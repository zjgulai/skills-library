import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retireTrees } from '../trial-home/screening/skill-repair-retire.mjs';

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const READABLE = '---\nname: launch\n---\n\n# 上市策略\n\n## Workflow\n\n1. 先复算。\n';

async function makeLibrary(t, files) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'rt-'));
  const library = join(root, 'library');
  for (const [relPath, content] of Object.entries(files)) {
    await mkdir(join(library, relPath, '..'), { recursive: true });
    await writeFile(join(library, relPath), content);
  }
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => {}); });
  return { library, backup: join(root, 'backup') };
}

const pair = { targetDir: '4-Skills/launch', twinDir: '81-Skills/launch' };

test('a byte-identical duplicate is backed up then removed, and dry-run removes nothing', async (t) => {
  const files = {
    '4-Skills/launch/SKILL.md': READABLE,
    '4-Skills/launch/scripts/run.py': 'print("ok")\n',
    '4-Skills/launch/.DS_Store': 'target-finder-metadata',
    '81-Skills/launch/SKILL.md': READABLE,
    '81-Skills/launch/scripts/run.py': 'print("ok")\n',
    '81-Skills/launch/.gitkeep': '',
  };
  const { library, backup } = await makeLibrary(t, files);
  const dry = await retireTrees({ retires: [pair], library, backupRoot: backup, apply: false });
  assert.equal(dry.retired.length, 1);
  assert.equal(dry.retired[0].removed, false);
  await stat(join(library, '4-Skills/launch/SKILL.md'));

  const applied = await retireTrees({ retires: [pair], library, backupRoot: backup, apply: true });
  assert.equal(applied.retired[0].removed, true);
  assert.equal(applied.retired[0].compared, 2, '只比内容文件：.DS_Store 不比');
  assert.equal(applied.retired[0].sha256, sha256(Buffer.from(READABLE)), '回执记退役件的 SKILL.md 摘要');
  await assert.rejects(stat(join(library, '4-Skills/launch')), /ENOENT/, '目标目录真的没了');
  assert.equal(await readFile(join(backup, '4-Skills/launch/SKILL.md'), 'utf8'), READABLE);
  assert.equal(await readFile(join(backup, '4-Skills/launch/.DS_Store'), 'utf8'), 'target-finder-metadata',
    '备份含元数据，回滚时能整棵复原');
  assert.equal(await readFile(join(library, '81-Skills/launch/SKILL.md'), 'utf8'), READABLE, '孪生不动');
});

test('any content difference refuses the whole retire', async (t) => {
  const { library, backup } = await makeLibrary(t, {
    '4-Skills/launch/SKILL.md': READABLE,
    '4-Skills/launch/scripts/run.py': 'print("different")\n',
    '81-Skills/launch/SKILL.md': READABLE,
    '81-Skills/launch/scripts/run.py': 'print("ok")\n',
  });
  const receipt = await retireTrees({ retires: [pair], library, backupRoot: backup, apply: true });
  assert.equal(receipt.retired.length, 0);
  assert.equal(receipt.refusals[0].reason.startsWith('NOT_IDENTICAL'), true,
    `一处不同就拒收：${JSON.stringify(receipt.refusals)}`);
  await stat(join(library, '4-Skills/launch/scripts/run.py'));
});

test('a twin that lacks a file, or an opaque target, is refused', async (t) => {
  const missing = await makeLibrary(t, {
    '4-Skills/launch/SKILL.md': READABLE,
    '4-Skills/launch/references/extra.md': 'only here\n',
    '81-Skills/launch/SKILL.md': READABLE,
  });
  const receipt = await retireTrees({ retires: [pair], library: missing.library,
    backupRoot: missing.backup, apply: true });
  assert.equal(receipt.refusals[0].reason.startsWith('NOT_IDENTICAL'), true,
    '孪生没有的文件也算不一致');

  const opaque = await makeLibrary(t, {});
  await mkdir(join(opaque.library, '4-Skills/launch'), { recursive: true });
  await mkdir(join(opaque.library, '81-Skills/launch'), { recursive: true });
  const sealed = Buffer.concat([Buffer.from([0x88, 0x7d, 0x1c, 0x03]), Buffer.alloc(12)]);
  await writeFile(join(opaque.library, '4-Skills/launch/SKILL.md'), sealed);
  await writeFile(join(opaque.library, '81-Skills/launch/SKILL.md'), READABLE);
  const refused = await retireTrees({ retires: [pair], library: opaque.library,
    backupRoot: opaque.backup, apply: true });
  assert.equal(refused.refusals[0].reason.startsWith('TARGET_OPAQUE'), true,
    '不可读的那份可能是唯一一份明文来源，不能删');
});
