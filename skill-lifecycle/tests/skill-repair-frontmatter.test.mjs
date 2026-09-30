import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDrafts, renderFrontmatter } from '../trial-home/screening/skill-repair-frontmatter.mjs';

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

const BODY = [
  '# 示例技能', '',
  '## Workflow', '',
  '1. 先核对输入身份，再复算关键数字，每一步都留依据。',
  '2. 材料不足时说明缺什么，而不是猜。', '',
].join('\n');

async function makeLibrary(t, files) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'fm-'));
  const library = join(root, 'library');
  await mkdir(library, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    await mkdir(join(library, relPath, '..'), { recursive: true });
    await writeFile(join(library, relPath), content);
  }
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => {}); });
  return { root, library, backup: join(root, 'backup') };
}

const draftFor = (relPath, bytes, description, name = 'demo-skill') => ({
  relPath, folderName: name, name, description, evidence: 'x', flags: [],
  bodySha256: sha256(Buffer.from(bytes, 'utf8')), bodyBytes: Buffer.byteLength(bytes, 'utf8'),
});

test('dry-run never writes and apply backs up before writing', async (t) => {
  const { library, backup } = await makeLibrary(t, { 'demo-skill/SKILL.md': BODY });
  const draft = draftFor('demo-skill/SKILL.md', BODY,
    'Use when the user asks for a demo workflow: 先复算，再报告。');

  const dry = await applyDrafts({ drafts: [draft], library, backupRoot: backup, apply: false });
  assert.equal(dry.changes.length, 1);
  assert.equal(dry.refusals.length, 0);
  assert.equal(await readFile(join(library, 'demo-skill/SKILL.md'), 'utf8'), BODY, 'dry-run 必须一个字节都不写');
  await assert.rejects(stat(backup), /ENOENT/, 'dry-run 不该建备份目录');

  const applied = await applyDrafts({ drafts: [draft], library, backupRoot: backup, apply: true });
  assert.equal(applied.applied, true);
  const written = await readFile(join(library, 'demo-skill/SKILL.md'), 'utf8');
  assert.match(written, /^---\nname: demo-skill\ndescription: "Use when the user asks for a demo workflow: 先复算，再报告。"\n---\n\n# 示例技能/);
  assert.equal(await readFile(join(backup, 'demo-skill/SKILL.md'), 'utf8'), BODY, '备份是改前原文');
  const receipt = JSON.parse(await readFile(join(backup, 'frontmatter-receipt.json'), 'utf8'));
  assert.equal(receipt.changes[0].sha256Before, sha256(Buffer.from(BODY, 'utf8')));
  assert.equal(receipt.changes[0].descriptionChars, [...draft.description].length);
});

test('the quoting trap: colons, quotes and newlines survive the round-trip', () => {
  const description = 'Use when the user says "帮我改简历"： 先问清目标岗位，再给建议。\n边界：不编造经历。';
  const rendered = renderFrontmatter({ name: 'demo-skill', description });
  const line = rendered.split('\n').find(row => row.startsWith('description: '));
  assert.equal(line.includes('\n'), false, 'description 必须落在单行上');
  const parsed = JSON.parse(line.replace(/^description: /, ''));
  assert.equal(parsed, description, '引号标量必须能原样还原');
});

test('a second run refuses to insert, and drift is caught before writing', async (t) => {
  const { library, backup } = await makeLibrary(t, { 'demo-skill/SKILL.md': BODY });
  const draft = draftFor('demo-skill/SKILL.md', BODY, 'Use when the user asks for a demo workflow with evidence.');
  await applyDrafts({ drafts: [draft], library, backupRoot: backup, apply: true });
  const again = await applyDrafts({ drafts: [draft], library, backupRoot: backup, apply: true });
  assert.equal(again.refusals[0].reason.startsWith('FRONTMATTER_EXISTS'), true,
    `幂等护栏必须当场拒收：${JSON.stringify(again.refusals)}`);

  const { library: library2, backup: backup2 } = await makeLibrary(t, { 'demo-skill/SKILL.md': BODY });
  const drifted = { ...draftFor('demo-skill/SKILL.md', BODY, 'Use when the user asks for a demo workflow with evidence.'),
    bodySha256: sha256(Buffer.from('另一份正文', 'utf8')) };
  const drift = await applyDrafts({ drafts: [drifted], library: library2, backupRoot: backup2, apply: true });
  assert.equal(drift.refusals[0].reason.startsWith('CONTENT_CHANGED'), true);
  assert.equal(await readFile(join(library2, 'demo-skill/SKILL.md'), 'utf8'), BODY, '被判定漂移的文件不能被动过');
});

test('a binary container is refused byte-for-byte, not text-decoded', async (t) => {
  const sealed = Buffer.concat([Buffer.from([0x88, 0x7d, 0x1c, 0x03, 0x3a, 0x05, 0xf6, 0x03]),
    Buffer.alloc(4088), Buffer.from('payload')]);
  const { library, backup } = await makeLibrary(t, {});
  await mkdir(join(library, 'sealed-skill'), { recursive: true });
  await writeFile(join(library, 'sealed-skill/SKILL.md'), sealed);
  const draft = { relPath: 'sealed-skill/SKILL.md', name: 'sealed-skill',
    description: 'Use when the user asks for a sealed skill with documented workflow.', bodySha256: sha256(sealed) };
  const receipt = await applyDrafts({ drafts: [draft], library, backupRoot: backup, apply: true });
  assert.equal(receipt.changes.length, 0);
  assert.equal(receipt.refusals[0].reason.startsWith('OPAQUE_CONTAINER'), true,
    `容器文件必须拒收：${JSON.stringify(receipt.refusals)}`);
  assert.deepEqual(await readFile(join(library, 'sealed-skill/SKILL.md')), sealed,
    '拒收后文件必须逐字节不变（utf8 往返会把它毁掉）');
});
