import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * ZIP 族物化判定表：442 个包解压后得到 511 个 SKILL.md，但「有多少技能要入面」不是 511 也不是 442——
 * 得先把多包里的嵌套件分清楚，再挑出撞名与逐字节重复，去向才有可审的件名清单。
 * 本工具只读解压暂存树和库面，不写库面。
 */

const SKILL_MD = 'SKILL.md';
const FAMILIES = { Manus: 'skills/Manus/skill02', MinMaxDesign: 'skills/MinMaxDesign' };

function walk(dir, rel, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['.DS_Store', '__pycache__', 'node_modules', '.git'].includes(entry.name)) continue;
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(join(dir, entry.name), r, out);
    else out.push(r);
  }
  return out;
}

// AppleDouble/Finder 残渣（__MACOSX/._x）不是交付文件，但它是真实存在的字节，
// 所以按旗标登记而不是从计数里悄悄抹掉——入面时要剥，静默过滤会让屏检和计数对不上。
const isAppleDouble = rel => rel.split('/').some(part => part === '__MACOSX' || part.startsWith('._'));

const sha16 = buffer => createHash('sha256').update(buffer).digest('hex').slice(0, 16);

function frontmatter(text) {
  const lines = text.split('\n');
  if ((lines[0] ?? '').replace(/^/, '').trim() !== '---') return { keys: null, name: null, description: null };
  const keys = new Set();
  let name = null;
  let description = null;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') break;
    const match = lines[index].match(/^([A-Za-z_][A-Za-z0-9_.-]*):(.*)$/);
    if (!match) continue;
    keys.add(match[1]);
    if (match[1] === 'name') name = match[2].trim().replace(/^["']|["']$/g, '');
    if (match[1] === 'description') description = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return { keys, name, description };
}

export function buildIntake({ probeRoot, libraryRoot, screenReport }) {
  const screenByRel = new Map((screenReport?.skills ?? []).map(item => [item.relPath, item]));

  // 库面基线：目录名（撞名判定）与 SKILL.md 摘要（逐字节重复判定）。
  const librarySkipped = [];
  const libraryFiles = walk(libraryRoot, '', []).filter(rel => {
    const top = rel.split('/')[0];
    return !(top === '_assembly-v1' || top === '_assembly-history' || top === 'skills-Qoder');
  });
  const libraryNames = new Set();
  const librarySha = new Map();
  for (const rel of libraryFiles.filter(path => basename(path) === SKILL_MD)) {
    libraryNames.add(basename(dirname(rel)));
    try { librarySha.set(sha16(readFileSync(join(libraryRoot, rel))), rel); } catch { /* 读不到就留空，不猜 */ }
  }

  const packages = [];
  for (const [family, libraryDir] of Object.entries(FAMILIES)) {
    const root = join(probeRoot, family);
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const dir = join(root, name);
      if (!statSync(dir).isDirectory()) continue;
      const inner = walk(dir, '', []);
      const skillRels = inner.filter(rel => basename(rel) === SKILL_MD);
      // 主件＝最浅层；同层有多个时取路径字典序第一个，其余全部按嵌套件登记，不静默丢弃。
      const depth = rel => rel.split('/').length;
      const minDepth = Math.min(...skillRels.map(depth), Infinity);
      const sorted = [...skillRels].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
      const primary = sorted[0] ?? null;
      const nested = primary ? sorted.slice(1) : [];
      const primaryBytes = primary ? readFileSync(join(dir, primary)) : null;
      const digest = primary ? sha16(primaryBytes) : null;
      const parsed = primary ? frontmatter(primaryBytes.toString('utf8')) : { keys: null, name: null };
      const screenRel = relative(probeRoot, join(dir, primary ?? ''));
      const screen = screenByRel.get(screenRel);
      const duplicateOf = digest ? librarySha.get(digest) ?? null : null;
      const collision = libraryNames.has(name) ? libraryFiles
        .filter(rel => basename(dirname(rel)) === name && basename(rel) === SKILL_MD) : [];
      packages.push({
        family, zipBase: name,
        sourceZip: `${libraryDir}/${name}.zip`,
        files: inner.length,
        appleDoubleFiles: inner.filter(isAppleDouble).length,
        skillMdCount: skillRels.length,
        primary, nested,
        primaryNameField: parsed.name,
        hasFrontmatter: parsed.keys !== null,
        primarySha256: digest,
        duplicateOfLibrarySkill: duplicateOf,
        collidesWithLibrary: collision,
        screenChecked: !!screen,
        // 屏检对零 finding 的件不给 severity，所以「查过但干净」必须写成 clean，不能冒充「没查」。
        screenSeverity: screen ? screen.severity ?? 'clean' : 'not-screened',
        screenFindingCodes: screen ? [...new Set(screen.findings.map(finding => finding.code))] : [],
      });
    }
  }

  const disposition = packages.map(item => {
    const reasons = [];
    if (!item.primary) reasons.push('NO_SKILL_MD');
    if (item.duplicateOfLibrarySkill) reasons.push('BYTE_DUPLICATE_OF_LIBRARY');
    if (item.collidesWithLibrary.length) reasons.push('NAME_COLLISION');
    if (item.nested.length) reasons.push('HAS_NESTED_SKILL_MD');
    if (!item.hasFrontmatter) reasons.push('NO_FRONTMATTER');
    if (item.appleDoubleFiles) reasons.push('HAS_APPLEDOUBLE_JUNK');
    const targetBucket = item.duplicateOfLibrarySkill ? 'register-duplicate'
      : !item.primary ? 'register-non-skill'
        : item.collidesWithLibrary.length ? 'collision-adjudication'
          : 'materialize';
    return { ...item, reasons, disposition: targetBucket };
  });

  const tally = disposition.reduce((acc, item) => {
    acc[item.disposition] = (acc[item.disposition] ?? 0) + 1;
    acc.nestedSkillMd += item.nested.length;
    acc.primarySkillMd += item.primary ? 1 : 0;
    return acc;
  }, { nestedSkillMd: 0, primarySkillMd: 0 });

  return { packages: disposition, tally, libraryBaseline: { skillMd: librarySha.size, dirNames: libraryNames.size } };
}

function controls({ probeRoot, libraryRoot, screenReport }) {
  const failures = [];
  let checked = 0;
  const expect = (label, condition, detail) => { checked += 1; if (!condition) failures.push(`${label} :: ${detail}`); };
  const result = buildIntake({ probeRoot, libraryRoot, screenReport });

  expect('正控-包数对账', result.packages.length === 442, `应为 442 个包，实得 ${result.packages.length}`);
  // 嵌套件不得被静默丢掉：主件＋嵌件套＝库内标准口径的 SKILL.md 总数（508；
  // 早前口算的 511 是 endsWith("SKILL.md") 把 __MACOSX/._SKILL.md 三个残渣也算进去，已勘误）。
  expect('正控-单元求和闭合', result.tally.primarySkillMd + result.tally.nestedSkillMd === 508,
    `主件 ${result.tally.primarySkillMd} ＋ 嵌套 ${result.tally.nestedSkillMd} 应等于 508`);
  expect('正控-AppleDouble 有账', result.packages.filter(item => item.appleDoubleFiles > 0).length === 3,
    `应登记到 3 个带 __MACOSX/._SKILL.md 残渣的包，实得 ${result.packages.filter(item => item.appleDoubleFiles > 0).length}`);
  const knownCollision = result.packages.find(item => item.zipBase === 'ad-creative' && item.family === 'MinMaxDesign');
  expect('正控-已知撞名', knownCollision?.disposition === 'collision-adjudication',
    `MinMaxDesign/ad-creative 应判撞名待裁，实得 ${knownCollision?.disposition}`);
  const nestedCase = result.packages.find(item => item.nested.length > 0);
  expect('正控-多包识别', nestedCase && nestedCase.reasons.includes('HAS_NESTED_SKILL_MD'),
    `应至少有一个多包被识别，实得 ${nestedCase?.zipBase ?? '无'}`);
  expect('正控-分桶完备',
    ['materialize', 'collision-adjudication', 'register-duplicate', 'register-non-skill']
      .reduce((sum, key) => sum + (result.tally[key] ?? 0), 0) === result.packages.length,
    `四个去向之和应等于包数：${JSON.stringify(result.tally)}`);

  // 负控一：换一个不存在的 probe 根，不得凭空造出包。
  const ghost = buildIntake({ probeRoot: join(probeRoot, 'does-not-exist'), libraryRoot, screenReport });
  expect('负控-幽灵根', ghost.packages.length === 0, `幽灵根应得 0 包，实得 ${ghost.packages.length}`);
  // 负控二：屏检读数错位时，件不得被写成有屏检结论。
  const mismatch = buildIntake({ probeRoot, libraryRoot, screenReport: { skills: [{ relPath: 'NoSuch/NoSuch/SKILL.md', severity: 'high', findings: [{ code: 'X', severity: 'high' }] }] } });
  expect('负控-屏检错位不冒充', mismatch.packages.every(item => item.screenChecked === false
    && item.screenSeverity === 'not-screened'), '屏检路径对不上时不得把结论挂到包上');
  return { failures, checked, result };
}

async function main(argv) {
  const value = flag => { const index = argv.indexOf(flag); return index === -1 ? undefined : argv[index + 1]; };
  const repoRoot = value('--repo') ?? process.cwd();
  const probeRoot = value('--probe') ?? join(repoRoot, 'skill-lifecycle/trial-home/screening/_zipprobe');
  const libraryRoot = value('--root') ?? '/Users/lute/project/AgentTools/技能库';
  const screenPath = value('--screen') ?? join(repoRoot, 'docs/specs/2026-09-25-dsh-skill-lifecycle/145-standardization-baseline/zipfamily-screen-2026-10-07.json');
  const screenReport = existsSync(screenPath) ? JSON.parse(readFileSync(screenPath, 'utf8')) : { skills: [] };

  if (argv.includes('--control')) {
    const { failures, checked } = controls({ probeRoot, libraryRoot, screenReport });
    console.log(JSON.stringify({ mode: 'control', at: new Date().toISOString(), checked, failures: failures.length, detail: failures }, null, 1));
    return failures.length ? 1 : 0;
  }

  const { packages, tally, libraryBaseline } = buildIntake({ probeRoot, libraryRoot, screenReport });
  const out = value('--out');
  if (out) {
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), probeRoot, libraryRoot, tally, libraryBaseline, packages }, null, 1));
    const header = 'family,zipBase,files,skillMd,primarySkillMd,nestedCount,primaryNameField,hasFrontmatter,sha16,duplicateOf,nameCollision,screenSeverity,screenCodes,disposition';
    const csv = [header, ...packages.map(p => [p.family, p.zipBase, p.files, p.skillMdCount, p.primary ?? '', p.nested.length,
      p.primaryNameField ?? '', p.hasFrontmatter, p.primarySha256 ?? '', p.duplicateOfLibrarySkill ?? '',
      p.collidesWithLibrary.length, p.screenSeverity ?? 'not-screened', p.screenFindingCodes.join('|'), p.disposition]
      .map(cell => (typeof cell === 'string' && cell.includes(',')) ? `"${cell}"` : cell).join(','))].join('\n');
    writeFileSync(`${out.replace(/\.json$/, '')}.csv`, `${csv}\n`);
  }
  console.log(JSON.stringify({ mode: 'intake', at: new Date().toISOString(), tally, libraryBaseline,
    byScreen: packages.reduce((acc, p) => { acc[p.screenSeverity ?? 'not-screened'] = (acc[p.screenSeverity ?? 'not-screened'] ?? 0) + 1; return acc; }, {}),
    reasonTotals: packages.reduce((acc, p) => { for (const r of p.reasons) acc[r] = (acc[r] ?? 0) + 1; return acc; }, {}),
    dispositionCounts: Object.fromEntries([...packages.reduce((set, p) => set.set(p.disposition, (set.get(p.disposition) ?? 0) + 1), new Map())]) }, null, 1));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
