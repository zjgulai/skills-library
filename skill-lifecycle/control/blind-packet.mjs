import { createHash } from 'node:crypto';
import { lstatSync, renameSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const slotPrefix = 'entry';
const judgedRecordTypes = new Set(['w2_ab_task', 'terminal_task']);
// W2 记录把题号放在顶层 task_id；终测记录放在 terminal.taskId。
const taskIdOf = record => (typeof record.task_id === 'string' ? record.task_id
  : (typeof record.terminal?.taskId === 'string' ? record.terminal.taskId : null));
const criteriaSuffix = 'criteria';

function failure(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function canonical(value) {
  return JSON.stringify(value);
}

/** Deterministic, seed-dependent slot order: the mapping is not guessable from the row order. */
function shuffleKey(seed, arm, taskId, repeat) {
  return sha256(`${seed}:${arm}:${taskId}:${repeat}`);
}

export function packetDigest(packet) {
  return sha256(canonical(packet.entries.map(entry => ({ slot: entry.slot, taskId: entry.taskId,
    criteria: entry.criteria, artifactDigest: sha256(entry.artifact) }))));
}

/**
 * Build a blinded judging packet from W2-shaped records.
 * `tasks` supplies the request text and the gold-free criterion question per task;
 * arm names, repeats, attempts, tokens and candidate identity stay in the returned key only.
 */
export function buildPacket({ records, tasks, seed, includeTasks, probes = [] } = {}) {
  if (typeof seed !== 'string' || !seed.trim()) throw failure('INVALID_SEED');
  if (!Array.isArray(records) || !Array.isArray(tasks)) throw failure('INVALID_INPUT');
  if (!Array.isArray(probes)) throw failure('INVALID_PROBES');
  const taskById = new Map();
  for (const task of tasks) {
    if (!isRecord(task) || typeof task.taskId !== 'string' || typeof task.request !== 'string' ||
      typeof task[criteriaSuffix] !== 'string') throw failure('INVALID_TASK');
    taskById.set(task.taskId, freeze({ taskId: task.taskId, request: task.request,
      criteria: task[criteriaSuffix] }));
  }
  const wanted = Array.isArray(includeTasks) && includeTasks.length > 0 ? new Set(includeTasks) : null;
  const rows = [];
  for (const record of records) {
    if (!isRecord(record) || !judgedRecordTypes.has(record.record_type)) continue;
    const taskId = taskIdOf(record);
    if (typeof record.arm !== 'string' || taskId === null) throw failure('INVALID_RECORD');
    if (wanted && !wanted.has(taskId)) continue;
    const task = taskById.get(taskId);
    if (!task) continue;
    const repeat = Number.isSafeInteger(record.repeat) ? record.repeat : 1;
    const artifact = [String(record.final_text ?? ''), String(record.report?.content ?? '')]
      .filter(part => part.trim().length > 0).join('\n\n---\n\n');
    rows.push({ arm: record.arm, taskId, repeat, artifact });
  }
  probes.forEach((probe, index) => {
    if (!isRecord(probe) || typeof probe.taskId !== 'string' || typeof probe.artifact !== 'string' ||
      typeof probe.expectedGate !== 'boolean' || typeof probe.label !== 'string' || !probe.label.trim()) {
      throw failure('INVALID_PROBES');
    }
    if (!taskById.has(probe.taskId)) throw failure('INVALID_PROBES');
    rows.push({ arm: 'probe', taskId: probe.taskId, repeat: index + 1, artifact: probe.artifact,
      probe: true, expectedGate: probe.expectedGate, label: probe.label });
  });
  if (rows.length === 0) throw failure('NO_ENTRIES');
  rows.sort((left, right) => shuffleKey(seed, left.arm, left.taskId, left.repeat)
    .localeCompare(shuffleKey(seed, right.arm, right.taskId, right.repeat)));

  const entries = [];
  const slots = [];
  rows.forEach((row, index) => {
    const slot = `${slotPrefix}-${String(index + 1).padStart(2, '0')}`;
    const task = taskById.get(row.taskId);
    entries.push(freeze({ slot, taskId: row.taskId, request: task.request,
      criteria: task.criteria, artifact: row.artifact }));
    slots.push(freeze({ slot, arm: row.arm, taskId: row.taskId, repeat: row.repeat,
      artifactDigest: sha256(row.artifact),
      ...(row.probe ? { probe: true, expectedGate: row.expectedGate, label: row.label } : {}) }));
  });
  // The seed stays out of the public packet: it would let a reader recompute the slot order.
  const packet = freeze({ packetId: `packet-${sha256(canonical(slots.map(slot => [slot.slot, slot.artifactDigest]))).slice(0, 16)}`,
    entries });
  const key = freeze({ packetId: packet.packetId, seed, slots,
    packetDigest: packetDigest(packet) });
  return { packet, key };
}

export async function writePacket({ root, packet, key } = {}) {
  if (typeof root !== 'string' || !root.trim()) throw failure('INVALID_PACKET_ROOT');
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    throw failure('INVALID_PACKET_ROOT', error);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw failure('INVALID_PACKET_ROOT');
  const publicPath = join(root, 'packet.json');
  const keyDirectory = join(root, 'keys');
  await mkdir(keyDirectory, { recursive: true });
  const keyPath = join(keyDirectory, `${key.packetId}.key.json`);
  try {
    await readFile(publicPath, 'utf8');
    throw failure('PACKET_EXISTS');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const write = async (path, value) => {
    const temporary = `${path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
  };
  await write(publicPath, { packet, packetDigest: key.packetDigest });
  await write(keyPath, key);
  return freeze({ packetPath: publicPath, keyPath, packetId: packet.packetId });
}

/** Validate a judge's verdict file: one decision per slot, nothing unknown, nothing missing. */
export function scorePacket({ packet, verdicts } = {}) {
  if (!isRecord(packet) || !Array.isArray(packet.entries)) throw failure('INVALID_PACKET');
  if (!Array.isArray(verdicts)) throw failure('INVALID_VERDICTS');
  const slots = new Set(packet.entries.map(entry => entry.slot));
  const scores = new Map();
  for (const verdict of verdicts) {
    if (!isRecord(verdict) || typeof verdict.slot !== 'string' || typeof verdict.gate !== 'boolean') {
      throw failure('INVALID_VERDICT');
    }
    if (!slots.has(verdict.slot)) throw failure(`UNKNOWN_SLOT: ${verdict.slot}`);
    if (scores.has(verdict.slot)) throw failure(`DUPLICATE_SLOT: ${verdict.slot}`);
    const reason = verdict.reason === undefined ? null : String(verdict.reason);
    scores.set(verdict.slot, freeze({ slot: verdict.slot, gate: verdict.gate, reason }));
  }
  const missing = [...slots].filter(slot => !scores.has(slot));
  if (missing.length > 0) throw failure(`MISSING_SLOTS: ${missing.join(',')}`);
  return scores;
}

/**
 * Map blinded scores back onto arms and rebuild W3 observations.
 * Attempts, tokens and completeness come from the original records, never from the judge.
 */
export function unblind({ key, scores, records } = {}) {
  if (!isRecord(key) || !Array.isArray(key.slots)) throw failure('INVALID_KEY');
  if (!(scores instanceof Map)) throw failure('INVALID_SCORES');
  if (!Array.isArray(records)) throw failure('INVALID_RECORDS');
  const byKey = new Map();
  for (const record of records) {
    if (!isRecord(record) || !judgedRecordTypes.has(record.record_type)) continue;
    const repeat = Number.isSafeInteger(record.repeat) ? record.repeat : 1;
    byKey.set(`${record.arm}|${taskIdOf(record)}|${repeat}`, record);
  }
  const observations = [];
  for (const slot of key.slots) {
    if (slot.probe === true) continue;
    const score = scores.get(slot.slot);
    if (score === undefined) throw failure(`MISSING_SLOTS: ${slot.slot}`);
    const record = byKey.get(`${slot.arm}|${slot.taskId}|${slot.repeat}`);
    if (record === undefined) throw failure(`RECORD_NOT_FOUND: ${slot.arm}/${slot.taskId}#${slot.repeat}`);
    observations.push(freeze({
      arm: slot.arm, taskId: slot.taskId, repeat: slot.repeat, gate: score.gate,
      attempts: record.attempts?.settled ?? 0,
      tokens: (record.attempts?.observed_input_tokens ?? 0) + (record.attempts?.observed_output_tokens ?? 0),
      incomplete: record.incomplete === true,
      reportWritten: record.report?.written === true,
    }));
  }
  return observations.sort((left, right) => (left.taskId === right.taskId
    ? (left.arm === right.arm ? left.repeat - right.repeat : left.arm.localeCompare(right.arm))
    : left.taskId.localeCompare(right.taskId)));
}

/** Report which forbidden tokens (arm names, candidate ids, …) leaked into the public packet. */
export function leaks(packet, tokens = ['candidate', 'original']) {
  const text = canonical(packet);
  return tokens.filter(token => typeof token === 'string' && token.length > 0 && text.includes(token));
}

const calibrationKinds = Object.freeze({ calibrated: 'calibrated', miscalibrated: 'miscalibrated' });

/**
 * Score the judge against its own negative and positive probes. A judge that agrees on every
 * probe is calibrated for this packet; any disagreement (a missed bad artifact, or a rejected
 * good one) marks the judge miscalibrated and is reported with the offending slots.
 */
export function calibrate({ key, scores } = {}) {
  if (!isRecord(key) || !Array.isArray(key.slots)) throw failure('INVALID_KEY');
  if (!(scores instanceof Map)) throw failure('INVALID_SCORES');
  const probes = key.slots.filter(slot => slot.probe === true);
  if (probes.length === 0) throw failure('NO_PROBES');
  const disagreements = [];
  const detail = [];
  for (const probe of probes) {
    const score = scores.get(probe.slot);
    if (score === undefined) throw failure(`MISSING_SLOTS: ${probe.slot}`);
    const agreed = score.gate === probe.expectedGate;
    detail.push(freeze({ slot: probe.slot, label: probe.label, expectedGate: probe.expectedGate,
      judgeGate: score.gate, agreed }));
    if (!agreed) disagreements.push(`${probe.label}:${probe.slot}`);
  }
  return freeze({
    verdict: disagreements.length === 0 ? calibrationKinds.calibrated : calibrationKinds.miscalibrated,
    probes: probes.length,
    agreements: probes.length - disagreements.length,
    disagreements,
    probeDetail: detail,
  });
}

/** A round verdict may only stand on a calibrated judge; otherwise it degrades to inconclusive. */
export function certifyRound({ calibration, verdict } = {}) {
  if (!isRecord(calibration) || typeof calibration.verdict !== 'string') throw failure('INVALID_CALIBRATION');
  if (!isRecord(verdict) || typeof verdict.kind !== 'string') throw failure('INVALID_VERDICT');
  const certified = calibration.verdict === calibrationKinds.calibrated;
  const base = { ...verdict, judgeCalibration: { ...calibration } };
  if (certified) return freeze({ ...base, certified: true });
  const reason = calibration.verdict === calibrationKinds.miscalibrated
    ? 'JUDGE_MISCALIBRATED'
    : 'JUDGE_UNCALIBRATED';
  return freeze({ ...base, certified: false, kind: 'inconclusive', reasons: [reason] });
}
