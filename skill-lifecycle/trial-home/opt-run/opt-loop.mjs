import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

/**
 * 优化回路（脚本化）：把"真实优化第一例"里手工走过的步骤固化成四个子命令。
 * 它**不**替人写改动（改法是判断），只保证：材料一致、任务可复跑、读数可复核、写回有闸门。
 *
 *   node opt-loop.mjs stage   --skill <技能目录> --round <n> [--root <工作根>]
 *       冻结该技能为第 n 轮材料（SKILL.md + package-files.txt + references/*），记录 sha256；
 *   node opt-loop.mjs task    --round <n> [--root <工作根>] [--tasks <输出>]
 *       为该轮生成任务文件（1 题，材料指向该轮 material/）；
 *   node opt-loop.mjs run     --round <n> [--root <工作根>] [--mode capture|wake-check|live] [--repeats 2] [--attempts <n>]
 *       调 probe-b 执行器跑该轮（清理该轮 stale run 目录、提示证据目录的续跑跳过，打印可执行命令与预算；
 *       --attempts 覆盖单次尝试上限，属限额修订，必须在记录里写明）；
 *   node opt-loop.mjs read    --round <n> [--root <工作根>]
 *       读该轮证据：结论、分数、issues 条目数、成本（零请求）。
 *
 * 纪律（与前例一致）：材料是暂存副本（库只读）；每轮记录 sha256；真实请求要另给预算。
 */
const usage = [
  'Usage: node opt-loop.mjs <stage|task|run|read> --skill <dir> | --round <n> [--root <dir>] [--mode <m>] [--repeats <n>]',
].join('\n');

const flag = (argv, name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const sha = buffer => createHash('sha256').update(buffer).digest('hex').slice(0, 16);

async function listFiles(root, prefix = '', collected = []) {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await listFiles(root, relPath, collected);
    else if (entry.isFile()) collected.push(relPath);
  }
  return collected;
}

const workRoot = argv => flag(argv, 'root') ?? 'skill-lifecycle/trial-home/opt-run';
const roundDir = (argv, round) => join(workRoot(argv), `r${round}`);

async function stage(argv) {
  const skill = flag(argv, 'skill');
  const round = flag(argv, 'round');
  if (!skill || !round) throw new Error(usage);
  const material = join(roundDir(argv, round), 'material');
  await rm(material, { recursive: true, force: true });
  await mkdir(join(material, 'references'), { recursive: true });
  const files = await listFiles(skill);
  const digests = {};
  const excluded = [];
  for (const relPath of files) {
    const bytes = await readFile(join(skill, relPath));
    // 交付接口只吃合法 UTF-8：二进制/不透明容器（88 7d 1c 头）在材料里要排除，
    // 否则 openFiles 会以 INVALID_UTF8 拒收（2026-09-28 实测：Skill家族管理 的两个 examples/*.json 就是容器件）。
    const opaque = bytes.length >= 3 && bytes[0] === 0x88 && bytes[1] === 0x7d && bytes[2] === 0x1c;
    let text = true;
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = false; }
    if (opaque || !text) { excluded.push({ relPath, why: opaque ? 'opaque-container' : 'non-utf8' }); continue; }
    await mkdir(join(material, relPath, '..'), { recursive: true });
    await writeFile(join(material, relPath), bytes);
    digests[relPath] = sha(bytes);
  }
  const listText = `${[...files].sort().join('\n')}${excluded.length ? `\n\n（以下 ${excluded.length} 个文件不可交付，未纳入材料）\n${excluded.map(x => `${x.relPath}  [${x.why}]`).join('\n')}` : ''}\n`;
  await writeFile(join(material, 'package-files.txt'), listText);
  // 包内文本件合并成一份：材料 fileId 越少，评估器越快进入"给结论"（实测：10 个 fileId 会让它
  // 8 次尝试全花在逐个读文件上、写不出报告）。合并上限**按执行器的总输入预算反推**：
  // probe-b 的 openFiles 对"全部输入文件累计"限 maxInputBytes=65536（实测：73k 的包会当场
  // INPUT_TOO_LARGE），所以 合并件 ≤ 总预算 − SKILL.md − 清单 − 2k 余量（按字节算，中文 3 字节）。
  const TOTAL_INPUT_BUDGET = 196608;   // 与 probe-b 的 maxInputBytes 一致；D73-amend-05（128→192KiB；D105 已追认）
  const FIXED_INPUT_RESERVE = 14000;   // task.md＋评测器技能文件（实测 7,985B）＋余量的固定占用（12000 曾令 76 文件小包贴限件 INPUT_TOO_LARGE：判者 7,985＋task.md ≈500 超出估算）
  const skillBytes = digests['SKILL.md'] === undefined ? 0 : (await readFile(join(material, 'SKILL.md'))).length;
  const mergedLimit = TOTAL_INPUT_BUDGET - skillBytes - Buffer.byteLength(listText) - FIXED_INPUT_RESERVE;
  const merged = [];
  let mergedBytes = 0;
  const unmerged = [];
  const mergedNames = Object.keys(digests).sort()
    .filter(relPath => relPath !== 'SKILL.md' && relPath !== 'package-files.txt');
  // 未并入的占位符自身也占 package-contents.md 的字节（huashu-design r268：107 处 ≈8.6KB——
  // 曾击穿固定余量、运行期 INPUT_TOO_LARGE）。两遍式：先按「剩余文件全部出占位符」预留，
  // 并入内容时扣除本文件占位符后仍须 ≤ mergedLimit，保证最终 mergedBytes（内容＋占位符）不超限。
  const placeholderText = relPath => `\n\n## ${relPath}\n\n（超出合并上限，未并入）`;
  let reserve = 0;
  for (const relPath of mergedNames) reserve += Buffer.byteLength(placeholderText(relPath));
  for (const relPath of mergedNames) {
    const body = await readFile(join(material, relPath));
    const ph = Buffer.byteLength(placeholderText(relPath));
    if (mergedBytes + body.length + (reserve - ph) <= mergedLimit) {
      mergedBytes += body.length;
      merged.push(`\n\n## ${relPath}\n\n${body.toString('utf8')}`);
    } else {
      mergedBytes += ph;
      merged.push(placeholderText(relPath));
      unmerged.push(relPath);
    }
    reserve -= ph;
  }
  await writeFile(join(material, 'package-contents.md'),
    `# 包内文件内容合并（供评估阅读）\n${merged.join('')}\n`);
  await writeFile(join(roundDir(argv, round), 'stage.json'),
    `${JSON.stringify({ record_type: 'opt_round_stage', at: new Date().toISOString(),
      skill, round: Number(round), files: files.length, delivered: Object.keys(digests).length,
      inputBudget: TOTAL_INPUT_BUDGET, mergedLimit, mergedBytes, unmerged, excluded, digests }, null, 2)}\n`);
  console.log(JSON.stringify({ staged: files.length, material, digests: Object.keys(digests).length }, null, 2));
}

