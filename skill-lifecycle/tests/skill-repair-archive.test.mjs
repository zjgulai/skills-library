import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveTrees } from '../trial-home/screening/skill-repair-archive.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'archive-'));
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  const library = join(base, 'library');
  const archive = join(base, 'archive');
  await mkdir(join(library, 'pkg', 'old-skill'), { recursive: true });
  await writeFile(join(library, 'pkg', 'old-skill', 'SKILL.md'),
    '---\nname: old-skill\nversion: "1.0.0"\n---\n\n# 旧\n\n正文。\n');
  await writeFile(join(library, 'pkg', 'old-skill', 'notes.md'), 'notes\n');
  return { base, library, archive };
}

const exists = async path => await stat(path).then(() => true, () => false);

test('dry-run：报告文件数、不动盘、不写回执', async (t) => {
  const { library, archive } = await fixture(t);
  const receipt = await archiveTrees({ moves: [{ relDir: 'pkg/old-skill', expectName: 'old-skill' }],
    library, archiveRoot: archive });
  assert.equal(receipt.moved.length, 1);
  assert.equal(receipt.moved[0].files, 2);
  assert.equal(await exists(join(library, 'pkg', 'old-skill')), true, 'dry-run 不许动库');
  assert.equal(await exists(join(archive, 'archive-receipt.json')), false);
});

test('apply：整树进归档、逐文件一致、源树消失、回执落盘', async (t) => {
  const { library, archive } = await fixture(t);
  const receipt = await archiveTrees({ apply: true,
    moves: [{ relDir: 'pkg/old-skill', expectName: 'old-skill' }], library, archiveRoot: archive });
  assert.equal(receipt.refusals.length, 0);
  assert.equal(await exists(join(library, 'pkg', 'old-skill')), false, '源树应已移出');
  const archived = await readFile(join(archive, 'old-skill', 'SKILL.md'), 'utf8');
  assert.match(archived, /name: old-skill/);
  assert.equal(await readFile(join(archive, 'old-skill', 'notes.md'), 'utf8'), 'notes\n');
  const written = JSON.parse(await readFile(join(archive, 'archive-receipt.json'), 'utf8'));
  assert.equal(written.moved.length, 1);
});

test('身份闸门：name 与 expectName 不一致即整份拒收（不动盘）', async (t) => {
  const { library, archive } = await fixture(t);
  const receipt = await archiveTrees({ apply: true,
    moves: [{ relDir: 'pkg/old-skill', expectName: 'another-name' }], library, archiveRoot: archive });
  assert.match(receipt.refusals[0].reason, /IDENTITY_MISMATCH/);
  assert.equal(await exists(join(library, 'pkg', 'old-skill')), true, '拒收后源树原样');
});

test('归档已存在即拒（不覆盖既有归档）', async (t) => {
  const { library, archive } = await fixture(t);
  await mkdir(join(archive, 'old-skill'), { recursive: true });
  await writeFile(join(archive, 'old-skill', 'SKILL.md'), '既有归档\n');
  const receipt = await archiveTrees({ apply: true,
    moves: [{ relDir: 'pkg/old-skill', expectName: 'old-skill' }], library, archiveRoot: archive });
  assert.equal(receipt.refusals[0].reason, 'ARCHIVE_EXISTS');
  assert.equal(await readFile(join(archive, 'old-skill', 'SKILL.md'), 'utf8'), '既有归档\n', '归档不被覆盖');
});

test('不透明容器不能退役（那是唯一一份）', async (t) => {
  const { library, archive } = await fixture(t);
  await writeFile(join(library, 'pkg', 'old-skill', 'SKILL.md'),
    Buffer.from([0x88, 0x7d, 0x1c, 0x00, 0x01, 0x02, 0x03, 0x04E]));
  const receipt = await archiveTrees({ apply: true,
    moves: [{ relDir: 'pkg/old-skill', expectName: 'old-skill' }], library, archiveRoot: archive });
  assert.match(receipt.refusals[0].reason, /TARGET_OPAQUE/);
  assert.equal(await exists(join(library, 'pkg', 'old-skill')), true);
});
