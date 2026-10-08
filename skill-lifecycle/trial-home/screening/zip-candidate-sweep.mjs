import { readdirSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { join, basename, dirname, extname } from 'node:path';

/**
 * 制作腿独立复核（主链跑，不采信代理自检）。
 *
 * 每条判据都必须"会红"：--self-test 会把每件已知缺陷注入到临时副本，逐项验证能红、
 * 未突变副本必须 pass。LB-7 起这条是硬规矩（代理自检过但主链复跑抓漏是常态）。
 */

const REPO = '/Users/lute/project/AgentTools/思维库/skill管理';
const FIX = join(REPO, 'skill-lifecycle/trial-home/opt-run/candidates-zip-fix');
const BASELINE = join(REPO, 'skill-lifecycle/trial-home/opt-run/candidates-zip');
const BASE = join(REPO, 'docs/specs/2026-09-25-dsh-skill-lifecycle/145-standardization-baseline');
const TARGETS = join(BASE, 'fix-targets');
const TARGETS2 = join(BASE, 'fix-targets-gen2');
const DSH_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PKG_DIRS = ['references/', 'assets/', 'scripts/', 'templates/', 'examples/', 'resources/'];
const JUNK = /(^|\/)(__pycache__|\.DS_Store|node_modules|\.pytest_cache)(\/|$)|\/[^/]+\.(pyc|pyo)$|\.crdownload$/;
// 真机器路径 vs 上游自带的示例占位（`/Users/me/Downloads/video.mp4` 这类）：
//   不区分就会把基线原文判成代理写的脏路径（LB-8 二波实测 2 条假红，基线同样命中）。
const PLACEHOLDER_USER = '(?!me\/|you\/|user\/|username\/|name\/|<)[a-z][a-z0-9_.-]*';
const MACHINE_PATH = new RegExp(
  `\\/(?:Users|home)\\/${PLACEHOLDER_USER}\\/|C:[\\/]+Users[\\/]+${PLACEHOLDER_USER}`, 'i');
// C:/Users/CedricChen/... 这种**正斜杠**写法曾经漏网（第二波代理在 scrapling 的 upstream-map.md 里抓到真例）

function walk(dir, rel = '', out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(join(dir, entry.name), r, out);
    else out.push(r);
  }
  return out;
}

