import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { smokeObserver } from '../enabled-smoke.mjs';

/**
 * 通用 L5 装载核验（零出境）：把库内实物经 DSH 原生链路
 * （skill-registry + filesystem(watch:false) + tool-skill）装载，核对 served 正文与盘上正文的字节身份。
 *
 * 用法：
 *   node repair-load-check-121.mjs --library <技能库根> --out <results.json> [--names a,b,c]
 *        [--ledger <109 台账 csv>] [--subdir <rel>]
 *   - 缺省 names＝R-1 六件、subdir＝81-Skills；
 *   - 给 --ledger 时按台账 sourcePath 解析每件的根与入口（支持子目录件与平铺 .md：平铺 root=文件、entry=''）。
 */
const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i === -1 ? undefined : argv[i + 1]; };
const LIB = flag('library');
const OUT = flag('out');
const SUB = flag('subdir') ?? '81-Skills';
const LEDGER = flag('ledger');
const NAMES = (flag('names') ?? 'skill-evaluator,platform-price-monitor,geo-optimizer,llm-tech-research,ecommerce-monthly-review,performance-tracking')
  .split(',').map(s => s.trim()).filter(Boolean);
if (!LIB || !OUT) {
  process.stderr.write('Usage: node repair-load-check-121.mjs --library <dir> --out <json> [--names a,b,c] [--ledger <109 csv>] [--subdir <rel>]\n');
  process.exit(2);
}

async function resolveLedger(names) {
  const text = (await readFile(LEDGER, 'utf8')).replace(/^\ufeff/, '');
  const splitCsv = line => {
    const cells = []; let cur = ''; let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells;
  };
  const lines = text.split('\n').filter(l => l.length);
  const header = splitCsv(lines[0]);
  const nameIdx = header.indexOf('name');
  const pathIdx = header.indexOf('sourcePath');
  if (nameIdx === -1 || pathIdx === -1) throw new Error('109 台账缺 name/sourcePath 列');
  const byName = new Map();
  for (const line of lines.slice(1)) {
    const cells = splitCsv(line);
    byName.set(cells[nameIdx], cells[pathIdx]);
  }
  const out = [];
  for (const name of names) {
    const sourcePath = byName.get(name);
    if (!sourcePath) throw new Error(`台账缺件：${name}`);
    if (sourcePath.endsWith('/SKILL.md')) {
      out.push({ name, root: join(LIB, sourcePath.replace(/\/SKILL.md$/, '')), entry: 'SKILL.md' });
    } else {
      out.push({ name, root: join(LIB, sourcePath), entry: '' }); // 平铺件：root 即文件
    }
  }
  return out;
}

const targets = LEDGER ? await resolveLedger(NAMES)
  : NAMES.map(name => ({ name, root: join(LIB, SUB, name), entry: 'SKILL.md' }));

const results = { record_type: 'l5-load-check', at: new Date().toISOString(), library: LIB,
  resolvedFrom: LEDGER ? `ledger:${LEDGER}` : `subdir:${SUB}`, items: [] };
let okCount = 0;
for (const { name, root, entry } of targets) {
  const r = await smokeObserver({ skillId: name, root, entry });
  const ok = r.ok === true;
  if (ok) okCount += 1;
  results.items.push({ name, ok, detail: r.detail, discoveredCount: (r.discovered ?? []).length });
  console.log(`[L5] ${name}: ${ok ? 'PASS' : 'FAIL'} — ${String(r.detail).slice(0, 110)}`);
}
results.summary = { total: targets.length, okCount, allPass: okCount === targets.length };
await writeFile(OUT, `${JSON.stringify(results, null, 1)}\n`);
console.log(`[L5] ${okCount}/${targets.length} PASS → ${OUT}`);
process.exitCode = results.summary.allPass ? 0 : 1;
