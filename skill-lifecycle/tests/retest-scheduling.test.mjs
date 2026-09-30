import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dueForRetest } from '../control/retest-scheduling.mjs';

const DAY = 86400000;
const NOW = 1800000000000;
const digest = 'a'.repeat(64);

function head(overrides = {}) {
  return { skillId: 'validate-data', version: 'original-1e424822', disposition: 'retain',
    dispositionId: digest, decidedAt: NOW - 10 * DAY, ...overrides };
}

function drift(overrides = {}) {
  return { skillId: 'validate-data', version: 'original-1e424822', reason: '输入材料模板改版',
    observedAt: NOW - 2 * DAY, ...overrides };
}

test('the three states are told apart in one pass', () => {
  const report = dueForRetest({ heads: [
    head({ skillId: 'fresh-skill', version: 'v1', decidedAt: NOW - 3 * DAY }),
    head({ skillId: 'stale-skill', version: 'v2', decidedAt: NOW - 40 * DAY }),
    head({ skillId: 'drifted-skill', version: 'v3', decidedAt: NOW - 5 * DAY }),
  ], now: NOW, maxAgeDays: 30, observedDrift: [
    drift({ skillId: 'drifted-skill', version: 'v3' }),
  ] });
  assert.equal(report.asOf, NOW);
  assert.equal(report.maxAgeDays, 30);
  assert.deepEqual(report.due.map(entry => [entry.skillId, entry.reasons]), [
    ['drifted-skill', ['DEPENDENCY_CHANGED']],
    ['stale-skill', ['AGE_EXCEEDED']],
  ]);
  assert.equal(report.due[1].ageDays, 40);
  assert.deepEqual(report.due[0].drift, [{ reason: '输入材料模板改版', observedAt: NOW - 2 * DAY }]);
  assert.deepEqual(report.notDue.map(entry => entry.skillId), ['fresh-skill']);
  assert.equal(report.notDue[0].ageDays, 3);
  assert.match(report.headsDigest, /^[a-f0-9]{64}$/);
});

test('the age boundary is inclusive: exactly maxAgeDays is still current', () => {
  const exact = dueForRetest({ heads: [head({ decidedAt: NOW - 30 * DAY })], now: NOW, maxAgeDays: 30 });
  assert.deepEqual(exact.due, []);
  assert.equal(exact.notDue[0].ageDays, 30);
  const past = dueForRetest({ heads: [head({ decidedAt: NOW - 30 * DAY - 1 })], now: NOW, maxAgeDays: 30 });
  assert.deepEqual(past.due.map(entry => entry.reasons), [['AGE_EXCEEDED']]);
});

test('a drift only counts when it happened after the decision', () => {
  const before = dueForRetest({ heads: [head({ decidedAt: NOW - 5 * DAY })], now: NOW, maxAgeDays: 30,
    observedDrift: [drift({ observedAt: NOW - 6 * DAY })] });
  assert.deepEqual(before.due, [], 'a drift the decision already accounted for is not news');
  const same = dueForRetest({ heads: [head({ decidedAt: NOW - 5 * DAY })], now: NOW, maxAgeDays: 30,
    observedDrift: [drift({ observedAt: NOW - 5 * DAY })] });
  assert.deepEqual(same.due, [], 'the same millisecond is not strictly after the decision');
  const after = dueForRetest({ heads: [head({ decidedAt: NOW - 5 * DAY })], now: NOW, maxAgeDays: 30,
    observedDrift: [drift({ observedAt: NOW - 5 * DAY + 1 })] });
  assert.deepEqual(after.due.map(entry => entry.reasons), [['DEPENDENCY_CHANGED']]);
});

test('versions that are no longer in use are not scheduled', () => {
  const report = dueForRetest({ heads: [
    head({ version: 'v1', disposition: 'retire', decidedAt: NOW - 400 * DAY }),
    head({ version: 'v2', disposition: 'merge', decidedAt: NOW - 400 * DAY }),
    head({ version: 'v3', disposition: 'rollback', decidedAt: NOW - 400 * DAY }),
    head({ version: 'v4', disposition: 'promote', decidedAt: NOW - 400 * DAY }),
  ], now: NOW, maxAgeDays: 30, observedDrift: [drift({ version: 'v1' })] });
  assert.deepEqual(report.due.map(entry => entry.version), ['v4']);
  assert.deepEqual(report.excluded.map(entry => [entry.version, entry.disposition]), [
    ['v1', 'retire'], ['v2', 'merge'], ['v3', 'rollback'],
  ]);
  assert.deepEqual(report.excluded.find(entry => entry.version === 'v1').reason, 'NOT_IN_USE');
  assert.deepEqual(report.excluded.find(entry => entry.version === 'v1').drift,
    [{ reason: '输入材料模板改版', observedAt: NOW - 2 * DAY }],
    'drift on an excluded version stays visible instead of being dropped');
  assert.deepEqual(report.unmatched, [], 'drift on a retired version is not dragged back in');
});

