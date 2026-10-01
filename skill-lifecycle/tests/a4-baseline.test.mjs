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
const EVIDENCE = join(TRIAL_HOME, 'evidence');
const SETTINGS = join(homedir(), '.dsh', 'settings.yaml');
const STORE = join(homedir(), '.dsh', '.credentials.yaml');
const RUBRIC_DOC = join(import.meta.dirname, '..', '..', 'docs', 'specs',
  '2026-09-25-dsh-skill-lifecycle', 'a4-A4任务集与判定口径.md');
const AUTHORIZATION_REFERENCE = 'D20-a4-baseline';
const FROZEN_SKILL_SHA = '1e424822043480375b80aef9416227b1c8083af749ca536568716265f79ca54b';
const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const digest = label => createHash('sha256').update(label).digest('hex');
const require_ = createRequire(join(APP, 'package.json'));
const load = async name => await import(pathToFileURL(require_.resolve('@deepseek-ai/' + name)).href);

// A4_MODE unset|capture -> scripted adapter only (zero egress)
// A4_MODE=wake-check        -> real route mounted, wrapper refuses every request (zero egress)
// A4_MODE=live              -> the approved 7-task baseline through the real route
const mode = process.env.A4_MODE ?? 'capture';
const isLive = mode === 'live';
const isWakeCheck = mode === 'wake-check';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const amendment = process.env.A4_AMENDMENT ?? null;
const suffix = amendment ? `-${amendment.replace(/[^A-Za-z0-9-]/g, '')}` : '';

const manifest = JSON.parse(await readFile(join(A4_HOME, 'manifest.json'), 'utf8'));
const batch = manifest.batch;
const selectedTasks = process.env.A4_TASKS
  ? manifest.tasks.filter(task => process.env.A4_TASKS.split(',').map(id => id.trim()).includes(task.taskId))
  : manifest.tasks;
const connection = JSON.parse(await readFile(join(TRIAL_HOME, 't09-connection.json'), 'utf8'));
const RUBRIC_SHA = await sha256(RUBRIC_DOC);
const ENVIRONMENT_DIGEST = digest('a4-baseline-narrow-graph');
const POLICY_DIGEST = digest(`${AUTHORIZATION_REFERENCE}:${JSON.stringify(batch.limits)}`);

const { Context } = await load('cordis');
const toolsMod = await load('dsh-tools');
const llmMod = await load('dsh-llm');
const systemPromptPlugin = (await load('dsh-system-prompt')).SystemPrompt;
const agentPlugin = (await load('dsh-agent')).AgentRegistry ?? (await load('dsh-agent')).default;
const sessionPlugin = (await load('dsh-session')).default;
const persistencePlugin = (await load('dsh-session-persistence-jsonl')).default;
const projectionPlugin = (await load('dsh-session-projection')).default;
const agentLoopPlugin = (await load('dsh-agent-loop')).AgentLoop ?? (await load('dsh-agent-loop')).default;

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

