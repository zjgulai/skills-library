import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 探针 B 的读数（零请求、只读）：按 criteria-rev2.json 的判据出结论。
 *
 * rev1 → rev2 的两处改动（见 criteria-rev2.json 的 why/disclosure）：
 * 1. 结论抽取：从「只认 YAML 的 `status:`」改成「词表抽取」（中文＋英文都认，noRelease 优先）；
 * 2. 干净对照的期望：从「必须 release 档」改成「有明确结论词 + 不得命中植入缺陷词」
 *    （rubric 的门槛是「六维度 ≥85 且无 error」，结构完整不等于达标）。
 * 命中匹配仍限定在 issues 区块内；报告非 YAML 时整篇视为 issues 区块。
 */
const dir = process.argv[2];
if (!dir) {
  process.stderr.write('Usage: node probe-b-read.mjs <evidence-dir> [criteria.json] [out.txt]\n');
  process.exit(2);
}
const criteriaPath = process.argv[3] ?? join(import.meta.dirname, 'criteria-rev2.json');
const outPath = process.argv[4];
const criteria = JSON.parse(readFileSync(criteriaPath, 'utf8'));
const { noRelease, release: releaseWords } = criteria.verdictWords;

function issuesBlockOf(report) {
  const lines = report.split(/\r?\n/);
  const start = lines.findIndex(line => /^issues\s*:/.test(line));
  if (start === -1) return { block: report, scoped: false };
  const out = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[a-zA-Z_][a-zA-Z0-9_]*\s*:/.test(lines[index])) break;
    out.push(lines[index]);
  }
  return { block: out.join('\n'), scoped: true };
}

const verdictOf = report => {
  const yaml = report.match(/status\s*:\s*"?([a-zA-Z_]+)"?/);
  if (yaml) {
    const value = yaml[1].toLowerCase();
    if (noRelease.includes(value)) return { verdict: 'no-release', via: `yaml:${value}` };
    if (releaseWords.includes(value)) return { verdict: 'release', via: `yaml:${value}` };
  }
  // noRelease 先判：『未达标』这类词里含『达标』，反过来扫会误判成 release。
  for (const word of noRelease) if (report.includes(word)) return { verdict: 'no-release', via: `text:${word}` };
  for (const word of releaseWords) if (report.includes(word)) return { verdict: 'release', via: `text:${word}` };
  return { verdict: 'unknown', via: 'none' };
};

const tokensOf = record => (record.ledger?.attempts ?? [])
  .reduce((sum, attempt) => sum + (attempt.usage?.inputTokens ?? 0) + (attempt.usage?.outputTokens ?? 0), 0);
const requestsOf = record => (record.ledger?.attempts ?? []).length;

const rows = [];
for (const name of readdirSync(dir).filter(entry => entry.endsWith('.json')).sort()) {
  const record = JSON.parse(readFileSync(join(dir, name), 'utf8'));
  const report = typeof record.report === 'string' ? record.report : '';
  const { block } = issuesBlockOf(report);
  const { verdict, via } = verdictOf(report);
  const defectHit = (record.defectTokens ?? []).some(token => block.includes(token));
  rows.push({ file: name, taskId: record.taskId, arm: record.arm, repeat: record.runId.slice(-1),
    expect: record.releaseExpect, cleanControl: record.cleanControl === true,
    verdict, via, defectHit,
    reportChars: report.length, requests: requestsOf(record), tokens: tokensOf(record),
    loaded: (record.loadedSkills ?? []).join('+') || '(none)' });
}

const byArm = arm => rows.filter(row => row.arm === arm);
const tasks = [...new Set(rows.map(row => row.taskId))];
const planted = tasks.filter(task => rows.find(row => row.taskId === task && !row.cleanControl));
const clean = tasks.filter(task => rows.find(row => row.taskId === task && row.cleanControl));

const lines = [];
const say = line => { lines.push(line); console.log(line); };

say(`判据：${criteriaPath.split('/').pop()}（${criteria.version}）`);
say(JSON.stringify({ records: rows.length,
  totalRequests: rows.reduce((sum, row) => sum + row.requests, 0),
  totalTokens: rows.reduce((sum, row) => sum + row.tokens, 0) }));
