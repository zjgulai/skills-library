import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planMerge, planRetire } from '../control/change-plans.mjs';

const digest = label => createHash('sha256').update(label, 'utf8').digest('hex');
const NOW = 1800000000000;

const heads = [
  { skillId: 'validate-data', version: 'original-1e424822', disposition: 'retain',
    dispositionId: digest('validate-data-head'), decidedAt: NOW - 3 * 86400000 },
  { skillId: 'checker-lite', version: 'draft-001', disposition: 'promote',
    dispositionId: digest('checker-lite-head'), decidedAt: NOW - 86400000 },
  { skillId: 'legacy-audit', version: 'v1', disposition: 'retire',
    dispositionId: digest('legacy-audit-head'), decidedAt: NOW - 30 * 86400000 },
];

function retireInput(overrides = {}) {
  return { heads, skillId: 'validate-data', version: 'original-1e424822',
    replacement: { skillId: 'checker-lite', version: 'draft-001' },
    reason: '核验能力已由 checker-lite 覆盖',
    evidenceRefs: ['31-P1批A实测与判定.md#7'], now: NOW, ...overrides };
}

test('a retire plan names its successor and stays a proposal', () => {
  const plan = planRetire(retireInput());
  assert.equal(plan.planType, 'retire');
  assert.match(plan.planId, /^[a-f0-9]{64}$/);
  assert.deepEqual(plan.target, { skillId: 'validate-data', version: 'original-1e424822' });
  assert.deepEqual(plan.replacement, { kind: 'successor', skillId: 'checker-lite', version: 'draft-001' });
  assert.deepEqual(plan.ledger, { known: true, disposition: 'retain',
    dispositionId: digest('validate-data-head') });
  assert.equal(plan.execution.channel, 'enablement');
  assert.equal(plan.execution.automatic, false, 'a plan never executes itself');
  assert.equal(plan.plannedAt, NOW);
  assert.equal(Object.isFrozen(plan), true);
});

test('a retire without a replacement, or an unexplained drop, is refused', () => {
  const { replacement, ...withoutReplacement } = retireInput();
  assert.throws(() => planRetire(withoutReplacement), /REPLACEMENT_REQUIRED/);
  assert.throws(() => planRetire(retireInput({ replacement: { skillId: '', version: 'x' } })),
    /REPLACEMENT_REQUIRED/);
  assert.throws(() => planRetire(retireInput({ replacement: { drop: true } })), /REPLACEMENT_REQUIRED/,
    'dropping a capability must be stated, not implied');
  const dropped = planRetire(retireInput({ replacement: { drop: true, reason: '团队不再需要核验环节' } }));
  assert.deepEqual(dropped.replacement, { kind: 'drop', reason: '团队不再需要核验环节' });
  assert.throws(() => planRetire(retireInput({ replacement: { drop: true, reason: '  ' } })),
    /REPLACEMENT_REQUIRED/);
});

test('a version that is already out of use cannot be retired again', () => {
  assert.throws(() => planRetire(retireInput({ skillId: 'legacy-audit', version: 'v1' })),
    /ALREADY_OUT_OF_USE/);
  const unknown = planRetire(retireInput({ skillId: 'never-decided', version: 'v9' }));
  assert.deepEqual(unknown.ledger, { known: false, disposition: null, dispositionId: null },
    'an unrecorded version is flagged, not silently treated as verified');
  assert.deepEqual(unknown.target, { skillId: 'never-decided', version: 'v9' });
});

test('the successor must itself be in use', () => {
  assert.throws(() => planRetire(retireInput({ replacement: { skillId: 'unknown-skill', version: 'v1' } })),
    /REPLACEMENT_NOT_IN_USE/);
  assert.throws(() => planRetire(retireInput({ replacement: { skillId: 'legacy-audit', version: 'v1' } })),
    /REPLACEMENT_NOT_IN_USE/);
});

test('a merge plan carries both directions of the reference', () => {
  const plan = planMerge({ heads, source: { skillId: 'checker-lite', version: 'draft-001' },
    target: { skillId: 'validate-data', version: 'original-1e424822' },
    reason: '两份技能职责重叠', evidenceRefs: ['35-P2-1需求接收与契约草稿记录.md'], now: NOW });
  assert.equal(plan.planType, 'merge');
  assert.deepEqual(plan.references.sourceToTarget, { from: { skillId: 'checker-lite', version: 'draft-001' },
    mergedInto: { skillId: 'validate-data', version: 'original-1e424822' } });
  assert.deepEqual(plan.references.targetToSource, { into: { skillId: 'validate-data', version: 'original-1e424822' },
    absorbs: [{ skillId: 'checker-lite', version: 'draft-001' }] });
  assert.deepEqual(plan.ledger.source, { known: true, disposition: 'promote',
    dispositionId: digest('checker-lite-head') });
  assert.deepEqual(plan.ledger.target.disposition, 'retain');
  assert.equal(plan.execution.automatic, false);
});

