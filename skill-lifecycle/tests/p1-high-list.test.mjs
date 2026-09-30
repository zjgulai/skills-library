import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = fileURLToPath(new URL('../trial-home/screening/p1-high-list.mjs', import.meta.url));
const { nonHubHighList } = await import(SCRIPT);

const screen = {
  skills: [
    { relPath: '81-Skills/工具名/SKILL.md', severity: 'high', findings: [{ code: 'NON_KEBAB_NAME', severity: 'high' }] },
    { relPath: 'skills/kimi/skills/a/SKILL.md', severity: 'high', findings: [
      { code: 'DANGEROUS_COMMAND', severity: 'high' }, { code: 'DANGEROUS_COMMAND', severity: 'high' }] },
    { relPath: 'pkg/b/SKILL.md', severity: 'medium', findings: [{ code: 'X', severity: 'medium' }] },
    { relPath: 'pkg/c/SKILL.md', severity: 'low', findings: [] },
  ],
};

test('抽取：排除 81-Skills、只取 high、code 去重排序', () => {
  assert.deepEqual(nonHubHighList(screen), [
    { relPath: 'skills/kimi/skills/a/SKILL.md', codes: ['DANGEROUS_COMMAND'] },
  ]);
});

test('负对照：只有 81-Skills 的 high 时名单为空', () => {
  assert.deepEqual(nonHubHighList({ skills: [screen.skills[0]] }), []);
});

test('CLI：一致退 0，漂移退 1（名单是能红的检查）', async (t) => {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'p1-'));
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  const screenPath = join(base, 'screen.json');
  const expectPath = join(base, 'expect.json');
  await writeFile(screenPath, JSON.stringify(screen));
  const outRun = spawnSync(process.execPath, [SCRIPT, '--screen', screenPath, '--out', expectPath], { encoding: 'utf8' });
  assert.equal(outRun.status, 0, outRun.stderr);
  const okRun = spawnSync(process.execPath, [SCRIPT, '--screen', screenPath, '--expect', expectPath], { encoding: 'utf8' });
  assert.equal(okRun.status, 0);
  assert.match(okRun.stdout, /PASS/);
  const frozen = JSON.parse(await readFile(expectPath, 'utf8'));
  frozen.items.push({ relPath: 'pkg/new/SKILL.md', codes: ['X'] });
  await writeFile(expectPath, JSON.stringify(frozen));
  const driftRun = spawnSync(process.execPath, [SCRIPT, '--screen', screenPath, '--expect', expectPath], { encoding: 'utf8' });
  assert.equal(driftRun.status, 1);
  assert.match(driftRun.stdout, /DRIFT/);
});
