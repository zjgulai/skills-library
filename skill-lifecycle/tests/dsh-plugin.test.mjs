import test from 'node:test';
import assert from 'node:assert/strict';
import { installTrialControl } from '../control/dsh-plugin.mjs';
import { makePluginFixture } from './fixtures.mjs';

function toolOn(f, name) {
  const definition = f.registeredTools.find(candidate => candidate.name === name);
  assert.ok(definition, `tool ${name} is registered`);
  return definition;
}

test('unknown capability and stopped run are denied', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  assert.match(f.denyReasons('bash')[0], /TOOL_NOT_ALLOWED/);
  assert.equal(f.denyReasons('trial_read').length, 0);
  await f.run.markStopping('cancelled');
  assert.match(f.denyReasons('trial_read')[0], /RUN_NOT_RUNNING/);
  assert.equal(f.denyReasons('bash', 'other-session').length, 0);
});

test('the scope registers exactly the trial tools and admits one native name', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  assert.deepEqual(f.registeredTools.map(tool => tool.name).sort(),
    ['trial_compute', 'trial_read', 'trial_write_report']);
  assert.deepEqual(control.admittedTools(), ['skill', 'trial_read', 'trial_compute', 'trial_write_report']);
  assert.ok(Object.isFrozen(control.admittedTools()));
});

test('dangerous or unknown capability names are denied as a class', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  for (const name of ['bash', 'run_code', 'browser', 'mcp__files__read', 'Skill',
    'trial_read ', 'subagent', 'download', 'read_file', 'tool_read']) {
    const reasons = f.denyReasons(name);
    assert.equal(reasons.length, 1, `${name} must be denied`);
    assert.match(reasons[0], /TOOL_NOT_ALLOWED/);
  }
});

test('the native skill name stays admitted until the run stops', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  assert.equal(f.denyReasons('skill', f.binding.sessionId, { name: 'validate-data' }).length, 0);
  assert.match(f.denyReasons('skill', f.binding.sessionId, { name: 'other-skill' })[0], /SKILL_NOT_ALLOWED/);
  assert.match(f.denyReasons('skill', f.binding.sessionId, {})[0], /SKILL_NOT_ALLOWED/);
  await f.run.markStopping('cancelled');
  assert.match(f.denyReasons('skill', f.binding.sessionId, { name: 'validate-data' })[0], /RUN_NOT_RUNNING/);
});

test('without a frozen skill list the skill capability is not admitted', async (t) => {
  const f = await makePluginFixture(t);
  const { allowedSkillNames, ...withoutSkills } = f.installOptions;
  const control = await installTrialControl(withoutSkills);
  t.after(() => control.dispose());
  assert.equal(control.admittedTools().includes('skill'), false);
  assert.match(f.denyReasons('skill', f.binding.sessionId, { name: 'validate-data' })[0], /TOOL_NOT_ALLOWED/);
});

test('trial_read serves approved inputs through the bounded reader', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  const result = await toolOn(f, 'trial_read').execute({ fileId: 'report', offset: 0, limit: 100 }, { callId: 'c1' });
  assert.match(result.content, /公开分析样例/);
  assert.equal(typeof result.sha256, 'string');
  const audited = f.auditEntries.filter(entry => entry.kind === 'tool_call');
  assert.equal(audited.length, 1);
  assert.equal(audited[0].tool, 'trial_read');
  assert.equal(audited[0].callId, 'c1');
});

test('trial_read cannot escape the issued file ids', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  await assert.rejects(toolOn(f, 'trial_read')
    .execute({ fileId: '../outside/sentinel.txt', offset: 0, limit: 100 }, { callId: 'c2' }),
  /FILE_NOT_ALLOWED/);
  await assert.rejects(toolOn(f, 'trial_read')
    .execute({ fileId: 'other-run-report', offset: 0, limit: 100 }, { callId: 'c3' }),
  /FILE_NOT_ALLOWED/);
});

test('trial tools refuse to run once the run is stopping', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  await f.run.markStopping('cancelled');
  await assert.rejects(toolOn(f, 'trial_read').execute({ fileId: 'report', offset: 0, limit: 10 }, { callId: 'c4' }),
    /RUN_NOT_RUNNING|IO_CLOSED/);
  await assert.rejects(toolOn(f, 'trial_write_report').execute({ content: 'late\n' }, { callId: 'c5' }),
    /RUN_NOT_RUNNING|IO_CLOSED/);
});

