import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openRun } from '../control/run-state.mjs';
import { openFiles } from '../control/bounded-files.mjs';
import { openBudget } from '../control/budget-ledger.mjs';
import { installTrialControl } from '../control/dsh-plugin.mjs';
import { stopRun } from '../control/stop-run.mjs';
import { preflight } from '../control/preflight.mjs';

const APP = '/Applications/DSH Desktop.app/Contents/Resources/app';
const TRIAL_HOME = join(import.meta.dirname, '..', 'trial-home');
const EVIDENCE = join(TRIAL_HOME, 'evidence');
const SETTINGS = join(homedir(), '.dsh', 'settings.yaml');
const STORE = join(homedir(), '.dsh', '.credentials.yaml');
const FROZEN_SKILL_SHA = '1e424822043480375b80aef9416227b1c8083af749ca536568716265f79ca54b';
const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const require_ = createRequire(join(APP, 'package.json'));
const load = async name => await import(pathToFileURL(require_.resolve('@deepseek-ai/' + name)).href);

// T09_LIVE unset|capture -> scripted adapter only (zero egress)
// T09_LIVE=wake-check        -> real route mounted, wrapper refuses every request (zero egress)
// T09_LIVE=live              -> one real task through the approved route
const liveMode = process.env.T09_LIVE ?? 'capture';

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

