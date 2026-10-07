import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 校准批收口：逐轮抽「读数／void／成本／判词」。
 *
 * 取分走三路互证而不是单条正则——历史上栽过两类假读数：
 *   ①「取文末」被尾部阈值句（≥85 分门槛）截胡；②不锚定「取首个」撞上 N/100 的分母与 **100%** 权重列。
 * 三路不一致时采自洽值并登记，不静默取第一个。
 */

const REPO = '/Users/lute/project/AgentTools/思维库/skill管理';
const OPT = join(REPO, 'skill-lifecycle/trial-home/opt-run');
const BASE = join(REPO, 'docs/specs/2026-09-25-dsh-skill-lifecycle/145-standardization-baseline');

const THRESHOLD_LINE = /(门槛|阈值|标准线|≥|>=|低于|高于|达到)\s*[^\n]{0,12}?\d{2,3}/;
const isPlausible = n => Number.isFinite(n) && n >= 5 && n <= 100;

// 总分只从「表格里的总计行」取，并与散文/标签路线互证；三路不一致就登记不硬取。
// 既存对（2026-10-07 逐件读原文）：r1900 81.0｜r1901 78.5｜r1902 53.5｜r1903 76.5｜r1904 80.5
// ＋r1905 81.5｜r1906 79.0｜r1907 48.0｜r1909 81（报告原文写作 `81.25 -> 81`，按修正后值取 81）
function grabScores(report) {
  const lines = report.split('\n');
  const routes = { table: [], label: [], prose: [] };
  const TOTAL_CELL = /总计|加权总分|综合总分|综合得分|总分/;
  for (const raw of lines) {
    const line = raw.trim();
    // ① 表格总计行：排除权重列的 **100%** 与占位 `-`；箭头形制 `81.25 -> 81` 取修正后值
    if (line.startsWith('|') && TOTAL_CELL.test(line)) {
      for (const cell of line.split('|').map(c => c.trim()).filter(Boolean)) {
        if (/%/.test(cell) || cell === '-' || TOTAL_CELL.test(cell.replace(/\*/g, ''))) continue;
        // 合计单元格有四种自洽写法，一律取**报告自己给的末位规范值**（与 wave-2「37.25 -> 41.0 取 41.0」同规则）：
        //   78.5 ｜ 81.25 -> 81 ｜ 76.05 ≈ 76.0 ｜ 74.45 (四舍五入 74.5)
        // 必须是「分数形制」的单元格：以数字开头，且除 分／约／≈／→／四舍五入 外不含文字——
        // 否则像 `**状态：需优化（需修复 Warning 并补充合规项后达到 >= 85 分）**` 这种说明格会被读成 85（校准批复跑当场抓回）
        if (!/^(?:\*\*)?\s*\d/.test(cell)) continue;
        const residue = cell.replace(/\*/g, '').replace(/\d|\.|(?:分|约|近)|(?:四舍五入)|[\s()（）\[\]≈→\-\/+]|\bkeep\b/g, '');
        if (/[A-Za-z\u4e00-\u9fff]/.test(residue)) continue;
        const clean = cell.replace(/\*/g, '').trim();
        const numbers = [...clean.matchAll(/(\d{1,3}(?:\.\d{1,2})?)/g)].map(m => Number(m[1])).filter(isPlausible);
        if (numbers.length) routes.table.push(numbers[numbers.length - 1]);
      }
      continue;
    }
    // ② 标签路线：值必须紧跟在「：／＝」之后；紧邻 ≥／门槛／低于 的數字一律拒绝（85 是门槛不是得分）
    const labelled = line.match(/(?:加权总分|综合总分|综合得分|最终得分|总分)[^\d]{0,6}?(?:[:：＝=]\s*)?(?:\*\*)?\s*(\d{1,3}(?:\.\d{1,2})?)/);
    if (labelled) {
      const before = line.slice(Math.max(0, labelled.index - 10), labelled.index + labelled[0].indexOf(labelled[1]));
      // 预测式措辞里的数字不是得分：r1901 的「预期综合得分可提升至 90+ 分」曾被既存对照抓成误读
      if (!/(≥|>=|低于|高于|达到|门槛|未达|预期|预计|提升至|可提升|提升至)/.test(before)) {
        const n = Number(labelled[1]);
        if (isPlausible(n)) routes.label.push(n);
      }
    }
    // ③ 散文路线：`79.0 / 100`，同样拒绝门槛句里的数字
    const prose = line.match(/(\d{1,3}(?:\.\d{1,2})?)\s*\/\s*100/);
    if (prose) {
      const before = line.slice(Math.max(0, prose.index - 10), prose.index);
      if (!/(≥|>=|低于|达到|门槛)/.test(before)) { const n = Number(prose[1]); if (isPlausible(n)) routes.prose.push(n); }
    }
  }
  return routes;
}

function mode(list) {
  const counts = new Map();
  for (const n of list) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? null;
}

