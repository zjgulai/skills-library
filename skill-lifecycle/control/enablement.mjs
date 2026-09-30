import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const maxFiles = 64;
const maxFileBytes = 262144;
const skillIdPattern = /^[a-z0-9][a-z0-9-]{1,63}$/;

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

function isDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function inside(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path);
}

async function mustBeDirectory(path, code) {
  let stat_;
  try {
    stat_ = lstatSync(path);
  } catch (error) {
    throw failure(code, error);
  }
  if (!stat_.isDirectory() || stat_.isSymbolicLink()) throw failure(code);
  return path;
}

/** Read a content tree as { relPath: sha256 }; bounded in depth, file count and file size. */
async function snapshotTree(root) {
  const files = {};
  async function walk(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      const stat_ = lstatSync(absolute);
      if (stat_.isSymbolicLink()) throw failure(`SYMLINK_NOT_ALLOWED: ${relPath}`);
      if (stat_.isDirectory()) {
        await walk(absolute, relPath);
        continue;
      }
      if (!stat_.isFile()) throw failure(`UNSUPPORTED_ENTRY: ${relPath}`);
      if (stat_.size > maxFileBytes) throw failure(`FILE_TOO_LARGE: ${relPath}`);
      files[relPath] = sha256(await readFile(absolute, 'utf8'));
      if (Object.keys(files).length > maxFiles) throw failure('TOO_MANY_FILES');
    }
  }
  await walk(root, '');
  return files;
}

function validateCandidate(candidate) {
  if (!isRecord(candidate) || typeof candidate.candidateId !== 'string' || !candidate.candidateId.trim() ||
    typeof candidate.dir !== 'string' || !candidate.dir.trim() || !Array.isArray(candidate.files) ||
    candidate.files.length === 0 || candidate.files.length > maxFiles ||
    candidate.files.some(file => !isRecord(file) || Reflect.ownKeys(file).length !== 2 ||
      typeof file.relPath !== 'string' || file.relPath.includes('..') || isAbsolute(file.relPath) ||
      !isDigest(file.sha256))) {
    throw failure('INVALID_CANDIDATE');
  }
  const seen = new Set();
  for (const file of candidate.files) {
    if (seen.has(file.relPath)) throw failure('INVALID_CANDIDATE');
    seen.add(file.relPath);
  }
  return freeze({ candidateId: candidate.candidateId, dir: candidate.dir,
    files: candidate.files.map(file => freeze({ relPath: file.relPath, sha256: file.sha256 })) });
}

/**
 * Plan an enablement: compute the change set against the installed tree and emit a preview
 * that carries logical file names and digests only — never absolute paths or file contents.
 * Any identity mismatch (candidate files moved, installed state drifted) plans nothing.
 */
