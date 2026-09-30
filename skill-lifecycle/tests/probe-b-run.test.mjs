import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openRun } from '../control/run-state.mjs';
import { openFiles } from '../control/bounded-files.mjs';
import { openBudget } from '../control/budget-ledger.mjs';
import { openBatchGroup, composeBudget } from '../control/batch-group.mjs';
import { installTrialControl } from '../control/dsh-plugin.mjs';
import { preflight } from '../control/preflight.mjs';
import { noSkillDigest, toolScopeFor } from '../control/arm-scope.mjs';

/**
 * 探针 B 的执行器（方案见 docs/specs/…/59-探针B方案.md）。
 *
 * 与探针 A 的区别：对象是单个库技能（Skill评估师），材料是 6 份"待评估技能"，
 * 读数是"报告里的结论与问题清单"（机械匹配，限定 issues 区块）。
 * 两条臂只差一件事：注册表里有没有那件评估技能。
 *
 * 三档门禁（沿用既有纪律）：capture（脚本化 adapter，零出境；顺带证明技能目录确实进了上下文）
 * → wake-check（挂真实路由，适配器在派发前拒绝一切请求，零出境）→ live（真实请求，按次授权）。
 */
const APP = '/Applications/DSH Desktop.app/Contents/Resources/app';
const TRIAL_HOME = join(import.meta.dirname, '..', 'trial-home');
const PROBE_HOME = join(TRIAL_HOME, 'probe-b');
const STORE = join(homedir(), '.dsh', '.credentials.yaml');
// armed 臂用**可安装形态**（kebab 化的 name）：库内原名 `Skill评估师` 非 kebab，DSH 会忽略它
// （首轮整批因此空转，见 60 号）。安装形态与库内原件的差异仅 frontmatter 的 name 一行，回执在 install-form/receipt.json。
const FROZEN = ['skill-evaluator'];
const RUN_LIMITS = { maxAttempts: Number(process.env.T_RUN_ATTEMPTS ?? 8), maxOutputTokensPerAttempt: 8192, maxRequestBytes: 262144,
  // 单轮 token 软停：大材料包按轮次由 T_RUN_TOKENS 覆盖（默认 40000；登记 D73-amend-04，待追认）
  observedTokenStop: Number(process.env.T_RUN_TOKENS ?? 40000), batchDeadlineMs: 1800000, attemptTimeoutMs: 120000 };
const GROUP_LIMITS = {
  maxAttempts: Number(process.env.T_GROUP_ATTEMPTS ?? 150),
  observedTokenStop: Number(process.env.T_GROUP_TOKENS ?? 800000),
  batchDeadlineMs: Number(process.env.T_GROUP_DEADLINE_MS ?? 7200000),
};
const AUTHORIZATION_REFERENCE = 'D65-probe-b';
const POLICY_DIGEST = createHash('sha256').update('probe-b-policy:v1').digest('hex');
const ENVIRONMENT_DIGEST = createHash('sha256').update('probe-b-env:v1').digest('hex');

const sha256File = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const digest = label => createHash('sha256').update(label).digest('hex');
const require_ = createRequire(join(APP, 'package.json'));
const load = async name => await import(pathToFileURL(require_.resolve('@deepseek-ai/' + name)).href);

const mode = process.env.T_MODE ?? 'capture';
const isLive = mode === 'live';
const isWakeCheck = mode === 'wake-check';
const arm = process.env.T_ARM ?? 'armed';
const skillArmed = arm !== 'none';
assert.ok(['capture', 'wake-check', 'live'].includes(mode), `unknown T_MODE ${mode}`);

// 任务文件可用 T_TASKS_FILE 换（优化轮次用不同的任务集：同一台仪器，材料不同）。
const tasksDoc = JSON.parse(await readFile(process.env.T_TASKS_FILE ?? join(PROBE_HOME, 'tasks.json'), 'utf8'));
const wanted = (process.env.T_TASKS ?? tasksDoc.tasks.map(task => task.taskId).join(',')).split(',');
const taskList = tasksDoc.tasks.filter(task => wanted.includes(task.taskId));
const repeat = Number(process.env.T_REPEAT ?? 1);
const stamp = process.env.T_STAMP ?? new Date().toISOString().slice(0, 10);
const scratch = await mkdtemp(join(await realpath(tmpdir()), 'probe-a-'));
const runDir = process.env.T_RUN_DIR ?? join(PROBE_HOME, 'runs');
const evidenceDir = process.env.T_EVIDENCE_DIR ?? join(TRIAL_HOME, 'evidence', `probe-a-${stamp}`);
assert.ok(!(process.env.T_SET_ROOT && isLive), 'T_SET_ROOT is capture-only');

