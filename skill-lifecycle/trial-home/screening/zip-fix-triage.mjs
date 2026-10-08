import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 修复腿分诊：把基线批的判者报告压成「逐件靶单」，供制作代理按条修，不靠它自己重新读报告。
 *
 * 两条硬规矩（都来自 143 的事故）：
 *   ① 靶单必须带判者原文窗口，不能让代理只看我概括的条目——概括会漂；
 *   ② 分数与判词从已自证的收口件读，不在这里重算，避免两处真源打架。
 */

const REPO = '/Users/lute/project/AgentTools/思维库/skill管理';
const OPT = join(REPO, 'skill-lifecycle/trial-home/opt-run');
const BASE = join(REPO, 'docs/specs/2026-09-25-dsh-skill-lifecycle/145-standardization-baseline');
const CLOSED = 85;

const closeout = JSON.parse(readFileSync(join(BASE, 'zip-slice52-closeout.json'), 'utf8'));
const selection = JSON.parse(readFileSync(join(BASE, 'zip-slice52-selection.json'), 'utf8'));
const slugByRound = new Map(selection.items.map((item, index) => [1910 + index, item.slug]));

const HEADINGS = /必须修复|推荐修复|关键问题|主要扣分|扣分项|待修复|问题清单|Issues?|Findings/i;