// 判词只看「发布结论」那一行的枚举 token。条件句里的「即可直接发布／可提升至 90+」不是判词——
// r1901/r1905 原文都有这种句子，早版按 tail 关键字判会把需优化读成可发布。
const CONDITIONAL = /即可|预计|预期|将(提升|可达)|复测后|修复后|达到\s*>=?\s*85\s*(分)?\s*(后|即可)|提升至/;
const verdictOf = report => {
  for (const raw of report.split('\n')) {
    const line = raw.trim();
    if (!/发布结论|结论[:：]|综合发布结论/.test(line)) continue;
    if (/needs_refactor|需重构/.test(line)) return 'reject';
    if (/needs_optimization|需优化|需要优化|优化后再发布|优化通过/.test(line)) return 'needs-optimising';
    if (CONDITIONAL.test(line)) continue;
    if (/needs_publication|可发布|准予发布|可以发布|达到发布标准|建议发布/.test(line)) return 'publishable';
  }
  return 'unknown';
};

// 轮次范围可由 --tsv 指定（收口件与校准件共用同一条取分/判词判据，不另写一套）
const tsvPath = (() => { const i = process.argv.indexOf('--tsv'); return i === -1 ? null : process.argv[i + 1]; })();
const tag = tsvPath ? 'zip-slice52' : 'zip-calibration';
const rounds = tsvPath
  ? readFileSync(tsvPath, 'utf8').trim().split('\n').map(line => Number(line.split('\t')[0]))
  : [1900, 1901, 1902, 1903, 1904, 1905, 1906, 1907, 1908, 1909];
const rows = [];
for (const round of rounds) {
  const dir = join(OPT, `evidence-r${round}`);
  const voidDirs = [];
  for (const entry of readdirSync(OPT)) if (entry === `evidence-r${round}-void1`) voidDirs.push(entry);
  if (!existsSync(dir)) { rows.push({ round, state: 'no-evidence', voids: voidDirs }); continue; }
  const files = readdirSync(dir).filter(name => name.endsWith('.json'));
  if (!files.length) { rows.push({ round, state: 'empty-dir', voids: voidDirs }); continue; }
  const rec = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
  const ledger = rec.ledger ?? {};
  const report = rec.report ?? rec.replyText ?? '';
  const routes = grabScores(report);
  const found = Object.entries(routes).filter(([, list]) => list.length);
  // 主证＝判者自己填的表格总计行；标签/散文只用来旁证（预测句和门槛句更容易污染散文）
  const primary = routes.table.length ? mode(routes.table) : (routes.label.length ? mode(routes.label) : mode(routes.prose));
  const values = found.map(([key, list]) => (key === 'table' ? mode(list) : (list.includes(primary) ? primary : mode(list))));
  // 主证（表格总计）须至少被一路旁证印证；散文路本来就是门槛句/区间枚举的高污染路，
  // 它多值时不算判红，而是单独登记 routeNoise——悄悄放宽判据换绿灯是不行的，所以噪音必须留在台账里。
  // 语义：凡产出值的路线都必须与主证一致（不一致＝真取分失败）；只有单路产出时值仍可采，
  // 但算「覆盖度缺口」单独计数——既不把单路当失败，也不悄悄当全绿。
  const agree = primary !== null && values.every(v => v === primary);
  const singleRoute = values.length === 1;
  const routeNoise = Object.entries(routes).filter(([, list]) => new Set(list).size > 1)
    .map(([key, list]) => `${key}:${JSON.stringify(list)}`);
  rows.push({
    round,
    state: (rec.reportChars ?? report.length) === 0 ? 'void' : 'reading',
    reportChars: rec.reportChars ?? report.length,
    finishKinds: rec.finishKinds ?? null,
    attemptsReserved: ledger.attemptsReserved ?? null,
    attemptsSettled: ledger.attemptsSettled ?? null,
    attemptsUnknown: ledger.attemptsUnknown ?? null,
    tokensLedger: ledger.observedTokenTotal ?? null,
    tokensIn: ledger.observedInputTokens ?? null,
    tokensOut: ledger.observedOutputTokens ?? null,
    tokensCacheRead: ledger.observedCacheReadTokens ?? null,
    elapsedSec: rec.elapsedMs ? Math.round(rec.elapsedMs / 1000) : null,
    score: primary,
    scoreRoutes: Object.fromEntries(found),
    scoreAgreement: agree,
    singleRoute,
    routeNoise,
    verdict: report ? verdictOf(report) : null,
    voidArchives: voidDirs,
  });
}

const readings = rows.filter(row => row.state === 'reading');
const voids = rows.filter(row => row.state !== 'reading');
const closedItems = readings.filter(row => (row.score ?? 0) >= 85 && row.verdict === 'publishable');
const closed = closedItems;
const auditTokens = readings.reduce((sum, row) => sum + (row.tokensLedger ?? 0), 0)
  + voids.reduce((sum, row) => sum + (row.tokensLedger ?? 0), 0);