const connection = JSON.parse(await readFile(join(TRIAL_HOME, 't09-connection.json'), 'utf8'));
async function readStoreKey(refName) {
  const store = await readFile(STORE, 'utf8');
  let inRefs = false;
  for (const raw of store.split('\n')) {
    if (/^refs:\s*$/.test(raw)) { inRefs = true; continue; }
    if (/^[A-Za-z0-9_.-]+:\s*$/.test(raw)) inRefs = false;
    if (!inRefs) continue;
    const match = raw.match(new RegExp(`^\\s+${refName}\\s*:\\s*(.+?)\\s*$`));
    if (match) return match[1].replace(/^['"]|['"]$/g, '');
  }
  return '';
}

function withDeadline(promise, ms, fallback) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// chunk 形状照抄终测载体（terminal-run）：block-start / tool-call-delta / block-end / usage / finish。
const toolCallTurn = (callId, name, args) => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: JSON.stringify(args) },
  { type: 'block-end', index: 0,
    block: { type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) } },
  { type: 'usage', usage: { inputTokens: 5, outputTokens: 6 } },
  { type: 'finish', reason: { kind: 'stop' } },
];
const textTurn = text => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } },
  { type: 'finish', reason: { kind: 'stop' } },
];

function buildPrompt({ task, armed }) {
  const toolLine = armed
    ? '你运行在一个受限环境里：可用工具只有 skill（加载本会话已注册的技能）、trial_read（按 fileId 读取）与 trial_write_report。'
    : '你运行在一个受限环境里：可用工具只有 trial_read（按 fileId 读取）与 trial_write_report；本次没有装配任何技能。';
  const fileIds = ['task', ...(task.material ?? []).map(material => material.fileId)];
  return [
    toolLine,
    `业务请求：${task.text}`,
    `可读的 fileId 清单：${fileIds.map(id => '"' + id + '"').join('、')}。`,
    '完成后必须用 trial_write_report 写出结论与问题清单；报告要标明发布结论（可发布 / 需优化 / 需重构）与依据。',
    '请连续执行直到完成，不要中途停下等待确认。',
  ].join('\n');
}

