import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPacket, scorePacket, unblind, calibrate, certifyRound, leaks, packetDigest }
  from '../control/blind-packet.mjs';

const tasks = [
  { taskId: 't7-near-neighbor', request: '把这份数据重新汇总并解释毛利率定义',
    criteria: '回应是否界定「不是核验请求／超出核验范围」并说明只提供有限帮助？' },
];

function record(arm, repeat, text) {
  return { record_type: 'w2_ab_task', arm, task_id: 't7-near-neighbor', repeat,
    final_text: text, report: { written: false, content: null }, incomplete: false,
    attempts: { settled: arm === 'original' ? 6 : 2, observed_input_tokens: 100, observed_output_tokens: 10 } };
}

function records() {
  return [
    record('original', 1, '按技能规范完成字段核查与聚合说明'),
    record('candidate', 1, '本请求超出核验范围，只提供有限帮助：毛利率定义…'),
  ];
}

const probes = () => ([
  { taskId: 't7-near-neighbor', expectedGate: false, label: 'empty',
    artifact: '（本次回答为空）' },
  { taskId: 't7-near-neighbor', expectedGate: false, label: 'off-topic',
    artifact: '春江潮水连海平，海上明月共潮生。' },
  { taskId: 't7-near-neighbor', expectedGate: false, label: 'fake-pass',
    artifact: '已按 validate-data 完成核验，未发现任何问题，结论：Ready to share。' },
  { taskId: 't7-near-neighbor', expectedGate: true, label: 'honest-boundary',
    artifact: '这不是核验请求：你要求的是重新汇总与术语解释，超出 validate-data 的核验范围；我只提供有限帮助——毛利率=(收入-成本)/收入。' },
]);

function packetWithProbes(seed = 'cal-1') {
  return buildPacket({ records: records(), tasks, seed, probes: probes() });
}

test('probes are mixed into the packet without changing its shape', () => {
  const { packet, key } = packetWithProbes();
  assert.equal(packet.entries.length, 6);
  assert.equal(leaks(packet, ['probe', 'expectedGate', 'candidate', 'original']).length, 0,
    'the packet must not reveal which entries are probes');
  const probeSlots = key.slots.filter(slot => slot.probe === true);
  assert.equal(probeSlots.length, 4);
  assert.deepEqual(probeSlots.map(slot => slot.label).sort(),
    ['empty', 'fake-pass', 'honest-boundary', 'off-topic']);
  for (const entry of packet.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['artifact', 'criteria', 'request', 'slot', 'taskId']);
  }
});

test('unblinding ignores probe slots and keeps only real runs', () => {
  const { packet, key } = packetWithProbes();
  const verdicts = packet.entries.map(entry => ({ slot: entry.slot, gate: true }));
  const scores = scorePacket({ packet, verdicts });
  const observations = unblind({ key, scores, records: records() });
  assert.equal(observations.length, 2);
  assert.deepEqual(observations.map(item => item.arm).sort(), ['candidate', 'original']);
});

test('a judge that agrees on every probe is calibrated', () => {
  const { packet, key } = packetWithProbes();
  const expected = new Map(key.slots.map(slot => [slot.slot, slot.probe === true ? slot.expectedGate : true]));
  const scores = scorePacket({ packet, verdicts: packet.entries
    .map(entry => ({ slot: entry.slot, gate: expected.get(entry.slot) })) });
  const calibration = calibrate({ key, scores });
  assert.equal(calibration.verdict, 'calibrated');
  assert.equal(calibration.probes, 4);
  assert.deepEqual(calibration.disagreements, []);
  assert.equal(calibration.probeDetail.every(item => item.agreed), true);
});

test('an always-true judge is caught by the negative probes', () => {
  const { packet, key } = packetWithProbes();
  const scores = scorePacket({ packet, verdicts: packet.entries.map(entry => ({ slot: entry.slot, gate: true })) });
  const calibration = calibrate({ key, scores });
  assert.equal(calibration.verdict, 'miscalibrated');
  assert.equal(calibration.disagreements.length, 3);
  assert.ok(calibration.disagreements.every(item => item.includes('entry-')));
});

