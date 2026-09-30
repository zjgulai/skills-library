import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAttributionBrief, submitHypotheses, toCandidateHypothesis }
  from '../control/attribution.mjs';

const criteria = () => ({ targetTaskIds: ['t7'], targetHitsRequired: 1, targetRepeatsExpected: 2,
  regressionTaskIds: ['t2'], costTolerance: { attemptsRatio: 1.5, tokensRatio: 1.5 }, maxRounds: 1 });

function record({ arm, taskId, repeat = 1, gate = true, incomplete = false, reportWritten = true,
  attempts = 3, tokens = 1000 }) {
  return { record_type: 'w2_ab_task', arm, task_id: taskId, repeat, gate, incomplete,
    attempts: { settled: attempts, observed_input_tokens: tokens - 100, observed_output_tokens: 100 },
    report: { written: reportWritten, content: reportWritten ? 'body' : null },
    final_text: 'text' };
}

function failingRecords() {
  return [
    record({ arm: 'original', taskId: 't7', repeat: 1, gate: false }),
    record({ arm: 'original', taskId: 't7', repeat: 2, gate: false }),
    record({ arm: 'candidate', taskId: 't7', repeat: 1, gate: false }),
    record({ arm: 'candidate', taskId: 't7', repeat: 2, gate: false }),
    record({ arm: 'original', taskId: 't2', repeat: 1 }),
    record({ arm: 'candidate', taskId: 't2', repeat: 1, reportWritten: false }),
    record({ arm: 'original', taskId: 'n1', repeat: 1, gate: true }),
    record({ arm: 'candidate', taskId: 'n1', repeat: 1, gate: false }),
    record({ arm: 'original', taskId: 'k1', repeat: 1 }),
    record({ arm: 'candidate', taskId: 'k1', repeat: 1 }),
    record({ arm: 'original', taskId: 'x1', repeat: 1, tokens: 1000 }),
    record({ arm: 'candidate', taskId: 'x1', repeat: 1, tokens: 5000 }),
  ];
}

test('the brief turns failing candidate readings into per-task facts', () => {
  const brief = buildAttributionBrief({ records: failingRecords(), criteria: criteria() });
  assert.deepEqual(brief.failures.map(entry => [entry.taskId, entry.readings]), [
    ['n1', ['GATE_MISSED']],
    ['t2', ['REPORT_MISSING']],
    ['t7', ['GATE_MISSED']],
    ['x1', ['COST_OUTLIER']],
  ]);
  assert.deepEqual(brief.ok, ['k1'], 'a task whose candidate arm passed is not a failure');
  const t7 = brief.failures.find(entry => entry.taskId === 't7');
  assert.equal(t7.repeats, 2);
  assert.deepEqual(t7.evidence.gates, [false, false]);
  assert.equal(t7.criteriaVisible, true, 't7 is a pre-registered target task');
  assert.equal(brief.failures.find(entry => entry.taskId === 't2').criteriaVisible, true,
    't2 is a pre-registered regression task');
  assert.equal(brief.failures.find(entry => entry.taskId === 'n1').criteriaVisible, false,
    'n1 is neither a target nor a regression task: fixing it would not move the verdict');
  assert.deepEqual(brief.hiddenFromCriteria, ['n1', 'x1']);
  assert.equal(brief.sample.observations, 12);
  assert.ok(brief.limits.some(line => line.includes('2 道失败题不在预注册判据内')),
    `expected the coverage gap in ${JSON.stringify(brief.limits)}`);
  assert.match(brief.briefDigest, /^[a-f0-9]{64}$/);
});

test('an incomplete candidate arm is a reading, not a silent skip', () => {
  const brief = buildAttributionBrief({ records: [
    record({ arm: 'candidate', taskId: 't7', repeat: 1, incomplete: true, gate: false }),
    record({ arm: 'original', taskId: 't7', repeat: 1 }),
  ], criteria: criteria() });
  assert.deepEqual(brief.failures.map(entry => [entry.taskId, entry.readings]),
    [['t7', ['INCOMPLETE', 'GATE_MISSED']]]);
});

