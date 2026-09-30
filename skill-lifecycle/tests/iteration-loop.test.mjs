import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeRound, collectObservations, recordRound } from '../control/iteration-loop.mjs';

const criteria = () => ({
  targetTaskId: 't7-near-neighbor',
  targetHitsRequired: 2,
  targetRepeatsExpected: 3,
  regressionTaskIds: ['t2-recompute', 't6-boundary'],
  costTolerance: { attemptsRatio: 1.5, tokensRatio: 1.5 },
  maxRounds: 3,
});

function observation(overrides = {}) {
  return { arm: 'candidate', taskId: 't7-near-neighbor', repeat: 1, gate: true,
    attempts: 4, tokens: 10000, incomplete: false, reportWritten: true, ...overrides };
}

function round1(overrides = {}) {
  const observations = [
    observation({ arm: 'original', repeat: 1, gate: false, attempts: 6, tokens: 15000 }),
    observation({ arm: 'original', repeat: 2, gate: false, attempts: 5, tokens: 14000 }),
    observation({ arm: 'original', repeat: 3, gate: false, attempts: 3, tokens: 12000 }),
    observation({ arm: 'candidate', repeat: 1, gate: true, attempts: 4, tokens: 11000 }),
    observation({ arm: 'candidate', repeat: 2, gate: true, attempts: 4, tokens: 10500 }),
    observation({ arm: 'candidate', repeat: 3, gate: true, attempts: 6, tokens: 16000 }),
    observation({ arm: 'original', taskId: 't2-recompute', gate: true, attempts: 6, tokens: 27000 }),
    observation({ arm: 'original', taskId: 't6-boundary', gate: true, attempts: 9, tokens: 38000 }),
    observation({ arm: 'candidate', taskId: 't2-recompute', gate: true, attempts: 5, tokens: 25000 }),
    observation({ arm: 'candidate', taskId: 't6-boundary', gate: true, attempts: 7, tokens: 30000 }),
  ];
  return { round: 1, observations, criteria: criteria(), ...overrides };
}

test('a clean round with the main effect met and cost in tolerance is accepted', () => {
  const verdict = judgeRound(round1());
  assert.equal(verdict.kind, 'accept');
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.metrics.targetHits, '3/3');
  assert.equal(verdict.metrics.requiredHits, 2);
  assert.equal(verdict.metrics.costDegraded, false);
  assert.ok(verdict.metrics.attempts.ratio < 1.5);
});

test('an unmet target inside the round budget asks for a revision', () => {
  const verdict = judgeRound(round1({ observations: round1().observations
    .map(item => (item.arm === 'candidate' && item.taskId === 't7-near-neighbor'
      ? { ...item, gate: item.repeat === 1 } : item)) }));
  assert.equal(verdict.kind, 'revise');
  assert.deepEqual(verdict.reasons, ['TARGET_NOT_MET']);
  assert.equal(verdict.metrics.targetHits, '1/3');
});

test('an unmet target with no rounds left is rejected rather than revised', () => {
  const verdict = judgeRound(round1({ round: 3, observations: round1().observations
    .map(item => (item.arm === 'candidate' && item.taskId === 't7-near-neighbor'
      ? { ...item, gate: false } : item)) }));
  assert.equal(verdict.kind, 'reject');
  assert.deepEqual(verdict.reasons, ['TARGET_NOT_MET', 'ROUNDS_EXHAUSTED']);
});

test('a regression on any regression task rejects the candidate', () => {
  const verdict = judgeRound(round1({ observations: round1().observations
    .map(item => (item.arm === 'candidate' && item.taskId === 't6-boundary'
      ? { ...item, gate: false } : item)) }));
  assert.equal(verdict.kind, 'reject');
  assert.deepEqual(verdict.reasons, ['REGRESSION:t6-boundary']);
});

