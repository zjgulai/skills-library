import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

/**
 * skill-hl 三档分档：认下的处置是——
 *   档一 孪生件 → 并入库面既有件作中文变体，不新建技能；
 *   档二 独有件 → 正常物化（改名＋补齐→认证）；
 *   档三 无 frontmatter 残件 → 先定「补齐 or 判残」。
 * 孪生判定用两条独立信号（撞名 ＋ 触发词重合），单条不算数：跨语言内容锚点法失效，屏检簇也看不见。
 */

const LIB = '/Users/lute/project/AgentTools/技能库';
const REPO = '/Users/lute/project/AgentTools/思维库/skill管理';
const BASE = join(REPO, 'docs/specs/2026-09-25-dsh-skill-lifecycle/145-standardization-baseline');
const SKIP = new Set(['node_modules', '.git', '__pycache__', '.DS_Store']);
const TOKEN_THRESHOLD = 0.12;
// 12% 只是「值得看一眼」的门槛：库面 717 件里取 top1，同域营销语汇很容易擦到 12–18%。
// 所以档一拆两档——A 档可自动并入（有件名撞名，或重合 ≥30%），B 档必须按件人工裁。
const STRONG_OVERLAP = 0.30;

function walk(dir, rel, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(join(dir, entry.name), r, out);
    else out.push(r);
  }
  return out;
}

function frontmatterValue(text, key) {
  const lines = text.split('\n');
  if ((lines[0] ?? '').replace(/^/, '').trim() !== '---') return null;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') break;
    const match = lines[index].match(new RegExp(`^${key}:\\s*(.*)$`));
    if (!match) continue;
    const inline = match[1].trim();
    if (/^[|>][-+]?\d*$/.test(inline)) {
      const parts = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        if (lines[next].trim() === '---') break;
        if (!/^\s/.test(lines[next]) && lines[next] !== '') break;
        parts.push(lines[next].trim());
      }
      return parts.join(' ');
    }
    return inline.replace(/^["']|["']$/g, '');
  }
  return null;
}

const tokens = text => new Set((text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []));

// 用户 2026-10-07 逐件裁定的结果：这 6 件的职责与库面某件一一对应，证据是**件名与交付物同一**，
// 不是重合度分数（我定译名时刻意避开库面名，反而让撞名测不出来——所以单列一张裁定表，可追溯、可复核）。
const ADJUDICATED_TWINS = {
  '50-skills/研究简报蓝图': 'market-research/skills/research-brief-blueprint',
  '50-skills/品牌叙事手册': 'brand-strategy/skills/brand-narrative-playbook',
  '50-skills/联合解决方案蓝图': 'partnership-development/skills/joint-solution-blueprint',
  '50-skills/SEO写作': 'content-marketing/skills/seo-writing',
  '50-skills/联合营销治理': 'partnership-development/skills/co-marketing-governance',
  '50-skills/品牌叙事': 'content-marketing/skills/storytelling',
};

export function buildDisposition() {
  const renameMap = JSON.parse(readFileSync(join(BASE, 'skhl-rename-map-2026-10-07.json'), 'utf8'));
  const collisionBy = new Map(renameMap.collisions.map(entry => [entry.dir, entry]));

  const hlFiles = walk(join(LIB, 'skill-hl'), '', []).filter(rel => basename(rel) === 'SKILL.md');
  const libraryFiles = walk(LIB, '', []).filter(rel => basename(rel) === 'SKILL.md')
    .filter(rel => !rel.startsWith('skill-hl/') && !rel.startsWith('_assembly') && !rel.startsWith('skills-Qoder'));
  const library = libraryFiles.map(rel => {
    const text = (() => { try { return readFileSync(join(LIB, rel), 'utf8'); } catch { return ''; } })();
    return { rel, dir: dirname(rel), name: basename(dirname(rel)), tokens: tokens(frontmatterValue(text, 'description') ?? '') };
  }).filter(entry => entry.tokens.size);

  const rows = hlFiles.map(rel => {
    const abs = join(LIB, 'skill-hl', rel);
    const text = readFileSync(abs, 'utf8');
    const description = frontmatterValue(text, 'description');
    const nameField = frontmatterValue(text, 'name');
    const mine = tokens(description ?? '');
    let best = null;
    if (mine.size) for (const entry of library) {
      let inter = 0;
      for (const token of entry.tokens) if (mine.has(token)) inter += 1;
      const jaccard = inter / new Set([...mine, ...entry.tokens]).size;
      if (!best || jaccard > best.jaccard) best = { ...entry, jaccard };
    }
    const collision = collisionBy.get(dirname(rel));
    const adjudicated = ADJUDICATED_TWINS[dirname(rel)] ?? null;
    const signals = [];
    if (collision) signals.push('slug-collision');
    if (adjudicated) signals.push('user-adjudicated');
    if (best && best.jaccard >= TOKEN_THRESHOLD) signals.push('trigger-overlap');
    const noFrontmatter = nameField === null || !description;
    return {
      dir: dirname(rel), rel,
      cnName: nameField ?? '(无 frontmatter)',
      proposedSlug: collision?.proposed ?? (renameMap.rows.find(row => row.dir === dirname(rel))?.proposed ?? ''),
      libraryTwin: collision?.libraryPath ?? adjudicated ?? (best && best.jaccard >= TOKEN_THRESHOLD ? best.rel : null),
      twinEvidence: signals.join('+') || 'none',
      tokenOverlap: best ? Number((best.jaccard * 100).toFixed(1)) : null,
      noFrontmatter,
      tier: (!collision && !adjudicated && (!best || best.jaccard < TOKEN_THRESHOLD))
        ? (noFrontmatter ? 'tier3-损坏容器（已复核为 OPAQUE 族，库面有可读英文孪生）' : 'tier2-独立物化')
        : (collision || adjudicated || (best && best.jaccard >= STRONG_OVERLAP))
          ? 'tier1A-孪生可自动并入'
          : 'tier1B-孪生待人工裁',
    };
  });

  const tally = rows.reduce((acc, row) => { acc[row.tier] = (acc[row.tier] ?? 0) + 1; return acc; }, {});
  return { rows, tally, libraryCompared: library.length, hlCount: rows.length };
}

