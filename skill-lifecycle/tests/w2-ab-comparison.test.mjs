import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openRun } from '../control/run-state.mjs';
import { openFiles } from '../control/bounded-files.mjs';
import { openBudget } from '../control/budget-ledger.mjs';
import { openBatchGroup, composeBudget } from '../control/batch-group.mjs';
import { installTrialControl } from '../control/dsh-plugin.mjs';
import { parseCsv } from '../control/table-compute.mjs';
import { preflight } from '../control/preflight.mjs';

// 运行时基座（2026-10-01 切换 Sage）：T_APP_ROOT 覆盖 → Sage 内置 harness 构建 → Sage 开发树（dist 重建窗口兜底）→ 旧应用路径；找不到即显式失败。
const APP = (() => {
  const fs = process.getBuiltinModule('node:fs');
  const path = process.getBuiltinModule('node:path');
  const candidates = [
    process.env.T_APP_ROOT,
    '/Users/lute/project/Sage/vendor/dsh-desktop/dsh-plugin-desktop/dist/mac-arm64/DSH Desktop.app/Contents/Resources/app',
    '/Users/lute/project/Sage/vendor/dsh-desktop/dsh-plugin-desktop',
    '/Applications/DSH Desktop.app/Contents/Resources/app',
  ].filter(Boolean);
  const found = candidates.find(candidate => fs.existsSync(path.join(candidate, 'package.json')));
  if (!found) throw new Error(`harness app root 未找到（试过：${candidates.join(' | ')}；可用 T_APP_ROOT 指定）`);
  return found;
})();
const TRIAL_HOME = join(import.meta.dirname, '..', 'trial-home');
const A4_HOME = join(TRIAL_HOME, 'a4');
const SETTINGS = join(homedir(), '.dsh', 'settings.yaml');
const STORE = join(homedir(), '.dsh', '.credentials.yaml');
const RUBRIC_DOC = join(import.meta.dirname, '..', '..', 'docs', 'specs',
  '2026-09-25-dsh-skill-lifecycle', 'a4-A4任务集与判定口径.md');
const AUTHORIZATION_REFERENCE = 'D21-w2-ab-comparison';
const FROZEN_SKILL_SHA = '1e424822043480375b80aef9416227b1c8083af749ca536568716265f79ca54b';
const DEFAULT_TASKS = ['t7-near-neighbor', 't2-recompute', 't6-boundary'];
const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const digest = label => createHash('sha256').update(label).digest('hex');
const require_ = createRequire(join(APP, 'package.json'));
const load = async name => await import(pathToFileURL(require_.resolve('@deepseek-ai/' + name)).href);

