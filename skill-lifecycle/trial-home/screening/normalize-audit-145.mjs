import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename, dirname, extname } from 'node:path';

// 只读盘点：把库面每个 SKILL.md 与所有认证/写回台账做对账，找出从未进过流水线的批与件。
const ROOT = process.argv[2] ?? '/Users/lute/project/AgentTools/技能库';
const SPEC = process.argv[3] ??
  '/Users/lute/project/AgentTools/思维库/skill管理/docs/specs/2026-09-25-dsh-skill-lifecycle';

const SKIP_DIRS = new Set(['node_modules', '.git', '.DS_Store', '__pycache__', '.pytest_cache']);

function walk(dir, rel = '', out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(abs, r, out);
    } else {
      out.push({ rel: r, abs, name: e.name, size: statSync(abs).size });
    }
  }
  return out;
}

// 极简 frontmatter 顶层键探测：只判断键是否存在，不做完整 YAML 解析。
function topKeys(text) {
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return null;
  const keys = [];
  let blockDesc = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    if (/^[A-Za-z_][A-Za-z0-9_.-]*:(\s|$)/.test(line)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_.-]*):(.*)$/);
      if (m) {
        keys.push(m[1]);
        const v = m[2].trim();
        blockDesc = /^[|>][-+]?\d*$/.test(v);
      } else blockDesc = false;
    } else if (blockDesc && (/^\s+/.test(line) || line === '')) {
      continue;
    } else blockDesc = false;
  }
  return new Set(keys);
}

function parseName(text) {
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break;
    const m = lines[i].match(/^name:\s*(.*)$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

function descLen(text) {
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break;
    const m = lines[i].match(/^description:\s*(.*)$/);
    if (!m) continue;
    const v = m[1].trim();
    if (/^[|>][-+]?\d*$/.test(v)) {
      let n = 0;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '---') break;
        if (!/^\s/.test(lines[j]) && lines[j] !== '') break;
        n += lines[j].trim().length + 1;
      }
      return n;
    }
    return v.replace(/^["']|["']$/g, '').length;
  }
  return null;
}

// ---- 台账：收集所有出现过轮次读数/收口的件名 ----
const ledgerFiles = [
  ['wave1', '143-library-normalize/fix-plans/p2-wave1-results.csv'],
  ['wave2', '143-library-normalize/fix-plans/p2-wave2-results.csv'],
  ['nm1', '143-library-normalize/nearmiss-pilot/results.csv'],
  ['nm2', '143-library-normalize/nearmiss-pilot2/results.csv'],
  ['lb1', '143-library-normalize/lowband-lb1/results.csv'],
  ['lb2', '143-library-normalize/lowband-lb2/results.csv'],
  ['lb3', '143-library-normalize/lowband-lb3/results.csv'],
  ['lb4', '143-library-normalize/lowband-lb4/results.csv'],
  ['lb5', '143-library-normalize/lowband-lb5/results.csv'],
  ['lb6', '143-library-normalize/lowband-lb6/results.csv'],
  ['lb7', '143-library-normalize/lowband-lb7/results.csv'],
  ['lb8w1', '143-library-normalize/lowband-lb8/wave1-results.csv'],
  ['lb8w1f', '143-library-normalize/lowband-lb8/wave1-final-results.csv'],
  ['lb8w2a', '143-library-normalize/lowband-lb8/wave2a-results.csv'],
  ['lb8w2b', '143-library-normalize/lowband-lb8/wave2b-results.csv'],
  ['lb8gen2', '143-library-normalize/lowband-lb8/gen2-8-results.csv'],
  ['lb8gen3', '143-library-normalize/lowband-lb8/gen3-results.csv'],
  ['lb8c3', '143-library-normalize/lowband-lb8/container3-salvage/receipts/c3r-results.csv'],
  ['strip39', '143-library-normalize/lowband-strip39/results.csv'],
  ['strip39recert', '143-library-normalize/lowband-strip39/recert-results.csv'],
];

const readNames = new Map();   // name -> Set(ledger)
const closedNames = new Map(); // name -> Set(ledger)  收口>=85

function add(set, name, tag) {
  if (!name) return;
  if (!set.has(name)) set.set(name, new Set());
  set.get(name).add(tag);
}

for (const [tag, rel] of ledgerFiles) {
  const p = join(SPEC, rel);
  if (!existsSync(p)) { console.error('MISSING LEDGER', rel); continue; }
  const text = readFileSync(p, 'utf8').replace(/^/, '');
  const lines = text.trim().split('\n');
  const head = lines[0].split(',');
  const iName = head.indexOf('name');
  const iClosed = head.indexOf('closed');
  const iScore = head.indexOf('score');
  for (const line of lines.slice(1)) {
    const cells = splitCsv(line);
    const nm = cells[iName];
    if (!nm) continue;
    add(readNames, nm, tag);
    const closed = iClosed >= 0 ? String(cells[iClosed]).toLowerCase() === 'true' : null;
    const score = iScore >= 0 ? Number(cells[iScore]) : NaN;
    if (closed === true || (Number.isFinite(score) && score >= 85)) add(closedNames, nm, tag);
  }
}

function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// loop-ledger v3（管理圈）
const loopNames = new Set();
{
  const p = join(SPEC, '109-loop-ledger/loop-ledger-v3.csv');
  const text = readFileSync(p, 'utf8').replace(/^/, '');
  const lines = text.trim().split('\n');
  const head = lines[0].split(',');
  const iName = head.indexOf('name');
  for (const l of lines.slice(1)) { const c = splitCsv(l); if (c[iName]) loopNames.add(c[iName]); }
}
// L5 装载台账
const l5Names = new Set();
for (const rel of [
  '143-library-normalize/p2-writeback/l5-ledger.csv',
  '143-library-normalize/lowband-lb8/container3-salvage/l5-ledger.csv',
]) {
  const p = join(SPEC, rel);
  if (!existsSync(p)) continue;
  const lines = readFileSync(p, 'utf8').replace(/^/, '').trim().split('\n');
  const head = lines[0].split(',');
  const iName = head.findIndex(h => /name/i.test(h));
  for (const l of lines.slice(1)) { const c = splitCsv(l); if (iName >= 0 && c[iName]) l5Names.add(c[iName]); }
}

// ---- 库面枚举 ----
const all = walk(ROOT);
const skillFiles = all.filter(f => f.name === 'SKILL.md');
const rows = [];
for (const f of skillFiles) {
  let text = '';
  try { text = readFileSync(f.abs, 'utf8'); } catch { text = ''; }
  const dirName = basename(dirname(f.rel));
  const keys = topKeys(text);
  const fmName = parseName(text);
  const head4 = Buffer.from(text.slice(0, 4));
  rows.push({
    rel: f.rel,
    batch: f.rel.split('/')[0],
    dirName,
    fmName,
    aliasOrSize: f.size,
    hasFm: keys !== null,
    keys,
    desc: descLen(text),
    nulRatio: nulRatio(text),
    name: fmName || dirName,
  });
}

function nulRatio(text) {
  const n = Math.min(text.length, 4000);
  let z = 0;
  for (let i = 0; i < n; i++) if (text.charCodeAt(i) === 0) z++;
  return n ? z / n : 0;
}

// 件名与台账对齐：优先 frontmatter name，其次目录名
const readSet = new Set(readNames.keys());
const closedSet = new Set(closedNames.keys());

const batches = new Map();
for (const r of rows) {
  const b = batches.get(r.batch) ?? { batch: r.batch, skills: 0, read: 0, closed: 0, loop: 0, l5: 0, noFm: 0, nameMismatch: 0, kebabBad: 0, shortDesc: 0, longDesc: 0, missingVersion: 0, opaque: 0, unmatched: [] };
  b.skills++;
  const nm = r.fmName || r.dirName;
  const alt = [r.dirName, r.fmName].filter(Boolean);
  const everRead = alt.some(x => readSet.has(x));
  const everClosed = alt.some(x => closedSet.has(x));
  const inLoop = alt.some(x => loopNames.has(x));
  const inL5 = alt.some(x => l5Names.has(x));
  if (everRead) b.read++;
  if (everClosed) b.closed++;
  if (inLoop) b.loop++;
  if (inL5) b.l5++;
  if (!r.hasFm) b.noFm++;
  if (r.fmName && r.fmName !== r.dirName) b.nameMismatch++;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(r.dirName)) b.kebabBad++;
  if (r.desc !== null && r.desc < 40) b.shortDesc++;
  if (r.desc !== null && r.desc > 500) b.longDesc++;
  if (!r.keys?.has('version')) b.missingVersion++;
  if (r.nulRatio > 0.5) b.opaque++;
  if (!everRead && !inLoop) b.unmatched.push(r.rel);
  batches.set(r.batch, b);
}