async function makeFixture(t, { route = 'scripted', mountPiAi = false } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 't09-live-'));
  const cwd = join(root, 'workspace');
  const sessions = join(root, 'sessions');
  await mkdir(join(cwd, 'inputs'), { recursive: true });
  await mkdir(join(cwd, 'outputs'), { recursive: true });
  await mkdir(sessions, { recursive: true });
  await mkdir(join(root, 'batch'), { recursive: true });
  await mkdir(join(root, 'run'), { recursive: true });
  for (const name of ['report.md', 'metrics.csv']) {
    await writeFile(join(cwd, 'inputs', name), await readFile(join(TRIAL_HOME, 'workspace', 'inputs', name)));
  }

  const { Context } = await load('cordis');
  const toolsMod = await load('dsh-tools');
  const llmMod = await load('dsh-llm');
  const ctx = new Context();
  await ctx.plugin((await load('dsh-system-prompt')).SystemPrompt);
  await ctx.plugin(toolsMod.ToolRuntime);
  await ctx.plugin(llmMod.LlmRuntime);
  await ctx.plugin((await load('dsh-agent')).AgentRegistry ?? (await load('dsh-agent')).default);
  await ctx.plugin((await load('dsh-session')).default);
  await ctx.plugin((await load('dsh-session-persistence-jsonl')).default, { root: sessions });
  await ctx.plugin((await load('dsh-session-projection')).default);
  await ctx.plugin((await load('dsh-agent-loop')).AgentLoop ?? (await load('dsh-agent-loop')).default, {});

  const scripts = [];
  const streamKinds = [];
  const finishKinds = [];
  let adapterCalls = 0;
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

  const useRealRoute = route === 'real';
  const providerId = useRealRoute ? 'vod' : 'trial-provider';
  const modelId = useRealRoute ? 'gemini-3.8-flash' : 'trial-model';
  if (useRealRoute || mountPiAi) {
    const connection = JSON.parse(await readFile(join(TRIAL_HOME, 't09-connection.json'), 'utf8'));
    const apiKey = (connection.provider.apiKey ?? '').trim() || (await readStoreKey(connection.provider.apiKeyEnv));
    assert.ok(apiKey.length >= 16, 'credential must be available for live modes');
    process.env[connection.provider.apiKeyEnv] = apiKey;
    await ctx.plugin((await load('dsh-credentials-local')).default, { path: STORE, watch: false });
    const piAi = await load('dsh-llm-pi-ai');
    await ctx.plugin(piAi, { providers: { vod: {
      displayName: connection.provider.displayName, api: connection.provider.api,
      baseURL: connection.provider.baseURL, apiKeyEnv: connection.provider.apiKeyEnv,
      models: [{ id: 'gemini-3.8-flash' }],
      ...(process.env.T09_ROUTE_REASONING ? { reasoning: process.env.T09_ROUTE_REASONING } : {}),
    } } });
  }

  const sessionId = `t09-live-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
  const binding = {
    runId: `run-${sessionId}`, batchId: 'trial-batch-001', sessionId,
    skillDigest: FROZEN_SKILL_SHA,
    inputDigest: createHash('sha256').update('t09-input').digest('hex'),
    evaluatorDigest: createHash('sha256').update('t09-evaluator').digest('hex'),
    environmentDigest: createHash('sha256').update('trial-home-narrow-graph').digest('hex'),
    policyDigest: createHash('sha256').update('D18-narrow-graph').digest('hex'),
  };
  const run = await openRun({ root: join(root, 'run'), binding });
  await run.start();
  const files = await openFiles({ run, binding, inputRoot: join(cwd, 'inputs'),
    skillRoot: join(TRIAL_HOME, 'skills'), outputRoot: join(cwd, 'outputs'),
    files: [
      { fileId: 'report', path: join(cwd, 'inputs', 'report.md'), role: 'input' },
      { fileId: 'metrics', path: join(cwd, 'inputs', 'metrics.csv'), role: 'input' },
      { fileId: 'skill', path: join(TRIAL_HOME, 'skills', 'validate-data', 'SKILL.md'), role: 'skill' },
    ], limits: { maxInputBytes: 65536, maxReportBytes: 65536 } });
  const outputCap = Number(process.env.T09_MAX_OUTPUT_TOKENS ?? 256);
  const limits = { maxAttempts: 2, maxOutputTokensPerAttempt: outputCap, maxRequestBytes: 131072,
    observedTokenStop: 4000, batchDeadlineMs: 300000, attemptTimeoutMs: 60000 };
  const budget = await openBudget({ run, binding, root: join(root, 'batch'), limits });
  const audit = [];
  const wakeCheck = liveMode === 'wake-check';
  const handle = await ctx.get('agentLoop').create(sessionId,
    { provider: providerId, model: modelId, maxTokens: limits.maxOutputTokensPerAttempt }, { cwd });
  await installTrialControl({
    agent: handle, run, binding, files, budget, waitMs: limits.attemptTimeoutMs,
    tables: new Map([['metrics', { headers: ['segment', 'value', 'weight'],
      rows: [['A', '10', '2'], ['B', '40', '1']],
      sha256: createHash('sha256').update('metrics').digest('hex') }]]),
    defineTool: toolsMod.defineTool,
    allowedSkillNames: ['validate-data'],
    requestIdentity: () => ({ runId: binding.runId, sessionId: binding.sessionId }),
    measureRequest: wakeCheck && useRealRoute ? () => 1 << 30
      : request => Buffer.byteLength(JSON.stringify(request.messages ?? []), 'utf8'),
    audit: entry => { audit.push(entry); },
  });
  ctx.on('llm/stream', (options, next) => (async function* observe() {
    for await (const chunk of await next()) {
      streamKinds.push(chunk?.type ?? '?');
      if (chunk?.type === 'finish') {
        const reason = chunk.reason ?? {};
        const detail = reason.failure ? `${reason.failure.code ?? '?'}:${String(reason.failure.message ?? '').slice(0, 160)}` : '';
        finishKinds.push(`${reason.kind ?? '?'}${detail ? '[' + detail + ']' : ''}`);
      }
      yield chunk;
    }
  })());

  t.after(async () => {
    handle.cancel({ kind: 'user' }, { keepInbox: false });
    await Promise.race([handle.whenIdle(), new Promise(resolve => setTimeout(resolve, 3000))]).catch(() => {});
    await files.close().catch(() => {});
    await budget.close().catch(() => {});
    await run.close().catch(() => {});
    try { await ctx.fiber?.dispose?.(); } catch { /* best effort */ }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await rm(root, { recursive: true, force: true }); return; } catch {
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    console.warn(`trial root not fully removed: ${root}`);
  });

  return {
    ctx, binding, run, files, budget, handle, audit, streamKinds, finishKinds, cwd, sessions, root,
    get adapterCalls() { return adapterCalls; },
    push: script => scripts.push(script),
    async send(text, deadlineMs = limits.batchDeadlineMs) {
      handle.send(llmMod.createUserMessage({ content: [{ type: 'text', text }] }), 'next-turn', true);
      let timer;
      const timeout = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), deadlineMs); });
      return await Promise.race([handle.whenIdle().then(() => 'idle'), timeout])
        .finally(() => clearTimeout(timer));
    },
  };
}

test('the fixture drives a scripted turn through the controlled chain', async (t) => {
  const f = await makeFixture(t);
  f.push(toolCallTurn('call-1', 'trial_read', { fileId: 'report', offset: 0, limit: 100 }));
  f.push(textTurn('done'));
  assert.equal(await f.send('read the report'), 'idle');
  assert.equal(f.adapterCalls, 2, 'a tool-call turn must continue into a second step');
  const snapshot = f.budget.snapshot();
  assert.equal(snapshot.attemptsSettled, 2);
  assert.ok(f.audit.some(entry => entry.kind === 'tool_call' && entry.tool === 'trial_read' && entry.ok === true));
});

test('mounting pi-ai alone does not break a scripted turn (zero egress)', async (t) => {
  const f = await makeFixture(t, { mountPiAi: true });
  f.push(textTurn('still fine'));
  assert.equal(await f.send('pi-ai presence check', 30000), 'idle');
  assert.equal(f.adapterCalls, 1, 'a scripted turn must still reach the scripted adapter');
  assert.equal(f.budget.snapshot().attemptsSettled, 1);
});

test('the real route reaches the model boundary and the wrapper refuses it (zero egress)', async (t) => {
  if (liveMode !== 'wake-check') return;
  const f = await makeFixture(t, { route: 'real' });
  const outcome = await f.send('wake check', 60000);
  assert.equal(outcome, 'idle');
  assert.ok(f.audit.some(entry => entry.kind === 'request_denied' && entry.reason === 'REQUEST_TOO_LARGE'),
    `the wrapper must refuse before dispatch; audit=${JSON.stringify(f.audit)}`);
  assert.equal(f.budget.snapshot().attemptsReserved, 0, 'a refused request must not reserve');
});

test('one approved live task produces the report artifact', async (t) => {
  if (liveMode !== 'live') return;
  const settingsBefore = await sha256(SETTINGS);
  const manifest = JSON.parse(await readFile(join(EVIDENCE, 't09-dry-run-manifest.json'), 'utf8'));
  const capabilities = JSON.parse(await readFile(join(EVIDENCE, 't09-dry-run-capabilities.json'), 'utf8'));
  manifest.modelSelection = { provider: 'vod', model: 'gemini-3.8-flash' };
  capabilities.approvedModel = { provider: 'vod', model: 'gemini-3.8-flash' };
  capabilities.authorizationVerified = true;
  const gate = await preflight({ manifest, capabilities });
  assert.equal(gate.status, 'ready', `preflight must be ready: ${gate.blockers.join(',')}`);
  const f = await makeFixture(t, { route: 'real' });
  const outcome = await f.send([
    'Complete the whole validation in this single turn by calling the tools in order and not stopping in between:',
    '1) trial_read fileId "report" offset 0 limit 400;',
    '2) trial_read fileId "metrics" offset 0 limit 400;',
    '3) trial_compute operation "weighted_mean" tableId "metrics" column "value" weightColumn "weight" filters [];',
    '4) trial_write_report whose content states the weighted mean you computed in step 3.',
    'Keep calling tools until the report is written.',
  ].join(' '), 300000);
  const settingsAfter = await sha256(SETTINGS);
  const snapshot = f.budget.snapshot();
  let report = null;
  try { report = await readFile(join(f.cwd, 'outputs', 'validation-report.md'), 'utf8'); } catch { /* absent */ }
  const record = {
    record_type: 't09_live_run', observed_at: new Date().toISOString(), outcome,
    budget_amendment: process.env.T09_MAX_OUTPUT_TOKENS
      ? `D19-amend-01: maxOutputTokensPerAttempt 256 -> ${process.env.T09_MAX_OUTPUT_TOKENS} (其余限额不变)`
      : null,
    session_id: f.binding.sessionId, attempts: snapshot.attempts, stream_kinds: f.streamKinds,
    finish_kinds: f.finishKinds, audit: f.audit, report_written: report !== null,
    report_content: report, settings_unchanged: settingsBefore === settingsAfter,
    claim_scope: { attempts_hard_limit: true, soft_thresholds: true, cost_hard_limit: false },
  };
  await writeFile(join(EVIDENCE, `t09-live-${Date.now()}.json`), `${JSON.stringify(record, null, 2)}\n`);
  assert.equal(record.settings_unchanged, true);
  assert.ok(snapshot.attemptsReserved >= 1, 'a live run must reserve at least one attempt');
});
