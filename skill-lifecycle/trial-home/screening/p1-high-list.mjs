#!/usr/bin/env node
/**
 * P1 名单生成与稳定性断言（批二十五/P1 新增）
 *
 * 用途：从全库屏检 JSON 里取「非 81-Skills 的 high 技能」，生成 P1 名单；
 * 或对既有名单做**可失败的漂移断言**（名单是冻结件，屏检换版后必须能发现新增/消失项）。
 *
 * 用法：
 *   node p1-high-list.mjs --screen <library-screen.json> --out <list.json>
 *   node p1-high-list.mjs --screen <library-screen.json> --expect <list.json>
 *
 * `--expect` 模式：逐项比对（relPath + 该技能的全部 high code），完全一致打印 PASS 并退 0；
 * 有出入打印 DRIFT（新增/消失/字段变化）并退 1。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const flag = (argv, name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

export function nonHubHighList(screen) {
  const out = [];
  for (const skill of screen.skills ?? []) {
    if (skill.severity !== 'high') continue;
    if (String(skill.relPath).startsWith('81-Skills/')) continue;
    const codes = [...new Set((skill.findings ?? []).filter(f => f.severity === 'high').map(f => f.code))].sort();
    out.push({ relPath: skill.relPath, codes });
  }
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

async function main(argv) {
  const screenPath = flag(argv, 'screen');
  const outPath = flag(argv, 'out');
  const expectPath = flag(argv, 'expect');
  if (!screenPath || (!outPath && !expectPath)) {
    process.stderr.write('Usage: node p1-high-list.mjs --screen <screen.json> (--out <list.json> | --expect <list.json>)\n');
    return 2;
  }
  const screen = JSON.parse(await readFile(screenPath, 'utf8'));
  const list = nonHubHighList(screen);
  if (expectPath) {
    const expected = JSON.parse(await readFile(expectPath, 'utf8'));
    const key = item => `${item.relPath} :: ${item.codes.join(',')}`;
    const have = new Set(list.map(key));
    const want = new Set((expected.items ?? []).map(key));
    const added = [...have].filter(k => !want.has(k));
    const removed = [...want].filter(k => !have.has(k));
    if (added.length === 0 && removed.length === 0) {
      console.log(`PASS：非 81-Skills 的 high 名单与冻结件一致（${list.length} 项）`);
      return 0;
    }
    console.log(`DRIFT：名单与冻结件不一致（屏检新增 ${added.length}、消失 ${removed.length}）`);
    for (const k of added) console.log(`  + ${k}`);
    for (const k of removed) console.log(`  - ${k}`);
    return 1;
  }
  await writeFile(outPath, `${JSON.stringify({ record_type: 'p1_high_list', at: new Date().toISOString().slice(0, 10), source: screenPath, items: list }, null, 2)}\n`);
  console.log(`已写出 ${list.length} 项 → ${outPath}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
