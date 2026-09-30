import { createHash } from 'node:crypto';
import { lstatSync, renameSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const idPattern = /^[a-z0-9][a-z0-9-]{2,63}$/;
const changeKinds = new Set(['edit', 'add', 'remove']);
const hypothesisFields = ['claim', 'evidence', 'expectedEffect', 'regressionRisk'];
const maxChanges = 32;
const maxScopeItems = 32;
const defaultMaxBytes = 65536;

function failure(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function isDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function freeze(value) {
  return Object.freeze(value);
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function requireString(value, code) {
  if (typeof value !== 'string' || !value.trim()) throw failure(code);
  return value;
}

function validateSource(value) {
  if (!isRecord(value) || !Object.hasOwn(value, 'path') || !Object.hasOwn(value, 'digest') ||
    Reflect.ownKeys(value).length !== 2) throw failure('INVALID_CANDIDATE_SOURCE');
  requireString(value.path, 'INVALID_CANDIDATE_SOURCE');
  if (!isDigest(value.digest)) throw failure('INVALID_CANDIDATE_SOURCE');
  return freeze({ path: value.path, digest: value.digest });
}

function validateChanges(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxChanges) {
    throw failure('INVALID_CHANGES');
  }
  return freeze(value.map(entry => {
    if (!isRecord(entry) || Reflect.ownKeys(entry).length !== 3 ||
      !Object.hasOwn(entry, 'target') || !Object.hasOwn(entry, 'kind') || !Object.hasOwn(entry, 'rationale')) {
      throw failure('INVALID_CHANGES');
    }
    requireString(entry.target, 'INVALID_CHANGES');
    requireString(entry.rationale, 'INVALID_CHANGES');
    if (!changeKinds.has(entry.kind)) throw failure('INVALID_CHANGES');
    return freeze({ target: entry.target, kind: entry.kind, rationale: entry.rationale });
  }));
}

function validateHypothesis(value) {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== hypothesisFields.length) {
    throw failure('INVALID_HYPOTHESIS');
  }
  const hypothesis = {};
  for (const key of hypothesisFields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure('INVALID_HYPOTHESIS');
    hypothesis[key] = requireString(descriptor.value, 'INVALID_HYPOTHESIS');
  }
  return freeze(hypothesis);
}

function validateScope(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxScopeItems) {
    throw failure('INVALID_AFFECTED_SCOPE');
  }
  return freeze(value.map(item => requireString(item, 'INVALID_AFFECTED_SCOPE')));
}

function frontmatterName(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (match === null) throw failure('SKILL_FRONTMATTER_MISSING');
  const nameLine = match[1].split(/\r?\n/).find(line => /^name\s*:/.test(line));
  if (nameLine === undefined) throw failure('SKILL_FRONTMATTER_MISSING');
  const name = nameLine.replace(/^name\s*:\s*/, '').trim().replace(/^['"]|['"]$/g, '');
  if (!name) throw failure('SKILL_FRONTMATTER_MISSING');
  return name;
}

function diffLines(before, after) {
  const left = before.split('\n');
  const right = after.split('\n');
  const lengths = Array.from({ length: left.length + 1 },
    () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i][j] = left[i] === right[j]
        ? lengths[i + 1][j + 1] + 1
        : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const lines = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      lines.push(` ${left[i]}`);
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      lines.push(`-${left[i]}`);
      removed += 1;
      i += 1;
    } else {
      lines.push(`+${right[j]}`);
      added += 1;
      j += 1;
    }
  }
  while (i < left.length) { lines.push(`-${left[i]}`); removed += 1; i += 1; }
  while (j < right.length) { lines.push(`+${right[j]}`); added += 1; j += 1; }
  return { text: lines.join('\n'), addedLines: added, removedLines: removed };
}