// W2_MODE=live runs the approved arms; anything else is a scripted zero-egress rehearsal.
const mode = process.env.W2_MODE ?? 'capture';
const isLive = mode === 'live';
const arm = process.env.W2_ARM ?? 'original';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
// 未显式给出目录时（例如全量回归），排练在临时目录里跑并自清理，不污染 trial-home 证据区。
const explicitDirs = Boolean(process.env.W2_RUN_DIR && process.env.W2_EVIDENCE_DIR);
const scratch = explicitDirs ? null : await mkdtemp(join(await realpath(tmpdir()), 'w2-'));
const runDir = process.env.W2_RUN_DIR ?? join(scratch, 'runs');
const evidenceDir = process.env.W2_EVIDENCE_DIR ?? join(scratch, 'evidence');
const manifest = JSON.parse(await readFile(join(A4_HOME, 'manifest.json'), 'utf8'));
const batch = manifest.batch;
const connection = JSON.parse(await readFile(join(TRIAL_HOME, 't09-connection.json'), 'utf8'));
const RUBRIC_SHA = await sha256(RUBRIC_DOC);
const ENVIRONMENT_DIGEST = digest('w2-ab-comparison-narrow-graph');
const POLICY_DIGEST = digest(`${AUTHORIZATION_REFERENCE}:${JSON.stringify(batch.limits)}`);
const taskIds = (process.env.W2_TASKS ?? DEFAULT_TASKS.join(',')).split(',').map(id => id.trim());
const repeat = Number(process.env.W2_REPEAT ?? 1);
assert.ok(Number.isSafeInteger(repeat) && repeat >= 1, 'W2_REPEAT must be a positive integer');
const selected = taskIds.map(id => {
  const task = manifest.tasks.find(candidate => candidate.taskId === id);
  assert.ok(task, `unknown task ${id}`);
  return task;
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
  if (arm === 'original') {
    return { arm, skillDigest: FROZEN_SKILL_SHA, sourcePath: join(TRIAL_HOME, 'skills', 'validate-data', 'SKILL.md'),
      candidateId: null, hypothesis: null };
  }
  const candidateId = process.env.W2_CANDIDATE ?? 't7-boundary-001';
  const candidateRoot = join(TRIAL_HOME, 'candidates', candidateId);
  const recorded = JSON.parse(await readFile(join(candidateRoot, 'candidate.json'), 'utf8'));
  assert.equal(recorded.candidateId, candidateId);
  assert.equal(recorded.sealed, true, 'only a sealed candidate may be evaluated');
  const sourcePath = join(candidateRoot, 'candidate', 'SKILL.md');
  const actual = await sha256(sourcePath);
  assert.equal(actual, recorded.candidateDigest, 'the sealed candidate must keep its identity');
  assert.equal(await sha256(join(TRIAL_HOME, 'skills', 'validate-data', 'SKILL.md')), FROZEN_SKILL_SHA,
    'the frozen original must be untouched while a candidate is under test');
  return { arm, skillDigest: actual, sourcePath, candidateId,
    hypothesis: recorded.hypothesis, changes: recorded.changes, sourceDigest: recorded.source.digest };
}

function buildPrompt(task) {
  const lines = [
    '你运行在一个受限核验环境中：可用工具只有 skill（加载已注册技能）、trial_read（按 fileId 读取）、trial_compute（对已批准表格做固定聚合）与 trial_write_report（写出报告）。',
    '第一步：用 skill 工具加载技能 "validate-data"，并严格按该技能的工作流执行下面的请求。',
    `业务请求：${task.request}`,
    `可用输入：${task.files.map(file => `fileId "${file.fileId}"（${file.name}）`).join('、')}。`,
    `数据表已注册为 tableId "${task.table.tableId}"，列名与 CSV 表头一致；trial_compute 的 operation、column、filters 请按该工具描述填写。`,
    task.expectsReport
      ? '完成后必须用 trial_write_report 写出核验报告，包含检查范围、逐条发现与依据、计算抽查、建议与限制。'
      : '请直接给出你的回应；只有确有必要时才写报告。',
    '请连续调用工具直到完成，不要中途停下等待确认。',
    '为提高效率，你可以在同一次回复里并行发起多个工具调用（例如同时读取多个文件、同时发起多个聚合），不必一次只调用一个。',
  ];
  return lines.join('\n');
}

function runLimits() {
  return { maxAttempts: batch.limits.maxAttemptsPerTask,
    maxOutputTokensPerAttempt: batch.limits.maxOutputTokensPerAttempt,
    maxRequestBytes: batch.limits.maxRequestBytes,
    observedTokenStop: batch.limits.observedTokenStop,
    batchDeadlineMs: batch.limits.batchDeadlineMs,
    attemptTimeoutMs: batch.limits.attemptTimeoutMs };
}

function withDeadline(promise, ms, fallback) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runTask(t, { task, index, root, group, recordDir, resolved }) {
  const started = Date.now();
  const cwd = join(root, 'workspace');
  const sessions = join(root, 'sessions');
  const skillRoot = join(root, 'skill-root');
  await mkdir(join(cwd, 'inputs'), { recursive: true });
  await mkdir(join(cwd, 'outputs'), { recursive: true });
  await mkdir(sessions, { recursive: true });
  await mkdir(join(root, 'run'), { recursive: true });
  await mkdir(join(root, 'batch'), { recursive: true });
  await mkdir(join(skillRoot, 'validate-data'), { recursive: true });

  const materials = {};
  for (const file of task.files) {
    const source = join(A4_HOME, 'tasks', task.taskId, file.name);
    const target = join(cwd, 'inputs', file.name);
    await copyFile(source, target);
    materials[file.fileId] = await sha256(target);
    materials[`${file.fileId}:bytes`] = (await stat(target)).size;
  }
  const skillPath = join(skillRoot, 'validate-data', 'SKILL.md');
  await copyFile(resolved.sourcePath, skillPath);
  assert.equal(await sha256(skillPath), resolved.skillDigest, 'the armed skill identity must survive the copy');
  materials['skill:bytes'] = (await stat(skillPath)).size;

  const csvText = await readFile(join(cwd, 'inputs', 'data.csv'), 'utf8');
  const parsed = parseCsv(csvText, { maxBytes: 65536, maxRows: 200, maxColumns: 16, maxCellChars: 256 });
  const tableRows = { [task.table.tableId]: { headers: parsed.headers, rows: parsed.rows,
    sha256: createHash('sha256').update(csvText).digest('hex') } };

  const sessionId = `w2-${arm}-${task.taskId}-r${repeat}-${stamp}`;
  const binding = {
    runId: `run-${sessionId}`, batchId: `${batch.batchId}-w2`, sessionId,
    skillDigest: resolved.skillDigest,
    inputDigest: digest(JSON.stringify(Object.entries(materials).sort())),
    evaluatorDigest: RUBRIC_SHA,
    environmentDigest: ENVIRONMENT_DIGEST,
    policyDigest: POLICY_DIGEST,
  };
  const files = [
    ...task.files.map(file => ({ fileId: file.fileId, path: join(cwd, 'inputs', file.name),
      sha256: materials[file.fileId], bytes: materials[`${file.fileId}:bytes`],
      maxBytes: batch.limits.maxRequestBytes })),
    { fileId: 'skill', path: skillPath, sha256: resolved.skillDigest,
      bytes: materials['skill:bytes'], maxBytes: 65536 },
  ];
  const gate = await preflight({
    manifest: { ...binding, files,
      toolNames: ['skill', 'trial_read', 'trial_compute', 'trial_write_report'],
      modelSelection: { provider: batch.route.provider, model: batch.route.model },
      budget: runLimits(),
      authorization: { reference: AUTHORIZATION_REFERENCE, scopeDigest: POLICY_DIGEST } },
    capabilities: {
      installedDshVersion: '0.1.5-rc.2', readBoundaryVerified: true, requestAttemptsCovered: true,
      stopVerified: true, nativeSessionVerified: true, authorizationVerified: true,
      approvedModel: { provider: batch.route.provider, model: batch.route.model },
      approvedEnvironmentDigest: binding.environmentDigest,
      approvedToolNames: ['skill', 'trial_read', 'trial_compute', 'trial_write_report'],
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
  if (process.env.W2_DEBUG) {
    ctx.on('agent/pre-step', async (payload, next) => {
      try {
        const decision = await next();
        console.log('W2-DEBUG pre-step kind:', decision?.kind,
          'messages:', Array.isArray(decision?.messages) ? decision.messages.length : null,
          'reason:', decision?.reason ?? null);
        return decision;
      } catch (error) {
        console.log('W2-DEBUG pre-step error:', error?.message, String(error?.stack ?? '').split('\n')[1]);
        throw error;
      }
    });
  }
  await ctx.plugin(plugins.registry, {});
  const isolated = {};
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
  const providerId = isLive ? batch.route.provider : 'trial-provider';
  const modelId = isLive ? batch.route.model : 'trial-model';

  const run = await openRun({ root: join(root, 'run'), binding });
  await run.start();
  const filesApi = await openFiles({ run, binding, inputRoot: join(cwd, 'inputs'), skillRoot,
    outputRoot: join(cwd, 'outputs'),
    files: task.files.map(file => ({ fileId: file.fileId, path: join(cwd, 'inputs', file.name), role: 'input' }))
      .concat([{ fileId: 'skill', path: skillPath, role: 'skill' }]),
    limits: { maxInputBytes: 65536, maxReportBytes: 65536 } });
  const ledger = await openBudget({ run, binding, root: join(root, 'batch'), limits: runLimits() });
  const budget = composeBudget({ ledger, group });
  const audit = [];
  const streamKinds = [];
  const finishKinds = [];
  const textParts = [];
  const handle = await ctx.get('agentLoop').create(sessionId,
    { provider: providerId, model: modelId, maxTokens: batch.limits.maxOutputTokensPerAttempt }, { cwd });
  const control = await installTrialControl({
    agent: handle, run, binding, files: filesApi, budget, waitMs: batch.limits.attemptTimeoutMs,
    tables: new Map(Object.entries(tableRows)), defineTool: toolsMod.defineTool,
    allowedSkillNames: ['validate-data'],
    requestIdentity: () => ({ runId: binding.runId, sessionId: binding.sessionId }),
    measureRequest: request => Buffer.byteLength(JSON.stringify(request.messages ?? []), 'utf8'),
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
    scripts.push(toolCallTurn(`w2-${index}-1`, 'skill', { name: 'validate-data' }));
    if (task.files.some(file => file.fileId === 'report')) {
      scripts.push(toolCallTurn(`w2-${index}-2`, 'trial_read', { fileId: 'report', offset: 0, limit: 4000 }));
    }
    scripts.push(toolCallTurn(`w2-${index}-3`, 'trial_read', { fileId: 'data', offset: 0, limit: 4000 }));
    scripts.push(toolCallTurn(`w2-${index}-4`, 'trial_compute', { operation: 'count', tableId: 'data' }));
    if (task.expectsReport) {
      scripts.push(toolCallTurn(`w2-${index}-5`, 'trial_write_report', { content:
        '# 核验报告（脚本化 dry-run）\n\n- 已通过原生 skill 工具加载技能\n- 本文件由 capture 档生成，不代表真实判定\n' }));
    }
    scripts.push(textTurn('脚本化 dry-run 完成'));
  }

  let outcome = 'not-sent';
  let stopError = null;
  try {
    handle.send(llmMod.createUserMessage({
      content: [{ type: 'text', text: buildPrompt(task) }],
      source: { kind: 'user' },
    }), 'next-turn', true);
    outcome = await withDeadline(handle.whenIdle().then(() => 'idle'), 600000, 'timeout');
    if (process.env.W2_DEBUG) {
      console.log('W2-DEBUG after send:', JSON.stringify({ outcome, adapterCalls,
        scriptsLeft: scripts.length, phase: typeof handle.phase === 'object' ? { ...handle.phase, abort: undefined } : handle.phase,
        status: handle.status }));
    }
  } finally {
    try { await control.stop('w2-task-finished'); } catch (error) { stopError = error?.code ?? String(error); }
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
  const record = {
    record_type: 'w2_ab_task', mode, arm, repeat, observed_at: new Date().toISOString(),
    batch_id: `${batch.batchId}-w2`, task_id: task.taskId, task_category: task.category,
    candidate_id: resolved.candidateId, skill_digest: resolved.skillDigest,
    hypothesis_claim: resolved.hypothesis?.claim ?? null,
    outcome, wall_ms: Date.now() - started,
    preflight: { status: gate.status, blockers: gate.blockers },
    attempts: { settled: ledgerSnapshot.attemptsSettled, unknown: ledgerSnapshot.attemptsUnknown,
      reserved: ledgerSnapshot.attemptsReserved, max_attempts: batch.limits.maxAttemptsPerTask,
      observed_input_tokens: ledgerSnapshot.observedInputTokens,
      observed_output_tokens: ledgerSnapshot.observedOutputTokens },
    group: { attempts_dispatched: groupSnapshot.attemptsDispatched,
      observed_token_total: groupSnapshot.observedTokenTotal },
    tool_calls: toolCalls, native_skill_loads: skillLoads,
    skill_loaded: skillLoads.includes('validate-data'),
    report, final_text: textParts.join(''),
    stream_kinds: streamKinds, finish_kinds: finishKinds,
    denials: audit.filter(entry => entry.kind !== 'tool_call' && entry.kind !== 'request_reserved'
      && entry.kind !== 'request_settled'),
    stop_error: stopError,
    incomplete: !skillLoads.includes('validate-data') || (task.expectsReport && !report.written),
    incomplete_reason: !skillLoads.includes('validate-data') ? 'SKILL_NOT_LOADED'
      : (task.expectsReport && !report.written ? 'REPORT_NOT_WRITTEN' : null),
    claim_scope: { attempts_hard_limit: true, soft_thresholds: true, cost_hard_limit: false },
  };
  await writeFile(join(recordDir, `${arm}-${task.taskId}-r${repeat}.json`), `${JSON.stringify(record, null, 2)}\n`);

  await ledger.close().catch(() => {});
  await run.close().catch(() => {});
  try { await ctx.fiber?.dispose?.(); } catch { /* best effort */ }
  return record;
}

test('the arm rehearses every task through the native skill loader (zero egress)', async (t) => {
  if (isLive) return;
  const resolved = await resolveArm();
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(runDir, { recursive: true });
  const recordDir = await realpath(evidenceDir);
  const runRoot = await realpath(runDir);
  const group = await openBatchGroup({ root: runRoot, groupId: `${batch.batchId}-w2`,
    limits: { maxAttempts: 80, observedTokenStop: 400000, batchDeadlineMs: 3600000 } });
  const records = [];
  for (const [index, task] of selected.entries()) {
    const root = join(runRoot, `${arm}-${task.taskId}-r${repeat}`);
    await mkdir(root, { recursive: true });
    records.push(await runTask(t, { task, index, root, group, recordDir, resolved }));
  }
  for (const record of records) {
    assert.equal(record.outcome, 'idle');
    assert.equal(record.skill_loaded, true, `${record.task_id} must load the skill natively`);
    assert.equal(record.preflight.status, 'ready');
  }
  await writeFile(join(recordDir, `batch-${arm}.json`), `${JSON.stringify({
    record_type: 'w2_ab_batch', arm, mode, observed_at: new Date().toISOString(),
    tasks: selected.map(task => task.taskId), group: group.snapshot(),
    skill_digest: resolved.skillDigest, candidate_id: resolved.candidateId, repeat,
  }, null, 2)}\n`);
  await group.close();
  if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
});

test('the arm runs the approved three tasks live and records everything', async (t) => {
  if (!isLive) return;
  const settingsBefore = await sha256(SETTINGS);
  const resolved = await resolveArm();
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(runDir, { recursive: true });
  const recordDir = await realpath(evidenceDir);
  const runRoot = await realpath(runDir);
  const group = await openBatchGroup({ root: runRoot, groupId: `${batch.batchId}-w2`,
    limits: { maxAttempts: 80, observedTokenStop: 400000, batchDeadlineMs: 3600000 } });
  const records = [];
  for (const [index, task] of selected.entries()) {
    const root = join(runRoot, `${arm}-${task.taskId}-r${repeat}`);
    await mkdir(root, { recursive: true });
    records.push(await runTask(t, { task, index, root, group, recordDir, resolved }));
  }
  assert.equal(records.length, selected.length);
  const settingsAfter = await sha256(SETTINGS);
  assert.equal(settingsBefore, settingsAfter, 'settings must stay unchanged');
  await writeFile(join(recordDir, `batch-${arm}.json`), `${JSON.stringify({
    record_type: 'w2_ab_batch', arm, mode, observed_at: new Date().toISOString(),
    tasks: selected.map(task => task.taskId), group: group.snapshot(),
    skill_digest: resolved.skillDigest, candidate_id: resolved.candidateId, repeat,
    settings_unchanged: settingsBefore === settingsAfter,
  }, null, 2)}\n`);
  await group.close();
});