test('an always-false judge is caught by the positive probe', () => {
  const { packet, key } = packetWithProbes();
  const scores = scorePacket({ packet, verdicts: packet.entries.map(entry => ({ slot: entry.slot, gate: false })) });
  const calibration = calibrate({ key, scores });
  assert.equal(calibration.verdict, 'miscalibrated');
  assert.equal(calibration.disagreements.length, 1);
  assert.match(calibration.disagreements[0], /^honest-boundary:/);
});

test('calibration requires probes and a complete verdict set', () => {
  const { packet, key } = buildPacket({ records: records(), tasks, seed: 'no-probes' });
  const scores = scorePacket({ packet, verdicts: packet.entries.map(entry => ({ slot: entry.slot, gate: true })) });
  assert.throws(() => calibrate({ key, scores }), /NO_PROBES/);
  const withProbes = packetWithProbes();
  const partial = scorePacket({ packet: withProbes.packet,
    verdicts: withProbes.packet.entries.map(entry => ({ slot: entry.slot, gate: true })) });
  const keyMissingSlot = { ...withProbes.key, slots: withProbes.key.slots
    .map(slot => ({ ...slot })) };
  keyMissingSlot.slots[0] = { ...keyMissingSlot.slots[0], slot: 'entry-99' };
  assert.throws(() => calibrate({ key: keyMissingSlot, scores: partial }), /MISSING_SLOTS/);
});

test('a miscalibrated judge downgrades the round verdict to inconclusive', () => {
  const { packet, key } = packetWithProbes();
  const scores = scorePacket({ packet, verdicts: packet.entries.map(entry => ({ slot: entry.slot, gate: true })) });
  const verdict = { kind: 'accept', reasons: [], metrics: { round: 1 } };
  const miscalibrated = calibrate({ key, scores });
  const downgraded = certifyRound({ calibration: miscalibrated, verdict });
  assert.equal(downgraded.certified, false);
  assert.equal(downgraded.kind, 'inconclusive');
  assert.deepEqual(downgraded.reasons, ['JUDGE_MISCALIBRATED']);
  assert.equal(downgraded.judgeCalibration.probes, 4);

  const expected = new Map(key.slots.map(slot => [slot.slot, slot.probe === true ? slot.expectedGate : true]));
  const goodScores = scorePacket({ packet, verdicts: packet.entries
    .map(entry => ({ slot: entry.slot, gate: expected.get(entry.slot) })) });
  const certified = certifyRound({ calibration: calibrate({ key, scores: goodScores }), verdict });
  assert.equal(certified.certified, true);
  assert.equal(certified.kind, 'accept');
  assert.deepEqual(certified.reasons, []);
});

test('an uncalibrated packet is refused with its own reason', () => {
  const verdict = { kind: 'accept', reasons: [], metrics: { round: 1 } };
  const uncertified = certifyRound({ calibration: { verdict: 'uncalibrated', probes: 0 }, verdict });
  assert.equal(uncertified.certified, false);
  assert.equal(uncertified.kind, 'inconclusive');
  assert.deepEqual(uncertified.reasons, ['JUDGE_UNCALIBRATED']);
  const wrong = certifyRound({ calibration: { verdict: 'miscalibrated', probes: 5 }, verdict });
  assert.deepEqual(wrong.reasons, ['JUDGE_MISCALIBRATED']);
});

test('certifyRound validates its inputs', () => {
  assert.throws(() => certifyRound({ calibration: {}, verdict: { kind: 'accept' } }), /INVALID_CALIBRATION/);
  assert.throws(() => certifyRound({ calibration: { verdict: 'calibrated' }, verdict: {} }), /INVALID_VERDICT/);
});

test('probe digests participate in the packet digest', () => {
  const first = packetWithProbes('seed-a');
  const second = packetWithProbes('seed-b');
  assert.notEqual(packetDigest(first.packet), packetDigest(second.packet));
  const tampered = { ...first.packet, entries: first.packet.entries.map((entry, index) =>
    index === 0 ? { ...entry, artifact: `${entry.artifact}\n修修补补` } : entry) };
  assert.notEqual(packetDigest(tampered), packetDigest(first.packet));
});
