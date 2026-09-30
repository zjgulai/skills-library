import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyWritebackOps } from '../trial-home/screening/skill-repair-writeback.mjs';

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const readOrNull = async path => await readFile(path, 'utf8').catch(() => null);

async function fixture(t) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'writeback-'));
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  const library = join(base, 'library');
  const backup = join(base, 'backup');
  const candidate = join(base, 'candidate');
  await mkdir(join(library, 'skill'), { recursive: true });
  await mkdir(candidate, { recursive: true });
  return { base, library, backup, candidate };
}

const putOp = (library, candidate, { relPath, before, after }) => ({
  kind: 'put', relPath, source: join(candidate, relPath.split('/').pop()),
  sourceSha256: sha256(after),
  ...(before === null ? { expectAbsent: true } : { expectSha256: sha256(before) }),
});

test('dry-run records the change set without touching the library', async (t) => {
  const { library, backup, candidate } = await fixture(t);
  await writeFile(join(library, 'skill', 'SKILL.md'), 'old\n');
  await writeFile(join(candidate, 'SKILL.md'), 'new\n');
  const receipt = await applyWritebackOps({ ops: [
    putOp(library, candidate, { relPath: 'skill/SKILL.md', before: 'old\n', after: 'new\n' }),
  ], library, backupRoot: backup });
  assert.equal(receipt.applied, false);
  assert.equal(receipt.changes.length, 1);
  assert.equal(await readOrNull(join(library, 'skill', 'SKILL.md')), 'old\n', 'dry-run 不许动库');
  assert.equal(await readOrNull(join(backup, 'writeback-receipt.json')), null, 'dry-run 不写回执');
});

test('apply overwrites with a backup of the previous content and a receipt', async (t) => {
  const { library, backup, candidate } = await fixture(t);
  await writeFile(join(library, 'skill', 'SKILL.md'), 'old\n');
  await writeFile(join(candidate, 'SKILL.md'), 'new\n');
  const receipt = await applyWritebackOps({ apply: true, ops: [
    putOp(library, candidate, { relPath: 'skill/SKILL.md', before: 'old\n', after: 'new\n' }),
  ], library, backupRoot: backup });
  assert.equal(await readOrNull(join(library, 'skill', 'SKILL.md')), 'new\n');
  assert.equal(await readOrNull(join(backup, 'skill', 'SKILL.md')), 'old\n', '备份必须是改前原件');
  const written = JSON.parse(await readFile(join(backup, 'writeback-receipt.json'), 'utf8'));
  assert.equal(written.changes[0].before, sha256('old\n').slice(0, 16));
  assert.equal(written.changes[0].after, sha256('new\n').slice(0, 16));
  assert.equal(receipt.refusals.length, 0);
});

test('put gates: source digest, target digest, absence and presence', async (t) => {
  const { library, backup, candidate } = await fixture(t);
  await writeFile(join(library, 'skill', 'SKILL.md'), 'old\n');
  await writeFile(join(candidate, 'SKILL.md'), 'new\n');
  const common = { relPath: 'skill/SKILL.md', source: join(candidate, 'SKILL.md') };

  const sourceChanged = await applyWritebackOps({ apply: true, ops: [
    { kind: 'put', ...common, sourceSha256: sha256('something else\n'), expectSha256: sha256('old\n') },
  ], library, backupRoot: backup });
  assert.equal(sourceChanged.refusals[0].reason, 'SOURCE_CHANGED');

  const contentChanged = await applyWritebackOps({ apply: true, ops: [
    { kind: 'put', ...common, sourceSha256: sha256('new\n'), expectSha256: sha256('stale\n') },
  ], library, backupRoot: backup });
  assert.equal(contentChanged.refusals[0].reason, 'CONTENT_CHANGED');

  const targetExists = await applyWritebackOps({ apply: true, ops: [
    { kind: 'put', ...common, sourceSha256: sha256('new\n'), expectAbsent: true },
  ], library, backupRoot: backup });
  assert.equal(targetExists.refusals[0].reason, 'TARGET_EXISTS');

  const targetMissing = await applyWritebackOps({ apply: true, ops: [
    { kind: 'put', ...common, sourceSha256: sha256('new\n'), expectSha256: sha256('old\n'),
      relPath: 'skill/OTHER.md' },
  ], library, backupRoot: backup });
  assert.equal(targetMissing.refusals[0].reason, 'TARGET_MISSING');
  assert.equal(await readOrNull(join(library, 'skill', 'SKILL.md')), 'old\n', '全部拒收后库保持原样');
});

test('put can create a brand-new file and remove can drop one, both with backups', async (t) => {
  const { library, backup, candidate } = await fixture(t);
  await mkdir(join(candidate), { recursive: true });
  await writeFile(join(candidate, 'skills_mgr.py'), 'print("hi")\n');
  await writeFile(join(library, 'skill', 'run.py'), 'legacy\n');

  await applyWritebackOps({ apply: true, ops: [
    { kind: 'put', relPath: 'skill/scripts/skills_mgr.py', source: join(candidate, 'skills_mgr.py'),
      sourceSha256: sha256('print("hi")\n'), expectAbsent: true },
    { kind: 'remove', relPath: 'skill/run.py', expectSha256: sha256('legacy\n') },
  ], library, backupRoot: backup });

  assert.equal(await readOrNull(join(library, 'skill', 'scripts', 'skills_mgr.py')), 'print("hi")\n');
  assert.equal(await readOrNull(join(library, 'skill', 'run.py')), null);
  assert.equal(await readOrNull(join(backup, 'skill', 'run.py')), 'legacy\n', '删除件也要留备份');
  assert.equal(await readOrNull(join(backup, 'skill', 'scripts', 'skills_mgr.py')), null,
    '新建件没有"改前原件"，不该有备份');
});

