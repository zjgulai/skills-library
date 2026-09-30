#!/usr/bin/env node
/**
 * 版本一致性扫描器（批十一新增）
 *
 * 起因：**正文/文档里的版本残留连续三批命中**——批十产品分析（正文 1.1.0）、批十一产品调研矩阵（维护与退役 1.1.0）、
 * 批十一场景侦察（维护与退役 v1.2.0）。每次都是 frontmatter/manifest 改了版本、正文维护区没跟着改，
 * 判者按"文档自相矛盾"扣分。这个检查器把这类问题在写回前一次性扫出来。
 *
 * 判据（每个技能目录）：
 *  - 取 SKILL.md frontmatter 的 version 作为权威版本；
 *  - 扫 SKILL.md 正文 + README.md 里出现的 `v?X.Y.Z` 版本号；
 *  - 与权威版本不同的，逐条报出（行号 + 该行文本），但**豁免**明显属于历史/迁移说明的行
 *    （含「历史」「迁移」「旧」「v0.」「0.x」等标记）与应用自身版本（如 "Python 3" 之外的语义化版本）。
 *
 * 用法：node skill-lifecycle/trial-home/screening/version-consistency.mjs --library <dir> [--json <out>]
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION_RE = /\bv?(\d+)\.(\d+)\.(\d+)\b/g;
// 历史行豁免：说明性文字 + 变更日志行（表格 `| v1.0.0 | … |` / 列表 `- **v1.0.0** (日期)：…`）。
// 但「**版本**：vX」这类"当前版本声明"不在豁免内——它正是判者扣分的那种残留。
const HISTORICAL = /(历史|迁移|legacy|deprecated|旧版|旧生态|旧评估|旧报告|mv\b|renamed|was\s+v?\d)/i;
const CHANGELOG = /^(\|\s*v?\d+\.\d+\.\d+\s*\||\s*[-*]?\s*\*\*v?\d+\.\d+\.\d+\*\*)/;
// 其它轴与示例：`配套 Eval 版本`、反引号包裹的示例值（如修复配方里的 `version: "1.0.0"`）
const OTHER_AXIS = /(Eval 版本|Schema 版本|Universal Skill Schema|指南版本|python|pandas|node)/i;
// 变更日志小标题（### v1.0.0）同样属于历史
const CHANGELOG_HEADING = /^#{2,4}\s*v?\d+\.\d+\.\d+/;
// 「版本」声明槽（`**版本**: X` / `版本：X`）里的值就是当前版本声明。必须在其它轴整行豁免
// 之前判定——2026-09-29 实测：`**版本**: 1.1.0 | **Schema 版本**: 1.1.0` 因同行含「Schema 版本」
// 被 OTHER_AXIS 整行放过，扫描器对它本该抓的槽位残留静默假绿（正例注入证伪）。
const SLOT = /(^|[|｜])\s*[-*]?\s*\*{0,2}版本\*{0,2}[:：]\s*$/;
const inVersionSlot = (line, index) => SLOT.test(line.slice(0, index));

function flag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

const baselineName = dir => dir.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? dir;

function parseFrontmatterVersion(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const front = text.slice(3, end);
  const match = front.match(/^version:\s*"?([^"\n]+)"?\s*$/m);
  return match ? match[1].trim() : null;
}

function scanVersions(text, { skipFrontmatter = false, authoritative = null } = {}) {
  let body = text;
  if (skipFrontmatter && text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) body = text.slice(end + 4);
  }
  const hits = [];
  const fenced = [];
  const lines = body.split('\n');
  let inFence = false;
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) {
      // 代码围栏里的是**示例/模板**（如 frontmatter 模板里的 `version: "1.0.0"`、依赖钉版），
      // 不是本包的版本声明。豁免但**留痕**（fenced 计数进报告，绝不静默）。
      VERSION_RE.lastIndex = 0;
      let fencedMatch;
      while ((fencedMatch = VERSION_RE.exec(line)) !== null) {
        if (Number(fencedMatch[1]) >= 1900) continue;
        fenced.push({ line: index + 1, version: `${fencedMatch[1]}.${fencedMatch[2]}.${fencedMatch[3]}` });
      }
      continue;
    }
    VERSION_RE.lastIndex = 0;
    let match;
    while ((match = VERSION_RE.exec(line)) !== null) {
      const version = `${match[1]}.${match[2]}.${match[3]}`;
      // 年份开头（如 2026.03.15）是日期不是版本，跳过
      if (Number(match[1]) >= 1900) continue;
      // 「版本：」槽位声明优先判（不受同行其它轴豁免影响）
      if (inVersionSlot(line, match.index)) {
        hits.push({ line: index + 1, version, text: line.trim().slice(0, 160) });
        continue;
      }
      // 同一行里出现权威版本 ⇒ 这行讲的就是当前版本（如「版本: 2.2.0 | Schema 版本: 1.1.0」、或"从 v2.0.0 修复到 v2.0.1"），不算残留
      if (authoritative && version !== authoritative && line.includes(authoritative)) continue;
      if (OTHER_AXIS.test(line)) continue;
      if (new RegExp('`[^`]*' + version.replace(/\./g, '\\.') + '[^`]*`').test(line)) continue;
      // 历史豁免只看**命中点附近**的窗口：早先按整行判，行尾随便出现 "deprecated" 就会
      // 把行中的版本残留一起豁免（2026-09-29 实测：一行「**版本**：v2.0.1；…标deprecated」被放过）。
      const window = line.slice(Math.max(0, line.indexOf(version) - 40), line.indexOf(version) + 60);
      // 「本版本/当前版本」这类**当前版本声明**即使同行出现"历史"也不豁免
      // （实测：一行「本版本 v1.0.1，历史版本见 git 记录」被窗口豁免吃掉）
      const CURRENT_CUE = /(本版本|当前版本|现版本|版本[:：]|\*\*version\*\*)/;
      if (CURRENT_CUE.test(window)) {
        hits.push({ line: index + 1, version, text: line.trim().slice(0, 160) });
        continue;
      }
      if (HISTORICAL.test(window)) continue;
      hits.push({ line: index + 1, version, text: line.trim().slice(0, 160) });
    }
  }
  return { hits, fenced };
}

async function main(argv) {
  const library = flag(argv, 'library');
  if (!library) {
    process.stderr.write('Usage: node version-consistency.mjs --library <dir> [--json <out>]\n');
    return 2;
  }
  // 库结构是 <library>/<族>/<技能>/SKILL.md（两层），别只扫一层——那会得到假绿
  // （2026-09-29 实测：只扫一层时全库"0 处不一致"，其实一个技能都没扫到）。
  const skills = [];
  // 两种布局都支持：库（<族>/<技能>/SKILL.md）与候选区（<技能>/SKILL.md）。
  // 只认一种会得到假绿——候选区跑出「0 个技能」时其实是没扫到（2026-09-29 二次踩到）。
  const candidates = [];
  // 第三种布局：--library 直接指向单个技能目录（自检常用形态；2026-09-29 实测漏支持 ⇒ 静默 0 处假绿）
  let rootIsSkill = false;
  try { await readFile(join(library, 'SKILL.md'), 'utf8'); rootIsSkill = true; } catch { /* 非技能根 */ }
  if (rootIsSkill) candidates.push({ dir: library, label: baselineName(library) });
  const families = rootIsSkill ? [] : await readdir(library, { withFileTypes: true });
  for (const family of families) {
    if (!family.isDirectory()) continue;
    const direct = join(library, family.name, 'SKILL.md');
    let isSkill = false;
    try { await readFile(direct, 'utf8'); isSkill = true; } catch { /* 不是技能目录 */ }
    if (isSkill) { candidates.push({ dir: join(library, family.name), label: family.name }); continue; }
    let children;
    try { children = await readdir(join(library, family.name), { withFileTypes: true }); } catch { continue; }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      candidates.push({ dir: join(library, family.name, child.name), label: `${family.name}/${child.name}` });
    }
  }
  let scanned = 0;
  const fenced = [];
  for (const candidate of candidates) {
    {
      const dir = candidate.dir;
      let skillMd;
      try { skillMd = await readFile(join(dir, 'SKILL.md'), 'utf8'); } catch { continue; }
      const authoritative = parseFrontmatterVersion(skillMd);
      if (!authoritative) continue;
      scanned += 1;
      const findings = [];
      const fencedHits = [];
      const mdScan = scanVersions(skillMd, { skipFrontmatter: true, authoritative });
      for (const hit of mdScan.hits) {
        if (hit.version === authoritative) continue;
        // 历史豁免已在 scanVersions 内按**命中点窗口**判过；这里只再排变更日志样式的行
        if (CHANGELOG.test(hit.text) || CHANGELOG_HEADING.test(hit.text)) continue;
        findings.push({ file: 'SKILL.md', ...hit });
      }
      fencedHits.push(...mdScan.fenced.map(f => ({ file: 'SKILL.md', ...f })));
      try {
        const readme = await readFile(join(dir, 'README.md'), 'utf8');
        const readmeScan = scanVersions(readme, { authoritative });
        for (const hit of readmeScan.hits) {
          if (hit.version === authoritative) continue;
          if (CHANGELOG.test(hit.text)) continue;
          findings.push({ file: 'README.md', ...hit });
        }
        fencedHits.push(...readmeScan.fenced.map(f => ({ file: 'README.md', ...f })));
      } catch { /* README 可选 */ }
      if (findings.length) skills.push({ dir: candidate.label, authoritative, findings });
      if (fencedHits.length) fenced.push({ dir: candidate.label, hits: fencedHits });
    }
  }
  if (candidates.length === 0 || scanned === 0) {
    process.stderr.write(`扫描器警告：--library 下没有解析到任何技能目录（0 个候选），这不是"零残留"而是没扫到。\n`);
    return 2;
  }
  const report = { library, skills: skills.length, total: skills.reduce((sum, s) => sum + s.findings.length, 0),
    fencedExempt: fenced.reduce((sum, s) => sum + s.hits.length, 0), fencedRows: fenced, rows: skills };
  const jsonPath = flag(argv, 'json');
  if (jsonPath) await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  for (const skill of skills) {
    console.log(`- ${skill.dir}（frontmatter ${skill.authoritative}）`);
    for (const f of skill.findings) console.log(`    ${f.file}:${f.line} → ${f.version} ｜ ${f.text}`);
  }
  if (report.fencedExempt > 0) {
    console.log(`\n代码围栏内版本（示例/模板，已豁免但留痕）：${report.fencedExempt} 处`);
    for (const row of report.fencedRows) {
      for (const hit of row.hits) console.log(`    ${row.dir} ${hit.file}:${hit.line} → ${hit.version}`);
    }
  }
  console.log(`\n版本不一致：${report.skills} 个技能 / ${report.total} 处${jsonPath ? `（明细 ${relative(process.cwd(), jsonPath)}）` : ''}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
