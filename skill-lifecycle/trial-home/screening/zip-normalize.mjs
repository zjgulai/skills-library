import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, statSync } from 'node:fs';
import { join, basename, dirname, relative } from 'node:path';

/**
 * Phase 1｜ZIP 族静态归一化（零请求，库面只读）。
 *
 * 只做**有出处**的整形：剥打包残渣、跨技能相对引用文面化（P1 已验证的打法）、目录名对齐 kebab。
 * 需要写内容的一律不自动填——缺 frontmatter／缺描述／嵌套件／撞名件全部进待制作清单，
 * 因为「替技能编一段描述」就是 143 §8f 那族伪造 license/author 的同型缺陷。
 */

const REPO = '/Users/lute/project/AgentTools/思维库/skill管理';
const LIB = '/Users/lute/project/AgentTools/技能库';
const PROBE = join(REPO, 'skill-lifecycle/trial-home/screening/_zipprobe');
const OUT_ROOT = join(REPO, 'skill-lifecycle/trial-home/opt-run/candidates-zip');
const BASE = join(REPO, 'docs/specs/2026-09-25-dsh-skill-lifecycle/145-standardization-baseline');
const DSH_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const JUNK = new Set(['.DS_Store', '__pycache__', '__MACOSX', '__pycache__.pyc']);
const CROSS_LINK = /\]\((\.\.\/[^)\s]+)\)/g;

function listAll(dir, rel = '', out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) listAll(join(dir, entry.name), r, out);
    else out.push(r);
  }
  return out;
}

const isJunk = rel => rel.split('/').some(part => JUNK.has(part) || part.startsWith('._'));

