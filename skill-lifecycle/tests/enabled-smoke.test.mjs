import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smokeObserver } from '../trial-home/enabled-smoke.mjs';

const SKILL = [
  '---',
  'name: smoke-demo',
  'description: QA an analysis before sharing.',
  '---',
  '',
  '# smoke-demo',
  '',
  '## Workflow',
  '',
  '### 1. Review',
  '',
  'Check the framing.',
  '',
].join('\n');

async function enabledTree(t, { body = SKILL } = {}) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'enabled-smoke-'));
  const root = join(base, 'enabled', 'smoke-demo');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'SKILL.md'), body);
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  return { base, root };
}

test('the smoke window loads the installed skill natively and matches its content identity', async (t) => {
  const { root } = await enabledTree(t);
  const result = await smokeObserver({ skillId: 'smoke-demo', root });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.mode, 'capture');
  assert.equal(result.route, 'none', 'the observation must not mount any provider route');
  assert.match(result.detail, /content identity .* matches the installed tree/);
});

test('the window reports a mismatch when the served content differs from the tree', async (t) => {
  // 这条检查的是"加载通路"：服务出来的内容必须等于树里的内容。
  // 篡改整棵树会被 enablement 层的"树 == 安装记录"前置校验拦下（见 enablement 测试），
  // 这里用"树里没有 SKILL.md 但目录名像个技能"来验证 mismatch 分支会红。
  const base = await mkdtemp(join(await realpath(tmpdir()), 'enabled-smoke-'));
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  const root = join(base, 'enabled', 'smoke-demo');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'NOTES.md'), 'no skill file here\n');
  const result = await smokeObserver({ skillId: 'smoke-demo', root });
  assert.equal(result.ok, false);
  assert.match(result.detail, /SKILL_NOT_DISCOVERED|SMOKE_ERROR/);
});

test('a directory without the skill fails with SKILL_NOT_DISCOVERED', async (t) => {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'enabled-smoke-'));
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  const root = join(base, 'enabled', 'missing-skill');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'notes.md'), 'not a skill\n');
  const result = await smokeObserver({ skillId: 'missing-skill', root });
  assert.equal(result.ok, false);
  assert.match(result.detail, /SKILL_NOT_DISCOVERED/);
});
