import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ZIP 族校准批选单（10 件）：按「tier × 屏检级别」分层覆盖，另必须各打进一件 HUGE_BODY 与
 * NON_KEBAB_NAME——校准的作用是校准判据，只挑干净件会让单价和缺陷率都被低估（143 §3 的 wave-1 教训）。
 */

const REPO = '/Users/lute/project/AgentTools/思维库/skill管理';
const CAND = join(REPO, 'skill-lifecycle/trial-home/opt-run/candidates-zip');
const BASE = join(REPO, 'docs/specs/2026-09-25-dsh-skill-lifecycle/145-standardization-baseline');

function list(dir, rel = '') {
  const out = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...list(dir, r));
    else out.push(r);
  }
  return out;
}

const post = JSON.parse(readFileSync(join(BASE, 'zipfamily-screen-after-normalize.json'), 'utf8'));
const bySlug = new Map(post.skills.map(item => [item.relPath.split('/')[0], item]));

const rows = readdirSync(CAND).map(slug => {
  const files = list(CAND + '/' + slug);
  const item = bySlug.get(slug);
  const severity = item ? (item.severity ?? 'clean') : 'not-screened';
  return {
    slug,
    files: files.length,
    tier: files.length > 6 ? 'large' : 'small',
    severity,
    codes: item ? [...new Set(item.findings.map(finding => finding.code))] : [],
    descriptionChars: item?.descriptionChars ?? 0,
    bodyBytes: item?.bodyBytes ?? 0,
  };
});

const wanted = [
  ['small', 'clean'], ['small', 'clean'],
  ['small', 'medium'], ['small', 'high'],
  ['large', 'clean'], ['large', 'medium'], ['large', 'high'],
];
const picked = [];
for (const [tier, severity] of wanted) {
  const match = rows.find(row => row.tier === tier && row.severity === severity && !picked.includes(row.slug));
  if (match) picked.push(match.slug);
}
for (const special of rows.filter(row => row.codes.some(code => ['HUGE_BODY', 'NON_KEBAB_NAME'].includes(code)))) {
  if (!picked.includes(special.slug) && picked.length < 10) picked.push(special.slug);
}
while (picked.length < 10) {
  const extra = rows.find(row => !picked.includes(row.slug) && row.severity === 'medium');
  if (!extra) break;
  picked.push(extra.slug);
}

const items = picked.map(slug => rows.find(row => row.slug === slug));
const failures = [];
if (items.length !== 10) failures.push(`选单 ${items.length} 件，应为 10`);
if (!items.some(item => item.tier === 'large')) failures.push('选单没有 large 件，档位判据未被覆盖');
if (!items.some(item => item.severity === 'clean')) failures.push('选单没有干净件，无法校准基线单价');
if (!items.some(item => item.codes.includes('HUGE_BODY') || item.codes.includes('NON_KEBAB_NAME')))
  failures.push('选单没打进特殊缺陷族，校准对判据敏感度失明');
if (new Set(items.map(item => item.slug)).size !== items.length) failures.push('选单有重复件');

const tally = items.reduce((acc, item) => {
  acc[item.tier] = (acc[item.tier] ?? 0) + 1;
  acc.bySeverity = acc.bySeverity ?? {};
  acc.bySeverity[item.severity] = (acc.bySeverity[item.severity] ?? 0) + 1;
  return acc;
}, {});

writeFileSync(join(BASE, 'zip-calibration-selection.json'), JSON.stringify({
  at: new Date().toISOString(),
  rule: 'tier × 屏检级别分层覆盖 ＋ HUGE_BODY/NON_KEBAB_NAME 各至少一件；档位阈值＝stage 实测 delivered>6 走 40/240k，否则 12/80k',
  pool: rows.length, tally, items,
  selectionSelfCheck: { checks: 5, failures },
}, null, 1));

console.log(JSON.stringify({ pool: rows.length, tally, failures, items: items.map(item => `${item.slug} ${item.tier} ${item.severity} ${item.files}f ${item.codes.join('|') || '-'}`) }, null, 1));
process.exitCode = failures.length ? 1 : 0;
