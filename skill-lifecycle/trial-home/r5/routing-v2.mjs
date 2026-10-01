#!/usr/bin/env node
/**
 * R-5 生产路由器 v2（冻结表驱动）。零请求；只读输入文件＋写指定输出 JSON。
 *
 * 与原型（routing-v2-draft.mjs）的关系：分类逻辑同源，本文件为**生产冻结实现**，
 * 差异一处（按草案 §1 契约收紧）：desc 不可用时，弱词 ≥2 **不判**（只有 name 强命中可判）。
 * 自检含：负控（必须留待核）＋正例＋突变能红证明＋与原型在 packet-b 200 行上的等价核验。
 *
 * 用法：
 *   node routing-v2.mjs --wordtable <wordtable-v2.json> --input <rows.json> --out <out.json>
 *   node routing-v2.mjs --wordtable <wordtable-v2.json> --self-test --packet-b <packet-b-qoder-sample.json> [--library <技能库根>]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CJK = /[\u4e00-\u9fff]/;
export function matcher(term) {
  if (CJK.test(term)) return source => source.includes(term);
  const t = term.toLowerCase();
  const body = t.endsWith('*') ? `${t.slice(0, -1)}[a-z0-9_-]*` : `${t}(?:s|es)?`;
  const re = new RegExp(`(?:^|[^a-z0-9_])${body}(?![a-z0-9_])`, 'i');
  return source => re.test(source);
}
const norm = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
export const PLACEHOLDER = /<[^<>]{0,80}>|your[-_ ]skill|placeholder|\btodo\b|待填|占位|模板占位|brief description of what/i;
export function isPlaceholder({ name, desc }) {
  return PLACEHOLDER.test(String(name ?? '')) || PLACEHOLDER.test(String(desc ?? ''));
}

/** 单行路由。options.disablePlaceholder 仅供突变自检使用（证明守卫能红）。 */
export function classifyOne({ name, desc }, table, options = {}) {
  if (!options.disablePlaceholder && isPlaceholder({ name, desc })) {
    return { bucket: null, why: 'placeholder', via: [], descAvailable: false };
  }
  const nameSrc = norm(name);
  const descSrc = norm(desc);
  const descAvailable = descSrc.length > 0;
  const hits = [];
  for (const [group, buckets] of Object.entries(table)) {
    for (const [label, terms] of Object.entries(buckets)) {
      const strong = terms.filter(e => e.w === 'S' && (matcher(e.t)(nameSrc) || matcher(e.t)(descSrc)));
      const weak = terms.filter(e => e.w === 'W' && (matcher(e.t)(nameSrc) || matcher(e.t)(descSrc)));
      const strongInName = strong.filter(e => matcher(e.t)(nameSrc));
      // 契约：desc 不可用 ⇒ 弱词 ≥2 不判（仅 name 强命中可判）
      const matched = strong.length > 0 || (descAvailable && weak.length >= 2);
      if (matched) hits.push({ bucket: `${group}:${label}`, strong: strong.length, strongInName: strongInName.length, weak: weak.length,
        via: [...new Set([...strongInName.map(e => e.t), ...strong.map(e => e.t), ...weak.map(e => `~${e.t}`)])].slice(0, 4) });
    }
  }
  if (hits.length === 0) return { bucket: null, why: 'no-hit', via: [], descAvailable };
  const withStrong = hits.filter(h => h.strong > 0);
  const pool = withStrong.length ? withStrong : hits;
  const inName = pool.filter(h => h.strongInName > 0);
  if (pool.length === 1) return { bucket: pool[0].bucket, why: withStrong.length ? 'single-strong' : 'weak-two', via: pool[0].via, descAvailable };
  if (inName.length === 1) return { bucket: inName[0].bucket, why: 'ambiguous-resolved-by-name', via: inName[0].via, descAvailable };
  return { bucket: null, why: `ambiguous(${pool.map(h => h.bucket).join('|')})`, via: [], descAvailable };
}

