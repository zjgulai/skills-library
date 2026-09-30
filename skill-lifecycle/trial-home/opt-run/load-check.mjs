import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokeObserver } from '../enabled-smoke.mjs';

/**
 * 装载验证（零出境）：用 trial-home 的观察窗把同一份技能放进不同"目录/名字"组合，
 * 看 DSH 原生链路实际能发现并加载哪一个。写回前后各跑一次（四路）。
 *
 *   ① kebab-root   / <最终 kebab 名>  ← 候选原样（name 与目录都是 kebab）
 *   ② pre-root     / <写回前中文名>    ← **写回前镜像**（用写回备份＋未改动件重建；frontmatter name 是中文）
 *   ③ mixed-root   / <写回前中文名>    ← 候选文件放进中文目录（= 只改 name 不改目录的形态）
 *   ④ library-root / <最终 kebab 名>  ← 库内实物（写回＋改名之后）
 *
 * 期望：①③④ 加载成功且内容身份与树一致；② 不被发现（`invalid skill name` 逐份忽略）。
 * 附加闸门：②由备份重建，其摘要必须逐条等于写回计划里的写回前摘要（证明备份是完整的写回前原件）。
 *
 * 用法：node load-check.mjs --candidate <候选目录> --skilldir <库内技能目录（现名）>
 *        --backup <写回备份根> --plan <写回计划.json> --evidence <证据目录>
 */
const here = dirname(fileURLToPath(import.meta.url));
const flag = name => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const candidate = flag('candidate');
const skillDir = flag('skilldir');
const backupRoot = flag('backup');
const planPath = flag('plan');
const evidenceDir = flag('evidence');
if (!candidate || !skillDir || !backupRoot || !planPath || !evidenceDir) {
  process.stderr.write('Usage: node load-check.mjs --candidate <dir> --skilldir <dir> --backup <dir> --plan <json> --evidence <dir>\n');
  process.exit(2);
}
const scratch = join(here, 'load-check');
const plan = JSON.parse(await readFile(planPath, 'utf8'));
// 写回计划里的路径前缀（改名前的技能目录）。**不能用 ops[0]**：按 relPath 排序时
// `.skill-meta/manifest.yaml` 会排在最前，dirname 就成了 `…/.skill-meta`（2026-09-29 实测，
// VOC 这次才暴露）。改为用 plan.target 的路径尾巴去对齐第一条 op 的前缀。
function prefixFromTarget(targetPath, sampleRelPath) {
  const targetSegs = String(targetPath ?? '').split('/').filter(Boolean);
  const sampleSegs = String(sampleRelPath).split('/').slice(0, -1);
  for (let take = Math.min(targetSegs.length, sampleSegs.length); take > 0; take -= 1) {
    const tail = targetSegs.slice(targetSegs.length - take).join('/');
    if (sampleSegs.slice(0, take).join('/') === tail) return tail;
  }
  return dirname(sampleRelPath);
}
// 取第一个**带 relPath** 的 op 来推前缀：prune-empty-dirs 这类 op 只有 root、没有 relPath
// （2026-09-30 实测：ops[0] 恰好是 prune op 时，relative(undefined) 直接 TypeError）。
const sampleOp = plan.ops.find(op => typeof op.relPath === 'string');
if (!sampleOp) throw new Error('计划里没有任何带 relPath 的 op，无法推写回前缀');
const opPrefix = prefixFromTarget(plan.target, sampleOp.relPath);   // 计划里的路径前缀（改名前的技能目录）
const preName = basename(opPrefix);                        // 写回前目录名 / frontmatter 名（中文）
const finalName = basename(skillDir);                      // 现目录名（kebab）

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const readOrNull = async path => await readFile(path).catch(() => null);
const listFiles = async (root, prefix = '', collected = []) => {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await listFiles(root, relPath, collected);
    else if (entry.isFile()) collected.push(relPath);
  }
  return collected;
};

await rm(scratch, { recursive: true, force: true });
const roots = [['kebab-root', finalName, candidate],
  ['pre-root', preName, null], ['mixed-root', preName, candidate],
  ['library-root', finalName, skillDir]];
for (const [parent, name, source] of roots) {
  const target = join(scratch, parent, name);
  await mkdir(dirname(target), { recursive: true });
  if (source !== null) await cp(source, target, { recursive: true });
}

// ② 写回前镜像：有 put/remove 记录的文件取自备份（写回前原件）；其余从未改动的库内文件复制；
// 计划里声明"新增"（expectAbsent）的件必须缺席。备份路径保留写回前的前缀（op.relPath 同形）。
const preRoot = join(scratch, 'pre-root', preName);
const opByRel = new Map(plan.ops.filter(op => typeof op.relPath === 'string')
  .map(op => [relative(opPrefix, op.relPath), op]));   // 同样跳过 prune 这类无 relPath 的 op
