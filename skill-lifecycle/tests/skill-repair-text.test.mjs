import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTextOps } from '../trial-home/screening/skill-repair-text.mjs';

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

async function makeLibrary(t, files) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tx-'));
  const library = join(root, 'library');
  for (const [relPath, content] of Object.entries(files)) {
    await mkdir(join(library, relPath, '..'), { recursive: true });
    await writeFile(join(library, relPath), content);
  }
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => {}); });
  return { library, backup: join(root, 'backup') };
}

const SOURCE = '---\nname: skill\n---\n\n正文。\n';

test('replace changes exactly the expected occurrences and backs up the original', async (t) => {
  const body = 'a `references/x.md` b\nc `references/x.md` d\n';
  const { library, backup } = await makeLibrary(t, { 'demo/SKILL.md': body });
  const op = { kind: 'replace', relPath: 'demo/SKILL.md', find: ' `references/x.md`', replace: '',
    expectCount: 2, expectSha256: sha256(Buffer.from(body)) };
  const dry = await applyTextOps({ ops: [op], library, backupRoot: backup, apply: false });
  assert.equal(dry.changes[0].occurrences, 2);
  assert.equal(await readFile(join(library, 'demo/SKILL.md'), 'utf8'), body, 'dry-run 不写');

  const applied = await applyTextOps({ ops: [op], library, backupRoot: backup, apply: true });
  assert.equal(applied.changes[0].occurrences, 2);
  assert.equal(await readFile(join(library, 'demo/SKILL.md'), 'utf8'), 'a b\nc d\n');
  assert.equal(await readFile(join(backup, 'demo/SKILL.md'), 'utf8'), body);
});

test('a count mismatch or a drifted file refuses instead of guessing', async (t) => {
  const body = 'only one `references/x.md`\n';
  const { library, backup } = await makeLibrary(t, { 'demo/SKILL.md': body });
  const wrongCount = await applyTextOps({ ops: [{ kind: 'replace', relPath: 'demo/SKILL.md',
    find: ' `references/x.md`', replace: '', expectCount: 2 }], library, backupRoot: backup, apply: true,
    receiptName: 'count-mismatch.json' });
  assert.equal(wrongCount.refusals[0].reason.startsWith('COUNT_MISMATCH'), true,
    `出现次数不符必须拒：${JSON.stringify(wrongCount.refusals)}`);
  const drifted = await applyTextOps({ ops: [{ kind: 'replace', relPath: 'demo/SKILL.md',
    find: ' `references/x.md`', replace: '', expectCount: 1, expectSha256: sha256(Buffer.from('别的版本')) }],
  library, backupRoot: backup, apply: true, receiptName: 'drifted.json' });
  assert.equal(drifted.refusals[0].reason, 'CONTENT_CHANGED');
  assert.equal(await readFile(join(library, 'demo/SKILL.md'), 'utf8'), body, '被拒的文件不能被动过');
});

test('copy-in fills a missing package file and refuses to overwrite', async (t) => {
  const { library, backup } = await makeLibrary(t, { 'src/scripts/tool.py': SOURCE, 'dst/SKILL.md': 'x\n' });
  const op = { kind: 'copy-in', relPath: 'dst/scripts/tool.py', source: 'src/scripts/tool.py' };
  const dry = await applyTextOps({ ops: [op], library, backupRoot: backup, apply: false });
  assert.equal(dry.changes.length, 1);
  await assert.rejects(stat(join(library, 'dst/scripts/tool.py')), /ENOENT/, 'dry-run 不建文件');

  const applied = await applyTextOps({ ops: [op], library, backupRoot: backup, apply: true,
    receiptName: 'copy-in-first.json' });
  assert.equal(applied.changes[0].sourceSha256, sha256(Buffer.from(SOURCE)));
  assert.equal(await readFile(join(library, 'dst/scripts/tool.py'), 'utf8'), SOURCE, '补件逐字节一致');

  const again = await applyTextOps({ ops: [op], library, backupRoot: backup, apply: true,
    receiptName: 'copy-in-second.json' });
  assert.equal(again.refusals[0].reason.startsWith('TARGET_EXISTS'), true, '补件不覆盖已有文件');
});

test('several edits to one file keep the pre-run original in the backup', async (t) => {
  const body = 'one `references/a.md`\ntwo `references/b.md`\n';
  const { library, backup } = await makeLibrary(t, { 'demo/SKILL.md': body });
  const ops = [' `references/a.md`', ' `references/b.md`'].map(find => ({
    kind: 'replace', relPath: 'demo/SKILL.md', find, replace: '', expectCount: 1 }));
  const receipt = await applyTextOps({ ops, library, backupRoot: backup, apply: true,
    receiptName: 'two-edits.json' });
  assert.equal(receipt.changes.length, 2);
  assert.equal(await readFile(join(library, 'demo/SKILL.md'), 'utf8'), 'one\ntwo\n');
  assert.equal(await readFile(join(backup, 'demo/SKILL.md'), 'utf8'), body,
    '备份必须是改前原件，不是"最后一个操作前"的半成品');
});

test('a second apply cannot overwrite the first receipt', async (t) => {
  const body = 'a `references/x.md`\n';
  const { library, backup } = await makeLibrary(t, { 'demo/SKILL.md': body });
  const op = { kind: 'replace', relPath: 'demo/SKILL.md', find: ' `references/x.md`', replace: '',
    expectCount: 1 };
  await applyTextOps({ ops: [op], library, backupRoot: backup, apply: true, receiptName: 'plan-a-receipt.json' });
  await assert.rejects(
    applyTextOps({ ops: [op], library, backupRoot: backup, apply: true, receiptName: 'plan-a-receipt.json' }),
    /RECEIPT_EXISTS/, '同一份回执不许被第二次 apply 盖掉');
  // 换名字（另一份计划）则互不影响
  const other = await applyTextOps({ ops: [op], library, backupRoot: backup, apply: true,
    receiptName: 'plan-b-receipt.json' });
  assert.equal(other.applied, true);
  await stat(join(backup, 'plan-a-receipt.json'));
  await stat(join(backup, 'plan-b-receipt.json'));
});

test('an opaque target is never text-edited', async (t) => {
  const sealed = Buffer.concat([Buffer.from([0x88, 0x7d, 0x1c, 0x03]), Buffer.alloc(4092)]);
  const { library, backup } = await makeLibrary(t, {});
  await mkdir(join(library, 'sealed'), { recursive: true });
  await writeFile(join(library, 'sealed/SKILL.md'), sealed);
  const receipt = await applyTextOps({ ops: [{ kind: 'replace', relPath: 'sealed/SKILL.md',
    find: 'x', replace: 'y', expectCount: 1 }], library, backupRoot: backup, apply: true });
  assert.equal(receipt.refusals[0].reason, 'OPAQUE_CONTAINER');
  assert.deepEqual(await readFile(join(library, 'sealed/SKILL.md')), sealed);
});
