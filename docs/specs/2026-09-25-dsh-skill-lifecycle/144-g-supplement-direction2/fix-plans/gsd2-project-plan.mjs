#!/usr/bin/env node
/**
 * G 续补去向② 新制作件·首次装配投影计划生成器（只读源与装配根；不写目标）。
 *
 * 七件为**新投影**（目标不存在）：计划不含 expectTargetDigest ⇒ 执行器走 planned 路径。
 * walkFiles / manifestDigest / computePlanDigest 直接复用 assembly-project.mjs 导出，
 * 摘要口径与执行器完全一致。
 *
 * 前置断言：目标在装配根必须不存在（防误覆盖）。
 *
 * 用法：node gsd2-project-plan.mjs [--out <plan.json>]
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { access, writeFile } from 'node:fs/promises';
import { walkFiles, manifestDigest, computePlanDigest } from '../../../../../skill-lifecycle/trial-home/screening/assembly-project.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '../../../../../../../技能库');    // AgentTools/技能库

const ITEMS = [
  { name: 'management-decision-package', sourceRel: '81-Skills/management-decision-package' },
  { name: 'scenario-governance-review', sourceRel: '81-Skills/scenario-governance-review' },
  { name: 'storefront-sellability-check', sourceRel: '81-Skills/storefront-sellability-check' },
  { name: 'account-health-appeal', sourceRel: 'skills-genspark/account-health-appeal' },
  { name: 'metric-contract-governance', sourceRel: '81-Skills/metric-contract-governance' },
  { name: 'experiment-adoption-gate', sourceRel: '81-Skills/experiment-adoption-gate' },
  { name: 'tool-contract-governance', sourceRel: 'skills/kimi/skills/tool-contract-governance' },
];

async function exists(p) {
  return access(p).then(() => true, () => false);
}

async function main() {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const out = outIdx === -1 ? join(HERE, '../receipts/gsd2-project-plan.json') : argv[outIdx + 1];
  const targetRoot = join(LIB, '_assembly-v1');

  const operations = [];
  for (let i = 0; i < ITEMS.length; i += 1) {
    const { name, sourceRel } = ITEMS[i];
    const sourceDir = join(LIB, sourceRel);
    const target = join(targetRoot, name);
    if (await exists(target)) {
      process.stderr.write(`REFUSE: 装配根已存在 ${name}（应走 update op，非新投影）\n`);
      process.exit(2);
    }
    const walked = await walkFiles(sourceDir);
    const entry = walked.files.find(f => f.relPath === 'SKILL.md');
    if (!entry) { process.stderr.write(`REFUSE: ${name} 源缺 SKILL.md\n`); process.exit(2); }
    operations.push({
      opId: `op-${String(i + 1).padStart(3, '0')}`,
      mode: 'dir',
      name,
      sourceKind: 'standard',
      entryRelPath: `${name}/SKILL.md`,
      entrySha256: entry.sha256,
      sourceDir,
      sourceFiles: walked.files,
      sourceBytes: walked.files.reduce((s, f) => s + f.bytes, 0),
      sourceDigest: manifestDigest(walked.files),
    });
  }

  const plan = {
    planKind: 'assembly-projection',
    planVersion: 'assembly-v1',
    planId: 'project-gsd2-2026-10-04',
    targetRoot,
    createdAt: '2026-10-04',
    selection: {
      kind: 'new-projection',
      names: ITEMS.map(i => i.name).sort(),
      basis: 'G 续补去向② 新制作件首次投影（目标不存在；planned 路径，非 update）；按族落位：四件 81-Skills（管理决策/场景治理/可售核验/口径契约/实验采用）、一件 skills-genspark（账号健康申诉，027 族 majority）、一件 skills/kimi（工具契约治理，047/049/050 族全胜；首个 kimi 落位）',
    },
    operations,
  };
  plan.planDigest = computePlanDigest(plan);
  await writeFile(out, `${JSON.stringify(plan, null, 1)}\n`, 'utf8');
  console.log(JSON.stringify({ plan: out, ops: operations.length, planDigest: plan.planDigest.slice(0, 16),
    names: plan.selection.names }, null, 1));
}

main();