test('trial_compute computes over host tables only', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  const result = await toolOn(f, 'trial_compute').execute({ operation: 'weighted_mean',
    tableId: 'metrics', column: 'value', weightColumn: 'weight', filters: [] }, { callId: 'c6' });
  assert.equal(result.value, 20);
  assert.equal(result.matchedRows, 2);
  await assert.rejects(toolOn(f, 'trial_compute').execute({ operation: 'sum',
    tableId: 'other', column: 'value', filters: [] }, { callId: 'c7' }), /TABLE_NOT_ALLOWED/);
});

test('trial_compute rejects code, paths and unsupported operations', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  const compute = toolOn(f, 'trial_compute');
  await assert.rejects(compute.execute({ operation: 'eval', code: 'process.env' }, { callId: 'c8' }),
    /OPERATION_NOT_ALLOWED|INVALID_REQUEST/);
  await assert.rejects(compute.execute({ operation: 'sum', tableId: 'metrics', column: 'value',
    filters: [], path: '/etc/passwd' }, { callId: 'c9' }), /INVALID_REQUEST/);
  await assert.rejects(compute.execute({ operation: 'sum', tableId: 'metrics', column: 'value',
    filters: [], url: 'https://example.test' }, { callId: 'c10' }), /INVALID_REQUEST/);
});

test('trial_write_report publishes the fixed artifact and refuses a caller path', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  const written = await toolOn(f, 'trial_write_report').execute({ content: 'summary: ok\n' }, { callId: 'c11' });
  assert.equal(typeof written.sha256, 'string');
  assert.equal(written.bytes, Buffer.byteLength('summary: ok\n'));
  await assert.rejects(toolOn(f, 'trial_write_report')
    .execute({ content: 'x\n', path: '../../outside/sentinel.txt' }, { callId: 'c12' }), /INVALID_REPORT/);
});

test('audit entries stay metadata only', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  await toolOn(f, 'trial_read').execute({ fileId: 'report', offset: 0, limit: 100 }, { callId: 'c13' });
  await toolOn(f, 'trial_write_report').execute({ content: 'summary: ok\n' }, { callId: 'c14' });
  assert.ok(f.auditEntries.length >= 2);
  for (const entry of f.auditEntries) {
    const text = JSON.stringify(entry);
    assert.equal(text.includes('公开分析样例'), false);
    assert.equal(text.includes('summary: ok'), false);
  }
});

test('tool_call audit entries carry a bounded identity view', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  await toolOn(f, 'trial_read').execute({ fileId: 'report', offset: 0, limit: 100 }, { callId: 'c21' });
  await toolOn(f, 'trial_compute').execute({ operation: 'sum', tableId: 'metrics', column: 'value',
    filters: [{ column: 'segment', op: 'eq', value: 'A' }] }, { callId: 'c22' });
  await toolOn(f, 'trial_write_report').execute({ content: 'summary: ok\n' }, { callId: 'c23' });
  const entries = f.auditEntries.filter(entry => entry.kind === 'tool_call');
  const read = entries.find(entry => entry.tool === 'trial_read');
  assert.deepEqual({ fileId: read.fileId, offset: read.offset, limit: read.limit },
    { fileId: 'report', offset: 0, limit: 100 });
  const compute = entries.find(entry => entry.tool === 'trial_compute');
  assert.deepEqual({ operation: compute.operation, tableId: compute.tableId,
    column: compute.column, filterCount: compute.filterCount },
  { operation: 'sum', tableId: 'metrics', column: 'value', filterCount: 1 });
  const written = entries.find(entry => entry.tool === 'trial_write_report');
  assert.equal(written.contentBytes, Buffer.byteLength('summary: ok\n'));
  assert.equal(Object.hasOwn(written, 'content'), false);
  for (const entry of entries) {
    assert.equal(JSON.stringify(entry).includes('summary: ok'), false);
  }
});