const hypothesesFor = brief => [
  { taskId: 't7', claim: '范围界定缺失导致门不过', change: '候选：开头加范围界定',
    expectedEffect: '门在候选臂命中', criteriaImpact: 'covered' },
  { taskId: 't2', claim: '收尾没写报告', change: '候选：收尾强制写报告', expectedEffect: '报告存在',
    criteriaImpact: 'covered' },
  { taskId: 'n1', claim: '非目标请求也被当核验处理', change: '候选：先判断是否属于范围',
    expectedEffect: '非目标请求得到澄清', criteriaImpact: 'not-covered',
    coverageNote: '需要在判据里新增"非核验请求须界定"一项，否则改进不会计分' },
  { taskId: 'x1', claim: '该题成本翻倍', change: '候选：限制重读次数', expectedEffect: '成本回到容差内',
    criteriaImpact: 'not-covered',
    coverageNote: '成本只在实际运行的判据里被看见，需要把该题列为成本观察项' },
];

test('submitted hypotheses must match the brief, and coverage gaps are surfaced', () => {
  const brief = buildAttributionBrief({ records: failingRecords(), criteria: criteria() });
  const report = submitHypotheses({ brief, hypotheses: hypothesesFor(brief) });
  assert.deepEqual(report.hypotheses.map(entry => entry.taskId), ['n1', 't2', 't7', 'x1']);
  assert.deepEqual(report.coverageGaps, ['n1', 'x1'],
    'a fix the pre-registered criteria cannot see must be flagged, not celebrated');
  assert.deepEqual(report.waived, []);
  assert.match(report.reportDigest, /^[a-f0-9]{64}$/);
});

test('claiming criteria coverage the brief contradicts is refused in both directions', () => {
  const brief = buildAttributionBrief({ records: failingRecords(), criteria: criteria() });
  const claimed = hypothesesFor(brief)
    .map(entry => (entry.taskId === 'n1' ? { ...entry, criteriaImpact: 'covered', coverageNote: undefined } : entry));
  assert.throws(() => submitHypotheses({ brief, hypotheses: claimed }), /CRITERIA_CLAIM_MISMATCH/);
  const overClaimed = hypothesesFor(brief)
    .map(entry => (entry.taskId === 't7' ? { ...entry, criteriaImpact: 'not-covered',
      coverageNote: '也许判据看不到' } : entry));
  assert.throws(() => submitHypotheses({ brief, hypotheses: overClaimed }), /CRITERIA_CLAIM_MISMATCH/);
});

test('a not-covered claim must say how it would be seen', () => {
  const brief = buildAttributionBrief({ records: failingRecords(), criteria: criteria() });
  const silent = hypothesesFor(brief)
    .map(entry => (entry.taskId === 'n1' ? { ...entry, coverageNote: undefined } : entry));
  assert.throws(() => submitHypotheses({ brief, hypotheses: silent }), /COVERAGE_NOTE_REQUIRED/);
});

test('unknown failures and unattributed tasks are both refused', () => {
  const brief = buildAttributionBrief({ records: failingRecords(), criteria: criteria() });
  const bogus = [...hypothesesFor(brief), { taskId: 'never-failed', claim: 'x', change: 'y',
    expectedEffect: 'z', criteriaImpact: 'covered' }];
  assert.throws(() => submitHypotheses({ brief, hypotheses: bogus }), /UNKNOWN_FAILURE: never-failed/);
  const partial = hypothesesFor(brief).filter(entry => entry.taskId !== 'x1');
  assert.throws(() => submitHypotheses({ brief, hypotheses: partial }), /UNATTRIBUTED_TASKS: x1/);
  const waived = [...partial, { taskId: 'x1', waived: true, reason: '成本波动大，先观察一轮' }];
  const report = submitHypotheses({ brief, hypotheses: waived });
  assert.deepEqual(report.waived, [{ taskId: 'x1', reason: '成本波动大，先观察一轮' }]);
  assert.equal(report.hypotheses.some(entry => entry.taskId === 'x1'), false);
});

