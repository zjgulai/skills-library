import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planEnable, verifyPlan } from '../control/enablement.mjs';

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

async function makeCase(t) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'enable-'));
  const allowedParent = join(base, 'trial-home');
  const target = join(allowedParent, 'enabled', 'demo-skill');
  const candidateDir = join(base, 'candidate');
  await mkdir(join(candidateDir, 'refs'), { recursive: true });
  await mkdir(join(allowedParent, 'enabled'), { recursive: true });
  await writeFile(join(candidateDir, 'SKILL.md'), '# demo skill\n\nv1 body\n');
  await writeFile(join(candidateDir, 'refs', 'notes.md'), 'notes v1\n');
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  return { base, allowedParent, target, candidateDir };
}

function candidateOf(dir, overrides = {}) {
  return { candidateId: 'demo-candidate-001', dir,
    files: [
      { relPath: 'SKILL.md', sha256: sha256('# demo skill\n\nv1 body\n') },
      { relPath: 'refs/notes.md', sha256: sha256('notes v1\n') },
    ], ...overrides };
}

async function installSnapshot(t, files) {
  const { allowedParent, target } = await makeCase(t);
  await mkdir(target, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    await mkdir(join(target, relPath.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    await writeFile(join(target, relPath), content);
  }
  return { allowedParent, target };
}

test('a first install plans only additions and never leaks paths or contents', async (t) => {
  const { allowedParent, target, candidateDir } = await makeCase(t);
  const plan = await planEnable({ allowedParent, root: target, skillId: 'demo-skill',
    candidate: candidateOf(candidateDir) });
  assert.equal(plan.preview.firstInstall, true);
  assert.deepEqual(plan.preview.added.map(file => file.relPath).sort(), ['SKILL.md', 'refs/notes.md']);
  assert.deepEqual(plan.preview.counts, { added: 2, replaced: 0, removed: 0 });
  assert.equal(plan.preview.scope, 'trial-home-only');
  const text = JSON.stringify(plan.preview);
  assert.equal(text.includes(allowedParent), false, 'the preview must not carry absolute paths');
  assert.equal(text.includes('v1 body'), false, 'the preview must not carry file contents');
  assert.equal(text.includes('"sha256":"'), true, 'the preview must carry digests instead');
});

test('an upgrade against a matching previous state plans replacements and removals', async (t) => {
  const { allowedParent, target } = await installSnapshot(t, { 'SKILL.md': '# demo skill\n\nv1 body\n',
    'refs/notes.md': 'notes v1\n', 'refs/legacy.md': 'legacy\n' });
  const candidateDir = join(allowedParent, '..', 'candidate');
  await writeFile(join(candidateDir, 'SKILL.md'), '# demo skill\n\nv2 body\n');
  const candidate = candidateOf(candidateDir, { files: [
    { relPath: 'SKILL.md', sha256: sha256('# demo skill\n\nv2 body\n') },
    { relPath: 'refs/notes.md', sha256: sha256('notes v1\n') },
  ] });
  const plan = await planEnable({ allowedParent, root: target, skillId: 'demo-skill', candidate,
    previous: { files: [
      { relPath: 'SKILL.md', sha256: sha256('# demo skill\n\nv1 body\n') },
      { relPath: 'refs/notes.md', sha256: sha256('notes v1\n') },
      { relPath: 'refs/legacy.md', sha256: sha256('legacy\n') },
    ] } });
  assert.deepEqual(plan.preview.replaced.map(file => file.relPath), ['SKILL.md']);
  assert.deepEqual(plan.preview.removed.map(file => file.relPath), ['refs/legacy.md']);
  assert.equal(plan.preview.counts.added, 0);
});

test('a target outside the allowed parent is refused, including via symlink', async (t) => {
  const { base, allowedParent, candidateDir } = await makeCase(t);
  const outside = join(base, 'outside-target');
  await mkdir(outside, { recursive: true });
  await assert.rejects(planEnable({ allowedParent, root: outside, skillId: 'demo-skill',
    candidate: candidateOf(candidateDir) }), /TARGET_OUT_OF_SCOPE/);
  const link = join(allowedParent, 'escape');
  await symlink(outside, link);
  await assert.rejects(planEnable({ allowedParent, root: join(link, 'x'), skillId: 'demo-skill',
    candidate: candidateOf(candidateDir) }), /TARGET_OUT_OF_SCOPE|INVALID_TARGET_ROOT/);
  await assert.rejects(planEnable({ allowedParent: join(base, 'nope'), root: join(base, 'nope', 'x'),
    skillId: 'demo-skill', candidate: candidateOf(candidateDir) }), /INVALID_ALLOWED_PARENT/);
});

test('a candidate whose files moved after sealing is refused', async (t) => {
  const { allowedParent, target, candidateDir } = await makeCase(t);
  await writeFile(join(candidateDir, 'SKILL.md'), '# demo skill\n\nTAMPERED\n');
  await assert.rejects(planEnable({ allowedParent, root: target, skillId: 'demo-skill',
    candidate: candidateOf(candidateDir) }), /CANDIDATE_FILE_CHANGED: SKILL\.md/);
});

test('installed state drift blocks planning on top of it', async (t) => {
  const { allowedParent, target } = await installSnapshot(t, { 'SKILL.md': '# demo skill\n\nv1 body\n' });
  const candidateDir = join(allowedParent, '..', 'candidate');
  await assert.rejects(planEnable({ allowedParent, root: target, skillId: 'demo-skill',
    candidate: candidateOf(candidateDir), previous: { files: [
      { relPath: 'SKILL.md', sha256: sha256('# demo skill\n\nSOMETHING ELSE\n') },
    ] } }), /INSTALLED_STATE_DRIFT/);
});

test('verifyPlan accepts only the plan that matches live state', async (t) => {
  const { allowedParent, target, candidateDir } = await makeCase(t);
  const candidate = candidateOf(candidateDir);
  const plan = await planEnable({ allowedParent, root: target, skillId: 'demo-skill', candidate });
  const verified = await verifyPlan({ plan, allowedParent, root: target, skillId: 'demo-skill', candidate });
  assert.deepEqual(verified, { verified: true, planDigest: plan.planDigest });
  await writeFile(join(candidateDir, 'refs', 'notes.md'), 'notes v1 changed\n');
  await assert.rejects(verifyPlan({ plan, allowedParent, root: target, skillId: 'demo-skill', candidate }),
    /CANDIDATE_FILE_CHANGED/);
  await assert.rejects(verifyPlan({ plan: { ...plan, planDigest: 'f'.repeat(64) }, allowedParent, root: target,
    skillId: 'demo-skill', candidate: candidateOf(candidateDir, { files: [
      { relPath: 'SKILL.md', sha256: sha256('# demo skill\n\nv1 body\n') },
      { relPath: 'refs/notes.md', sha256: sha256('notes v1 changed\n') }] }) }),
  /PLAN_CHANGED_SINCE_PREVIEW/);
});

test('candidate declarations and skill ids are validated', async (t) => {
  const { allowedParent, target, candidateDir } = await makeCase(t);
  await assert.rejects(planEnable({ allowedParent, root: target, skillId: 'Bad_Id',
    candidate: candidateOf(candidateDir) }), /INVALID_SKILL_ID/);
  await assert.rejects(planEnable({ allowedParent, root: target, skillId: 'demo-skill',
    candidate: { ...candidateOf(candidateDir), files: [] } }), /INVALID_CANDIDATE/);
  await assert.rejects(planEnable({ allowedParent, root: target, skillId: 'demo-skill',
    candidate: candidateOf(candidateDir, { files: [
      { relPath: '../escape.md', sha256: sha256('x') }] }) }), /INVALID_CANDIDATE/);
  await assert.rejects(planEnable({ allowedParent, root: target, skillId: 'demo-skill',
    candidate: candidateOf(candidateDir, { files: [
      { relPath: 'SKILL.md', sha256: 'nothex' }] }) }), /INVALID_CANDIDATE/);
});

test('a symlink inside the installed tree is refused rather than followed', async (t) => {
  const { allowedParent, target } = await installSnapshot(t, { 'SKILL.md': '# demo skill\n\nv1 body\n' });
  await symlink('/etc/hosts', join(target, 'linked.md'));
  const candidateDir = join(allowedParent, '..', 'candidate');
  await assert.rejects(planEnable({ allowedParent, root: target, skillId: 'demo-skill',
    candidate: candidateOf(candidateDir) }), /SYMLINK_NOT_ALLOWED/);
});

test('the plan digest binds candidate, installed state and change set', async (t) => {
  const { allowedParent, target, candidateDir } = await makeCase(t);
  const candidate = candidateOf(candidateDir);
  const first = await planEnable({ allowedParent, root: target, skillId: 'demo-skill', candidate });
  const second = await planEnable({ allowedParent, root: target, skillId: 'demo-skill', candidate });
  assert.equal(first.planDigest, second.planDigest, 'the same live state must produce the same plan');
  const other = await planEnable({ allowedParent, root: join(allowedParent, 'enabled', 'other-skill'),
    skillId: 'other-skill', candidate });
  assert.notEqual(first.planDigest, other.planDigest, 'a different target must not share the digest');
});

// ---------- P3-2 apply + verify ----------

import { applyEnable } from '../control/enablement.mjs';

async function staged(t, { installed = null } = {}) {
  const base = await makeCase(t);
  if (installed !== null) {
    await mkdir(base.target, { recursive: true });
    for (const [relPath, content] of Object.entries(installed)) {
      await mkdir(join(base.target, dirnameOf(relPath)), { recursive: true });
      await writeFile(join(base.target, relPath), content);
    }
  }
  const receipts = join(base.allowedParent, 'receipts');
  return { ...base, receipts };
}

const dirnameOf = relPath => relPath.split('/').slice(0, -1).join('/') || '.';
const snapshotOf = async target => {
  const files = {};
  async function walk(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), relPath);
      else files[relPath] = sha256(await readFile(join(directory, entry.name), 'utf8'));
    }
  }
  try { await walk(target, ''); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return files;
};

