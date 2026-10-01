import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokeObserver } from '../enabled-smoke.mjs';

/**
 * 105-017 批 T1-1：装配根离线发现与解析冒烟（零请求；不涉及 Sage）。
 * 1) 整根发现（期望 173＝172 目录＋1 平铺；深层模板 3 个不被发现）
 * 2) 逐项装载冒烟（名称→skill 工具装载→内容身份核对）
 * 3) 开关样本（disable-model-invocation / user-invocable 的实际观察，按窄图能力就低取证）
 * 4) V-08 夹具（悬空/循环/有效 symlink 的行为样本）
 * 产物：results JSON；不产生任何生产动作。
 *
 * 用法：node t1-assembly-smoke.mjs --root <装配根> --out <results.json> [--probe <yaml探针json>]
 */
const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i === -1 ? undefined : argv[i + 1]; };
const ROOT = flag('root');
const OUT = flag('out');
const PROBE = flag('probe');
if (!ROOT || !OUT) {
  process.stderr.write('Usage: node t1-assembly-smoke.mjs --root <dir> --out <json> [--probe <json>]\n');
  process.exit(2);
}

const entries = readdirSync(ROOT).filter(e => !e.startsWith('.')).sort();
const dirs = entries.filter(e => statSync(join(ROOT, e)).isDirectory());
const flats = entries.filter(e => e.endsWith('.md') && statSync(join(ROOT, e)).isFile());
const expectedNames = [...dirs, ...flats.map(f => f.replace(/\.md$/, ''))].sort();

const results = { at: new Date().toISOString(), root: ROOT, expected: { dirs: dirs.length, flats: flats.length, total: expectedNames.length } };

// —— 1) 整根发现 ——
const anchor = dirs[0];
const discovery = await smokeObserver({ skillId: anchor, root: join(ROOT, anchor) });
const discovered = (discovery.discovered ?? []).slice().sort();
results.discovery = {
  anchor, discoveredCount: discovered.length,
  missing: expectedNames.filter(n => !discovered.includes(n)),
  unexpected: discovered.filter(n => !expectedNames.includes(n)),
  deepTemplateLeak: discovered.filter(n => ['minimal-skill', 'standard-skill', 'complex-skill'].includes(n)),
  ok: discovered.length === expectedNames.length &&
      expectedNames.every(n => discovered.includes(n)) &&
      discovered.every(n => expectedNames.includes(n)),
};
console.log(`[T1-1] 发现：${discovered.length}/${expectedNames.length} ok=${results.discovery.ok}`);

// —— 2) 逐项装载 ——
const perItem = [];
let done = 0;
for (const name of expectedNames) {
  const isFlat = flats.some(f => f.replace(/\.md$/, '') === name);
  const file = isFlat ? flats.find(f => f.replace(/\.md$/, '') === name) : null;
  const root = isFlat ? join(ROOT, file) : join(ROOT, name);
  const entry = isFlat ? '' : 'SKILL.md';   // 平铺件：root 即文件，entry 留空 ⇒ join(root,'')=root
  const t0 = Date.now();
  const r = await smokeObserver({ skillId: name, root, entry });
  perItem.push({
    name, isFlat, ok: r.ok === true, detail: r.detail,
    ms: Date.now() - t0,
    summaryFields: r.summary ? Object.keys(r.summary).sort() : null,
    summary: r.summary ?? null,
  });
  done += 1;
  if (done % 25 === 0) console.log(`[T1-1] 装载 ${done}/${expectedNames.length}…`);
}
const failItems = perItem.filter(x => !x.ok);
results.perItem = { count: perItem.length, okCount: perItem.length - failItems.length,
  fails: failItems.map(x => ({ name: x.name, detail: x.detail })),
  items: perItem.map(x => ({ name: x.name, isFlat: x.isFlat, ok: x.ok, ms: x.ms, summaryFields: x.summaryFields, summary: x.summary })) };
console.log(`[T1-1] 装载：${results.perItem.okCount}/${results.perItem.count}，失败 ${failItems.length}`);

// —— 3) 开关样本 ——
let switchNames = { disable: [], userInvocable: [] };
if (PROBE) {
  try {
    const probe = JSON.parse(readFileSync(PROBE, 'utf8'));
    for (const item of probe.items) {
      const sw = item.switches || {};
      if (Object.prototype.hasOwnProperty.call(sw, 'disable-model-invocation')) switchNames.disable.push(item.dir.replace(/\.md$/, ''));
      if (Object.prototype.hasOwnProperty.call(sw, 'user-invocable')) switchNames.userInvocable.push(item.dir.replace(/\.md$/, ''));
    }
  } catch (e) { results.switchNotes = [`probe read failed: ${e.message}`]; }
}
results.switches = { names: switchNames, samples: perItem.filter(x => switchNames.disable.includes(x.name) || switchNames.userInvocable.includes(x.name)).map(x => ({ name: x.name, ok: x.ok, summaryFields: x.summaryFields, summary: x.summary, detail: x.detail })) };
console.log(`[T1-1] 开关样本：disable=${switchNames.disable.length} user-invocable=${switchNames.userInvocable.length}`);

// —— 4) V-08 夹具 ——
const fixture = mkdtempSync(join(tmpdir(), 't1-symlink-'));
try {
  mkdirSync(join(fixture, 'normal-item'));
  writeFileSync(join(fixture, 'normal-item', 'SKILL.md'), '---\nname: normal-item\ndescription: fixture\n---\n\nbody\n');
  symlinkSync(join(fixture, 'missing-target'), join(fixture, 'dangling-item'));      // 悬空
  symlinkSync(join(fixture, 'cyc-b'), join(fixture, 'cyc-a'));                        // 循环
  symlinkSync(join(fixture, 'cyc-a'), join(fixture, 'cyc-b'));
  symlinkSync(join(fixture, 'normal-item'), join(fixture, 'alias-item'));             // 有效指向
  const r = await smokeObserver({ skillId: 'normal-item', root: join(fixture, 'normal-item') });
  results.fixtureV08 = {
    ok: r.ok === true,
    discovered: (r.discovered ?? []).slice().sort(),
    detail: r.detail,
    note: '夹具为机制样本（本库全树 0 symlink）；悬空/循环是否被忽略或报错以本读数记录',
  };
  console.log(`[T1-1] 夹具：ok=${r.ok} discovered=${JSON.stringify(results.fixtureV08.discovered)}`);
} catch (e) {
  results.fixtureV08 = { ok: false, detail: `FIXTURE_ERROR: ${e.message}` };
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(results, null, 1)}\n`);
console.log(JSON.stringify({ discovery: results.discovery.ok, perItemOk: results.perItem.okCount, perItemTotal: results.perItem.count, fixture: results.fixtureV08.ok, out: OUT }));
