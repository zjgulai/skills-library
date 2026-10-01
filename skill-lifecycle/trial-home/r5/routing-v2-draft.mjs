#!/usr/bin/env node
/**
 * R-5 词表草案 v2 的路由原型（**决策验证器，非 v1.1 生产者**）。
 *
 * 作用：把《v2 词表增补草案》编码成可执行规则，对**历史样本**（110 号 packet-b 的 200 行）
 * 出"草案路由率 vs 人工判断率（189/200＝94.5%）"的对照读数，供拍板参考。
 * **不读写任何台账；不产出 v1.1；只写 123-r5-decisions/ 下的统计 JSON。**
 *
 * 归属纪律（123 号 §2）：只可作用于"未归类"池的行；本原型仅喂样本行，天然满足。
 *
 * 用法：node skill-lifecycle/trial-home/r5/routing-v2-draft.mjs --sample <packet-b.json> \
 *        [--library <技能库根>] [--out <stats.json>] [--examples 20]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const S = (arr) => arr.map(t => ({ t, w: 'S' }));
const W = (arr) => arr.map(t => ({ t, w: 'W' }));

export const TABLE = {
  shared: {
    研发与代码: [...S(['code', 'git', 'github', 'gitlab', 'sdk', 'compiler', 'runtime', 'kernel', 'openclaw', 'mcp', 'test',
      'claude', 'gemini', 'gpt', 'llm', 'ide', 'vscode', 'terminal', 'cli', 'script', 'security']),
      ...W(['programming', 'unit', 'ci', 'pipeline', 'pull', 'merge', 'commit', 'review', 'codebase', 'repo', 'library', 'api',
        'workflow', 'automation', 'dependency', 'subagent', 'agent', 'tool', 'refactor*', 'debug*',
        'implement*', 'develop*', 'engineer*', 'architecture', 'framework', 'pattern', 'model', 'isolation', 'sandbox', 'standalone', 'nexus'])],
    数据: [...S(['dataset', 'etl', 'warehouse', 'sql', 'query', 'schema', 'scraping', 'excel', 'csv', 'json', 'parquet', 'statistics', 'rag', 'embedding']),
      ...W(['data', 'record', 'validation', 'cleaning', 'segment', 'metric', 'memory', 'knowledge', 'semantic', 'search', 'find', 'extract*',
        'stat', 'processing', 'raw', 'tracking', 'analytics'])],
    文档与知识: [...S(['documentation', 'readme', 'changelog', 'markdown', 'wiki']),
      ...W(['doc', 'note', 'summar*', 'writing', 'organiz*', 'report', 'text', 'file', 'content', 'guidance', 'practice', 'instruction',
        'spec', 'openspec', 'sync', 'translat*', 'map', 'about'])],
    创意文档: [...S(['copywriting', 'story', 'narrative', 'brand', 'marketing']),
      ...W(['creative', 'article', 'prompt', 'template', 'generat*', 'creat*', 'copy', 'tone', 'voice'])],
    图像视频: [...S(['image', 'photo', 'video', 'audio', 'music', 'logo', 'poster', 'animation', 'storyboard', 'subtitle']),
      ...W(['design', 'visual', 'render*', 'sprite', 'screenshot'])],
    产品设计: [...S(['ui', 'ux', 'figma', 'wireframe', 'prototype']),
      ...W(['component', 'landing', 'interface', 'onboarding', 'user story'])],
    网站与部署: [...S(['deploy*', 'hosting', 'nginx', 'docker', 'kubernetes', 'vercel', 'netlify', 'cloudflare', 'aws']),
      ...W(['domain', 'dns', 'server', 'application', 'web', 'build'])],
    本地诊断: [...S(['diagnos*', 'incident', 'crash', 'benchmark']),
      ...W(['log', 'monitor*', 'performance', 'error', 'issue', 'status', 'check', 'maintenance', 'calibration', 'reminder', 'alert'])],
    通用研究: [...S(['research', 'arxiv', 'literature', 'survey']),
      ...W(['analysis', 'analyze', 'market', 'paper', 'insight', 'learning', 'structured', 'decision', 'matrix', 'score', 'criteria',
        'option', 'strategy', 'framework', 'best practice'])],
    协作与外部工具: [...S(['slack', 'discord', 'telegram', 'notion', 'obsidian', 'calendar', 'feishu', 'lark', 'dingtalk', 'wechat']),
      ...W(['email', 'jira', 'linear', 'ticket', 'team', 'collaboration', 'context', 'session', '飞书', '钉钉', 'card', 'message', 'send', 'reader'])],
    演示与内容: [...S(['presentation', 'slides', 'deck']), ...W(['ppt', 'social', 'influencer'])],
  },
  other: {
    个人娱乐: [...S(['pet', 'diary', 'travel', 'fitness', 'adhd', 'parenting', 'recipe', 'fashion', 'anime', 'comic']),
      ...W(['journal', 'personal', 'mood', 'student', 'resident', 'visitor', 'countdown', 'birthday', 'anniversary', '纪念日', '倒数', '日历'])],
    游戏: [...S(['unity', 'unreal', 'godot', 'minecraft', 'steam']), ...W(['game', 'gaming'])],
  },
};

const CJK = /[\u4e00-\u9fff]/;

/** 词条 → 匹配器：CJK 按子串；ASCII 默认词边界（可带 s/es），显式 `*` 后缀才放开通配词干。 */
export function matcher(term) {
  if (CJK.test(term)) return source => source.includes(term);
  const t = term.toLowerCase();
  const body = t.endsWith('*') ? `${t.slice(0, -1)}[a-z0-9_-]*` : `${t}(?:s|es)?`;
  const re = new RegExp(`(?:^|[^a-z0-9_])${body}(?![a-z0-9_])`, 'i');
  return source => re.test(source);
}