function frontmatterLines(text) {
  const lines = text.split('\n');
  if ((lines[0] ?? '').replace(/^/, '').trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') return { body: lines.slice(0, i + 1).join('\n'), lines: lines.slice(1, i) };
  return null;
}

function topLevelKeys(lines) {
  const keys = new Set();
  let inBlock = false;
  for (const line of lines) {
    const m = line.match(/^([A-Za-z_][\w.-]*):(.*)$/);
    if (m) { keys.add(m[1]); inBlock = /^\s*[|>][-+]?\d*$/.test(m[2]); }
    else if (!/^\s/.test(line) && line.trim() !== '') inBlock = false;
  }
  return keys;
}

/** 未加引号却含 `: ` 的**流式**标量——DSH 走 yaml.parse，这类会整件解析失败（本批代理自报抓到两例）。
 *  块标量（`|`/`>`）的内容里出现冒号完全合法，绝不能扫进去（LB-8 实测：15/24 件 `description: >-` 被假红）。 */
function unquotedColonScalars(lines) {
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w.-]*):\s+(.*\S)\s*$/);
    if (!m) continue;
    const value = m[2];
    if (/^[|>][-+]?\d*$/.test(value)) {                                   // 块标量：内容不参与映射解析，整段跳过
      for (let j = i + 1; j < lines.length && (lines[j].startsWith(' ') || lines[j] === ''); j++) i = j;
      continue;
    }
    if (/^["'].*["']$/.test(value)) continue;
    if (/:\s/.test(value) || /\s#\s/.test(value)) bad.push(m[1]);
  }
  return bad;
}

function referencedFiles(text, dirs) {
  const refs = new Set();
  const md = /\]\(([^)\s]+)\)/g;
  let m;
  while ((m = md.exec(text)) !== null) refs.add({ ref: m[1], kind: 'md' });
  const back = /`(?:\.?\/?)([\w][\w.\/-]*\.(?:md|json|ya?ml|js|mjs|py|sh|csv|txt))`/g;
  while ((m = back.exec(text)) !== null) refs.add({ ref: m[1], kind: 'backtick' });
  return [...refs].filter(({ ref }) => !/^(https?:|mailto:|#)/.test(ref) && [...dirs].some(dir => ref.startsWith(dir)));
}

/** 白名单不能写死：本族基线里实际出现过 evals/ tests/ agents/ reference(单数) 等 12 类目录，
 *  写死 6 类会漏检。以「候选与基线实际存在的顶层目录」为准，跨技能引用（目录在本包外）自然不入范围。 */
function pkgDirSet(files, baseFiles) {
  const dirs = new Set(PKG_DIRS);
  for (const list of [files, baseFiles]) for (const f of list) {
    if (!f.includes('/')) continue;
    const top = f.split('/')[0];
    if (top.length > 1) dirs.add(`${top}/`);
  }
  return dirs;
}

/** 反引号里的裸路径常按包根书写（正文说"见 `references/x.md`"），markdown 链接按文件相对。
 *  两种解析都不存在才算断链——只按文件相对解会假红（LB-8 实测 20 条断链全为这种）。 */
function resolves(dir, fromFile, ref) {
  const clean = ref.replace(/^\.\//, '');
  return existsSync(join(dir, dirname(fromFile), clean)) || existsSync(join(dir, clean));
}

export function sweepItem({ slug, fixRoot = FIX, baselineRoot = BASELINE }) {
  const dir = join(fixRoot, `${slug}-gen1`);
  const baseDir = join(baselineRoot, slug);
  const problems = [];
  const notes = [];
  if (!existsSync(dir)) return { slug, problems: [`候选缺失 ${slug}-gen1`], notes, files: 0 };
  if (!existsSync(baseDir)) notes.push('无基线件可对照');

  const files = walk(dir);
  const baseFiles = existsSync(baseDir) ? walk(baseDir) : [];
  const rel = `${slug}-gen1`;

  // 结构：必须 <slug>/SKILL.md 深度 1，且目录名 kebab 并与 frontmatter name 一致
  const skill = files.filter(f => basename(f) === 'SKILL.md');
  if (skill.length !== 1) problems.push(`SKILL.md 数 ${skill.length}（应为 1）`);
  else if (skill[0] !== 'SKILL.md') problems.push(`SKILL.md 在 ${dirname(skill[0]) || '.'}（双层包裹）`);
  if (!DSH_NAME.test(slug)) problems.push(`目录名非 kebab：${slug}`);
  const text = skill.length ? readFileSync(join(dir, skill[0]), 'utf8') : '';
  const fm = frontmatterLines(text);
  if (!fm) problems.push('无 frontmatter');
  else {
    const keys = topLevelKeys(fm.lines);
    const nameMatch = fm.lines.find(line => /^name:/.test(line))?.match(/^name:\s*(.*)$/);
    const name = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, '') : null;
    if (!keys.has('description')) problems.push('缺 description');
    if (name !== slug) problems.push(`name(${name}) != 目录(${slug})`);
    for (const key of unquotedColonScalars(fm.lines)) problems.push(`标量含未转义冒号（DSH yaml.parse 会整件失败）：${key}`);
    const version = fm.lines.find(line => /^version:/.test(line))?.match(/^version:\s*["']?([\d.]+)/);
    const metaVersion = fm.body.match(/^\s+version:\s*["']?([\d.]+)/m);
    if (version && metaVersion && version[1] !== metaVersion[1]) problems.push(`version(${version[1]}) 与 metadata.version(${metaVersion[1]}) 打架`);
  }

  const baseText = existsSync(baseDir) && existsSync(join(baseDir, 'SKILL.md'))
    ? readFileSync(join(baseDir, 'SKILL.md'), 'utf8') : '';
  const baseKeys = frontmatterLines(baseText) ? topLevelKeys(frontmatterLines(baseText).lines) : new Set();
  const nowKeys = fm ? topLevelKeys(fm.lines) : new Set();

  // 字段一致性（LB-8 制作腿实测四类分歧，规则写进闸门而不是靠代理自觉）：
  //  A. 判者点名「非标准字段」的键（acceptLicenseTerms / slug / trigger-words / exported-by）留着不改＝扣分项没修；
  //  B. 判者没提的规范外键（schema_version / security / category）被代理当"房内形制"互相抄＝发明事实（本族基线 0 件带 schema_version）。
  // 靶单＝第一轮 ＋ gen2（第二轮复评报告全文）。只看第一轮会把 gen2 判者点名的键当成「无点名新增」——
  // 实测 video-to-subtitle-summary 的 category/tags 由 gen2 报告点名，闸门却按旧靶单判红。
  const targetText = [join(TARGETS, `${slug}.md`), join(TARGETS2, `${slug}.md`)]
    .filter(path => existsSync(path)).map(path => readFileSync(path, 'utf8')).join('\n');
  if (targetText) {
    const named = key => (key === 'slug' ? /`slug`/.test(targetText) : targetText.includes(key));
    for (const key of ['acceptLicenseTerms', 'slug', 'trigger-words', 'exported-by']) {
      if (nowKeys.has(key) && named(key)) problems.push(`${key} 判者已点名非标准却仍在候选里`);
    }
    for (const key of ['schema_version', 'security', 'category']) {
      if (nowKeys.has(key) && !named(key)) problems.push(`${key} 为无点名新增（判者未要求，本族基线亦无此键）`);
    }
    // exported-by 单独定性：库面 1,111 件出现 **0 次**，本族 399 件基线却有 101 件——是上游导出管线的残留，
    // 判者在本族反复记为「非标／宿主身份」。故不按「本件靶单是否点名」而按族级证据一律拦。
    if (nowKeys.has('exported-by')) problems.push('exported-by 属上游导出残留（库面 0/1111），本批一律不得保留');
  }

  // 无据新增字段：候选相对基线新增的 license/author 必须有包内出处
  for (const field of ['license', 'author']) {
    if (nowKeys.has(field) && !baseKeys.has(field)) {
      const evidence = files.filter(f => /(^|\/)(LICENSE|COPYING|NOTICE|_meta\.json|README[^/]*\.md)$/i.test(f))
        .some(f => {
          const t = (() => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return ''; } })();
          const value = fm.lines.find(line => line.startsWith(field + ':'))?.slice(field.length + 1) ?? '';
          const token = value.replace(/^["']|["']$/g, '').trim();
          return token.length > 1 && new RegExp(token.split(/\s+/)[0], 'i').test(t) && !/未为整份|no repository-wide|not.*licensed/i.test(t);
        });
      if (!evidence) problems.push(`${field} 为无据新增（基线没有该字段，包内亦无出处）`);
    }
  }

  // 引用完整性：包内约定目录的引用必须真实存在
  const dirs = pkgDirSet(files, baseFiles);
  for (const file of files.filter(f => f.endsWith('.md'))) {
    const body = readFileSync(join(dir, file), 'utf8');
    for (const { ref } of referencedFiles(body, dirs)) {
      if (!resolves(dir, file, ref)) problems.push(`断链 ${file} → ${ref}`);
    }
  }

  // 残渣与机器路径
  for (const file of files) if (JUNK.test(file)) problems.push(`打包残渣 ${file}`);
  for (const file of files.filter(f => /\.(md|py|js|mjs|sh|json|ya?ml)$/.test(f))) {
    const t = (() => { try { return readFileSync(join(dir, file), 'utf8'); } catch { return ''; } })();
    if (MACHINE_PATH.test(t)) problems.push(`机器绝对路径 ${file}`);
    if (/TODO|FIXME|<placeholder>|xxx\.md/i.test(t)) problems.push(`占位符残留 ${file}`);
  }
  // 新增可执行文件必须语法可检
  for (const newFile of files.filter(f => ['.py', '.js', '.mjs'].includes(extname(f).toLowerCase()) && !baseFiles.includes(f))) {
    notes.push(`新增可执行文件待主链跑语法检查：${rel}/${newFile}`);
  }
  return { slug, problems: [...new Set(problems)], notes, files: files.length, added: files.filter(f => !baseFiles.includes(f)),
    removed: baseFiles.filter(f => !files.includes(f)) };
}

function selfTest() {
  const results = [];
  const probeSlug = 'zz-selftest-probe';
  const probeFix = join(FIX, `${probeSlug}-gen1`);
  const probeBase = join(BASELINE, probeSlug);
  const probeTarget = join(TARGETS, `${probeSlug}.md`);
  // 默认靶单：点名 acceptLicenseTerms 为非标准，不点名 schema_version / category
  const DEFAULT_TARGET = '| 1 | `frontmatter.license` | error | 存在非标准字段 `acceptLicenseTerms: true`。 |\n';
  const cleanup = () => { rmSync(probeFix, { recursive: true, force: true }); rmSync(probeBase, { recursive: true, force: true }); rmSync(probeTarget, { force: true }); };
  try {
    mkdirSync(join(probeFix, 'references'), { recursive: true });
    mkdirSync(probeBase, { recursive: true });
    const clean = ['---', 'name: zz-selftest-probe', 'description: "A probe skill for the sweep verifier itself."', 'version: "1.0.0"', '---', '', '# Probe', '', 'See `references/a.md`.', ''].join('\n');
    writeFileSync(join(probeFix, 'SKILL.md'), clean);
    writeFileSync(join(probeFix, 'references/a.md'), '# a\n');
    writeFileSync(join(probeBase, 'SKILL.md'), clean);

    const reset = (target = DEFAULT_TARGET) => {
      rmSync(probeFix, { recursive: true, force: true });
      mkdirSync(join(probeFix, 'references'), { recursive: true });
      writeFileSync(join(probeFix, 'references/a.md'), '# a\n');
      writeFileSync(join(probeFix, 'SKILL.md'), clean);
      writeFileSync(probeTarget, target);
    };
    // expect=green 守「放宽后不许假红」，expect=red 守「放宽后不许漏红」——两边都要有，
    // 只留 red 的话这次两处放宽（块标量、根相对反引号）就没有回归位。
    const cases = [
      { case: '未突变副本必须 pass', expect: 'green', mutate: () => {} },
      { case: '块标量 description 内含冒号必须放行', expect: 'green',
        mutate: () => writeFileSync(join(probeFix, 'SKILL.md'),
          clean.replace('description: "A probe skill for the sweep verifier itself."',
            'description: >-\n  Two-phase pipeline: convert a photo, then animate it. Trigger keywords: a, b.')) },
      { case: '子目录文件里的根相对反引号引用必须放行', expect: 'green',
        mutate: () => { writeFileSync(join(probeFix, 'references/b.md'), '# b\n');
          writeFileSync(join(probeFix, 'references/a.md'), 'See `references/b.md`.\n'); } },
      { case: '断链要被抓', expect: 'red',
        mutate: () => writeFileSync(join(probeFix, 'SKILL.md'), clean.replace('references/a.md', 'references/missing.md')) },
      { case: '子目录反引号真断链要被抓', expect: 'red',
        mutate: () => writeFileSync(join(probeFix, 'references/a.md'), 'See `references/nope.md`.\n') },
      { case: '动态目录（evals/）断链要被抓', expect: 'red',
        mutate: () => { mkdirSync(join(probeFix, 'evals'), { recursive: true });
          writeFileSync(join(probeFix, 'evals/other.md'), '# o\n');
          writeFileSync(join(probeFix, 'SKILL.md'), clean + 'See `evals/missing.md`.\n'); } },
      { case: '无据 license 要被抓', expect: 'red',
        mutate: () => writeFileSync(join(probeFix, 'SKILL.md'), clean.replace('version:', 'license: MIT\nversion:')) },
      { case: '未转义冒号描述要被抓', expect: 'red',
        mutate: () => writeFileSync(join(probeFix, 'SKILL.md'), clean.replace(/description: .*/, 'description: Use when: needed, do not use for X')) },
      { case: 'name 与目录不符要被抓', expect: 'red',
        mutate: () => writeFileSync(join(probeFix, 'SKILL.md'), clean.replace('name: zz-selftest-probe', 'name: other-name')) },
      { case: '双层包裹要被抓', expect: 'red',
        mutate: () => { mkdirSync(join(probeFix, 'nested'), { recursive: true });
          writeFileSync(join(probeFix, 'nested', 'SKILL.md'), clean); writeFileSync(join(probeFix, 'SKILL.md'), '# x\n'); } },
      { case: 'version 打架要被抓', expect: 'red',
        mutate: () => writeFileSync(join(probeFix, 'SKILL.md'), clean.replace('version: "1.0.0"', 'version: "2.0.0"\nmetadata:\n  version: 1.0.0')) },
      { case: '无点名 schema_version 要被抓', expect: 'red',
        mutate: () => writeFileSync(join(probeFix, 'SKILL.md'), clean.replace('version:', 'schema_version: "1.1.0"\nversion:')) },
      { case: '判者点名的 schema_version 必须放行', expect: 'green',
        mutate: () => { writeFileSync(probeTarget, '在 Frontmatter 中显式声明 `schema_version: "1.1.0"`。\n');
          writeFileSync(join(probeFix, 'SKILL.md'), clean.replace('version:', 'schema_version: "1.1.0"\nversion:')); } },
      { case: '判者点名的非标准字段仍在要被抓', expect: 'red',
        mutate: () => writeFileSync(join(probeFix, 'SKILL.md'), clean.replace('version:', 'acceptLicenseTerms: true\nversion:')) },
      { case: '上游示例路径 /Users/me/ 必须放行', expect: 'green',
        mutate: () => writeFileSync(join(probeFix, 'references', 'a.md'), 'Try /Users/me/Downloads/video.mp4 as input\n') },
      { case: '真机器路径要被抓', expect: 'red',
        mutate: () => writeFileSync(join(probeFix, 'references', 'a.md'), 'Run /Users/lute/project/x.sh\n') },
      { case: 'C:/Users/ 正斜杠机器路径要被抓', expect: 'red',
        mutate: () => writeFileSync(join(probeFix, 'references', 'a.md'), 'see C:/Users/CedricChen/.codex/skills/x\n') },
      { case: 'exported-by 一律要被抓（靶单未点名也算）', expect: 'red',
        mutate: () => writeFileSync(join(probeFix, 'SKILL.md'), clean.replace('version:', 'exported-by: MiniMax-hub\nversion:')) },
      { case: '无点名 category 要被抓', expect: 'red',
        mutate: () => writeFileSync(join(probeFix, 'SKILL.md'), clean.replace('version:', 'category: video-generation\nversion:')) },
    ];
    for (const { case: name, expect, mutate } of cases) {
      reset();
      mutate();
      const out = sweepItem({ slug: probeSlug });
      results.push({ case: name, expect, caught: expect === 'green' ? out.problems.length === 0 : out.problems.length > 0,
        detail: out.problems.slice(0, 2) });
    }
  } finally { cleanup(); }
  return results;
}

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) {
  const results = selfTest();
  const failed = results.filter(row => !row.caught);
  console.log(JSON.stringify({ mode: 'sweep-selftest', cases: results.length, failed: failed.length, results }, null, 1));
  process.exitCode = failed.length ? 1 : 0;
} else {
  const only = argv.filter(arg => !arg.startsWith('--'));
  const slugs = only.length ? only : readdirSync(FIX).filter(name => name.endsWith('-gen1')).map(name => name.replace(/-gen1$/, ''));
  const out = slugs.map(slug => sweepItem({ slug }));
  const problems = out.flatMap(row => row.problems.map(text => `${row.slug}: ${text}`));
  writeFileSync(join(BASE, 'zip-candidate-sweep.json'), JSON.stringify({ at: new Date().toISOString(), candidates: out.length,
    withProblems: out.filter(row => row.problems.length).length, problems, rows: out }, null, 1));
  console.log(JSON.stringify({ candidates: out.length, withProblems: out.filter(row => row.problems.length).length,
    problemTotal: problems.length, problems: problems.slice(0, 40), addedFiles: out.reduce((s, r) => s + r.added.length, 0),
    removedFiles: out.reduce((s, r) => s + r.removed.length, 0) }, null, 1));
  process.exitCode = problems.length ? 1 : 0;
}
