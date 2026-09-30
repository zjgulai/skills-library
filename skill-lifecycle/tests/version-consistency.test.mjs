import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = fileURLToPath(new URL('../trial-home/screening/version-consistency.mjs', import.meta.url));

async function fixture(t, files) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'vc-'));
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  for (const [rel, text] of Object.entries(files)) {
    const path = join(base, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
  }
  return base;
}

function run(library) {
  return spawnSync(process.execPath, [SCRIPT, '--library', library], { encoding: 'utf8' });
}

const skill = (footer) => `---\nname: demo\ntitle: "演示"\nversion: "2.2.0"\n---\n\n# 演示\n\n正文。\n\n---\n\n${footer}\n`;

test('槽位残留判红：同行带 Schema 轴也不得整行豁免', async (t) => {
  const library = await fixture(t, {
    'pkg/demo/SKILL.md': skill('**版本**: 1.1.0 | **Schema 版本**: 1.1.0 | **类型**: Technique'),
  });
  const result = run(library);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 个技能 \/ 1 处/);
  assert.match(result.stdout, /1\.1\.0/);
});

test('负例：版本槽与权威版本一致、Schema 轴为其它值时判绿', async (t) => {
  const library = await fixture(t, {
    'pkg/demo/SKILL.md': skill('**版本**: 2.2.0 | **Schema 版本**: 1.1.0 | **类型**: Technique'),
  });
  const result = run(library);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 个技能 \/ 0 处/);
});

test('负例：history 行中的旧版本号仍被豁免', async (t) => {
  const library = await fixture(t, {
    'pkg/demo/SKILL.md': skill('- **v1.1.0** (2026-09-03)：历史版本记录，本行属迁移说明'),
  });
  const result = run(library);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 个技能 \/ 0 处/);
});

test('代码围栏内的版本是示例：豁免但留痕（负控：围栏外的同款行仍判红）', async (t) => {
  const fenced = '```yaml\nversion: "1.0.0"   # 模板里的占位\n```\n';
  const library = await fixture(t, { 'pkg/demo/SKILL.md': skill(fenced) });
  const result = run(library);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 个技能 \/ 0 处/);
  assert.match(result.stdout, /已豁免但留痕/, '豁免必须留痕，不能静默');
  const control = await fixture(t, { 'pkg/demo/SKILL.md': skill('version: "1.0.0"   # 裸行不是示例\n') });
  const controlRun = run(control);
  assert.match(controlRun.stdout, /1 个技能 \/ 1 处/, '围栏外的同款行必须仍被抓');
});

test('Universal Skill Schema 轴：豁免（负控：无 Schema 语境的同版本号仍判红）', async (t) => {
  const library = await fixture(t, {
    'pkg/demo/SKILL.md': skill('- 重构评估体系，对齐 Universal Skill Schema v1.1.0'),
  });
  assert.match(run(library).stdout, /0 个技能 \/ 0 处/);
  const control = await fixture(t, { 'pkg/demo/SKILL.md': skill('- 重构评估体系，对齐评估规范 v1.1.0') });
  assert.match(run(control).stdout, /1 个技能 \/ 1 处/, '去掉 Schema 语境后同款行必须仍被抓');
});

test('旧评估记录：豁免（负控：无「旧生态」语境的同版本号仍判红）', async (t) => {
  const library = await fixture(t, {
    'pkg/demo/SKILL.md': skill('- 旧生态评估报告（版本 1.0.2）已随写回移出本包。'),
  });
  assert.match(run(library).stdout, /0 个技能 \/ 0 处/);
  const control = await fixture(t, { 'pkg/demo/SKILL.md': skill('- 评估报告（版本 1.0.2）仍在包内。') });
  assert.match(run(control).stdout, /1 个技能 \/ 1 处/, '去掉「旧」语境后同款行必须仍被抓');
});

test('0 扫描 fail-loud：空目录不是零残留而是没扫到', async (t) => {
  const library = await fixture(t, { 'empty/placeholder.txt': 'x\n' });
  const result = run(library);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /没有解析到任何技能目录/);
});
