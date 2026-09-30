import { createHash } from 'node:crypto';
import { collectObservations } from './iteration-loop.mjs';

/**
 * A5 in its honest half: the machine reads the run records and states, per task, what actually
 * failed and whether the pre-registered criteria can even see a fix. The judgment (what to change)
 * stays with the author; `submitHypotheses` only holds that judgment to the readings it claims —
 * most importantly the lesson that a real improvement can sit outside the pre-registered criteria
 * and then never be scored, or adopted.
 */
const readingOrder = Object.freeze(['INCOMPLETE', 'REPORT_MISSING', 'GATE_MISSED', 'COST_OUTLIER']);
const hypothesisFields = ['taskId', 'claim', 'change', 'expectedEffect', 'criteriaImpact'];
const optionalHypothesisFields = ['coverageNote'];
const maxTextChars = 500;
const digestPattern = /^[a-f0-9]{64}$/;

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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digestOf(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function readCriteria(criteria) {
  if (!isRecord(criteria)) throw failure('INVALID_CRITERIA');
  const targets = Array.isArray(criteria.targetTaskIds) ? criteria.targetTaskIds
    : (typeof criteria.targetTaskId === 'string' ? [criteria.targetTaskId] : null);
  if (targets === null || !Array.isArray(criteria.regressionTaskIds) ||
    !isRecord(criteria.costTolerance) ||
    typeof criteria.costTolerance.attemptsRatio !== 'number' ||
    typeof criteria.costTolerance.tokensRatio !== 'number') throw failure('INVALID_CRITERIA');
  return freeze({ targets: [...targets], regressions: [...criteria.regressionTaskIds],
    tolerance: { attemptsRatio: criteria.costTolerance.attemptsRatio,
      tokensRatio: criteria.costTolerance.tokensRatio } });
}

const observationFields = ['arm', 'taskId', 'repeat', 'gate', 'attempts', 'tokens', 'incomplete',
  'reportWritten'];

function readObservations(value) {
  if (!Array.isArray(value)) throw failure('INVALID_OBSERVATION');
  return value.map(item => {
    if (!isRecord(item) || Reflect.ownKeys(item).length !== observationFields.length ||
      observationFields.some(key => !Object.hasOwn(item, key))) throw failure('INVALID_OBSERVATION');
    if (typeof item.arm !== 'string' || !item.arm.trim() ||
      typeof item.taskId !== 'string' || !item.taskId.trim() ||
      !Number.isSafeInteger(item.repeat) || item.repeat <= 0 ||
      typeof item.gate !== 'boolean' || typeof item.incomplete !== 'boolean' ||
      typeof item.reportWritten !== 'boolean' ||
      !Number.isSafeInteger(item.attempts) || item.attempts < 0 ||
      !Number.isSafeInteger(item.tokens) || item.tokens < 0) throw failure('INVALID_OBSERVATION');
    return freeze({ arm: item.arm, taskId: item.taskId, repeat: item.repeat, gate: item.gate,
      attempts: item.attempts, tokens: item.tokens, incomplete: item.incomplete,
      reportWritten: item.reportWritten });
  });
}

/**
 * `records` (via `collectObservations`) and `observations` are two ways in, never both: a judge-scored
 * run states the gate itself, and that judgement cannot be re-derived from evidence tokens.
 */
export function buildAttributionBrief({ records, observations, gateTokens = {}, criteria } = {}) {
  if ((records === undefined) === (observations === undefined)) throw failure('INVALID_INPUT');
  if (records !== undefined && !Array.isArray(records)) throw failure('INVALID_RECORDS');
  const read = readCriteria(criteria);
  const folded = observations === undefined
    ? collectObservations(records, { gateTokens })
    : readObservations(observations);
  const taskIds = [...new Set(folded.map(item => item.taskId))].sort();

  const failures = [];
  const ok = [];
  for (const taskId of taskIds) {
    const candidate = folded.filter(item => item.taskId === taskId && item.arm === 'candidate')
      .sort((left, right) => left.repeat - right.repeat);
    if (candidate.length === 0) continue;
    const baseline = folded.filter(item => item.taskId === taskId && item.arm !== 'candidate');
    const readings = new Set();
    if (candidate.some(item => item.incomplete)) readings.add('INCOMPLETE');
    if (candidate.some(item => !item.reportWritten)) readings.add('REPORT_MISSING');
    if (candidate.some(item => !item.gate)) readings.add('GATE_MISSED');
    if (baseline.length > 0) {
      const attemptsRatio = baseline.reduce((sum, item) => sum + item.attempts, 0) === 0 ? 1
        : median(candidate.map(item => item.attempts)) / median(baseline.map(item => item.attempts));
      const tokensRatio = baseline.reduce((sum, item) => sum + item.tokens, 0) === 0 ? 1
        : median(candidate.map(item => item.tokens)) / median(baseline.map(item => item.tokens));
      if (attemptsRatio > read.tolerance.attemptsRatio || tokensRatio > read.tolerance.tokensRatio) {
        readings.add('COST_OUTLIER');
      }
    }
    const covered = read.targets.includes(taskId) || read.regressions.includes(taskId);
    if (readings.size === 0) {
      ok.push(taskId);
      continue;
    }
    failures.push({ taskId, readings: readingOrder.filter(reading => readings.has(reading)),
      repeats: candidate.length, criteriaVisible: covered,
      evidence: { gates: candidate.map(item => item.gate),
        incomplete: candidate.map(item => item.incomplete),
        reportWritten: candidate.map(item => item.reportWritten),
        attempts: candidate.map(item => item.attempts), tokens: candidate.map(item => item.tokens) } });
  }

  const hidden = failures.filter(entry => !entry.criteriaVisible).map(entry => entry.taskId);
  const limits = [
    `样本：${taskIds.length} 道题 / ${folded.length} 条观测，不做显著性推断`,
    `成本口径：tokens 与尝试数，无价格依据`,
  ];
  if (hidden.length > 0) {
    limits.push(`${hidden.length} 道失败题不在预注册判据内（改进不会被计分）：${hidden.join('、')}`);
  }
  const brief = { failures, ok, sample: { tasks: taskIds.length, observations: folded.length },
    limits, hiddenFromCriteria: hidden, readingVocabulary: [...readingOrder] };
  return freeze({ ...brief, briefDigest: digestOf(brief) });
}

function readBrief(brief) {
  if (!isRecord(brief) || !Array.isArray(brief.failures) ||
    typeof brief.briefDigest !== 'string' || !digestPattern.test(brief.briefDigest)) {
    throw failure('INVALID_BRIEF');
  }
  const failing = new Map();
  for (const entry of brief.failures) {
    if (!isRecord(entry) || typeof entry.taskId !== 'string' || !Array.isArray(entry.readings) ||
      typeof entry.criteriaVisible !== 'boolean') throw failure('INVALID_BRIEF');
    failing.set(entry.taskId, entry);
  }
  return failing;
}

function validateText(value, code) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxTextChars) throw failure(code);
  return value;
}