say('');
say('arm   task                     r  verdict      via                  缺陷命中  报告字符  请求  tokens');
for (const row of rows) {
  say(`${row.arm.padEnd(5)} ${row.taskId.padEnd(24)} ${row.repeat}  ${row.verdict.padEnd(12)} ${String(row.via).padEnd(21)} ${String(row.defectHit).padEnd(8)} ${String(row.reportChars).padStart(6)} ${String(row.requests).padStart(4)} ${String(row.tokens).padStart(7)}`);
}

const bothHit = (arm, task) => byArm(arm).filter(row => row.taskId === task && row.defectHit).length === 2;
const bothVerdict = (arm, task, verdict) => byArm(arm).filter(row => row.taskId === task && row.verdict === verdict).length === 2;

say('');
say('=== 判据（rev2） ===');
const armedHit = planted.filter(task => bothHit('armed', task)).length;
const noneHit = planted.filter(task => bothHit('none', task)).length;
say(`1 缺陷覆盖：armed ${armedHit}/${planted.length}，none ${noneHit}/${planted.length} ⇒ ${armedHit >= 3 && armedHit > noneHit ? 'PASS' : 'FAIL'}`);
const cleanOk = arm => clean.filter(task => {
  const rowsFor = byArm(arm).filter(row => row.taskId === task);
  return rowsFor.length === 2 && rowsFor.every(row => row.verdict !== 'unknown' && row.defectHit === false);
}).length;
say(`2 干净对照（有明确结论词 + 不命中植入缺陷词）：armed ${cleanOk('armed')}/${clean.length}，none ${cleanOk('none')}/${clean.length} ⇒ ${cleanOk('armed') === clean.length && cleanOk('none') === clean.length ? 'PASS' : 'FAIL'}`);
const verdictOk = arm => planted.filter(task => bothVerdict(arm, task, 'no-release')).length;
say(`3 植入题结论正确（no-release）：armed ${verdictOk('armed')}/${planted.length}，none ${verdictOk('none')}/${planted.length} ⇒ armed ${verdictOk('armed') >= 3 ? 'PASS' : 'FAIL'}`);
const costViolations = rows.filter(row => row.requests > 10 || row.tokens > 60000);
say(`4 成本：${costViolations.length === 0 ? 'PASS' : `FAIL（${costViolations.length} 条违规）`}`);
// 按 **臂** 分组比对两次重复：早先按 taskId 取行会同时拿到两臂 4 行 ⇒ length!==2 恒真 ⇒
// 「稳定性」检查永不触发（2026-09-30 校准批实测：none:q5-clean 两轮 release/no-release 被漏报）。
const unstable = planted.concat(clean).flatMap(task =>
  ['armed', 'none'].flatMap(arm => {
    const rowsFor = rows.filter(row => row.taskId === task && row.arm === arm);
    return rowsFor.length === 2 && rowsFor[0].verdict !== rowsFor[1].verdict ? [`${arm}:${task}`] : [];
  }));
say(`5 稳定性（同题两次结论一致）：观察项 —— ${unstable.length === 0 ? '无波动' : `波动题：${unstable.join('、')}`}`);

say('');
say('=== 信息性（不计分） ===');
for (const arm of ['armed', 'none']) {
  const cleanVerdicts = clean.map(task => `${task}:${[...new Set(byArm(arm).filter(row => row.taskId === task).map(row => row.verdict))].join('/')}`);
  const armRows = byArm(arm);
  const avgChars = Math.round(armRows.reduce((sum, row) => sum + row.reportChars, 0) / Math.max(1, armRows.length));
  const avgTokens = Math.round(armRows.reduce((sum, row) => sum + row.tokens, 0) / Math.max(1, armRows.length));
  say(`${arm}：干净对照结论 ${cleanVerdicts.join('  ')} ｜ 报告均长 ${avgChars} 字符 ｜ 每执行均 ${avgTokens} tokens`);
}
if (outPath) writeFileSync(outPath, `${lines.join('\n')}\n`);