test('each version of a skill is judged on its own', () => {
  const report = dueForRetest({ heads: [
    head({ version: 'v1', decidedAt: NOW - 90 * DAY }),
    head({ version: 'v2', decidedAt: NOW - 1 * DAY }),
  ], now: NOW, maxAgeDays: 30 });
  assert.deepEqual(report.due.map(entry => entry.version), ['v1']);
  assert.deepEqual(report.notDue.map(entry => entry.version), ['v2']);
});

test('a drift fact that matches no recorded version is surfaced, not dropped', () => {
  const report = dueForRetest({ heads: [head()], now: NOW, maxAgeDays: 30,
    observedDrift: [drift({ skillId: 'never-decided', version: 'v9' })] });
  assert.deepEqual(report.unmatched, [{ skillId: 'never-decided', version: 'v9',
    reason: '输入材料模板改版', observedAt: NOW - 2 * DAY }]);
  assert.deepEqual(report.due, []);
});

test('inputs are validated before any scheduling', () => {
  assert.throws(() => dueForRetest({ heads: [], now: NOW, maxAgeDays: 0 }), /INVALID_MAX_AGE/);
  assert.throws(() => dueForRetest({ heads: [], now: NOW, maxAgeDays: Number.NaN }), /INVALID_MAX_AGE/);
  assert.throws(() => dueForRetest({ heads: [], now: 1.5, maxAgeDays: 30 }), /INVALID_NOW/);
  assert.throws(() => dueForRetest({ heads: 'nope', now: NOW, maxAgeDays: 30 }), /INVALID_HEADS/);
  assert.throws(() => dueForRetest({ heads: [head({ disposition: 'promoted' })], now: NOW, maxAgeDays: 30 }),
    /INVALID_HEADS/);
  assert.throws(() => dueForRetest({ heads: [head({ decidedAt: 'yesterday' })], now: NOW, maxAgeDays: 30 }),
    /INVALID_HEADS/);
  assert.throws(() => dueForRetest({ heads: [{ ...head(), extra: 1 }], now: NOW, maxAgeDays: 30 }),
    /INVALID_HEADS/);
  assert.throws(() => dueForRetest({ heads: [head()], now: NOW, maxAgeDays: 30,
    observedDrift: [{ skillId: 'validate-data', version: 'original-1e424822', reason: '', observedAt: NOW }] }),
    /INVALID_DRIFT/);
  assert.throws(() => dueForRetest({ heads: [head()], now: NOW, maxAgeDays: 30,
    observedDrift: [{ skillId: 'validate-data', version: 'original-1e424822', reason: 'x', observedAt: 'now' }] }),
    /INVALID_DRIFT/);
  assert.throws(() => dueForRetest({ heads: [head()], now: NOW, maxAgeDays: 30, observedDrift: {} }),
    /INVALID_DRIFT/);
});

test('the scheduler accepts what the ledger actually reports', async (t) => {
  const { openGovernanceLedger } = await import('../control/governance-ledger.mjs');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'retest-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  const ledgerRoot = await mkdtemp(join(await realpath(tmpdir()), 'retest-'));
  t.after(() => rm(ledgerRoot, { recursive: true, force: true }).catch(() => {}));
  const ledger = await openGovernanceLedger({ root, now: () => NOW - 40 * DAY });
  await ledger.append({ skillId: 'validate-data', version: 'original-1e424822', disposition: 'retain',
    evidenceRefs: ['31-P1批A实测与判定.md#7'], sourceDigests: [digest], previous: null });
  const heads = (await ledger.verify()).heads;
  const report = dueForRetest({ heads, now: NOW, maxAgeDays: 30 });
  assert.deepEqual(report.due.map(entry => [entry.skillId, entry.version, entry.reasons]),
    [['validate-data', 'original-1e424822', ['AGE_EXCEEDED']]]);
  const fresh = await openGovernanceLedger({ root: await mkdtemp(join(await realpath(tmpdir()), 'retest-')),
    now: () => NOW });
  await fresh.append({ skillId: 'validate-data', version: 'original-1e424822', disposition: 'retain',
    evidenceRefs: ['31-P1批A实测与判定.md#7'], sourceDigests: [digest], previous: null });
  assert.deepEqual(dueForRetest({ heads: (await fresh.verify()).heads, now: NOW, maxAgeDays: 30 }).due, []);
});