async function task(argv) {
  const round = flag(argv, 'round');
  const output = flag(argv, 'tasks') ?? join(roundDir(argv, round), 'tasks.json');
  const material = join(roundDir(argv, round), 'material');
  const files = [];   // 材料只交付三件：SKILL.md、包内清单、合并后的包内内容
  const doc = {
    record_type: 'probe_b_tasks', at: new Date().toISOString(),
    purpose: `优化回路 · 第 ${round} 轮：用 Skill评估师 评估暂存材料，拿 issues 当改进目标。`,
    arms: ['armed', 'none'],
    reading: { note: '本轮判据：拿到可用诊断（结论＋issues），不判对错。' },
    tasks: [{
      taskId: `o${round}-evaluate-target`, fixture: 'opt-target',
      materialRoot: material, releaseExpect: 'diagnose', defectTokens: [], cleanControl: false,
      planted: '优化回路材料（暂存副本；库只读）',
      text: '请评估这份技能（fileId `candidate-skill`；包内文件清单见 fileId `candidate-package-files`；包内文件内容见 fileId `candidate-package-contents`）'
        + `${files.length ? `；另有 ${files.length} 个包内文件按 fileId 提供` : ''}）：给出发布结论（可发布 / 需优化 / 需重构）、`
        + '六维度评分与**问题清单**，每条问题写明字段、严重度与修法。',
      material: [{ fileId: 'candidate-skill', relPath: 'SKILL.md' },
        { fileId: 'candidate-package-files', relPath: 'package-files.txt' },
        { fileId: 'candidate-package-contents', relPath: 'package-contents.md' }],
    }],
  };
  await writeFile(output, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(JSON.stringify({ tasks: output, materialFiles: files.length, materialRoot: material }, null, 2));
}

async function run(argv) {
  const round = flag(argv, 'round');
  const mode = flag(argv, 'mode') ?? 'capture';
  const repeats = Number(flag(argv, 'repeats') ?? 2);
  const attempts = flag(argv, 'attempts');
  const tokens = flag(argv, 'tokens');
  const root = workRoot(argv);
  // stale run 目录会让 probe-b 执行器以 RUN_LOCKED 拒绝（2026-09-28 实测）：
  // 命令里带 rm 前缀，重复执行同一条命令也能自愈；这里先清一次并说明。
  const staleRuns = join(root, `runs-r${round}`);
  const had = existsSync(staleRuns);
  await rm(staleRuns, { recursive: true, force: true });
  console.log(`（stale run 目录 ${staleRuns}：${had ? '已清理' : '无残留'}；命令内含同样的 rm 前缀，可重复执行）`);
  // 续跑守卫：目标证据目录里已有同名的记录时，runner 会直接 skip（当次执行不作数）。
  const evidence = join(root, `evidence-r${round}`);
  if (existsSync(evidence)) {
    const existing = (await readdir(evidence)).filter(entry => entry.endsWith('.json'));
    if (existing.length > 0) {
      console.log(`（注意：${evidence} 已有 ${existing.length} 条记录，runner 会 skip；要重跑请先把它移到 -voidN 目录）`);
    }
  }
  console.log('');
  // 组限量三个字段都必须为正整数（batch-group 的 validateLimits）：非 live 档不设 T_GROUP_*，
  // 走执行器默认值（150 / 800000 / 7200000）。
  const groupEnv = mode === 'live' ? 'T_GROUP_ATTEMPTS=60 T_GROUP_TOKENS=300000 \\\n  ' : '';
  // 单次尝试上限默认 8（执行器默认值）；材料变大后 8 次常被读取耗尽 ⇒ 用 --attempts 显式登记修订。
  // 单轮 token 软停默认 40000；大材料包用 --tokens 覆盖（否则读完前触停、产不出报告）。
  const attemptsEnv = attempts === undefined ? '' : `T_RUN_ATTEMPTS=${attempts} `;
  const tokensEnv = tokens === undefined ? '' : `T_RUN_TOKENS=${tokens} `;
  const command = [
    `rm -rf ${staleRuns} && for REP in ${Array.from({ length: repeats }, (_, i) => i + 1).join(' ')}; do`,
    `T_MODE=${mode} T_ARM=armed T_TASKS=o${round}-evaluate-target T_REPEAT=$REP \\`,
    `  T_TASKS_FILE=${join(roundDir(argv, round), 'tasks.json')} \\`,
    `  T_RUN_DIR=${join(root, `runs-r${round}`)} T_EVIDENCE_DIR=${join(root, `evidence-r${round}`)} \\`,
    `  ${attemptsEnv}${tokensEnv}${groupEnv}node --test skill-lifecycle/tests/probe-b-run.test.mjs; done`,
  ].join('\n');
  console.log(command);
  console.log(`\n（${mode === 'live' ? `真实请求：每执行 ≈6–10 请求 / 18–35k tokens${attempts === undefined ? '' : `（本次尝试上限 ${attempts}，属登记修订）`}；` : '零出境档；'}证据将写入 ${join(root, `evidence-r${round}`)}）`);
  if (mode === 'live') {
    // 113 号 §3.3-3（已确认）：void 与未覆盖读数的消耗只存在于证据内嵌账本，轮次收尾必须对账登记。
    console.log(`（轮次收尾：python3 -B skill-lifecycle/trial-home/screening/void-audit-make.py --from ${round} --to ${round} 对账；void 与未覆盖读数必须登记入账）`);
  }
}

async function read(argv) {
  const round = flag(argv, 'round');
  const dir = join(workRoot(argv), `evidence-r${round}`);
  const rows = [];
  for (const name of (await readdir(dir)).filter(entry => entry.endsWith('.json')).sort()) {
    const record = JSON.parse(await readFile(join(dir, name), 'utf8'));
    const report = record.report || record.replyText || '';
    const verdict = (report.match(/(?:发布结论\**\*?[:：]\**\s*\**)([^\n*]{2,40})/) ?? [])[1];
    const score = (report.match(/加权总分\**\*?[:：]\**\s*\**(\d{2}(?:\.\d)?)/) ?? [])[1]
      ?? (report.match(/(\d{2}(?:\.\d)?)\s*分/) ?? [])[1];
    const issues = (report.match(/severity\s*[:：]\s*"?(\w+)"?/gi) ?? []).length;
    rows.push({ file: name, verdict: verdict ? verdict.trim() : '(未找到)', score: score ?? '?',
      issueFields: issues, reportChars: report.length,
      requests: (record.ledger?.attempts ?? []).length,
      tokens: (record.ledger?.attempts ?? []).reduce((sum, attempt) =>
        sum + (attempt.usage?.inputTokens ?? 0) + (attempt.usage?.outputTokens ?? 0), 0) });
  }
  console.table(rows);
  const reportPath = join(dir, 'diagnosis.md');
  console.log(`（逐字报告在各记录 JSON 的 report/replyText 字段；可另存 ${reportPath}）`);
}

const [command, ...rest] = process.argv.slice(2);
const handlers = { stage, task, run: async argv => run(argv), read };
if (!handlers[command]) {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}
await handlers[command](rest);
void basename;