test('a first install applies, verifies and writes a receipt', async (t) => {
  const { allowedParent, target, candidateDir, receipts } = await staged(t);
  const candidate = candidateOf(candidateDir);
  const plan = await planEnable({ allowedParent, root: target, skillId: 'demo-skill', candidate });
  const { receipt, receiptPath } = await applyEnable({ plan, allowedParent, root: target,
    skillId: 'demo-skill', candidate, receiptRoot: receipts, now: () => 1000 });
  assert.equal(receipt.verified, true);
  assert.equal(receipt.planDigest, plan.planDigest);
  assert.deepEqual(await snapshotOf(target), {
    'SKILL.md': sha256('# demo skill\n\nv1 body\n'),
    'refs/notes.md': sha256('notes v1\n'),
  });
  const stored = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(stored.installedDigest, receipt.installedDigest);
  assert.equal(receiptPath.includes(allowedParent), true);
});

test('an upgrade applies replacements and removals, and a repeated receipt is refused', async (t) => {
  const { allowedParent, target, candidateDir, receipts } = await staged(t, { installed: {
    'SKILL.md': '# demo skill\n\nv1 body\n', 'refs/legacy.md': 'legacy\n' } });
  await writeFile(join(candidateDir, 'SKILL.md'), '# demo skill\n\nv2 body\n');
  const candidate = candidateOf(candidateDir, { files: [
    { relPath: 'SKILL.md', sha256: sha256('# demo skill\n\nv2 body\n') }] });
  const previous = { files: [
    { relPath: 'SKILL.md', sha256: sha256('# demo skill\n\nv1 body\n') },
    { relPath: 'refs/legacy.md', sha256: sha256('legacy\n') }] };
  const plan = await planEnable({ allowedParent, root: target, skillId: 'demo-skill', candidate, previous });
  await applyEnable({ plan, allowedParent, root: target, skillId: 'demo-skill', candidate, previous,
    receiptRoot: receipts, now: () => 2000 });
  assert.deepEqual(await snapshotOf(target), { 'SKILL.md': sha256('# demo skill\n\nv2 body\n') });
});

