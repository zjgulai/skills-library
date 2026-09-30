import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { looksOpaque } from '../../control/skill-screen.mjs';

/**
 * 不透明容器普查：把「整份不可读」与「只坏了辅助件」分开计数，产出一份可复核的登记表。
 *
 * 为什么只登记不修：容器不可解码（解压器全败、明文探针 0 命中），恢复路径是**换权威源**
 * （库内可读孪生 / git 历史）。在拿到权威源之前，任何"猜着补"都是在技能库里造新内容。
 */
const skippedDirs = new Set(['node_modules', '.git']);

async function walk(root, prefix = '', collected = []) {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (skippedDirs.has(entry.name) || entry.isSymbolicLink()) continue;
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walk(root, relPath, collected);
    else if (entry.isFile()) collected.push(relPath);
  }
  return collected;
}

export async function census(root) {
  const files = [];
  for (const relPath of await walk(root)) {
    const handle = await readFile(join(root, relPath));
    if (!looksOpaque(handle.subarray(0, 8))) continue;
    files.push({ relPath, bytes: handle.length });
  }
  const byDir = new Map();
  for (const file of files) {
    const parts = file.relPath.split('/');
    const owner = /SKILL\.md$/.test(file.relPath)
      ? parts.slice(0, -1).join('/')
      : (parts.length > 1 ? parts.slice(0, 2).join('/') : parts[0]);
    if (!byDir.has(owner)) byDir.set(owner, { dir: owner, files: [], skillFile: false });
    const entry = byDir.get(owner);
    entry.files.push(file.relPath);
    if (/SKILL\.md$/.test(file.relPath)) entry.skillFile = true;
  }
  const dirs = [...byDir.values()].map(entry => ({ dir: entry.dir, count: entry.files.length,
    skillFile: entry.skillFile, samples: entry.files.slice(0, 4) }))
    .sort((left, right) => (right.skillFile ? 1 : 0) - (left.skillFile ? 1 : 0) ||
      right.count - left.count || left.dir.localeCompare(right.dir));
  return { total: files.length, skills: dirs.filter(entry => entry.skillFile).length,
    auxiliaryFiles: files.filter(file => !/SKILL\.md$/.test(file.relPath)).length, dirs, files };
}

async function main(argv) {
  const flag = name => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  const root = flag('root');
  if (!root) {
    process.stderr.write('Usage: node opaque-census.mjs --root <dir> [--json <out>] [--md <out>]\n');
    return 2;
  }
  const report = await census(root);
  const jsonPath = flag('json');
  if (jsonPath) await writeFile(jsonPath, `${JSON.stringify({ root, at: new Date().toISOString(), ...report }, null, 2)}\n`);
  const mdPath = flag('md');
  if (mdPath) {
    const lines = [`# 不透明容器登记（${root}）`, '',
      `- 不透明文件 **${report.total}** 个：其中 **${report.skills}** 份技能是 \`SKILL.md\` 整份不可读，`,
      `  其余 **${report.auxiliaryFiles}** 个是辅助件（技能本体可读、包内资源残缺）。`,
      '- 容器特征：魔数 `88 7d 1c` + 4096 字节头 + 高熵正文；长度恒等于明文 + 4096。',
      '- 处置：**不解码**（解压器全进程全偏移全败、明文探针 0 命中）——恢复路径是换权威源。', '',
      '| 位置 | 文件数 | SKILL.md | 样例 |', '| --- | ---: | :---: | --- |'];
    for (const entry of report.dirs) {
      lines.push(`| \`${entry.dir}\` | ${entry.count} | ${entry.skillFile ? '**是**' : '—'} | ${entry.samples.map(name => `\`${name.split('/').slice(-2).join('/')}\``).join('、')} |`);
    }
    lines.push('');
    await mkdir(dirname(mdPath), { recursive: true });
    await writeFile(mdPath, `${lines.join('\n')}\n`);
  }
  process.stdout.write(`${JSON.stringify({ total: report.total, skills: report.skills,
    auxiliaryFiles: report.auxiliaryFiles, dirs: report.dirs.length,
    json: jsonPath ? relative(process.cwd(), jsonPath) : null,
    md: mdPath ? relative(process.cwd(), mdPath) : null }, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