test('an admitted native skill load is recorded without owning the loader', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  const admitted = f.registeredGuards.map(guard => guard(f.execCall('skill', f.binding.sessionId,
    { name: 'validate-data' }))).filter(reason => reason !== undefined);
  assert.deepEqual(admitted, [], 'the allowlisted skill name must pass the guard');
  const denied = f.registeredGuards.map(guard => guard(f.execCall('skill', f.binding.sessionId,
    { name: 'other-skill' }))).filter(reason => reason !== undefined);
  assert.match(denied[0], /SKILL_NOT_ALLOWED/);
  const admittedEntries = f.auditEntries.filter(entry => entry.kind === 'tool_admitted');
  assert.deepEqual(admittedEntries.map(entry => entry.skillName), ['validate-data']);
  assert.equal(f.auditEntries.filter(entry => entry.kind === 'tool_denied')
    .some(entry => entry.reason === 'SKILL_NOT_ALLOWED'), true);
});

const requestOptions = { maxTokens: 20,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };

function chunkStream(chunks) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

async function drain(listener, options, next) {
  const seen = [];
  for await (const chunk of await listener(options, next)) seen.push(chunk);
  return seen;
}

test('a controlled stream reserves before the adapter and settles afterwards', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  const chunks = [{ type: 'text', text: 'hello' },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 7 } },
    { type: 'finish', reason: { kind: 'stop' } }];
  let adapterCalls = 0;
  const next = () => { adapterCalls += 1; return chunkStream(chunks); };
  const seen = await drain(f.streamListeners[0], requestOptions, next);
  assert.deepEqual(seen, chunks);
  assert.equal(adapterCalls, 1);
  const snapshot = f.budget.snapshot();
  assert.equal(snapshot.attemptsSettled, 1);
  assert.equal(snapshot.observedTokenTotal, 12);
  const reserved = f.auditEntries.filter(entry => entry.kind === 'request_reserved');
  assert.equal(reserved.length, 1);
});

test('over-limit requests never reach the adapter', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  let adapterCalls = 0;
  const next = () => { adapterCalls += 1; return chunkStream([{ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } }]); };
  await drain(f.streamListeners[0], requestOptions, next);
  await drain(f.streamListeners[0], requestOptions, next);
  await assert.rejects(drain(f.streamListeners[0], requestOptions, next), /ATTEMPTS_EXHAUSTED/);
  assert.equal(adapterCalls, 2);
});

test('a request that does not belong to this run is refused before dispatch', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl({ ...f.installOptions,
    requestIdentity: () => ({ runId: 'other-run', sessionId: f.binding.sessionId }) });
  t.after(() => control.dispose());
  let adapterCalls = 0;
  const next = () => { adapterCalls += 1; return chunkStream([]); };
  await assert.rejects(drain(f.streamListeners[0], requestOptions, next), /REQUEST_NOT_OWNED/);
  assert.equal(adapterCalls, 0);
  assert.equal(f.budget.snapshot().attemptsReserved, 0);
});

test('an abandoned stream leaves the attempt unresolved instead of settled', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  const chunks = [{ type: 'text', text: 'first' },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } }];
  const iterator = await f.streamListeners[0](requestOptions, () => chunkStream(chunks));
  const first = await iterator.next();
  assert.equal(first.value.type, 'text');
  await iterator.return();
  const snapshot = f.budget.snapshot();
  assert.equal(snapshot.attemptsUnknown, 1);
  assert.equal(snapshot.attemptsSettled, 0);
  assert.equal(snapshot.observedTokenTotal, 0);
  assert.equal(snapshot.attempts[0].reason, 'stream_abandoned');
});

test('invalid install options are refused before any registration', async (t) => {
  const f = await makePluginFixture(t);
  const base = f.installOptions;
  await assert.rejects(installTrialControl({ ...base, agent: { id: '' } }),
    /INVALID_INSTALL_OPTIONS: agent/);
  await assert.rejects(installTrialControl({ ...base, agent: { id: 'a', ctx: {} } }),
    /INVALID_INSTALL_OPTIONS: agent\.ctx/);
  await assert.rejects(installTrialControl({ ...base, run: {} }), /INVALID_INSTALL_OPTIONS: run/);
  await assert.rejects(installTrialControl({ ...base, files: {} }), /INVALID_INSTALL_OPTIONS: files/);
  await assert.rejects(installTrialControl({ ...base, tables: new Map() }),
    /INVALID_INSTALL_OPTIONS: tables/);
  await assert.rejects(installTrialControl({ ...base, budget: {} }), /INVALID_INSTALL_OPTIONS: budget/);
  await assert.rejects(installTrialControl({ ...base, defineTool: 'x' }),
    /INVALID_INSTALL_OPTIONS: defineTool/);
  await assert.rejects(installTrialControl({ ...base, waitMs: 0 }), /INVALID_INSTALL_OPTIONS: waitMs/);
  assert.equal(f.registeredTools.length, 0);
  assert.equal(f.registeredGuards.length, 0);
  assert.equal(f.streamListeners.length, 0);
});