test('the baseline arm failing its own regression gate is an integrity problem, not a win', () => {
  const verdict = judgeRound(round1({ observations: round1().observations
    .map(item => (item.arm === 'original' && item.taskId === 't2-recompute'
      ? { ...item, gate: false } : item)) }));
  assert.equal(verdict.kind, 'inconclusive');
  assert.deepEqual(verdict.reasons, ['BASELINE_REGRESSION:t2-recompute']);
});

test('cost degradation blocks acceptance and asks for a revision', () => {
  const verdict = judgeRound(round1({ observations: round1().observations
    .map(item => (item.arm === 'candidate' ? { ...item, attempts: item.attempts * 3, tokens: item.tokens * 3 } : item)) }));
  assert.equal(verdict.kind, 'revise');
  assert.deepEqual(verdict.reasons, ['COST_DEGRADED']);
  assert.equal(verdict.metrics.costDegraded, true);
  assert.ok(verdict.metrics.attempts.ratio > 1.5);
});

test('cost degradation with no rounds left is rejected', () => {
  const verdict = judgeRound(round1({ round: 3, observations: round1().observations
    .map(item => (item.arm === 'candidate' ? { ...item, tokens: item.tokens * 4 } : item)) }));
  assert.equal(verdict.kind, 'reject');
  assert.deepEqual(verdict.reasons, ['COST_DEGRADED', 'ROUNDS_EXHAUSTED']);
});

test('missing repeats and incomplete runs are inconclusive, never a pass', () => {
  const missing = judgeRound(round1({ observations: round1().observations
    .filter(item => !(item.arm === 'candidate' && item.taskId === 't7-near-neighbor' && item.repeat === 3)) }));
  assert.equal(missing.kind, 'inconclusive');
  assert.deepEqual(missing.reasons, ['EVIDENCE_INCOMPLETE']);
  const incomplete = judgeRound(round1({ observations: round1().observations
    .map(item => (item.arm === 'candidate' && item.taskId === 't7-near-neighbor' && item.repeat === 2
      ? { ...item, incomplete: true } : item)) }));
  assert.equal(incomplete.kind, 'inconclusive');
  assert.deepEqual(incomplete.reasons, ['EVIDENCE_INCOMPLETE']);
});

test('an exhausted budget stops the loop without pretending it is a quality result', () => {
  const verdict = judgeRound(round1({ budgetExhausted: true }));
  assert.equal(verdict.kind, 'budget_stopped');
  assert.deepEqual(verdict.reasons, ['BUDGET_EXHAUSTED']);
});

test('multi-target criteria score a set of target tasks', () => {
  const observations = [
    observation({ arm: 'original', taskId: 'n1-resummary', gate: false, attempts: 6, tokens: 20000 }),
    observation({ arm: 'candidate', taskId: 'n1-resummary', gate: true, attempts: 5, tokens: 19000 }),
    observation({ arm: 'original', taskId: 'n2-term', gate: false, attempts: 5, tokens: 18000 }),
    observation({ arm: 'candidate', taskId: 'n2-term', gate: true, attempts: 4, tokens: 17000 }),
    observation({ arm: 'original', taskId: 'n3-mixed', gate: false, attempts: 6, tokens: 21000 }),
    observation({ arm: 'candidate', taskId: 'n3-mixed', gate: false, attempts: 6, tokens: 20000 }),
    observation({ arm: 'original', taskId: 'c1-channel', gate: true, attempts: 6, tokens: 22000 }),
    observation({ arm: 'candidate', taskId: 'c1-channel', gate: true, attempts: 6, tokens: 21000 }),
  ];
  const multi = { targetTaskIds: ['n1-resummary', 'n2-term', 'n3-mixed'], targetHitsRequired: 2,
    targetRepeatsExpected: 1, regressionTaskIds: ['c1-channel'],
    costTolerance: { attemptsRatio: 1.5, tokensRatio: 1.5 }, maxRounds: 1 };
  const verdict = judgeRound({ round: 1, observations, criteria: multi });
  assert.equal(verdict.metrics.targetHits, '2/3');
  assert.equal(verdict.kind, 'accept');
  const strict = judgeRound({ round: 1, criteria: { ...multi, targetHitsRequired: 3 }, observations });
  assert.equal(strict.kind, 'reject');
  assert.deepEqual(strict.reasons, ['TARGET_NOT_MET', 'ROUNDS_EXHAUSTED']);
  const half = judgeRound({ round: 1, criteria: multi, observations: observations.slice(2) });
  assert.equal(half.kind, 'inconclusive');
  assert.deepEqual(half.reasons, ['EVIDENCE_INCOMPLETE']);
  assert.throws(() => judgeRound({ round: 1, observations,
    criteria: { ...multi, targetTaskId: 'n1-resummary', targetTaskIds: undefined } }), /INVALID_CRITERIA/);
});

