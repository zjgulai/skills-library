#!/usr/bin/env node
// T09 小批真实探针 runner（D19 批准：vod/gemini-3.8-flash、1 任务×1 次、保守预算）。
// 用法：
//   node skill-lifecycle/trial-home/run-probe.mjs --check      # 只校验配置与出境门，不发请求
//   node skill-lifecycle/trial-home/run-probe.mjs              # 发 1 次真实请求
// 边界：只写 trial-home/；不写 ~/.dsh（settings 前后 sha256 校验，变化即中止）；不打印/不落盘密钥。
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openRun } from '../control/run-state.mjs';
import { openFiles } from '../control/bounded-files.mjs';
import { openBudget } from '../control/budget-ledger.mjs';
import { installTrialControl } from '../control/dsh-plugin.mjs';
import { stopRun } from '../control/stop-run.mjs';
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
const TRIAL_HOME = import.meta.dirname;
const EVIDENCE = join(TRIAL_HOME, 'evidence');
const SETTINGS = join(homedir(), '.dsh', 'settings.yaml');
const checkOnly = process.argv.includes('--check');
const wakeCheck = process.argv.includes('--wake-check');
const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const require_ = createRequire(join(APP, 'package.json'));
const load = async name => await import(pathToFileURL(require_.resolve('@deepseek-ai/' + name)).href);
const fail = message => { console.error(`probe blocked: ${message}`); process.exit(3); };

