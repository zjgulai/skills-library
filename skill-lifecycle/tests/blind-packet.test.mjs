import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPacket, writePacket, scorePacket, unblind, leaks, packetDigest } from '../control/blind-packet.mjs';

const tasks = [
  { taskId: 't7-near-neighbor', request: '把这份数据重新汇总并解释毛利率定义',
    criteria: '回应是否界定「不是核验请求／超出核验范围」并说明只提供有限帮助？' },
  { taskId: 't2-recompute', request: '核验这份成交与客单价分析',
    criteria: '报告是否给出独立复算并指出结论与数据不符？' },
];

function record(arm, taskId, repeat, text) {
  return { record_type: 'w2_ab_task', arm, task_id: taskId, repeat,
    final_text: text, report: { written: false, content: null }, incomplete: false,
    attempts: { settled: arm === 'original' ? 6 : 2, observed_input_tokens: 27000, observed_output_tokens: 900 },
    candidate_id: arm === 'candidate' ? 't7-boundary-001' : null, skill_digest: 'a'.repeat(64) };
}

function records() {
  return [
    record('original', 't7-near-neighbor', 1, '按技能规范完成字段核查与聚合说明'),
    record('original', 't7-near-neighbor', 2, '按技能规范完成字段核查'),
    record('candidate', 't7-near-neighbor', 1, '本请求超出核验范围，只提供有限帮助：毛利率定义…'),
    record('candidate', 't7-near-neighbor', 2, '本请求超出核验范围，仅提供有限帮助'),
    record('original', 't2-recompute', 1, '报告结论与数据不符：复算总额为 5,880 元'),
    record('candidate', 't2-recompute', 1, '复算总额为 5,880 元，与报告不符'),
  ];
}

test('the public packet carries no arm, candidate or cost information', () => {
  const { packet, key } = buildPacket({ records: records(), tasks, seed: 'seed-1' });
  assert.equal(leaks(packet, ['candidate', 'original', 't7-boundary-001', 'attempts', 'tokens',
    'observed_input_tokens', 'skill_digest']).length, 0, 'the packet must not leak identity or cost');
  assert.equal(packet.entries.length, 6);
  assert.equal(key.slots.length, 6);
  for (const entry of packet.entries) {
    assert.match(entry.slot, /^entry-\d{2}$/);
    assert.ok(entry.artifact.length > 0);
    assert.equal(Object.hasOwn(entry, 'arm'), false);
  }
});

test('slot order is seed-dependent, so row order does not reveal the arm', () => {
  const first = buildPacket({ records: records(), tasks, seed: 'seed-1' });
  const second = buildPacket({ records: records(), tasks, seed: 'seed-2' });
  const orderOf = built => built.packet.entries.map(entry => entry.slot + ':' + entry.taskId).join('|');
  assert.equal(orderOf(first), orderOf(buildPacket({ records: records(), tasks, seed: 'seed-1' })),
    'the same seed must reproduce the same order');
  assert.notEqual(orderOf(first), orderOf(second), 'a different seed must reshuffle the packet');
  const arms = first.key.slots.map(slot => slot.arm);
  assert.ok(arms.slice(0, 3).includes('candidate') || arms.slice(0, 3).includes('original'));
  assert.equal(new Set(arms).size, 2, 'both arms must be present');
});

test('records can be limited to selected tasks', () => {
  const { packet } = buildPacket({ records: records(), tasks, seed: 'seed-1', includeTasks: ['t7-near-neighbor'] });
  assert.equal(packet.entries.length, 4);
  assert.ok(packet.entries.every(entry => entry.taskId === 't7-near-neighbor'));
});

