#!/usr/bin/env node
/**
 * G 去向② 新制作件·首次装配投影计划生成器（只读源与装配根；不写目标）。
 *
 * 四件（hardware-quality-closure / warranty-claim-adjudication / tax-position-review /
 * market-access-gate）为**新投影**（目标不存在）：计划不含 expectTargetDigest ⇒
 * 执行器走 planned 路径（dry-run=planned，apply=落位）。
 * walkFiles / manifestDigest / computePlanDigest 直接复用 assembly-project.mjs 导出，
 * 摘要口径与执行器完全一致。
 *
 * 前置断言：目标在装配根必须不存在（防误覆盖；已存在应走 update op）。
 *
 * 用法：node gdir2-project-plan.mjs [--out <plan.json>]
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { access, writeFile } from 'node:fs/promises';
import { walkFiles, manifestDigest, computePlanDigest } from '../../../../../skill-lifecycle/trial-home/screening/assembly-project.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '../../../../../../../技能库');    // AgentTools/技能库

const ITEMS = [
  { name: 'hardware-quality-closure', sourceRel: '81-Skills/hardware-quality-closure' },
  { name: 'warranty-claim-adjudication', sourceRel: 'skills-genspark/warranty-claim-adjudication' },
  { name: 'tax-position-review', sourceRel: 'skills-genspark/tax-position-review' },
  { name: 'market-access-gate', sourceRel: 'skills-genspark/market-access-gate' },
];

async function exists(p) {
  return access(p).then(() => true, () => false);
}

async function main() {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const out = outIdx === -1 ? join(HERE, '../receipts/gdir2-project-plan.json') : argv[outIdx + 1];
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
    planId: 'project-gdir2-2026-10-01',
    targetRoot,
    createdAt: '2026-10-01',
    selection: {
      kind: 'new-projection',
      names: ITEMS.map(i => i.name).sort(),
      basis: 'G 去向② 新制作件首次投影（目标不存在；planned 路径，非 update）；按族落位：硬件质量→81-Skills、客服/财务/合规→skills-genspark',
    },
    operations,
  };
  plan.planDigest = computePlanDigest(plan);
  await writeFile(out, `${JSON.stringify(plan, null, 1)}\n`, 'utf8');
  console.log(JSON.stringify({ plan: out, ops: operations.length, planDigest: plan.planDigest.slice(0, 16),
    names: plan.selection.names }, null, 1));
}

main();
