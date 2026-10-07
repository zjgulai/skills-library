import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

// 145 号只读盘点：库面 × 认证台账 × 写回备份根 × 屏检，四维对账「哪些批/件从未标准化」。
const LIB = '/Users/lute/project/AgentTools/技能库';
const REPO = '/Users/lute/project/AgentTools/思维库/skill管理';
const TRIAL = join(REPO, 'skill-lifecycle/trial-home');
const SPEC = join(REPO, 'docs/specs/2026-09-25-dsh-skill-lifecycle');
const SKIP = new Set(['node_modules', '.git', '__pycache__', '.pytest_cache', '.venv', 'venv']);

function walk(dir, rel, out) {
  let es;
  try { es = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(join(dir, e.name), r, out); }
    else out.push(r);
  }
  return out;
}

function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}
function readCsv(p) {
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, 'utf8').replace(/^/, '').trim().split('\n');
  const head = splitCsv(lines[0]);
  return lines.slice(1).map(l => { const c = splitCsv(l); const o = {}; head.forEach((h, i) => o[h] = c[i]); return o; });
}

// ---------- A. 屏检现状（自带工具，含 descriptionChars/findings） ----------
const screen = JSON.parse(readFileSync(join(TRIAL, 'screening/library-screen-2026-10-07b.json'), 'utf8'));
const byRel = new Map(screen.skills.map(s => [s.relPath, s]));

