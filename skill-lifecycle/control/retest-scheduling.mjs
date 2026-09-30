import { createHash } from 'node:crypto';

/** Only versions still in use need a value retest: retired, merged away or rolled-back versions do not. */
const dispositionsInUse = Object.freeze(['promote', 'retain']);
const dispositionsOutOfUse = Object.freeze(['retire', 'merge', 'rollback']);
const headFields = ['skillId', 'version', 'disposition', 'dispositionId', 'decidedAt'];
const requiredHeadFields = ['skillId', 'version', 'disposition', 'decidedAt'];
const driftFields = ['skillId', 'version', 'reason', 'observedAt'];
const maxDriftReasonChars = 500;
const idPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const dayMs = 86400000;

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

function validateHeads(heads) {
  if (!Array.isArray(heads)) throw failure('INVALID_HEADS');
  const seen = new Set();
  return heads.map(entry => {
    if (!isRecord(entry) || Reflect.ownKeys(entry).some(key => !headFields.includes(key)) ||
      requiredHeadFields.some(key => !Object.hasOwn(entry, key))) throw failure('INVALID_HEADS');
    if (typeof entry.skillId !== 'string' || !idPattern.test(entry.skillId) ||
      typeof entry.version !== 'string' || !versionPattern.test(entry.version)) throw failure('INVALID_HEADS');
    if (!dispositionsInUse.includes(entry.disposition) && !dispositionsOutOfUse.includes(entry.disposition)) {
      throw failure('INVALID_HEADS');
    }
    if (Object.hasOwn(entry, 'dispositionId') &&
      (typeof entry.dispositionId !== 'string' || !digestPattern.test(entry.dispositionId))) {
      throw failure('INVALID_HEADS');
    }
    if (!Number.isSafeInteger(entry.decidedAt) || entry.decidedAt <= 0) throw failure('INVALID_HEADS');
    const key = `${entry.skillId}@${entry.version}`;
    if (seen.has(key)) throw failure('INVALID_HEADS');
    seen.add(key);
    return freeze({ skillId: entry.skillId, version: entry.version, disposition: entry.disposition,
      decidedAt: entry.decidedAt });
  });
}

function validateDrift(observedDrift) {
  if (observedDrift === undefined) return [];
  if (!Array.isArray(observedDrift)) throw failure('INVALID_DRIFT');
  return observedDrift.map(entry => {
    if (!isRecord(entry) || Reflect.ownKeys(entry).length !== driftFields.length ||
      driftFields.some(key => !Object.hasOwn(entry, key))) throw failure('INVALID_DRIFT');
    if (typeof entry.skillId !== 'string' || !idPattern.test(entry.skillId) ||
      typeof entry.version !== 'string' || !versionPattern.test(entry.version)) throw failure('INVALID_DRIFT');
    if (typeof entry.reason !== 'string' || !entry.reason.trim() ||
      entry.reason.length > maxDriftReasonChars) throw failure('INVALID_DRIFT');
    if (!Number.isSafeInteger(entry.observedAt) || entry.observedAt <= 0) throw failure('INVALID_DRIFT');
    return freeze({ skillId: entry.skillId, version: entry.version, reason: entry.reason,
      observedAt: entry.observedAt });
  });
}

/**
 * Which recorded versions need a value retest. Pure logic: the caller reads the ledger itself
 * (`verify().heads`) and hands the heads over, so a ledger that cannot be vouched for never
 * reaches scheduling. Age is measured from the last decision, and a drift fact only counts when
 * it was observed strictly after that decision — a fact the decision already accounted for is not news.
 */
export function dueForRetest({ heads, now, maxAgeDays, observedDrift } = {}) {
  if (!Number.isSafeInteger(now) || now <= 0) throw failure('INVALID_NOW');
  if (typeof maxAgeDays !== 'number' || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    throw failure('INVALID_MAX_AGE');
  }
  const validatedHeads = validateHeads(heads);
  const drift = validateDrift(observedDrift);

  const headKeys = new Set(validatedHeads.map(entry => `${entry.skillId}@${entry.version}`));
  const due = [];
  const notDue = [];
  const excluded = [];
  for (const entry of validatedHeads) {
    const key = `${entry.skillId}@${entry.version}`;
    const facts = drift.filter(fact => `${fact.skillId}@${fact.version}` === key)
      .map(fact => ({ reason: fact.reason, observedAt: fact.observedAt }));
    const ageDays = (now - entry.decidedAt) / dayMs;
    const record = { skillId: entry.skillId, version: entry.version, disposition: entry.disposition,
      decidedAt: entry.decidedAt, ageDays };
    if (dispositionsOutOfUse.includes(entry.disposition)) {
      excluded.push({ ...record, reason: 'NOT_IN_USE', drift: facts });
      continue;
    }
    const fresh = facts.filter(fact => fact.observedAt > entry.decidedAt);
    const reasons = [];
    if (fresh.length > 0) reasons.push('DEPENDENCY_CHANGED');
    if (ageDays > maxAgeDays) reasons.push('AGE_EXCEEDED');
    if (reasons.length === 0) notDue.push(record);
    else due.push({ ...record, reasons, drift: fresh });
  }
  const unmatched = drift.filter(fact => !headKeys.has(`${fact.skillId}@${fact.version}`))
    .map(fact => ({ skillId: fact.skillId, version: fact.version, reason: fact.reason,
      observedAt: fact.observedAt }));

  const order = (left, right) => (left.skillId === right.skillId
    ? left.version.localeCompare(right.version) : left.skillId.localeCompare(right.skillId));
  return freeze({ asOf: now, maxAgeDays, headsDigest: createHash('sha256')
    .update(canonicalJson(validatedHeads), 'utf8').digest('hex'),
  due: due.sort(order), notDue: notDue.sort(order), excluded: excluded.sort(order),
  unmatched: unmatched.sort(order) });
}
