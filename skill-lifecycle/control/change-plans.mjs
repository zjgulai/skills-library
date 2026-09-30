import { createHash } from 'node:crypto';

/**
 * Merge and retire produce **plans only**. Nothing here touches the filesystem, the ledger or an
 * installed skill: applying a plan stays on the P3 enable/rollback channel, under the user's decision.
 */
const dispositionsInUse = Object.freeze(['promote', 'retain']);
const dispositionsOutOfUse = Object.freeze(['retire', 'merge', 'rollback']);
const headFields = ['skillId', 'version', 'disposition', 'dispositionId', 'decidedAt'];
const requiredHeadFields = ['skillId', 'version', 'disposition', 'decidedAt'];
const dependentFields = ['skillId', 'evidenceRef'];
const maxEvidenceRefs = 32;
const maxEvidenceRefChars = 500;
const idPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const execution = Object.freeze({ channel: 'enablement', automatic: false });

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
    return freeze({ skillId: entry.skillId, version: entry.version, disposition: entry.disposition,
      dispositionId: Object.hasOwn(entry, 'dispositionId') ? entry.dispositionId : null,
      decidedAt: entry.decidedAt });
  });
}

function identityOf(value, code) {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== 2 ||
    !Object.hasOwn(value, 'skillId') || !Object.hasOwn(value, 'version') ||
    typeof value.skillId !== 'string' || !idPattern.test(value.skillId) ||
    typeof value.version !== 'string' || !versionPattern.test(value.version)) throw failure(code);
  return { skillId: value.skillId, version: value.version };
}

function sameIdentity(left, right) {
  return left.skillId === right.skillId && left.version === right.version;
}

function validateEvidenceRefs(evidenceRefs) {
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0 ||
    evidenceRefs.length > maxEvidenceRefs ||
    evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim() || ref.length > maxEvidenceRefChars)) {
    throw failure('INVALID_EVIDENCE');
  }
  return [...evidenceRefs];
}

function validateDependents(dependents) {
  if (dependents === undefined) return [];
  if (!Array.isArray(dependents)) throw failure('INVALID_DEPENDENTS');
  return dependents.map(entry => {
    if (!isRecord(entry) || Reflect.ownKeys(entry).length !== dependentFields.length ||
      dependentFields.some(key => !Object.hasOwn(entry, key))) throw failure('INVALID_DEPENDENTS');
    if (typeof entry.skillId !== 'string' || !entry.skillId.trim() ||
      typeof entry.evidenceRef !== 'string' || !entry.evidenceRef.trim() ||
      entry.evidenceRef.length > maxEvidenceRefChars) throw failure('INVALID_DEPENDENTS');
    return freeze({ skillId: entry.skillId, evidenceRef: entry.evidenceRef });
  });
}

function validateMigration(migration, dependents) {
  if (dependents.length === 0) return null;
  if (migration === undefined || migration === null) throw failure('MIGRATION_REQUIRED');
  if (!isRecord(migration) || Reflect.ownKeys(migration).length !== 2 ||
    typeof migration.note !== 'string' || !migration.note.trim() ||
    typeof migration.evidenceRef !== 'string' || !migration.evidenceRef.trim()) {
    throw failure('MIGRATION_REQUIRED');
  }
  return freeze({ note: migration.note, evidenceRef: migration.evidenceRef });
}

function validateCommon(input, allowed) {
  if (!isRecord(input)) throw failure('INVALID_INPUT');
  if (Reflect.ownKeys(input).some(key => !allowed.includes(key))) throw failure('INVALID_INPUT');
  if (typeof input.reason !== 'string' || !input.reason.trim()) throw failure('INVALID_REASON');
  const now = input.now === undefined ? Date.now() : input.now;
  if (!Number.isSafeInteger(now) || now <= 0) throw failure('INVALID_NOW');
  return { heads: validateHeads(input.heads), evidenceRefs: validateEvidenceRefs(input.evidenceRefs),
    dependents: validateDependents(input.dependents),
    migration: validateMigration(input.migration, validateDependents(input.dependents)), now };
}