export async function planEnable({ allowedParent, root, skillId, candidate, previous = null } = {}) {
  if (typeof allowedParent !== 'string' || !allowedParent.trim()) throw failure('INVALID_ALLOWED_PARENT');
  if (typeof root !== 'string' || !root.trim()) throw failure('INVALID_TARGET_ROOT');
  if (typeof skillId !== 'string' || !skillIdPattern.test(skillId)) throw failure('INVALID_SKILL_ID');
  const target = validateCandidate(candidate);
  await mustBeDirectory(allowedParent, 'INVALID_ALLOWED_PARENT');
  if (!inside(allowedParent, root)) throw failure('TARGET_OUT_OF_SCOPE');
  // 词法包含不够：目标可以经符号链接逃逸。对"最深的已存在祖先"取 realpath 再判一次包含。
  const realAllowed = await realpath(allowedParent);
  let existing = resolve(root);
  for (;;) {
    try {
      const stat_ = lstatSync(existing);
      if (!stat_.isDirectory() || stat_.isSymbolicLink()) throw failure('INVALID_TARGET_ROOT');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) throw failure('INVALID_TARGET_ROOT');
      existing = parent;
    }
  }
  if (!inside(realAllowed, await realpath(existing))) throw failure('TARGET_OUT_OF_SCOPE');

  const candidateFiles = {};
  for (const file of target.files) {
    const content = await readFile(join(target.dir, file.relPath), 'utf8').catch(error => {
      throw failure(`CANDIDATE_FILE_MISSING: ${file.relPath}`, error);
    });
    if (sha256(content) !== file.sha256) throw failure(`CANDIDATE_FILE_CHANGED: ${file.relPath}`);
    candidateFiles[file.relPath] = file.sha256;
  }

  let installed = {};
  let targetExists = false;
  try {
    await mustBeDirectory(root, 'INVALID_TARGET_ROOT');
    targetExists = true;
    installed = await snapshotTree(root);
  } catch (error) {
    if (error.code !== 'INVALID_TARGET_ROOT') throw error;
  }
  if (previous !== null) {
    if (!isRecord(previous) || !Array.isArray(previous.files)) throw failure('INVALID_PREVIOUS');
    const declared = Object.fromEntries(previous.files.map(file => [file.relPath, file.sha256]));
    const same = Object.keys(declared).length === Object.keys(installed).length &&
      Object.entries(declared).every(([relPath, digest]) => installed[relPath] === digest);
    if (!same) throw failure('INSTALLED_STATE_DRIFT');
  }

  const added = [];
  const replaced = [];
  const removed = [];
  for (const [relPath, after] of Object.entries(candidateFiles).sort()) {
    const before = installed[relPath];
    if (before === undefined) added.push({ relPath, sha256: after });
    else if (before !== after) replaced.push({ relPath, beforeSha256: before, afterSha256: after });
  }
  for (const [relPath, before] of Object.entries(installed).sort()) {
    if (candidateFiles[relPath] === undefined) removed.push({ relPath, sha256: before });
  }

  const preview = freeze({
    skillId,
    candidateId: target.candidateId,
    scope: 'trial-home-only',
    firstInstall: !targetExists,
    added, replaced, removed,
    counts: { added: added.length, replaced: replaced.length, removed: removed.length },
    declaration: [
      `skill files: ${Object.keys(candidateFiles).length}`,
      'assembly: skill-registry + skill-filesystem(watch:false, includeDefaultRoots:false) + tool-skill',
    ],
  });
  const plan = freeze({
    skillId,
    candidateId: target.candidateId,
    changeDigest: digestOf({ added, replaced, removed }),
    targetDigest: digestOf(installed),
    candidateDigest: digestOf(candidateFiles),
    planDigest: digestOf({ skillId, candidateId: target.candidateId, added, replaced, removed,
      installed, candidateFiles }),
    preview,
  });
  return plan;
}

/** Re-derive a plan's identity from live state; apply may only proceed on an identical plan. */
export async function verifyPlan({ plan, allowedParent, root, skillId, candidate, previous = null } = {}) {
  if (!isRecord(plan) || !isDigest(plan.planDigest) || plan.skillId !== skillId ||
    plan.candidateId !== candidate?.candidateId) throw failure('INVALID_PLAN');
  const fresh = await planEnable({ allowedParent, root, skillId, candidate, previous });
  if (fresh.planDigest !== plan.planDigest) throw failure('PLAN_CHANGED_SINCE_PREVIEW');
  return freeze({ verified: true, planDigest: fresh.planDigest });
}

async function readTree(root) {
  const contents = {};
  try {
    await mustBeDirectory(root, 'INVALID_TARGET_ROOT');
  } catch (error) {
    if (error.code === 'INVALID_TARGET_ROOT') return contents;
    throw error;
  }
  for (const relPath of Object.keys(await snapshotTree(root)).sort()) {
    contents[relPath] = await readFile(join(root, relPath), 'utf8');
  }
  return contents;
}

async function writeAtomic(path, content) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}


/** Restore a tree to an exact prior content snapshot: drop extras, rewrite everything else. */
async function restoreTree(root, before) {
  const current = await snapshotTree(root).catch(() => ({}));
  for (const relPath of Object.keys(current)) {
    if (before[relPath] === undefined) await rm(join(root, relPath), { force: true });
  }
  for (const [relPath, content] of Object.entries(before)) {
    await mkdir(dirname(join(root, relPath)), { recursive: true });
    await writeFile(join(root, relPath), content);
  }
}