test('an install whose receipt path already exists is refused', async (t) => {
  const { allowedParent, target, candidateDir, receipts } = await staged(t);
  const candidate = candidateOf(candidateDir);
  const plan = await planEnable({ allowedParent, root: target, skillId: 'demo-skill', candidate });
  await mkdir(receipts, { recursive: true });
  const occupied = join(receipts, 'demo-skill-demo-candidate-001-7000.receipt.json');
  await writeFile(occupied, '{}\n');
  await assert.rejects(applyEnable({ plan, allowedParent, root: target, skillId: 'demo-skill', candidate,
    receiptRoot: receipts, now: () => 7000 }), /RECEIPT_EXISTS/);
  assert.equal(await readFile(occupied, 'utf8'), '{}\n', 'the existing receipt must not be overwritten');
});

test('a file changed right after writing fails verification and rolls the tree back exactly', async (t) => {
  const prior = { 'SKILL.md': '# demo skill\n\nv1 body\n', 'refs/notes.md': 'notes v1\n',
    'refs/legacy.md': 'legacy\n' };
  const { allowedParent, target, candidateDir, receipts } = await staged(t, { installed: prior });
  await writeFile(join(candidateDir, 'SKILL.md'), '# demo skill\n\nv2 body\n');
  const candidate = candidateOf(candidateDir, { files: [
    { relPath: 'SKILL.md', sha256: sha256('# demo skill\n\nv2 body\n') }] });
  const previous = { files: Object.entries(prior).map(([relPath, content]) => ({ relPath, sha256: sha256(content) })) };
  const plan = await planEnable({ allowedParent, root: target, skillId: 'demo-skill', candidate, previous });
  await assert.rejects(applyEnable({ plan, allowedParent, root: target, skillId: 'demo-skill', candidate,
    previous, receiptRoot: receipts, now: () => 3000,
    afterApply: async ({ root }) => { await writeFile(join(root, 'SKILL.md'), '# tampered after write\n'); } }),
  /INSTALL_VERIFY_FAILED/);
  assert.deepEqual(await snapshotOf(target),
    Object.fromEntries(Object.entries(prior).map(([relPath, content]) => [relPath, sha256(content)])),
    'the tree must be restored to the exact previous state');
  await assert.rejects(readFile(join(receipts, 'demo-skill-demo-candidate-001-3000.receipt.json'), 'utf8'),
    /ENOENT/, 'a failed install must not leave a receipt');
});