function headFor(heads, identity) {
  const head = heads.find(entry => sameIdentity(entry, identity));
  if (head === undefined) return freeze({ known: false, disposition: null, dispositionId: null });
  return freeze({ known: true, disposition: head.disposition, dispositionId: head.dispositionId });
}

function requireInUse(heads, identity, code) {
  const head = heads.find(entry => sameIdentity(entry, identity));
  if (head === undefined || !dispositionsInUse.includes(head.disposition)) throw failure(code);
}

function seal(planType, payload) {
  const body = { planType, ...payload };
  return freeze({ ...body, planId: createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex') });
}

/**
 * Retire a version. The plan must say what takes over the capability — a successor version, or an
 * explicit statement that the capability is dropped. "We'll figure it out later" is not a plan.
 */
export function planRetire(input = {}) {
  const common = validateCommon(input, ['heads', 'skillId', 'version', 'replacement', 'reason',
    'evidenceRefs', 'dependents', 'migration', 'now']);
  const target = identityOf({ skillId: input.skillId, version: input.version }, 'INVALID_TARGET');
  const head = common.heads.find(entry => sameIdentity(entry, target));
  if (head !== undefined && dispositionsOutOfUse.includes(head.disposition)) throw failure('ALREADY_OUT_OF_USE');

  const replacementInput = input.replacement;
  let replacement;
  if (isRecord(replacementInput) && replacementInput.drop === true) {
    if (Reflect.ownKeys(replacementInput).length !== 2 || typeof replacementInput.reason !== 'string' ||
      !replacementInput.reason.trim()) throw failure('REPLACEMENT_REQUIRED');
    replacement = freeze({ kind: 'drop', reason: replacementInput.reason });
  } else if (isRecord(replacementInput) && Reflect.ownKeys(replacementInput).length === 2 &&
    Object.hasOwn(replacementInput, 'skillId') && Object.hasOwn(replacementInput, 'version')) {
    const successor = identityOf(replacementInput, 'REPLACEMENT_REQUIRED');
    if (sameIdentity(successor, target)) throw failure('REPLACEMENT_REQUIRED');
    requireInUse(common.heads, successor, 'REPLACEMENT_NOT_IN_USE');
    replacement = freeze({ kind: 'successor', ...successor });
  } else {
    throw failure('REPLACEMENT_REQUIRED');
  }

  return seal('retire', {
    target,
    replacement,
    reason: input.reason,
    evidenceRefs: common.evidenceRefs,
    impact: { dependents: common.dependents, migration: common.migration },
    ledger: headFor(common.heads, target),
    execution,
    plannedAt: common.now,
  });
}

/**
 * Merge one version into another. Both directions of the reference are written into the plan, so a
 * reader of either side sees the same fact; the target must itself be a version in use.
 */
export function planMerge(input = {}) {
  const common = validateCommon(input, ['heads', 'source', 'target', 'reason', 'evidenceRefs',
    'dependents', 'migration', 'now']);
  const source = identityOf(input.source, 'INVALID_SOURCE');
  const target = identityOf(input.target, 'INVALID_TARGET');
  if (sameIdentity(source, target)) throw failure('MERGE_INTO_SELF');
  const sourceHead = common.heads.find(entry => sameIdentity(entry, source));
  if (sourceHead !== undefined && dispositionsOutOfUse.includes(sourceHead.disposition)) {
    throw failure('ALREADY_OUT_OF_USE');
  }
  requireInUse(common.heads, target, 'TARGET_NOT_IN_USE');

  return seal('merge', {
    source,
    target,
    references: {
      sourceToTarget: { from: source, mergedInto: target },
      targetToSource: { into: target, absorbs: [source] },
    },
    reason: input.reason,
    evidenceRefs: common.evidenceRefs,
    impact: { dependents: common.dependents, migration: common.migration },
    ledger: { source: headFor(common.heads, source), target: headFor(common.heads, target) },
    execution,
    plannedAt: common.now,
  });
}
