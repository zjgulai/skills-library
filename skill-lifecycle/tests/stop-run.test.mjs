import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { openRun } from '../control/run-state.mjs';
import { openFiles } from '../control/bounded-files.mjs';
import { openBudget } from '../control/budget-ledger.mjs';
import { stopRun, completeRun } from '../control/stop-run.mjs';
import { makeTempCase } from './fixtures.mjs';

const waitMs = 50;

async function openStartedRun(f, root = f.trusted, binding = f.binding) {
  const run = f.track(await openRun({ root, binding }));
  await run.start();
  return run;
}

function spyAgent(f, { cancel, whenIdle } = {}) {
  const calls = { cancel: 0, idle: 0 };
  return {
    calls,
    id: f.binding.sessionId,
    cancel(cause, options) {
      calls.cancel += 1;
      if (cancel) return cancel(cause, options);
      return undefined;
    },
    whenIdle() {
      calls.idle += 1;
      if (whenIdle) return whenIdle();
      return Promise.resolve();
    },
  };
}

function spyIo({ drain } = {}) {
  const calls = { drain: 0 };
  return {
    calls,
    drain() {
      calls.drain += 1;
      if (drain) return drain();
      return Promise.resolve();
    },
  };
}

function openBudgetOn(f, run, limits = f.testBudget) {
  return openBudget({ run, binding: f.binding, root: f.budget, limits });
}

test('admission closes before cancel and idle', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const order = [];
  const agent = {
    id: f.binding.sessionId,
    cancel(_cause, options) {
      assert.equal(run.snapshot().status, 'stopping');
      assert.equal(options.keepInbox, false);
      order.push('cancel');
    },
    async whenIdle() { order.push('idle'); },
  };
  const io = { async drain() { order.push('drain'); } };
  await stopRun({ run, binding: f.binding, agent, io, reason: 'cancelled',
    waitMs: 100, waitForIdle: (a) => a.whenIdle() });
  assert.deepEqual(order, ['cancel', 'idle', 'drain']);
  assert.equal(run.snapshot().status, 'stopped');
});

test('a stopped receipt records the agent, reason and confirmation', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const receipt = await stopRun({ run, binding: f.binding, agent: spyAgent(f),
    io: spyIo(), reason: 'budget_exhausted', waitMs, waitForIdle: (a) => a.whenIdle() });
  assert.equal(receipt.status, 'stopped');
  assert.equal(receipt.confirmed, true);
  assert.equal(receipt.cancelled, true);
  assert.equal(receipt.agentId, f.binding.sessionId);
  assert.equal(receipt.reason, 'budget_exhausted');
  assert.ok(Object.isFrozen(receipt));
  const state = run.snapshot();
  assert.equal(state.status, 'stopped');
  assert.equal(state.reason, 'budget_exhausted');
  assert.equal(state.details.agentId, f.binding.sessionId);
  assert.equal(state.details.idle, 'confirmed');
  assert.equal(state.details.drain, 'drained');
});

test('tools, reports and prompts are refused once stopping begins', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const io = f.track(await openFiles({ run, binding: f.binding, inputRoot: f.inputs,
    skillRoot: f.skill, outputRoot: f.outputs, files: f.inputFiles,
    limits: { maxInputBytes: 4096, maxReportBytes: 4096 } }));
  const observed = [];
  const agent = {
    id: f.binding.sessionId,
    cancel() {
      observed.push(() => assert.throws(() => run.assertAdmitted(f.binding), /RUN_NOT_RUNNING/));
    },
    async whenIdle() {
      await assert.rejects(io.read({ fileId: 'report', offset: 0, limit: 10 }), /RUN_NOT_RUNNING/);
      await assert.rejects(io.writeReport({ content: 'late write\n' }), /RUN_NOT_RUNNING/);
    },
  };
  await stopRun({ run, binding: f.binding, agent, io, reason: 'cancelled',
    waitMs, waitForIdle: (a) => a.whenIdle() });
  observed.forEach(check => check());
  assert.equal(run.snapshot().status, 'stopped');
});

test('another session agent is never cancelled', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const other = spyAgent(f);
  other.id = 'other-session-001';
  await assert.rejects(stopRun({ run, binding: f.binding, agent: other, io: spyIo(),
    reason: 'cancelled', waitMs, waitForIdle: (a) => a.whenIdle() }), /AGENT_SESSION_MISMATCH/);
  assert.equal(other.calls.cancel, 0);
  assert.equal(other.calls.idle, 0);
  assert.equal(run.snapshot().status, 'running');
  assert.equal(run.assertAdmitted(f.binding), undefined);
});

