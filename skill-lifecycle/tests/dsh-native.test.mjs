import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { openRun } from '../control/run-state.mjs';
import { openFiles } from '../control/bounded-files.mjs';
import { openBudget } from '../control/budget-ledger.mjs';
import { installTrialControl } from '../control/dsh-plugin.mjs';
import { makeTempCase } from './fixtures.mjs';

const APP = '/Applications/DSH Desktop.app/Contents/Resources/app';
const EXPECTED_DSH_VERSION = '0.1.5-rc.2';
const MODEL = { provider: 'trial-provider', id: 'trial-model', name: 'Trial Model',
  context: { contextWindow: 8000 }, defaultMaxTokens: 32 };

function appRequire() {
  return createRequire(join(APP, 'package.json'));
}

async function loadNative(name) {
  return await import(pathToFileURL(appRequire().resolve(name)).href);
}

class Host {
  static inject = ['tools', 'llm'];
}

async function makeNativeFixture(t) {
  const f = await makeTempCase(t);
  const { Context } = await loadNative('@deepseek-ai/cordis');
  const { createScope } = await loadNative('@deepseek-ai/dsh-scope');
  const toolsMod = await loadNative('@deepseek-ai/dsh-tools');
  const llmMod = await loadNative('@deepseek-ai/dsh-llm');
  const spMod = await loadNative('@deepseek-ai/dsh-system-prompt');
  const ctx = new Context();
  await ctx.plugin(spMod.SystemPrompt);
  await ctx.plugin(toolsMod.ToolRuntime);
  await ctx.plugin(llmMod.LlmRuntime);
  const host = await ctx.plugin(Host);
  const agent = { id: f.binding.sessionId };
  const otherAgent = { id: 'other-session-001' };
  const scope = createScope(host.ctx, agent);
  const otherScope = createScope(host.ctx, otherAgent);
  agent.ctx = scope.ctx;
  otherAgent.ctx = otherScope.ctx;
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await run.start();
  const files = f.track(await openFiles({ run, binding: f.binding, inputRoot: f.inputs,
    skillRoot: f.skill, outputRoot: f.outputs, files: f.inputFiles,
    limits: { maxInputBytes: 4096, maxReportBytes: 4096 } }));
  const budget = f.track(await openBudget({ run, binding: f.binding, root: f.budget,
    limits: f.testBudget, now: () => 1000 }));
  const tables = new Map([['metrics', { headers: ['segment', 'value', 'weight'],
    rows: [['A', '10', '2'], ['B', '40', '1']], sha256: 'a'.repeat(64) }]]);
  const auditEntries = [];
  const stubCalls = [];
  const dangerous = toolsMod.defineTool({
    name: 'bash',
    description: 'Test-only dangerous stub that must never run for the trial agent.',
    parameters: { command: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      ran: { type: 'boolean' } } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) { stubCalls.push(args.command); return { ran: true }; },
  });
  ctx.tools.register(dangerous);
  const control = await installTrialControl({ agent, run, binding: f.binding, files, tables, budget,
    waitMs: 100, defineTool: toolsMod.defineTool,
    requestIdentity: () => ({ runId: f.binding.runId, sessionId: f.binding.sessionId }),
    measureRequest: options => Buffer.byteLength(JSON.stringify(options.messages ?? []), 'utf8'),
    audit: entry => { auditEntries.push(entry); } });
  t.after(() => { control.dispose(); scope.dispose(); otherScope.dispose(); });
  return {
    ...f, ctx, toolsMod, llmMod, agent, otherAgent, run, files, budget, tables,
    control, auditEntries, stubCalls,
    execute(name, args, target = agent) {
      return ctx.tools.execute({ callId: `call-${name}-${Math.random().toString(16).slice(2)}`,
        name, arguments: args, agent: target, signal: new AbortController().signal });
    },
  };
}

test('the installed native runtimes match the pinned version', async () => {
  const appVersion = appRequire()(join(APP, 'package.json')).version;
  for (const name of ['dsh-tools', 'dsh-llm', 'dsh-agent', 'dsh-scope']) {
    const version = appRequire()(`@deepseek-ai/${name}/package.json`).version;
    assert.equal(version, EXPECTED_DSH_VERSION, `${name} version changed; T06 must re-verify the seams`);
  }
  assert.equal(typeof appVersion, 'string');
  const toolsMod = await loadNative('@deepseek-ai/dsh-tools');
  const llmMod = await loadNative('@deepseek-ai/dsh-llm');
  assert.equal(typeof toolsMod.ToolRuntime, 'function');
  assert.equal(typeof toolsMod.defineTool, 'function');
  assert.equal(typeof llmMod.LlmRuntime, 'function');
  assert.equal(typeof llmMod.LlmAdapter, 'function');
});