// 扣分项在报告里没有统一小节名（43 份报告出现 227 种标题），但有稳定标记：
// 带序号的「问题 N：…」「Error/Warning/Info 级」标题，以及「必须修复／推荐修复」条目。
// 按小节词表匹配实测漏掉 21/42 件，所以改抓这些标记并把其后直到下一个标题的正文一起带走。
const ITEM_HEAD = /(?:^|\s)(?:#{2,6}\s*)?(?:[\u274c\ud83d\udd34\ud83d\udfe1\ud83d\udd35\u26a0\ufe0f\u2139\ufe0f\s]*)\s*(?:\d+\.\d*\s*)?(?:问题|错误|警告|建议|缺陷)\s*\d*\s*[:：\u3010(\uff08]/;
const SEVERITY_HEAD = /#{2,6}\s*.*(必须修复|推荐修复|Error|Warning|Info)\s*(级|级别)?/i;

function deductionsOf(report) {
  const lines = report.split('\n');
  const out = [];
  let collecting = false;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.trim();
    if (!line) continue;
    const isHeading = /^#{1,6}\s/.test(line);
    const level = isHeading ? (line.match(/^#+/)[0].length) : 0;
    // 「## 三、问题清单」下的「### 1. Schema 合规性问题」是扣分条目本身，不能当换段停手；
    // 只有换到另一个二级章节（如「## 四、优化建议」）才真的收尾——早版在此掐断，21 件抽不到扣分。
    const looksLikeItem = ITEM_HEAD.test(line) || SEVERITY_HEAD.test(line) || HEADINGS.test(line)
      || (isHeading && level >= 3 && /问题|缺陷|错误|警告|缺失|缺少|违规|风险/.test(line));
    if (looksLikeItem) collecting = true;
    else if (isHeading && level <= 2) collecting = false;
    if (!collecting) continue;
    // 表格壳不算扣分条目：分隔行 `|---|` 与无严重度词的表头行（`| 序号 | 字段 | 严重度 |`）。
    // 早版把壳也计进条目并截到 16 条，于是「16 条扣分只可见 6 条」成了制作腿反复登记的假盲区
    // （2026-10-07 实测：42 件真扣分共 80 条，靶单一条不漏，虚增的计数才是问题）。
    if (/^\|[-:\s|]+\|?$/.test(line)) continue;
    if (/^\|/.test(line) && !/(error|warning|info|严重|阻断|❌|🔴|🟡|🔵)/i.test(line)) continue;
    const text = line.replace(/^#+\s*/, '').replace(/^(\||[-*\u2022]|\d+[.)、])\s*/, '').replace(/\*\*/g, '').slice(0, 420);
    if (text.length < 8) continue;
    if (out.some(entry => entry.text === text)) continue;   // 尾部窗口与正文重复的同一行只留一条
    out.push({ at: index, text });
    if (out.length >= 60) break;
  }
  return out;
}

const items = [];
for (const row of closeout.rows) {
  const slug = slugByRound.get(row.round);
  if (!slug) { items.push({ round: row.round, slug: null, state: 'round-unmapped' }); continue; }
  if (row.state !== 'reading') { items.push({ round: row.round, slug, state: 'void' }); continue; }
  const dir = join(OPT, `evidence-r${row.round}`);
  const record = JSON.parse(readFileSync(join(dir, readdirSync(dir).find(name => name.endsWith('.json'))), 'utf8'));
  const report = record.report ?? '';
  const list = deductionsOf(report);
  // 「扣分相关行数」≠「扣分条目数」：早版只报前者，42 件合计 1062 行、真实带序号的表格扣分只有 80 条，
  // 制作腿因此反复登记「16 条只可见 6 条」的假盲区。两个数都写进靶单抬头，条目数说了算。
  const rows = deductionRowsOf(report);
  const needsFix = (row.score ?? 0) < CLOSED || row.verdict !== 'publishable';
  if (needsFix) {
    mkdirSync(join(BASE, 'fix-targets'), { recursive: true });
    writeFileSync(join(BASE, 'fix-targets', `${slug}.md`),
      `# ${slug}｜基线 r${row.round} 判者靶单\n\n- 基线分：**${row.score ?? '未取到'}**｜判词：${row.verdict ?? '未定'}\n- 判者报告：${record.reportChars ?? report.length} 字符｜${
        rows.length ? `**带序号的扣分条目 ${rows.length} 条，本靶单已逐条收录**（下面另附 ${list.length} 行扣分相关原文，含说明句，不是条目数）`
          : `本件报告**不用表格列条目**（扣分以正文编号句陈述），下面 ${list.length} 行即报告扣分相关原文全量——按内容逐条修，别按行数猜条目数`}\n\n${
        list.length ? list.map((entry, n) => `${n + 1}. ${entry.text}`).join('\n') : '（未能定位扣分小节——见下"未定位"标记，需人工读报告）\n'
      }\n\n## 报告尾部原文（判词与总分所在）\n\n${report.slice(-900)}\n`);
  }
  items.push({
    round: row.round, slug, score: row.score, verdict: row.verdict, state: 'reading',
    deductionCount: list.length, deductionRows: rows.length, needsFix, listCapped: list.length >= 60,
    tokens: row.tokensLedger, attempts: row.attemptsSettled,
  });
}

const reading = items.filter(item => item.state === 'reading');
const needs = reading.filter(item => item.needsFix);
const normCov = s => s.replace(/[\s|*`]/g, '');
/** 带序号且含严重度的表格扣分行＝判者自己列出的条目，是「件数」口径的唯一来源。 */
function deductionRowsOf(report) {
  return String(report ?? '').split('\n').map(l => l.trim())
    .filter(s => /^\|\s*\*{0,2}\d+\*{0,2}\s*\|/.test(s) && (s.match(/\|/g) ?? []).length >= 4
      && /(error|warning|info|严重|阻断)/i.test(s));
}

const failures = [];
if (items.length !== closeout.rows.length) failures.push(`分诊件数 ${items.length} ≠ 收口件数 ${closeout.rows.length}`);
if (needs.some(item => item.deductionCount === 0)) {
  failures.push(`有 ${needs.filter(item => item.deductionCount === 0).length} 件定位不到扣分小节：${needs.filter(item => item.deductionCount === 0).map(item => item.slug).join(', ')}`);
}
if (!existsSync(join(BASE, 'fix-targets', `${needs[0]?.slug ?? 'x'}.md`))) failures.push('靶单文件没落盘');
// 覆盖断言（2026-10-07 加）：报告里「带序号＋严重度的表格扣分行」必须逐条出现在靶单中。
// 制作腿三轮都登记过「16 条只可见 X 条」的假盲区；这条断言把「靶单是否漏条目」变成机检，
// 而不是让代理按计数猜。归一化去空白/竖线/星号/反引号后取前 70 字符比对。
const covMiss = [];
for (const item of needs) {
  const dir = join(OPT, `evidence-r${item.round}`);
  const rec = JSON.parse(readFileSync(join(dir, readdirSync(dir).find(name => name.endsWith('.json'))), 'utf8'));
  const md = normCov(readFileSync(join(BASE, 'fix-targets', `${item.slug}.md`), 'utf8'));
  for (const s of deductionRowsOf(rec.report)) {
    if (!md.includes(normCov(s).slice(0, 70))) covMiss.push(`${item.slug} ← ${s.slice(0, 60)}`);
  }
}
if (covMiss.length) failures.push(`靶单漏扣分 ${covMiss.length} 条：${covMiss.slice(0, 3).join(' ; ')}`);

// 负控：判据不能恒真——把报告换成「什么小节都没有」的样本，deductionCount 必须为 0
const emptyProbe = deductionsOf('普通段落，没有任何小节标题，也没有列表项。');
if (emptyProbe.length !== 0) failures.push(`空样本被抽出 ${emptyProbe.length} 条扣分——判据过宽`);
// 正控：构造一条标准判者扣分段，必须被抓到
const sampleProbe = deductionsOf('## 必须修复\n\n- 缺少 negative-triggers\n1. description 过短\n');
if (sampleProbe.length !== 2) failures.push(`构造样本应抓到 2 条，实得 ${sampleProbe.length}——判据过窄`);

const result = {
  at: new Date().toISOString(),
  source: 'zip-slice52-closeout.json（分数与判词不在本工具重算）',
  totals: { rounds: items.length, readings: reading.length, voids: items.filter(i => i.state === 'void').length,
    needFix: needs.length, alreadyClosed: reading.filter(i => !i.needsFix).length,
    unmapped: items.filter(i => i.state === 'round-unmapped').length },
  budgetForFixLegs: { perItemBaseline: Math.round(reading.reduce((s, i) => s + (i.tokens ?? 0), 0) / reading.length),
    note: '修复腿＝制作（子代理）＋复评（判者）；复评按 LB 带件均 71–93k 估，不等于基线件均' },
  items: needs.map(item => ({ slug: item.slug, round: item.round, score: item.score, verdict: item.verdict,
    deductions: item.deductionCount, deductionRows: item.deductionRows })),
  selfCheck: { checks: 6, failures },
};
writeFileSync(join(BASE, 'zip-fix-triage.json'), JSON.stringify({ ...result, allItems: items }, null, 1));
console.log(JSON.stringify({ totals: result.totals, selfCheck: result.selfCheck,
  sample: result.items.slice(0, 8), fixLegEstimate: result.budgetForFixLegs }, null, 1));
if (result.selfCheck.failures.length) process.exitCode = 1;
