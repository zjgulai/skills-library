import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openRun } from '../control/run-state.mjs';
import { openFiles } from '../control/bounded-files.mjs';
import { parseCsv, compute } from '../control/table-compute.mjs';
import { openBudget } from '../control/budget-ledger.mjs';
import { makeTempCase } from './fixtures.mjs';

function limitsWith(overrides = {}) {
  return { maxAttempts: 2, maxOutputTokensPerAttempt: 20, maxRequestBytes: 4096,
    observedTokenStop: 100, batchDeadlineMs: 5000, attemptTimeoutMs: 100, ...overrides };
}

function candidateBinding(f, overrides = {}) {
  return { ...f.binding, runId: 'run-candidate-001', skillDigest: 'c'.repeat(64), ...overrides };
}

async function openStartedRun(f, root, binding = f.binding) {
  const run = f.track(await openRun({ root, binding }));
  await run.start();
  return run;
}

async function openBudgetOn(f, run, { binding = f.binding, limits = f.testBudget, now, amendment } = {}) {
  const options = { run, binding, root: f.budget, limits };
  if (now) options.now = now;
  if (amendment) options.amendment = amendment;
  return f.track(await openBudget(options));
}

test('unknown usage cannot become a free retry after reopen', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await run.start();
  let budget = await openBudget({ run, binding: f.binding, root: f.budget,
    limits: f.testBudget, now: () => 1000 });
  await budget.reserve({ attemptId: 'a1', requestBytes: 100, maxOutputTokens: 20 });
  await budget.markUnknown({ attemptId: 'a1', reason: 'response_lost' });
  await budget.close();
  budget = f.track(await openBudget({ run, binding: f.binding, root: f.budget,
    limits: f.testBudget, now: () => 1001 }));
  await assert.rejects(budget.reserve({ attemptId: 'a2', requestBytes: 100,
    maxOutputTokens: 20 }), /UNRESOLVED_USAGE/);
  assert.equal(budget.snapshot().attemptsReserved, 1);
});

test('reserve admits one attempt, returns a receipt and persists the batch identity', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  const receipt = await budget.reserve({ attemptId: 'a1', requestBytes: 120, maxOutputTokens: 20 });
  assert.equal(receipt.attemptId, 'a1');
  assert.equal(receipt.attemptNumber, 1);
  assert.equal(receipt.remainingAttempts, 1);
  assert.equal(receipt.batchId, f.binding.batchId);
  assert.equal(receipt.runId, f.binding.runId);
  const ledger = JSON.parse(await readFile(join(f.budget, 'budget-ledger.json'), 'utf8'));
  assert.equal(ledger.batchId, f.binding.batchId);
  assert.equal(ledger.attemptsReserved, 1);
  assert.equal(ledger.attempts.length, 1);
  assert.equal(ledger.attempts[0].runId, f.binding.runId);
  assert.equal(ledger.attempts[0].sessionId, f.binding.sessionId);
  assert.equal(ledger.attempts[0].skillDigest, f.binding.skillDigest);
  assert.equal(ledger.attempts[0].requestBytes, 120);
  assert.equal(budget.snapshot().attemptsReserved, 1);
});

test('a second open of the same batch root is blocked by the batch lock', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  await openBudgetOn(f, run);
  await assert.rejects(openBudget({ run, binding: f.binding, root: f.budget, limits: f.testBudget }),
    /BUDGET_LOCKED/);
});

test('close releases the batch lock but neither the run lock nor run admission', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run, { now: () => 1000 });
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await budget.close();
  assert.equal(run.snapshot().status, 'running');
  assert.equal(run.assertAdmitted(f.binding), undefined);
  await assert.rejects(openRun({ root: f.trusted, binding: f.binding }), /RUN_LOCKED/);
  const reopened = await openBudgetOn(f, run, { now: () => 1000 });
  assert.equal(reopened.snapshot().attemptsReserved, 1);
  await assert.rejects(reopened.reserve({ attemptId: 'a2', requestBytes: 10, maxOutputTokens: 5 }),
    /ATTEMPT_IN_FLIGHT/);
});