async function writeTree(root, contents) {
  for (const [relPath, content] of Object.entries(contents)) {
    await mkdir(dirname(join(root, relPath)), { recursive: true });
    await writeFile(join(root, relPath), content);
  }
}

async function readBackup(backupRoot, skillId, installId = null) {
  try {
    lstatSync(backupRoot);
  } catch (error) {
    if (error.code === 'ENOENT') throw failure('NO_BACKUP');
    throw failure('INVALID_BACKUP_ROOT', error);
  }
  await mustBeDirectory(backupRoot, 'INVALID_BACKUP_ROOT');
  const ids = (await readdir(backupRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith(`${skillId}@`))
    .map(entry => entry.name).sort();
  if (ids.length === 0) throw failure('NO_BACKUP');
  const chosen = installId === null ? ids[ids.length - 1] : ids.find(id => id === `${installId}` || id === installId);
  if (chosen === undefined) throw failure('UNKNOWN_BACKUP');
  const directory = join(backupRoot, chosen);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.skillId !== skillId) throw failure('UNKNOWN_BACKUP');
  const contents = {};
  for (const file of manifest.files) {
    contents[file.relPath] = await readFile(join(directory, 'files', file.relPath), 'utf8');
    if (sha256(contents[file.relPath]) !== file.sha256) throw failure(`BACKUP_FILE_CHANGED: ${file.relPath}`);
  }
  return freeze({ installId: chosen, directory, manifest, contents });
}