test('unmeasurable or oversized requests are refused before dispatch', async (t) => {
  const f = await makePluginFixture(t);
  const oversized = await installTrialControl({ ...f.installOptions, measureRequest: () => 99999 });
  const unmeasurable = await installTrialControl({ ...f.installOptions, measureRequest: () => Number.NaN });
  const throwing = await installTrialControl({ ...f.installOptions,
    measureRequest: () => { throw new Error('cannot measure'); } });
  const control = await installTrialControl(f.installOptions);
  t.after(() => { oversized.dispose(); unmeasurable.dispose(); throwing.dispose(); control.dispose(); });
  let adapterCalls = 0;
  const next = () => { adapterCalls += 1; return chunkStream([]); };
  await assert.rejects(drain(f.streamListeners[0], requestOptions, next), /REQUEST_TOO_LARGE/);
  await assert.rejects(drain(f.streamListeners[1], requestOptions, next), /REQUEST_UNMEASURABLE/);
  await assert.rejects(drain(f.streamListeners[2], requestOptions, next), /REQUEST_UNMEASURABLE/);
  assert.equal(adapterCalls, 0);
});

test('a stream error marks the attempt unknown and blocks the next send', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  let adapterCalls = 0;
  const failing = () => {
    adapterCalls += 1;
    return (async function* () {
      yield { type: 'text', text: 'partial' };
      throw new Error('stream broke');
    })();
  };
  await assert.rejects(drain(f.streamListeners[0], requestOptions, failing), /stream broke/);
  assert.equal(adapterCalls, 1);
  assert.equal(f.budget.snapshot().attemptsUnknown, 1);
  await assert.rejects(drain(f.streamListeners[0], requestOptions, failing), /UNRESOLVED_USAGE/);
  assert.equal(adapterCalls, 1);
});

test('a stream without usage is marked unknown rather than settled at zero', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  const next = () => chunkStream([{ type: 'finish', reason: { kind: 'stop' } }]);
  await drain(f.streamListeners[0], requestOptions, next);
  const snapshot = f.budget.snapshot();
  assert.equal(snapshot.attemptsUnknown, 1);
  assert.equal(snapshot.observedTokenTotal, 0);
  assert.equal(snapshot.attempts[0].reason, 'usage_missing');
});

test('stop closes admission, cancels, drains and then disposes everything', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  const receipt = await control.stop('cancelled');
  assert.equal(receipt.status, 'stopped');
  assert.equal(f.run.snapshot().status, 'stopped');
  assert.equal(f.cancelled.length, 1);
  assert.deepEqual(f.cancelled[0].cause, { kind: 'user' });
  assert.equal(f.cancelled[0].options.keepInbox, false);
  assert.ok(f.registeredGuards.every(guard => guard.disposed === true));
  assert.ok(f.registeredTools.every(tool => tool.disposed === true));
  assert.ok(f.streamListeners.every(listener => listener.disposed === true));
  await assert.rejects(drain(f.streamListeners[0], requestOptions, () => chunkStream([])), /RUN_NOT_RUNNING/);
});

test('dispose unregisters without touching the run and is idempotent', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  control.dispose();
  assert.ok(f.registeredGuards.every(guard => guard.disposed === true));
  assert.ok(f.registeredTools.every(tool => tool.disposed === true));
  assert.ok(f.streamListeners.every(listener => listener.disposed === true));
  control.dispose();
  assert.equal(f.run.snapshot().status, 'running');
  assert.equal(f.cancelled.length, 0);
  assert.equal(control.admittedTools().includes('trial_read'), true);
});