test('inputs are validated before any brief or report exists', () => {
  assert.throws(() => buildAttributionBrief({ records: 'none', criteria: criteria() }), /INVALID_RECORDS/);
  assert.throws(() => buildAttributionBrief({ records: [], criteria: {} }), /INVALID_CRITERIA/);
  const brief = buildAttributionBrief({ records: failingRecords(), criteria: criteria() });
  assert.throws(() => submitHypotheses({ brief: { failures: [] }, hypotheses: [] }), /INVALID_BRIEF/);
  assert.throws(() => submitHypotheses({ brief, hypotheses: [{}] }), /INVALID_HYPOTHESIS/);
  assert.throws(() => submitHypotheses({ brief, hypotheses: [{ taskId: 't7', claim: 'x', change: 'y',
    expectedEffect: 'z', criteriaImpact: 'maybe' }] }), /INVALID_HYPOTHESIS/);
  assert.throws(() => submitHypotheses({ brief, hypotheses: [{ taskId: 't7', waived: true }] }),
    /INVALID_HYPOTHESIS/);
});

test('judge-scored observations can be briefed directly', () => {
  const observations = [
    { arm: 'original', taskId: 't7', repeat: 1, gate: false, attempts: 3, tokens: 20000,
      incomplete: false, reportWritten: true },
    { arm: 'candidate', taskId: 't7', repeat: 1, gate: false, attempts: 3, tokens: 20000,
      incomplete: false, reportWritten: true },
  ];
  const brief = buildAttributionBrief({ observations, criteria: criteria() });
  assert.deepEqual(brief.failures.map(entry => [entry.taskId, entry.readings]), [['t7', ['GATE_MISSED']]]);
  assert.equal(brief.sample.observations, 2);
  assert.throws(() => buildAttributionBrief({ observations,
    records: [], criteria: criteria() }), /INVALID_INPUT/, 'exactly one input form, never both');
  assert.throws(() => buildAttributionBrief({ observations: [{ arm: 'candidate' }], criteria: criteria() }),
    /INVALID_OBSERVATION/);
  assert.throws(() => buildAttributionBrief({ criteria: criteria() }), /INVALID_INPUT/);
});

test('a terminal-run record is a first-class input, not a silent blank', () => {
  const terminalRecord = { record_type: 'terminal_task', arm: 'candidate', repeat: 1,
    terminal: { setId: 'w03', taskId: 't7', expectsReport: true }, incomplete: false,
    attempts: { settled: 4, observed_input_tokens: 20000, observed_output_tokens: 500 },
    report: { written: true, content: '正文' }, final_text: '没有界定范围' };
  const brief = buildAttributionBrief({ records: [terminalRecord,
    record({ arm: 'original', taskId: 't7', repeat: 1, tokens: 20000 })], criteria: criteria() });
  assert.equal(brief.failures.length, 1, 'the terminal record must reach the brief');
  assert.deepEqual(brief.failures[0].readings, ['GATE_MISSED']);
  assert.equal(brief.failures[0].taskId, 't7');
});

test('an accepted hypothesis becomes the candidate wording, and nothing else does', () => {
  const brief = buildAttributionBrief({ records: failingRecords(), criteria: criteria() });
  const report = submitHypotheses({ brief, hypotheses: hypothesesFor(brief) });
  const wording = toCandidateHypothesis({ report, taskId: 't7' });
  assert.deepEqual(wording, { claim: '范围界定缺失导致门不过', expectedEffect: '门在候选臂命中' });
  assert.throws(() => toCandidateHypothesis({ report, taskId: 'n1' }), /COVERAGE_NOTE_REQUIRED/,
    'a fix the criteria cannot see must not ride into a candidate as if it would be scored');
  assert.throws(() => toCandidateHypothesis({ report, taskId: 'k1' }), /NOT_ATTRIBUTED/,
    'a task that never failed has no hypothesis to hand over');
});
