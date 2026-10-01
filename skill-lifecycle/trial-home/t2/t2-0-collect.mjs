#!/usr/bin/env node
/**
 * T2-0 实例事实实读采集器（120 号序列 T2-0；**默认 dry-run，不读任何文件**）。
 *
 * 目的：为"实例事实表"收集只读事实（active profile／实例补丁／用户 presets／技能根存在与覆盖），
 * 并与 117/118 的静态假设对表。**零模型请求**；不写实例；凭据/密钥/会话类路径内建拒读闸。
 *
 * 用法：
 *   node skill-lifecycle/trial-home/t2/t2-0-collect.mjs                 # dry-run：只打印拟读清单（零文件访问）
 *   node skill-lifecycle/trial-home/t2/t2-0-collect.mjs --apply --authorized <D-编号或文字>
 *        # 执行只读采集 → 写 120-w5-t2-sequence/t2-0/instance-facts.json 与 diff-stub.md
 *        # 不带 --authorized 一律拒绝执行（授权门显式化）
 * 退出码：0 正常；2 用法/未授权；3 命中拒读闸（停，回报）。
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DSH = join(homedir(), '.dsh');
const AGENTS = join(homedir(), '.agents');

// 拒读闸：凭据、密钥、会话、连接类文件一律不可入清单（T2-0 stop 规则的程序化实现）
export const DENY = [
  /\.credentials/i, /credentials\.ya?ml$/i,
  /\.(pem|key|p12|pfx)$/i,
  /\bsessions?\b/i, /\/sessions\//i,
  /secret/i, /token/i,
];
export function denied(path) {
  return DENY.some(re => re.test(path));
}

const MAX_BYTES = 200 * 1024;

/** 拟读清单：kind=file 读全文（≤200KB）；kind=listing 只列顶层名字（不读内容）。 */
export function plan() {
  return [
    { path: join(DSH, 'settings.yaml'), kind: 'file', why: 'active profile 选择/装载线索（117 §R-* 静态假设对照用；如你介意可在授权时划掉）' },
    { path: join(DSH, 'profiles', 'desktop', 'cordis.patch.yml'), kind: 'file', why: '实例补丁（E02 合成链的 patch 层实况）' },
    { path: join(DSH, 'profiles', 'desktop'), kind: 'listing', why: 'active profile 目录结构（名字级）' },
    { path: join(DSH, '.agent-presets'), kind: 'listing', why: '用户 presets（名字级）' },
    { path: join(DSH, 'skills'), kind: 'listing', why: 'dshHome 技能根存在性与成员（名字级）' },
    { path: join(AGENTS, 'skills'), kind: 'listing', why: 'agentsHome 技能根存在性与成员（名字级）' },
  ];
}

/** presets 内每个 agent.cordis.yml 逐份读（补 plan：listing 里发现的子目录） */
export async function expandPresets() {
  const root = join(DSH, '.agent-presets');
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of (await readdir(root)).sort()) {
    const p = join(root, name, 'agent.cordis.yml');
    if (existsSync(p)) out.push({ path: p, kind: 'file', why: `preset「${name}」声明（scope/技能根）` });
  }
  return out;
}

async function readFact(item, facts) {
  if (denied(item.path)) { facts.denied.push(item.path); return; }
  try {
    if (item.kind === 'file') {
      const info = await stat(item.path);
      if (info.size > MAX_BYTES) { facts.unknowns.push(`${item.path}（>${MAX_BYTES} 字节，未读）`); return; }
      const text = await readFile(item.path, 'utf8');
      facts.files.push({ path: item.path, sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
        bytes: info.size, content: text });
    } else {
      const entries = (await readdir(item.path, { withFileTypes: true })).map(e => `${e.isDirectory() ? 'd' : '-'}${e.name}`).sort();
      facts.listings.push({ path: item.path, count: entries.length, names: entries });
    }
  } catch (error) {
    facts.unknowns.push(`${item.path}（不可读：${error?.code ?? error?.message}）`);
  }
}

