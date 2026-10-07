import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, basename, dirname, extname } from 'node:path';

/**
 * 库面卫生登记：只登记、不删除。删除射程超出「标准化」，且这批里 .DS_Store 一类
 * 是 Finder 常态产物，非技能 zip（webapp 模板、BI 导出）是别人的包内资产，剥错就动了源库。
 */

const LIB = process.argv[2] ?? '/Users/lute/project/AgentTools/技能库';
const SKIP = new Set(['node_modules', '.git', '__pycache__']);

function walk(dir, rel, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') { out.push({ rel: r, kind: 'pycache-dir' }); continue; }
      if (SKIP.has(entry.name)) continue;
      if (entry.name === '__MACOSX') { out.push({ rel: r, kind: 'appledouble-dir' }); continue; }
      walk(join(dir, entry.name), r, out);
    } else out.push({ rel: r, kind: 'file', name: entry.name });
  }
  return out;
}

const entries = walk(LIB, '', []);
const files = entries.filter(entry => entry.kind === 'file');
const skillRoots = new Set(files.filter(entry => basename(entry.rel) === 'SKILL.md').map(entry => dirname(entry.rel)));

const categories = {
  ds_store: files.filter(entry => basename(entry.rel) === '.DS_Store').map(entry => entry.rel),
  pycache_dirs: entries.filter(entry => entry.kind === 'pycache-dir').map(entry => entry.rel),
  appledouble_dirs: entries.filter(entry => entry.kind === 'appledouble-dir').map(entry => entry.rel),
  crdownload: files.filter(entry => entry.name.endsWith('.crdownload')).map(entry => entry.rel),
  pem_or_key: files.filter(entry => /\.pem$|\.key$|id_rsa$/i.test(entry.name)).map(entry => entry.rel),
  zip_inside_skill: files.filter(entry => entry.name.toLowerCase().endsWith('.zip') && skillRoots.has(dirname(entry.rel)))
    .map(entry => entry.rel),
  zip_outside_skill_but_packaged: files.filter(entry => entry.name.toLowerCase().endsWith('.zip')
    && !skillRoots.has(dirname(entry.rel))
    && !entry.rel.startsWith('skills/Manus/skill02/') && !entry.rel.startsWith('skills/MinMaxDesign/')
    && !entry.rel.startsWith('_assembly') && !entry.rel.startsWith('paper_to_skills/paper2skills-vault/'))
    .map(entry => entry.rel),
  vault_exports: files.filter(entry => entry.rel.startsWith('paper_to_skills/paper2skills-vault/')
    && entry.name.toLowerCase().endsWith('.zip')).map(entry => entry.rel),
  // 有 SKILL.md 的目录之外、看起来像「一个技能摊平成 .md」的位置：顶层与二级目录的散落 prompt 文件。
  flat_prompt_md: files.filter(entry => entry.name.toLowerCase().endsWith('.md')
    && entry.rel.split('/').length === 2
    && !skillRoots.has(dirname(entry.rel))).map(entry => entry.rel),
  skill_hl_yiwei_prompts: files.filter(entry => entry.rel.startsWith('skill-hl/yiwei-20-seo-prompts-md/')).map(entry => entry.rel),
};

const summary = Object.fromEntries(Object.entries(categories).map(([key, list]) => [key, list.length]));

const problems = [];
if (categories.crdownload.length) problems.push(`仍有 ${categories.crdownload.length} 个未完成下载件（用户称已重下载，需复核 skill-hl 之外位置）`);
if (!summary.ds_store) problems.push('ds_store 计数为 0——遍历可能没跑到（判据失效信号）');

writeFileSync(process.env.OUT ?? join(process.cwd(), 'hygiene-register.json'),
  JSON.stringify({ at: new Date().toISOString(), root: LIB, filesWalked: files.length, skillRoots: skillRoots.size, summary, categories }, null, 1));
console.log(JSON.stringify({ mode: 'hygiene', filesWalked: files.length, skillRoots: skillRoots.size, summary, problems }, null, 1));