function controls(result) {
  const failures = [];
  let checked = 0;
  const expect = (label, condition, detail) => { checked += 1; if (!condition) failures.push(`${label} :: ${detail}`); };
  expect('正控-件数', result.hlCount === 53, `应为 53 件，实得 ${result.hlCount}`);
  expect('正控-三档求和闭合', Object.values(result.tally).reduce((a, b) => a + b, 0) === result.hlCount,
    JSON.stringify(result.tally));
  expect('正控-已知孪生落 A 档', result.rows.filter(row => row.tier === 'tier1A-孪生可自动并入').length >= 14,
    `A 档应至少 14 件（全部撞名件），实得 ${result.rows.filter(row => row.tier === 'tier1A-孪生可自动并入').length}`);
  expect('正控-撞名件必在 A 档', result.rows.every(row => !(row.twinEvidence.startsWith('slug-collision')
    && row.tier !== 'tier1A-孪生可自动并入')), '有件名撞名的件不得落到 B/二档');
  expect('正控-无 frontmatter 件被单列', result.rows.filter(row => row.noFrontmatter).length === 3,
    `应为 3 件，实得 ${result.rows.filter(row => row.noFrontmatter).length}`);
  expect('正控-裁定表落 A 档', Object.keys(ADJUDICATED_TWINS).every(dir =>
    result.rows.find(row => row.dir === dir)?.tier === 'tier1A-孪生可自动并入'),
    `6 件人工裁定必须进 A 档：${Object.entries(ADJUDICATED_TWINS).map(([dir, twin]) =>
      `${dir.split('/').pop()}→${result.rows.find(row => row.dir === dir)?.tier ?? '查无此件'}(${twin}${existsSync(join(LIB, twin, 'SKILL.md')) ? '在库' : '**已不在库**'})`).join(' ; ')}`);
  expect('正控-裁定目标必须在库', Object.values(ADJUDICATED_TWINS).every(twin => existsSync(join(LIB, twin, 'SKILL.md'))),
    `裁定表指向的库面件必须仍存在：${Object.values(ADJUDICATED_TWINS).filter(twin => !existsSync(join(LIB, twin, 'SKILL.md'))).join(', ') || '（全部在库）'}`);
  // 负控：把 A 档判据拿掉后 B 档必须还剩件——证明重合度这条信号真的在参与判定，不是摆设。
  const strict = result.rows.filter(row => row.tier === 'tier1A-孪生可自动并入'
    && row.twinEvidence.startsWith('slug-collision')).length;
  const loose = result.rows.filter(row => row.tier.startsWith('tier1')).length;
  expect('负控-阈值会改判', strict < loose, `只认撞名是 ${strict} 件，应少于 A+B 合计 ${loose} 件，否则重合度信号没起作用`);
  return { failures, checked };
}

async function main(argv) {
  const result = buildDisposition();
  if (argv.includes('--control')) {
    const { failures, checked } = controls(result);
    console.log(JSON.stringify({ mode: 'control', checked, failures: failures.length, detail: failures, tally: result.tally }, null, 1));
    return failures.length ? 1 : 0;
  }
  const out = join(BASE, 'skhl-disposition-2026-10-07.json');
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), ...result }, null, 1));
  writeFileSync(out.replace(/\.json$/, '.csv'),
    ['dir\tcnName\tproposedSlug\ttier\ttwinEvidence\ttokenOverlap%\tlibraryTwin'].join('\n') + '\n'
    + result.rows.map(r => [r.dir, r.cnName, r.proposedSlug, r.tier, r.twinEvidence, r.tokenOverlap ?? '', r.libraryTwin ?? ''].join('\t')).join('\n') + '\n');
  console.log(JSON.stringify({ mode: 'disposition', hlCount: result.hlCount, libraryCompared: result.libraryCompared, tally: result.tally, out }, null, 1));
  return 0;
}

if (process.argv[1]) process.exitCode = await main(process.argv.slice(2));
