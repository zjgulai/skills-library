import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openRun } from '../control/run-state.mjs';
import { openFiles } from '../control/bounded-files.mjs';
import { openBudget } from '../control/budget-ledger.mjs';
import { installTrialControl } from '../control/dsh-plugin.mjs';
import { stopRun } from '../control/stop-run.mjs';

const APP = '/Applications/DSH Desktop.app/Contents/Resources/app';
const TRIAL_HOME = join(import.meta.dirname, '..', 'trial-home');
const FROZEN_SKILL_SHA = '1e424822043480375b80aef9416227b1c8083af749ca536568716265f79ca54b';
const MODEL = Object.freeze({ provider: 'trial-provider', id: 'trial-model', name: 'Trial Model',
  context: { contextWindow: 8000 }, defaultMaxTokens: 64 });
const digest = label => createHash('sha256').update(String(label)).digest('hex');

const require_ = createRequire(join(APP, 'package.json'));
const load = async name => await import(pathToFileURL(require_.resolve('@deepseek-ai/' + name)).href);

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

async function makeSessionFixture(t, options = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 't08-session-'));
  const sessionsDir = join(root, 'sessions');
  const cwd = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(join(cwd, 'inputs'), { recursive: true });
  await mkdir(join(cwd, 'outputs'), { recursive: true });
  await mkdir(join(sessionsDir), { recursive: true });
  await mkdir(join(root, 'batch'), { recursive: true });
  await mkdir(join(root, 'run'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'sentinel.txt'), 'public-test-sentinel');
  for (const name of ['report.md', 'metrics.csv']) {
    await copyFile(join(TRIAL_HOME, 'workspace', 'inputs', name), join(cwd, 'inputs', name));
  }

  const { Context } = await load('cordis');
  const sys = await load('dsh-system-prompt');
  const toolsMod = await load('dsh-tools');
  const llmMod = await load('dsh-llm');
  const agentMod = await load('dsh-agent');
  const sessionMod = await load('dsh-session');
  const persistenceMod = await load('dsh-session-persistence-jsonl');
  const projectionMod = await load('dsh-session-projection');
  const loopMod = await load('dsh-agent-loop');

  const ctx = new Context();
  await ctx.plugin(sys.SystemPrompt);
  await ctx.plugin(toolsMod.ToolRuntime);
  await ctx.plugin(llmMod.LlmRuntime);
  await ctx.plugin(agentMod.AgentRegistry ?? agentMod.default);
  await ctx.plugin(sessionMod.default);
  await ctx.plugin(persistenceMod.default, { root: sessionsDir });
  await ctx.plugin(projectionMod.default);
  await ctx.plugin(loopMod.AgentLoop ?? loopMod.default, {});

  const scripts = [];
  const requests = [];
  let adapterCalls = 0;
  class ScriptedAdapter extends llmMod.LlmAdapter {
    async prepareCall() {
      return { model: MODEL, stream: options => this.run(options) };
    }
    async *run(options) {
      adapterCalls += 1;
      requests.push(options.messages);
      const script = scripts.shift();
      if (script === undefined) throw new Error('no scripted response left');
      const chunks = typeof script === 'function' ? script() : script;
      for await (const chunk of chunks) yield chunk;
    }
  }
  ctx.llm.registerAdapter(['trial-provider'], new ScriptedAdapter());

  if (options.globalTools) {
    for (const tool of options.globalTools(ctx, toolsMod)) ctx.tools.register(tool);
  }

  const sessionId = `session-trial-${Math.random().toString(16).slice(2, 10)}`;
  const binding = {
    runId: `run-${sessionId}`,
    batchId: 'trial-batch-001',
    sessionId,
    skillDigest: FROZEN_SKILL_SHA,
    inputDigest: digest('trial-input'),
    evaluatorDigest: digest('trial-evaluator'),
    environmentDigest: digest('trial-environment'),
    policyDigest: digest('trial-policy'),
  };
  const run = await openRun({ root: join(root, 'run'), binding });
  await run.start();
  const files = await openFiles({ run, binding,
    inputRoot: join(cwd, 'inputs'), skillRoot: join(TRIAL_HOME, 'skills'), outputRoot: join(cwd, 'outputs'),
    files: [
      { fileId: 'report', path: join(cwd, 'inputs', 'report.md'), role: 'input' },
      { fileId: 'metrics', path: join(cwd, 'inputs', 'metrics.csv'), role: 'input' },
      { fileId: 'skill', path: join(TRIAL_HOME, 'skills', 'validate-data', 'SKILL.md'), role: 'skill' },
    ],
    limits: { maxInputBytes: 65536, maxReportBytes: 65536 } });
  const budget = await openBudget({ run, binding, root: join(root, 'batch'),
    limits: { maxAttempts: 4, maxOutputTokensPerAttempt: 200, maxRequestBytes: 65536,
      observedTokenStop: 10000, batchDeadlineMs: 60000, attemptTimeoutMs: 5000 } });

  const auditEntries = [];
  const controls = [];
  const handle = await ctx.get('agentLoop').create(sessionId,
    { provider: 'trial-provider', model: 'trial-model', maxTokens: 64 }, { cwd });
  const seenAgents = [handle];
  controls.push(await installTrialControl({
    agent: handle, run, binding, files, budget, waitMs: 500,
    tables: new Map([['metrics', { headers: ['segment', 'value', 'weight'],
      rows: [['A', '10', '2'], ['B', '40', '1']], sha256: digest('metrics') }]]),
    defineTool: toolsMod.defineTool,
    allowedSkillNames: ['validate-data'],
    requestIdentity: () => ({ runId: binding.runId, sessionId: binding.sessionId }),
    measureRequest: request => Buffer.byteLength(JSON.stringify(request.messages ?? []), 'utf8'),
    audit: entry => { auditEntries.push(entry); },
  }));

  t.after(async () => {
    for (const control of controls) {
      try { control.dispose(); } catch { /* already disposed by stop */ }
    }
    handle.cancel({ kind: 'user' }, { keepInbox: false });
    await Promise.race([
      handle.whenIdle(),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]).catch(() => {});
    await files.close().catch(() => {});
    await budget.close().catch(() => {});
    await run.close().catch(() => {});
    // Stop the graph before removing the tree: an open persistence writer can
    // recreate files mid-rm and leave the directory non-empty.
    try { await ctx.fiber?.dispose?.(); } catch (error) { console.warn('ctx dispose failed:', String(error)); }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true });
        return;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    console.warn(`trial root not fully removed: ${root}`);
  });

  return {
    ctx, toolsMod, llmMod, cwd, outside, sessionsDir, sessionId, binding,
    run, files, budget, handle, seenAgents, auditEntries, controls, requests,
    get adapterCalls() { return adapterCalls; },
    push: script => scripts.push(script),
    transcript: () => JSON.stringify(requests),
    send: async (text) => {
      handle.send(llmMod.createUserMessage({ content: [{ type: 'text', text }] }), 'next-turn', true);
      await Promise.race([
        handle.whenIdle(),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('turn timeout')), 10000)),
      ]);
    },
  };
}