const auditAttempts = readings.reduce((sum, row) => sum + (row.attemptsSettled ?? 0), 0)
  + voids.reduce((sum, row) => sum + (row.attemptsSettled ?? 0), 0);

const failures = [];
if (rows.length !== rounds.length) failures.push(`轮次记录 ${rows.length} 条，应为 ${rounds.length}`);
if (readings.some(row => row.score === null)) failures.push(`有读数没抽到分数：${readings.filter(r => r.score === null).map(r => r.round).join(',')}`);
if (readings.filter(row => !row.scoreAgreement).length) failures.push(`三路取分不一致（采自洽值并登记）：${readings.filter(r => !r.scoreAgreement).map(r => `${r.round}:${JSON.stringify(r.scoreRoutes)}`).join(' ; ')}`);
// 判词既存对：九件全部是需优化／需重构，任何一件被判成 publishable 都是仪器出错
const KNOWN_VERDICT = tsvPath ? {} : { 1902: 'reject', 1907: 'reject' };
for (const [round, expected] of Object.entries(KNOWN_VERDICT)) {
  const got = rows.find(row => row.round === Number(round))?.verdict;
  if (got !== expected) failures.push(`判词仪器读偏：r${round} 应 ${expected}，实得 ${got}`);
}
if (!tsvPath && readings.some(row => row.verdict === 'publishable')) failures.push('本批无一件可发布；出现 publishable 即条件句污染');
if (auditTokens === 0) failures.push('成本合计为 0——账本没读到，不是真的零消耗');
if (rows.length !== rounds.length) failures.push(`轮次记录 ${rows.length} ≠ 清单 ${rounds.length}`);
if (readings.length === 0) failures.push('全部腿无读数——发射没真干活');
// 已知答案对照：这三条是我逐条读过报告原文确认的值，用来证明取分仪器没有读偏
// （门槛句 85、权重列 **100%**、维度分都可能被误取，只有既存对能抓到）。
const KNOWN = tsvPath ? {} : { 1900: 81.0, 1901: 78.5, 1902: 53.5, 1903: 76.5, 1904: 80.5, 1905: 81.5, 1906: 79.0, 1907: 48.0, 1909: 81 };
for (const [round, expected] of Object.entries(KNOWN)) {
  const got = rows.find(row => row.round === Number(round))?.score;
  if (got !== expected) failures.push(`取分仪器对已知答案读偏：r${round} 应 ${expected}，实得 ${got}`);
}

const result = {
  at: new Date().toISOString(),
  rounds: 'r1900–r1909',
  tally: { readings: readings.length, voids: voids.length, closed: closed.length, unresolved: readings.length - closed.length },
  cost: {
    auditTokens, auditAttempts,
    perReadingMean: readings.length ? Math.round(auditTokens / (readings.length + voids.length)) : 0,
    voidTokens: voids.reduce((sum, row) => sum + (row.tokensLedger ?? 0), 0),
  },
  extrapolation: {
    basis: '本批 10 腿实测件均（含 void）',
    perItem: Math.round(auditTokens / 10),
    fullBatch399: Math.round(auditTokens / 10 * 399),
    note: '校准 10 件覆盖 small 6／large 4；放量按同比例外推，void 率也按本批外推',
  },
  rows,
  selfCheck: { checks: 9 + 4, failures, routeNoiseItems: readings.filter(r => (r.routeNoise??[]).length).map(r => r.round) },
};
writeFileSync(join(BASE, `${tag}-closeout.json`.replace('zip-calibration-', 'zip-calibration-')), JSON.stringify(result, null, 1));
writeFileSync(join(BASE, `${tag}-results.csv`),
  ['round,state,score,agreement,verdict,reportChars,attemptsSettled,tokensLedger,tokensIn,tokensOut,cacheRead,elapsedSec,voids'].join('\n') + '\n'
  + rows.map(row => [row.round, row.state, row.score ?? '', row.scoreAgreement ?? '', row.verdict ?? '',
    row.reportChars ?? '', row.attemptsSettled ?? '', row.tokensLedger ?? '', row.tokensIn ?? '',
    row.tokensOut ?? '', row.tokensCacheRead ?? '', row.elapsedSec ?? '', (row.voidArchives ?? []).join('|')].join(',')).join('\n') + '\n');
console.log(JSON.stringify({ tally: result.tally, cost: result.cost, extrapolation: result.extrapolation,
  selfCheck: result.selfCheck, rows: rows.map(row => `${row.round} ${row.state} score=${row.score ?? '-'} agree=${row.scoreAgreement ?? '-'} ${row.verdict ?? '-'} tok=${row.tokensLedger ?? '-'} att=${row.attemptsSettled ?? '-'} ${row.elapsedSec ?? '-'}s`) }, null, 1));

// 报失败却不判红＝假绿面：自检有失败必须非零退出
if (result.selfCheck.failures.length) process.exitCode = 1;
