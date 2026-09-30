import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openRun } from '../control/run-state.mjs';
import { openBudget } from '../control/budget-ledger.mjs';
import { openBatchGroup, composeBudget } from '../control/batch-group.mjs';
import { makeTempCase } from './fixtures.mjs';

const groupLimits = { maxAttempts: 3, observedTokenStop: 100, batchDeadlineMs: 5000 };
const usage = (input, output) => ({ inputTokens: input, outputTokens: output });

async function openGroup(f, { limits = groupLimits, groupId = 'a4-test-batch', now } = {}) {
  const options = { root: f.trusted, groupId, limits };
  if (now) options.now = now;
  return f.track(await openBatchGroup(options));
}

test('group limits and root are validated', async (t) => {
  const f = await makeTempCase(t);
  await assert.rejects(openBatchGroup({ root: f.trusted, groupId: 'g1',
    limits: { maxAttempts: 0, observedTokenStop: 100, batchDeadlineMs: 5000 } }), /INVALID_LIMITS/);
  await assert.rejects(openBatchGroup({ root: f.trusted, groupId: 'g1',
    limits: { maxAttempts: 1, observedTokenStop: 100 } }), /INVALID_LIMITS/);
  await assert.rejects(openBatchGroup({ root: join(f.trusted, 'missing'), groupId: 'g1',
    limits: groupLimits }), /INVALID_GROUP_ROOT/);
});

test('reserve and settle persist counters across reopen', async (t) => {
  const f = await makeTempCase(t);
  const group = await openGroup(f);
  const receipt = await group.reserve({ attemptId: 'a1', requestBytes: 100, maxOutputTokens: 20 });
  assert.equal(receipt.attemptId, 'a1');
  assert.equal(receipt.attemptsDispatched, 1);
  assert.equal(receipt.remainingAttempts, 2);
  await group.settle({ attemptId: 'a1', usage: usage(30, 12) });
  const snapshot = group.snapshot();
  assert.equal(snapshot.attemptsDispatched, 1);
  assert.equal(snapshot.attemptsSettled, 1);
  assert.equal(snapshot.observedInputTokens, 30);
  assert.equal(snapshot.observedOutputTokens, 12);
  assert.equal(snapshot.observedTokenTotal, 42);
  await group.close();
  const stored = JSON.parse(await readFile(join(f.trusted, 'batch-group.json'), 'utf8'));
  assert.equal(stored.groupId, 'a4-test-batch');
  assert.equal(stored.limits.maxAttempts, 3);
  const reopened = await openGroup(f);
  const reopenedSnapshot = reopened.snapshot();
  assert.equal(reopenedSnapshot.attemptsSettled, 1);
  assert.equal(reopenedSnapshot.observedTokenTotal, 42);
  await reopened.reserve({ attemptId: 'a2' });
  assert.equal(reopened.snapshot().attemptsDispatched, 2);
});

test('a released reservation frees the count but keeps the id spent', async (t) => {
  const f = await makeTempCase(t);
  const group = await openGroup(f);
  await group.reserve({ attemptId: 'a1' });
  const released = await group.release({ attemptId: 'a1' });
  assert.equal(released.released, true);
  assert.equal(group.snapshot().attemptsDispatched, 0);
  assert.equal(group.snapshot().attemptsReleased, 1);
  await assert.rejects(group.reserve({ attemptId: 'a1' }), /ATTEMPT_ID_REUSED/);
  await group.reserve({ attemptId: 'a2' });
  await assert.rejects(group.settle({ attemptId: 'a1', usage: usage(1, 1) }), /ATTEMPT_RELEASED/);
  await assert.rejects(group.markUnknown({ attemptId: 'a1', reason: 'late' }), /ATTEMPT_RELEASED/);
  await assert.rejects(group.release({ attemptId: 'a9' }), /ATTEMPT_NOT_FOUND/);
});

test('the attempt cap rejects new reservations', async (t) => {
  const f = await makeTempCase(t);
  const group = await openGroup(f, { limits: { ...groupLimits, maxAttempts: 2 } });
  await group.reserve({ attemptId: 'a1' });
  await group.reserve({ attemptId: 'a2' });
  await assert.rejects(group.reserve({ attemptId: 'a3' }), /ATTEMPTS_EXHAUSTED/);
});

