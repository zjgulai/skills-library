import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanCredentials } from './credential-tripwire.mjs';

/**
 * 切片选单：屏检 high ＋ medium 的 52 件候选，先走全链（认证基线 → 按靶单修复 → 复评）。
 * 发射前硬门槛：①候选树必须过凭据闸（这批是第三方 zip 物料，早先那道闸只扫过库面）；
 * ②号位必须空闲（probe-b「recordPath 存在即 skip」会把占用号位变成静默空转的假绿）。
 */

const REPO = '/Users/lute/project/AgentTools/思维库/skill管理';
const OPT = join(REPO, 'skill-lifecycle/trial-home/opt-run');
const CAND = join(OPT, 'candidates-zip');
const BASE = join(REPO, 'docs/specs/2026-09-25-dsh-skill-lifecycle/145-standardization-baseline');
const R0 = 1910;

const screen = JSON.parse(readFileSync(join(BASE, 'zipfamily-screen-after-normalize.json'), 'utf8'));
const wanted = screen.skills.filter(item => ['high', 'medium'].includes(item.severity));

function list(dir, rel = '') {
  const out = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...list(dir, r));
    else out.push(r);
  }
  return out;
}

const items = [];
const failures = [];
for (const entry of wanted) {
  const slug = entry.relPath.split('/')[0];
  const dir = join(CAND, slug);
  if (!existsSync(dir)) { failures.push(`候选缺失 ${slug}`); continue; }
  const files = list(dir);
  // 凭据闸：候选树逐个扫，命中即整件拦下不进选单（宁可不发也不能把第三方物料里的密钥带进运行期）
  const scan = scanCredentials(dir, { files });
  if (scan.hits.length) failures.push(`凭据闸拦截 ${slug}: ${scan.hits.map(hit => hit.rel).join(', ')}`);
  items.push({
    slug,
    files: files.length,
    tier: files.length > 6 ? 'large' : 'small',
    severity: entry.severity,
    codes: [...new Set(entry.findings.map(finding => finding.code))],
    credentialHits: scan.hits.length,
    credentialNotes: scan.notes.length,
  });
}

// 校准批已产出读数的件不再重跑：重复发射既花预算又会让同一件有两个认证读数打架。
// void 腿不算「已有读数」，要保留（本批只有 r1908 typography-product-tvc 是 void）。
const calib = JSON.parse(readFileSync(join(BASE, 'zip-calibration-closeout.json'), 'utf8'));
const calibSel = JSON.parse(readFileSync(join(BASE, 'zip-calibration-selection.json'), 'utf8'));
const alreadyRead = new Map();
// 轮次与件名的对应关系取校准选单自身的顺序（发射脚本就是按 items 下标 ＋ r0 排的），
// 不去猜证据里的路径字段——那字段形制多变，猜错会静默不去重（本工具第一次就是这样漏掉 6 件）。
calibSel.items.forEach((item, index) => {
  const roundRow = (calib.rows ?? []).find(row => row.round === 1900 + index);
  if (roundRow?.state === 'reading') alreadyRead.set(item.slug, roundRow.round);
});

const blocked = [...failures];
const deduped = items.filter(item => {
  if (item.credentialHits) { blocked.push(`凭据闸 ${item.slug}`); return false; }
  if (alreadyRead.has(item.slug)) { blocked.push(`校准批已判 ${item.slug}（r${alreadyRead.get(item.slug)}）→ 排除`); return false; }
  return true;
});
const kept = deduped;
const credentialBlocked = items.filter(item => item.credentialHits).length;
const slots = [];
for (let index = 0; index < kept.length; index++) {
  const round = R0 + index;
  if (existsSync(join(OPT, `evidence-${round}`)) || existsSync(join(OPT, `evidence-r${round}`))) slots.push(`r${round} 已被占`);
}
// tally 必须在断言之前声明（TDZ：`tally.high` 早于 const 会让整段崩溃，崩溃不是判红）
const tally = kept.reduce((acc, item) => {
  acc[item.severity] = (acc[item.severity] ?? 0) + 1;
  acc[item.tier] = (acc[item.tier] ?? 0) + 1;
  return acc;
}, {});
if (kept.length + blocked.length - credentialBlocked !== wanted.length) {
  failures.push(`闭合检查不过：选单 ${kept.length} ＋ 排除 ${blocked.length - credentialBlocked} ＋ 凭据拦 ${credentialBlocked} ≠ 请求 ${wanted.length}`);
}
if ((tally.high ?? 0) + (tally.medium ?? 0) !== kept.length) failures.push(`级别求和不闭合：high ${tally.high} + medium ${tally.medium} ≠ ${kept.length}`);
if (kept.some(item => item.credentialHits)) failures.push('有候选带凭据命中却进了选单');
if (slots.length) failures.push(`号位冲突：${slots.slice(0, 5).join(', ')}`);
if (new Set(kept.map(item => item.slug)).size !== kept.length) failures.push('选单有重复件');

const tsv = kept.map((item, index) => {
  const [a, t] = item.tier === 'large' ? [40, 240000] : [12, 80000];
  return `${R0 + index}\t${item.slug}\t${a}\t${t}`;
}).join('\n') + '\n';

writeFileSync(join(BASE, 'zip-slice52-selection.json'), JSON.stringify({
  at: new Date().toISOString(),
  rule: '候选树屏检 worst＝high/medium 的件；逐件先过全树凭据闸，命中即拦',
  requested: wanted.length, kept: kept.length, roundStart: R0, roundEnd: R0 + kept.length - 1,
  tally, items: kept, blocked: failures,
}, null, 1));
writeFileSync(join(BASE, 'zip-slice52-run.tsv'), tsv);
console.log(JSON.stringify({ requested: wanted.length, kept: kept.length, tally, rounds: `${R0}–${R0 + kept.length - 1}`,
  failures, credentialNotesTotal: kept.reduce((sum, item) => sum + item.credentialNotes, 0) }, null, 1));
process.exitCode = failures.length ? 1 : 0;
