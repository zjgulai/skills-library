import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * skill-hl 改名映射：这批的 frontmatter name 本身也是中文（51/53），所以「改目录名」不够，
 * name 字段要一起换，否则装载后仍不满足 DSH 的 kebab-ASCII 技能名规则。
 * 译名不靠猜：--dump 先把中文题名＋描述＋库面疑似同源件打出来，人（或我）照着定名。
 */

const LIB = '/Users/lute/project/AgentTools/技能库';
const REPO = process.env.SKL_REPO ?? '/Users/lute/project/AgentTools/思维库/skill管理';
const SKIP = new Set(['node_modules', '.git', '__pycache__', '.DS_Store']);
const DSH_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

function body(text) {
  const lines = text.split('\n');
  if ((lines[0] ?? '').replace(/^/, '').trim() !== '---') return text;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') return lines.slice(index + 1).join('\n');
  }
  return text;
}

/** 描述里的长片段当锚点，用来认「这批和库面某件可能是同一内容的中英文两版」。 */
function anchors(text) {
  const flat = body(text).replace(/\s+/g, ' ');
  const out = [];
  for (const start of [0, Math.floor(flat.length * 0.3), Math.floor(flat.length * 0.6)]) {
    const slice = flat.slice(start, start + 60);
    if (slice.length >= 40) out.push(slice);
  }
  return out;
}

export function scanSkillHl({ libraryRoot = LIB } = {}) {
  const hlRoot = join(libraryRoot, 'skill-hl');
  const files = walk(hlRoot, '', []);
  const skillPaths = files.filter(rel => basename(rel) === 'SKILL.md');

  // 库面基线（排除 skill-hl 自己），既用于撞名预检，也用于同源锚点比对。
  const libraryFiles = walk(libraryRoot, '', []).filter(rel => basename(rel) === 'SKILL.md');
  const library = [];
  for (const rel of libraryFiles) {
    if (rel.startsWith('skill-hl/') || rel.startsWith('_assembly') || rel.startsWith('skills-Qoder')) continue;
    let text = '';
    try { text = readFileSync(join(libraryRoot, rel), 'utf8'); } catch { continue; }
    library.push({ rel, dirName: basename(dirname(rel)), anchors: anchors(text) });
  }

  const items = [];
  for (const rel of skillPaths) {
    const abs = join(hlRoot, rel);
    const text = readFileSync(abs, 'utf8');
    const dir = dirname(rel);
    const dirName = dir === '.' ? '' : basename(dir);
    const nameField = frontmatterValue(text, 'name');
    const description = frontmatterValue(text, 'description');
    const ownAnchors = anchors(text);
    const twin = ownAnchors.length
      ? library.map(entry => ({ entry, hits: entry.anchors.filter(anchor => ownAnchors.some(a => a.includes(anchor) || anchor.includes(a))).length }))
        .filter(score => score.hits > 0).sort((a, b) => b.hits - a.hits)[0]?.entry ?? null
      : null;
    items.push({
      rel, dir, dirName, nameField,
      nameIsKebab: !!nameField && DSH_NAME.test(nameField),
      dirIsKebab: DSH_NAME.test(dirName),
      descriptionChars: description ? description.length : 0,
      descriptionHead: (description ?? '').slice(0, 180),
      bodyBytes: statSync(abs).size,
      suspectedLibraryTwin: twin?.dirName ?? null,
      twinPath: twin?.rel ?? null,
    });
  }
  return { items, librarySkillCount: library.length };
}

export function applyMapping(items, mapping, { libraryRoot = LIB } = {}) {
  // 基线要排掉 skill-hl 自己：否则 skill-yn 那两件会跟自己撞名，把 collisions 灌水。
  const libraryNames = new Map(walk(libraryRoot, '', [])
    .filter(rel => basename(rel) === 'SKILL.md')
    .map(rel => dirname(rel))
    .filter(dir => !dir.startsWith('skill-hl/') && !dir.startsWith('_assembly') && !dir.startsWith('skills-Qoder'))
    .map(dir => [basename(dir), dir]));
  const problems = [];
  const collisions = [];
  const rows = items.map(item => {
    const proposed = item.dirIsKebab && item.nameIsKebab ? item.nameField : mapping[item.dirName] ?? null;
    if (!proposed) { if (!item.dirIsKebab) problems.push(`NO_MAPPING ${item.dir}`); return { ...item, proposed, status: 'unmapped' }; }
    if (!DSH_NAME.test(proposed)) problems.push(`BAD_SLUG ${item.dir} → ${proposed}`);
    // 撞库面名不是表的缺陷，是要人裁的发现：它意味着库面已有同职责件，得先定「并入 or 并存」。
    const clash = libraryNames.get(proposed);
    if (clash && clash !== item.dir) collisions.push({ dir: item.dir, proposed, libraryPath: clash });
    return { ...item, proposed, collidesWith: clash && clash !== item.dir ? clash : null,
      status: clash && clash !== item.dir ? 'collides-library' : DSH_NAME.test(proposed) ? 'proposed' : 'invalid' };
  });
  const seen = new Map();
  for (const row of rows) {
    if (!row.proposed) continue;
    seen.set(row.proposed, [...(seen.get(row.proposed) ?? []), row.dir]);
  }
  for (const [slug, dirs] of seen) if (dirs.length > 1) problems.push(`INTERNAL_DUP ${slug} ← ${dirs.join(', ')}`);
  return { rows, problems, collisions };
}

