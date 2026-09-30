import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreTrees } from '../trial-home/screening/skill-repair-restore.mjs';

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const sealed = payload => Buffer.concat([Buffer.from([0x88, 0x7d, 0x1c, 0x03, 0x3a, 0x05, 0xf6, 0x03]),
  Buffer.alloc(4088), Buffer.from(payload)]);

const READABLE = '---\nname: launch\n---\n\n# 上市策略\n\n## Workflow\n\n1. 先复算。\n';

async function makeLibrary(t, files) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'rs-'));
  const library = join(root, 'library');
  for (const [relPath, content] of Object.entries(files)) {
    await mkdir(join(library, relPath, '..'), { recursive: true });
    await writeFile(join(library, relPath), content);
  }
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => {}); });
  return { library, backup: join(root, 'backup') };
}

const pair = { targetDir: '81-Skills/launch', sourceDir: '4-Skills/launch' };

test('an opaque tree is restored from its readable twin, with the sealed bytes kept as backup', async (t) => {
  const { library, backup } = await makeLibrary(t, {
    '81-Skills/launch/SKILL.md': sealed('sealed-body'),
    '81-Skills/launch/scripts/run.py': sealed('sealed-script'),
    '81-Skills/launch/tests/.gitkeep': '',
    '4-Skills/launch/SKILL.md': READABLE,
    '4-Skills/launch/scripts/run.py': 'print("ok")\n',
    '4-Skills/launch/.DS_Store': 'source-finder-metadata',
  });
  const receipt = await restoreTrees({ restores: [pair], library, backupRoot: backup, apply: true });
  assert.equal(receipt.refusals.length, 0);
  const action = receipt.skills[0];
  assert.equal(action.restored, 2, '两个容器文件都要换成明文');
  assert.equal(action.opaqueBefore, 2);
  assert.deepEqual(action.skippedMetadata, ['.DS_Store'], 'Finder 元数据不跟着孪生走');
  assert.equal(await readFile(join(library, '81-Skills/launch/SKILL.md'), 'utf8'), READABLE);
  assert.equal(await readFile(join(library, '81-Skills/launch/scripts/run.py'), 'utf8'), 'print("ok")\n');
  assert.deepEqual(await readFile(join(backup, '81-Skills/launch/SKILL.md')), sealed('sealed-body'),
    '改前的不透明原件要留在项目内');
  assert.deepEqual(action.retained, ['tests/.gitkeep'], '目标侧多出来的文件保留并列出，不删');
});

test('a readable target is refused, and nothing is written', async (t) => {
  const { library, backup } = await makeLibrary(t, {
    '81-Skills/launch/SKILL.md': READABLE,
    '4-Skills/launch/SKILL.md': READABLE,
  });
  const receipt = await restoreTrees({ restores: [pair], library, backupRoot: backup, apply: true });
  assert.equal(receipt.skills.length, 0);
  assert.equal(receipt.refusals[0].reason.startsWith('TARGET_NOT_OPAQUE'), true,
    `可读目标必须拒换：${JSON.stringify(receipt.refusals)}`);
});

test('an opaque twin cannot be used as the source, and dry-run writes nothing', async (t) => {
  const { library, backup } = await makeLibrary(t, {
    '81-Skills/launch/SKILL.md': sealed('a'),
    '4-Skills/launch/SKILL.md': sealed('b'),
  });
  const refused = await restoreTrees({ restores: [pair], library, backupRoot: backup, apply: true });
  assert.equal(refused.refusals[0].reason.startsWith('SOURCE_UNREADABLE'), true);

  const { library: lib2, backup: backup2 } = await makeLibrary(t, {
    '81-Skills/launch/SKILL.md': sealed('sealed-body'),
    '4-Skills/launch/SKILL.md': READABLE,
  });
  const dry = await restoreTrees({ restores: [pair], library: lib2, backupRoot: backup2, apply: false });
  assert.equal(dry.skills[0].restored, 1);
  assert.deepEqual(await readFile(join(lib2, '81-Skills/launch/SKILL.md')), sealed('sealed-body'),
    'dry-run 下目标逐字节不变');
});

test('identical files are counted, not rewritten', async (t) => {
  const { library, backup } = await makeLibrary(t, {
    '81-Skills/launch/SKILL.md': sealed('x'),
    '81-Skills/launch/README.md': 'same\n',
    '4-Skills/launch/SKILL.md': READABLE,
    '4-Skills/launch/README.md': 'same\n',
  });
  const receipt = await restoreTrees({ restores: [pair], library, backupRoot: backup, apply: true });
  const action = receipt.skills[0];
  assert.equal(action.identical, 1, '逐字节相同的文件记 identical');
  assert.equal(action.restored, 1);
  assert.equal(action.files.find(file => file.relPath === 'README.md').action, 'identical');
  assert.equal(sha256(await readFile(join(library, '81-Skills/launch/README.md'))), sha256(Buffer.from('same\n')));
});