test('the observed token stop rejects new reservations', async (t) => {
  const f = await makeTempCase(t);
  const group = await openGroup(f, { limits: { ...groupLimits, observedTokenStop: 100 } });
  await group.reserve({ attemptId: 'a1' });
  await group.settle({ attemptId: 'a1', usage: usage(60, 50) });
  await assert.rejects(group.reserve({ attemptId: 'a2' }), /OBSERVED_TOKEN_STOP/);
});

test('the batch deadline rejects new reservations', async (t) => {
  const f = await makeTempCase(t);
  let clock = 1000;
  const group = await openGroup(f, { now: () => clock });
  await group.reserve({ attemptId: 'a1' });
  await group.settle({ attemptId: 'a1', usage: usage(1, 1) });
  clock = 6001;
  await assert.rejects(group.reserve({ attemptId: 'a2' }), /BUDGET_DEADLINE_EXCEEDED/);
});

test('unknown usage is sticky and blocks the batch across reopen', async (t) => {
  const f = await makeTempCase(t);
  const group = await openGroup(f);
  await group.reserve({ attemptId: 'a1' });
  await group.markUnknown({ attemptId: 'a1', reason: 'response_lost' });
  assert.equal(group.snapshot().attemptsUnknown, 1);
  await assert.rejects(group.reserve({ attemptId: 'a2' }), /UNRESOLVED_USAGE/);
  await group.close();
  const reopened = await openGroup(f);
  assert.equal(reopened.snapshot().attemptsUnknown, 1);
  await assert.rejects(reopened.reserve({ attemptId: 'a3' }), /UNRESOLVED_USAGE/);
});

test('in-flight reservations from a crashed process become unknown on reopen', async (t) => {
  const f = await makeTempCase(t);
  const group = await openGroup(f);
  await group.reserve({ attemptId: 'a1' });
  await group.close();
  const reopened = await openGroup(f);
  const snapshot = reopened.snapshot();
  assert.equal(snapshot.attemptsUnknown, 1);
  assert.equal(snapshot.entries.find(entry => entry.attemptId === 'a1').reason,
    'group_recovered_in_flight');
  await assert.rejects(reopened.reserve({ attemptId: 'a2' }), /UNRESOLVED_USAGE/);
});

test('a closed group rejects mutations but still snapshots', async (t) => {
  const f = await makeTempCase(t);
  const group = await openGroup(f);
  await group.reserve({ attemptId: 'a1' });
  await group.close();
  await group.close();
  await assert.rejects(group.reserve({ attemptId: 'a2' }), /GROUP_CLOSED/);
  assert.equal(group.snapshot().attemptsDispatched, 1);
});

test('invalid attempt ids and usages are rejected', async (t) => {
  const f = await makeTempCase(t);
  const group = await openGroup(f);
  await assert.rejects(group.reserve({ attemptId: '  ' }), /INVALID_ATTEMPT/);
  await group.reserve({ attemptId: 'a1' });
  await assert.rejects(group.settle({ attemptId: 'a1', usage: usage(-1, 1) }), /INVALID_USAGE/);
  await assert.rejects(group.settle({ attemptId: 'a1', usage: { inputTokens: 1 } }), /INVALID_USAGE/);
  await assert.rejects(group.markUnknown({ attemptId: 'a1', reason: '' }), /INVALID_REASON/);
});

test('composeBudget keeps the group behind the ledger and releases on ledger refusal', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await run.start();
  const ledger = f.track(await openBudget({ run, binding: f.binding, root: f.budget,
    limits: { ...f.testBudget, maxAttempts: 1 }, now: () => 1000 }));
  const group = await openGroup(f);
  const budget = composeBudget({ ledger, group });
  const receipt = await budget.reserve({ attemptId: 'a1', requestBytes: 100, maxOutputTokens: 20 });
  assert.equal(receipt.attemptId, 'a1');
  assert.equal(group.snapshot().attemptsDispatched, 1);
  await budget.settle({ attemptId: 'a1', usage: usage(7, 3) });
  assert.equal(group.snapshot().observedTokenTotal, 10);
  const snapshot = budget.snapshot();
  assert.equal(snapshot.attemptsSettled, 1);
  assert.equal(snapshot.group.attemptsSettled, 1);
  await assert.rejects(budget.reserve({ attemptId: 'a2', requestBytes: 100, maxOutputTokens: 20 }),
    /ATTEMPTS_EXHAUSTED/);
  assert.equal(group.snapshot().attemptsDispatched, 1);
  assert.equal(group.snapshot().attemptsReleased, 1);
  await assert.rejects(budget.markUnknown({ attemptId: 'a1', reason: 'too_late' }),
    /ATTEMPT_ALREADY_SETTLED/);
});