const MAPPING = {
  // lute 于 2026-10-07 授权「翻译成英文」。定名依据＝描述里的实际职责，不是目录字面直译；
  // 与库面同域的件（品牌监控/归因/文案…）一律取可区分的名，装载与台账才不会两条同名并行。
  'SEO写作': 'seo-content-writer',
  'TikTok达人营销': 'tiktok-creator-campaigns',
  '体验系统蓝图': 'experience-system-blueprint',
  '信息框架': 'message-house-builder',
  '公关': 'pr-media-pitch',
  '内容策略': 'content-strategy-planner',
  '分析': 'analytics-tracking-setup',
  '创意迭代手册': 'creative-iteration-playbook',
  '危机应对手册': 'crisis-response-playbook',
  '参与者运营枢纽': 'research-participant-ops',
  '合作伙伴生态图谱': 'partner-ecosystem-map',
  '合作伙伴营收台': 'partner-revenue-desk',
  '品牌叙事': 'brand-narrative-arc',
  '品牌叙事手册': 'brand-messaging-handbook',
  '品牌声音术语表': 'tone-of-voice-guide',
  '品牌治理操作系统': 'brand-governance-os',
  '品牌测量仪表盘': 'brand-health-dashboard',
  '品牌监控': 'brand-mention-monitor',
  '媒体数据库': 'media-contact-database',
  '市场信号追踪器': 'market-signal-tracker',
  '市场情景建模器': 'market-sizing-modeler',
  '平台框架': 'platform-content-framework',
  '归因': 'marketing-attribution-advisor',
  '思想领导力': 'thought-leadership-writing',
  '效果追踪': 'campaign-performance-tracking',
  '文案写作': 'marketing-copywriter',
  '案例研究': 'case-study-writing',
  '洞察知识库套件': 'insights-repository-governance',
  '活动策划': 'campaign-strategy-brief',
  '渠道整合': 'channel-integration',
  '渠道路线图套件': 'channel-roadmap-kit',
  '电商营销策略构建器': 'ecommerce-strategy-composer',
  '白皮书': 'whitepaper-production',
  '研究简报蓝图': 'research-brief-template',
  '社区互动': 'community-engagement',
  '社区舆情仪表盘': 'community-sentiment-dashboard',
  '社媒内容': 'social-content-batch',
  '社媒日历系统': 'social-calendar-system',
  '竞争战卡库': 'battlecard-library',
  '竞品画像': 'competitor-profile-builder',
  '编辑运营': 'editorial-operations',
  '网络研讨会': 'webinar-program',
  '联合营销': 'co-marketing-partner-sourcing',
  '联合营销治理': 'co-marketing-governance-desk',
  '联合解决方案蓝图': 'co-solution-blueprint',
  '营销心理学': 'buyer-psychology-models',
  '赢输数据集': 'win-loss-dataset',
  '趋势研究': 'cultural-trend-research',
  '达人营销': 'creator-partnership-execution',
  '高管简报套件': 'executive-briefing-kit',
  '蒸馏': 'source-material-distillation',
};