test('a binding that does not belong to the run is refused before any cancel', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const agent = spyAgent(f);
  await assert.rejects(stopRun({ run, binding: { ...f.binding, sessionId: 'other-session' },
    agent, io: spyIo(), reason: 'cancelled', waitMs, waitForIdle: (a) => a.whenIdle() }),
  /BINDING_MISMATCH|AGENT_SESSION_MISMATCH/);
  assert.equal(agent.calls.cancel, 0);
  assert.equal(run.snapshot().status, 'running');
});

test('concurrent stop calls cancel once and both confirm', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const agent = spyAgent(f);
  const io = spyIo();
  const args = { run, binding: f.binding, agent, io, reason: 'cancelled',
    waitMs, waitForIdle: (a) => a.whenIdle() };
  const [first, second] = await Promise.all([stopRun(args), stopRun(args)]);
  assert.equal(first.status, 'stopped');
  assert.equal(second.status, 'stopped');
  assert.equal(agent.calls.cancel, 1);
  assert.equal(io.calls.drain, 1);
});

test('stopping an already stopped run does not cancel again', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const agent = spyAgent(f);
  const io = spyIo();
  const args = { run, binding: f.binding, agent, io, reason: 'cancelled',
    waitMs, waitForIdle: (a) => a.whenIdle() };
  await stopRun(args);
  const again = await stopRun(args);
  assert.equal(again.status, 'stopped');
  assert.equal(again.idempotent, true);
  assert.equal(agent.calls.cancel, 1);
});

test('a completed run is not cancelled by a later stop', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  await run.markCompleted({ artifacts: ['validation-report.md'] });
  const agent = spyAgent(f);
  const receipt = await stopRun({ run, binding: f.binding, agent, io: spyIo(),
    reason: 'cancelled', waitMs, waitForIdle: (a) => a.whenIdle() });
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.cancelled, false);
  assert.equal(agent.calls.cancel, 0);
  assert.equal(run.snapshot().status, 'completed');
});

test('a cancel error leaves the run stop_unconfirmed and still refusing work', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const io = spyIo();
  const receipt = await stopRun({ run, binding: f.binding,
    agent: spyAgent(f, { cancel: () => { throw new Error('cancel failed'); } }),
    io, reason: 'cancelled', waitMs, waitForIdle: (a) => a.whenIdle() });
  assert.equal(receipt.status, 'stop_unconfirmed');
  assert.equal(receipt.confirmed, false);
  assert.equal(receipt.cancelled, false);
  assert.equal(receipt.failure, 'cancel_failed');
  assert.equal(io.calls.drain, 0);
  assert.equal(run.snapshot().status, 'stop_unconfirmed');
  assert.equal(run.snapshot().reason, 'cancelled:cancel_failed');
  assert.throws(() => run.assertAdmitted(f.binding), /RUN_NOT_RUNNING/);
});

test('a cancel that never settles is bounded and marks stop_unconfirmed', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const io = spyIo();
  const receipt = await stopRun({ run, binding: f.binding,
    agent: spyAgent(f, { cancel: () => new Promise(() => {}) }),
    io, reason: 'cancelled', waitMs, waitForIdle: (a) => a.whenIdle() });
  assert.equal(receipt.status, 'stop_unconfirmed');
  assert.equal(receipt.failure, 'cancel_timeout');
  assert.equal(receipt.cancelled, false);
  assert.equal(io.calls.drain, 0);
  assert.equal(run.snapshot().status, 'stop_unconfirmed');
});

test('a run whose admission cannot be closed is not cancelled', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const statePath = join(f.trusted, 'run-state.json');
  await rm(statePath);
  await mkdir(statePath);
  const agent = spyAgent(f);
  await assert.rejects(stopRun({ run, binding: f.binding, agent, io: spyIo(),
    reason: 'cancelled', waitMs, waitForIdle: (a) => a.whenIdle() }), /STOP_NOT_ADMITTED/);
  assert.equal(agent.calls.cancel, 0);
  assert.equal(run.snapshot().status, 'running');
});

test('a confirmed stop records unresolved attempts and observed usage', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const budget = f.track(await openBudgetOn(f, run));
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  const receipt = await stopRun({ run, binding: f.binding, agent: spyAgent(f), io: spyIo(),
    reason: 'cancelled', waitMs, waitForIdle: (a) => a.whenIdle(), budget });
  assert.equal(receipt.status, 'stopped');
  const state = run.snapshot();
  assert.equal(state.details.unresolvedAttempts, 1);
  assert.equal(state.details.observedTokenTotal, 0);
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 4, outputTokens: 4 } });
  assert.equal(budget.snapshot().observedTokenTotal, 8);
});