export function submitHypotheses({ brief, hypotheses } = {}) {
  const failing = readBrief(brief);
  if (!Array.isArray(hypotheses)) throw failure('INVALID_HYPOTHESIS');
  const accepted = [];
  const waived = [];
  const seen = new Set();
  for (const entry of hypotheses) {
    if (!isRecord(entry) || typeof entry.taskId !== 'string') throw failure('INVALID_HYPOTHESIS');
    const keys = Reflect.ownKeys(entry);
    if (keys.some(key => ![...hypothesisFields, ...optionalHypothesisFields, 'waived', 'reason'].includes(key))) {
      throw failure('INVALID_HYPOTHESIS');
    }
    if (!failing.has(entry.taskId)) throw failure(`UNKNOWN_FAILURE: ${entry.taskId}`);
    if (seen.has(entry.taskId)) throw failure(`DUPLICATE_HYPOTHESIS: ${entry.taskId}`);
    seen.add(entry.taskId);
    if (entry.waived === true) {
      waived.push({ taskId: entry.taskId,
        reason: validateText(entry.reason, 'INVALID_HYPOTHESIS') });
      continue;
    }
    if (entry.waived !== undefined) throw failure('INVALID_HYPOTHESIS');
    if (hypothesisFields.some(key => !Object.hasOwn(entry, key))) throw failure('INVALID_HYPOTHESIS');
    if (entry.criteriaImpact !== 'covered' && entry.criteriaImpact !== 'not-covered') {
      throw failure('INVALID_HYPOTHESIS');
    }
    const fact = failing.get(entry.taskId);
    const expectedImpact = fact.criteriaVisible ? 'covered' : 'not-covered';
    if (entry.criteriaImpact !== expectedImpact) throw failure(`CRITERIA_CLAIM_MISMATCH: ${entry.taskId}`);
    let coverageNote = null;
    if (entry.criteriaImpact === 'not-covered') {
      coverageNote = validateText(entry.coverageNote, `COVERAGE_NOTE_REQUIRED: ${entry.taskId}`);
    } else if (entry.coverageNote !== undefined) {
      throw failure('INVALID_HYPOTHESIS');
    }
    accepted.push({ taskId: entry.taskId, claim: validateText(entry.claim, 'INVALID_HYPOTHESIS'),
      change: validateText(entry.change, 'INVALID_HYPOTHESIS'),
      expectedEffect: validateText(entry.expectedEffect, 'INVALID_HYPOTHESIS'),
      criteriaImpact: entry.criteriaImpact, coverageNote,
      readings: [...fact.readings] });
  }
  const unattributed = [...failing.keys()].filter(taskId => !seen.has(taskId)).sort();
  if (unattributed.length > 0) throw failure(`UNATTRIBUTED_TASKS: ${unattributed.join(',')}`);
  const order = (left, right) => left.taskId.localeCompare(right.taskId);
  const report = { hypotheses: accepted.sort(order), waived: waived.sort(order),
    coverageGaps: accepted.filter(entry => entry.criteriaImpact === 'not-covered')
      .map(entry => entry.taskId).sort(),
    briefDigest: brief.briefDigest };
  return freeze({ ...report, reportDigest: digestOf(report) });
}

/**
 * Hand one accepted hypothesis to the candidate as its declared wording. A fix the pre-registered
 * criteria cannot see must not ride in as if it would be scored — that was the P1 lesson, and this
 * is where it is mechanically enforced.
 */
export function toCandidateHypothesis({ report, taskId } = {}) {
  if (!isRecord(report) || !Array.isArray(report.hypotheses)) throw failure('INVALID_REPORT');
  const entry = report.hypotheses.find(item => item.taskId === taskId);
  if (entry === undefined) throw failure(`NOT_ATTRIBUTED: ${String(taskId)}`);
  if (entry.criteriaImpact === 'not-covered') throw failure(`COVERAGE_NOTE_REQUIRED: ${taskId}`);
  return freeze({ claim: entry.claim, expectedEffect: entry.expectedEffect });
}