test('the cost tolerance boundary is inclusive', () => {
  const base = round1();
  const originalCost = new Map(base.observations.filter(item => item.arm === 'original')
    .map(item => [`${item.taskId}#${item.repeat}`, item]));
  const observations = base.observations.map(item => {
    if (item.arm !== 'candidate') return item;
    const original = originalCost.get(`${item.taskId}#${item.repeat}`);
    return { ...item, attempts: original.attempts, tokens: original.tokens };
  });
  const exact = judgeRound({ round: 1, observations,
    criteria: { ...criteria(), costTolerance: { attemptsRatio: 1.0, tokensRatio: 1.0 } } });
  assert.equal(exact.metrics.attempts.ratio, 1);
  assert.equal(exact.metrics.tokens.ratio, 1);
  assert.equal(exact.kind, 'accept', 'a ratio exactly at the tolerance must pass');
  const strict = judgeRound({ round: 1, observations,
    criteria: { ...criteria(), costTolerance: { attemptsRatio: 0.99, tokensRatio: 0.99 } } });
  assert.equal(strict.kind, 'revise', 'a ratio just above the tolerance must not pass');
});

test('criteria and observations are validated before any verdict', () => {
  assert.throws(() => judgeRound(round1({ criteria: { ...criteria(), targetHitsRequired: 0 } })), /INVALID_CRITERIA/);
  assert.throws(() => judgeRound(round1({ round: 0 })), /INVALID_ROUND/);
  assert.throws(() => judgeRound(round1({ observations: [...round1().observations, { arm: 'candidate' }] })),
    /INVALID_OBSERVATION/);
});

test('terminal-run records reach the same observations as W2 records', () => {
  const shared = { arm: 'candidate', repeat: 2, incomplete: false,
    attempts: { settled: 5, observed_input_tokens: 21000, observed_output_tokens: 900 },
    report: { written: true, content: '核验报告正文' }, final_text: '回答' };
  const terminalRecord = { record_type: 'terminal_task', ...shared,
    terminal: { setId: 'w03', taskId: 'w-d3-dupamount', expectsReport: true } };
  const w2Record = { record_type: 'w2_ab_task', task_id: 'w-d3-dupamount', ...shared };
  const gateTokens = { 'w-d3-dupamount': ['业务确认'] };
  const fromTerminal = collectObservations([terminalRecord], { gateTokens });
  const fromW2 = collectObservations([w2Record], { gateTokens });
  assert.equal(fromTerminal.length, 1, 'a terminal record must not be dropped');
  assert.deepEqual(fromTerminal, fromW2, 'both carriers must yield the same observation');
  assert.equal(fromTerminal[0].taskId, 'w-d3-dupamount');
  assert.equal(fromTerminal[0].tokens, 21900);
  const hit = collectObservations([{ ...terminalRecord,
    report: { written: true, content: '这里需要业务确认' } }], { gateTokens });
  assert.equal(hit[0].gate, true, 'the gate reads the same text fields for both carriers');
});

