import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, normalize, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 第 ③ 步的只读分析：把 `REFERENCED_FILE_MISSING` 逐条分类，产出可批的处置建议。
 *
 * 四类（判据都在**路径**上，不需要读正文）：
 * - `placeholder`：`xxx` / `0X` 一类占位 —— 建议清洗（删引用或改写成说明）；
 * - `resolved`：把引用按技能目录解析后，库里**确有**这个文件 —— 建议改引用路径（多为 `../..` 写歪）；
 * - `elsewhere`：库内别处有**同名文件** —— 建议补进包内（从那份复制）或改写引用指向；
 * - `missing`：库里找不到 —— 要么补写文件，要么删引用，需人拍板。
 *
 * 只读：本工具不写技能库。
 */
const placeholderPattern = /^(?:x{2,}|X{2,}|0x|xxx|yyy|zzz|your[-_]?|name[-_]?of)/i;

export async function auditReferences({ library, screen }) {
  const skills = screen.skills ?? [];
  const paths = new Set(screen.__paths ?? []);
  const byBase = new Map();
  for (const path of paths) {
    const base = basename(path);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(path);
  }
  const entries = [];
  for (const skill of skills) {
    const directory = skill.relPath.slice(0, skill.relPath.length - 'SKILL.md'.length);
    for (const item of skill.findings.filter(finding => finding.code === 'REFERENCED_FILE_MISSING')) {
      const reference = item.detail;
      const resolvedPath = normalize(join(directory, reference)).replace(/\\/g, '/');
      let kind;
      let candidates = [];
      if (placeholderPattern.test(reference)) {
        kind = 'placeholder';
      } else if (paths.has(resolvedPath)) {
        kind = 'resolved';
        candidates = [resolvedPath];
      } else {
        const hits = (byBase.get(basename(reference)) ?? []).filter(path => path !== resolvedPath);
        if (hits.length > 0) { kind = 'elsewhere'; candidates = hits.slice(0, 3); }
        else kind = 'missing';
      }
      entries.push({ skill: skill.relPath, directory, reference, kind, resolvedPath, candidates });
    }
  }
  const counts = {};
  for (const entry of entries) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
  return { total: entries.length, counts, entries };
}

async function main(argv) {
  const flag = name => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  const library = flag('library');
  const screenPath = flag('screen');
  if (!library || !screenPath) {
    process.stderr.write('Usage: node reference-audit.mjs --library <dir> --screen <screen.json> [--json <out>] [--md <out>]\n');
    return 2;
  }
  const screen = JSON.parse(await readFile(screenPath, 'utf8'));
  // 复核用的全树路径清单：筛查报告里每份技能只被给出 SKILL.md，所以这里重新走一遍目录树。
  const paths = [];
  const skippedDirs = new Set(['node_modules', '.git']);
  async function walk(prefix = '') {
    for (const entry of await readdir(join(library, prefix), { withFileTypes: true })) {
      if (skippedDirs.has(entry.name) || entry.isSymbolicLink()) continue;
      const relPath = `${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`;
      if (entry.isDirectory()) await walk(relPath);
      else paths.push(relPath);
    }
  }
  await walk();
  const report = await auditReferences({ library, screen: { ...screen, __paths: paths } });
  const jsonPath = flag('json');
  if (jsonPath) await writeFile(jsonPath, `${JSON.stringify({ library, screen: screenPath, ...report }, null, 2)}\n`);
  const mdPath = flag('md');
  if (mdPath) {
    const lines = ['# 引用缺失逐条分类（只读分析）', '',
      `共 **${report.total}** 条：${Object.entries(report.counts).map(([k, v]) => `${k} ${v}`).join(' / ')}`, ''];
    const groups = new Map();
    for (const entry of report.entries) {
      if (!groups.has(entry.kind)) groups.set(entry.kind, []);
      groups.get(entry.kind).push(entry);
    }
    for (const [kind, list] of groups) {
      lines.push(`## ${kind}（${list.length}）`, '', '| 技能 | 引用 | 解析后 | 候选 |', '| --- | --- | --- | --- |');
      for (const entry of list) {
        lines.push(`| \`${entry.directory}\` | \`${entry.reference}\` | \`${entry.resolvedPath}\` | ${entry.candidates.map(c => `\`${c}\``).join('、') || '—'} |`);
      }
      lines.push('');
    }
    await writeFile(mdPath, `${lines.join('\n')}\n`);
  }
  process.stdout.write(`${JSON.stringify({ total: report.total, counts: report.counts,
    json: jsonPath ? relative(process.cwd(), jsonPath) : null,
    md: mdPath ? relative(process.cwd(), mdPath) : null }, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