// 非技能资产
const archives = all.filter(f => /\.(zip|tar|gz|tgz|7z|rar)$/i.test(f.name));
const looseMd = all.filter(f => f.name !== 'SKILL.md' && extname(f.name).toLowerCase() === '.md');
const dirsUnderRoot = (() => {
  try { return readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
})();
const batchDirsNoSkill = dirsUnderRoot.filter(d => {
  const b = batches.get(d);
  return !b || b.skills === 0;
});

// 整棵树里被 SKIP_DIRS 屏蔽的 SKILL.md（屏检看不到但物理存在）
let hiddenSkills = 0;
{
  const stack = [ROOT];
  while (stack.length) {
    const d = stack.pop();
    let es;
    try { es = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of es) {
      const abs = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(abs);
        else {
          const sub = walkSkipped(abs);
          hiddenSkills += sub;
        }
      } else if (e.name === 'SKILL.md' && d !== ROOT) { /* counted by parent walk if not skipped */ }
    }
  }
}
function walkSkipped(dir) {
  let n = 0; const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of es) {
      if (e.isDirectory()) stack.push(join(d, e.name));
      else if (e.name === 'SKILL.md') n++;
    }
  }
  return n;
}

const report = {
  root: ROOT,
  generatedAt: new Date().toISOString(),
  totals: {
    files: all.length,
    skillMd: rows.length,
    hiddenSkillMdInSkippedDirs: hiddenSkills,
    archives: archives.length,
    looseMdNotSkill: looseMd.length,
    batchDirsWithNoSkill: batchDirsNoSkill,
    ledgerReadNames: readSet.size,
    ledgerClosedNames: closedSet.size,
    loopLedgerNames: loopNames.size,
    l5LedgerNames: l5Names.size,
  },
  batches: [...batches.values()].sort((a, b) => a.skills - b.skills).map(b => ({
    ...b, unmatchedCount: b.unmatched.length, unmatched: b.unmatched,
  })),
  neverRead: rows.map(r => r.rel).filter(rel => {
    const parts = rel.split('/');
    const dirName = basename(dirname(rel));
    const alt = [dirName];
    return !alt.some(x => readSet.has(x) || loopNames.has(x));
  }),
};

console.log(JSON.stringify(report, null, 1));
