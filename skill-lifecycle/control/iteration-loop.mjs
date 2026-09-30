import { createHash } from 'node:crypto';
import { lstatSync, renameSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { armVocabulary, baselineArms, candidateArm } from './arm-scope.mjs';

const criteriaFields = ['targetTaskId', 'targetHitsRequired', 'targetRepeatsExpected',
  'regressionTaskIds', 'costTolerance', 'maxRounds'];
const toleranceFields = ['attemptsRatio', 'tokensRatio'];
const observationFields = ['arm', 'taskId', 'repeat', 'gate', 'attempts', 'tokens', 'incomplete', 'reportWritten'];
const arms = new Set(armVocabulary);
const defaultBaselineArm = 'original';

function failure(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function digestOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function targetIdsOf(value) {
  if (typeof value.targetTaskId === 'string' && value.targetTaskId.trim()) return [value.targetTaskId];
  if (Array.isArray(value.targetTaskIds) && value.targetTaskIds.length > 0 &&
    value.targetTaskIds.every(id => typeof id === 'string' && id.trim()) &&
    new Set(value.targetTaskIds).size === value.targetTaskIds.length) return [...value.targetTaskIds];
  throw failure('INVALID_CRITERIA');
}

function validateCriteria(value) {
  const allowed = [...criteriaFields, 'targetTaskIds', 'targetHitsOverBaseline'];
  if (!isRecord(value) ||
    Reflect.ownKeys(value).some(key => !allowed.includes(key)) ||
    ((Object.hasOwn(value, 'targetTaskId') ? 1 : 0) + (Object.hasOwn(value, 'targetTaskIds') ? 1 : 0)) !== 1) {
    throw failure('INVALID_CRITERIA');
  }
  const required = criteriaFields.filter(key => key !== 'targetTaskId' && key !== 'targetHitsRequired');
  if (required.some(key => !Object.hasOwn(value, key))) throw failure('INVALID_CRITERIA');
  const targetIds = targetIdsOf(value);
  // A target is either an absolute hit count, or a delta over the baseline arm. The relative form is the
  // only way to state "must be better than the baseline" — and a delta the baseline already saturates is
  // a legitimate (if unwinnable) target, so it is not capped here.
  const absolute = Object.hasOwn(value, 'targetHitsRequired');
  const relative = Object.hasOwn(value, 'targetHitsOverBaseline');
  if (absolute === relative) throw failure('INVALID_CRITERIA');
  if (absolute && (!Number.isSafeInteger(value.targetHitsRequired) || value.targetHitsRequired <= 0)) {
    throw failure('INVALID_CRITERIA');
  }
  if (relative && (!Number.isSafeInteger(value.targetHitsOverBaseline) || value.targetHitsOverBaseline < 0)) {
    throw failure('INVALID_CRITERIA');
  }
  if (!Number.isSafeInteger(value.targetRepeatsExpected) || value.targetRepeatsExpected <= 0) throw failure('INVALID_CRITERIA');
  if (absolute && value.targetHitsRequired > value.targetRepeatsExpected * targetIds.length) throw failure('INVALID_CRITERIA');
  if (!Array.isArray(value.regressionTaskIds) ||
    value.regressionTaskIds.some(id => typeof id !== 'string' || !id.trim()) ||
    new Set(value.regressionTaskIds).size !== value.regressionTaskIds.length) throw failure('INVALID_CRITERIA');
  const tolerance = value.costTolerance;
  if (!isRecord(tolerance) || Reflect.ownKeys(tolerance).length !== toleranceFields.length ||
    toleranceFields.some(key => typeof tolerance[key] !== 'number' || !Number.isFinite(tolerance[key]) ||
      tolerance[key] <= 0)) throw failure('INVALID_CRITERIA');
  if (!Number.isSafeInteger(value.maxRounds) || value.maxRounds <= 0) throw failure('INVALID_CRITERIA');
  return freeze({ targetTaskIds: targetIds,
    targetHitsRequired: absolute ? value.targetHitsRequired : null,
    targetHitsOverBaseline: relative ? value.targetHitsOverBaseline : null,
    targetRepeatsExpected: value.targetRepeatsExpected,
    regressionTaskIds: [...value.regressionTaskIds],
    costTolerance: { attemptsRatio: tolerance.attemptsRatio, tokensRatio: tolerance.tokensRatio },
    maxRounds: value.maxRounds });
}

function validateObservation(value) {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== observationFields.length ||
    observationFields.some(key => !Object.hasOwn(value, key))) throw failure('INVALID_OBSERVATION');
  if (!arms.has(value.arm)) throw failure('INVALID_OBSERVATION');
  if (typeof value.taskId !== 'string' || !value.taskId.trim()) throw failure('INVALID_OBSERVATION');
  if (!Number.isSafeInteger(value.repeat) || value.repeat <= 0) throw failure('INVALID_OBSERVATION');
  if (typeof value.gate !== 'boolean' || typeof value.incomplete !== 'boolean' ||
    typeof value.reportWritten !== 'boolean') throw failure('INVALID_OBSERVATION');
  if (!isCount(value.attempts) || !isCount(value.tokens)) throw failure('INVALID_OBSERVATION');
  return freeze({ arm: value.arm, taskId: value.taskId, repeat: value.repeat, gate: value.gate,
    attempts: value.attempts, tokens: value.tokens, incomplete: value.incomplete,
    reportWritten: value.reportWritten });
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function ratio(candidate, original) {
  if (original === 0) return candidate === 0 ? 1 : Number.POSITIVE_INFINITY;
  return candidate / original;
}

const judgedRecordTypes = new Set(['w2_ab_task', 'terminal_task']);

/**
 * Both carriers are ours to judge: the W2 ab record and the terminal-run record. A recognized record
 * whose task identity cannot be resolved is refused loudly — silently dropping it is exactly how a
 * whole batch of terminal runs once reached the controller as "no observations".
 */
function taskIdOf(record) {
  const taskId = record.record_type === 'terminal_task' ? record.terminal?.taskId : record.task_id;
  if (typeof taskId !== 'string' || !taskId.trim()) throw failure('INVALID_RECORD');
  return taskId;
}

/**
 * Collapse W2-shaped and terminal-run task records into loop observations. `gateTokens` maps a task id
 * to the pre-registered evidence tokens its gate requires; a record without gate tokens scores on its
 * own recorded mechanical result instead.
 */
export function collectObservations(records, { gateTokens = {} } = {}) {
  return records.filter(record => isRecord(record) && judgedRecordTypes.has(record.record_type))
    .map(record => {
      const taskId = taskIdOf(record);
      const text = `${record.final_text ?? ''}${record.report?.content ?? ''}`;
      const tokens = gateTokens[taskId];
      const gate = Array.isArray(tokens) && tokens.length > 0
        ? tokens.some(token => text.includes(token))
        : record.gate === true;
      return freeze({
        arm: record.arm,
        taskId,
        repeat: Number.isSafeInteger(record.repeat) ? record.repeat : 1,
        gate: gate === true,
        attempts: record.attempts?.settled ?? 0,
        tokens: (record.attempts?.observed_input_tokens ?? 0) + (record.attempts?.observed_output_tokens ?? 0),
        incomplete: record.incomplete === true,
        reportWritten: record.report?.written === true,
      });
    })
    .sort((left, right) => (left.taskId === right.taskId
      ? (left.arm === right.arm ? left.repeat - right.repeat : left.arm.localeCompare(right.arm))
      : left.taskId.localeCompare(right.taskId)));
}

/**
 * Resolve which baseline the round compares against. `original` and `none` are mutually exclusive
 * by construction, so the records themselves determine the baseline; an explicit choice may only
 * confirm what the records say, never contradict them.
 */
function resolveBaselineArm(observations, declared) {
  if (declared !== undefined && !baselineArms.includes(declared)) throw failure('INVALID_OBSERVATION');
  const seen = new Set(observations.map(item => item.arm));
  const baselinesSeen = baselineArms.filter(arm => seen.has(arm));
  if (baselinesSeen.length > 1) throw failure('INVALID_OBSERVATION');
  if (declared !== undefined && baselinesSeen.length === 1 && baselinesSeen[0] !== declared) {
    throw failure('INVALID_OBSERVATION');
  }
  return declared ?? baselinesSeen[0] ?? defaultBaselineArm;
}

export function judgeRound(options = {}) {
  const criteria = validateCriteria(options.criteria);
  const round = options.round;
  if (!Number.isSafeInteger(round) || round <= 0 || round > criteria.maxRounds) throw failure('INVALID_ROUND');
  const source = options.observations;
  if (!Array.isArray(source)) throw failure('INVALID_OBSERVATION');
  const observations = source.map(validateObservation);
  const baselineArm = resolveBaselineArm(observations, options.baselineArm);
  const roundsLeft = round < criteria.maxRounds;

  const target = observations.filter(item => criteria.targetTaskIds.includes(item.taskId));
  const targetFor = arm => target.filter(item => item.arm === arm);
  const candidateTarget = targetFor(candidateArm);
  const baselineTarget = targetFor(baselineArm);
  const regression = observations.filter(item => criteria.regressionTaskIds.includes(item.taskId));

  const metrics = {
    round,
    roundsLeft,
    baselineArm,
    targetHits: `${candidateTarget.filter(item => item.gate).length}/${candidateTarget.length}`,
    baselineHits: baselineTarget.filter(item => item.gate).length,
    requiredHits: criteria.targetHitsOverBaseline === null ? criteria.targetHitsRequired
      : baselineTarget.filter(item => item.gate).length + criteria.targetHitsOverBaseline,
    targetHitsOverBaseline: criteria.targetHitsOverBaseline,
    repeatsExpected: criteria.targetRepeatsExpected * criteria.targetTaskIds.length,
    targetTaskIds: [...criteria.targetTaskIds],
    attempts: { candidate: null, baseline: null, ratio: null },
    tokens: { candidate: null, baseline: null, ratio: null },
    costDegraded: false,
    costTolerance: criteria.costTolerance,
  };

  const incomplete = observations.filter(item => item.incomplete);
  const expectedTarget = criteria.targetRepeatsExpected * criteria.targetTaskIds.length;
  const missing = expectedTarget !== candidateTarget.length ||
    expectedTarget !== baselineTarget.length ||
    criteria.regressionTaskIds.some(id =>
      regression.filter(item => item.taskId === id && item.arm === candidateArm).length === 0 ||
      regression.filter(item => item.taskId === id && item.arm === baselineArm).length === 0);
  if (missing || incomplete.length > 0) {
    return freeze({ kind: 'inconclusive', reasons: ['EVIDENCE_INCOMPLETE'],
      detail: missing ? 'MISSING_OBSERVATIONS' : incomplete.map(item => `${item.arm}/${item.taskId}#${item.repeat}`),
      metrics, inputsDigest: digestOf(observations), criteriaDigest: digestOf(options.criteria) });
  }
  if (options.budgetExhausted === true) {
    return freeze({ kind: 'budget_stopped', reasons: ['BUDGET_EXHAUSTED'], metrics,
      inputsDigest: digestOf(observations), criteriaDigest: digestOf(options.criteria) });
  }

  const baselineRegression = criteria.regressionTaskIds.filter(id =>
    regression.some(item => item.taskId === id && item.arm === baselineArm && !item.gate));
  if (baselineRegression.length > 0) {
    return freeze({ kind: 'inconclusive', reasons: baselineRegression.map(id => `BASELINE_REGRESSION:${id}`),
      detail: 'THE_BASELINE_ARM_FAILED_ITS_OWN_REGRESSION_GATE', metrics,
      inputsDigest: digestOf(observations), criteriaDigest: digestOf(options.criteria) });
  }

  const candidateAll = observations.filter(item => item.arm === candidateArm);
  const baselineAll = observations.filter(item => item.arm === baselineArm);
  metrics.attempts = { candidate: median(candidateAll.map(item => item.attempts)),
    baseline: median(baselineAll.map(item => item.attempts)), ratio: null };
  metrics.tokens = { candidate: median(candidateAll.map(item => item.tokens)),
    baseline: median(baselineAll.map(item => item.tokens)), ratio: null };
  metrics.attempts.ratio = ratio(metrics.attempts.candidate, metrics.attempts.baseline);
  metrics.tokens.ratio = ratio(metrics.tokens.candidate, metrics.tokens.baseline);
  metrics.costDegraded = metrics.attempts.ratio > criteria.costTolerance.attemptsRatio ||
    metrics.tokens.ratio > criteria.costTolerance.tokensRatio;

  const hits = candidateTarget.filter(item => item.gate).length;
  const reasons = [];
  if (hits < metrics.requiredHits) reasons.push('TARGET_NOT_MET');
  const regressions = criteria.regressionTaskIds.filter(id =>
    regression.some(item => item.taskId === id && item.arm === candidateArm && !item.gate));
  if (regressions.length > 0) reasons.push(...regressions.map(id => `REGRESSION:${id}`));
  if (metrics.costDegraded) reasons.push('COST_DEGRADED');

  let kind;
  if (regressions.length > 0) {
    kind = 'reject';
  } else if (reasons.includes('TARGET_NOT_MET') || reasons.includes('COST_DEGRADED')) {
    if (roundsLeft) {
      kind = 'revise';
    } else {
      kind = 'reject';
      reasons.push('ROUNDS_EXHAUSTED');
    }
  } else {
    kind = 'accept';
  }
  return freeze({ kind, reasons, metrics,
    inputsDigest: digestOf(observations), criteriaDigest: digestOf(options.criteria) });
}

export async function recordRound({ root, verdict, now = Date.now } = {}) {
  if (typeof root !== 'string' || !root.trim()) throw failure('INVALID_ROUND_ROOT');
  if (!isRecord(verdict) || typeof verdict.kind !== 'string' || !verdict.kind.trim() ||
    !Number.isSafeInteger(verdict.metrics?.round)) throw failure('INVALID_VERDICT');
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    throw failure('INVALID_ROUND_ROOT', error);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw failure('INVALID_ROUND_ROOT');
  const directory = join(root, 'rounds');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `round-${verdict.metrics.round}.json`);
  try {
    await readFile(path, 'utf8');
    throw failure('ROUND_EXISTS');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const payload = { record_type: 'iteration_round', decidedAt: now(), ...verdict };
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(temporary, path);
  return freeze({ written: true, path, round: verdict.metrics.round, kind: verdict.kind });
}
