import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcilePlan } from '../control/plan-reconcile.mjs';

const digest = label => createHash('sha256').update(label, 'utf8').digest('hex');
const NOW = 1800000000000;
const PLAN_ID = digest('plan');

function retirePlan(overrides = {}) {
  return { planType: 'retire', planId: PLAN_ID, plannedAt: NOW,
    target: { skillId: 'validate-data', version: 'original-1e424822' }, ...overrides };
}

function record(overrides = {}) {
  return { dispositionId: digest('record'), disposition: 'retire', decidedAt: NOW + 1000,
    skillId: 'validate-data', version: 'original-1e424822',
    evidenceRefs: [PLAN_ID], ...overrides };
}

test('a plan nobody recorded stays pending — including a look-alike record', () => {
  assert.deepEqual(reconcilePlan({ plan: retirePlan(), history: [] }).status, 'pending');
  const lookAlike = reconcilePlan({ plan: retirePlan(),
    history: [record({ evidenceRefs: ['31-P1批A实测与判定.md#7'] })] });
  assert.equal(lookAlike.status, 'pending',
    'a record with the right disposition but no citation is not this plan being executed');
  assert.equal(lookAlike.record, null);
});

test('a citing record with the matching disposition and a later date records the plan', () => {
  const report = reconcilePlan({ plan: retirePlan(), history: [record()] });
  assert.equal(report.status, 'recorded');
  assert.equal(report.expectedDisposition, 'retire');
  assert.deepEqual(report.identity, { skillId: 'validate-data', version: 'original-1e424822' });
  assert.equal(report.record.dispositionId, digest('record'));
  assert.equal(report.citations, 1);
});

test('a citing record that decided something else is a mismatch, not a match', () => {
  const report = reconcilePlan({ plan: retirePlan(), history: [record({ disposition: 'retain' })] });
  assert.equal(report.status, 'mismatched');
  assert.deepEqual(report.reasons, ['DISPOSITION_MISMATCH']);
  assert.equal(report.record, null);
});

test('a citation that predates the plan cannot be its execution', () => {
  const report = reconcilePlan({ plan: retirePlan(), history: [record({ decidedAt: NOW - 1 })] });
  assert.equal(report.status, 'mismatched');
  assert.deepEqual(report.reasons, ['RECORD_PREDATES_PLAN']);
});

test('an inconsistent citation does not poison a consistent one', () => {
  const report = reconcilePlan({ plan: retirePlan(), history: [
    record({ dispositionId: digest('r1'), disposition: 'retain' }),
    record({ dispositionId: digest('r2') }),
  ] });
  assert.equal(report.status, 'recorded');
  assert.equal(report.record.dispositionId, digest('r2'));
  assert.equal(report.citations, 2);
});

test('a merge plan is reconciled against its source identity', () => {
  const plan = { planType: 'merge', planId: digest('merge-plan'), plannedAt: NOW,
    source: { skillId: 'checker-lite', version: 'draft-001' },
    target: { skillId: 'validate-data', version: 'original-1e424822' } };
  const report = reconcilePlan({ plan, history: [
    { dispositionId: digest('m1'), disposition: 'merge', decidedAt: NOW + 5,
      skillId: 'checker-lite', version: 'draft-001', evidenceRefs: [digest('merge-plan')] }] });
  assert.equal(report.status, 'recorded');
  assert.deepEqual(report.identity, { skillId: 'checker-lite', version: 'draft-001' });
  assert.equal(report.expectedDisposition, 'merge');
});

test('inputs are validated before any reconciliation', () => {
  assert.throws(() => reconcilePlan({ plan: retirePlan({ planId: 'abc' }), history: [] }), /INVALID_PLAN/);
  assert.throws(() => reconcilePlan({ plan: retirePlan({ planType: 'promote' }), history: [] }),
    /INVALID_PLAN/);
  assert.throws(() => reconcilePlan({ plan: { ...retirePlan(), target: undefined }, history: [] }),
    /INVALID_PLAN/);
  assert.throws(() => reconcilePlan({ plan: retirePlan({ plannedAt: 'now' }), history: [] }), /INVALID_PLAN/);
  assert.throws(() => reconcilePlan({ plan: retirePlan(), history: 'none' }), /INVALID_HISTORY/);
  assert.throws(() => reconcilePlan({ plan: retirePlan(), history: [{ disposition: 'retire' }] }),
    /INVALID_HISTORY/);
  assert.throws(() => reconcilePlan({ plan: retirePlan(),
    history: [record({ evidenceRefs: 'not-an-array' })] }), /INVALID_HISTORY/);
});

test('the convention round-trips with the planner and the ledger', async (t) => {
  const { planRetire } = await import('../control/change-plans.mjs');
  const { openGovernanceLedger } = await import('../control/governance-ledger.mjs');
  const heads = [{ skillId: 'validate-data', version: 'original-1e424822', disposition: 'retain',
    dispositionId: digest('head'), decidedAt: NOW - 3 * 86400000 }];
  const plan = planRetire({ heads, skillId: 'validate-data', version: 'original-1e424822',
    replacement: { drop: true, reason: '不再需要核验环节' }, reason: '团队决定下线',
    evidenceRefs: ['45-P0P4总盘点.md'], now: NOW });
  const root = await mkdtemp(join(await realpath(tmpdir()), 'reconcile-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  const ledger = await openGovernanceLedger({ root, now: () => NOW - 3 * 86400000 });
  const first = await ledger.append({ skillId: 'validate-data', version: 'original-1e424822',
    disposition: 'retain', evidenceRefs: ['31-P1批A实测与判定.md#7'], sourceDigests: [digest('v')],
    previous: null });
  const history = await ledger.historyFor({ skillId: 'validate-data', version: 'original-1e424822' });
  assert.equal(reconcilePlan({ plan, history }).status, 'pending',
    'the original decision predates the plan and does not cite it');
  await ledger.append({ skillId: 'validate-data', version: 'original-1e424822', disposition: 'retire',
    evidenceRefs: [`plan:${plan.planId}`, '45-P0P4总盘点.md'], sourceDigests: [digest('v')],
    previous: first.dispositionId, decidedAt: NOW + 60000 });
  const after = await ledger.historyFor({ skillId: 'validate-data', version: 'original-1e424822' });
  const report = reconcilePlan({ plan, history: after });
  assert.equal(report.status, 'pending', 'citations are exact: a prefixed string is not the planId');
  await ledger.append({ skillId: 'validate-data', version: 'original-1e424822', disposition: 'retire',
    evidenceRefs: [plan.planId, '45-P0P4总盘点.md'], sourceDigests: [digest('v')],
    previous: (await ledger.historyFor({ skillId: 'validate-data', version: 'original-1e424822' })).at(-1).dispositionId,
    decidedAt: NOW + 120000 });
  const final = reconcilePlan({ plan,
    history: await ledger.historyFor({ skillId: 'validate-data', version: 'original-1e424822' }) });
  assert.equal(final.status, 'recorded');
  assert.equal(final.record.disposition, 'retire');
});
