#!/usr/bin/env node
/** 冻结《v2 词表增补草案》为 wordtable-v2.json（来源＝已验证原型 routing-v2-draft.mjs 的 TABLE；
 * 原型即 48%/55.5% 读数的产生者，冻结保证实施与验证同表）。零请求；只写目标 JSON。 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { TABLE } from './routing-v2-draft.mjs';

const draft = await readFile(new URL('./routing-v2-draft.mjs', import.meta.url));
const tableDigest = createHash('sha256').update(JSON.stringify(TABLE)).digest('hex');
const out = {
  record_type: 'wordtable-v2-frozen',
  at: new Date().toISOString().slice(0, 10),
  source: 'routing-v2-draft.mjs TABLE（决策验证器同表；48.0%/55.5% 读数之来源）',
  sourceFileSha256: createHash('sha256').update(draft).digest('hex'),
  tableDigest,
  semantics: {
    match: 'name（高权重）＋frontmatter description；正文不参与',
    strong: '单命中即可判',
    weak: '同桶 ≥2 命中',
    tie: '强命中优先；仍并列且 name-strong 不能唯一解 ⇒ 留待核',
    noDesc: '无 frontmatter/无描述/名字为空 ⇒ 只有 name 强命中可判；否则留待核（草案 §1 契约）',
    placeholder: '占位/模板行一律留待核（不硬填）',
    scope: '只作用于未归类池（qoder 7,596＋no-class-signal 555）；v1 已标行冻结',
  },
  table: TABLE,
};
const outPath = process.argv[2];
if (!outPath) { console.error('usage: node freeze-wordtable-v2.mjs <out.json>'); process.exit(2); }
await writeFile(outPath, `${JSON.stringify(out, null, 1)}\n`);
console.log(JSON.stringify({ saved: outPath, tableDigest }, null, 1));
