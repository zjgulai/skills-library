#!/usr/bin/env node
/** 第二轮抽样复核后的收尾收紧（story→W 修复敏捷工具误纳；recipe→W）。 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const [,, inPath, outPath] = process.argv;
const src = JSON.parse(await readFile(inPath, 'utf8'));
const T = src.table;
const patch = [];
function moveSW(group, bucket, term) {
  const g = T[group];
  const hit = g[bucket].find(e => e.t === term && e.w === 'S');
  if (!hit) throw new Error(`moveSW 未命中 ${bucket}/${term}`);
  hit.w = 'W';
  patch.push({ op: 'moveS->W', bucket: `${group}:${bucket}`, term });
}
moveSW('shared', '创意文档', 'story');
moveSW('other', '个人娱乐', 'recipe');
const tableDigest = createHash('sha256').update(JSON.stringify(T)).digest('hex');
const out = { ...src, record_type: 'wordtable-v2.2-frozen', at: new Date().toISOString().slice(0, 10),
  derivedFrom: 'wordtable-v2.1.json + round2 spot patch（story/recipe 类误纳）', patch, tableDigest, table: T };
await writeFile(outPath, `${JSON.stringify(out, null, 1)}\n`);
console.log(JSON.stringify({ saved: outPath, tableDigest, patch }, null, 1));
