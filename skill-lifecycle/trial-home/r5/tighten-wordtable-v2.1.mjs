#!/usr/bin/env node
/** 依据首轮 ≥30/桶 抽样复核结论，产出 wordtable-v2.1（保守收紧；每处修改入 patch 记录）。 */
import { readFile, writeFile } from 'node:fs/promises';

const [,, inPath, outPath] = process.argv;
const src = JSON.parse(await readFile(inPath, 'utf8'));
const T = src.table;
const patch = [];

function dropW(group, bucket, terms) {
  const g = group === 'shared' ? T.shared : T.other;
  const arr = g[bucket];
  const before = arr.length;
  g[bucket] = arr.filter(e => !(e.w === 'W' && terms.includes(e.t)));
  patch.push({ op: 'dropW', bucket: `${group}:${bucket}`, removed: terms, from: before, to: g[bucket].length });
}
function moveSW(group, bucket, term) {
  const g = group === 'shared' ? T.shared : T.other;
  const arr = g[bucket];
  const hit = arr.find(e => e.t === term && e.w === 'S');
  if (!hit) throw new Error(`moveSW 未命中 ${bucket}/${term}`);
  hit.w = 'W';
  patch.push({ op: 'moveS->W', bucket: `${group}:${bucket}`, term });
}

dropW('shared', '创意文档', ['prompt', 'template', 'generat*', 'creat*']);
dropW('shared', '本地诊断', ['issue', 'check', 'reminder']);
dropW('shared', '通用研究', ['analysis', 'analyze', 'learning', 'criteria']);
dropW('shared', '网站与部署', ['application', 'build']);
dropW('shared', '协作与外部工具', ['context', 'session', 'reader', 'collaboration']);
dropW('shared', '数据', ['find', 'extract*', 'record']);
dropW('shared', '图像视频', ['render*']);
dropW('shared', '文档与知识', ['about', 'map']);
moveSW('shared', '产品设计', 'prototype');
moveSW('shared', '图像视频', 'logo');
moveSW('shared', '数据', 'json');

import { createHash } from 'node:crypto';
const tableDigest = createHash('sha256').update(JSON.stringify(T)).digest('hex');
const out = { ...src, record_type: 'wordtable-v2.1-frozen', at: new Date().toISOString().slice(0, 10),
  derivedFrom: 'wordtable-v2.json + tighten patch（首轮 ≥30/桶 抽样复核结论）',
  patch, tableDigest, table: T };
await writeFile(outPath, `${JSON.stringify(out, null, 1)}\n`);
console.log(JSON.stringify({ saved: outPath, patch }, null, 1));