test('remove refuses a digest mismatch and a missing target', async (t) => {
  const { library, backup } = await fixture(t);
  await writeFile(join(library, 'skill', 'run.py'), 'legacy\n');
  const changed = await applyWritebackOps({ apply: true, ops: [
    { kind: 'remove', relPath: 'skill/run.py', expectSha256: sha256('other\n') },
    { kind: 'remove', relPath: 'skill/gone.py', expectSha256: sha256('x\n') },
  ], library, backupRoot: backup });
  assert.deepEqual(changed.refusals.map(item => item.reason), ['CONTENT_CHANGED', 'TARGET_MISSING']);
  assert.equal(await readOrNull(join(library, 'skill', 'run.py')), 'legacy\n');
});

test('an existing receipt blocks a second apply before anything is touched', async (t) => {
  const { library, backup, candidate } = await fixture(t);
  await writeFile(join(library, 'skill', 'SKILL.md'), 'old\n');
  await writeFile(join(candidate, 'SKILL.md'), 'new\n');
  const ops = [putOp(library, candidate, { relPath: 'skill/SKILL.md', before: 'old\n', after: 'new\n' })];
  await applyWritebackOps({ apply: true, ops, library, backupRoot: backup });
  await assert.rejects(() => applyWritebackOps({ apply: true, ops, library, backupRoot: backup }),
    error => error.code === 'RECEIPT_EXISTS');
});

test('prune-empty-dirs: dry-run 报告"将被清空"的目录但一字节不动', async (t) => {
  const { library, backup } = await fixture(t);
  await mkdir(join(library, 'skill', 'tests', 'momcozy'), { recursive: true });
  await writeFile(join(library, 'skill', 'tests', 'momcozy', 'a.md'), 'x\n');
  await writeFile(join(library, 'skill', 'tests', 'keep.md'), 'k\n');
  const receipt = await applyWritebackOps({ ops: [
    { kind: 'remove', relPath: 'skill/tests/momcozy/a.md', expectSha256: sha256('x\n') },
    { kind: 'prune-empty-dirs', root: 'skill' },
  ], library, backupRoot: backup });
  const prune = receipt.changes.find(c => c.kind === 'prune-empty-dirs');
  assert.deepEqual(prune.pruned, ['skill/tests/momcozy'], '只有会被删空的 momcozy 在列；keep.md 所在目录不是');
  assert.equal(await readOrNull(join(library, 'skill', 'tests', 'momcozy', 'a.md')), 'x\n', 'dry-run 不动盘');
});

test('prune-empty-dirs: apply 后壳目录消失，root 自身与非空目录都保留', async (t) => {
  const { library, backup } = await fixture(t);
  await mkdir(join(library, 'skill', 'tests', 'momcozy'), { recursive: true });
  await mkdir(join(library, 'skill', 'scripts'), { recursive: true });
  await writeFile(join(library, 'skill', 'tests', 'momcozy', 'a.md'), 'x\n');
  await writeFile(join(library, 'skill', 'scripts', 'run.py'), 'print(1)\n');
  const receipt = await applyWritebackOps({ apply: true, ops: [
    { kind: 'remove', relPath: 'skill/tests/momcozy/a.md', expectSha256: sha256('x\n') },
    { kind: 'prune-empty-dirs', root: 'skill' },
  ], library, backupRoot: backup });
  assert.equal(await readOrNull(join(library, 'skill', 'tests', 'momcozy')), null, '空壳应被剪掉');
  assert.notEqual(await readOrNull(join(library, 'skill', 'scripts', 'run.py')), null, '非空目录保留');
  assert.equal(await stat(join(library, 'skill')).then(s => s.isDirectory(), () => false), true, 'root 自身不删');
  assert.ok(receipt.refusals.length === 0);
});

test('prune-empty-dirs: root 不存在即拒（ROOT_MISSING），不抛不猜', async (t) => {
  const { library, backup } = await fixture(t);
  const receipt = await applyWritebackOps({ apply: true, ops: [
    { kind: 'prune-empty-dirs', root: 'skill/nope' },
  ], library, backupRoot: backup });
  assert.equal(receipt.refusals[0].reason, 'ROOT_MISSING');
  assert.equal(await stat(join(library, 'skill')).then(s => s.isDirectory(), () => false), true, '拒收时一切原样');
});

test('an invalid op shape is rejected up front', async (t) => {
  const { library, backup } = await fixture(t);
  await assert.rejects(() => applyWritebackOps({ ops: [{ kind: 'rename', relPath: 'x' }], library, backupRoot: backup }),
    error => error.code.startsWith('INVALID_OP_KIND'));
  await assert.rejects(() => applyWritebackOps({ ops: [{ kind: 'put', relPath: 'x' }], library, backupRoot: backup }),
    error => error.code.startsWith('INVALID_OP'));
  await assert.rejects(() => applyWritebackOps({ ops: [], library, backupRoot: backup }),
    error => error.code === 'EMPTY_PLAN');
});