test('a recognized record without a task identity fails loudly', () => {
  assert.throws(() => collectObservations([{ record_type: 'terminal_task', arm: 'candidate', repeat: 1 }]),
    /INVALID_RECORD/, 'silently dropping a record is how the blindness went unnoticed');
  assert.throws(() => collectObservations([{ record_type: 'w2_ab_task', arm: 'candidate', repeat: 1 }]),
    /INVALID_RECORD/);
  assert.deepEqual(collectObservations([{ record_type: 'w3_ab_task', arm: 'candidate' }]), [],
    'a record type that is not ours to judge is ignored, not guessed at');
});

test('a target can be stated relative to the baseline arm', () => {
  const withoutAbsolute = ({ targetHitsRequired: _drop, ...rest }) => rest;
  const relative = overrides => ({ ...withoutAbsolute(criteria()), ...overrides });
  const base = round1();
  const equal = judgeRound({ round: 1, observations: base.observations,
    criteria: relative({ targetHitsOverBaseline: 1 }) });
  assert.equal(equal.metrics.baselineHits, 0, 'the baseline target hits are read from the same records');
  assert.equal(equal.metrics.requiredHits, 1);
  assert.equal(equal.metrics.targetHits, '3/3');
  assert.equal(equal.kind, 'accept', 'beating the baseline by 1 is enough');
  const noRoom = judgeRound({ round: 1, observations: base.observations.map(item =>
    (item.arm === 'original' && item.taskId === 't7-near-neighbor' ? { ...item, gate: true } : item)),
  criteria: relative({ targetHitsOverBaseline: 1 }) });
  assert.equal(noRoom.kind, 'revise',
    'a target the baseline already saturates is a real state: no headroom means revise, not a crash');
  assert.equal(noRoom.metrics.baselineHits, 3);
  assert.equal(noRoom.metrics.requiredHits, 4);
  const flat = judgeRound({ round: 1, observations: base.observations,
    criteria: relative({ targetHitsOverBaseline: 0 }) });
  assert.equal(flat.kind, 'accept', 'a minimum delta of 0 is non-inferiority');
  assert.throws(() => judgeRound({ round: 1, observations: base.observations,
    criteria: { ...criteria(), targetHitsOverBaseline: 1 } }), /INVALID_CRITERIA/,
  'stating both an absolute and a relative target is ambiguous');
  assert.throws(() => judgeRound({ round: 1, observations: base.observations,
    criteria: relative({ targetHitsOverBaseline: 1.5 }) }), /INVALID_CRITERIA/);
  assert.throws(() => judgeRound({ round: 1, observations: base.observations,
    criteria: relative({ targetHitsOverBaseline: -1 }) }), /INVALID_CRITERIA/);
  assert.throws(() => judgeRound({ round: 1, observations: base.observations,
    criteria: withoutAbsolute(criteria()) }), /INVALID_CRITERIA/,
  'one of the two target forms must be present');
});

test('a new-skill round compares the candidate against the no-skill baseline', () => {
  const observations = [
    observation({ arm: 'none', repeat: 1, gate: false, attempts: 6, tokens: 15000 }),
    observation({ arm: 'none', repeat: 2, gate: false, attempts: 5, tokens: 14000 }),
    observation({ arm: 'none', repeat: 3, gate: false, attempts: 3, tokens: 12000 }),
    observation({ arm: 'candidate', repeat: 1, gate: true, attempts: 4, tokens: 11000 }),
    observation({ arm: 'candidate', repeat: 2, gate: true, attempts: 4, tokens: 10500 }),
    observation({ arm: 'candidate', repeat: 3, gate: true, attempts: 6, tokens: 16000 }),
    observation({ arm: 'none', taskId: 't2-recompute', gate: true, attempts: 6, tokens: 27000 }),
    observation({ arm: 'none', taskId: 't6-boundary', gate: true, attempts: 9, tokens: 38000 }),
    observation({ arm: 'candidate', taskId: 't2-recompute', gate: true, attempts: 5, tokens: 25000 }),
    observation({ arm: 'candidate', taskId: 't6-boundary', gate: true, attempts: 7, tokens: 30000 }),
  ];
  const verdict = judgeRound({ round: 1, observations, criteria: criteria() });
  assert.equal(verdict.kind, 'accept', 'the baseline derivation must not need to be spelled out');
  assert.equal(verdict.metrics.baselineArm, 'none');
  assert.equal(verdict.metrics.attempts.baseline, 6, 'median attempts of the no-skill arm');
  assert.equal(verdict.metrics.attempts.candidate, 5);
  assert.equal(verdict.metrics.targetHits, '3/3');
  assert.equal(Object.hasOwn(verdict.metrics.attempts, 'original'), false,
    'a no-skill round must not report an original-arm number');
  const explicit = judgeRound({ round: 1, observations, criteria: criteria(), baselineArm: 'none' });
  assert.deepEqual(explicit.metrics, verdict.metrics);
  assert.throws(() => judgeRound({ round: 1, observations, criteria: criteria(), baselineArm: 'original' }),
    /INVALID_OBSERVATION/, 'an explicit baseline that contradicts the records must be refused');
  const weak = judgeRound({ round: 1, criteria: criteria(),
    observations: observations.map(item => (item.arm === 'candidate' ? { ...item, gate: false } : item)) });
  assert.equal(weak.kind, 'reject', 'the same three-condition logic applies to the no-skill baseline');
});