async function main(argv) {
  const value = flag => { const index = argv.indexOf(flag); return index === -1 ? undefined : argv[index + 1]; };
  const scanned = scanSkillHl({ libraryRoot: value('--root') ?? LIB });
  if (argv.includes('--dump')) {
    for (const item of scanned.items) {
      console.log(`${item.dir}\tname=${item.nameField ?? '(none)'}\tdesc=${item.descriptionChars}B\ttwin=${item.suspectedLibraryTwin ?? '-'}\t${item.descriptionHead.slice(0, 110)}`);
    }
    console.log(`# library skills compared: ${scanned.librarySkillCount}`);
    return 0;
  }
  if (argv.includes('--selftest')) {
    const problems = [];
    let checked = 0;
    const expect = (label, condition, detail) => { checked += 1; if (!condition) problems.push(`${label} :: ${detail}`); };
    const scanned = scanSkillHl();
    const mapped = applyMapping(scanned.items, MAPPING);
    // 同源探测器必须会命中（只会绿的检查不是检查）：屏检簇里那对 perspective 件应被锚点抓到。
    const library = walk(value('--root') ?? LIB, '', []).filter(rel => basename(rel) === 'SKILL.md');
    const pair = library.filter(rel => /elon-musk/.test(rel) && !rel.startsWith('skill-hl/') && !rel.startsWith('_assembly')).slice(0, 2);
    if (pair.length === 2) {
      const [a, b] = pair.map(rel => readFileSync(join(LIB, rel), 'utf8'));
      const A = anchors(a), B = anchors(b);
      const hits = A.filter(anchor => B.some(other => other.includes(anchor) || anchor.includes(other))).length;
      expect('正控-锚点探测会命中', hits >= 1, `elon-musk 两版应至少 1 个锚点重合，实得 ${hits}（对：${pair.join(', ')}）`);
    } else expect('正控-锚点探测会命中', false, `样本对不足：${pair.join(', ')}`);
    expect('正控-映射全覆盖', mapped.rows.filter(r => r.status === 'unmapped').length === 0,
      `未定名件 ${mapped.rows.filter(r => r.status === 'unmapped').length}：${mapped.rows.filter(r => r.status === 'unmapped').map(r => r.dir).join(', ')}`);
    expect('正控-硬错误为零', mapped.problems.length === 0, mapped.problems.join(' ; '));
    expect('正控-撞名以发现形式在册', mapped.collisions.length >= 1,
      '译名与库面同职责件相撞应作为 collisions 列出，供人裁并入 or 并存');
    // 负控：抽掉一条映射，该件必须转 unmapped 且整体判红。
    const partial = applyMapping(scanned.items, Object.fromEntries(Object.entries(MAPPING).filter(([k]) => k !== '品牌监控')));
    expect('负控-缺映射会漏', partial.rows.some(r => r.dirName === '品牌监控' && r.status === 'unmapped')
      && partial.problems.some(p => p.startsWith('NO_MAPPING')), '抽掉「品牌监控」映射后该件必须落 unmapped 并记硬错误');
    // 负控：造一个与库面撞名的译名，必须进 collisions 而不是被静默接受。
    const collide = applyMapping(scanned.items, { ...MAPPING, '分析': 'analytics' });
    expect('负控-撞名会记', collide.collisions.some(entry => entry.libraryPath === 'analytics'),
      '把「分析」译成库面已有的 analytics 必须进 collisions');
    console.log(JSON.stringify({ mode: 'selftest', checked, problems: problems.length, detail: problems,
      items: mapped.rows.length, slugs: [...new Set(mapped.rows.map(r => r.proposed).filter(Boolean))].length }, null, 1));
    return problems.length ? 1 : 0;
  }
  const { rows, problems, collisions } = applyMapping(scanned.items, MAPPING, { libraryRoot: value('--root') ?? LIB });
  const out = value('--out');
  if (out) {
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), rows, problems, collisions }, null, 1));
    writeFileSync(`${out.replace(/\.json$/, '')}.tsv`,
      ['dir\tcnName\tproposedKebab\tstatus\tcollidesWithLibrary\tsuspectedTwin'].join('\n') + '\n'
      + rows.map(r => [r.dir, r.nameField ?? '(none)', r.proposed ?? '', r.status, r.collidesWith ?? '', r.suspectedLibraryTwin ?? ''].join('\t')).join('\n') + '\n');
  }
  console.log(JSON.stringify({
    mode: 'rename-map', items: rows.length,
    alreadyKebab: rows.filter(r => r.dirIsKebab && r.nameIsKebab).length,
    proposed: rows.filter(r => r.status === 'proposed').length,
    collidesLibrary: collisions.length,
    unmapped: rows.filter(r => r.status === 'unmapped').length,
    withSuspectedTwin: rows.filter(r => r.suspectedLibraryTwin).length,
    problems: problems.length, problemDetail: problems.slice(0, 20),
    collisionDetail: collisions.map(entry => `${entry.dir} → ${entry.proposed} ≡ ${entry.libraryPath}`),
  }, null, 1));
  return problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
