#!/usr/bin/env node
/**
 * seo 一致性收尾批（140 号）·装配侧重投影计划生成器（只读源与装配根；不写目标）。
 *
 * 背景：库内目录 skill-zyx → seo-orchestrator（目录改名，内容未动）。装配侧旧名目录
 * `seo-skill-v1-5-candidate` 已备份（trial-home/library-backup-rename-seo-orchestrator-assembly-2026-10-01）
 * 并移除；本计划把该件以**新名**重新投影（目标不存在 ⇒ planned 路径），meta 随之再生。
 *
 * 摘要口径复用 assembly-project.mjs 导出。
 * 用法：node seo-project-plan.mjs [--out <plan.json>]
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { access, writeFile } from 'node:fs/promises';
import { walkFiles, manifestDigest, computePlanDigest } from '../../../../../skill-lifecycle/trial-home/screening/assembly-project.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '../../../../../../../技能库');

const ITEMS = [
  { name: 'seo-orchestrator', sourceRel: 'seo-orchestrator' },
];

async function exists(p) {
  return access(p).then(() => true, () => false);
}

async function main() {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const out = outIdx === -1 ? join(HERE, '../receipts/seo-project-plan.json') : argv[outIdx + 1];
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
    planId: 'rename-seo-orchestrator-2026-10-01',
    targetRoot,
    createdAt: '2026-10-01',
    selection: {
      kind: 'new-projection',
      names: ITEMS.map(i => i.name).sort(),
      basis: 'seo 一致性收尾批（140 号）：库内目录改名后装配侧重投影（旧名目录已备份并移除；内容未动）',
    },
    operations,
  };
  plan.planDigest = computePlanDigest(plan);
  await writeFile(out, `${JSON.stringify(plan, null, 1)}\n`, 'utf8');
  console.log(JSON.stringify({ plan: out, ops: operations.length, planDigest: plan.planDigest.slice(0, 16),
    names: plan.selection.names }, null, 1));
}

main();