test('a merge into an unverified target, or into itself, is refused', () => {
  const merge = overrides => ({ heads, source: { skillId: 'checker-lite', version: 'draft-001' },
    target: { skillId: 'validate-data', version: 'original-1e424822' }, reason: 'x',
    evidenceRefs: ['a.md'], now: NOW, ...overrides });
  assert.throws(() => planMerge(merge({ target: { skillId: 'never-decided', version: 'v9' } })),
    /TARGET_NOT_IN_USE/);
  assert.throws(() => planMerge(merge({ target: { skillId: 'legacy-audit', version: 'v1' } })),
    /TARGET_NOT_IN_USE/);
  assert.throws(() => planMerge(merge({ target: { skillId: 'checker-lite', version: 'draft-001' } })),
    /MERGE_INTO_SELF/);
  assert.throws(() => planMerge(merge({ source: { skillId: 'legacy-audit', version: 'v1' } })),
    /ALREADY_OUT_OF_USE/);
});

test('dependents without a migration note are refused', () => {
  const dependents = [{ skillId: 'w03-终测集', evidenceRef: '32-w03终测集铸造记录.md' }];
  assert.throws(() => planRetire(retireInput({ dependents })), /MIGRATION_REQUIRED/,
    'whoever still uses it needs an answer, not a shrug');
  assert.throws(() => planMerge({ heads, source: { skillId: 'checker-lite', version: 'draft-001' },
    target: { skillId: 'validate-data', version: 'original-1e424822' }, reason: 'x',
    evidenceRefs: ['a.md'], dependents, now: NOW }), /MIGRATION_REQUIRED/);
  const planned = planRetire(retireInput({ dependents,
    migration: { note: '终测集切换到 checker-lite 的题面', evidenceRef: '34-P2P4工程化计划.md' } }));
  assert.deepEqual(planned.impact.dependents, dependents);
  assert.equal(planned.impact.migration.note, '终测集切换到 checker-lite 的题面');
});

test('inputs are validated before any plan is produced', () => {
  assert.throws(() => planRetire(retireInput({ heads: [{ skillId: 'x' }] })), /INVALID_HEADS/);
  assert.throws(() => planRetire(retireInput({ reason: '   ' })), /INVALID_REASON/);
  assert.throws(() => planRetire(retireInput({ evidenceRefs: [] })), /INVALID_EVIDENCE/);
  assert.throws(() => planRetire(retireInput({ evidenceRefs: ['x'.repeat(501)] })), /INVALID_EVIDENCE/);
  assert.throws(() => planRetire(retireInput({ evidenceRefs: ['a', 7] })), /INVALID_EVIDENCE/);
  assert.throws(() => planRetire(retireInput({ dependents: 'nobody' })), /INVALID_DEPENDENTS/);
  assert.throws(() => planRetire(retireInput({ dependents: [{ skillId: 'x' }] })), /INVALID_DEPENDENTS/);
  assert.throws(() => planRetire(retireInput({ now: 1.5 })), /INVALID_NOW/);
  assert.throws(() => planRetire(retireInput({ extra: true })), /INVALID_INPUT/);
});

test('planning writes nothing: the ledger and the tree are untouched', async (t) => {
  const { openGovernanceLedger } = await import('../control/governance-ledger.mjs');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'plans-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  const ledger = await openGovernanceLedger({ root, now: () => NOW - 3 * 86400000 });
  await ledger.append({ skillId: 'validate-data', version: 'original-1e424822', disposition: 'retain',
    evidenceRefs: ['31-P1批A实测与判定.md#7'], sourceDigests: [digest('validate-data')], previous: null });
  const before = await readFile(ledger.path, 'utf8');
  const treeBefore = (await readdir(root, { recursive: true })).sort();
  const planned = planRetire(retireInput({ replacement: { drop: true, reason: '不再需要' } }));
  assert.equal(planned.planType, 'retire');
  assert.equal(await readFile(ledger.path, 'utf8'), before, 'the ledger must not change');
  assert.deepEqual((await readdir(root, { recursive: true })).sort(), treeBefore,
    'planning must not create files');
});
