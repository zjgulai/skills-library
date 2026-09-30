#!/usr/bin/env node
/**
 * 跨技能旧名引用·替换计划生成器（P2 新增；只产计划，不动盘）
 *
 * 输入：stale-ref-audit 的 JSON（pointer/other 两类为候选）。
 * 输出：
 *   - `<out>.json`：skill-repair-text.mjs 可直接跑的计划（ops = 逐行 find/replace），
 *     `find` 用**整行原文**（同文件重复行按出现次数计），`replace` 为把候选名替换成
 *     `kebab（中文名）` 后的行——未加注的才替换，已带 kebab 注记的原样保留。
 *   - `<out>.review.md`：逐行 before → after 对照表，供人复核后再 apply。
 *
 * 用法：
 *   node stale-ref-plan.mjs --library <库根> --audit <audit.json> --out <plan.json> [--classes pointer,other]
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

// 只在**指针动词位**替换：名前面紧跟 使用/改用/交给/路由到/转交/回流/转给（允许一个全角空格或半角空格）。
// 这样避开四类误伤：①触发词清单（用户话术，必须保持中文）；②既有 `kebab（中文）`/「技能「中文」」注记；
// ③名词短语（「自然社媒内容」「广告创意用例」）；④表格/正文里当主题词的引用。
const POINTER_BEFORE = /(使用|改用|交给|路由到|转交|回流|转给|用于)\s?$/;

function replaceNamesInLine(line, hits) {
  let out = line;
  for (const { name, kebab } of hits) {
    const result = [];
    let cursor = 0;
    while (true) {
      const index = out.indexOf(name, cursor);
      if (index === -1) { result.push(out.slice(cursor)); break; }
      const before = out.slice(0, index);
      if (!POINTER_BEFORE.test(before)) { result.push(out.slice(cursor, index + name.length)); cursor = index + name.length; continue; }
      const spaced = /[\u4e00-\u9fff]$/.test(before) ? ' ' : '';
      result.push(out.slice(cursor, index), `${spaced}${kebab}（${name}）`);
      cursor = index + name.length;
    }
    out = result.join('');
  }
  return out;
}

async function main(argv) {
  const flag = name => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const library = flag('library');
  const auditPath = flag('audit');
  const outPath = flag('out');
  const classes = (flag('classes') ?? 'pointer,other').split(',').map(s => s.trim());
  if (!library || !auditPath || !outPath) {
    process.stderr.write('Usage: node stale-ref-plan.mjs --library <dir> --audit <audit.json> --out <plan.json> [--classes pointer,other]\n');
    return 2;
  }
  const audit = JSON.parse(await readFile(auditPath, 'utf8'));
  const byFileLine = new Map();
  for (const hit of audit.hits) {
    if (!classes.includes(hit.class)) continue;
    const key = `${hit.file}::${hit.line}`;
    if (!byFileLine.has(key)) byFileLine.set(key, { file: hit.file, line: hit.line, names: [] });
    const entry = byFileLine.get(key);
    if (!entry.names.some(n => n.name === hit.name)) entry.names.push({ name: hit.name, kebab: hit.kebab });
  }
  const fileCache = new Map();
  const ops = [];
  const review = [];
  const skipped = [];
  for (const { file, line, names } of byFileLine.values()) {
    if (!fileCache.has(file)) fileCache.set(file, await readFile(join(library, file), 'utf8'));
    const text = fileCache.get(file);
    const rawLines = text.split('\n');
    const raw = rawLines[line - 1];
    if (raw === undefined) continue;
    // 闸门：.md 文件的 frontmatter 区（description 是路由面）一律不动——批量替换只在正文。
    if (file.endsWith('.md') && rawLines[0] === '---') {
      const close = rawLines.indexOf('---', 1);
      if (close !== -1 && line >= 1 && line <= close + 1) {
        skipped.push({ file, line, reason: 'FRONTMATTER（description/元数据区不改）', text: raw.trim().slice(0, 120) });
        continue;
      }
    }
    // 行级闸门：触发词清单与既有注记整行跳过；且只替换"指针动词位"的出现。
    if (/触发词|触发\s*[:：]|\.\s*trigger/i.test(raw)) { skipped.push({ file, line, reason: 'TRIGGER_LIST', text: raw.trim().slice(0, 120) }); continue; }
    if (/技能「/.test(raw)) { skipped.push({ file, line, reason: 'EXISTING_ANNOTATION（技能「」注记）', text: raw.trim().slice(0, 120) }); continue; }
    if (names.some(n => raw.includes(n.kebab))) { skipped.push({ file, line, reason: 'KEBAB_ALREADY_PRESENT', text: raw.trim().slice(0, 120) }); continue; }
    const replaced = replaceNamesInLine(raw, names);
    if (replaced === raw) { skipped.push({ file, line, reason: 'NO_CHANGE（出现都在注记里）', text: raw.trim().slice(0, 120) }); continue; }
    // 同一文件里**逐字相同**的行只出一条 op：find=整行会一次性替换该行全部出现，
    // 重复出 op 会让第二条撞上 COUNT_MISMATCH（0 处）——那是自造的噪点。
    const dedupeKey = `${file}\u0000${raw}`;
    if (ops.some(op => op._key === dedupeKey)) { skipped.push({ file, line, reason: 'DUPLICATE_LINE（同文件同文行已并入首条 op）' }); continue; }
    const count = rawLines.filter(l => l === raw).length;
    ops.push({ _key: dedupeKey, kind: 'replace', relPath: file, find: raw, replace: replaced, expectCount: count });
    review.push({ file, line, count, before: raw.trim().slice(0, 180), after: replaced.trim().slice(0, 200) });
  }
  // expectSha256 在跨文件共享同一文件时会因前一处改动而失效——按文件分组，链式给哈希太脆；
  // 这里对**同一文件**的多条 op 只保留最后一条给哈希？不：逐条都不给哈希，改为在 apply 前
  // 由执行器按 COUNT 闸门兜底（find 是整行原文，改动不会误伤别处）；apply 后逐文件复核。
  const plan = { record_type: 'library_text_plan', at: new Date().toISOString().slice(0, 10),
    library, policy: 'P2 跨技能旧名引用替换：把指向已 kebab 化技能的**裸中文名引用**替换为 `kebab（中文）`；'
      + 'find 用整行原文（同文件重复行按次数），未加注的出现才替换。候选＝audit 的 pointer/other 两类；'
      + 'topic/heading/annotated/compound 不动（名词短语、标题、已注记）。',
    ops: ops.map(({ _key, ...rest }) => rest) };
  await writeFile(outPath, `${JSON.stringify(plan, null, 2)}\n`);
  const md = ['# 跨技能旧名引用替换·复核表', '',
    `- 计划：${ops.length} 行；跳过：${skipped.length} 行`, ''];
  for (const r of review) md.push(`- \`${r.file}:${r.line}\``, `  - 前：${r.before}`, `  - 后：${r.after}`);
  if (skipped.length) { md.push('', '## 跳过'); for (const s of skipped) md.push(`- \`${s.file}:${s.line}\`（${s.reason}）`); }
  await writeFile(`${outPath.replace(/\.json$/, '')}.review.md`, `${md.join('\n')}\n`);
  console.log(`计划 ${ops.length} 行（跳过 ${skipped.length}）；复核表 ${relative(process.cwd(), outPath.replace(/\.json$/, '.review.md'))}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
