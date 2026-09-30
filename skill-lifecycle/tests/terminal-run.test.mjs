import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { openRun } from '../control/run-state.mjs';
import { openFiles } from '../control/bounded-files.mjs';
import { openBudget } from '../control/budget-ledger.mjs';
import { openBatchGroup, composeBudget } from '../control/batch-group.mjs';
import { installTrialControl } from '../control/dsh-plugin.mjs';
import { parseCsv } from '../control/table-compute.mjs';
import { preflight } from '../control/preflight.mjs';
import { openTerminalSet, sealTerminalSet, assertRootsDisjoint, assertFresh, reveal } from '../control/terminal-set.mjs';
import { assertArmAllowed, isArmed, noSkillDigest, toolScopeFor } from '../control/arm-scope.mjs';

const execFileAsync = promisify(execFile);

const APP = '/Applications/DSH Desktop.app/Contents/Resources/app';
const TRIAL_HOME = join(import.meta.dirname, '..', 'trial-home');
const TERMINAL_HOME = join(TRIAL_HOME, 'terminal');
const SETTINGS = join(homedir(), '.dsh', 'settings.yaml');
const STORE = join(homedir(), '.dsh', '.credentials.yaml');
const RUBRIC_DOC = join(import.meta.dirname, '..', '..', 'docs', 'specs',
  '2026-09-25-dsh-skill-lifecycle', '26-终测集与读取隔离.md');
const AUTHORIZATION_REFERENCE = 'D27-terminal-run';
const FROZEN_SKILL_SHA = '1e424822043480375b80aef9416227b1c8083af749ca536568716265f79ca54b';
const RUN_LIMITS = { maxAttempts: 12, maxOutputTokensPerAttempt: 8192, maxRequestBytes: 262144,
  observedTokenStop: 400000, batchDeadlineMs: 3600000, attemptTimeoutMs: 120000 };
const GROUP_LIMITS = {
  maxAttempts: Number(process.env.T_GROUP_ATTEMPTS ?? 60),
  observedTokenStop: Number(process.env.T_GROUP_TOKENS ?? 300000),
  batchDeadlineMs: Number(process.env.T_GROUP_DEADLINE_MS ?? 3600000),
};
const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const digest = label => createHash('sha256').update(label).digest('hex');
const require_ = createRequire(join(APP, 'package.json'));
const load = async name => await import(pathToFileURL(require_.resolve('@deepseek-ai/' + name)).href);

const mode = process.env.T_MODE ?? 'capture';
const isLive = mode === 'live';
const arm = process.env.T_ARM ?? 'original';
const skillArmed = isArmed(arm);
// 只有 capture 演练才允许指向临时集根；真实运行必须落在 trial-home 托管区。
assert.ok(!(process.env.T_SET_ROOT && isLive),
  'T_SET_ROOT is capture-only: a live run may only read the trial-home custodian area');
const setId = process.env.T_SET ?? 'w01';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const explicitDirs = Boolean(process.env.T_RUN_DIR && process.env.T_EVIDENCE_DIR);
const scratch = explicitDirs ? null : await mkdtemp(join(await realpath(tmpdir()), 'terminal-run-'));
const runDir = process.env.T_RUN_DIR ?? join(scratch, 'runs');
const evidenceDir = process.env.T_EVIDENCE_DIR ?? join(scratch, 'evidence');
const connection = JSON.parse(await readFile(join(TRIAL_HOME, 't09-connection.json'), 'utf8'));
const RUBRIC_SHA = await sha256(RUBRIC_DOC);
const ENVIRONMENT_DIGEST = digest('terminal-narrow-graph');
const POLICY_DIGEST = digest(`${AUTHORIZATION_REFERENCE}:${JSON.stringify(RUN_LIMITS)}`);
const terminalRoot = process.env.T_SET_ROOT ?? TERMINAL_HOME;
const terminalSet = await openTerminalSet({ root: terminalRoot, setId });
assertArmAllowed(terminalSet.arms, arm);
const taskIds = (process.env.T_TASKS ?? terminalSet.taskIds.join(',')).split(',').map(id => id.trim());
const repeat = Number(process.env.T_REPEAT ?? 1);
assert.ok(Number.isSafeInteger(repeat) && repeat >= 1, 'T_REPEAT must be a positive integer');
for (const taskId of taskIds) assert.ok(terminalSet.taskIds.includes(taskId), `unknown terminal task ${taskId}`);

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