test('a receipt root outside the allowed parent is refused', async (t) => {
  const { base, allowedParent, target, candidateDir } = await staged(t);
  const candidate = candidateOf(candidateDir);
  const plan = await planEnable({ allowedParent, root: target, skillId: 'demo-skill', candidate });
  await assert.rejects(applyEnable({ plan, allowedParent, root: target, skillId: 'demo-skill', candidate,
    receiptRoot: join(base, 'outside-receipts'), now: () => 4000 }), /RECEIPT_OUT_OF_SCOPE/);
});

test('apply refuses when the candidate changed after the preview', async (t) => {
  const { allowedParent, target, candidateDir, receipts } = await staged(t);
  const candidate = candidateOf(candidateDir);
  const plan = await planEnable({ allowedParent, root: target, skillId: 'demo-skill', candidate });
  await writeFile(join(candidateDir, 'refs', 'notes.md'), 'notes v1 changed\n');
  await assert.rejects(applyEnable({ plan, allowedParent, root: target, skillId: 'demo-skill',
    candidate: candidateOf(candidateDir, { files: [
      { relPath: 'SKILL.md', sha256: sha256('# demo skill\n\nv1 body\n') },
      { relPath: 'refs/notes.md', sha256: sha256('notes v1 changed\n') }] }),
    receiptRoot: receipts, now: () => 5000 }), /PLAN_CHANGED_SINCE_PREVIEW/);
  assert.deepEqual(await snapshotOf(target), {}, 'nothing may be written when the plan is stale');
});