test('whitelisted calls run the real bounded reader, compute and writer', async (t) => {
  const f = await makeNativeFixture(t);
  const read = await f.execute('trial_read', { fileId: 'report', offset: 0, limit: 100 });
  assert.equal(read.isError, false);
  assert.match(read.value.content, /公开分析样例/);
  const computed = await f.execute('trial_compute', { operation: 'weighted_mean',
    tableId: 'metrics', column: 'value', weightColumn: 'weight', filters: [] });
  assert.equal(computed.isError, false);
  assert.equal(computed.value.value, 20);
  const written = await f.execute('trial_write_report', { content: 'summary: native\n' });
  assert.equal(written.isError, false);
  assert.equal(written.value.bytes, Buffer.byteLength('summary: native\n'));
  assert.equal(f.auditEntries.filter(entry => entry.kind === 'tool_call').length, 3);
});

test('a dangerous global tool is denied for the trial agent and runs for others', async (t) => {
  const f = await makeNativeFixture(t);
  const denied = await f.execute('bash', { command: 'echo unsafe' });
  assert.equal(denied.isError, true);
  assert.match(denied.error.message, /TOOL_NOT_ALLOWED/);
  assert.deepEqual(f.stubCalls, []);
  const allowed = await f.execute('bash', { command: 'echo other' }, f.otherAgent);
  assert.equal(allowed.isError, false);
  assert.deepEqual(f.stubCalls, ['echo other']);
});

test('an approving pre-execute cannot override the guard', async (t) => {
  const f = await makeNativeFixture(t);
  const off = f.ctx.on('tools/pre-execute', () => ({ kind: 'allow' }));
  t.after(() => off());
  const result = await f.execute('bash', { command: 'echo bypass' });
  assert.equal(result.isError, true);
  assert.match(result.error.message, /TOOL_NOT_ALLOWED/);
  assert.deepEqual(f.stubCalls, []);
});

test('unknown tools are denied by the whitelist before they can resolve', async (t) => {
  const f = await makeNativeFixture(t);
  const result = await f.execute('nope', {});
  assert.equal(result.isError, true);
  assert.match(result.error.message, /TOOL_NOT_ALLOWED/);
  assert.deepEqual(f.stubCalls, []);
});

test('the guard refuses every tool once the run stops', async (t) => {
  const f = await makeNativeFixture(t);
  await f.run.markStopping('cancelled');
  const result = await f.execute('trial_read', { fileId: 'report', offset: 0, limit: 10 });
  assert.equal(result.isError, true);
  assert.match(result.error.message, /RUN_NOT_RUNNING/);
});

test('the controlled wrapper wraps the plain stream and settles usage', async (t) => {
  const f = await makeNativeFixture(t);
  class MemoryAdapter extends f.llmMod.LlmAdapter {
    calls = 0;
    async prepareCall() {
      return { model: MODEL, stream: () => this.run() };
    }
    async *run() {
      this.calls += 1;
      yield { type: 'text', text: 'answer' };
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 7 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const adapter = new MemoryAdapter();
  f.ctx.llm.registerAdapter(['trial-provider'], adapter);
  const { createUserMessage } = f.llmMod;
  const options = { provider: 'trial-provider', model: 'trial-model', maxTokens: 20,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }] })],
    signal: new AbortController().signal };
  const types = [];
  for await (const chunk of await f.agent.ctx.llm.stream(options)) types.push(chunk.type);
  assert.deepEqual(types, ['text', 'usage', 'finish']);
  assert.equal(adapter.calls, 1);
  const snapshot = f.budget.snapshot();
  assert.equal(snapshot.attemptsReserved, 1);
  assert.equal(snapshot.attemptsSettled, 1);
  assert.equal(snapshot.observedTokenTotal, 12);
});