const textTurn = text => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } },
  { type: 'finish', reason: { kind: 'stop' } },
];
const toolCallTurn = (callId, name, args) => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: JSON.stringify(args) },
  { type: 'block-end', index: 0,
    block: { type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) } },
  { type: 'usage', usage: { inputTokens: 5, outputTokens: 6 } },
  { type: 'finish', reason: { kind: 'stop' } },
];

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

async function resolveArm() {
  if (!skillArmed) {
    assert.equal(await sha256(join(TRIAL_HOME, 'skills', 'validate-data', 'SKILL.md')), FROZEN_SKILL_SHA,
      'the frozen original must be untouched while a candidate is under test');
    return { arm, skillDigest: noSkillDigest, sourcePath: null, candidateId: null };
  }
  if (arm === 'original') {
    return { arm, skillDigest: FROZEN_SKILL_SHA,
      sourcePath: join(TRIAL_HOME, 'skills', 'validate-data', 'SKILL.md'), candidateId: null };
  }
  const candidateId = process.env.T_CANDIDATE ?? 't7-boundary-001';
  const candidateRoot = join(TRIAL_HOME, 'candidates', candidateId);
  const recorded = JSON.parse(await readFile(join(candidateRoot, 'candidate.json'), 'utf8'));
  assert.equal(recorded.sealed, true, 'only a sealed candidate may be evaluated');
  const sourcePath = join(candidateRoot, 'candidate', 'SKILL.md');
  assert.equal(await sha256(sourcePath), recorded.candidateDigest);
  assert.equal(await sha256(join(TRIAL_HOME, 'skills', 'validate-data', 'SKILL.md')), FROZEN_SKILL_SHA,
    'the frozen original must be untouched while a candidate is under test');
  return { arm, skillDigest: recorded.candidateDigest, sourcePath, candidateId };
}

function buildPrompt({ request, files, expectsReport, armed = true }) {
  const toolLine = armed
    ? '你运行在一个受限核验环境中：可用工具只有 skill（加载已注册技能）、trial_read（按 fileId 读取）、trial_compute（对已批准表格做固定聚合）与 trial_write_report（写出报告）。'
    : '你运行在一个受限核验环境中：可用工具只有 trial_read（按 fileId 读取）、trial_compute（对已批准表格做固定聚合）与 trial_write_report（写出报告）；本次没有装配任何技能。';
  return [
    toolLine,
    ...(armed ? ['第一步：用 skill 工具加载技能 "validate-data"，并严格按该技能的工作流执行下面的请求。'] : []),
    `业务请求：${request}`,
    `可用输入：${files.map(file => `fileId "${file.fileId}"（${file.name}）`).join('、')}。`,
    '数据表已注册为 tableId "data"，列名与 CSV 表头一致；trial_compute 的 operation、column、filters 请按该工具描述填写。',
    expectsReport
      ? '完成后必须用 trial_write_report 写出核验报告，包含检查范围、逐条发现与依据、计算抽查、建议与限制。'
      : '请直接给出你的回应；只有确有必要时才写报告。',
    '请连续调用工具直到完成，不要中途停下等待确认。',
    '为提高效率，你可以在同一次回复里并行发起多个工具调用（例如同时读取多个文件、同时发起多个聚合），不必一次只调用一个。',
  ].join('\n');
}

