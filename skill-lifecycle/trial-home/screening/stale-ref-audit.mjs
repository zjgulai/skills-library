#!/usr/bin/env node
/**
 * 跨技能旧名引用审计（P2 新增）
 *
 * 对象：已完成 kebab 化的技能，其**中文原名**在其他技能正文/脚本里仍被引用。
 * 本工具**只分类、不改盘**：把每条命中按上下文分成 pointer / heading / topic / other，
 * 并给出建议动作，供人（或下一轮的 agent）逐条复核后走 `skill-repair-text.mjs` 动盘。
 *
 * 用法：
 *   node stale-ref-audit.mjs --library <技能库根> --mapping <kebab-mapping.json> --out <audit.json>
 *
 * 分类口径（保守——宁多判 review 也不误判 replace）：
 *   - heading：行是 Markdown 小标题（# 开头），命中只是标题里的主题词 → keep
 *   - topic  ：命中出现在「、」「/」「，」连接的话题列举里，或独占一个列表项 → keep（复核）
 *   - pointer：命中附近有路由动词（使用/交给/路由/回流/不要用于/应路由/→ 等），
 *              或行形如 yaml 依赖项（`- 名字`）→ 建议 replace-with-kebab
 *   - other  ：其余 → review
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXT = new Set(['.md', '.yaml', '.yml', '.json', '.py']);
const ROUTING = /(使用|交给|路由|回流|不要用于|应路由|协作调用|见\s*`?|参考\s*`?|→|->|vs\s|用于)/;
const SKIP_DIRS = new Set(['node_modules', '.git']);
// 技能包内的这些子目录不是"路由文本"：tests/ 是夹具（改它会动测试语义）、
// data/ 与研究语料（paper_to_skills 的 contracts 里有几千行主题词）、eval-reports/ 是归档件。
const SKIP_SUBPATHS = ['/tests/', '/data/', '/eval-reports/', '/fixtures/'];

async function walk(root, prefix = '', out = []) {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(root, prefix ? `${prefix}/${entry.name}` : entry.name, out);
    } else out.push(prefix ? `${prefix}/${entry.name}` : entry.name);
  }
  return out;
}

export function classifyLine(line, name, kebab) {
  const trimmed = line.trim();
  // 已带 kebab 注记（`kebab（中文）`）⇒ 无需动作（历批修过的正确形态）。
  if (kebab && new RegExp(`\`?${kebab}\`?\\s*[（(]\\s*${name}\\s*[）)]`).test(trimmed)) return 'annotated';
  // 名词复合（「广告创意用例」「市场可行性审计报告」）⇒ 命中是长名词的一部分，不是引用。
  if (new RegExp(`${name}(用例|清单|报告|方案|流程|模板|规范|指南|示例|设计|文案|建议|诊断|服务|平台|系统|工具|包|集)`).test(trimmed)) return 'compound';
  if (/^#{1,6}\s/.test(trimmed)) return 'heading';
  const index = trimmed.indexOf(name);
  const window = trimmed.slice(Math.max(0, index - 30), index + name.length + 30);
  if (new RegExp(`^[-*]\\s*\`?${name}\`?\\s*$`).test(trimmed)) return 'topic';
  // 话题列举：整行是 `/`、`、` 分隔的话题串（≥3 段）且命中只是其中一段 ⇒ 是名词话题，不是路由引用
  // （实测：「Listing 优化 / 广告投放 / 邮件营销 / 社媒内容 / 品牌设计 …」里的「社媒内容」不是技能）。
  const segments = trimmed.split(/\s*[/｜|、]\s*/).filter(Boolean);
  if (segments.length >= 3 && segments.some(seg => seg === name || seg === `**${name}**`)) return 'topic';
  if (new RegExp(`${name}\\s*等`).test(trimmed)) return 'topic';
  // 依赖清单行：`- 名字`（yaml 或 md 列表）——机器可读引用，建议 kebab
  if (new RegExp(`^[-*]\\s*\`?${name}\`?([（(]|\\s*$)`).test(trimmed)) return 'pointer';
  if (ROUTING.test(window)) return 'pointer';
  // 话题列举：命中紧邻顿号/斜杠/逗号
  const before = trimmed[index - 1] ?? '';
  const after = trimmed[index + name.length] ?? '';
  if ('、/，,｜|'.includes(before) || '、/，,｜|'.includes(after)) return 'topic';
  return 'other';
}

async function main(argv) {
  const flag = name => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const library = flag('library');
  const mappingPath = flag('mapping');
  const outPath = flag('out');
  if (!library || !mappingPath || !outPath) {
    process.stderr.write('Usage: node stale-ref-audit.mjs --library <dir> --mapping <mapping.json> --out <audit.json>\n');
    return 2;
  }
  const mapping = JSON.parse(await readFile(mappingPath, 'utf8'));
  const renamed = mapping.entries.filter(e => e.status === 'completed'
    && [...e.name].some(ch => ch >= '\u4e00' && ch <= '\u9fff'));
  const files = await walk(library);
  const hits = [];
  // 只认"技能包内"的文件：所在目录链上必须有一个含 SKILL.md 的目录（技能根），
  // 且不在 tests/、data/、eval-reports/、fixtures/ 里——那些不是路由文本（实测：研究语料
  // 一处就贡献 200+ 行命中，全是假阳性）。
  const skillRoots = new Set(files.filter(rel => rel === 'SKILL.md' || rel.endsWith('/SKILL.md'))
    .map(rel => rel.slice(0, rel.length - 'SKILL.md'.length)));
  const inSkillPackage = rel => [...skillRoots].some(root => rel.startsWith(root))
    && !SKIP_SUBPATHS.some(segment => rel.includes(segment));
  const textual = files.filter(rel => EXT.has(rel.slice(rel.lastIndexOf('.'))) && inSkillPackage(rel));
  for (const rel of textual) {
    let text;
    try { text = await readFile(join(library, rel), 'utf8'); } catch { continue; }
    if (!renamed.some(e => text.includes(e.name))) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      for (const entry of renamed) {
        if (!lines[i].includes(entry.name)) continue;
        if (rel.startsWith(`${entry.kebab}/`) || rel.includes(`/${entry.kebab}/`)) continue;
        const cls = classifyLine(lines[i], entry.name, entry.kebab);
        hits.push({ name: entry.name, kebab: entry.kebab, file: rel, line: i + 1,
          class: cls, text: lines[i].trim().slice(0, 200) });
      }
    }
  }
  const byClass = {};
  for (const hit of hits) byClass[hit.class] = (byClass[hit.class] ?? 0) + 1;
  const byName = {};
  for (const hit of hits) {
    const key = `${hit.name} → ${hit.kebab}`;
    byName[key] = byName[key] ?? { pointer: 0, heading: 0, topic: 0, other: 0, annotated: 0, compound: 0 };
    byName[key][hit.class] += 1;
  }
  const report = { record_type: 'stale_ref_audit', at: new Date().toISOString().slice(0, 10),
    library, renamedSkills: renamed.length, filesScanned: textual.length, totalHits: hits.length,
    byClass, byName, hits };
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`命中 ${hits.length} 处（文件 ${textual.length} 个，改名技能 ${renamed.length} 个）`);
  console.log(`分类：${JSON.stringify(byClass)}`);
  console.log(`明细 → ${relative(process.cwd(), outPath)}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
