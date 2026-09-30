import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 探针 A 的读数（零请求、只读）：把 16 条记录按预注册判据过一遍。
 *
 * 判据（跑前钉死，见 57 号 §2）：
 * 1. 题 1–3（one-of-two）：装且只装一份；
 * 2. 题 4–6（none）：误装 = 0；
 * 3. 题 7–8（record-only）：只记录；
 * 4. 成本：每执行请求数 ≤ 8、tokens ≤ 40k；
 * 5. 未过判者校准记 inconclusive —— 本探针的读数是机械的（加载了哪份技能），不做盲判，
 *    因此不适用判者校准；这一点写在 57 号方案的"判分"里。
 */
const dir = process.argv[2];
if (!dir) {
  process.stderr.write('Usage: node probe-a-read.mjs <evidence-dir>\n');
  process.exit(2);
}
const files = readdirSync(dir).filter(name => name.endsWith('.json')).sort();
const tokensOf = record => (record.ledger?.attempts ?? [])
  .reduce((sum, attempt) => sum + (attempt.usage?.inputTokens ?? 0) + (attempt.usage?.outputTokens ?? 0), 0);
const requestsOf = record => (record.ledger?.attempts ?? []).length;

const rows = [];
for (const name of files) {
  const record = JSON.parse(readFileSync(join(dir, name), 'utf8'));
  const loaded = record.loadedSkills ?? [];
  let verdict;
  if (record.arm === 'none') {
    // none 臂是**对照**：它只有一件事可判——必须 0 加载（证明信号来自我们装的技能，
    // 而不是模型自己"想到"内容策略）。题 1–3 的"只装一份"在这一臂里不适用。
    verdict = loaded.length === 0 ? 'control-ok' : 'FAIL';
  } else if (record.expect === 'one-of-two') {
    verdict = loaded.length === 1 ? 'pass' : 'FAIL';
  } else if (record.expect === 'none') {
    verdict = loaded.length === 0 ? 'pass' : 'FAIL';
  } else {
    verdict = 'record-only';
  }
  rows.push({ file: name, task: record.taskId, arm: record.arm, expect: record.expect,
    loaded: loaded.join('+') || '(未加载)', verdict, requests: requestsOf(record),
    tokens: tokensOf(record), finish: (record.finishKinds ?? []).join(','),
    catalog: record.catalogSeen ? (record.catalogSeen.hasCatalog ? '有' : '无') : '(未捕获)' });
}
const totalRequests = rows.reduce((sum, row) => sum + row.requests, 0);
const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
console.log(JSON.stringify({ records: rows.length, totalRequests, totalTokens,
  hardStop: { requests: 150, tokens: 800000 } }, null, 2));
const violations = rows.filter(row => row.requests > 8 || row.tokens > 40000);
console.log('\n成本违规（>8 请求或 >40k tokens）:', violations.length === 0 ? '无' : violations);
console.table(rows);
const fails = rows.filter(row => row.verdict === 'FAIL');
console.log(`\n判定：pass ${rows.filter(row => row.verdict === 'pass').length} / FAIL ${fails.length} / record-only ${rows.filter(row => row.verdict === 'record-only').length}`);
for (const row of fails) console.log(`  FAIL ${row.arm} ${row.task}: 期望 ${row.expect}，实际加载=${row.loaded}`);
const perArm = { armed: {}, none: {} };
for (const row of rows) {
  const key = `${row.task}`;
  perArm[row.arm][key] = row.loaded;
}
console.log('\n按题对照（armed vs none）：');
for (const task of Object.keys(perArm.armed)) {
  console.log(`  ${task}: armed=${perArm.armed[task]} | none=${perArm.none[task] ?? '(缺)'}`);
}