/** Any install of this skill that still carries its in-progress marker blocks a new install. */
export async function assertNoInstallInProgress({ backupRoot, skillId } = {}) {
  if (typeof skillId !== 'string' || !skillIdPattern.test(skillId)) throw failure('INVALID_SKILL_ID');
  try {
    await mustBeDirectory(backupRoot, 'INVALID_BACKUP_ROOT');
  } catch (error) {
    if (error.code === 'INVALID_BACKUP_ROOT') return freeze({ inProgress: false });
    throw error;
  }
  const entries = await readdir(backupRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${skillId}@`)) continue;
    try {
      await readFile(join(backupRoot, entry.name, 'IN_PROGRESS'), 'utf8');
      throw failure(`INSTALL_IN_PROGRESS: ${entry.name}`);
    } catch (error) {
      if (error.code === 'INSTALL_IN_PROGRESS') throw error;
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return freeze({ inProgress: false });
}

/**
 * Roll the installed tree back to the state captured before a given install — across processes,
 * because the backup is on disk. The restore is verified file by file; on any mismatch the
 * in-progress marker is deliberately kept so the state can never look clean while it is not.
 */
export async function rollbackEnable({ allowedParent, root, skillId, backupRoot, receiptRoot,
  installId = null, now = Date.now, afterRestore } = {}) {
  await mustBeDirectory(allowedParent, 'INVALID_ALLOWED_PARENT');
  if (!inside(allowedParent, root)) throw failure('TARGET_OUT_OF_SCOPE');
  if (!inside(allowedParent, receiptRoot)) throw failure('RECEIPT_OUT_OF_SCOPE');
  const backup = await readBackup(backupRoot, skillId, installId);
  let recovered = false;
  try {
    await readFile(join(backup.directory, 'IN_PROGRESS'), 'utf8');
    recovered = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // 回退本身也要可见：开始就写标记，成功才清——崩在回退中途也必须留下"未完成"的痕迹。
  await writeFile(join(backup.directory, 'IN_PROGRESS'),
    `${JSON.stringify({ skillId, phase: 'rollback', startedAt: now() })}\n`);
  await restoreTree(root, backup.contents);
  if (typeof afterRestore === 'function') await afterRestore({ root });
  const restored = await snapshotTree(root).catch(() => ({}));
  const expected = Object.fromEntries(backup.manifest.files.map(file => [file.relPath, file.sha256]));
  const same = Object.keys(restored).length === Object.keys(expected).length &&
    Object.entries(expected).every(([relPath, digest]) => restored[relPath] === digest);
  if (!same) throw failure('ROLLBACK_VERIFY_FAILED');
  await rm(join(backup.directory, 'IN_PROGRESS'), { force: true });
  const receipt = freeze({
    skillId,
    installId: backup.installId,
    rolledBackAt: now(),
    recovered,
    restoredDigest: digestOf(expected),
    removedByRollback: [],
    verified: true,
  });
  await mkdir(receiptRoot, { recursive: true });
  const path = join(receiptRoot, `${skillId}-rollback-${receipt.rolledBackAt}.receipt.json`);
  try {
    await readFile(path, 'utf8');
    throw failure('RECEIPT_EXISTS');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return freeze({ receipt, receiptPath: path });
}

/**
 * Apply a verified plan, then prove the result by re-reading the tree file by file.
 * Any mismatch — including a file changed between write and verification — restores the exact
 * previous state and fails with INSTALL_VERIFY_FAILED. `afterApply` exists so tests can inject
 * that fault; production callers leave it undefined.
 */
export async function applyEnable({ plan, allowedParent, root, skillId, candidate, previous = null,
  receiptRoot, backupRoot = null, now = Date.now, afterApply } = {}) {
  if (typeof receiptRoot !== 'string' || !receiptRoot.trim()) throw failure('INVALID_RECEIPT_ROOT');
  await mustBeDirectory(allowedParent, 'INVALID_ALLOWED_PARENT');
  if (!inside(allowedParent, root)) throw failure('TARGET_OUT_OF_SCOPE');
  if (!inside(allowedParent, receiptRoot)) throw failure('RECEIPT_OUT_OF_SCOPE');
  if (backupRoot !== null && !inside(allowedParent, backupRoot)) throw failure('BACKUP_OUT_OF_SCOPE');
  if (backupRoot !== null) await assertNoInstallInProgress({ backupRoot, skillId });
  const target = validateCandidate(candidate);
  await verifyPlan({ plan, allowedParent, root, skillId, candidate, previous });

  const before = await readTree(root);
  const installId = `${skillId}@${now()}`;
  let backupDirectory = null;
  if (backupRoot !== null) {
    backupDirectory = join(backupRoot, installId);
    const manifest = { skillId, candidateId: target.candidateId, planDigest: plan.planDigest,
      takenAt: now(), files: Object.keys(before).sort()
        .map(relPath => ({ relPath, sha256: sha256(before[relPath]) })) };
    await mkdir(join(backupDirectory, 'files'), { recursive: true });
    await writeTree(join(backupDirectory, 'files'), before);
    await writeFile(join(backupDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(backupDirectory, 'IN_PROGRESS'),
      `${JSON.stringify({ skillId, candidateId: target.candidateId, planDigest: plan.planDigest, startedAt: now() })}\n`);
  }
  const clearMarker = async () => {
    if (backupDirectory !== null) await rm(join(backupDirectory, 'IN_PROGRESS'), { force: true });
  };
  try {
    for (const file of [...plan.preview.added, ...plan.preview.replaced]) {
      const directory = dirname(join(root, file.relPath));
      await mkdir(directory, { recursive: true });
      await writeAtomic(join(root, file.relPath), await readFile(join(target.dir, file.relPath), 'utf8'));
    }
    for (const file of plan.preview.removed) await rm(join(root, file.relPath), { force: true });
    if (typeof afterApply === 'function') await afterApply({ root });
  } catch (error) {
    await restoreTree(root, before);
    await clearMarker();
    throw failure('INSTALL_APPLY_FAILED', error);
  }

  const installed = await snapshotTree(root).catch(() => ({}));
  const expected = Object.fromEntries(target.files.map(file => [file.relPath, file.sha256]));
  const same = Object.keys(installed).length === Object.keys(expected).length &&
    Object.entries(expected).every(([relPath, digest]) => installed[relPath] === digest);
  if (!same) {
    await restoreTree(root, before);
    await clearMarker();
    throw failure('INSTALL_VERIFY_FAILED');
  }

  await clearMarker();
  const receipt = freeze({
    skillId,
    candidateId: target.candidateId,
    installedAt: now(),
    installId: backupDirectory === null ? null : installId,
    backupId: backupDirectory === null ? null : installId,
    planDigest: plan.planDigest,
    previousDigest: digestOf(before),
    installedDigest: digestOf(expected),
    verified: true,
    files: target.files.map(file => freeze({ relPath: file.relPath, sha256: file.sha256 })),
  });
  await mkdir(receiptRoot, { recursive: true });
  const path = join(receiptRoot, `${skillId}-${target.candidateId}-${receipt.installedAt}.receipt.json`);
  try {
    await readFile(path, 'utf8');
    throw failure('RECEIPT_EXISTS');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return freeze({ receipt, receiptPath: path });
}

/**
 * Observe an installed skill through an injected observer and record the reading.
 * Live observations are refused unless the caller explicitly authorises egress — the gate runs
 * before the observer, so an unauthorised live window never even starts.
 */
export async function observeInstalled({ allowedParent, root, skillId, candidateId, observer,
  observation, expectedFiles = null, receiptRoot, allowEgress = false, now = Date.now } = {}) {
  if (typeof observer !== 'function') throw failure('INVALID_OBSERVER');
  if (!isRecord(observation) || (observation.mode !== 'capture' && observation.mode !== 'live')) {
    throw failure('INVALID_OBSERVATION');
  }
  if (observation.mode === 'live' && allowEgress !== true) throw failure('EGRESS_NOT_AUTHORIZED');
  await mustBeDirectory(allowedParent, 'INVALID_ALLOWED_PARENT');
  if (!inside(allowedParent, root)) throw failure('TARGET_OUT_OF_SCOPE');
  if (!inside(allowedParent, receiptRoot)) throw failure('RECEIPT_OUT_OF_SCOPE');
  if (typeof skillId !== 'string' || !skillIdPattern.test(skillId)) throw failure('INVALID_SKILL_ID');
  if (typeof candidateId !== 'string' || !candidateId.trim()) throw failure('INVALID_CANDIDATE_ID');

  const installed = await snapshotTree(root).catch(() => ({}));
  if (Object.keys(installed).length === 0) throw failure('INSTALLED_STATE_DRIFT');
  if (expectedFiles !== null) {
    // 观察的前提是"树仍是当初安装的那一份"：与安装记录逐文件比对，防止观察一个已被改动的树。
    if (!Array.isArray(expectedFiles) || expectedFiles.length === 0 ||
      expectedFiles.some(file => !isRecord(file) || typeof file.relPath !== 'string' ||
        !isDigest(file.sha256))) throw failure('INVALID_EXPECTED_FILES');
    const mismatched = expectedFiles.filter(file => installed[file.relPath] !== file.sha256);
    if (mismatched.length > 0 || Object.keys(installed).length !== expectedFiles.length) {
      throw failure('INSTALLED_STATE_DRIFT');
    }
  }
  const installedDigest = digestOf(installed);
  const started = now();
  const result = await observer({ skillId, candidateId, root, files: Object.keys(installed).sort() });
  if (!isRecord(result) || typeof result.ok !== 'boolean' || result.mode !== observation.mode) {
    throw failure('INVALID_OBSERVATION_RESULT');
  }
  if (result.mode !== 'capture' && allowEgress !== true) throw failure('EGRESS_NOT_AUTHORIZED');
  const receipt = freeze({
    skillId,
    candidateId,
    observedAt: started,
    installedDigest,
    observation: {
      mode: result.mode,
      ok: result.ok,
      detail: typeof result.detail === 'string' ? result.detail : null,
      durationMs: Math.max(0, now() - started),
      files: result.files ?? null,
    },
    verified: true,
  });
  await mkdir(receiptRoot, { recursive: true });
  const path = join(receiptRoot, `${skillId}-observation-${receipt.observedAt}.receipt.json`);
  try {
    await readFile(path, 'utf8');
    throw failure('RECEIPT_EXISTS');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return freeze({ receipt, receiptPath: path });
}