test('a request without an explicit output bound is refused before dispatch', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  const { maxTokens, ...noBound } = requestOptions;
  let adapterCalls = 0;
  const next = () => { adapterCalls += 1; return chunkStream([]); };
  await assert.rejects(drain(f.streamListeners[0], noBound, next), /OUTPUT_BOUND_MISSING/);
  assert.equal(adapterCalls, 0);
  assert.equal(f.budget.snapshot().attemptsReserved, 0);
});

test('repeated usage samples follow the harness last-sample semantics', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  const chunks = [
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 100 } },
    { type: 'usage', usage: { inputTokens: 6, outputTokens: 8, cacheReadTokens: 50, cacheWriteTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  await drain(f.streamListeners[0], requestOptions, () => chunkStream(chunks));
  const snapshot = f.budget.snapshot();
  assert.equal(snapshot.observedInputTokens, 6);
  assert.equal(snapshot.observedOutputTokens, 8);
  assert.equal(snapshot.observedTokenTotal, 14);
  assert.equal(snapshot.observedCacheReadTokens, 50);
  assert.equal(snapshot.observedCacheWriteTokens, 3);
  assert.equal(snapshot.attemptsSettled, 1);
});

test('an invalid usage sample is unresolved rather than settled at a guessed value', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  const chunks = [{ type: 'usage', usage: { inputTokens: 'many', outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } }];
  await drain(f.streamListeners[0], requestOptions, () => chunkStream(chunks));
  const snapshot = f.budget.snapshot();
  assert.equal(snapshot.attemptsSettled, 0);
  assert.equal(snapshot.attemptsUnknown, 1);
  assert.equal(snapshot.attempts[0].reason, 'usage_invalid');
  assert.equal(snapshot.observedTokenTotal, 0);
});

test('reinstalling on the same batch does not reuse persisted attempt ids', async (t) => {
  const f = await makePluginFixture(t);
  let control = await installTrialControl(f.installOptions);
  const settleOnce = () => chunkStream([{ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } }]);
  await drain(f.streamListeners[0], requestOptions, settleOnce);
  assert.equal(f.budget.snapshot().attemptsSettled, 1);
  control.dispose();
  control = await installTrialControl(f.installOptions);
  t.after(() => control.dispose());
  await drain(f.streamListeners[1], requestOptions, settleOnce);
  const snapshot = f.budget.snapshot();
  assert.equal(snapshot.attemptsReserved, 2);
  assert.equal(snapshot.attemptsSettled, 2);
});

test('a failing registration rolls the whole install back', async (t) => {
  const f = await makePluginFixture(t);
  let registrations = 0;
  const failingAgent = { ...f.agent, ctx: { ...f.ctx, tools: {
    guard: f.ctx.tools.guard,
    register(definition) {
      registrations += 1;
      if (registrations === 2) throw new Error('register failed');
      return f.ctx.tools.register(definition);
    },
  } } };
  await assert.rejects(installTrialControl({ ...f.installOptions, agent: failingAgent }),
    /register failed/);
  assert.equal(f.registeredTools.length, 1);
  assert.equal(f.registeredTools[0].disposed, true);
  assert.equal(f.registeredGuards.length, 0);
  assert.equal(f.streamListeners.length, 0);
});

test('dispose finishes the remaining registrations even if one throws', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl({ ...f.installOptions, agent: { ...f.agent,
    ctx: { ...f.ctx, tools: {
      register: f.ctx.tools.register,
      guard(guard) {
        f.ctx.tools.guard(guard);
        return () => { throw new Error('dispose failed'); };
      },
    } } } });
  assert.throws(() => control.dispose(), /dispose failed/);
  assert.ok(f.registeredTools.every(tool => tool.disposed === true));
  assert.ok(f.streamListeners.every(listener => listener.disposed === true));
  control.dispose();
});

test('stop still disposes when the ordered stop cannot confirm', async (t) => {
  const f = await makePluginFixture(t);
  const control = await installTrialControl({ ...f.installOptions,
    files: { ...f.files, drain: () => Promise.reject(new Error('io fault')) } });
  const receipt = await control.stop('cancelled');
  assert.equal(receipt.status, 'stop_unconfirmed');
  assert.ok(f.registeredGuards.every(guard => guard.disposed === true));
  assert.ok(f.registeredTools.every(tool => tool.disposed === true));
  assert.ok(f.streamListeners.every(listener => listener.disposed === true));
});