test('collectObservations normalizes record-shaped input deterministically', () => {
  const records = [
    { record_type: 'w2_ab_task', arm: 'candidate', task_id: 't7-near-neighbor', repeat: 2,
      skill_loaded: true, report: { written: false }, incomplete: false,
      attempts: { settled: 2, observed_input_tokens: 5000, observed_output_tokens: 500 } },
    { record_type: 'w2_ab_task', arm: 'original', task_id: 't7-near-neighbor', repeat: 1,
      skill_loaded: true, report: { written: false }, incomplete: false,
      attempts: { settled: 6, observed_input_tokens: 27000, observed_output_tokens: 900 } },
  ];
  const observations = collectObservations(records, {
    gateTokens: { 't7-near-neighbor': ['核验范围', '有限'] },
  });
  assert.deepEqual(observations[0], { arm: 'candidate', taskId: 't7-near-neighbor', repeat: 2,
    gate: false, attempts: 2, tokens: 5500, incomplete: false, reportWritten: false });
  assert.equal(observations[1].arm, 'original');
});

test('a round verdict is written once and never overwritten', async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'iteration-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  const verdict = judgeRound(round1());
  const first = await recordRound({ root, verdict });
  assert.equal(first.written, true);
  const stored = JSON.parse(await readFile(first.path, 'utf8'));
  assert.equal(stored.kind, 'accept');
  assert.match(stored.inputsDigest, /^[a-f0-9]{64}$/);
  assert.equal(stored.criteriaDigest, createHash('sha256').update(JSON.stringify(criteria())).digest('hex'));
  await assert.rejects(recordRound({ root, verdict }), /ROUND_EXISTS/);
  const second = await recordRound({ root,
    verdict: { ...verdict, kind: 'reject', metrics: { ...verdict.metrics, round: 2 } } });
  assert.equal(second.written, true);
  const rounds = (await readFile(join(root, 'rounds', 'round-2.json'), 'utf8')).length > 0;
  assert.equal(rounds, true);
});

test('two rounds recorded in sequence keep their own verdicts', async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'iteration-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  await recordRound({ root, verdict: judgeRound(round1()) });
  await recordRound({ root, verdict: judgeRound(round1({ round: 2, observations: round1().observations
    .map(item => (item.arm === 'candidate' ? { ...item, tokens: item.tokens * 5 } : item)) })) });
  const first = JSON.parse(await readFile(join(root, 'rounds', 'round-1.json'), 'utf8'));
  const second = JSON.parse(await readFile(join(root, 'rounds', 'round-2.json'), 'utf8'));
  assert.equal(first.kind, 'accept');
  assert.equal(second.kind, 'revise');
  assert.notEqual(first.inputsDigest, second.inputsDigest);
});
