import { createHash } from 'node:crypto';
import { lstatSync, renameSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const idPattern = /^[a-z0-9][a-z0-9-]{1,63}$/;
const relPathPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const maxFiles = 16;
const maxBytes = 65536;

function failure(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function digestOf(value) {
  return sha256(JSON.stringify(value));
}

function frontmatterName(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (match === null) throw failure('SKILL_FRONTMATTER_MISSING');
  const lines = match[1].split(/\r?\n/);
  const read = key => {
    const line = lines.find(candidate => new RegExp(`^${key}\\s*:`).test(candidate));
    if (line === undefined) throw failure('SKILL_FRONTMATTER_MISSING');
    return line.replace(new RegExp(`^${key}\\s*:\\s*`), '').trim().replace(/^['"]|['"]$/g, '');
  };
  return { name: read('name'), description: read('description') };
}

function validateContract(contract) {
  if (!isRecord(contract) || contract.verdict !== 'draftable' || !isRecord(contract.contract)) {
    throw failure('CONTRACT_NOT_DRAFTABLE');
  }
  const fields = ['need', 'triggers', 'inputs', 'outputs', 'constraints', 'outOfScope', 'openQuestions'];
  if (fields.some(key => !Object.hasOwn(contract.contract, key))) throw failure('INVALID_CONTRACT');
  const constraints = contract.contract.constraints;
  if (!Array.isArray(constraints) || constraints.length === 0 ||
    constraints.some(item => typeof item !== 'string' || !item.trim())) {
    throw failure('INVALID_CONTRACT');
  }
  return contract;
}

function validateFiles(files) {
  if (!isRecord(files)) throw failure('INVALID_DRAFT_FILES');
  const entries = Object.entries(files);
  if (entries.length === 0 || entries.length > maxFiles || !Object.hasOwn(files, 'SKILL.md')) {
    throw failure('INVALID_DRAFT_FILES');
  }
  const normalized = {};
  for (const [relPath, content] of entries) {
    if (!relPathPattern.test(relPath) || relPath.includes('..') || isAbsolute(relPath) ||
      typeof content !== 'string' || !content.isWellFormed() ||
      Buffer.byteLength(content, 'utf8') > maxBytes) throw failure('INVALID_DRAFT_FILES');
    normalized[relPath] = content;
  }
  return freeze(normalized);
}

async function listDraftFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const collected = [];
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      collected.push(...await listDraftFiles(join(directory, entry.name), relPath));
    } else if (entry.isFile()) {
      collected.push(relPath);
    } else {
      throw failure(`CANDIDATE_FILE_CHANGED: ${relPath}`);
    }
  }
  return collected;
}

/**
 * Open a draft candidate for a NEW skill (no source version to diff against).
 * The draft is bound to the intake contract instead: it may not rename the skill away from the
 * declared name, and every contract constraint must be carried verbatim in SKILL.md — a new
 * skill that silently drops its safety constraints is the failure this check exists to stop.
 */
export async function openDraftCandidate({ root, candidateId, contract, hypothesis, affectedScope,
  name, description, now = Date.now } = {}) {
  if (typeof root !== 'string' || !root.trim()) throw failure('INVALID_CANDIDATE_ROOT');
  if (typeof candidateId !== 'string' || !idPattern.test(candidateId)) throw failure('INVALID_CANDIDATE_ID');
  validateContract(contract);
  if (typeof name !== 'string' || !idPattern.test(name)) throw failure('INVALID_SKILL_NAME');
  if (typeof description !== 'string' || !description.trim() ||
    Buffer.byteLength(description, 'utf8') > 500) throw failure('INVALID_SKILL_DESCRIPTION');
  if (!isRecord(hypothesis) || Reflect.ownKeys(hypothesis).length !== 2 ||
    typeof hypothesis.claim !== 'string' || !hypothesis.claim.trim() ||
    typeof hypothesis.expectedEffect !== 'string' || !hypothesis.expectedEffect.trim()) {
    throw failure('INVALID_HYPOTHESIS');
  }
  if (!Array.isArray(affectedScope) || affectedScope.length === 0 ||
    affectedScope.some(item => typeof item !== 'string' || !item.trim())) {
    throw failure('INVALID_AFFECTED_SCOPE');
  }
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    throw failure('INVALID_CANDIDATE_ROOT', error);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw failure('INVALID_CANDIDATE_ROOT');

  const directory = join(root, candidateId);
  try {
    await mkdir(directory, { recursive: false });
  } catch (error) {
    if (error.code === 'EEXIST') throw failure('CANDIDATE_EXISTS');
    throw failure('INVALID_CANDIDATE_ROOT', error);
  }
  const draftDirectory = join(directory, 'candidate');
  await mkdir(draftDirectory, { recursive: true });
  const manifestPath = join(directory, 'candidate.json');
  const contractDigest = digestOf(contract.contract);
  const constraints = contract.contract.constraints;

  let state = 'open';
  let draftDigest = null;
  let writtenFiles = null;

  async function readManifest() {
    return JSON.parse(await readFile(manifestPath, 'utf8'));
  }

  async function persistManifest(extra = {}) {
    let previous = {};
    try {
      previous = await readManifest();
    } catch { /* first write */ }
    const manifest = {
      record_type: 'draft_candidate',
      candidateId,
      skillName: name,
      description,
      contractDigest,
      contractVersion: 'intake-v1',
      hypothesis,
      affectedScope,
      draftDigest,
      files: writtenFiles,
      sealed: false,
      sealedAt: null,
      createdAt: previous.createdAt ?? now(),
      ...extra,
    };
    const temporary = `${manifestPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(temporary, manifestPath);
    return manifest;
  }

  async function writeDraft(files) {
    if (state === 'sealed') throw failure('CANDIDATE_SEALED');
    const normalized = validateFiles(files);
    const skillText = normalized['SKILL.md'];
    const frontmatter = frontmatterName(skillText);
    if (frontmatter.name !== name) throw failure('SKILL_NAME_MISMATCH');
    if (frontmatter.description !== description) throw failure('SKILL_DESCRIPTION_MISMATCH');
    for (const constraint of constraints) {
      if (!skillText.includes(constraint)) throw failure(`CONSTRAINT_NOT_COVERED: ${constraint}`);
    }
    for (const [relPath, content] of Object.entries(normalized)) {
      const target = join(draftDirectory, relPath);
      await mkdir(join(target, '..'), { recursive: true });
      const temporary = `${target}.tmp`;
      await writeFile(temporary, content);
      renameSync(temporary, target);
    }
    draftDigest = digestOf(normalized);
    writtenFiles = Object.keys(normalized).sort().map(relPath => ({ relPath, sha256: sha256(normalized[relPath]) }));
    const manifest = await persistManifest();
    return freeze({ candidateId, draftDigest, files: manifest.files });
  }

  async function seal() {
    if (state === 'sealed') return freeze({ candidateId, sealed: true, sealedAt: (await readManifest()).sealedAt });
    if (draftDigest === null) throw failure('CANDIDATE_NOT_WRITTEN');
    const manifest = await persistManifest({ sealed: true, sealedAt: now() });
    state = 'sealed';
    return freeze({ candidateId, sealed: true, sealedAt: manifest.sealedAt });
  }

  async function verify({ contract: current } = {}) {
    if (draftDigest === null) throw failure('CANDIDATE_NOT_WRITTEN');
    const manifest = await readManifest();
    if (current !== undefined && digestOf(current.contract) !== manifest.contractDigest) {
      throw failure('CONTRACT_CHANGED');
    }
    const onDisk = (await listDraftFiles(draftDirectory)).sort();
    const declared = manifest.files.map(file => file.relPath).sort();
    if (JSON.stringify(onDisk) !== JSON.stringify(declared)) throw failure('CANDIDATE_FILE_SET_CHANGED');
    const contents = {};
    for (const file of manifest.files) {
      contents[file.relPath] = await readFile(join(draftDirectory, file.relPath), 'utf8');
      if (sha256(contents[file.relPath]) !== file.sha256) throw failure(`CANDIDATE_FILE_CHANGED: ${file.relPath}`);
    }
    if (digestOf(contents) !== manifest.draftDigest) throw failure('CANDIDATE_IDENTITY_CHANGED');
    return freeze({ ok: true, checks: ['contract', 'file-set', 'digests'], contractDigest: manifest.contractDigest });
  }

  await persistManifest();
  return Object.freeze({
    candidateId,
    skillName: name,
    directory,
    draftDirectory,
    preview: () => freeze({ candidateId, skillName: name, description,
      contractDigest, hypothesis, affectedScope,
      contractConstraints: [...constraints], openQuestions: [...contract.contract.openQuestions] }),
    writeDraft,
    seal,
    verify,
    manifest: async () => freeze(await readManifest()),
  });
}