test('attempts are exhausted at maxAttempts and failed sends still count', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await budget.markUnknown({ attemptId: 'a1', reason: 'transport_error' });
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 3, outputTokens: 2 } });
  await budget.reserve({ attemptId: 'a2', requestBytes: 10, maxOutputTokens: 5 });
  await budget.settle({ attemptId: 'a2', usage: { inputTokens: 3, outputTokens: 2 } });
  await assert.rejects(budget.reserve({ attemptId: 'a3', requestBytes: 10, maxOutputTokens: 5 }),
    /ATTEMPTS_EXHAUSTED/);
  assert.equal(budget.snapshot().attemptsReserved, 2);
});

test('request size and output token caps reject before the ledger changes', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await assert.rejects(budget.reserve({ attemptId: 'a1', requestBytes: 4097, maxOutputTokens: 5 }),
    /REQUEST_TOO_LARGE/);
  await assert.rejects(budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 21 }),
    /OUTPUT_TOO_LARGE/);
  const snapshot = budget.snapshot();
  assert.equal(snapshot.attemptsReserved, 0);
  assert.equal(snapshot.attempts.length, 0);
});

test('the batch deadline rejects new attempts without changing counters', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  let time = 1000;
  const budget = await openBudgetOn(f, run, { now: () => time });
  time = 5999;
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 1, outputTokens: 1 } });
  time = 6000;
  await assert.rejects(budget.reserve({ attemptId: 'a2', requestBytes: 10, maxOutputTokens: 5 }),
    /BUDGET_DEADLINE_EXCEEDED/);
  assert.equal(budget.snapshot().attemptsReserved, 1);
});

test('only one attempt may be in flight at a time', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  // 固定时钟：fixture 的 attemptTimeoutMs 只有 100ms，真实时钟下并行跑满会让在途尝试
  // 被判成过期（reconcileExpiredAttempt → unknown），断言就会从 ATTEMPT_IN_FLIGHT 变成 UNRESOLVED_USAGE。
  const budget = await openBudgetOn(f, run, { now: () => 1000 });
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await assert.rejects(budget.reserve({ attemptId: 'a2', requestBytes: 10, maxOutputTokens: 5 }),
    /ATTEMPT_IN_FLIGHT/);
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 1, outputTokens: 1 } });
  await budget.reserve({ attemptId: 'a2', requestBytes: 10, maxOutputTokens: 5 });
  assert.equal(budget.snapshot().attemptsReserved, 2);
});

test('attempt ids cannot be reused after settlement, unknown or rejection', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 1, outputTokens: 1 } });
  await assert.rejects(budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 }),
    /ATTEMPT_ID_REUSED/);
  await budget.reserve({ attemptId: 'a2', requestBytes: 10, maxOutputTokens: 5 });
  await budget.markUnknown({ attemptId: 'a2', reason: 'response_lost' });
  await assert.rejects(budget.reserve({ attemptId: 'a2', requestBytes: 10, maxOutputTokens: 5 }),
    /ATTEMPT_ID_REUSED/);
});

test('invalid attempt arguments are rejected as a dense record', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await assert.rejects(budget.reserve({ attemptId: '', requestBytes: 10, maxOutputTokens: 5 }),
    /INVALID_ATTEMPT/);
  await assert.rejects(budget.reserve({ attemptId: 'a1', requestBytes: 1.5, maxOutputTokens: 5 }),
    /INVALID_ATTEMPT/);
  await assert.rejects(budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 0 }),
    /INVALID_ATTEMPT/);
  await assert.rejects(budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5, extra: true }),
    /INVALID_ATTEMPT/);
  await assert.rejects(budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5, get limit() { return 1; } }),
    /INVALID_ATTEMPT/);
  assert.equal(budget.snapshot().attemptsReserved, 0);
});

test('reserve requires a prepared-or-running state that is actually running', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  const budget = await openBudgetOn(f, run);
  await assert.rejects(budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 }),
    /RUN_NOT_RUNNING/);
  await run.start();
  await run.markStopping('cancelled');
  await assert.rejects(budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 }),
    /RUN_NOT_RUNNING/);
});

