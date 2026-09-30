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
 * 探针 A 的执行器（方案见 docs/specs/…/57-动态探针方案.md）。
 *
 * 与终测载体（terminal-run）的区别：这里**不做双臂版本比较、不需要判者**——
 * 读数是机械的：每次执行里"模型加载了哪份技能"，来自 trial guard 的审计。
 * 因此两条臂只差一件事：注册表里有没有那两份技能。
 *
 * 三档门禁（沿用既有纪律）：capture（脚本化 adapter，零出境；顺带证明技能目录确实进了上下文）
 * → wake-check（挂真实路由，适配器在派发前拒绝一切请求，零出境）→ live（真实请求，按次授权）。
 */
const APP = '/Applications/DSH Desktop.app/Contents/Resources/app';
const TRIAL_HOME = join(import.meta.dirname, '..', 'trial-home');
const PROBE_HOME = join(TRIAL_HOME, 'probe-a');
const STORE = join(homedir(), '.dsh', '.credentials.yaml');
const FROZEN = ['content-strategy', 'genspark-content-strategy'];
const RUN_LIMITS = { maxAttempts: 8, maxOutputTokensPerAttempt: 8192, maxRequestBytes: 262144,
  observedTokenStop: 40000, batchDeadlineMs: 1800000, attemptTimeoutMs: 120000 };
const GROUP_LIMITS = {
  maxAttempts: Number(process.env.T_GROUP_ATTEMPTS ?? 150),
  observedTokenStop: Number(process.env.T_GROUP_TOKENS ?? 800000),
  batchDeadlineMs: Number(process.env.T_GROUP_DEADLINE_MS ?? 7200000),
};
const AUTHORIZATION_REFERENCE = 'D62-probe-a';
const POLICY_DIGEST = createHash('sha256').update('probe-a-policy:v1').digest('hex');
const ENVIRONMENT_DIGEST = createHash('sha256').update('probe-a-env:v1').digest('hex');

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

const tasksDoc = JSON.parse(await readFile(join(PROBE_HOME, 'tasks.json'), 'utf8'));
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

function buildPrompt({ text, armed }) {
  const toolLine = armed
    ? '你运行在一个受限环境里：可用工具只有 skill（加载本会话已注册的技能）、trial_read（按 fileId 读取）与 trial_write_report。'
    : '你运行在一个受限环境里：可用工具只有 trial_read（按 fileId 读取）与 trial_write_report；本次没有装配任何技能。';
  return [
    toolLine,
    `业务请求：${text}`,
    '任务说明同时以 fileId "task" 提供，可按需读取。',
    '直接给出你的回应；只有确有必要时才写报告。',
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
    bytes: materials['task:bytes'], maxBytes: 65536, role: 'input' });

  let bundleDigest = noSkillDigest;
  if (skillArmed) {
    const pairs = [];
    for (const name of FROZEN) {
      const from = join(PROBE_HOME, 'skills', name, 'SKILL.md');
      const to = join(skillRoot, name, 'SKILL.md');
      await mkdir(join(skillRoot, name), { recursive: true });
      await writeFile(to, await readFile(from));
      const sha = await sha256File(to);
      assert.equal(sha, await sha256File(from), `frozen skill ${name} must survive the copy`);
      pairs.push([name, sha]);
      files.push({ fileId: `skill-${name}`, path: to, sha256: sha,
        bytes: (await stat(to)).size, maxBytes: 65536, role: 'skill' });
    }
    bundleDigest = digest(JSON.stringify(pairs.sort()));
    assert.equal((await readdir(skillRoot)).length, FROZEN.length);
  } else {
    assert.deepEqual(await readdir(skillRoot), [], 'the none arm must not put anything under the skill root');
  }

  const sessionId = `pa-${arm}-${task.taskId}-r${repeat}-${stamp}`;
  const binding = { runId: `run-${sessionId}`, batchId: 'probe-a', sessionId,
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
    limits: { maxInputBytes: 65536, maxReportBytes: 65536 } });
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
      const text = JSON.stringify(messages ?? null);
      const info = { messageCount: Array.isArray(messages) ? messages.length : null,
        hasCatalog: text.includes('available_skills'),
        hasContentStrategy: text.includes('content-strategy'),
        hasGenspark: text.includes('genspark-content-strategy'),
        bytes: Buffer.byteLength(text ?? '', 'utf8') };
      // 同一次执行会有多个请求（首个是短的系统调用），只有最大的那个才是"模型真正收到的"。
      if (catalogSeen === null || info.bytes > catalogSeen.bytes) catalogSeen = info;
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
    if (skillArmed) scripts.push(toolCallTurn('pa-1', 'skill', { name: 'content-strategy' }));
    scripts.push(textTurn('（脚本化演练）已按可用技能作答。'));
  }

  const prompt = buildPrompt({ text: task.text, armed: skillArmed });
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
  const record = {
    record_type: 'probe_a_task',
    taskId: task.taskId,
    expect: task.expect,
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
    phase: handle.phase ?? null,
    outcome,
    notes: ['trial_compute 的表是占位表（本探针的题都是散文题），不是证据；题面不要求用工具'],
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
test(`probe A · ${mode} · arm=${arm} · ${taskList.length} tasks`,
  { skip: process.env.T_MODE === undefined ? 'driver: set T_MODE=capture|wake-check|live to run' : false },
  async (t) => {
  await mkdir(runDir, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });
  const runRoot = await realpath(runDir);
  const group = await openBatchGroup({ root: runRoot, groupId: 'probe-a', limits: GROUP_LIMITS });
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
    produced.push({ taskId: task.taskId, loaded: record.loadedSkills.join('+') || '(none)',
      finish: record.finishKinds[0] ?? '?' });
    console.log(`done ${arm} ${task.taskId} → ${record.loadedSkills.join('+') || '(未加载)'} | ${record.finishKinds.join(',')}`);
  }
  console.log(`PROBE-A ${mode} ${arm}: ${produced.length} records → ${evidenceDir}`);
  if (produced.length > 0) console.log(JSON.stringify(produced, null, 1));
});
