import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const AUDIT = fileURLToPath(new URL('../trial-home/screening/stale-ref-audit.mjs', import.meta.url));
const PLAN = fileURLToPath(new URL('../trial-home/screening/stale-ref-plan.mjs', import.meta.url));
const { classifyLine } = await import(AUDIT);

test('classifyLine：pointer/annotated/compound/topic/heading 五类口径', () => {
  assert.equal(classifyLine('- 不要用于价格监控（使用 演示技能）', '演示技能', 'demo-skill'), 'pointer');
  assert.equal(classifyLine('- 相关: `demo-skill`（演示技能）', '演示技能', 'demo-skill'), 'annotated');
  assert.equal(classifyLine('**演示技能用例：**', '演示技能', 'demo-skill'), 'compound');
  assert.equal(classifyLine('## 演示技能', '演示技能', 'demo-skill'), 'heading');
  assert.equal(classifyLine('A / B / 演示技能 / C', '演示技能', 'demo-skill'), 'topic');
  // 独占列表项按话题处理（保守：脚本位置未知，宁可不替换）
  assert.equal(classifyLine('- 演示技能', '演示技能', 'demo-skill'), 'topic');
  // 负控：普通行不误判为 pointer
  assert.equal(classifyLine('这是一段介绍演示技能的话。', '演示技能', 'demo-skill'), 'other');
});

async function fixture(t) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'sra-'));
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  const lib = join(base, 'lib');
  await mkdir(join(lib, 'pkg', 'a'), { recursive: true });
  await mkdir(join(lib, 'pkg', 'b'), { recursive: true });
  await writeFile(join(lib, 'pkg', 'a', 'SKILL.md'), '---\nname: a-skill\nversion: "1.0.0"\n---\n\n# A\n\n正文。\n');
  await writeFile(join(lib, 'pkg', 'b', 'SKILL.md'), [
    '---', 'name: b-skill', 'version: "1.0.0"', '---', '', '# B', '',
    '- 不要用于价格监控（使用 演示技能）',        // pointer → 应替换
    '- 触发词：演示技能、demo',                    // 触发词行 → 分类即出局
    '- 相关: `demo-skill`（演示技能）',            // 已注记 → 不重复注记
    '- 两个名字 demo-skill 与 演示技能 并存的行',  // 含 kebab → 闸门 KEBAB_ALREADY_PRESENT
  ].join('\n') + '\n');
  const mapping = join(base, 'mapping.json');
  await writeFile(mapping, JSON.stringify({ entries: [
    { relPath: 'pkg/a/SKILL.md', name: '演示技能', kebab: 'demo-skill', status: 'completed' },
  ] }));
  return { base, lib, mapping };
}

test('audit → plan：只有指针位的裸出现被替换；触发词行与已注记行不动', async (t) => {
  const { base, lib, mapping } = await fixture(t);
  const auditOut = join(base, 'audit.json');
  const auditRun = spawnSync(process.execPath, [AUDIT, '--library', lib, '--mapping', mapping, '--out', auditOut], { encoding: 'utf8' });
  assert.equal(auditRun.status, 0, auditRun.stderr);
  const audit = JSON.parse(await readFile(auditOut, 'utf8'));
  assert.equal(audit.totalHits, 4, '四行各一条命中（含被分类/闸门拦下的三行）');

  const planOut = join(base, 'plan.json');
  const planRun = spawnSync(process.execPath, [PLAN, '--library', lib, '--audit', auditOut, '--out', planOut], { encoding: 'utf8' });
  assert.equal(planRun.status, 0, planRun.stderr);
  const plan = JSON.parse(await readFile(planOut, 'utf8'));
  assert.equal(plan.ops.length, 1, '只应产出指针位那一条 op');
  assert.equal(plan.ops[0].find, '- 不要用于价格监控（使用 演示技能）');
  assert.equal(plan.ops[0].replace, '- 不要用于价格监控（使用 demo-skill（演示技能））');
  assert.equal(plan.ops[0].expectCount, 1);
  const review = await readFile(join(base, 'plan.review.md'), 'utf8');
  assert.match(review, /KEBAB_ALREADY_PRESENT/, '含 kebab 的行应由闸门点名跳过');
  assert.doesNotMatch(review, /触发词：演示技能/, '触发词行不得进入替换（分类即出局）');
  assert.doesNotMatch(review, /（使用 demo-skill（演示技能））（演示技能）/, '不得二次注记');
});