test('the declared trial assembly matches what the session actually mounts', async (t) => {
  const yaml = await readFile(join(TRIAL_HOME, 'presets', 'trial-validate-data', 'agent.cordis.yml'), 'utf8');
  const rowIds = [...yaml.matchAll(/^- id: (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(rowIds, ['persona', 'skill-registry', 'skill-filesystem', 'tool-skill', 'trial-control']);
  const rowNames = [...yaml.matchAll(/^  name: '?([^'\n]+?)'?$/gm)].map(match => match[1]);
  assert.deepEqual(rowNames, ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-skill',
    '@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-tool-skill',
    '../../../control/dsh-plugin.mjs']);
  assert.match(yaml, /watch: false/, 'the trial scope must not start a skill-root watcher');
  assert.match(yaml, /includeDefaultRoots: false/, 'the trial scope must not scan user skill roots');
  assert.deepEqual(await readdir(join(TRIAL_HOME, 'skills')), ['validate-data']);
  const skillSha = createHash('sha256')
    .update(await readFile(join(TRIAL_HOME, 'skills', 'validate-data', 'SKILL.md'))).digest('hex');
  assert.equal(skillSha, FROZEN_SKILL_SHA);

  const f = await makeSessionFixture(t);
  assert.equal(f.seenAgents.length, 1);
  assert.equal(f.seenAgents[0], f.handle, 'the published handle must be the controlled agent');
  assert.equal(f.ctx.tools.get('trial_read', f.handle)?.name, 'trial_read');
  assert.equal(f.ctx.tools.get('bash', f.handle), undefined);
  assert.equal(f.ctx.tools.get('run_code', f.handle), undefined);
  assert.equal(f.controls.length, 1);
});

test('a fresh session inherits no history and never touches the user home', async (t) => {
  const f = await makeSessionFixture(t);
  assert.deepEqual(f.ctx.agents.list().map(entry => entry.id ?? entry), [f.sessionId]);
  assert.equal(f.ctx.agents.get(f.sessionId), f.handle, 'the registry must hold the controlled handle');
  assert.equal(f.requests.length, 0, 'creating a session must not send any request');
  const persistence = f.ctx.get('sessionPersistence');
  assert.equal(await realpath(persistence.root), await realpath(f.sessionsDir),
    'the session store must be rooted inside the trial home');
  const stored = await persistence.open(f.sessionId, 'read');
  assert.equal(stored.header.id, f.sessionId, 'the trial store must own this session');
  const userSessions = await readdir(join(homedir(), '.dsh', 'sessions'), { recursive: true })
    .then(entries => entries.map(String)).catch(() => []);
  assert.equal(userSessions.some(name => name.includes(f.sessionId)), false,
    'the session must not appear under the user DSH home');
  f.push(textTurn('first answer'));
  await f.send('only message');
  assert.deepEqual(f.requests[0].map(message => message.role), ['system', 'user']);
  assert.match(JSON.stringify(f.requests[0]), /only message/);
  assert.equal(f.requests.length, 1);
});

test('a full turn runs through the controlled wrapper and settles one attempt', async (t) => {
  const f = await makeSessionFixture(t);
  f.push(textTurn('checked the report'));
  await f.send('validate the report');
  assert.equal(f.adapterCalls, 1);
  const snapshot = f.budget.snapshot();
  assert.equal(snapshot.attemptsReserved, 1);
  assert.equal(snapshot.attemptsSettled, 1);
  assert.equal(snapshot.observedTokenTotal, 7);
  assert.equal(f.handle.status, 'idle');
});

test('a model-driven tool call reads only approved inputs', async (t) => {
  const f = await makeSessionFixture(t);
  f.push(toolCallTurn('call-1', 'trial_read', { fileId: 'report', offset: 0, limit: 200 }));
  f.push(textTurn('read ok'));
  await f.send('read the report');
  assert.equal(f.adapterCalls, 2);
  const settled = f.budget.snapshot();
  assert.equal(settled.attemptsSettled, 2);
  const second = JSON.stringify(f.requests[1]);
  assert.match(second, /公开分析样例/);
  assert.match(second, /trial_read/);
  assert.ok(f.auditEntries.some(entry => entry.kind === 'tool_call' && entry.tool === 'trial_read'));
});

test('a model-driven tool call cannot escape the issued file ids', async (t) => {
  const f = await makeSessionFixture(t);
  f.push(toolCallTurn('call-2', 'trial_read', { fileId: '../outside/sentinel.txt', offset: 0, limit: 50 }));
  f.push(textTurn('blocked'));
  await f.send('read outside');
  const transcript = f.transcript();
  assert.match(transcript, /FILE_NOT_ALLOWED/);
  assert.equal(transcript.includes('public-test-sentinel'), false);
  assert.equal(await readFile(join(f.outside, 'sentinel.txt'), 'utf8'), 'public-test-sentinel');
});

test('a non-whitelisted tool is denied inside the session even with an approving pre-execute', async (t) => {
  const calls = [];
  const f = await makeSessionFixture(t, {
    globalTools: (ctx, toolsMod) => [toolsMod.defineTool({
      name: 'bash',
      description: 'must never run for the trial session',
      parameters: { command: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { ran: { type: 'boolean' } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args) { calls.push(args.command); return { ran: true }; },
    })],
  });
  const preExecuteCalls = [];
  const off = f.ctx.on('tools/pre-execute', () => { preExecuteCalls.push('allow'); return { kind: 'allow' }; });
  t.after(() => off());
  f.push(toolCallTurn('call-3', 'bash', { command: 'echo unsafe' }));
  f.push(textTurn('denied'));
  await f.send('run bash');
  assert.deepEqual(calls, []);
  assert.ok(preExecuteCalls.length > 0, 'the approving pre-execute must have run and still not won');
  assert.match(f.transcript(), /TOOL_NOT_ALLOWED/);
});

test('a model-driven tool call writes the fixed report artifact', async (t) => {
  const f = await makeSessionFixture(t);
  f.push(toolCallTurn('call-5', 'trial_write_report', { content: 'summary: validated\n' }));
  f.push(textTurn('report written'));
  await f.send('write the report');
  const written = await readFile(join(f.cwd, 'outputs', 'validation-report.md'), 'utf8');
  assert.equal(written, 'summary: validated\n');
  assert.ok(f.auditEntries.some(entry => entry.kind === 'tool_call'
    && entry.tool === 'trial_write_report' && entry.ok === true));
});

test('the skill capability is enforced through the real dispatch path', async (t) => {
  const f = await makeSessionFixture(t);
  const denied = await f.ctx.tools.execute({ callId: 'skill-1', name: 'skill',
    arguments: { name: 'other-skill' }, agent: f.handle, signal: new AbortController().signal });
  assert.equal(denied.isError, true);
  assert.match(denied.error.message, /SKILL_NOT_ALLOWED/);
  const allowed = f.ctx.tools.guardReason({ name: 'skill', agent: f.handle,
    arguments: { name: 'validate-data' } });
  assert.equal(allowed, undefined,
    'the frozen name is admitted by the guard (the skill-file plugins are not mounted in this narrow graph)');
});

test('stopping one session leaves another session untouched', async (t) => {
  const calls = [];
  const f = await makeSessionFixture(t, {
    globalTools: (ctx, toolsMod) => [toolsMod.defineTool({
      name: 'bash',
      description: 'global stub used to observe other sessions',
      parameters: { command: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { ran: { type: 'boolean' } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args) { calls.push(args.command); return { ran: true }; },
    })],
  });
  const other = await f.ctx.get('agentLoop').create('session-other-001',
    { provider: 'trial-provider', model: 'trial-model', maxTokens: 64 }, { cwd: f.cwd });
  t.after(() => {
    try { other.cancel({ kind: 'user' }, { keepInbox: false }); } catch { /* never woken */ }
  });
  f.push(textTurn('first'));
  await f.send('hello');
  // A queued prompt must never become a request once admission closes.
  f.handle.send(f.llmMod.createUserMessage({ content: [{ type: 'text', text: 'queued' }] }), 'next-turn', false);
  const receipt = await stopRun({ run: f.run, binding: f.binding, agent: f.handle, io: f.files,
    reason: 'cancelled', waitMs: 500, waitForIdle: target => target.whenIdle(), budget: f.budget });
  assert.equal(receipt.status, 'stopped');
  const denied = await f.ctx.tools.execute({ callId: 'after-stop', name: 'trial_read',
    arguments: { fileId: 'report', offset: 0, limit: 10 }, agent: f.handle,
    signal: new AbortController().signal });
  assert.equal(denied.isError, true);
  assert.match(denied.error.message, /RUN_NOT_RUNNING|TOOL_NOT_ALLOWED/);
  const elsewhere = await f.ctx.tools.execute({ callId: 'other-1', name: 'bash',
    arguments: { command: 'echo other' }, agent: other, signal: new AbortController().signal });
  assert.equal(elsewhere.isError, false);
  assert.deepEqual(calls, ['echo other']);
  f.push(textTurn('should not run'));
  await f.send('after stop');
  assert.equal(f.adapterCalls, 1);
});

test('an unresolved attempt blocks the next model request inside the session', async (t) => {
  const f = await makeSessionFixture(t);
  f.push(() => (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'partial' };
    throw new Error('stream broke mid-flight');
  })());
  f.push(textTurn('never reached'));
  await f.send('first');
  const snapshot = f.budget.snapshot();
  assert.equal(snapshot.attemptsUnknown, 1);
  assert.equal(snapshot.attemptsSettled, 0);
  await f.send('second');
  assert.equal(f.adapterCalls, 1, 'the refused retry must not reach the adapter');
  assert.equal(f.budget.snapshot().attemptsUnknown, 1);
});

test('a model-driven compute call returns the audited value without touching the network', async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (...args) => { fetchCalls += 1; return originalFetch(...args); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const f = await makeSessionFixture(t);
  f.push(toolCallTurn('call-4', 'trial_compute',
    { operation: 'weighted_mean', tableId: 'metrics', column: 'value', weightColumn: 'weight', filters: [] }));
  f.push(textTurn('computed'));
  await f.send('compute');
  assert.equal(fetchCalls, 0);
  assert.equal(f.adapterCalls, 2);
  assert.match(f.transcript(), /ieee754-binary64/,
    'the audited receipt must travel back through the model request');
  const granted = await f.ctx.tools.execute({ callId: 'call-4b', name: 'trial_compute',
    arguments: { operation: 'weighted_mean', tableId: 'metrics', column: 'value',
      weightColumn: 'weight', filters: [] }, agent: f.handle, signal: new AbortController().signal });
  assert.equal(granted.isError, false);
  assert.equal(granted.value.value, 20);
  assert.equal(granted.value.matchedRows, 2);
  assert.ok(f.auditEntries.some(entry => entry.kind === 'tool_call'
    && entry.tool === 'trial_compute' && entry.ok === true));
});