async function runOne({ task, root, group }) {
  const cwd = join(root, 'workspace');
  const sessions = join(root, 'sessions');
  const skillRoot = join(root, 'skill-root');
  for (const dir of [join(cwd, 'inputs'), join(cwd, 'outputs'), sessions, skillRoot,
    join(root, 'run'), join(root, 'batch')]) await mkdir(dir, { recursive: true });

  const materials = {};
  const files = [];
  const taskPath = join(cwd, 'inputs', 'task.md');
  await writeFile(taskPath, `${task.text}\n`);
  materials['task:bytes'] = (await stat(taskPath)).size;
  files.push({ fileId: 'task', path: taskPath, sha256: await sha256File(taskPath),
    bytes: materials['task:bytes'], maxBytes: 196608, role: 'input' });
  // 待评估材料：按 tasks.json 声明逐份复制进 inputs/（fileId 保持声明值，trial_read 按它读）。
  const materialList = [];
  for (const [index, material] of (task.material ?? []).entries()) {
    const safeName = `material-${index + 1}${material.relPath.endsWith('.md') ? '.md' : '.txt'}`;
    const target = join(cwd, 'inputs', safeName);
    const materialRoot = task.materialRoot ?? join(PROBE_HOME, 'fixtures', task.fixture);
    await writeFile(target, await readFile(join(materialRoot, material.relPath)));
    const sha = await sha256File(target);
    files.push({ fileId: material.fileId, path: target, sha256: sha,
      bytes: (await stat(target)).size, maxBytes: 196608, role: 'input' });
    materialList.push({ fileId: material.fileId, relPath: material.relPath, sha256: sha,
      bytes: (await stat(target)).size });
  }
  assert.ok(materialList.length > 0, 'every probe-B task must hand at least one material file');

  let bundleDigest = noSkillDigest;
  if (skillArmed) {
    const pairs = [];
    for (const name of FROZEN) {
      const from = join(PROBE_HOME, 'install-form', name, 'SKILL.md');
      const to = join(skillRoot, name, 'SKILL.md');
      await mkdir(join(skillRoot, name), { recursive: true });
      await writeFile(to, await readFile(from));
      const sha = await sha256File(to);
      assert.equal(sha, await sha256File(from), `frozen skill ${name} must survive the copy`);
      pairs.push([name, sha]);
      // fileId 必须是 ASCII（openFiles 的校验是 ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$）——
      // 技能名可以是中文，挂载点不行。
      files.push({ fileId: 'skill-under-test', path: to, sha256: sha,
        bytes: (await stat(to)).size, maxBytes: 196608, role: 'skill' });
    }
    bundleDigest = digest(JSON.stringify(pairs.sort()));
    assert.equal((await readdir(skillRoot)).length, FROZEN.length);
  } else {
    assert.deepEqual(await readdir(skillRoot), [], 'the none arm must not put anything under the skill root');
  }

  assert.ok(typeof task.text === 'string' && task.text.trim().length >= 10,
    `任务文本缺失或过短（首轮曾因此整批作废）：${task.taskId}`);

  const sessionId = `pb-${arm}-${task.taskId}-r${repeat}-${stamp}`;
  const binding = { runId: `run-${sessionId}`, batchId: 'probe-b', sessionId,
    skillDigest: bundleDigest, inputDigest: digest(JSON.stringify(Object.entries(materials).sort())),
    evaluatorDigest: digest(JSON.stringify(tasksDoc.tasks)), environmentDigest: ENVIRONMENT_DIGEST,
    policyDigest: POLICY_DIGEST };
  const toolNames = [...toolScopeFor({ armed: skillArmed })];
  await preflight({
    manifest: { ...binding, arm, files, toolNames,
      modelSelection: { provider: 'vod', model: 'gemini-3.8-flash' }, budget: RUN_LIMITS,
      authorization: { reference: AUTHORIZATION_REFERENCE, scopeDigest: POLICY_DIGEST } },
    capabilities: { installedDshVersion: '0.1.5-rc.2', readBoundaryVerified: true,
      requestAttemptsCovered: true, stopVerified: true, nativeSessionVerified: true,
      authorizationVerified: true, approvedModel: { provider: 'vod', model: 'gemini-3.8-flash' },
      approvedEnvironmentDigest: ENVIRONMENT_DIGEST, approvedToolNames: [...toolNames],
      approvedFiles: files.map(file => ({ fileId: file.fileId, sha256: file.sha256, maxBytes: file.maxBytes })),
      authorization: { reference: AUTHORIZATION_REFERENCE, scopeDigest: POLICY_DIGEST } },
  });

  const { Context } = await load('cordis');
  const toolsMod = await load('dsh-tools');
  const llmMod = await load('dsh-llm');
  const plugins = {
    systemPrompt: (await load('dsh-system-prompt')).SystemPrompt,
    agent: (await load('dsh-agent')).AgentRegistry ?? (await load('dsh-agent')).default,
    session: (await load('dsh-session')).default,
    persistence: (await load('dsh-session-persistence-jsonl')).default,
    projection: (await load('dsh-session-projection')).default,
    agentLoop: (await load('dsh-agent-loop')).AgentLoop ?? (await load('dsh-agent-loop')).default,
    registry: (await load('dsh-skill')).default,
    skillFs: await load('dsh-skill-filesystem'),
    toolSkill: await load('dsh-tool-skill'),
  };
  const ctx = new Context();
  await ctx.plugin(plugins.systemPrompt);
  await ctx.plugin(toolsMod.ToolRuntime);
  await ctx.plugin(llmMod.LlmRuntime);
  await ctx.plugin(plugins.agent);
  await ctx.plugin(plugins.session);
  await ctx.plugin(plugins.persistence, { root: sessions });
  await ctx.plugin(plugins.projection);
  await ctx.plugin(plugins.agentLoop, {});
  const isolated = {};
  if (skillArmed) {
    await ctx.plugin(plugins.registry, {});
    for (const key of ['dshHome', 'agentsHome', 'bundledSkillDir']) {
      isolated[key] = join(root, key);
      await mkdir(isolated[key], { recursive: true });
    }
    await ctx.plugin({ apply: plugins.skillFs.apply, inject: plugins.skillFs.inject,
      name: plugins.skillFs.name, Config: plugins.skillFs.Config }, {
      includeDefaultRoots: false, watch: false, customSkillDirs: [skillRoot],
      dshHome: isolated.dshHome, agentsHome: isolated.agentsHome, bundledSkillDir: isolated.bundledSkillDir,
    });
    await ctx.plugin({ apply: plugins.toolSkill.apply, inject: plugins.toolSkill.inject,
      name: plugins.toolSkill.name, Config: plugins.toolSkill.Config }, {});
  }

  const scripts = [];
  if (!isLive) {
    const model = Object.freeze({ provider: 'trial-provider', id: 'trial-model', name: 'Trial Model',
      context: { contextWindow: 8192 }, defaultMaxTokens: 256 });
    class ScriptedAdapter extends llmMod.LlmAdapter {
      async prepareCall(request) {
        // capture/wake-check 的零出境证明：把"模型实际会看到什么"留证。
        const messages = JSON.stringify(request?.messages ?? request ?? {});
        if (catalogSeen === null) {
          catalogSeen = { hasCatalog: messages.includes('available_skills'),
            hasContentStrategy: messages.includes('content-strategy'),
            hasGenspark: messages.includes('genspark-content-strategy'),
            bytes: Buffer.byteLength(messages, 'utf8') };
        }
        return { model, stream: () => this.run() };
      }
      async *run() {
        if (isWakeCheck) throw new Error('EGRESS_BLOCKED: wake-check 在派发前拒绝一切请求');
        const script = scripts.shift();
        if (script === undefined) throw new Error('no scripted response left');
        for (const chunk of script) yield chunk;
      }
    }
    ctx.llm.registerAdapter(['trial-provider'], new ScriptedAdapter());
  } else {
    const apiKey = (connection.provider.apiKey ?? '').trim()
      || (await readStoreKey(connection.provider.apiKeyEnv));
    assert.ok(apiKey.length >= 16, 'credential must be available for live modes');
    process.env[connection.provider.apiKeyEnv] = apiKey;
    await ctx.plugin((await load('dsh-credentials-local')).default, { path: STORE, watch: false });
    const piAi = await load('dsh-llm-pi-ai');
    await ctx.plugin(piAi, { providers: { vod: {
      displayName: connection.provider.displayName, api: connection.provider.api,
      baseURL: connection.provider.baseURL, apiKeyEnv: connection.provider.apiKeyEnv,
      models: [{ id: 'gemini-3.8-flash' }],
    } } });
  }
  if (isWakeCheck) {
    // 真实路由已挂上，但这一档在派发前拒绝一切请求：用来证明"装配与凭据都就位、且一个字节都没出去"。
    ctx.on('llm/stream', () => { throw new Error('EGRESS_BLOCKED: wake-check 在派发前拒绝一切请求'); });
  }

  const run = await openRun({ root: join(root, 'run'), binding });
  await run.start();
  // openFiles 只接受 {fileId, path, role} 三个键（多一个就 INVALID_FILE）；带摘要的那份给 preflight。
  const filesApi = await openFiles({ run, binding, inputRoot: join(cwd, 'inputs'),
    skillRoot, outputRoot: join(cwd, 'outputs'),
    files: files.map(({ fileId, path, role }) => ({ fileId, path, role })),
    limits: { maxInputBytes: 196608, maxReportBytes: 65536 } });
  const ledger = await openBudget({ run, binding, root: join(root, 'batch'), limits: RUN_LIMITS });
  const budget = composeBudget({ ledger, group });
  const audit = [];
  // 技能目录是否真进了上下文：从 guard 的 measureRequest 取——那是「模型将收到的请求」本身。
  let catalogSeen = null;
  const streamKinds = [];
  const finishKinds = [];
  const textParts = [];
  const handle = await ctx.get('agentLoop').create(sessionId,
    { provider: isLive ? 'vod' : 'trial-provider', model: isLive ? 'gemini-3.8-flash' : 'trial-model',
      maxTokens: RUN_LIMITS.maxOutputTokensPerAttempt }, { cwd });
  const skillToolVisible = Boolean(ctx.tools.get('skill', handle));
  assert.equal(skillToolVisible, skillArmed, skillArmed
    ? 'an armed run must expose the skill tool'
    : 'the none arm must not expose the skill tool');
  const control = await installTrialControl({
    agent: handle, run, binding, files: filesApi, budget, waitMs: RUN_LIMITS.attemptTimeoutMs,
    // 本探针的题都是散文题，没有数据表；但 trial_compute 的影子工具需要一个表占位，
    // 不是证据（记录里显式标注），题面也不要求用它。
    tables: new Map([['data', { headers: ['probe-a'], rows: [['no-table-in-this-task']],
      sha256: digest('probe-a-placeholder-table') }]]),
    defineTool: toolsMod.defineTool,
    ...(skillArmed ? { allowedSkillNames: FROZEN } : {}),
    requestIdentity: () => ({ runId: binding.runId, sessionId: binding.sessionId }),
    measureRequest: request => {
      const messages = request?.messages;
      // 技能目录在 **tools**（skill 工具的描述）里，不在 messages 里——两处都要量。
      const text = JSON.stringify({ messages: messages ?? null, tools: request?.tools ?? null });
      // 目录在 **request.tools**（skill 工具的描述）里；首轮我用"正文里出现技能名"当门禁，
      // capture 里那个 true 其实来自被加载后的技能正文 ⇒ 假绿。现在分开量：tools 里有没有、全文里有没有。
      // 目录的正确位置：**messages 里的 <system-reminder>**（`<available_skills>` 开头的技能清单）。
      // 首轮 live 失败的根因是"中文名被 provider 过滤 ⇒ 目录为空"，与位置无关（先前记成 tools，已更正）。
      const info = { keys: Object.keys(request ?? {}),
        messageCount: Array.isArray(messages) ? messages.length : null,
        hasCatalogBlock: text.includes('<available_skills>'),
        listsSkill: text.includes('skill-evaluator'),
        bytes: Buffer.byteLength(text ?? '', 'utf8') };
      // 同一次执行会有多个请求（首个是短的系统调用），只有最大的那个才是"模型真正收到的"。
      if (catalogSeen === null || info.bytes > catalogSeen.bytes) {
        catalogSeen = info;
        // 只在本机落一份"模型将收到的请求"，用于核对目录（零请求、旁路证据）。
        if (process.env.T_REQUEST_DUMP !== undefined) {
          writeFile(process.env.T_REQUEST_DUMP, text).catch(() => {});
        }
      }
      if (catalogSeen !== null && !Array.isArray(catalogSeen.sizes)) catalogSeen.sizes = [];
      catalogSeen.sizes.push(info.bytes);
      return Buffer.byteLength(text ?? '', 'utf8');
    },
    audit: entry => { audit.push(entry); },
  });
  ctx.on('llm/stream', (options, next) => (async function* observe() {
    for await (const chunk of await next()) {
      streamKinds.push(chunk?.type ?? '?');
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') textParts.push(chunk.text);
      if (chunk?.type === 'finish') {
        const reason = chunk.reason ?? {};
        finishKinds.push(`${reason.kind ?? '?'}${reason.failure ? ':' + String(reason.failure.message ?? '').slice(0, 120) : ''}`);
      }
      yield chunk;
    }
  })());
  if (!isLive) {
    if (skillArmed) scripts.push(toolCallTurn('pb-1', 'skill', { name: 'skill-evaluator' }));
    scripts.push(textTurn('（脚本化演练）已按可用技能作答。'));
  }

  const prompt = buildPrompt({ task, armed: skillArmed });
  const startedAt = Date.now();
  handle.send(llmMod.createUserMessage({ content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' } }), 'next-turn', true);
  const outcome = await withDeadline(handle.whenIdle().then(() => 'idle'), 600000, 'timeout');

  const admittances = audit.filter(entry => entry.kind === 'tool_admitted' && entry.tool === 'skill');
  const snapshot = await ledger.snapshot?.() ?? null;
  if (isWakeCheck) {
    // 零出境档的硬断言：真实路由已挂、凭据已装，但一个预留都不许发生（否则这一档就是在花钱）。
    assert.equal((snapshot?.attempts ?? []).length, 0, 'wake-check 必须零预留');
    assert.equal(audit.some(entry => entry.kind === 'tool_admitted'), false, 'wake-check 不许有工具放行');
  }
  const reportPath = join(cwd, 'outputs', 'validation-report.md');
  let reportText = null;
  try { reportText = await readFile(reportPath, 'utf8'); } catch { /* 没有报告也是读数 */ }
  const record = {
    record_type: 'probe_b_task',
    taskId: task.taskId,
    fixture: task.fixture,
    releaseExpect: task.releaseExpect,
    defectTokens: task.defectTokens ?? [],
    cleanControl: task.cleanControl === true,
    planted: task.planted,
    materials: materialList,
    arm,
    mode,
    at: new Date().toISOString(),
    runId: binding.runId,
    skillDigest: binding.skillDigest,
    loadedSkills: [...new Set(admittances.map(entry => entry.skillName))],
    auditSkillDenied: audit.filter(entry => entry.kind === 'tool_denied').map(entry => entry.reason),
    toolScope: toolNames,
    streamKinds: [...new Set(streamKinds)],
    finishKinds,
    replyChars: textParts.join('').length,
    replyHead: textParts.join('').slice(0, 400),
    // 完整回复也留证：模型偶尔只在对话里作答、不写报告文件（6 次里出现过 2 次），
    // 读数需要能退回对话文本（rev2 判据里『整篇视为 issues 区块』就是为这种情况写的）。
    replyText: textParts.join(''),
    phase: handle.phase ?? null,
    outcome,
    reportChars: reportText === null ? 0 : reportText.length,
    report: reportText,
    readDenied: audit.filter(entry => entry.kind === 'tool_denied' && entry.tool !== 'skill')
      .map(entry => entry.reason),
    notes: ['armed 臂拿到的是技能 SKILL.md 全文（含六维度、权重、发布门槛、输出格式），'
      + '读不到它的 references/ 细则（trial_read 只放行已声明的材料）——这是与真实 DSH 的已知差异，'
      + '若执行中出现读被拒会记进 readDenied'],
    elapsedMs: Date.now() - startedAt,
    ledger: snapshot,
    catalogSeen,
  };
  await control.dispose?.();
  await filesApi.close?.();
  await budget.close?.();
  await run.close?.();
  return record;
}

// 这是**驱动**不是测试：只有显式给了 T_MODE 才跑（否则全量套件会把 capture 记录
// 写进 live 证据目录——已发生过一次：probe-a 的 6 条 capture 记录即由此而来）。
test(`probe B · ${mode} · arm=${arm} · ${taskList.length} tasks`,
  { skip: process.env.T_MODE === undefined ? 'driver: set T_MODE=capture|wake-check|live to run' : false },
  async (t) => {
  await mkdir(runDir, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });
  const runRoot = await realpath(runDir);
  const group = await openBatchGroup({ root: runRoot, groupId: 'probe-b', limits: GROUP_LIMITS });
  t.after(async () => { await rm(scratch, { recursive: true, force: true }).catch(() => {}); });
  const produced = [];
  for (const task of taskList) {
    const recordPath = join(evidenceDir, `${arm}-${task.taskId}-r${repeat}.json`);
    try { await stat(recordPath); console.log(`skip ${arm} ${task.taskId}`); continue; } catch { /* 新题 */ }
    const root = join(runRoot, `${arm}-${task.taskId}-r${repeat}`);
    await mkdir(root, { recursive: true });
    const started = Date.now();
    const record = await runOne({ task, root, group });
    record.elapsedMs = Date.now() - started;
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    produced.push({ taskId: task.taskId, loaded: record.loadedSkills.join('+') || '(none)', reportChars: record.reportChars,
      finish: record.finishKinds[0] ?? '?' });
    console.log(`done ${arm} ${task.taskId} → ${record.loadedSkills.join('+') || '(未加载)'} | ${record.finishKinds.join(',')}`);
  }
  console.log(`PROBE-B ${mode} ${arm}: ${produced.length} records → ${evidenceDir}`);
  if (produced.length > 0) console.log(JSON.stringify(produced, null, 1));
});