async function mountRealRoute(ctx) {
  const apiKey = (connection.provider.apiKey ?? '').trim() || (await readStoreKey(connection.provider.apiKeyEnv));
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

function scriptedTurn(task, index) {
  const calls = [toolCallTurn(`a4-${index}-1`, 'trial_read', { fileId: 'skill', offset: 0, limit: 20000 })];
  if (task.files.some(file => file.fileId === 'report')) {
    calls.push(toolCallTurn(`a4-${index}-2`, 'trial_read', { fileId: 'report', offset: 0, limit: 4000 }));
  }
  calls.push(toolCallTurn(`a4-${index}-3`, 'trial_read', { fileId: 'data', offset: 0, limit: 4000 }));
  calls.push(toolCallTurn(`a4-${index}-4`, 'trial_compute', { operation: 'count', tableId: 'data' }));
  if (task.expectsReport) {
    calls.push(toolCallTurn(`a4-${index}-5`, 'trial_write_report', { content:
      `# 核验报告（脚本化 dry-run）\n\n- 已加载冻结技能并读取全部输入\n- 复算与范围说明见正式运行\n- 本文件由 capture 档生成，不代表真实判定\n` }));
  }
  calls.push(textTurn('脚本化 dry-run 完成'));
  return calls;
}

function buildPrompt(task) {
  const lines = [
    '你运行在一个受限核验环境中：可用工具只有 trial_read（按 fileId 读取）、trial_compute（对已批准表格做固定聚合）、trial_write_report（写出报告），以及加载冻结技能的权限。',
    '第一步：用 trial_read 读取 fileId "skill"（offset 0，limit 20000）加载技能全文，并严格按该技能的工作流执行下面的请求。',
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

function buildPreflightInputs({ task, binding, materials }) {
  const files = task.files.map(file => ({
    fileId: file.fileId, path: join('workspace', 'inputs', file.name),
    sha256: materials[file.fileId], maxBytes: batch.limits.maxRequestBytes,
    bytes: materials[`${file.fileId}:bytes`],
  }));
  files.push({ fileId: 'skill', path: join('skills', 'validate-data', 'SKILL.md'),
    sha256: FROZEN_SKILL_SHA, maxBytes: 65536, bytes: materials['skill:bytes'] });
  const declared = {
    ...binding,
    files,
    toolNames: ['skill', 'trial_read', 'trial_compute', 'trial_write_report'],
    modelSelection: { provider: batch.route.provider, model: batch.route.model },
    budget: runLimits(),
    authorization: { reference: AUTHORIZATION_REFERENCE, scopeDigest: POLICY_DIGEST },
  };
  const capabilities = {
    installedDshVersion: '0.1.5-rc.2',
    readBoundaryVerified: true,
    requestAttemptsCovered: true,
    stopVerified: true,
    nativeSessionVerified: true,
    authorizationVerified: true,
    approvedModel: { provider: batch.route.provider, model: batch.route.model },
    approvedEnvironmentDigest: binding.environmentDigest,
    approvedToolNames: ['skill', 'trial_read', 'trial_compute', 'trial_write_report'],
    approvedFiles: files.map(file => ({ fileId: file.fileId, sha256: file.sha256, maxBytes: file.maxBytes })),
    authorization: { reference: AUTHORIZATION_REFERENCE, scopeDigest: POLICY_DIGEST },
  };
  return { manifest: declared, capabilities };
}

function withDeadline(promise, ms, fallback) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runTask(t, { task, index, root, group, recordDir }) {
  const started = Date.now();
  const cwd = join(root, 'workspace');
  const sessions = join(root, 'sessions');
  await mkdir(join(cwd, 'inputs'), { recursive: true });
  await mkdir(join(cwd, 'outputs'), { recursive: true });
  await mkdir(sessions, { recursive: true });
  await mkdir(join(root, 'run'), { recursive: true });
  await mkdir(join(root, 'batch'), { recursive: true });

  const materials = {};
  const tableRows = {};
  for (const file of task.files) {
    const source = join(A4_HOME, 'tasks', task.taskId, file.name);
    const target = join(cwd, 'inputs', file.name);
    await copyFile(source, target);
    materials[file.fileId] = await sha256(target);
    materials[`${file.fileId}:bytes`] = (await stat(target)).size;
  }
  const skillPath = join(TRIAL_HOME, 'skills', 'validate-data', 'SKILL.md');
  assert.equal(await sha256(skillPath), FROZEN_SKILL_SHA, 'the frozen skill must keep its identity');
  materials['skill:bytes'] = (await stat(skillPath)).size;
  const csvText = await readFile(join(cwd, 'inputs', 'data.csv'), 'utf8');
  const parsed = parseCsv(csvText, { maxBytes: 65536, maxRows: 200, maxColumns: 16, maxCellChars: 256 });
  tableRows[task.table.tableId] = { headers: parsed.headers, rows: parsed.rows,
    sha256: createHash('sha256').update(csvText).digest('hex') };

  const sessionId = `a4-${task.taskId}-${stamp}`;
  const binding = {
    runId: `run-${sessionId}`, batchId: batch.batchId, sessionId,
    skillDigest: FROZEN_SKILL_SHA,
    inputDigest: digest(JSON.stringify(Object.entries(materials).sort())),
    evaluatorDigest: RUBRIC_SHA,
    environmentDigest: ENVIRONMENT_DIGEST,
    policyDigest: POLICY_DIGEST,
  };
  const gate = await preflight(buildPreflightInputs({ task, binding, materials }));

  const ctx = new Context();
  await ctx.plugin(systemPromptPlugin);
  await ctx.plugin(toolsMod.ToolRuntime);
  await ctx.plugin(llmMod.LlmRuntime);
  await ctx.plugin(agentPlugin);
  await ctx.plugin(sessionPlugin);
  await ctx.plugin(persistencePlugin, { root: sessions });
  await ctx.plugin(projectionPlugin);
  await ctx.plugin(agentLoopPlugin, {});

  const scripts = [];
  let adapterCalls = 0;
  if (!isLive && !isWakeCheck) {
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
    await mountRealRoute(ctx);
  }
  const providerId = (isLive || isWakeCheck) ? batch.route.provider : 'trial-provider';
  const modelId = (isLive || isWakeCheck) ? batch.route.model : 'trial-model';

  const run = await openRun({ root: join(root, 'run'), binding });
  await run.start();
  const files = await openFiles({ run, binding, inputRoot: join(cwd, 'inputs'),
    skillRoot: join(TRIAL_HOME, 'skills'), outputRoot: join(cwd, 'outputs'),
    files: [
      ...task.files.map(file => ({ fileId: file.fileId, path: join(cwd, 'inputs', file.name), role: 'input' })),
      { fileId: 'skill', path: join(TRIAL_HOME, 'skills', 'validate-data', 'SKILL.md'), role: 'skill' },
    ], limits: { maxInputBytes: 65536, maxReportBytes: 65536 } });
  const ledger = await openBudget({ run, binding, root: join(root, 'batch'), limits: runLimits() });
  const budget = composeBudget({ ledger, group });
  const audit = [];
  const streamKinds = [];
  const finishKinds = [];
  const textParts = [];
  const handle = await ctx.get('agentLoop').create(sessionId,
    { provider: providerId, model: modelId, maxTokens: batch.limits.maxOutputTokensPerAttempt }, { cwd });
  const control = await installTrialControl({
    agent: handle, run, binding, files, budget, waitMs: batch.limits.attemptTimeoutMs,
    tables: new Map(Object.entries(tableRows)),
    defineTool: toolsMod.defineTool,
    allowedSkillNames: ['validate-data'],
    requestIdentity: () => ({ runId: binding.runId, sessionId: binding.sessionId }),
    measureRequest: isWakeCheck ? () => 1 << 30
      : request => Buffer.byteLength(JSON.stringify(request.messages ?? []), 'utf8'),
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
  if (!isLive && !isWakeCheck) {
    for (const turn of scriptedTurn(task, index)) scripts.push(turn);
  }

  let outcome = 'not-sent';
  let stopError = null;
  try {
    handle.send(llmMod.createUserMessage({ content: [{ type: 'text', text: buildPrompt(task) }] }),
      'next-turn', true);
    outcome = await withDeadline(handle.whenIdle().then(() => 'idle'), 600000, 'timeout');
  } finally {
    try { await control.stop('a4-task-finished'); } catch (error) { stopError = error?.code ?? String(error); }
    await files.close().catch(() => {});
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
    .map(({ tool, callId, ok, code, fileId, offset, limit, operation, tableId, column, filterCount, contentBytes }) =>
      ({ tool, callId, ok, code, fileId, offset, limit, operation, tableId, column, filterCount, contentBytes }));
  const skillRead = toolCalls.some(call => call.tool === 'trial_read' && call.fileId === 'skill' && call.ok === true);
  const record = {
    record_type: 'a4_baseline_task', mode, observed_at: new Date().toISOString(),
    batch_id: batch.batchId, task_id: task.taskId, category: task.category, title: task.title,
    prompt: buildPrompt(task), outcome, wall_ms: Date.now() - started,
    preflight: { status: gate.status, blockers: gate.blockers },
    attempts: {
      settled: ledgerSnapshot.attemptsSettled, unknown: ledgerSnapshot.attemptsUnknown,
      reserved: ledgerSnapshot.attemptsReserved, max_attempts: batch.limits.maxAttemptsPerTask,
      observed_input_tokens: ledgerSnapshot.observedInputTokens,
      observed_output_tokens: ledgerSnapshot.observedOutputTokens,
    },
    group: { attempts_dispatched: groupSnapshot.attemptsDispatched,
      attempts_settled: groupSnapshot.attemptsSettled, attempts_unknown: groupSnapshot.attemptsUnknown,
      observed_token_total: groupSnapshot.observedTokenTotal },
    tool_calls: toolCalls, skill_read: skillRead,
    report, final_text: textParts.join(''),
    stream_kinds: streamKinds, finish_kinds: finishKinds,
    denials: audit.filter(entry => entry.kind !== 'tool_call' && entry.kind !== 'request_reserved'
      && entry.kind !== 'request_settled'),
    stop_error: stopError,
    incomplete: !skillRead || (task.expectsReport && !report.written),
    incomplete_reason: !skillRead ? 'SKILL_NOT_READ'
      : (task.expectsReport && !report.written ? 'REPORT_NOT_WRITTEN' : null),
    claim_scope: { attempts_hard_limit: true, soft_thresholds: true, cost_hard_limit: false },
  };
  await writeFile(join(recordDir, `${task.taskId}.json`), `${JSON.stringify(record, null, 2)}\n`);

  await ledger.close().catch(() => {});
  await run.close().catch(() => {});
  try { await ctx.fiber?.dispose?.(); } catch { /* best effort */ }
  if (!isLive) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await rm(root, { recursive: true, force: true }); break; } catch {
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
  }
  return record;
}

async function runBatch(t) {
  const baseRoot = isLive
    ? join(TRIAL_HOME, 'runs', `a4-live-${stamp}${suffix}`)
    : await mkdtemp(join(await realpath(tmpdir()), 'a4-baseline-'));
  await mkdir(baseRoot, { recursive: true });
  const recordDir = isLive
    ? join(EVIDENCE, `a4-live-${stamp}${suffix}`)
    : join(EVIDENCE, `a4-${mode}-${stamp}${suffix}`);
  await mkdir(recordDir, { recursive: true });
  const group = await openBatchGroup({ root: baseRoot, groupId: `${batch.batchId}${suffix}`,
    limits: { maxAttempts: batch.limits.maxAttempts, observedTokenStop: batch.limits.observedTokenStop,
      batchDeadlineMs: batch.limits.batchDeadlineMs } });
  const records = [];
  for (const [index, task] of selectedTasks.entries()) {
    if (isWakeCheck && index > 0) break;
    const root = join(baseRoot, task.taskId);
    await mkdir(root, { recursive: true });
    records.push(await runTask(t, { task, index, root, group, recordDir }));
  }
  const groupSnapshot = group.snapshot();
  const summary = {
    record_type: 'a4_baseline_batch', mode, observed_at: new Date().toISOString(),
    batch_id: batch.batchId, amendment, record_dir: recordDir, limits: batch.limits, route: batch.route,
    tasks_requested: selectedTasks.map(task => task.taskId),
    rubric_sha256: RUBRIC_SHA, environment_digest: ENVIRONMENT_DIGEST, policy_digest: POLICY_DIGEST,
    authorization_reference: AUTHORIZATION_REFERENCE,
    tasks: records.map(record => ({ task_id: record.task_id, outcome: record.outcome,
      settled: record.attempts.settled, report_written: record.report.written,
      skill_read: record.skill_read, incomplete: record.incomplete })),
    group: { attempts_dispatched: groupSnapshot.attemptsDispatched,
      attempts_settled: groupSnapshot.attemptsSettled, attempts_unknown: groupSnapshot.attemptsUnknown,
      attempts_released: groupSnapshot.attemptsReleased,
      observed_input_tokens: groupSnapshot.observedInputTokens,
      observed_output_tokens: groupSnapshot.observedOutputTokens,
      observed_token_total: groupSnapshot.observedTokenTotal,
      revision: groupSnapshot.revision },
  };
  await writeFile(join(recordDir, 'batch.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await group.close();
  if (!isLive) await rm(baseRoot, { recursive: true, force: true }).catch(() => {});
  return { records, summary, recordDir, baseRoot };
}

test('seven scripted tasks drive the controlled chain end to end (zero egress)', async (t) => {
  if (isLive || isWakeCheck) return;
  const { records, summary } = await runBatch(t);
  assert.equal(records.length, selectedTasks.length);
  for (const record of records) {
    assert.equal(record.outcome, 'idle', `${record.task_id} must reach idle`);
    assert.equal(record.skill_read, true, `${record.task_id} must read the frozen skill`);
    assert.equal(record.preflight.status, 'ready', `${record.task_id} preflight: ${record.preflight.blockers}`);
    if (manifest.tasks.find(task => task.taskId === record.task_id).expectsReport) {
      assert.equal(record.report.written, true);
    }
    assert.ok(record.attempts.settled >= 3);
  }
  assert.equal(summary.group.attempts_unknown, 0);
});

test('the real route reaches the model boundary and the wrapper refuses it (zero egress)', async (t) => {
  if (!isWakeCheck) return;
  const { records } = await runBatch(t);
  assert.equal(records.length, 1);
  const denial = records[0].denials.find(entry => entry.kind === 'request_denied');
  assert.ok(denial, `the wrapper must refuse before dispatch; denials=${JSON.stringify(records[0].denials)}`);
  assert.equal(denial.reason, 'REQUEST_TOO_LARGE');
  assert.equal(records[0].attempts.reserved, 0, 'a refused request must not reserve');
});

test('the approved baseline batch runs seven live tasks under the group budget', async (t) => {
  if (!isLive) return;
  const settingsBefore = await sha256(SETTINGS);
  const { records, summary, recordDir } = await runBatch(t);
  assert.equal(records.length, selectedTasks.length);
  const settingsAfter = await sha256(SETTINGS);
  assert.equal(settingsBefore, settingsAfter, 'settings must stay unchanged');
  const totalSettled = records.reduce((sum, record) => sum + record.attempts.settled, 0);
  assert.ok(totalSettled >= records.length, 'a live batch must settle at least one attempt per task');
  assert.equal(summary.group.attempts_unknown, 0,
    `unresolved usage must not be silently ignored; see ${recordDir}`);
});