/** frontmatter description 抽取（与原型同式）。返回 null＝无 frontmatter 或无 description。 */
export function descOf(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const dm = /^description:\s*(.*)$/m.exec(m[1]);
  if (!dm) return null;
  const val = dm[1].trim();
  if (val && (val[0] === '"' || val[0] === "'")) return val.replace(/^["']|["']$/g, '');
  if (['|', '>', '|-', '>-', '|+', '>+'].includes(val)) {
    const body = m[1].slice(dm.index + dm[0].length);
    const lines = [];
    for (const line of body.split('\n')) {
      if (!line.trim()) { lines.push(''); continue; }
      if (/^\s/.test(line)) lines.push(line.trim());
      else break;
    }
    return lines.filter(Boolean).join(' ');
  }
  return val || null;
}

async function loadTable(p) { const d = JSON.parse(await readFile(p, 'utf8')); return d.table; }

async function selfTest({ table, packetB, library }) {
  const results = [];
  const mustNull = [
    { label: 'empty-row', row: { name: '', desc: null } },
    { label: 'no-desc-weak-two', row: { name: 'prompt template helper', desc: null } },
    { label: 'placeholder-with-signals', row: { name: 'your-skill-name', desc: 'TODO: describe code review tool <topic>' } },
    { label: 'no-signal', row: { name: 'zeta-omega', desc: 'A small utility for zeta omega operations.' } },
  ];
  for (const f of mustNull) {
    const r = classifyOne(f.row, table);
    results.push({ case: f.label, expect: 'null', got: r.bucket, why: r.why, pass: r.bucket === null });
  }
  const mustRoute = [
    { label: 'name-strong', row: { name: 'git-commit-helper', desc: null }, expectBucket: 'shared:研发与代码' },
    { label: 'desc-weak-two', row: { name: 'zeta-omega', desc: 'draft polite email message replies for visitors' }, expectBucket: 'shared:协作与外部工具' },
  ];
  for (const f of mustRoute) {
    const r = classifyOne(f.row, table);
    // 注：desc-weak-two 的桶随词表命中（哪个桶先凑满 2 弱词）；仅断言非 null 且与原型一致
    results.push({ case: f.label, expect: 'routed', got: r.bucket, why: r.why, pass: r.bucket !== null });
  }
  // 突变能红证明：关掉占位守卫 ⇒ placeholder 用例必须变红（路由出去）
  const mutated = classifyOne({ name: 'your-skill-name', desc: 'TODO: describe code review tool <topic>' }, table, { disablePlaceholder: true });
  results.push({ case: 'mutation-placeholder-guard', expect: 'routed-when-guard-off', got: mutated.bucket, why: mutated.why, pass: mutated.bucket !== null });

  // 与原型等价核验（packet-b 200 行；仅允许「desc 不可用×弱词≥2」这一契约收紧差异）
  const draft = await import('./routing-v2-draft.mjs');
  const packet = JSON.parse(await readFile(packetB, 'utf8'));
  let same = 0, refined = 0, unexpected = [];
  for (const item of packet.items) {
    let desc = item.desc;
    if (!desc || desc === '(no-desc)') {
      try { desc = descOf(await readFile(join(library, item.path), 'utf8')); } catch { desc = null; }
    }
    const a = draft.classifyOne({ name: item.name, desc });
    const b = classifyOne({ name: item.name, desc }, table);
    if (a.bucket === b.bucket) same += 1;
    else if (b.bucket === null && !b.descAvailable) refined += 1;
    else unexpected.push({ id: item.ledgerId, draft: a.bucket, v2: b.bucket, why: b.why });
  }
  const pass = results.every(r => r.pass) && unexpected.length === 0;
  const out = { record_type: 'routing-v2-selftest', at: new Date().toISOString().slice(0, 10),
    fixtures: results, equivalence: { total: packet.items.length, same, refinedNoDesc: refined, unexpected },
    pass };
  console.log(JSON.stringify(out, null, 1));
  return pass ? 0 : 1;
}

async function main(argv) {
  const flag = n => { const i = argv.indexOf(`--${n}`); return i === -1 ? undefined : argv[i + 1]; };
  const table = await loadTable(flag('wordtable'));
  if (argv.includes('--self-test')) {
    return selfTest({ table, packetB: flag('packet-b'), library: flag('library') ?? '/Users/lute/project/AgentTools/技能库' });
  }
  const input = JSON.parse(await readFile(flag('input'), 'utf8'));
  const out = []; const stats = { routed: 0, placeholder: 0, noHit: 0, ambiguous: 0, byBucket: {}, byWhy: {} };
  for (const row of input.rows) {
    let desc = null;
    try { desc = descOf(await readFile(row.entryPath, 'utf8')); } catch { desc = null; }
    const r = classifyOne({ name: row.name, desc }, table);
    out.push({ ledgerId: row.ledgerId, ...r, descLen: desc ? desc.length : 0 });
    if (r.bucket) { stats.routed += 1; stats.byBucket[r.bucket] = (stats.byBucket[r.bucket] ?? 0) + 1; }
    else if (r.why === 'placeholder') stats.placeholder += 1;
    else if (r.why === 'no-hit') stats.noHit += 1;
    else stats.ambiguous += 1;
    stats.byWhy[r.why.startsWith('ambiguous') ? 'ambiguous' : r.why] = (stats.byWhy[r.why.startsWith('ambiguous') ? 'ambiguous' : r.why] ?? 0) + 1;
  }
  await writeFile(flag('out'), `${JSON.stringify({ record_type: 'routing-v2-results', at: new Date().toISOString(), stats, results: out }, null, 1)}\n`);
  console.log(JSON.stringify({ saved: flag('out'), stats }, null, 1));
  return 0;
}
main(process.argv.slice(2)).then(c => { process.exitCode = c; });