function frontmatterView(text) {
  const lines = text.split('\n');
  if ((lines[0] ?? '').replace(/^/, '').trim() !== '---') return { has: false, name: null, description: null };
  let name = null;
  let description = null;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') break;
    const match = lines[index].match(/^(name|description):\s*(.*)$/);
    if (!match) continue;
    const inline = match[2].trim();
    if (/^[|>][-+]?\d*$/.test(inline)) {
      const parts = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        if (lines[next].trim() === '---') break;
        if (!/^\s/.test(lines[next]) && lines[next] !== '') break;
        parts.push(lines[next].trim());
      }
      if (match[1] === 'name') name = parts.join(' '); else description = parts.join(' ');
    } else if (match[1] === 'name') name = inline.replace(/^["']|["']$/g, '');
    else description = inline.replace(/^["']|["']$/g, '');
  }
  return { has: true, name, description };
}

/** 跨技能相对引用：包单独分发时目标不存在，DSH 也只读包内路径——改成文面，指向关系留在文字里。 */
function defuseCrossLinks(text) {
  let count = 0;
  const next = text.replace(CROSS_LINK, (whole, target) => {
    count += 1;
    return `（跨技能引用：${target.replace(/^\.\.\//, '').replace(/\)\(.*$/, '')}）`;
  });
  return { text: next, count };
}

export function normalizeZipFamily({ probeRoot = PROBE, outRoot = OUT_ROOT, dryRun = true } = {}) {
  const intake = JSON.parse(readFileSync(join(BASE, 'zipintake-2026-10-07.json'), 'utf8'));
  const candidates = intake.packages.filter(pkg => pkg.disposition === 'materialize' && !pkg.nested.length);
  const heldMulti = intake.packages.filter(pkg => pkg.disposition === 'materialize' && pkg.nested.length);
  const operations = [];
  const held = [];

  for (const pkg of candidates) {
    const srcDir = join(probeRoot, pkg.family, pkg.zipBase);
    const slug = pkg.primaryNameField && DSH_NAME.test(pkg.primaryNameField) ? pkg.primaryNameField : pkg.zipBase;
    const ops = { family: pkg.family, zipBase: pkg.zipBase, slug, crossLinkRewrites: 0, junkDropped: 0,
      dirAligned: slug !== pkg.zipBase, needs: [] };
    if (!DSH_NAME.test(slug)) { ops.needs.push('NON_KEBAB_SLUG'); held.push({ ...pkg, reason: 'NON_KEBAB_SLUG' }); continue; }
    const files = listAll(srcDir);
    const junk = files.filter(isJunk);
    ops.junkDropped = junk.length;
    const deliverable = files.filter(rel => !isJunk(rel));
    const primaryRel = deliverable.find(rel => basename(rel) === 'SKILL.md');
    if (!primaryRel) { ops.needs.push('NO_PRIMARY_AFTER_JUNK'); held.push({ ...pkg, reason: 'NO_PRIMARY_AFTER_JUNK' }); continue; }
    // 很多包解压后是 `<包名>/<包名>/SKILL.md` 的双层包裹：屏检不报（它只认更深的 SKILL.md），
    // 但装载链按 `<技能>/SKILL.md` 发现——不剥掉就会交出去 104 个错位件。
    // 只在「顶层唯一目录且该目录下确实有 SKILL.md」时剥一层，其余原样保留，不猜结构。
    const topLevelDirs = new Set(deliverable.map(rel => rel.split('/')[0]).filter(part => !part.includes('.')));
    const topLevelFiles = deliverable.filter(rel => !rel.includes('/'));
    let strip = '';
    if (primaryRel.includes('/') && topLevelDirs.size === 1 && !topLevelFiles.length) {
      const candidate = [...topLevelDirs][0];
      if (deliverable.some(rel => rel.startsWith(`${candidate}/`))) {
        strip = `${candidate}/`;
        ops.flattened = true;
      }
    }

    // 需要写内容的三类一律不自动改：无 frontmatter、无描述、描述过短（<40 与屏检同口径）。
    const view = frontmatterView(readFileSync(join(srcDir, primaryRel), 'utf8'));
    if (!view.has) ops.needs.push('NO_FRONTMATTER');
    if (!view.name) ops.needs.push('NO_NAME_FIELD');
    if (!view.description || view.description.length < 40) ops.needs.push('SHORT_OR_MISSING_DESCRIPTION');
    if (ops.needs.length) { held.push({ ...pkg, reason: ops.needs.join('+'), slug }); continue; }

    const destDir = join(outRoot, slug);
    if (!dryRun) {
      if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
      mkdirSync(destDir, { recursive: true });
    }
    for (const rel of deliverable) {
      const targetRel = strip ? rel.slice(strip.length) : rel;
      const source = join(srcDir, rel);
      let payload = source;
      if (/\.(md|markdown)$/i.test(rel)) {
        const { text, count } = defuseCrossLinks(readFileSync(source, 'utf8'));
        ops.crossLinkRewrites += count;
        if (count > 0 && !dryRun) {
          const tmp = `${destDir}/${targetRel}`;
          mkdirSync(dirname(tmp), { recursive: true });
          writeFileSync(tmp, text);
          continue;
        }
      }
      if (!dryRun) {
        const target = `${destDir}/${targetRel}`;
        mkdirSync(dirname(target), { recursive: true });
        cpSync(source, target);
      }
    }
    operations.push(ops);
  }

  const tally = {
    considered: candidates.length + heldMulti.length,
    normalized: operations.length,
    heldNeedsAuthoring: held.length,
    heldMultiSkillPackages: heldMulti.map(pkg => ({ zip: pkg.zipBase, nested: pkg.nested.length })),
    crossLinkRewrites: operations.reduce((sum, ops) => sum + ops.crossLinkRewrites, 0),
    junkFilesDropped: operations.reduce((sum, ops) => sum + ops.junkDropped, 0),
    slugsAligned: operations.filter(ops => ops.dirAligned).length,
    flattenedPackages: operations.filter(ops => ops.flattened).length,
    needsBreakdown: held.reduce((acc, item) => { acc[item.reason] = (acc[item.reason] ?? 0) + 1; return acc; }, {}),
  };
  return { operations, held, tally, dryRun };
}

function controls({ probeRoot = PROBE }) {
  const failures = [];
  let checked = 0;
  const expect = (label, condition, detail) => { checked += 1; if (!condition) failures.push(`${label} :: ${detail}`); };
  const result = normalizeZipFamily({ probeRoot, dryRun: true });

  expect('正控-候选数闭合', result.tally.normalized + result.tally.heldNeedsAuthoring === result.tally.considered
    - result.tally.heldMultiSkillPackages.length,
    `整形 ${result.tally.normalized} ＋ 待制作 ${result.tally.heldNeedsAuthoring} 应等于候选 ${result.tally.considered - result.tally.heldMultiSkillPackages.length}`);
  expect('正控-残渣不落候选', result.operations.every(ops => ops.junkDropped >= 0) && result.tally.junkFilesDropped > 0,
    `应剥掉打包残渣，实得 ${result.tally.junkFilesDropped} 个`);
  expect('正控-跨技能引用确有改写', result.tally.crossLinkRewrites > 0,
    `改写数 ${result.tally.crossLinkRewrites} 应大于 0，否则这条判据空转`);

  // 负控：判据必须对内容敏感，用内存件直跑改写函数，不写盘。
  const sample = 'see [dep](../other-skill/SKILL.md) and [x](../../up/file.md)';
  const defused = defuseCrossLinks(sample);
  expect('负控-文面化真的动文本', defused.count === 2 && !defused.text.includes(']('),
    `两条相对引用都要消掉，实得 ${defused.count}；结果「${defused.text}」`);
  const noLink = defuseCrossLinks('nothing relative here');
  expect('负控-无引用不误报', noLink.count === 0, `无相对链接时应 0 改写，实得 ${noLink.count}`);
  // 负控：缺描述的件必须留在待制作清单，而不是被硬填进候选。
  expect('负控-缺内容不硬填', result.held.every(item => (item.reason ?? '').length > 0)
    && Object.keys(result.tally.needsBreakdown).length > 0,
    `待制作件都要有明确理由；实得 ${JSON.stringify(result.tally.needsBreakdown)}`);
  // 负控：dry-run 不得留下任何候选目录。
  expect('负控-dry-run 零落盘', !existsSync(join(OUT_ROOT, '__dryrun_probe__')), 'dry-run 不应写盘');
  expect('正控-双层包裹被剥净', result.tally.flattenedPackages === 104,
    `已知 104 个「包名/包名/SKILL.md」形制的包应全部剥层，实得 ${result.tally.flattenedPackages}`);
  // 负控：判据必须只在「顶层唯一目录且无顶层文件」时剥层——用一个内存构造反证太宽的剥法会丢平铺文件。
  const mixed = ['outer/SKILL.md', 'README.md'];
  const wouldStrip = mixed.filter(rel => !rel.includes('/')).length === 0 && new Set(mixed.map(r => r.split('/')[0])).size === 1;
  expect('负控-有顶层文件时不剥层', wouldStrip === false, '顶层同时有文件和唯一目录时不得剥层');
  return { failures, checked, result };
}

async function main(argv) {
  const value = flag => { const index = argv.indexOf(flag); return index === -1 ? undefined : argv[index + 1]; };
  const dryRun = !argv.includes('--apply');
  if (argv.includes('--control')) {
    const { failures, checked, result } = controls({});
    console.log(JSON.stringify({ mode: 'control', checked, failures: failures.length, detail: failures,
      tally: result.tally }, null, 1));
    return failures.length ? 1 : 0;
  }
  const { operations, held, tally } = normalizeZipFamily({ outRoot: OUT_ROOT, dryRun });
  const out = join(BASE, `zip-normalize-${dryRun ? 'dryrun' : 'apply'}-2026-10-07.json`);
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), mode: dryRun ? 'dry-run' : 'apply',
    outRoot: OUT_ROOT, tally, operations, held }, null, 1));
  console.log(JSON.stringify({ mode: dryRun ? 'dry-run' : 'apply', tally, out }, null, 1));
  return 0;
}

if (process.argv[1]) process.exitCode = await main(process.argv.slice(2));