test('an unconfirmed idle wait marks stop_unconfirmed without draining', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const io = spyIo();
  const receipt = await stopRun({ run, binding: f.binding, agent: spyAgent(f),
    io, reason: 'cancelled', waitMs, waitForIdle: () => new Promise(() => {}) });
  assert.equal(receipt.status, 'stop_unconfirmed');
  assert.equal(receipt.failure, 'idle_timeout');
  assert.equal(io.calls.drain, 0);
  assert.equal(run.snapshot().status, 'stop_unconfirmed');
});

test('a rejecting idle wait marks stop_unconfirmed', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const io = spyIo();
  const receipt = await stopRun({ run, binding: f.binding, agent: spyAgent(f),
    io, reason: 'cancelled', waitMs, waitForIdle: () => Promise.reject(new Error('idle failed')) });
  assert.equal(receipt.status, 'stop_unconfirmed');
  assert.equal(receipt.failure, 'idle_failed');
  assert.equal(io.calls.drain, 0);
});

test('a failing drain marks stop_unconfirmed after a confirmed idle', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const receipt = await stopRun({ run, binding: f.binding, agent: spyAgent(f),
    io: spyIo({ drain: () => Promise.reject(new Error('io fault')) }),
    reason: 'cancelled', waitMs, waitForIdle: (a) => a.whenIdle() });
  assert.equal(receipt.status, 'stop_unconfirmed');
  assert.equal(receipt.failure, 'drain_failed');
  assert.equal(receipt.idle, 'confirmed');
  assert.equal(receipt.drain, 'unconfirmed');
  assert.equal(run.snapshot().status, 'stop_unconfirmed');
  assert.equal(run.snapshot().details, null);
});

test('a drain that never settles marks stop_unconfirmed', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const receipt = await stopRun({ run, binding: f.binding, agent: spyAgent(f),
    io: spyIo({ drain: () => new Promise(() => {}) }),
    reason: 'cancelled', waitMs, waitForIdle: (a) => a.whenIdle() });
  assert.equal(receipt.status, 'stop_unconfirmed');
  assert.equal(receipt.failure, 'drain_timeout');
});

test('a retry can confirm a stop that was previously unconfirmed', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const first = await stopRun({ run, binding: f.binding,
    agent: spyAgent(f, { cancel: () => { throw new Error('cancel failed'); } }),
    io: spyIo(), reason: 'cancelled', waitMs, waitForIdle: (a) => a.whenIdle() });
  assert.equal(first.status, 'stop_unconfirmed');
  const agent = spyAgent(f);
  const second = await stopRun({ run, binding: f.binding, agent, io: spyIo(),
    reason: 'cancelled', waitMs, waitForIdle: (a) => a.whenIdle() });
  assert.equal(second.status, 'stopped');
  assert.equal(agent.calls.cancel, 1);
  assert.equal(run.snapshot().status, 'stopped');
});

test('invalid stop arguments are refused before touching the run', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const base = { run, binding: f.binding, agent: spyAgent(f), io: spyIo(),
    reason: 'cancelled', waitMs, waitForIdle: (a) => a.whenIdle() };
  await assert.rejects(stopRun({ ...base, reason: '' }), /INVALID_STOP_ARGS/);
  await assert.rejects(stopRun({ ...base, waitMs: 0 }), /INVALID_STOP_ARGS/);
  await assert.rejects(stopRun({ ...base, waitForIdle: 'idle' }), /INVALID_STOP_ARGS/);
  await assert.rejects(stopRun({ ...base, io: {} }), /INVALID_STOP_ARGS/);
  await assert.rejects(stopRun({ ...base, agent: { id: f.binding.sessionId } }), /INVALID_STOP_ARGS/);
  await assert.rejects(stopRun({ ...base, budget: {} }), /INVALID_STOP_ARGS/);
  assert.equal(run.snapshot().status, 'running');
});

test('stopping persists across close and reopen and cannot be restarted', async (t) => {
  const f = await makeTempCase(t);
  let run = await openRun({ root: f.trusted, binding: f.binding });
  await run.start();
  await stopRun({ run, binding: f.binding,
    agent: spyAgent(f, { cancel: () => { throw new Error('cancel failed'); } }),
    io: spyIo(), reason: 'cancelled', waitMs, waitForIdle: (a) => a.whenIdle() });
  await run.close();
  run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  assert.equal(run.snapshot().status, 'stop_unconfirmed');
  await assert.rejects(run.start(), /INVALID_TRANSITION/);
  assert.throws(() => run.assertAdmitted(f.binding), /RUN_NOT_RUNNING/);
});