test('stopping blocks new attempts while late usage is still recorded', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await run.markStopping('cancelled');
  await assert.rejects(budget.reserve({ attemptId: 'a2', requestBytes: 10, maxOutputTokens: 5 }),
    /RUN_NOT_RUNNING/);
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 4, outputTokens: 6 } });
  const snapshot = budget.snapshot();
  assert.equal(snapshot.attemptsSettled, 1);
  assert.equal(snapshot.observedInputTokens, 4);
  assert.equal(snapshot.observedOutputTokens, 6);
  assert.equal(run.snapshot().status, 'stopping');
});

test('open rejects a binding that does not match the run', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  await assert.rejects(openBudget({ run, binding: { ...f.binding, sessionId: 'other-session' },
    root: f.budget, limits: f.testBudget }), /BINDING_MISMATCH/);
});

test('a ledger written for another batch id is refused, not overwritten', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await budget.close();
  const ledgerPath = join(f.budget, 'budget-ledger.json');
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  ledger.batchId = 'another-batch';
  await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`);
  await assert.rejects(openBudget({ run, binding: f.binding, root: f.budget, limits: f.testBudget }),
    /BATCH_MISMATCH/);
  assert.equal(JSON.parse(await readFile(ledgerPath, 'utf8')).batchId, 'another-batch');
});

test('candidate runs link to the same batch ledger without resetting counters', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  let budget = await openBudgetOn(f, run);
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 1, outputTokens: 1 } });
  await budget.close();
  const candidateRoot = join(f.root, 'trusted-candidate');
  await mkdir(candidateRoot);
  const candidate = candidateBinding(f);
  const candidateRun = await openStartedRun(f, candidateRoot, candidate);
  budget = await openBudgetOn(f, candidateRun, { binding: candidate, now: () => 1100 });
  const snapshot = budget.snapshot();
  assert.equal(snapshot.attemptsReserved, 1);
  assert.equal(snapshot.observedInputTokens, 1);
  await budget.reserve({ attemptId: 'b1', requestBytes: 10, maxOutputTokens: 5 });
  const ledger = JSON.parse(await readFile(join(f.budget, 'budget-ledger.json'), 'utf8'));
  assert.equal(ledger.attempts[1].runId, candidate.runId);
  assert.equal(ledger.attempts[1].skillDigest, candidate.skillDigest);
});

test('limits changes require a traceable amendment and preserve counters', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 1, outputTokens: 1 } });
  await budget.close();
  const amended = limitsWith({ maxAttempts: 3 });
  await assert.rejects(openBudget({ run, binding: f.binding, root: f.budget, limits: amended }),
    /BUDGET_REVISION_REQUIRED/);
  const budget2 = await openBudgetOn(f, run, { limits: amended,
    amendment: { reference: 'approval-2026-09-25-01' } });
  const snapshot = budget2.snapshot();
  assert.equal(snapshot.attemptsReserved, 1);
  assert.equal(snapshot.observedOutputTokens, 1);
  assert.equal(snapshot.limits.maxAttempts, 3);
  assert.equal(snapshot.amendments.length, 1);
  assert.equal(snapshot.amendments[0].reference, 'approval-2026-09-25-01');
  assert.notEqual(snapshot.amendments[0].previousConfigDigest, snapshot.amendments[0].nextConfigDigest);
  await budget2.reserve({ attemptId: 'a2', requestBytes: 10, maxOutputTokens: 5 });
  await budget2.settle({ attemptId: 'a2', usage: { inputTokens: 1, outputTokens: 1 } });
  await budget2.reserve({ attemptId: 'a3', requestBytes: 10, maxOutputTokens: 5 });
  assert.equal(budget2.snapshot().attemptsReserved, 3);
});

test('a changed policy digest also requires an amendment and never resets counters', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await budget.close();
  const candidateRoot = join(f.root, 'trusted-policy');
  await mkdir(candidateRoot);
  const nextPolicy = candidateBinding(f, { runId: 'run-candidate-002', policyDigest: 'e'.repeat(64) });
  const nextRun = await openStartedRun(f, candidateRoot, nextPolicy);
  await assert.rejects(openBudget({ run: nextRun, binding: nextPolicy, root: f.budget, limits: f.testBudget }),
    /BUDGET_REVISION_REQUIRED/);
  const budget2 = await openBudgetOn(f, nextRun, { binding: nextPolicy,
    amendment: { reference: 'approval-2026-09-25-02' } });
  assert.equal(budget2.snapshot().policyDigest, 'e'.repeat(64));
  assert.equal(budget2.snapshot().attemptsReserved, 1);
  assert.equal(budget2.snapshot().amendments.length, 1);
});

test('identical repeated usage is idempotent and never counted twice', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  const first = await budget.settle({ attemptId: 'a1', usage: { inputTokens: 5, outputTokens: 7 } });
  const second = await budget.settle({ attemptId: 'a1', usage: { inputTokens: 5, outputTokens: 7 } });
  assert.equal(first.status, 'settled');
  assert.equal(second.status, 'settled');
  const snapshot = budget.snapshot();
  assert.equal(snapshot.attemptsSettled, 1);
  assert.equal(snapshot.observedInputTokens, 5);
  assert.equal(snapshot.observedOutputTokens, 7);
  assert.equal(snapshot.observedTokenTotal, 12);
});

test('conflicting usage for the same attempt is rejected without changing totals', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 5, outputTokens: 7 } });
  await assert.rejects(budget.settle({ attemptId: 'a1', usage: { inputTokens: 5, outputTokens: 8 } }),
    /USAGE_CONFLICT/);
  const snapshot = budget.snapshot();
  assert.equal(snapshot.observedInputTokens, 5);
  assert.equal(snapshot.observedOutputTokens, 7);
  assert.equal(snapshot.attemptsSettled, 1);
});

test('a late settlement reconciles an unknown attempt and reopens admission', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await budget.markUnknown({ attemptId: 'a1', reason: 'response_lost' });
  await assert.rejects(budget.reserve({ attemptId: 'a2', requestBytes: 10, maxOutputTokens: 5 }),
    /UNRESOLVED_USAGE/);
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 4, outputTokens: 6 } });
  const reconciled = budget.snapshot();
  assert.equal(reconciled.attemptsUnknown, 0);
  assert.equal(reconciled.attemptsSettled, 1);
  assert.equal(reconciled.observedTokenTotal, 10);
  await budget.reserve({ attemptId: 'a2', requestBytes: 10, maxOutputTokens: 5 });
  assert.equal(budget.snapshot().attemptsReserved, 2);
});

test('invalid or incomplete usage marks the attempt unknown instead of settling it', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await assert.rejects(budget.settle({ attemptId: 'a1', usage: { inputTokens: -1, outputTokens: 2 } }),
    /INVALID_USAGE/);
  await assert.rejects(budget.settle({ attemptId: 'a1', usage: { inputTokens: 3 } }), /INVALID_USAGE/);
  await assert.rejects(budget.settle({ attemptId: 'a1', usage: { inputTokens: 3, outputTokens: 2, extra: 1 } }),
    /INVALID_USAGE/);
  await assert.rejects(budget.settle({ attemptId: 'a1',
    usage: { inputTokens: 3, outputTokens: 2, get id() { return 'x'; } } }), /INVALID_USAGE/);
  const snapshot = budget.snapshot();
  assert.equal(snapshot.attempts[0].status, 'unknown');
  assert.equal(snapshot.attemptsUnknown, 1);
  assert.equal(snapshot.observedTokenTotal, 0);
  await assert.rejects(budget.reserve({ attemptId: 'a2', requestBytes: 10, maxOutputTokens: 5 }),
    /UNRESOLVED_USAGE/);
});

test('cache usage is stored separately and never added to token totals', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run, { limits: limitsWith({ observedTokenStop: 40 }) });
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await budget.settle({ attemptId: 'a1',
    usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 500, cacheWriteTokens: 7 } });
  const snapshot = budget.snapshot();
  assert.equal(snapshot.observedInputTokens, 10);
  assert.equal(snapshot.observedOutputTokens, 20);
  assert.equal(snapshot.observedTokenTotal, 30);
  assert.equal(snapshot.observedCacheReadTokens, 500);
  assert.equal(snapshot.observedCacheWriteTokens, 7);
  assert.equal(snapshot.attempts[0].usage.cacheReadTokens, 500);
  await budget.reserve({ attemptId: 'a2', requestBytes: 10, maxOutputTokens: 5 });
});

test('settling an attempt that was never reserved is rejected', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await assert.rejects(budget.settle({ attemptId: 'a9', usage: { inputTokens: 1, outputTokens: 1 } }),
    /ATTEMPT_NOT_FOUND/);
  await assert.rejects(budget.markUnknown({ attemptId: 'a9', reason: 'x' }), /ATTEMPT_NOT_FOUND/);
});

test('markUnknown is idempotent for unknown attempts and refused for settled ones', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await budget.markUnknown({ attemptId: 'a1', reason: 'first_reason' });
  await budget.markUnknown({ attemptId: 'a1', reason: 'second_reason' });
  assert.equal(budget.snapshot().attempts[0].reason, 'first_reason');
  await assert.rejects(budget.markUnknown({ attemptId: 'a1', reason: '' }), /INVALID_REASON/);
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 2, outputTokens: 2 } });
  await assert.rejects(budget.markUnknown({ attemptId: 'a1', reason: 'late' }), /ATTEMPT_ALREADY_SETTLED/);
  assert.equal(budget.snapshot().attemptsSettled, 1);
});

test('observed token stop blocks further attempts once settled usage crosses it', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run, { limits: limitsWith({ observedTokenStop: 25 }) });
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 20, outputTokens: 5 } });
  await assert.rejects(budget.reserve({ attemptId: 'a2', requestBytes: 10, maxOutputTokens: 5 }),
    /OBSERVED_TOKEN_STOP/);
  assert.equal(budget.snapshot().attemptsReserved, 1);
});

test('a counting transport stub only sends after admitted reservations', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  let sends = 0;
  const sendOnce = async (attemptId) => {
    await budget.reserve({ attemptId, requestBytes: 10, maxOutputTokens: 5 });
    sends += 1;
  };
  await sendOnce('a1');
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 1, outputTokens: 1 } });
  await sendOnce('a2');
  await budget.settle({ attemptId: 'a2', usage: { inputTokens: 1, outputTokens: 1 } });
  await assert.rejects(sendOnce('a3'), /ATTEMPTS_EXHAUSTED/);
  await run.markStopping('cancelled');
  await assert.rejects(sendOnce('a4'), /RUN_NOT_RUNNING/);
  assert.equal(sends, 2);
});

test('a ledger write failure blocks the send and stays sticky', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  let sends = 0;
  const sendOnce = async (attemptId) => {
    await budget.reserve({ attemptId, requestBytes: 10, maxOutputTokens: 5 });
    sends += 1;
  };
  await sendOnce('a1');
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 1, outputTokens: 1 } });
  const ledgerPath = join(f.budget, 'budget-ledger.json');
  await rm(ledgerPath);
  await mkdir(ledgerPath);
  await assert.rejects(sendOnce('a2'), /BUDGET_PERSIST_FAILED/);
  await assert.rejects(sendOnce('a3'), /BUDGET_STORAGE_FAILED/);
  assert.equal(sends, 1);
  const snapshot = budget.snapshot();
  assert.equal(snapshot.attemptsReserved, 1);
  assert.equal(snapshot.attemptsSettled, 1);
  assert.deepEqual((await readdir(f.budget)).filter(name => name.endsWith('.tmp')), []);
  await budget.close();
  await assert.rejects(openBudget({ run, binding: f.binding, root: f.budget, limits: f.testBudget }),
    /BUDGET_LOCKED/);
});

test('a truncated ledger is rejected at open, left untouched and not locked', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await budget.close();
  const ledgerPath = join(f.budget, 'budget-ledger.json');
  const text = await readFile(ledgerPath, 'utf8');
  const truncated = text.slice(0, Math.floor(text.length / 2));
  await writeFile(ledgerPath, truncated);
  await assert.rejects(openBudget({ run, binding: f.binding, root: f.budget, limits: f.testBudget }),
    /INVALID_LEDGER/);
  assert.equal(await readFile(ledgerPath, 'utf8'), truncated);
  assert.equal((await readdir(f.budget)).includes('.budget.lock'), false);
});

test('a stale batch lock is not auto-removed', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const lockPath = join(f.budget, '.budget.lock');
  await writeFile(lockPath, `${JSON.stringify({ ownerId: 'dead-owner', pid: 999999 })}\n`);
  await assert.rejects(openBudget({ run, binding: f.binding, root: f.budget, limits: f.testBudget }),
    /BUDGET_LOCKED/);
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).ownerId, 'dead-owner');
});

test('close never removes another owner lock', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudget({ run, binding: f.binding, root: f.budget, limits: f.testBudget });
  const lockPath = join(f.budget, '.budget.lock');
  await rm(lockPath);
  await writeFile(lockPath, `${JSON.stringify({ ownerId: 'replacement' })}\n`);
  await assert.rejects(budget.close(), /BUDGET_LOCK_LOST/);
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).ownerId, 'replacement');
});

test('lock loss blocks a write and retains the replacement lock', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudget({ run, binding: f.binding, root: f.budget, limits: f.testBudget });
  const lockPath = join(f.budget, '.budget.lock');
  await rm(lockPath);
  await writeFile(lockPath, `${JSON.stringify({ ownerId: 'replacement' })}\n`);
  await assert.rejects(budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 }),
    /BUDGET_PERSIST_FAILED/);
  assert.equal(budget.snapshot().attemptsReserved, 0);
  await budget.close();
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).ownerId, 'replacement');
  const ledger = JSON.parse(await readFile(join(f.budget, 'budget-ledger.json'), 'utf8'));
  assert.equal(ledger.attempts.length, 0);
  assert.equal(ledger.revision, 0);
});

test('a linked ledger file is refused without touching its target', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const source = join(f.outside, 'sentinel.txt');
  const before = await readFile(source, 'utf8');
  await symlink(source, join(f.budget, 'budget-ledger.json'));
  await assert.rejects(openBudget({ run, binding: f.binding, root: f.budget, limits: f.testBudget }),
    /INVALID_LEDGER_FILE/);
  assert.equal(await readFile(source, 'utf8'), before);
  assert.equal((await readdir(f.budget)).includes('.budget.lock'), false);
});

test('invalid limits are rejected before any ledger or lock is created', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  await assert.rejects(openBudget({ run, binding: f.binding, root: f.budget,
    limits: { ...f.testBudget, maxAttempts: 0 } }), /INVALID_LIMITS/);
  await assert.rejects(openBudget({ run, binding: f.binding, root: f.budget,
    limits: { ...f.testBudget, maxRequestBytes: 1.5 } }), /INVALID_LIMITS/);
  await assert.rejects(openBudget({ run, binding: f.binding, root: f.budget,
    limits: { ...f.testBudget, extra: 1 } }), /INVALID_LIMITS/);
  const missing = { ...f.testBudget };
  delete missing.maxOutputTokensPerAttempt;
  await assert.rejects(openBudget({ run, binding: f.binding, root: f.budget, limits: missing }),
    /INVALID_LIMITS/);
  assert.deepEqual(await readdir(f.budget), []);
});

test('snapshot is frozen, bounded and free of raw payload data', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 3, outputTokens: 4 } });
  const snapshot = budget.snapshot();
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.limits));
  assert.ok(Object.isFrozen(snapshot.attempts));
  assert.ok(Object.isFrozen(snapshot.attempts[0]));
  assert.throws(() => snapshot.attempts.push({ attemptId: 'fake' }));
  const keys = Object.keys(snapshot.attempts[0]);
  assert.equal(keys.some(key => ['rows', 'content', 'body', 'prompt', 'messages'].includes(key)), false);
  assert.equal(snapshot.attempts[0].attemptId, 'a1');
});

test('local chain: reserve, bounded read, compute, report and settle stay consistent', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const io = f.track(await openFiles({ run, binding: f.binding, inputRoot: f.inputs,
    skillRoot: f.skill, outputRoot: f.outputs, files: f.inputFiles,
    limits: { maxInputBytes: 4096, maxReportBytes: 4096 } }));
  const budget = await openBudgetOn(f, run);
  await budget.reserve({ attemptId: 'a1', requestBytes: 64, maxOutputTokens: 20 });
  const csv = await io.read({ fileId: 'metrics', offset: 0, limit: 4096 });
  const table = parseCsv(csv.content, { maxBytes: 4096, maxRows: 20, maxColumns: 8, maxCellChars: 128 });
  const result = compute({ operation: 'weighted_mean', tableId: 'metrics', column: 'value',
    weightColumn: 'weight', filters: [] },
    new Map([['metrics', { ...table, sha256: csv.sha256 }]]), { maxOperations: 1, maxFilters: 4 });
  assert.equal(result.value, 20);
  const written = await io.writeReport({ content: `mean=${result.value}\n` });
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 12, outputTokens: 3 } });
  const snapshot = budget.snapshot();
  assert.equal(snapshot.attemptsSettled, 1);
  assert.equal(snapshot.observedTokenTotal, 15);
  assert.equal(run.snapshot().status, 'running');
  assert.equal(typeof written.sha256, 'string');
  assert.equal(written.bytes, Buffer.byteLength('mean=20\n'));
});

test('ledger counters that disagree with the attempt list are rejected at open', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await budget.close();
  const ledgerPath = join(f.budget, 'budget-ledger.json');
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  ledger.attemptsSettled = 1;
  await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`);
  await assert.rejects(openBudget({ run, binding: f.binding, root: f.budget, limits: f.testBudget }),
    /INVALID_LEDGER/);
});