const connection = JSON.parse(await readFile(join(TRIAL_HOME, 't09-connection.json'), 'utf8'));
const provider = connection.provider;
const route = connection.approvedRoute;
const fromStore = process.argv.includes('--key-from-store');
const storePath = join(homedir(), '.dsh', '.credentials.yaml');
async function readStoreValue(refName) {
  const store = await readFile(storePath, 'utf8');
  let inRefs = false;
  for (const raw of store.split('\n')) {
    if (/^refs:\s*$/.test(raw)) { inRefs = true; continue; }
    if (/^[A-Za-z0-9_.-]+:\s*$/.test(raw)) inRefs = false;
    if (!inRefs) continue;
    const match = raw.match(new RegExp(`^\\s+${refName}\\s*:\\s*(.+?)\\s*$`));
    if (match) return match[1].replace(/^['"]|['"]$/g, '');
  }
  return null;
}
const envKey = process.env[provider.apiKeyEnv];
const literalKey = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : '';
const storeKey = fromStore ? (await readStoreValue(provider.apiKeyEnv)) ?? '' : '';
const apiKey = literalKey.length >= 16 ? literalKey : (storeKey.length >= 16 ? storeKey : (envKey ?? ''));
const credentialAvailable = apiKey.length > 0;
const credentialSource = literalKey.length >= 16 ? 'connection-file'
  : storeKey.length >= 16 ? 'credentials-store(in-memory)'
    : credentialAvailable ? 'environment' : 'missing';

const manifest = JSON.parse(await readFile(join(EVIDENCE, 't09-dry-run-manifest.json'), 'utf8'));
manifest.modelSelection = { provider: route.provider, model: route.model };
manifest.authorization = { ...manifest.authorization, reference: 'D19' };
const capabilities = JSON.parse(await readFile(join(EVIDENCE, 't09-dry-run-capabilities.json'), 'utf8'));
capabilities.approvedModel = { provider: route.provider, model: route.model };
capabilities.authorizationVerified = true;
capabilities.authorization = { ...manifest.authorization };
const gate = await preflight({ manifest, capabilities });
if (gate.status !== 'ready') fail(`preflight not ready: ${gate.blockers.join(', ')}`);
console.log('preflight ready; materials', gate.preview.materials.map(m => `${m.fileId}:${m.bytes}B`).join(' '),
  '| route', route.provider + '/' + route.model, '| limits', JSON.stringify(gate.preview.limits));

const settingsBefore = await sha256(SETTINGS);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runId = `t09-run-${stamp}`;
const workRoot = join(TRIAL_HOME, 'runs', runId);
const cwd = join(workRoot, 'workspace');
await mkdir(join(cwd, 'inputs'), { recursive: true });
await mkdir(join(cwd, 'outputs'), { recursive: true });
await mkdir(join(workRoot, 'sessions'), { recursive: true });
await mkdir(join(workRoot, 'batch'), { recursive: true });
await mkdir(join(workRoot, 'run'), { recursive: true });
for (const name of ['report.md', 'metrics.csv']) {
  await writeFile(join(cwd, 'inputs', name), await readFile(join(TRIAL_HOME, 'workspace', 'inputs', name)));
}

const { Context } = await load('cordis');
const ctx = new Context();
await ctx.plugin((await load('dsh-system-prompt')).SystemPrompt);
await ctx.plugin((await load('dsh-tools')).ToolRuntime);
await ctx.plugin((await load('dsh-llm')).LlmRuntime);
await ctx.plugin((await load('dsh-agent')).AgentRegistry ?? (await load('dsh-agent')).default);
await ctx.plugin((await load('dsh-session')).default);
await ctx.plugin((await load('dsh-session-persistence-jsonl')).default, { root: join(workRoot, 'sessions') });
await ctx.plugin((await load('dsh-session-projection')).default);
await ctx.plugin((await load('dsh-agent-loop')).AgentLoop ?? (await load('dsh-agent-loop')).default, {});
const skipPiAi = process.env.T09_SKIP_PI_AI === '1';
if (!skipPiAi) {
  if (credentialAvailable) process.env[provider.apiKeyEnv] = apiKey;
  await ctx.plugin((await load('dsh-credentials-local')).default, { path: storePath, watch: false });
  const piAi = await load('dsh-llm-pi-ai');
  await ctx.plugin(piAi, { providers: { [provider.id]: {
    displayName: provider.displayName, api: provider.api, baseURL: provider.baseURL,
    apiKeyEnv: provider.apiKeyEnv, models: [{ id: route.model }],
    ...(process.env.T09_ROUTE_REASONING ? { reasoning: process.env.T09_ROUTE_REASONING } : {}),
  } } });
  console.log('providers registered:', JSON.stringify(typeof ctx.llm.listProviders === 'function' ? ctx.llm.listProviders() : null));
} else {
  console.log('pi-ai mount skipped (isolation run)');
}

// 无出境的回环自测：脚本化 adapter 必须先证明"工具结果之后会继续下一步"，
// 否则本次运行不消耗任何真实请求。
const llmMod = await load('dsh-llm');
const toolsMod = await load('dsh-tools');
const skipSelfTest = process.env.T09_SKIP_SELF_TEST === '1';
const selfTest = skipSelfTest ? { outcome: 'skipped', calls: 0, continued: true } : await (async function runSelfTest() {
  const model = Object.freeze({ provider: 'self-test', id: 'self-model', name: 'Self Test',
    context: { contextWindow: 4096 }, defaultMaxTokens: 64 });
  const scripts = [
    [{ type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'self-1', name: 'selftest_echo', argumentsDelta: '{"value":"ping"}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'self-1', name: 'selftest_echo', arguments: '{"value":"ping"}' } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } }],
    [{ type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'done' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } }],
  ];
  let calls = 0;
  class Stub extends llmMod.LlmAdapter {
    async prepareCall() { return { model, stream: () => this.run() }; }
    async *run() { calls += 1; const script = scripts.shift(); if (script === undefined) throw new Error('self-test script exhausted'); for (const chunk of script) yield chunk; }
  }
  ctx.llm.registerAdapter(['self-test'], new Stub());
  ctx.tools.register(toolsMod.defineTool({
    name: 'selftest_echo', description: 'self-test echo tool',
    parameters: { value: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { echoed: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) { return { echoed: args.value }; },
  }));
  const handle = await ctx.get('agentLoop').create(`self-${Date.now().toString(36)}`,
    { provider: 'self-test', model: 'self-model', maxTokens: 64 }, { cwd });
  handle.send(llmMod.createUserMessage({ content: [{ type: 'text', text: 'self test' }] }), 'next-turn', true);
  const outcome = await Promise.race([handle.whenIdle().then(() => 'idle'),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 20000))]);
  handle.cancel({ kind: 'user' }, { keepInbox: false });
  return { outcome, calls, continued: calls === 2 };
})();
console.log('self-test:', JSON.stringify(selfTest));
if (!selfTest.continued) fail('loop self-test did not continue after a tool call; refusing to spend a real request');

if (checkOnly) {
  console.log('check mode: outbound gate verified; credential source:', credentialSource,
    '; loop self-test passed; no request sent.');
  process.exit(0);
}
if (!credentialAvailable) {
  fail(`no credential available: fill provider.apiKey in t09-connection.json or export ${provider.apiKeyEnv}`);
}

const budgetLimits = { ...manifest.budget };
const auditEntries = [];
const binding = {
  runId, batchId: manifest.batchId, sessionId: `t09-probe-${Date.now().toString(36)}`,
  skillDigest: manifest.skillDigest, inputDigest: manifest.inputDigest,
  evaluatorDigest: manifest.evaluatorDigest, environmentDigest: manifest.environmentDigest,
  policyDigest: manifest.policyDigest,
};
const run = await openRun({ root: join(workRoot, 'run'), binding });
await run.start();
const files = await openFiles({ run, binding, inputRoot: join(cwd, 'inputs'),
  skillRoot: join(TRIAL_HOME, 'skills'), outputRoot: join(cwd, 'outputs'),
  files: [
    { fileId: 'report', path: join(cwd, 'inputs', 'report.md'), role: 'input' },
    { fileId: 'metrics', path: join(cwd, 'inputs', 'metrics.csv'), role: 'input' },
    { fileId: 'skill', path: join(TRIAL_HOME, 'skills', 'validate-data', 'SKILL.md'), role: 'skill' },
  ], limits: { maxInputBytes: 65536, maxReportBytes: 65536 } });
const budget = await openBudget({ run, binding, root: join(workRoot, 'batch'), limits: budgetLimits });
const fileManifest = files.manifest();
const providerOverride = process.env.T09_PROVIDER_OVERRIDE ?? null;
const sessionRoute = providerOverride === null
  ? { provider: route.provider, model: route.model }
  : { provider: providerOverride, model: 'self-model' };
const handle = await ctx.get('agentLoop').create(binding.sessionId,
  { provider: sessionRoute.provider, model: sessionRoute.model,
    maxTokens: budgetLimits.maxOutputTokensPerAttempt },
  { cwd });
const streamKinds = [];
const finishKinds = [];
await installTrialControl({
  agent: handle, run, binding, files, budget, waitMs: budgetLimits.attemptTimeoutMs,
  tables: new Map([['metrics', { headers: ['segment', 'value', 'weight'],
    rows: [['A', '10', '2'], ['B', '40', '1']], sha256: manifest.files.find(f => f.fileId === 'metrics').sha256 }]]),
  defineTool: (await load('dsh-tools')).defineTool,
  allowedSkillNames: ['validate-data'],
  requestIdentity: () => ({ runId: binding.runId, sessionId: binding.sessionId }),
  measureRequest: wakeCheck ? () => 1 << 30
    : request => Buffer.byteLength(JSON.stringify(request.messages ?? []), 'utf8'),
  audit: entry => { auditEntries.push(entry); },
});

ctx.on('llm/stream', (options, next) => (async function* observe() {
  for await (const chunk of await next()) {
    streamKinds.push(chunk?.type ?? '?');
    if (chunk?.type === 'finish') finishKinds.push(chunk.reason?.kind ?? '?');
    yield chunk;
  }
})());
const task = [
  'Complete the whole validation in this single turn by calling the tools in order and not stopping in between:',
  '1) trial_read fileId "report" offset 0 limit 400;',
  '2) trial_read fileId "metrics" offset 0 limit 400;',
  '3) trial_compute operation "weighted_mean" tableId "metrics" column "value" weightColumn "weight" filters [];',
  '4) trial_write_report whose content states the weighted mean you computed in step 3.',
  'Keep calling tools until the report is written. Do not stop after the reads, and never answer from memory.',
].join(' ');
const observedEvents = [];
const observedNames = (process.env.T09_OBSERVE_EVENTS ?? 'minimal') === 'wide'
  ? ['agent/request-error', 'agent/error', 'agent/status', 'agent/pre-step', 'agent/request',
    'agent/turn-stopping', 'agent/session-start', 'agent/disposed', 'session/event',
    'session/disposed', 'internal/error', 'internal/warning', 'tools/change']
  : ['agent/request-error', 'agent/error', 'internal/error', 'tools/change'];
for (const eventName of observedNames) {
  try {
    ctx.on(eventName, payload => observedEvents.push(
      `${eventName}:${JSON.stringify(payload ?? null).slice(0, 220)}`));
  } catch { /* event may not exist */ }
}
const startedAt = Date.now();
const { createUserMessage } = await load('dsh-llm');
let turnError = null;
let idle = 'not_started';
const diagnostics = { status_before: handle.status, provider_registered: ctx.llm.listProviders?.() ?? null };
const phaseProbe = () => {
  const phase = handle.phase ?? null;
  return phase === null ? 'unavailable' : `${phase.kind}:wakeRequested=${String(phase.wakeRequested)}`;
};
diagnostics.phase_before_send = phaseProbe();
try {
  handle.send(createUserMessage({ content: [{ type: 'text', text: task }] }), 'next-turn', true);
  diagnostics.phase_after_send = phaseProbe();
  await new Promise(resolve => setTimeout(resolve, 300));
  diagnostics.phase_after_300ms = phaseProbe();
  idle = await Promise.race([
    handle.whenIdle().then(() => 'idle'),
    new Promise(resolve => setTimeout(() => resolve('timeout'), budgetLimits.batchDeadlineMs)),
  ]);
} catch (error) {
  turnError = String(error?.code ?? error?.message ?? error).slice(0, 200);
}
diagnostics.status_after = handle.status;
diagnostics.session_events = (handle.session.eventsSnapshot ?? []).slice(-12).map(event => {
  const shape = event?.kind ?? event?.type ?? 'unknown';
  const digest = JSON.stringify(event ?? null);
  return digest === undefined ? String(shape) : `${String(shape)}:${digest.slice(0, 120)}`;
});
diagnostics.inbox_next_turn = (() => {
  try { return handle.inbox?.nextTurn?.length ?? null; } catch { return 'unavailable'; }
})();
diagnostics.llm_adapters = ctx.llm.listProviders?.() ?? null;
const elapsedMs = Date.now() - startedAt;
const stopReceipt = await stopRun({ run, binding, agent: handle, io: files, reason: 'probe_complete',
  waitMs: budgetLimits.attemptTimeoutMs, waitForIdle: target => target.whenIdle(), budget });
const snapshot = budget.snapshot();
const settingsAfter = await sha256(SETTINGS);
const artifacts = await readdir(join(cwd, 'outputs'));
const artifactDigests = {};
for (const name of artifacts) artifactDigests[name] = await sha256(join(cwd, 'outputs', name));
const record = {
  record_type: 't09_real_probe_run',
  run_id: runId,
  observed_at: new Date().toISOString(),
  authorization: 'D19: vod/gemini-3.8-flash, 1 task x 1, conservative limits, attempts+soft-threshold claims only',
  route: { provider: route.provider, model: route.model, base_url: provider.baseURL, api_key_env: provider.apiKeyEnv,
    credential_source: credentialSource },
  credential_persisted: false,
  outbound_preview: { materials: gate.preview.materials, tools: gate.preview.tools, limits: gate.preview.limits },
  session: { session_id: binding.sessionId, cwd, status: handle.status, idle_outcome: idle, elapsed_ms: elapsedMs },
  attempts: { reserved: snapshot.attemptsReserved, settled: snapshot.attemptsSettled, unknown: snapshot.attemptsUnknown,
    observed_input_tokens: snapshot.observedInputTokens, observed_output_tokens: snapshot.observedOutputTokens,
    observed_token_total: snapshot.observedTokenTotal },
  budget_limits: budgetLimits,
  claim_scope: { attempts_hard_limit: true, observed_usage_and_time_soft_thresholds: true, cost_hard_limit: false },
  stop: { status: stopReceipt.status, confirmed: stopReceipt.confirmed, failure: stopReceipt.failure },
  artifacts: artifactDigests,
  audit_entries: auditEntries,
  settings_sha256_before: settingsBefore,
  settings_sha256_after: settingsAfter,
  settings_unchanged: settingsBefore === settingsAfter,
  user_dsh_home_changed: settingsBefore !== settingsAfter,
  transcript_tail: null,
};
record.file_manifest = fileManifest;
record.turn_error = turnError;
record.diagnostics = diagnostics;
record.observed_events = observedEvents;
record.route_reasoning = process.env.T09_ROUTE_REASONING ?? null;
record.wake_check = wakeCheck;
record.session_route = sessionRoute;
record.stream_kinds = streamKinds;
record.finish_kinds = finishKinds;
record.self_test = selfTest;
await mkdir(EVIDENCE, { recursive: true });
await writeFile(join(EVIDENCE, `${runId}.json`), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ run_id: runId, idle, attempts: record.attempts, stop: record.stop.status,
  artifacts: Object.keys(artifactDigests), settings_unchanged: record.settings_unchanged }, null, 2));
process.exit(stopReceipt.status === 'stopped' && record.settings_unchanged ? 0 : 4);