test('apply refuses when a candidate file no longer matches its sealed digest', async (t) => {
  const { allowedParent, target, candidateDir, receipts } = await staged(t);
  const candidate = candidateOf(candidateDir);
  const plan = await planEnable({ allowedParent, root: target, skillId: 'demo-skill', candidate });
  await writeFile(join(candidateDir, 'refs', 'notes.md'), 'notes v1 changed\n');
  await assert.rejects(applyEnable({ plan, allowedParent, root: target, skillId: 'demo-skill',
    candidate, receiptRoot: receipts, now: () => 6000 }), /CANDIDATE_FILE_CHANGED/);
  assert.deepEqual(await snapshotOf(target), {}, 'nothing may be written when a candidate file moved');
});

// ---------- P3-3 rollback + re-entry ----------

import { rollbackEnable, assertNoInstallInProgress } from '../control/enablement.mjs';

async function stagedWithBackup(t, { installed = null } = {}) {
  const staged0 = await staged(t, { installed });
  const backups = join(staged0.allowedParent, 'backups');
  return { ...staged0, backups };
}

test('apply writes a disk backup, clears its marker, and rollback restores across processes', async (t) => {
  const prior = { 'SKILL.md': '# demo skill\n\nv1 body\n' };
  const { allowedParent, target, candidateDir, receipts, backups } = await stagedWithBackup(t, { installed: prior });
  await writeFile(join(candidateDir, 'SKILL.md'), '# demo skill\n\nv2 body\n');
  const candidate = candidateOf(candidateDir, { files: [
    { relPath: 'SKILL.md', sha256: sha256('# demo skill\n\nv2 body\n') }] });
  const previous = { files: [{ relPath: 'SKILL.md', sha256: sha256('# demo skill\n\nv1 body\n') }] };
  const plan = await planEnable({ allowedParent, root: target, skillId: 'demo-skill', candidate, previous });
  const { receipt } = await applyEnable({ plan, allowedParent, root: target, skillId: 'demo-skill', candidate,
    previous, receiptRoot: receipts, backupRoot: backups, now: () => 9000 });
  assert.equal(typeof receipt.backupId, 'string');
  assert.deepEqual(await snapshotOf(target), { 'SKILL.md': sha256('# demo skill\n\nv2 body\n') });
  await assert.rejects(readFile(join(backups, receipt.backupId, 'IN_PROGRESS'), 'utf8'), /ENOENT/);
  const stillFresh = await assertNoInstallInProgress({ backupRoot: backups, skillId: 'demo-skill' });
  assert.equal(stillFresh.inProgress, false);

  // 模拟"另一个进程"：只凭磁盘上的备份回退，不需要任何内存状态
  const { receipt: rollbackReceipt, receiptPath } = await rollbackEnable({ allowedParent, root: target,
    skillId: 'demo-skill', backupRoot: backups, receiptRoot: receipts, now: () => 9100 });
  assert.equal(rollbackReceipt.verified, true);
  assert.equal(rollbackReceipt.recovered, false);
  assert.deepEqual(await snapshotOf(target), { 'SKILL.md': sha256('# demo skill\n\nv1 body\n') });
  assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).restoredDigest, rollbackReceipt.restoredDigest);
});

