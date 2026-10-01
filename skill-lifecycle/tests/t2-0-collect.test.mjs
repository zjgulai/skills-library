import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../trial-home/t2/t2-0-collect.mjs', import.meta.url));
const { denied, plan, DENY } = await import(SCRIPT);

test('拒读闸：凭据/密钥/会话类路径一律命中；普通配置不命中', () => {
  const DSH = join(homedir(), '.dsh');
  assert.equal(denied(join(DSH, '.credentials.yaml')), true);
  assert.equal(denied(join(DSH, 'profiles/desktop/sessions/abc.json')), true);
  assert.equal(denied('/x/server.pem'), true);
  assert.equal(denied('/x/private.key'), true);
  assert.equal(denied('/x/api-token.json'), true);
  assert.equal(denied(join(DSH, 'settings.yaml')), false);
  assert.equal(denied(join(DSH, '.agent-presets/foo/agent.cordis.yml')), false);
  assert.equal(denied(join(DSH, 'profiles/desktop/cordis.patch.yml')), false);
  assert.ok(DENY.length >= 5);
});

test('拟读清单不含拒读项（清单自身过闸）', () => {
  for (const item of plan()) assert.equal(denied(item.path), false, item.path);
});

test('CLI dry-run：零文件访问、退 0、输出拟读清单', () => {
  const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.match(out.mode, /dry-run/);
  assert.ok(out.willRead.length >= 6);
  const paths = out.willRead.map(i => i.path).join('\n');
  assert.match(paths, /cordis\.patch\.yml/);
  assert.match(paths, /agent\.cordis\.yml/);
  assert.doesNotMatch(paths, /credentials/i);
});

test('CLI --apply 无 --authorized：拒绝执行（退 2，不写盘）', () => {
  const run = spawnSync(process.execPath, [SCRIPT, '--apply'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--authorized/);
});


test('输出路径回归：OUT_DIR 位于「skill管理/docs/specs」下（2026-10-01 路径缺陷修复的固定测试）', async () => {
  const mod = await import(SCRIPT);
  const { OUT_DIR, REPO } = mod;
  assert.ok(REPO.replace(/\/$/, '').endsWith(join('思维库', 'skill管理')), REPO);
  assert.ok(OUT_DIR.includes(join('skill管理', 'docs', 'specs')), OUT_DIR);
  assert.ok(OUT_DIR.endsWith(join('t2-0')) && OUT_DIR.includes('120-w5-t2-sequence'), OUT_DIR);
});