test('a prepared run can be stopped before any work starts', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  const agent = spyAgent(f);
  const receipt = await stopRun({ run, binding: f.binding, agent, io: spyIo(),
    reason: 'cancelled_before_start', waitMs, waitForIdle: (a) => a.whenIdle() });
  assert.equal(receipt.status, 'stopped');
  assert.equal(agent.calls.cancel, 1);
});

test('a closed run handle cannot be stopped', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  await run.close();
  await assert.rejects(stopRun({ run, binding: f.binding, agent: spyAgent(f), io: spyIo(),
    reason: 'cancelled', waitMs, waitForIdle: (a) => a.whenIdle() }), /RUN_CLOSED/);
});

test('a run already in stopping can still be driven to a confirmed stop', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  await run.markStopping('cancelled');
  assert.equal(run.snapshot().status, 'stopping');
  const agent = spyAgent(f);
  const receipt = await stopRun({ run, binding: f.binding, agent, io: spyIo(),
    reason: 'cancelled', waitMs, waitForIdle: (a) => a.whenIdle() });
  assert.equal(receipt.status, 'stopped');
  assert.equal(agent.calls.cancel, 1);
  assert.equal(run.snapshot().status, 'stopped');
});

test('a stopped run refuses new reservations while late usage is still recorded', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const budget = f.track(await openBudgetOn(f, run));
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  const receipt = await stopRun({ run, binding: f.binding, agent: spyAgent(f), io: spyIo(),
    reason: 'budget_exhausted', waitMs, waitForIdle: (a) => a.whenIdle() });
  assert.equal(receipt.status, 'stopped');
  await assert.rejects(budget.reserve({ attemptId: 'a2', requestBytes: 10, maxOutputTokens: 5 }),
    /RUN_NOT_RUNNING/);
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 3, outputTokens: 4 } });
  assert.equal(budget.snapshot().attemptsSettled, 1);
  assert.equal(run.snapshot().status, 'stopped');
  await assert.rejects(run.markCompleted({ artifacts: [] }), /INVALID_TRANSITION/);
});

test('completion requires a drained io, no pending attempts and named acceptance checks', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const budget = f.track(await openBudgetOn(f, run));
  const io = f.track(await openFiles({ run, binding: f.binding, inputRoot: f.inputs,
    skillRoot: f.skill, outputRoot: f.outputs, files: f.inputFiles,
    limits: { maxInputBytes: 4096, maxReportBytes: 4096 } }));
  await budget.reserve({ attemptId: 'a1', requestBytes: 64, maxOutputTokens: 20 });
  await io.writeReport({ content: 'summary: ok\n' });
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 5, outputTokens: 5 } });
  const receipt = await completeRun({ run, binding: f.binding, io, budget,
    details: { acceptance: ['report verified', 'usage settled'] } });
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.confirmed, true);
  const state = run.snapshot();
  assert.equal(state.status, 'completed');
  assert.deepEqual(state.details.acceptance, ['report verified', 'usage settled']);
});

test('completion is refused while an attempt is in flight', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const budget = f.track(await openBudgetOn(f, run));
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await assert.rejects(completeRun({ run, binding: f.binding, io: spyIo(), budget,
    details: { acceptance: ['x'] } }), /PENDING_REQUESTS/);
  assert.equal(run.snapshot().status, 'running');
});

test('completion is refused while an attempt is unresolved', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const budget = f.track(await openBudgetOn(f, run));
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await budget.markUnknown({ attemptId: 'a1', reason: 'response_lost' });
  await assert.rejects(completeRun({ run, binding: f.binding, io: spyIo(), budget,
    details: { acceptance: ['x'] } }), /UNRESOLVED_USAGE/);
  assert.equal(run.snapshot().status, 'running');
});

test('completion is refused when the io has not drained', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const budget = f.track(await openBudgetOn(f, run));
  await assert.rejects(completeRun({ run, binding: f.binding,
    io: spyIo({ drain: () => Promise.reject(new Error('io fault')) }), budget,
    details: { acceptance: ['x'] } }), /IO_NOT_DRAINED/);
  assert.equal(run.snapshot().status, 'running');
});

