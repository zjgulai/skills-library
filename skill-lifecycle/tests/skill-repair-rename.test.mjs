import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = fileURLToPath(new URL('../trial-home/screening/skill-repair-rename.mjs', import.meta.url));
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const readOrNull = async path => await readFile(path, 'utf8').catch(() => null);
const exists = async path => await stat(path).then(() => true, () => false);

const skill = (name, note = 'body') => `---\nname: ${name}\ndescription: Use when the user needs a documented workflow.\n---\n\n# ${name}\n\n${note}\n`;

async function fixture(t, { relDir, name }) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'rename-'));
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  const library = join(base, 'library');
  const backup = join(base, 'backup');
  const planPath = join(base, 'plan.json');
  const root = join(library, relDir);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'SKILL.md'), skill(name));
  await writeFile(join(root, 'README.md'), 'readme\n');
  return { base, library, backup, planPath, root };
}

function run(library, backup, planPath, { apply = false } = {}) {
  const args = [SCRIPT, '--plan', planPath, '--library', library, '--backup', backup];
  if (apply) args.push('--apply');
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

const writePlan = async (planPath, renames) => await writeFile(planPath, `${JSON.stringify({ renames }, null, 2)}\n`);

test('name and directory are renamed together, with a backup and receipt', async (t) => {
  const { library, backup, planPath } = await fixture(t, { relDir: 'pkg/old-name', name: 'old-name' });
  await writePlan(planPath, [{ relPath: 'pkg/old-name/SKILL.md', expectName: 'old-name', nextName: 'new-name' }]);
  const result = run(library, backup, planPath, { apply: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await exists(join(library, 'pkg/new-name/SKILL.md')), true);
  assert.equal(await exists(join(library, 'pkg/old-name')), false);
  assert.match(await readOrNull(join(library, 'pkg/new-name/SKILL.md')), /^name: new-name$/m);
  assert.equal(await readOrNull(join(backup, 'pkg/old-name/SKILL.md')), skill('old-name'), '备份必须是改前原件');
  const receipt = JSON.parse(await readFile(join(backup, 'rename-receipt.json'), 'utf8'));
  assert.equal(receipt.changes[0].dirFrom, 'pkg/old-name');
  assert.equal(receipt.changes[0].dirTo, 'pkg/new-name');
});

test('dir-only mode renames the directory and leaves the frontmatter untouched', async (t) => {
  const { library, backup, planPath } = await fixture(t,
    { relDir: '81-Skills/Skill家族管理', name: 'skill-family-manager' });
  const before = await readFile(join(library, '81-Skills/Skill家族管理/SKILL.md'), 'utf8');
  await writePlan(planPath, [{ relPath: '81-Skills/Skill家族管理/SKILL.md',
    expectName: 'skill-family-manager', nextDir: 'skill-family-manager' }]);
  const result = run(library, backup, planPath, { apply: true });
  assert.equal(result.status, 0, result.stderr);
  const moved = await readOrNull(join(library, '81-Skills/skill-family-manager/SKILL.md'));
  assert.equal(moved, before, 'frontmatter 与正文都必须逐字不变');
  assert.equal(await exists(join(library, '81-Skills/Skill家族管理')), false, '旧目录不得残留');
  assert.equal(await readOrNull(join(library, '81-Skills/skill-family-manager/README.md')), 'readme\n',
    '整个目录一起搬，别只搬 SKILL.md');
  const receipt = JSON.parse(await readFile(join(backup, 'rename-receipt.json'), 'utf8'));
  assert.equal(receipt.changes[0].sha256Before, receipt.changes[0].sha256After, '内容摘要必须相等');
  assert.equal(receipt.changes[0].from, receipt.changes[0].to);
});

test('dry-run prints the change set without touching the library', async (t) => {
  const { library, backup, planPath } = await fixture(t, { relDir: 'pkg/old-name', name: 'old-name' });
  await writePlan(planPath, [{ relPath: 'pkg/old-name/SKILL.md', expectName: 'old-name', nextName: 'new-name' }]);
  const result = run(library, backup, planPath);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await exists(join(library, 'pkg/old-name/SKILL.md')), true);
  assert.equal(await exists(join(library, 'pkg/new-name')), false);
  assert.equal(await readOrNull(join(backup, 'rename-receipt.json')), null);
});

test('a stale plan is refused by the identity gate', async (t) => {
  const { library, backup, planPath } = await fixture(t, { relDir: 'pkg/old-name', name: 'old-name' });
  await writePlan(planPath, [{ relPath: 'pkg/old-name/SKILL.md', expectName: 'some-other', nextName: 'new-name' }]);
  const result = run(library, backup, planPath, { apply: true });
  assert.equal(result.status, 3);
  assert.match(result.stdout, /NAME_MISMATCH/);
  assert.equal(await exists(join(library, 'pkg/old-name/SKILL.md')), true, '被拒时库必须原样');
  assert.equal(await exists(join(library, 'pkg/new-name')), false);
});

test('an invalid target directory name is rejected up front', async (t) => {
  const { library, backup, planPath } = await fixture(t,
    { relDir: '81-Skills/Skill家族管理', name: 'skill-family-manager' });
  await writePlan(planPath, [{ relPath: '81-Skills/Skill家族管理/SKILL.md',
    expectName: 'skill-family-manager', nextDir: 'Skill家族管理' }]);
  const invalid = run(library, backup, planPath);
  assert.notEqual(invalid.status, 0);
  assert.match(`${invalid.stdout}${invalid.stderr}`, /INVALID_NEXT_DIR/);
});

test('a plan whose target equals the current directory is a no-op error', async (t) => {
  const { library, backup, planPath } = await fixture(t,
    { relDir: '81-Skills/skill-family-manager', name: 'skill-family-manager' });
  await writePlan(planPath, [{ relPath: '81-Skills/skill-family-manager/SKILL.md',
    expectName: 'skill-family-manager', nextDir: 'skill-family-manager' }]);
  const noop = run(library, backup, planPath);
  assert.notEqual(noop.status, 0);
  assert.match(`${noop.stdout}${noop.stderr}`, /NO_CHANGE/);
});

test('an existing receipt blocks a second apply', async (t) => {
  const { library, backup, planPath } = await fixture(t, { relDir: 'pkg/old-name', name: 'old-name' });
  await writePlan(planPath, [{ relPath: 'pkg/old-name/SKILL.md', expectName: 'old-name', nextName: 'new-name' }]);
  assert.equal(run(library, backup, planPath, { apply: true }).status, 0);
  const again = run(library, backup, planPath, { apply: true });
  assert.notEqual(again.status, 0);
  assert.match(`${again.stdout}${again.stderr}`, /RECEIPT_EXISTS/);
});