test('scoring requires exactly one verdict per slot', () => {
  const { packet } = buildPacket({ records: records(), tasks, seed: 'seed-1' });
  const verdicts = packet.entries.map(entry => ({ slot: entry.slot, gate: true }));
  const scores = scorePacket({ packet, verdicts });
  assert.equal(scores.size, packet.entries.length);
  assert.equal(scores.get(packet.entries[0].slot).gate, true);
  assert.throws(() => scorePacket({ packet, verdicts: verdicts.slice(1) }), /MISSING_SLOTS/);
  assert.throws(() => scorePacket({ packet, verdicts: [...verdicts, { slot: 'entry-99', gate: true }] }),
    /UNKNOWN_SLOT/);
  assert.throws(() => scorePacket({ packet, verdicts: [verdicts[0], verdicts[0], ...verdicts.slice(2)] }),
    /DUPLICATE_SLOT/);
  assert.throws(() => scorePacket({ packet, verdicts: [{ slot: verdicts[0].slot, gate: 'yes' }] }),
    /INVALID_VERDICT/);
});

test('unblinding restores arms and keeps cost out of the judge path', () => {
  const { packet, key } = buildPacket({ records: records(), tasks, seed: 'seed-1' });
  const verdicts = packet.entries.map(entry => ({ slot: entry.slot,
    gate: entry.criteria.includes('界定') ? entry.artifact.includes('超出核验范围') : true }));
  const scores = scorePacket({ packet, verdicts });
  const observations = unblind({ key, scores, records: records() });
  assert.equal(observations.length, 6);
  const candidateTarget = observations.filter(item => item.arm === 'candidate' && item.taskId === 't7-near-neighbor');
  const originalTarget = observations.filter(item => item.arm === 'original' && item.taskId === 't7-near-neighbor');
  assert.deepEqual(candidateTarget.map(item => item.gate), [true, true]);
  assert.deepEqual(originalTarget.map(item => item.gate), [false, false]);
  assert.deepEqual(candidateTarget.map(item => item.attempts), [2, 2]);
  assert.deepEqual(originalTarget.map(item => item.tokens), [27900, 27900]);
});

test('unblinding refuses when a record no longer matches its slot', () => {
  const { packet, key } = buildPacket({ records: records(), tasks, seed: 'seed-1' });
  const scores = scorePacket({ packet, verdicts: packet.entries.map(entry => ({ slot: entry.slot, gate: true })) });
  const trimmed = records().filter(item => !(item.arm === 'candidate' && item.task_id === 't7-near-neighbor'));
  assert.throws(() => unblind({ key, scores, records: trimmed }), /RECORD_NOT_FOUND/);
});

test('the packet digest binds the exact artifacts it shipped', () => {
  const { packet } = buildPacket({ records: records(), tasks, seed: 'seed-1' });
  const before = packetDigest(packet);
  const tampered = { ...packet, entries: packet.entries.map((entry, index) =>
    index === 0 ? { ...entry, artifact: 'rewritten after the fact' } : entry) };
  assert.notEqual(packetDigest(tampered), before);
  assert.equal(packetDigest(packet), before, 'digesting twice must be stable');
});

test('writing a packet stores the key beside it and refuses to overwrite', async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'blind-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  const { packet, key } = buildPacket({ records: records(), tasks, seed: 'seed-1' });
  const written = await writePacket({ root, packet, key });
  const publicPayload = JSON.parse(await readFile(written.packetPath, 'utf8'));
  assert.equal(publicPayload.packetDigest, key.packetDigest);
  assert.equal(leaks(publicPayload, ['candidate', 'original']).length, 0);
  const keyPayload = JSON.parse(await readFile(written.keyPath, 'utf8'));
  assert.equal(keyPayload.slots.length, 6);
  assert.ok(written.keyPath.includes(join('keys')));
  await assert.rejects(writePacket({ root, packet, key }), /PACKET_EXISTS/);
  const nested = await mkdtemp(join(await realpath(tmpdir()), 'blind-'));
  t.after(() => rm(nested, { recursive: true, force: true }).catch(() => {}));
  await assert.rejects(writePacket({ root: join(nested, 'missing'), packet, key }), /INVALID_PACKET_ROOT/);
});

test('buildPacket validates its inputs', () => {
  assert.throws(() => buildPacket({ records: records(), tasks, seed: '' }), /INVALID_SEED/);
  assert.throws(() => buildPacket({ records: records(), tasks: [{ taskId: 't7-near-neighbor' }], seed: 's' }),
    /INVALID_TASK/);
  assert.throws(() => buildPacket({ records: [], tasks, seed: 's' }), /NO_ENTRIES/);
});