export async function openCandidate(options = {}) {
  const root = options.root;
  const candidateId = options.candidateId;
  if (typeof candidateId !== 'string' || !idPattern.test(candidateId)) throw failure('INVALID_CANDIDATE_ID');
  const source = validateSource(options.source);
  const changes = validateChanges(options.changes);
  const hypothesis = validateHypothesis(options.hypothesis);
  const affectedScope = validateScope(options.affectedScope);
  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw failure('INVALID_MAX_BYTES');
  const now = options.now ?? Date.now;
  if (typeof now !== 'function' || !Number.isSafeInteger(now())) throw failure('INVALID_CLOCK');

  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    throw failure('INVALID_CANDIDATE_ROOT', error);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw failure('INVALID_CANDIDATE_ROOT');
  let sourceStat;
  try {
    sourceStat = lstatSync(source.path);
  } catch (error) {
    throw failure('INVALID_CANDIDATE_SOURCE', error);
  }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw failure('INVALID_CANDIDATE_SOURCE');

  const directory = join(root, candidateId);
  try {
    await mkdir(directory, { recursive: false });
  } catch (error) {
    if (error.code === 'EEXIST') throw failure('CANDIDATE_EXISTS');
    throw failure('INVALID_CANDIDATE_ROOT', error);
  }
  const manifestPath = join(directory, 'candidate.json');
  const diffPath = join(directory, 'candidate.diff');
  const candidateDir = join(directory, 'candidate');
  const candidatePath = join(candidateDir, 'SKILL.md');
  await mkdir(candidateDir, { recursive: true });

  const sourceText = await readFile(source.path, 'utf8');
  if (sha256(sourceText) !== source.digest) throw failure('SOURCE_IDENTITY_CHANGED');
  const sourceName = frontmatterName(sourceText);

  let state = 'open';
  let candidateDigest = null;
  let candidateBytes = null;
  let createdAt = null;

  async function assertSourceUnchanged() {
    const current = await readFile(source.path, 'utf8');
    if (sha256(current) !== source.digest) throw failure('SOURCE_IDENTITY_CHANGED');
    return true;
  }

  async function readManifest() {
    return JSON.parse(await readFile(manifestPath, 'utf8'));
  }

  async function persistManifest(extra = {}) {
    createdAt ??= now();
    let previous = {};
    try {
      previous = await readManifest();
    } catch { /* first write */ }
    const manifest = {
      candidateId,
      createdAt,
      source: { path: source.path, digest: source.digest, name: sourceName },
      changes,
      hypothesis,
      affectedScope,
      candidateDigest,
      candidateBytes,
      diffSummary: previous.diffSummary ?? null,
      sealed: previous.sealed ?? false,
      sealedAt: previous.sealedAt ?? null,
      ...extra,
    };
    const temporary = `${manifestPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(temporary, manifestPath);
    return manifest;
  }

  async function writeCandidate(text) {
    if (state === 'sealed') throw failure('CANDIDATE_SEALED');
    requireString(text, 'INVALID_CANDIDATE_TEXT');
    if (!text.isWellFormed()) throw failure('INVALID_CANDIDATE_TEXT');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes) throw failure('CANDIDATE_TOO_LARGE');
    if (text === sourceText) throw failure('EMPTY_CHANGE');
    if (frontmatterName(text) !== sourceName) throw failure('SKILL_NAME_CHANGED');
    for (const change of changes) {
      const side = change.kind === 'add' ? text : sourceText;
      if (!side.includes(change.target)) throw failure('CHANGE_TARGET_MISSING');
    }
    await assertSourceUnchanged();
    const diff = diffLines(sourceText, text);
    const temporary = `${candidatePath}.tmp`;
    await writeFile(temporary, text);
    renameSync(temporary, candidatePath);
    await writeFile(diffPath, `${diff.text}\n`);
    candidateDigest = sha256(text);
    candidateBytes = bytes;
    const manifest = await persistManifest({ diffSummary: {
      addedLines: diff.addedLines, removedLines: diff.removedLines } });
    return freeze({ candidateId, sha256: candidateDigest, bytes: candidateBytes,
      diffSummary: manifest.diffSummary });
  }

  async function seal() {
    if (state === 'sealed') return freeze({ candidateId, sealed: true, sealedAt: (await readManifest()).sealedAt });
    if (candidateDigest === null) throw failure('CANDIDATE_NOT_WRITTEN');
    await assertSourceUnchanged();
    const manifest = await persistManifest({ sealed: true, sealedAt: now() });
    state = 'sealed';
    return freeze({ candidateId, sealed: true, sealedAt: manifest.sealedAt });
  }

  async function verify() {
    await assertSourceUnchanged();
    if (candidateDigest === null) throw failure('CANDIDATE_NOT_WRITTEN');
    const text = await readFile(candidatePath, 'utf8');
    if (sha256(text) !== candidateDigest) throw failure('CANDIDATE_IDENTITY_CHANGED');
    const manifest = await readManifest();
    if (manifest.candidateDigest !== candidateDigest) throw failure('CANDIDATE_IDENTITY_CHANGED');
    const diff = diffLines(sourceText, text);
    const storedDiff = await readFile(diffPath, 'utf8');
    if (storedDiff !== `${diff.text}\n`) throw failure('DIFF_MISMATCH');
    return freeze({ ok: true, checks: ['source', 'candidate', 'diff'] });
  }

  await persistManifest();

  return Object.freeze({
    candidateId,
    directory,
    preview: () => freeze({ candidateId, sourcePath: source.path, sourceDigest: source.digest,
      sourceName, changes, hypothesis, affectedScope, maxBytes }),
    writeCandidate,
    seal,
    verify,
    assertSourceUnchanged,
    manifest: async () => freeze(await readManifest()),
  });
}