function withDeadline(promise, ms, fallback) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runTask(t, { taskId, index, root, group, recordDir, resolved }) {
  const started = Date.now();
  const cwd = join(root, 'workspace');
  const sessions = join(root, 'sessions');
  const skillRoot = join(root, 'skill-root');
  await mkdir(join(cwd, 'inputs'), { recursive: true });
  await mkdir(join(cwd, 'outputs'), { recursive: true });
  await mkdir(sessions, { recursive: true });
  await mkdir(join(root, 'run'), { recursive: true });
  await mkdir(join(root, 'batch'), { recursive: true });
  if (skillArmed) await mkdir(join(skillRoot, 'validate-data'), { recursive: true });
  await mkdir(skillRoot, { recursive: true });

  // 终测材料只经托管区交付：copyInto 只给该题声明的输入，且托管根必须与执行根不相交。
  const handed = await terminalSet.copyInto({ taskId, runRoot: cwd });
  const roots = assertRootsDisjoint({ custodianRoot: terminalSet.custodianRoot,
    roots: [join(cwd, 'inputs'), join(cwd, 'outputs'), skillRoot] });
  const materials = {};
  for (const input of handed.inputs) {
    materials[input.name] = input.sha256;
    materials[`${input.name}:bytes`] = input.bytes;
  }
  const skillPath = join(skillRoot, 'validate-data', 'SKILL.md');
  if (skillArmed) {
    await writeFile(skillPath, await readFile(resolved.sourcePath));
    assert.equal(await sha256(skillPath), resolved.skillDigest, 'the armed skill identity must survive the copy');
    materials['skill:bytes'] = (await stat(skillPath)).size;
  } else {
    assert.deepEqual(await readdir(skillRoot), [], 'the no-skill arm must not put anything under the skill root');
  }

  const csvText = await readFile(join(cwd, 'inputs', 'data.csv'), 'utf8');
  const parsed = parseCsv(csvText, { maxBytes: 65536, maxRows: 200, maxColumns: 16, maxCellChars: 256 });
  const tableRows = { data: { headers: parsed.headers, rows: parsed.rows,
    sha256: createHash('sha256').update(csvText).digest('hex') } };

  const sessionId = `t-${arm}-${taskId}-r${repeat}-${stamp}`;
  const binding = {
    runId: `run-${sessionId}`, batchId: `terminal-${setId}`, sessionId,
    skillDigest: resolved.skillDigest,
    inputDigest: digest(JSON.stringify(Object.entries(materials).sort())),
    evaluatorDigest: RUBRIC_SHA,
    environmentDigest: ENVIRONMENT_DIGEST,
    policyDigest: POLICY_DIGEST,
  };
  const files = handed.inputs.map(input => ({ fileId: input.name.startsWith('report') ? 'report' : 'data',
    path: join(cwd, 'inputs', input.name), sha256: input.sha256, bytes: input.bytes,
    maxBytes: RUN_LIMITS.maxRequestBytes }))
    .concat(skillArmed ? [{ fileId: 'skill', path: skillPath, sha256: resolved.skillDigest,
      bytes: materials['skill:bytes'], maxBytes: 65536 }] : []);
  const toolNames = [...toolScopeFor({ armed: skillArmed })];
  const gate = await preflight({
    manifest: { ...binding, arm, files,
      toolNames,
      modelSelection: { provider: 'vod', model: 'gemini-3.8-flash' },
      budget: RUN_LIMITS,
      authorization: { reference: AUTHORIZATION_REFERENCE, scopeDigest: POLICY_DIGEST } },
    capabilities: {
      installedDshVersion: '0.1.5-rc.2', readBoundaryVerified: true, requestAttemptsCovered: true,
      stopVerified: true, nativeSessionVerified: true, authorizationVerified: true,
      approvedModel: { provider: 'vod', model: 'gemini-3.8-flash' },
      approvedEnvironmentDigest: binding.environmentDigest,
      approvedToolNames: [...toolNames],
      approvedFiles: files.map(file => ({ fileId: file.fileId, sha256: file.sha256, maxBytes: file.maxBytes })),
      authorization: { reference: AUTHORIZATION_REFERENCE, scopeDigest: POLICY_DIGEST },
    },
  });

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
  let adapterCalls = 0;
  if (!isLive) {
    const model = Object.freeze({ provider: 'trial-provider', id: 'trial-model', name: 'Trial Model',
      context: { contextWindow: 8192 }, defaultMaxTokens: 256 });
    class ScriptedAdapter extends llmMod.LlmAdapter {
      async prepareCall() { return { model, stream: () => this.run() }; }
      async *run() {
        adapterCalls += 1;
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

  const run = await openRun({ root: join(root, 'run'), binding });
  await run.start();
  const filesApi = await openFiles({ run, binding, inputRoot: join(cwd, 'inputs'), skillRoot,
    outputRoot: join(cwd, 'outputs'),
    files: handed.inputs.map(input => ({ fileId: input.name.startsWith('report') ? 'report' : 'data',
      path: join(cwd, 'inputs', input.name), role: 'input' }))
      .concat(skillArmed ? [{ fileId: 'skill', path: skillPath, role: 'skill' }] : []),
    limits: { maxInputBytes: 65536, maxReportBytes: 65536 } });
  const ledger = await openBudget({ run, binding, root: join(root, 'batch'), limits: RUN_LIMITS });
  const budget = composeBudget({ ledger, group });
  const audit = [];
  const streamKinds = [];
  const finishKinds = [];
  const textParts = [];
  const handle = await ctx.get('agentLoop').create(sessionId,
    { provider: isLive ? 'vod' : 'trial-provider',
      model: isLive ? 'gemini-3.8-flash' : 'trial-model',
      maxTokens: RUN_LIMITS.maxOutputTokensPerAttempt }, { cwd });
  const skillToolVisible = Boolean(ctx.tools.get('skill', handle));
  assert.equal(skillToolVisible, skillArmed, skillArmed
    ? 'an armed run must expose the skill tool'
    : 'the no-skill arm must not expose the skill tool');
  const control = await installTrialControl({
    agent: handle, run, binding, files: filesApi, budget, waitMs: RUN_LIMITS.attemptTimeoutMs,
    tables: new Map(Object.entries(tableRows)), defineTool: toolsMod.defineTool,
    ...(skillArmed ? { allowedSkillNames: ['validate-data'] } : {}),
    requestIdentity: () => ({ runId: binding.runId, sessionId: binding.sessionId }),
    measureRequest: request => Buffer.byteLength(JSON.stringify(request.messages ?? ''), 'utf8'),
    audit: entry => { audit.push(entry); },
  });
  ctx.on('llm/stream', (options, next) => (async function* observe() {
    for await (const chunk of await next()) {
      streamKinds.push(chunk?.type ?? '?');
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') textParts.push(chunk.text);
      if (chunk?.type === 'finish') {
        const reason = chunk.reason ?? {};
        const detail = reason.failure ? `${reason.failure.code ?? '?'}:${String(reason.failure.message ?? '').slice(0, 160)}` : '';
        finishKinds.push(`${reason.kind ?? '?'}${detail ? '[' + detail + ']' : ''}`);
      }
      yield chunk;
    }
  })());
  if (!isLive) {
    if (skillArmed) scripts.push(toolCallTurn(`t-${index}-1`, 'skill', { name: 'validate-data' }));
    scripts.push(toolCallTurn(`t-${index}-2`, 'trial_read', { fileId: 'report', offset: 0, limit: 4000 }));
    scripts.push(toolCallTurn(`t-${index}-3`, 'trial_read', { fileId: 'data', offset: 0, limit: 4000 }));
    scripts.push(toolCallTurn(`t-${index}-4`, 'trial_compute', { operation: 'sum', tableId: 'data', column: 'revenue' }));
    scripts.push(toolCallTurn(`t-${index}-5`, 'trial_write_report', { content: skillArmed
      ? '# 核验报告（脚本化 dry-run）\n\n- 已通过原生 skill 工具加载技能，材料只经终端托管区交付\n- 本文件由 capture 档生成，不代表真实判定\n'
      : '# 核验报告（脚本化 dry-run · 无技能臂）\n\n- 本次未装配任何技能，材料只经终端托管区交付\n- 本文件由 capture 档生成，不代表真实判定\n' }));
    scripts.push(textTurn('脚本化 dry-run 完成'));
  }

  const request = handed.request;
  // 补救重跑用：按次覆盖"是否需要报告"（w03 的三道非核验题在封存时漏标 expectsReport=false）。
  // manifest 不追改；覆盖事实写进记录，作为登记的偏差。
  const override = process.env.T_EXPECTS_REPORT_OVERRIDE === undefined
    ? null : process.env.T_EXPECTS_REPORT_OVERRIDE === '1';
  const expectsReport = override === null ? terminalSet.expectsReport(taskId) : override;
  const prompt = buildPrompt({ request, files: files.filter(file => file.fileId !== 'skill'),
    expectsReport, armed: skillArmed });
  let outcome = 'not-sent';
  let stopError = null;
  try {
    handle.send(llmMod.createUserMessage({ content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' } }), 'next-turn', true);
    outcome = await withDeadline(handle.whenIdle().then(() => 'idle'), 600000, 'timeout');
  } finally {
    try { await control.stop('terminal-task-finished'); } catch (error) { stopError = error?.code ?? String(error); }
    await filesApi.close().catch(() => {});
  }

  let report = null;
  try {
    const content = await readFile(join(cwd, 'outputs', 'validation-report.md'), 'utf8');
    report = { written: true, bytes: Buffer.byteLength(content), content,
      sha256: createHash('sha256').update(content).digest('hex') };
  } catch { report = { written: false, bytes: 0, content: null, sha256: null }; }
  const ledgerSnapshot = ledger.snapshot();
  const groupSnapshot = group.snapshot();
  const toolCalls = audit.filter(entry => entry.kind === 'tool_call')
    .map(({ tool, callId, ok, code, fileId, operation, column, filterCount, contentBytes }) =>
      ({ tool, callId, ok, code, fileId, operation, column, filterCount, contentBytes }));
  const skillLoads = audit.filter(entry => entry.kind === 'tool_admitted' && entry.tool === 'skill')
    .map(entry => entry.skillName);
  const skillLoaded = skillLoads.includes('validate-data');
  const record = {
    record_type: 'terminal_task', mode, arm, skill_armed: skillArmed,
    skill_tool_visible: skillToolVisible, tool_scope: toolNames,
    repeat, observed_at: new Date().toISOString(),
    terminal: { setId, taskId, request, expectsReport,
      expectsReportOverride: override === null ? null : { forced: override, manifestValue: terminalSet.expectsReport(taskId) },
      prompt,
      inputs: handed.inputs,
      custodianRoot: terminalSet.custodianRoot, rootsDisjoint: roots.roots.length,
      ledger: runDir },
    candidate_id: resolved.candidateId, skill_digest: skillArmed ? resolved.skillDigest : null,
    outcome, wall_ms: Date.now() - started,
    preflight: { status: gate.status, blockers: gate.blockers },
    attempts: { settled: ledgerSnapshot.attemptsSettled, unknown: ledgerSnapshot.attemptsUnknown,
      reserved: ledgerSnapshot.attemptsReserved, max_attempts: RUN_LIMITS.maxAttempts,
      observed_input_tokens: ledgerSnapshot.observedInputTokens,
      observed_output_tokens: ledgerSnapshot.observedOutputTokens },
    group: { attempts_dispatched: groupSnapshot.attemptsDispatched,
      observed_token_total: groupSnapshot.observedTokenTotal },
    tool_calls: toolCalls, native_skill_loads: skillLoads,
    skill_loaded: skillLoaded,
    report, final_text: textParts.join(''),
    stream_kinds: streamKinds, finish_kinds: finishKinds,
    denials: audit.filter(entry => entry.kind !== 'tool_call' && entry.kind !== 'request_reserved'
      && entry.kind !== 'request_settled'),
    stop_error: stopError,
    incomplete: (skillArmed && !skillLoaded) || (expectsReport && !report.written),
    incomplete_reason: skillArmed && !skillLoaded ? 'SKILL_NOT_LOADED'
      : (expectsReport && !report.written ? 'REPORT_NOT_WRITTEN' : null),
    claim_scope: { attempts_hard_limit: true, soft_thresholds: true, cost_hard_limit: false },
  };
  await writeFile(join(recordDir, `${arm}-${taskId}-r${repeat}.json`), `${JSON.stringify(record, null, 2)}\n`);

  await ledger.close().catch(() => {});
  await run.close().catch(() => {});
  try { await ctx.fiber?.dispose?.(); } catch { /* best effort */ }
  return record;
}

async function recordFreshness({ taskIds, allowBurned = false }) {
  try {
    await assertFresh({ root: terminalRoot, setId, taskIds });
    return { freshBeforeReveal: true, burnedBy: [] };
  } catch (error) {
    if (error.code !== 'TASK_BURNED') throw error;
    const burnedBy = Array.isArray(error.taskIds) ? error.taskIds
      : error.message.replace('TASK_BURNED: ', '').split(',').map(item => item.trim());
    if (!allowBurned && process.env.T_ALLOW_BURNED !== '1') {
      throw new Error(`terminal tasks already burned (${burnedBy.join(',')}); set T_ALLOW_BURNED=1 only when the same round already released answers`);
    }
    return { freshBeforeReveal: false, burnedBy, allowedBy: allowBurned ? 'capture-rehearsal' : 'T_ALLOW_BURNED=1' };
  }
}

test('the terminal rehearsal hands over only declared inputs (zero egress)', async (t) => {
  if (isLive) return;
  const resolved = await resolveArm();
  await recordFreshness({ taskIds, allowBurned: true });
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(runDir, { recursive: true });
  const recordDir = await realpath(evidenceDir);
  const runRoot = await realpath(runDir);
  const group = await openBatchGroup({ root: runRoot, groupId: `terminal-${setId}`, limits: GROUP_LIMITS });
  const records = [];
  for (const [index, taskId] of taskIds.entries()) {
    const root = join(runRoot, `${arm}-${taskId}-r${repeat}`);
    await mkdir(root, { recursive: true });
    records.push(await runTask(t, { taskId, index, root, group, recordDir, resolved }));
  }
  for (const record of records) {
    assert.equal(record.outcome, 'idle');
    assert.equal(record.skill_armed, skillArmed);
    assert.equal(record.skill_loaded, skillArmed, 'only an armed run may load a skill');
    assert.equal(record.preflight.status, 'ready');
    assert.equal(record.report.written, record.terminal.expectsReport);
    assert.equal(record.terminal.rootsDisjoint, 3);
    assert.deepEqual(record.terminal.inputs.map(input => input.name).sort(), ['data.csv', 'report.md']);
    assert.deepEqual(record.tool_scope, [...toolScopeFor({ armed: skillArmed })]);
    if (!skillArmed) {
      assert.equal(record.skill_digest, null, 'a no-skill record carries no skill digest');
      assert.equal(record.candidate_id, null);
      assert.deepEqual(record.native_skill_loads, []);
      assert.equal(record.incomplete, false, 'a missing skill is not an incomplete run when none is armed');
    }
  }
  await group.close();
  if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
});

test('the approved terminal run executes the held-out tasks once per arm', async (t) => {
  if (!isLive) return;
  const settingsBefore = await sha256(SETTINGS);
  const resolved = await resolveArm();
  const freshness = await recordFreshness({ taskIds });
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(runDir, { recursive: true });
  const recordDir = await realpath(evidenceDir);
  const runRoot = await realpath(runDir);
  const group = await openBatchGroup({ root: runRoot, groupId: `terminal-${setId}`, limits: GROUP_LIMITS });
  const records = [];
  for (const [index, taskId] of taskIds.entries()) {
    const root = join(runRoot, `${arm}-${taskId}-r${repeat}`);
    await mkdir(root, { recursive: true });
    records.push(await runTask(t, { taskId, index, root, group, recordDir, resolved }));
  }
  assert.equal(records.length, taskIds.length);
  assert.equal(await sha256(SETTINGS), settingsBefore, 'settings must stay unchanged');
  // 放行答案会烧题：默认不做，需显式 T_REVEAL=1（在两臂都跑完之后再收尾）。
  const revealed = [];
  if (process.env.T_REVEAL === '1') {
    for (const taskId of taskIds) {
      revealed.push(await reveal({ root: terminalRoot, setId, taskId, actor: 'judge',
        reason: `terminal run ${stamp} (${arm}) — answers released to the custodian record` }));
    }
  }
  await writeFile(join(recordDir, `batch-${arm}.json`), `${JSON.stringify({
    record_type: 'terminal_batch', arm, skill_armed: skillArmed, mode, setId,
    observed_at: new Date().toISOString(),
    tasks: taskIds, group: group.snapshot(), settings_unchanged: true,
    freshness,
    answers_released: revealed.map(entry => ({ taskId: entry.taskId, answers: entry.answers })),
    skill_digest: skillArmed ? resolved.skillDigest : null, candidate_id: resolved.candidateId,
  }, null, 2)}\n`);
  await group.close();
});

const NEW_SKILL_TASKS = [{
  taskId: 'n-t1',
  request: '请界定本次请求是否属于本技能的处理范围，并给出你的回应。材料：报告 report.md、数据表 data.csv。',
  files: [
    { name: 'report.md', content: '# 月度数据核对（节选）\n\n- 本月营收 58.8 万元。\n' },
    { name: 'data.csv', content: 'month,revenue\n1月,196000\n2月,196000\n3月,196000\n' },
  ],
  answers: ['需要界定：请求属于核验范围，按流程核对并给出依据'],
}];

test('the no-skill arm runs a new-skill set end to end (zero egress)', async (t) => {
  if (isLive || process.env.T_SET_ROOT !== undefined) return;
  const root = await mkdtemp(join(await realpath(tmpdir()), 'new-skill-set-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  await sealTerminalSet({ root, setId: 'n1', arms: ['none', 'candidate'], tasks: NEW_SKILL_TASKS });
  // 嵌套 test runner 必须剥掉测试上下文变量，否则子进程的 node --test 不产出任何结果。
  const childEnv = { ...process.env, T_MODE: 'capture', T_ARM: 'none', T_SET: 'n1', T_SET_ROOT: root,
    T_TASKS: 'n-t1', T_RUN_DIR: join(root, 'runs'), T_EVIDENCE_DIR: join(root, 'evidence') };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;
  const child = await execFileAsync(process.execPath,
    ['--test', fileURLToPath(import.meta.url)], {
      cwd: join(import.meta.dirname, '..', '..'),
      env: childEnv,
      timeout: 300000,
    });
  assert.match(child.stdout, /ℹ fail 0/, 'the no-skill rehearsal must be green');
  const record = JSON.parse(await readFile(join(root, 'evidence', 'none-n-t1-r1.json'), 'utf8'));
  assert.equal(record.arm, 'none');
  assert.equal(record.skill_armed, false);
  assert.equal(record.skill_tool_visible, false);
  assert.equal(record.skill_digest, null);
  assert.equal(record.skill_loaded, false);
  assert.equal(record.incomplete, false);
  assert.equal(record.preflight.status, 'ready');
  assert.deepEqual(record.tool_scope, ['trial_read', 'trial_compute', 'trial_write_report']);
  assert.equal(record.terminal.prompt.includes('skill'), false,
    'the no-skill prompt must not talk about loading a skill');
  assert.equal(record.terminal.prompt.includes('trial_read'), true);
  assert.deepEqual(record.tool_calls.map(call => call.tool), ['trial_read', 'trial_read', 'trial_compute', 'trial_write_report']);
  assert.equal(record.terminal.setId, 'n1');
});

test('a set refuses an arm its policy does not carry', async (t) => {
  if (process.env.T_SET_ROOT !== undefined) return;
  const root = await mkdtemp(join(await realpath(tmpdir()), 'new-skill-set-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  await sealTerminalSet({ root, setId: 'n1', arms: ['none', 'candidate'], tasks: NEW_SKILL_TASKS });
  assert.throws(() => assertArmAllowed(['none', 'candidate'], 'original'), /ARM_NOT_ALLOWED: original/);
  assert.throws(() => assertArmAllowed(['original', 'candidate'], 'none'), /ARM_NOT_ALLOWED: none/);
  assert.throws(() => isArmed('beta'), /INVALID_ARM/);
  const existing = await sealTerminalSet({ root, setId: 'w9', tasks: NEW_SKILL_TASKS });
  const set = await openTerminalSet({ root, setId: 'w9' });
  assert.deepEqual(set.arms, ['original', 'candidate']);
  assert.equal(existing.taskIds.length, 1);
});
