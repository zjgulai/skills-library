const contractFields = ['need', 'triggers', 'inputs', 'outputs', 'constraints', 'outOfScope', 'openQuestions'];
const signalFields = ['recurring', 'existingSkillCovers', 'needsJudgment'];
const draftFields = contractFields.filter(field => field !== 'need');
const verdicts = Object.freeze({ draftable: 'draftable', needsUserInput: 'needs-user-input',
  notWorth: 'not-worth-skillifying' });
const maxItems = 12;
const maxChars = 500;

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

function requireText(value, code, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > maxChars) throw failure(code);
  if (!allowEmpty && !value.trim()) throw failure(code);
  return value;
}

function requireList(value, code, { allowEmpty = false } = {}) {
  const min = allowEmpty ? 0 : 1;
  if (!Array.isArray(value) || value.length < min || value.length > maxItems) throw failure(code);
  return value.map(item => requireText(item, code));
}

/**
 * Draft a skill contract from a requirement plus explicit decision signals.
 * The "not worth building" branch must be triggered by signals, never by reading the prose:
 * a one-off need, or a need an existing skill already covers, ends the intake here.
 */
export function draftContract({ requirement, signals, draft } = {}) {
  const need = requireText(requirement, 'INVALID_REQUIREMENT');
  if (!isRecord(signals) || Reflect.ownKeys(signals).length !== signalFields.length ||
    signalFields.some(key => typeof signals[key] !== 'boolean')) {
    throw failure('INVALID_SIGNALS');
  }
  const { recurring, existingSkillCovers, needsJudgment } = signals;
  const reasons = [];
  let verdict;
  if (existingSkillCovers) {
    verdict = verdicts.notWorth;
    reasons.push('EXISTING_SKILL_COVERS');
  } else if (!recurring) {
    verdict = verdicts.notWorth;
    reasons.push('ONE_OFF_NEED');
  } else if (draft === undefined) {
    verdict = verdicts.needsUserInput;
    reasons.push('CONTRACT_NOT_DRAFTED');
  } else {
    verdict = verdicts.draftable;
    if (!needsJudgment) reasons.push('NOTE_DETERMINISTIC_FLOW');
  }

  if (verdict !== verdicts.draftable) {
    return freeze({ verdict, reasons, need, signals: { ...signals }, contract: null });
  }

  if (!isRecord(draft) || Reflect.ownKeys(draft).length !== draftFields.length ||
    draftFields.some(key => !Object.hasOwn(draft, key))) {
    throw failure('INVALID_DRAFT');
  }
  const contract = {
    need,
    triggers: requireList(draft.triggers, 'INVALID_DRAFT'),
    inputs: requireList(draft.inputs, 'INVALID_DRAFT'),
    outputs: requireList(draft.outputs, 'INVALID_DRAFT'),
    constraints: requireList(draft.constraints, 'INVALID_DRAFT'),
    outOfScope: requireList(draft.outOfScope, 'INVALID_DRAFT', { allowEmpty: true }),
    openQuestions: requireList(draft.openQuestions, 'INVALID_DRAFT', { allowEmpty: true }),
  };
  const blocking = contract.openQuestions.filter(question => /^(BLOCKING|阻断)/i.test(question));
  if (blocking.length > 0) {
    return freeze({ verdict: verdicts.needsUserInput, reasons: ['OPEN_BLOCKING_QUESTIONS'],
      need, signals: { ...signals }, contract });
  }
  return freeze({ verdict, reasons, need, signals: { ...signals }, contract });
}