test('a tampered amendment record is rejected at open', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await budget.close();
  const amended = await openBudgetOn(f, run, { limits: limitsWith({ maxAttempts: 3 }),
    amendment: { reference: 'approval-2026-09-25-03' } });
  assert.equal(amended.snapshot().amendments.length, 1);
  await amended.close();
  const ledgerPath = join(f.budget, 'budget-ledger.json');
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  ledger.amendments[0].reference = ' ';
  await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`);
  await assert.rejects(openBudget({ run, binding: f.binding, root: f.budget, limits: f.testBudget }),
    /INVALID_LEDGER/);
});

test('settle argument shape errors reject without touching the ledger', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await assert.rejects(budget.settle({ attemptId: 'a1' }), /INVALID_USAGE/);
  await assert.rejects(budget.settle({ attemptId: 'a1',
    usage: { inputTokens: 1, outputTokens: 1 }, extra: true }), /INVALID_USAGE/);
  const snapshot = budget.snapshot();
  assert.equal(snapshot.attempts[0].status, 'reserved');
  assert.equal(snapshot.attemptsUnknown, 0);
  assert.equal(snapshot.observedTokenTotal, 0);
});

test('another run in the same batch cannot settle or mark this run attempt', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await budget.close();
  const candidateRoot = join(f.root, 'trusted-owner');
  await mkdir(candidateRoot);
  const candidate = candidateBinding(f);
  const candidateRun = await openStartedRun(f, candidateRoot, candidate);
  const other = await openBudgetOn(f, candidateRun, { binding: candidate });
  await assert.rejects(other.settle({ attemptId: 'a1', usage: { inputTokens: 1, outputTokens: 1 } }),
    /ATTEMPT_NOT_OWNED/);
  await assert.rejects(other.markUnknown({ attemptId: 'a1', reason: 'not_mine' }), /ATTEMPT_NOT_OWNED/);
  assert.equal(other.snapshot().attempts[0].status, 'reserved');
  await other.close();
  const owner = await openBudgetOn(f, run);
  await owner.settle({ attemptId: 'a1', usage: { inputTokens: 1, outputTokens: 1 } });
  assert.equal(owner.snapshot().attemptsSettled, 1);
});

test('an expired in-flight attempt becomes unknown and blocks new attempts', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  let time = 1000;
  const budget = await openBudgetOn(f, run, { now: () => time });
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  time = 1100;
  await assert.rejects(budget.reserve({ attemptId: 'a2', requestBytes: 10, maxOutputTokens: 5 }),
    /UNRESOLVED_USAGE/);
  const snapshot = budget.snapshot();
  assert.equal(snapshot.attempts[0].status, 'unknown');
  assert.equal(snapshot.attempts[0].reason, 'attempt_timeout');
  assert.equal(snapshot.attemptsUnknown, 1);
  await budget.settle({ attemptId: 'a1', usage: { inputTokens: 2, outputTokens: 3 } });
  await budget.reserve({ attemptId: 'a2', requestBytes: 10, maxOutputTokens: 5 });
  assert.equal(budget.snapshot().attemptsReserved, 2);
});

test('a changed environment digest requires an amendment', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await budget.reserve({ attemptId: 'a1', requestBytes: 10, maxOutputTokens: 5 });
  await budget.close();
  const candidateRoot = join(f.root, 'trusted-environment');
  await mkdir(candidateRoot);
  const nextEnvironment = candidateBinding(f,
    { runId: 'run-candidate-003', environmentDigest: 'f'.repeat(64) });
  const nextRun = await openStartedRun(f, candidateRoot, nextEnvironment);
  await assert.rejects(openBudget({ run: nextRun, binding: nextEnvironment, root: f.budget,
    limits: f.testBudget }), /BUDGET_REVISION_REQUIRED/);
  const amended = await openBudgetOn(f, nextRun, { binding: nextEnvironment,
    amendment: { reference: 'approval-2026-09-25-04' } });
  const snapshot = amended.snapshot();
  assert.equal(snapshot.environmentDigest, 'f'.repeat(64));
  assert.equal(snapshot.attemptsReserved, 1);
  assert.equal(snapshot.amendments[0].previousEnvironmentDigest, f.binding.environmentDigest);
  assert.equal(snapshot.amendments[0].nextEnvironmentDigest, 'f'.repeat(64));
});

test('stale ledger temp files are swept under the batch lock', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  await writeFile(join(f.budget, '.budget-ledger-dead.tmp'), '{}\n');
  await writeFile(join(f.budget, 'keep.tmp'), 'not a ledger temp\n');
  const budget = await openBudgetOn(f, run);
  const names = await readdir(f.budget);
  assert.equal(names.includes('.budget-ledger-dead.tmp'), false);
  assert.equal(names.includes('keep.tmp'), true);
  assert.equal(budget.snapshot().attemptsReserved, 0);
});

test('a tampered amendment chain is rejected at open', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await budget.close();
  const amended = await openBudgetOn(f, run, { limits: limitsWith({ maxAttempts: 3 }),
    amendment: { reference: 'approval-2026-09-25-05' } });
  await amended.close();
  const ledgerPath = join(f.budget, 'budget-ledger.json');
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  ledger.amendments[0].nextConfigDigest = 'a'.repeat(64);
  await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`);
  await assert.rejects(openBudget({ run, binding: f.binding, root: f.budget, limits: f.testBudget }),
    /INVALID_LEDGER/);
});

test('a broken link between two amendments is rejected at open', async (t) => {
  const f = await makeTempCase(t);
  const run = await openStartedRun(f, f.trusted);
  const budget = await openBudgetOn(f, run);
  await budget.close();
  const first = await openBudgetOn(f, run, { limits: limitsWith({ maxAttempts: 3 }),
    amendment: { reference: 'approval-2026-09-25-06' } });
  await first.close();
  const candidateRoot = join(f.root, 'trusted-chain');
  await mkdir(candidateRoot);
  const nextPolicy = candidateBinding(f, { runId: 'run-candidate-004', policyDigest: 'd'.repeat(64) });
  const nextRun = await openStartedRun(f, candidateRoot, nextPolicy);
  const second = await openBudgetOn(f, nextRun, { binding: nextPolicy,
    amendment: { reference: 'approval-2026-09-25-07' } });
  assert.equal(second.snapshot().amendments.length, 2);
  await second.close();
  const ledgerPath = join(f.budget, 'budget-ledger.json');
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  ledger.amendments[1].previousConfigDigest = 'a'.repeat(64);
  await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`);
  await assert.rejects(openBudget({ run: nextRun, binding: nextPolicy, root: f.budget,
    limits: f.testBudget }), /INVALID_LEDGER/);
});