test('a leftover marker blocks a new install until it is rolled back', async (t) => {
  const prior = { 'SKILL.md': '# demo skill\n\nv1 body\n' };
  const { allowedParent, target, candidateDir, receipts, backups } = await stagedWithBackup(t, { installed: prior });
  const candidate = candidateOf(candidateDir, { files: [
    { relPath: 'SKILL.md', sha256: sha256('# demo skill\n\nv1 body\n') }] });
  const previous = { files: [{ relPath: 'SKILL.md', sha256: sha256('# demo skill\n\nv1 body\n') }] };
  const plan = await planEnable({ allowedParent, root: target, skillId: 'demo-skill', candidate, previous });
  await assert.rejects(applyEnable({ plan, allowedParent, root: target, skillId: 'demo-skill', candidate,
    previous, receiptRoot: receipts, backupRoot: backups, now: () => 9200,
    afterApply: async () => { throw new Error('crash simulation'); } }), /INSTALL_APPLY_FAILED/);
  // 失败路径已自愈（还原 + 清标记）→ 不算"未完成安装"
  assert.equal((await assertNoInstallInProgress({ backupRoot: backups, skillId: 'demo-skill' })).inProgress, false);
  // 人为留下标记，模拟"进程被杀"的半成品状态
  const leftover = join(backups, 'demo-skill@1');
  await mkdir(join(leftover, 'files'), { recursive: true });
  await writeFile(join(leftover, 'manifest.json'), `${JSON.stringify({ skillId: 'demo-skill', candidateId: 'c',
    planDigest: plan.planDigest, takenAt: 1, files: [{ relPath: 'SKILL.md', sha256: sha256('# demo skill\n\nv1 body\n') }] })}\n`);
  await writeFile(join(leftover, 'files', 'SKILL.md'), '# demo skill\n\nv1 body\n');
  await writeFile(join(leftover, 'IN_PROGRESS'), '{}\n');
  await assert.rejects(applyEnable({ plan, allowedParent, root: target, skillId: 'demo-skill', candidate,
    previous, receiptRoot: receipts, backupRoot: backups, now: () => 9300 }), /INSTALL_IN_PROGRESS/);
  const { receipt } = await rollbackEnable({ allowedParent, root: target, skillId: 'demo-skill',
    backupRoot: backups, receiptRoot: receipts, installId: 'demo-skill@1', now: () => 9400 });
  assert.equal(receipt.recovered, true, 'a crashed install must be reported as recovered');
  assert.equal((await assertNoInstallInProgress({ backupRoot: backups, skillId: 'demo-skill' })).inProgress, false);
  await assert.rejects(readFile(join(leftover, 'IN_PROGRESS'), 'utf8'), /ENOENT/);
});

test('a rollback that cannot prove the restore keeps the marker and fails', async (t) => {
  const prior = { 'SKILL.md': '# demo skill\n\nv1 body\n' };
  const { allowedParent, target, candidateDir, receipts, backups } = await stagedWithBackup(t, { installed: prior });
  const candidate = candidateOf(candidateDir, { files: [
    { relPath: 'SKILL.md', sha256: sha256('# demo skill\n\nv1 body\n') }] });
  const previous = { files: [{ relPath: 'SKILL.md', sha256: sha256('# demo skill\n\nv1 body\n') }] };
  const plan = await planEnable({ allowedParent, root: target, skillId: 'demo-skill', candidate, previous });
  const { receipt } = await applyEnable({ plan, allowedParent, root: target, skillId: 'demo-skill', candidate,
    previous, receiptRoot: receipts, backupRoot: backups, now: () => 9500 });
  await assert.rejects(rollbackEnable({ allowedParent, root: target, skillId: 'demo-skill', backupRoot: backups,
    receiptRoot: receipts, installId: receipt.backupId, now: () => 9600,
    afterRestore: async ({ root }) => { await writeFile(join(root, 'SKILL.md'), '# tampered after restore\n'); } }),
  /ROLLBACK_VERIFY_FAILED/);
  await assert.rejects(assertNoInstallInProgress({ backupRoot: backups, skillId: 'demo-skill' }),
    /INSTALL_IN_PROGRESS/, 'a failed rollback must stay visible as in-progress');
  const marker = await readFile(join(backups, receipt.backupId, 'IN_PROGRESS'), 'utf8');
  assert.match(marker, /"phase":"rollback"/, 'the leftover marker must say the rollback was the unfinished step');
});