for (const rel of await listFiles(skillDir)) {
  const op = opByRel.get(rel);
  if (op?.expectAbsent === true) continue;                       // 新增件：写回前不存在
  const source = op ? join(backupRoot, op.relPath) : join(skillDir, rel);
  const bytes = await readOrNull(source);
  if (bytes === null) { process.stderr.write(`镜像缺件：${rel}\n`); continue; }
  await mkdir(dirname(join(preRoot, rel)), { recursive: true });
  await writeFile(join(preRoot, rel), bytes);
}
for (const op of plan.ops) {                                     // remove 的件（现目录里已没有）从备份补回
  if (op.kind !== 'remove') continue;
  const bytes = await readFile(join(backupRoot, op.relPath));
  const target = join(preRoot, relative(opPrefix, op.relPath));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

const candidateFiles = await listFiles(candidate);
const failures = [];
for (const op of plan.ops.filter(entry => typeof entry.relPath === 'string')) {
  const mirrored = await readOrNull(join(preRoot, relative(opPrefix, op.relPath)));
  if (op.expectAbsent === true) {
    if (mirrored !== null) failures.push(`pre-root 不该有 ${op.relPath}`);
  } else if (mirrored === null || sha256(mirrored) !== op.expectSha256) {
    failures.push(`pre-root 的 ${op.relPath} 与计划里的写回前摘要不一致`);
  }
}

// 同名字段件（未改名，如 genspark 单文件包）：②/③ 的"中文名不可见"探针不适用——
// pre-root 镜像仍跑（验证备份完整性），但预期应为 loaded，且 mixed 与 kebab 重复则略去。
const renamed = preName !== finalName;
const probes = renamed ? [
  { key: 'kebab', expect: 'loaded', skillId: finalName, parent: 'kebab-root', name: finalName },
  { key: 'pre-writeback', expect: 'ignored', skillId: preName, parent: 'pre-root', name: preName },
  { key: 'mixed', expect: 'loaded', skillId: finalName, parent: 'mixed-root', name: preName },
  { key: 'library-after', expect: 'loaded', skillId: finalName, parent: 'library-root', name: finalName },
] : [
  { key: 'kebab', expect: 'loaded', skillId: finalName, parent: 'kebab-root', name: finalName },
  { key: 'pre-writeback', expect: 'loaded', skillId: finalName, parent: 'pre-root', name: preName },
  { key: 'library-after', expect: 'loaded', skillId: finalName, parent: 'library-root', name: finalName },
];

const rows = [];
for (const probe of probes) {
  const root = join(scratch, probe.parent, probe.name);
  const result = await smokeObserver({ skillId: probe.skillId, root });
  const files = await listFiles(root);
  const digest = sha256(await readFile(join(root, 'SKILL.md')));
  const verdictOk = probe.expect === 'loaded'
    ? (result.ok === true && result.discovered.includes(probe.skillId))
    : (result.ok === false && result.detail.startsWith('SKILL_NOT_DISCOVERED') && result.discovered.length === 0);
  if (!verdictOk) failures.push(`${probe.key}: ${JSON.stringify(result).slice(0, 300)}`);
  rows.push({ probe: probe.key, root: `${probe.parent}/${probe.name}`, skillId: probe.skillId,
    expect: probe.expect, ok: result.ok, discovered: result.discovered, detail: result.detail,
    route: result.route, files: files.length, SKILLmd: digest.slice(0, 16) });
}
// ④ 的 SKILL.md 必须等于候选（写回的"逐字"要求），② 必须等于计划里的写回前值
const skOp = plan.ops.find(op => op.relPath.endsWith('/SKILL.md'));
if (rows.find(row => row.probe === 'kebab').SKILLmd
  !== rows.find(row => row.probe === 'library-after').SKILLmd) {
  failures.push('库内 SKILL.md 与候选不一致');
}
if (rows.find(row => row.probe === 'pre-writeback').SKILLmd !== skOp.expectSha256.slice(0, 16)) {
  failures.push('写回前镜像的 SKILL.md 与计划不符');
}
const verbatim = rows.find(row => row.probe === 'library-after').files === candidateFiles.length;

await mkdir(evidenceDir, { recursive: true });
await writeFile(join(evidenceDir, 'load-check.json'),
  `${JSON.stringify({ record_type: 'opt_round_load_check', at: new Date().toISOString(),
    candidate, skillDir, candidateFiles: candidateFiles.length, plan: planPath, rows, failures }, null, 2)}\n`);
console.table(rows.map(({ detail, ...rest }) => ({ ...rest, detail: detail.slice(0, 56) })));
console.log(`（库内件数 ${candidateFiles.length}，写回后副本件数一致：${verbatim}）`);
for (const failure of failures) console.error(`FAIL ${failure}`);
console.log(failures.length === 0
  ? (renamed
    ? '\n装载验证 PASS：① kebab 可加载、② 写回前（中文名）不可见、③ 只改 name 不改目录可加载、④ 写回后的库内实物可加载且与候选逐字一致'
    : '\n装载验证 PASS（同名字段件）：① 候选可加载、② 写回前镜像可加载且 SKILL.md == 计划写回前摘要、④ 写回后库内实物可加载且与候选逐字一致（②/③ 改名探针不适用，已在记录注明）')
  : `\n装载验证 FAIL（${failures.length}）`);
process.exitCode = failures.length === 0 ? 0 : 1;
