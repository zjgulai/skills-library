#!/usr/bin/env node
/**
 * 写回计划生成器（批二十四新增）
 *
 * 起因：每批技能写回都要手搓 `writeback-plan-*.json`，其中 `sourceSha256`（候选侧）
 * 与 `expectSha256`（库内侧）两侧摘要全靠手工核对——极易把两侧抄反或抄漏。
 * 本工具按候选目录与目标目录**实际字节**生成 ops，删除项由调用方点名。
 *
 * 用法：
 *   node writeback-plan-make.mjs --library-root <技能库根> --target <库内技能目录>
 *     --candidate <候选目录> --slug <slug> --policy-file <policy.txt> --out <plan.json>
 *     [--remove <rel> ...] [--evidence <a,b,c>]
 *
 * 规则：
 *  - puts＝候选目录下全部文件（递归），relPath = <target 相对 library-root>/<候选内相对路径>；
 *    目标已存在 ⇒ expectSha256＝目标当前摘要；不存在 ⇒ expectAbsent: true。
 *  - removes＝--remove 逐条给出的 target 内相对路径，expectSha256＝当前摘要。
 *  - 任何候选/目标文件读不到即整体失败（不产出半份计划）。
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

async function walk(root, rel = '') {
  const out = [];
  const entries = await readdir(join(root, rel), { withFileTypes: true });
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await walk(root, child));
    else if (entry.isFile()) out.push(child);
  }
  return out.sort();
}

function flags(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === `--${name}`) out.push(argv[i + 1]);
  return out;
}

async function main(argv) {
  const one = name => flags(argv, name)[0];
  const libraryRoot = one('library-root');
  const target = one('target');
  const candidate = one('candidate');
  const slug = one('slug');
  const policyFile = one('policy-file');
  const out = one('out');
  const removes = flags(argv, 'remove');
  const pruneEmpty = argv.includes('--prune-empty');
  const evidence = flags(argv, 'evidence').flatMap(v => v.split(',')).map(s => s.trim()).filter(Boolean);
  if (!libraryRoot || !target || !candidate || !slug || !policyFile || !out) {
    process.stderr.write('Usage: node writeback-plan-make.mjs --library-root <dir> --target <dir> --candidate <dir> '
      + '--slug <s> --policy-file <txt> --out <json> [--remove <rel> ...] [--prune-empty] [--evidence a,b]\n');
    return 2;
  }
  const targetRelBase = relative(libraryRoot, target);
  if (targetRelBase.startsWith('..')) throw new Error(`target 不在 library-root 内：${target}`);

  const candidateFiles = await walk(candidate);
  const targetFiles = new Set(await walk(target).catch(() => []));

  const ops = [];
  for (const rel of candidateFiles) {
    const source = join(candidate, rel);
    const buffer = await readFile(source);
    const targetRel = `${targetRelBase}/${rel}`;
    const expectPath = join(libraryRoot, targetRel);
    if (targetFiles.has(rel)) {
      const before = await readFile(expectPath);
      ops.push({ kind: 'put', relPath: targetRel, source,
        sourceSha256: sha256(buffer), expectSha256: sha256(before) });
    } else {
      ops.push({ kind: 'put', relPath: targetRel, source,
        sourceSha256: sha256(buffer), expectAbsent: true });
    }
  }
  for (const rel of removes) {
    const targetRel = `${targetRelBase}/${rel}`;
    const before = await readFile(join(libraryRoot, targetRel));
    ops.push({ kind: 'remove', relPath: targetRel, expectSha256: sha256(before) });
  }
  // 空目录壳：删除只看文件，删完会留下空目录（momcozy 事故）。--prune-empty 追加一个显式 op，
  // 范围就是本技能目录（executor 只删其内已空/被本计划删空的目录，root 自身不删）。
  if (pruneEmpty && removes.length > 0) ops.push({ kind: 'prune-empty-dirs', root: targetRelBase });

  const plan = {
    record_type: 'library_writeback_plan',
    at: new Date().toISOString().slice(0, 10),
    target,
    candidate,
    policy: (await readFile(policyFile, 'utf8')).trim(),
    evidence,
    ops,
  };
  await writeFile(out, `${JSON.stringify(plan, null, 2)}\n`);
  process.stdout.write(`计划已写出：${out}（${ops.filter(o => o.kind === 'put').length} put / ${ops.filter(o => o.kind === 'remove').length} remove）\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
