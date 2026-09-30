/**
 * Reconcile a change plan (from `change-plans`) with the governance ledger: has the decision the plan
 * proposes actually been recorded? The plan is a proposal, the ledger is the record, and this is the
 * check that keeps the two from drifting apart.
 *
 * Convention (deliberately exact, no fuzzy matching): a ledger entry counts as this plan's record only
 * when its `evidenceRefs` contains the plan's `planId` **verbatim**, the disposition equals the one the
 * plan asks for, and the decision is not older than the plan. Anything else is reported, not guessed.
 */
const planTypes = Object.freeze({ retire: 'retire', merge: 'merge' });
const historyFields = ['dispositionId', 'disposition', 'decidedAt', 'skillId', 'version', 'evidenceRefs'];
const idPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const maxEvidenceRefs = 64;

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

function identityOf(value) {
  if (!isRecord(value) || typeof value.skillId !== 'string' || !idPattern.test(value.skillId) ||
    typeof value.version !== 'string' || !versionPattern.test(value.version)) throw failure('INVALID_PLAN');
  return { skillId: value.skillId, version: value.version };
}

function readPlan(plan) {
  if (!isRecord(plan) || typeof plan.planType !== 'string' ||
    !Object.hasOwn(planTypes, plan.planType) ||
    typeof plan.planId !== 'string' || !digestPattern.test(plan.planId) ||
    !Number.isSafeInteger(plan.plannedAt) || plan.plannedAt <= 0) throw failure('INVALID_PLAN');
  const identity = identityOf(plan.planType === 'retire' ? plan.target : plan.source);
  return freeze({ planType: plan.planType, planId: plan.planId, plannedAt: plan.plannedAt, identity,
    expected: planTypes[plan.planType] });
}

function readHistory(history) {
  if (!Array.isArray(history)) throw failure('INVALID_HISTORY');
  return history.map(entry => {
    if (!isRecord(entry) || historyFields.some(key => !Object.hasOwn(entry, key))) {
      throw failure('INVALID_HISTORY');
    }
    if (typeof entry.dispositionId !== 'string' || !digestPattern.test(entry.dispositionId) ||
      typeof entry.disposition !== 'string' || !entry.disposition.trim() ||
      !Number.isSafeInteger(entry.decidedAt) || entry.decidedAt <= 0 ||
      typeof entry.skillId !== 'string' || !idPattern.test(entry.skillId) ||
      typeof entry.version !== 'string' || !versionPattern.test(entry.version) ||
      !Array.isArray(entry.evidenceRefs) || entry.evidenceRefs.length > maxEvidenceRefs ||
      entry.evidenceRefs.some(ref => typeof ref !== 'string')) throw failure('INVALID_HISTORY');
    return freeze({ dispositionId: entry.dispositionId, disposition: entry.disposition,
      decidedAt: entry.decidedAt, skillId: entry.skillId, version: entry.version,
      evidenceRefs: [...entry.evidenceRefs] });
  });
}

export function reconcilePlan({ plan, history } = {}) {
  const read = readPlan(plan);
  const entries = readHistory(history);
  const citations = entries.filter(entry => entry.evidenceRefs.includes(read.planId));
  if (citations.length === 0) {
    return freeze({ planId: read.planId, planType: read.planType, identity: read.identity,
      expectedDisposition: read.expected, status: 'pending', reasons: [], citations: 0, record: null });
  }
  const consistent = citations.find(entry => entry.disposition === read.expected &&
    entry.decidedAt >= read.plannedAt);
  if (consistent !== undefined) {
    return freeze({ planId: read.planId, planType: read.planType, identity: read.identity,
      expectedDisposition: read.expected, status: 'recorded', reasons: [], citations: citations.length,
      record: consistent });
  }
  const reasons = [];
  for (const entry of citations) {
    if (entry.disposition !== read.expected && !reasons.includes('DISPOSITION_MISMATCH')) {
      reasons.push('DISPOSITION_MISMATCH');
    }
    if (entry.decidedAt < read.plannedAt && !reasons.includes('RECORD_PREDATES_PLAN')) {
      reasons.push('RECORD_PREDATES_PLAN');
    }
  }
  return freeze({ planId: read.planId, planType: read.planType, identity: read.identity,
    expectedDisposition: read.expected, status: 'mismatched', reasons, citations: citations.length,
    record: null });
}