test('rollback refuses when there is no backup to restore', async (t) => {
  const { allowedParent, target, receipts, backups } = await stagedWithBackup(t);
  await assert.rejects(rollbackEnable({ allowedParent, root: target, skillId: 'demo-skill', backupRoot: backups,
    receiptRoot: receipts, now: () => 9700 }), /NO_BACKUP/);
  await assert.rejects(rollbackEnable({ allowedParent, root: target, skillId: 'demo-skill', backupRoot: backups,
    receiptRoot: receipts, installId: 'demo-skill@404', now: () => 9800 }), /NO_BACKUP|UNKNOWN_BACKUP/);
});

test('backup and receipt roots outside the allowed parent are refused', async (t) => {
  const { base, allowedParent, target, candidateDir, receipts } = await stagedWithBackup(t);
  const candidate = candidateOf(candidateDir);
  const plan = await planEnable({ allowedParent, root: target, skillId: 'demo-skill', candidate });
  await assert.rejects(applyEnable({ plan, allowedParent, root: target, skillId: 'demo-skill', candidate,
    receiptRoot: receipts, backupRoot: join(base, 'outside-backups'), now: () => 9900 }), /BACKUP_OUT_OF_SCOPE/);
});

// ---------- P3-4 observation window ----------

import { observeInstalled } from '../control/enablement.mjs';

test('a capture observation records its reading, and live observation needs explicit authorisation', async (t) => {
  const { allowedParent, target, candidateDir, receipts } = await staged(t);
  const candidate = candidateOf(candidateDir);
  const plan = await planEnable({ allowedParent, root: target, skillId: 'demo-skill', candidate });
  await applyEnable({ plan, allowedParent, root: target, skillId: 'demo-skill', candidate,
    receiptRoot: receipts, now: () => 11000 });
  let calls = 0;
  const observer = async () => { calls += 1; return { mode: 'capture', ok: true, detail: 'skill loaded, digest matched',
    files: ['SKILL.md', 'refs/notes.md'] }; };
  await assert.rejects(observeInstalled({ allowedParent, root: target, skillId: 'demo-skill',
    candidateId: candidate.candidateId, observer, observation: { mode: 'live' }, receiptRoot: receipts,
    now: () => 11100 }), /EGRESS_NOT_AUTHORIZED/);
  assert.equal(calls, 0, 'an unauthorised live window must not even start');
  const { receipt, receiptPath } = await observeInstalled({ allowedParent, root: target, skillId: 'demo-skill',
    candidateId: candidate.candidateId, observer, observation: { mode: 'capture' }, receiptRoot: receipts,
    now: () => 11200 });
  assert.equal(receipt.observation.ok, true);
  assert.equal(receipt.observation.mode, 'capture');
  assert.deepEqual(receipt.observation.files, ['SKILL.md', 'refs/notes.md']);
  assert.equal(receipt.verified, true);
  assert.match(receiptPath, /demo-skill-observation-11200\.receipt\.json$/);
  assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).installedDigest, receipt.installedDigest);
});

test('a failed observation is recorded as a failure, never silently dropped', async (t) => {
  const { allowedParent, target, candidateDir, receipts } = await staged(t);
  const candidate = candidateOf(candidateDir);
  const plan = await planEnable({ allowedParent, root: target, skillId: 'demo-skill', candidate });
  await applyEnable({ plan, allowedParent, root: target, skillId: 'demo-skill', candidate,
    receiptRoot: receipts, now: () => 12000 });
  const { receipt } = await observeInstalled({ allowedParent, root: target, skillId: 'demo-skill',
    candidateId: candidate.candidateId, observer: async () => ({ mode: 'capture', ok: false,
      detail: 'skill tool returned an unexpected digest' }),
    observation: { mode: 'capture' }, receiptRoot: receipts, now: () => 12100 });
  assert.equal(receipt.observation.ok, false);
  assert.match(receipt.observation.detail, /unexpected digest/);
});