test('completion is refused without named acceptance checks', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const budget = f.track(await openBudgetOn(f, run));
  const io = spyIo();
  await assert.rejects(completeRun({ run, binding: f.binding, io, budget, details: {} }),
    /INVALID_ACCEPTANCE/);
  await assert.rejects(completeRun({ run, binding: f.binding, io, budget,
    details: { acceptance: [] } }), /INVALID_ACCEPTANCE/);
  await assert.rejects(completeRun({ run, binding: f.binding, io, budget,
    details: { acceptance: ['ok', ''] } }), /INVALID_ACCEPTANCE/);
  await assert.rejects(completeRun({ run, binding: f.binding, io, budget,
    details: { acceptance: 'ok' } }), /INVALID_ACCEPTANCE/);
  await assert.rejects(completeRun({ run, binding: f.binding, io, budget,
    details: { acceptance: ['ok'], extra: true } }), /INVALID_ACCEPTANCE/);
  assert.equal(run.snapshot().status, 'running');
});

test('completion is refused once the run is stopping', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const budget = f.track(await openBudgetOn(f, run));
  await run.markStopping('cancelled');
  await assert.rejects(completeRun({ run, binding: f.binding, io: spyIo(), budget,
    details: { acceptance: ['x'] } }), /RUN_NOT_RUNNING/);
});

test('a new run in the same batch inherits the counters after a stop', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  let budget = f.track(await openBudgetOn(f, run));
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 1, outputTokens: 1 } });
  await stopRun({ run, binding: f.binding, agent: spyAgent(f), io: spyIo(),
    reason: 'cancelled', waitMs, waitForIdle: (a) => a.whenIdle() });
  await budget.close();
  const nextRoot = join(f.root, 'trusted-next');
  await mkdir(nextRoot);
  const nextBinding = { ...f.binding, runId: 'run-next-001', skillDigest: 'e'.repeat(64) };
  const nextRun = f.track(await openRun({ root: nextRoot, binding: nextBinding }));
  await nextRun.start();
  budget = f.track(await openBudget({ run: nextRun, binding: nextBinding, root: f.budget,
    limits: f.testBudget }));
  assert.equal(budget.snapshot().attemptsReserved, 1);
  await budget.reserve({ attemptId: 'b1', requestBytes: 10, maxOutputTokens: 5 });
  assert.equal(budget.snapshot().attemptsReserved, 2);
  assert.equal(nextRun.snapshot().status, 'running');
});

test('late events after a confirmed stop never restart the run', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const budget = f.track(await openBudgetOn(f, run));
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await stopRun({ run, binding: f.binding, agent: spyAgent(f), io: spyIo(),
    reason: 'cancelled', waitMs, waitForIdle: (a) => a.whenIdle() });
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 2, outputTokens: 2 } });
  await assert.rejects(budget.reserve({ attemptId: 'a2', requestBytes: 10, maxOutputTokens: 5 }),
    /RUN_NOT_RUNNING/);
  assert.throws(() => run.assertAdmitted(f.binding), /RUN_NOT_RUNNING/);
  assert.equal(run.snapshot().status, 'stopped');
});

test('completion is idempotent once the run is already completed', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const budget = f.track(await openBudgetOn(f, run));
  const io = spyIo();
  const first = await completeRun({ run, binding: f.binding, io, budget,
    details: { acceptance: ['report verified'] } });
  assert.equal(first.idempotent, false);
  const second = await completeRun({ run, binding: f.binding, io, budget,
    details: { acceptance: ['report verified'] } });
  assert.equal(second.status, 'completed');
  assert.equal(second.idempotent, true);
  assert.equal(run.snapshot().status, 'completed');
});

test('completion re-checks the ledger after the drain', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const budget = f.track(await openBudgetOn(f, run));
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 1, outputTokens: 1 } });
  const io = spyIo({ drain: () => budget.reserve({ attemptId: 'a2', requestBytes: 10, maxOutputTokens: 5 }) });
  await assert.rejects(completeRun({ run, binding: f.binding, io, budget,
    details: { acceptance: ['report verified'] } }), /PENDING_REQUESTS/);
  assert.equal(run.snapshot().status, 'running');
  assert.equal(budget.snapshot().attemptsReserved, 2);
});

test('acceptance entries must be plain data values', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f);
  const budget = f.track(await openBudgetOn(f, run));
  const io = spyIo();
  const items = ['ok'];
  Object.defineProperty(items, '0', { get: () => 'ok', enumerable: true, configurable: true });
  await assert.rejects(completeRun({ run, binding: f.binding, io, budget,
    details: { acceptance: items } }), /INVALID_ACCEPTANCE/);
  const sparse = ['ok'];
  sparse[2] = 'later';
  await assert.rejects(completeRun({ run, binding: f.binding, io, budget,
    details: { acceptance: sparse } }), /INVALID_ACCEPTANCE/);
  assert.equal(run.snapshot().status, 'running');
});