export async function collect() {
  const facts = { recordType: 't2-0-instance-facts', at: new Date().toISOString(),
    excludedByPolicy: '凭据/密钥/会话/连接类路径（DENY 闸，程序化拒读）',
    files: [], listings: [], denied: [], unknowns: [] };
  for (const item of [...plan(), ...await expandPresets()]) await readFact(item, facts);
  // 技能根覆盖：dshHome 与 agentsHome 同名成员（名字级交集）
  const get = (suffix) => facts.listings.find(l => l.path.endsWith(suffix))?.names.map(n => n.slice(1)) ?? [];
  const dshNames = new Set(get('.dsh/skills'));
  const agentsNames = get('.agents/skills');
  facts.skillRootOverlap = { dshOnly: [...dshNames].filter(n => !agentsNames.includes(n)).length,
    agentsOnly: agentsNames.filter(n => !dshNames.has(n)).length,
    both: agentsNames.filter(n => dshNames.has(n)) };
  return facts;
}

export const REPO = fileURLToPath(new URL('../../..', import.meta.url));  // 修正：skill-lifecycle/trial-home/t2 → 上 3 层到「skill管理」（原 4 层误指「思维库」；缺陷 2026-10-01 修复）
export const OUT_DIR = join(REPO, 'docs/specs/2026-09-25-dsh-skill-lifecycle/120-w5-t2-sequence/t2-0');

export async function main(argv) {
  const apply = argv.includes('--apply');
  const authIndex = argv.indexOf('--authorized');
  const authorization = authIndex === -1 ? undefined : argv[authIndex + 1];
  if (!apply) {
    // dry-run 承诺零文件访问：不展开 presets 子目录，只给通配描述
    const willRead = [...plan(), { path: join(DSH, '.agent-presets', '*', 'agent.cordis.yml'),
      kind: 'file（逐 presets，apply 时展开）', why: 'preset 声明（scope/技能根）' }];
    const conflicts = willRead.filter(i => denied(i.path));
    if (conflicts.length) {
      process.stderr.write(`拒读闸命中（停，回报范围问题）：\n${conflicts.map(i => i.path).join('\n')}\n`);
      return 3;
    }
    console.log(JSON.stringify({ mode: 'dry-run（零文件访问）', willRead }, null, 1));
    return 0;
  }
  if (!authorization) {
    process.stderr.write('Usage: --apply 需显式携带 --authorized <D-编号或文字>（授权门显式化）\n');
    return 2;
  }
  const items = [...plan(), ...await expandPresets()];
  const conflicts = items.filter(i => denied(i.path));
  if (conflicts.length) {
    process.stderr.write(`拒读闸命中（停，回报范围问题）：\n${conflicts.map(i => i.path).join('\n')}\n`);
    return 3;
  }
  const facts = await collect();
  facts.authorization = authorization;
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'instance-facts.json'), `${JSON.stringify(facts, null, 1)}\n`);
  const rootLine = facts.listings.map(l => `- ${l.path}：${l.count} 项`).join('\n');
  await writeFile(join(OUT_DIR, 'diff-stub.md'),
    `# T2-0 静态差异单（骨架；对照 117/118 静态假设逐项补）\n\n采集：${facts.at}；授权：${authorization}\n\n## 实例实况（机读见 instance-facts.json）\n${rootLine}\n\n## 技能根覆盖（名字级）\n- dshOnly ${facts.skillRootOverlap.dshOnly} / agentsOnly ${facts.skillRootOverlap.agentsOnly} / both ${facts.skillRootOverlap.both.length}\n- both 名单：${facts.skillRootOverlap.both.join(', ') || '（空）'}\n\n## 与静态假设的差异（逐项：117 R04/R05 根布局、R22 装配、R23 产品面；118 V-05/06/25）\n- [ ] …\n\n## unknown（未读/不可读）\n${facts.unknowns.map(x => `- ${x}`).join('\n') || '- （无）'}\n`);
  console.log(JSON.stringify({ mode: 'apply', outDir: OUT_DIR, files: facts.files.length,
    listings: facts.listings.length, unknowns: facts.unknowns.length, denied: facts.denied.length }, null, 1));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