test('observation refuses a tree that no longer matches the install record', async (t) => {
  const { allowedParent, target, candidateDir, receipts } = await staged(t);
  const candidate = candidateOf(candidateDir);
  const plan = await planEnable({ allowedParent, root: target, skillId: 'demo-skill', candidate });
  const { receipt } = await applyEnable({ plan, allowedParent, root: target, skillId: 'demo-skill',
    candidate, receiptRoot: receipts, now: () => 14000 });
  await writeFile(join(target, 'SKILL.md'), '# demo skill\n\nTAMPERED AFTER INSTALL\n');
  await assert.rejects(observeInstalled({ allowedParent, root: target, skillId: 'demo-skill',
    candidateId: candidate.candidateId, observer: async () => ({ mode: 'capture', ok: true }),
    observation: { mode: 'capture' }, expectedFiles: receipt.files, receiptRoot: receipts,
    now: () => 14100 }), /INSTALLED_STATE_DRIFT/);
  // 正控：把树改回安装时的内容，同一个 expectedFiles 必须放行（证明这条检查会绿，不是只会红）
  await writeFile(join(target, 'SKILL.md'), '# demo skill\n\nv1 body\n');
  const intact = await observeInstalled({ allowedParent, root: target, skillId: 'demo-skill',
    candidateId: candidate.candidateId, observer: async () => ({ mode: 'capture', ok: true }),
    observation: { mode: 'capture' }, expectedFiles: receipt.files, receiptRoot: receipts,
    now: () => 14200 });
  assert.equal(intact.receipt.observation.ok, true);
});

test('observation refuses drift, mismatched modes and malformed results', async (t) => {
  const { allowedParent, target, candidateDir, receipts } = await staged(t);
  const candidate = candidateOf(candidateDir);
  const plan = await planEnable({ allowedParent, root: target, skillId: 'demo-skill', candidate });
  await assert.rejects(observeInstalled({ allowedParent, root: target, skillId: 'demo-skill',
    candidateId: candidate.candidateId, observer: async () => ({ mode: 'capture', ok: true }),
    observation: { mode: 'capture' }, receiptRoot: receipts, now: () => 13000 }), /INSTALLED_STATE_DRIFT/);
  await applyEnable({ plan, allowedParent, root: target, skillId: 'demo-skill', candidate,
    receiptRoot: receipts, now: () => 13100 });
  await assert.rejects(observeInstalled({ allowedParent, root: target, skillId: 'demo-skill',
    candidateId: candidate.candidateId, observer: async () => ({ mode: 'live', ok: true }),
    observation: { mode: 'capture' }, receiptRoot: receipts, now: () => 13200 }), /INVALID_OBSERVATION_RESULT/);
  await assert.rejects(observeInstalled({ allowedParent, root: target, skillId: 'demo-skill',
    candidateId: candidate.candidateId, observer: async () => 'fine',
    observation: { mode: 'capture' }, receiptRoot: receipts, now: () => 13300 }), /INVALID_OBSERVATION_RESULT/);
  const okObserver = async () => ({ mode: 'capture', ok: true });
  await observeInstalled({ allowedParent, root: target, skillId: 'demo-skill',
    candidateId: candidate.candidateId, observer: okObserver, observation: { mode: 'capture' },
    receiptRoot: receipts, now: () => 13400 });
  await assert.rejects(observeInstalled({ allowedParent, root: target, skillId: 'demo-skill',
    candidateId: candidate.candidateId, observer: okObserver, observation: { mode: 'capture' },
    receiptRoot: receipts, now: () => 13400 }), /RECEIPT_EXISTS/);
});