const norm = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** 占位/模板守卫：模板占位行一律留待核，不硬填（规范 §4：禁止用共享吸收判不准的行）。 */
export const PLACEHOLDER = /<[^<>]{0,80}>|your[-_ ]skill|placeholder|\btodo\b|待填|占位|模板占位|brief description of what/i;

export function isPlaceholder({ name, desc }) {
  return PLACEHOLDER.test(String(name ?? '')) || PLACEHOLDER.test(String(desc ?? ''));
}

/** 单行路由：返回 {bucket:'shared:<label>'|'other:<label>'|null, via, why}。null＝留给待核（含歧义/占位）。 */
export function classifyOne({ name, desc }) {
  if (isPlaceholder({ name, desc })) return { bucket: null, why: 'placeholder', via: [] };
  const nameSrc = norm(name);
  const descSrc = norm(desc);
  const hits = [];
  for (const [group, buckets] of Object.entries(TABLE)) {
    for (const [label, terms] of Object.entries(buckets)) {
      const strong = terms.filter(e => e.w === 'S' && (matcher(e.t)(nameSrc) || matcher(e.t)(descSrc)));
      const weak = terms.filter(e => e.w === 'W' && (matcher(e.t)(nameSrc) || matcher(e.t)(descSrc)));
      const strongInName = strong.filter(e => matcher(e.t)(nameSrc));
      const matched = strong.length > 0 || weak.length >= 2;
      if (matched) hits.push({ bucket: `${group}:${label}`, strong: strong.length, strongInName: strongInName.length, weak: weak.length,
        via: [...new Set([...strongInName.map(e => e.t), ...strong.map(e => e.t), ...weak.map(e => `~${e.t}`)])].slice(0, 4) });
    }
  }
  if (hits.length === 0) return { bucket: null, why: 'no-hit', via: [] };
  const withStrong = hits.filter(h => h.strong > 0);
  const pool = withStrong.length ? withStrong : hits;
  const inName = pool.filter(h => h.strongInName > 0);
  if (pool.length === 1) return { bucket: pool[0].bucket, why: withStrong.length ? 'single-strong' : 'weak-two', via: pool[0].via };
  if (inName.length === 1) return { bucket: inName[0].bucket, why: 'ambiguous-resolved-by-name', via: inName[0].via };
  return { bucket: null, why: `ambiguous(${pool.map(h => h.bucket).join('|')})`, via: [] };
}

/** 描述抽取（与 pool-verify 同式：frontmatter description，含引号与块标量） */
export function descOf(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const dm = /^description:\s*(.*)$/m.exec(m[1]);
  if (!dm) return null;
  const val = dm[1].trim();
  if (val && (val[0] === '"' || val[0] === "'")) return val.replace(/^["']|["']$/g, '');
  if (['|', '>', '|-', '>-', '|+', '>+'].includes(val)) {
    const body = m[1].slice(dm.index + dm[0].length);
    const lines = [];
    for (const line of body.split('\n')) {
      if (!line.trim()) { lines.push(''); continue; }
      if (/^\s/.test(line)) lines.push(line.trim());
      else break;
    }
    return lines.filter(Boolean).join(' ');
  }
  return val || null;
}

async function main(argv) {
  const flag = n => { const i = argv.indexOf(`--${n}`); return i === -1 ? undefined : argv[i + 1]; };
  const samplePath = flag('sample');
  const library = flag('library') ?? '/Users/lute/project/AgentTools/技能库';
  const outPath = flag('out');
  const examples = Number(flag('examples') ?? 0);
  if (!samplePath) {
    process.stderr.write('Usage: node routing-v2-draft.mjs --sample <packet.json> [--library <dir>] [--out <json>] [--examples N]\n');
    return 2;
  }
  const packet = JSON.parse(await readFile(samplePath, 'utf8'));
  const rows = [];
  for (const item of packet.items) {
    let desc = item.desc;
    if (!desc || desc === '(no-desc)') {
      try {
        desc = descOf(await readFile(join(library, item.path), 'utf8'));
      } catch { desc = null; }
    }
    rows.push({ ledgerId: item.ledgerId, name: item.name, desc, ...classifyOne({ name: item.name, desc }) });
  }
  const byBucket = {};
  for (const r of rows) {
    const k = r.bucket ?? (r.why === 'no-hit' ? '(no-hit)' : '(ambiguous)');
    byBucket[k] = (byBucket[k] ?? 0) + 1;
  }
  const routed = rows.filter(r => r.bucket).length;
  const stats = { recordType: 'r5-draft-validation', at: new Date().toISOString(),
    sampleSize: rows.length, routed, routeRate: `${(routed / rows.length * 100).toFixed(1)}%`,
    humanReference: '110 号：判可归类 189/200＝94.5%（聚合，无逐行标签可比）',
    byBucket, unassignedExamples: rows.filter(r => !r.bucket && r.why !== 'no-hit').slice(0, 8).map(r => ({ id: r.ledgerId, name: r.name, why: r.why })) };
  if (examples) stats.exampleRows = rows.filter(r => r.bucket).slice(0, examples);
  const print = { ...stats };
  if (outPath) {
    await writeFile(outPath, `${JSON.stringify(stats, null, 1)}\n`);
    print.saved = outPath;
  }
  console.log(JSON.stringify(print, null, 1));
  return 0;
}

export async function exportedMain(argv) { return main(argv); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