// ---------- B. 判者实跑过的库面绝对路径（r*/stage.json） ----------
const optRun = join(TRIAL, 'opt-run');
const certPaths = new Map(); // relPath(库内) -> Set(轮次标签)
let roundDirs = 0;
for (const e of readdirSync(optRun, { withFileTypes: true })) {
  if (!e.isDirectory() || !/^r\d+$/.test(e.name)) continue;
  const p = join(optRun, e.name, 'stage.json');
  if (!existsSync(p)) continue;
  roundDirs++;
  let j; try { j = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
  if (typeof j.skill === 'string' && j.skill.startsWith(LIB)) {
    const rel = j.skill.slice(LIB.length + 1);
    if (!certPaths.has(rel)) certPaths.set(rel, new Set());
    certPaths.get(rel).add(`r${j.round}`);
  }
}

// ---------- C. 写回备份根 → 曾被写回库面的技能目录 ----------
const writtenBack = new Map(); // skillDirRel -> Set(backup tag)
for (const e of readdirSync(TRIAL, { withFileTypes: true })) {
  if (!e.isDirectory() || !e.name.startsWith('library-backup-writeback-')) continue;
  const tag = e.name.replace('library-backup-writeback-', '');
  let sub;
  try { sub = readdirSync(join(TRIAL, e.name), { withFileTypes: true }); } catch { continue; }
  for (const s of sub) {
    if (!s.isDirectory()) continue;
    walk(join(TRIAL, e.name, s.name), s.name, []).filter(f => basename(f) === 'SKILL.md')
      .forEach(f => {
        const dir = dirname(f);
        if (!writtenBack.has(dir)) writtenBack.set(dir, new Set());
        writtenBack.get(dir).add(tag);
      });
  }
}

// ---------- D. loop-ledger v3 管理圈 ----------
const loopRows = readCsv(join(SPEC, '109-loop-ledger/loop-ledger-v3.csv')) ?? [];
const loopPaths = new Set(loopRows.map(r => r.sourcePath));

// ---------- E. 库面全枚举 + frontmatter 字段完整性 ----------
const FIELDS = ['name', 'description', 'version', 'license', 'author', 'tags', 'complexity', 'compatibility', 'metadata'];
function fmKeys(text) {
  const lines = text.split('\n');
  if ((lines[0] ?? '').replace(/^\uFEFF/, '').trim() !== '---') return null;
  const keys = new Set(); let cont = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_.-]*):(.*)$/);
    if (m) { keys.add(m[1]); cont = /^[|>][-+]?\d*$/.test(m[2].trim()); }
    else if (!/^\s/.test(line)) cont = false;
  }
  return keys;
}
function fmGet(text, key) {
  const lines = text.split('\n');
  if ((lines[0] ?? '').replace(/^\uFEFF/, '').trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break;
    const m = lines[i].match(new RegExp(`^${key}:(\\s*(.*))$`));
    if (m) {
      const v = m[2].trim();
      if (/^[|>][-+]?\d*$/.test(v)) { let s = ''; for (let j = i + 1; j < lines.length; j++) { if (lines[j].trim() === '---' || (!/^\s/.test(lines[j]) && lines[j] !== '')) break; s += lines[j].trim() + ' '; } return s.trim(); }
      return v.replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

const allFiles = walk(LIB, '', []);
const skills = allFiles.filter(f => basename(f) === 'SKILL.md').sort();

const rows = skills.map(rel => {
  const abs = join(LIB, rel);
  let text = ''; try { text = readFileSync(abs, 'utf8'); } catch { }
  const dir = dirname(rel);
  const dirName = dir === '.' ? basename(rel, '.md') : basename(dir);
  const keys = fmKeys(text);
  const fmName = fmGet(text, 'name');
  const sc = byRel.get(rel);
  return {
    rel, dir, batch: rel.split('/')[0], dirName, fmName,
    inScreenScope: !!sc,
    descChars: sc ? sc.descriptionChars : (fmGet(text, 'description') ?? '').length,
    findings: sc ? sc.findings : null,
    severity: sc ? sc.severity : null,
    noFm: keys === null,
    missing: keys === null ? FIELDS.slice() : FIELDS.filter(f => !keys.has(f)),
    kebab: /^[a-z0-9]+(-[a-z0-9]+)*$/.test(dirName),
    nameMismatch: !!(fmName && fmName !== dirName),
    certified: certPaths.has(dir),
    writtenBack: writtenBack.has(dir),
    inLoop: loopPaths.has(rel),
    size: statSync(abs).size,
  };
});

const inScope = rows.filter(r => r.inScreenScope);
const assembly = rows.filter(r => !r.inScreenScope);

// ---------- F. 非技能资产 ----------
const archives = allFiles.filter(f => /\.(zip|tar|tgz|gz|7z|rar)$/i.test(f));
const looseMd = allFiles.filter(f => basename(f) !== 'SKILL.md' && f.toLowerCase().endsWith('.md'));
const topDirs = readdirSync(LIB, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);

// ---------- 汇总 ----------
function group(list) {
  const m = new Map();
  for (const r of list) {
    const g = m.get(r.batch) ?? { batch: r.batch, n: 0, cert: 0, wb: 0, loop: 0, noFm: 0, kebabBad: 0, nameMis: 0, d500: 0, d1024: 0, hi: 0, med: 0, low: 0, noVersion: 0, noLicense: 0, noAuthor: 0, noTags: 0, noComplexity: 0, noCompat: 0, never: [] };
    g.n++;
    if (r.certified) g.cert++;
    if (r.writtenBack) g.wb++;
    if (r.inLoop) g.loop++;
    if (r.noFm) g.noFm++;
    if (!r.kebab) g.kebabBad++;
    if (r.nameMismatch) g.nameMis++;
    if (r.descChars > 500) g.d500++;
    if (r.descChars > 1024) g.d1024++;
    if (r.severity === 'high') g.hi++;
    if (r.severity === 'medium') g.med++;
    if (r.severity === 'low') g.low++;
    if (r.missing.includes('version')) g.noVersion++;
    if (r.missing.includes('license')) g.noLicense++;
    if (r.missing.includes('author')) g.noAuthor++;
    if (r.missing.includes('tags')) g.noTags++;
    if (r.missing.includes('complexity')) g.noComplexity++;
    if (r.missing.includes('compatibility')) g.noCompat++;
    if (!r.certified && !r.writtenBack && !r.inLoop) g.never.push(r.dir);
    m.set(r.batch, g);
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}

const out = {
  generatedAt: new Date().toISOString(),
  totals: {
    filesWalked: allFiles.length,
    skillMdTotal: rows.length,
    inScreenScope: inScope.length,
    outsideScreenScope: assembly.length,
    roundStageDirs: roundDirs,
    distinctLibraryPathsEverJudged: certPaths.size,
    distinctSkillDirsEverWrittenBack: writtenBack.size,
    loopLedgerRows: loopRows.length,
    archives: archives.length,
    looseMd: looseMd.length,
    topDirs: topDirs.length,
    topDirsWithoutSkillMd: topDirs.filter(d => !rows.some(r => r.batch === d)),
    descOver500: inScope.filter(r => r.descChars > 500).length,
    descOver1024: inScope.filter(r => r.descChars > 1024).length,
    skillsWithFindings: inScope.filter(r => r.findings && r.findings.length).length,
    skillsNeverTouched: rows.filter(r => !r.certified && !r.writtenBack && !r.inLoop).length,
  },
  screenScopeBatches: group(inScope),
  assemblyBatches: group(assembly),
  archivesByBatch: archives.reduce((m, f) => { const b = f.split('/')[0]; m[b] = (m[b] ?? 0) + 1; return m; }, {}),
  looseMdByBatch: looseMd.reduce((m, f) => { const b = f.split('/')[0]; m[b] = (m[b] ?? 0) + 1; return m; }, {}),
  neverTouched: rows.filter(r => !r.certified && !r.writtenBack && !r.inLoop).map(r => ({ rel: r.dir, batch: r.batch, noFm: r.noFm, missing: r.missing, descChars: r.descChars })),
};
console.log(JSON.stringify(out, null, 1));