test('the prepared call path is also intercepted', async (t) => {
  const f = await makeNativeFixture(t);
  class PreparedAdapter extends f.llmMod.LlmAdapter {
    calls = 0;
    async prepareCall() {
      return { model: { ...MODEL, defaultMaxTokens: 16 }, stream: () => this.run() };
    }
    async *run() {
      this.calls += 1;
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const adapter = new PreparedAdapter();
  f.ctx.llm.registerAdapter(['trial-provider'], adapter);
  const { createUserMessage } = f.llmMod;
  const options = { provider: 'trial-provider', model: 'trial-model',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }] })],
    signal: new AbortController().signal };
  const prepared = await f.agent.ctx.llm.prepareCall(options);
  const types = [];
  for await (const chunk of await prepared.stream(prepared.config)) types.push(chunk.type);
  assert.deepEqual(types, ['usage', 'finish']);
  assert.equal(adapter.calls, 1);
  const snapshot = f.budget.snapshot();
  assert.equal(snapshot.attemptsSettled, 1);
  assert.equal(snapshot.observedTokenTotal, 5);
});

test('a resolved call above the output cap is refused before dispatch', async (t) => {
  const f = await makeNativeFixture(t);
  class BigAdapter extends f.llmMod.LlmAdapter {
    calls = 0;
    async prepareCall() {
      return { model: MODEL, stream: () => this.run() };
    }
    async *run() {
      this.calls += 1;
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const adapter = new BigAdapter();
  f.ctx.llm.registerAdapter(['trial-provider'], adapter);
  const { createUserMessage } = f.llmMod;
  const options = { provider: 'trial-provider', model: 'trial-model',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }] })],
    signal: new AbortController().signal };
  const prepared = await f.agent.ctx.llm.prepareCall(options);
  await assert.rejects(async () => {
    for await (const _chunk of await prepared.stream(prepared.config)) { /* should not run */ }
  }, /OUTPUT_TOO_LARGE/);
  assert.equal(adapter.calls, 0);
  assert.equal(f.budget.snapshot().attemptsReserved, 0);
});

test('each retry reserves a new attempt and exhaustion stops dispatch', async (t) => {
  const f = await makeNativeFixture(t);
  class RetryAdapter extends f.llmMod.LlmAdapter {
    calls = 0;
    async prepareCall() {
      return { model: MODEL, stream: () => this.run() };
    }
    async *run() {
      this.calls += 1;
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const adapter = new RetryAdapter();
  f.ctx.llm.registerAdapter(['trial-provider'], adapter);
  const { createUserMessage } = f.llmMod;
  const options = { provider: 'trial-provider', model: 'trial-model', maxTokens: 20,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }] })],
    signal: new AbortController().signal };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for await (const _chunk of await f.agent.ctx.llm.stream(options)) { /* drained */ }
  }
  assert.equal(adapter.calls, 2);
  assert.equal(f.budget.snapshot().attemptsReserved, 2);
  let failure;
  try {
    for await (const _chunk of await f.agent.ctx.llm.stream(options)) { /* should not run */ }
  } catch (error) { failure = error; }
  assert.match(String(failure), /ATTEMPTS_EXHAUSTED/);
  assert.equal(adapter.calls, 2);
  assert.equal(f.budget.snapshot().attemptsReserved, 2);
});

test('the offline adapter touches no network and the wrapper never fabricates chunks', async (t) => {
  const f = await makeNativeFixture(t);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (...args) => { fetchCalls += 1; return originalFetch(...args); };
  t.after(() => { globalThis.fetch = originalFetch; });
  class QuietAdapter extends f.llmMod.LlmAdapter {
    async prepareCall() {
      return { model: MODEL, stream: () => (async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } };
      })() };
    }
  }
  f.ctx.llm.registerAdapter(['trial-provider'], new QuietAdapter());
  const { createUserMessage } = f.llmMod;
  const options = { provider: 'trial-provider', model: 'trial-model', maxTokens: 20,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }] })],
    signal: new AbortController().signal };
  const types = [];
  for await (const chunk of await f.agent.ctx.llm.stream(options)) types.push(chunk.type);
  assert.deepEqual(types, ['finish']);
  assert.equal(fetchCalls, 0);
  const snapshot = f.budget.snapshot();
  assert.equal(snapshot.attemptsUnknown, 1);
  assert.equal(snapshot.observedTokenTotal, 0);
});

test('dispose removes the scope registrations from the real runtime', async (t) => {
  const f = await makeNativeFixture(t);
  assert.equal(f.ctx.tools.get('trial_read', f.agent)?.name, 'trial_read');
  f.control.dispose();
  assert.equal(f.ctx.tools.get('trial_read', f.agent), undefined);
  const result = await f.execute('bash', { command: 'echo after-dispose' });
  assert.equal(result.isError, false);
  assert.deepEqual(f.stubCalls, ['echo after-dispose']);
});
