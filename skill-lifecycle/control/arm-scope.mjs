import { createHash } from 'node:crypto';

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The arms the evaluation chain knows. `original` and `none` both play the baseline role — an
 * existing skill compared against its frozen original, or a new skill compared against no skill
 * at all — and they are mutually exclusive, so a round can never silently mix the two.
 */
export const armVocabulary = Object.freeze(['original', 'none', 'candidate']);
export const baselineArms = Object.freeze(['original', 'none']);
export const candidateArm = 'candidate';

/**
 * Digest that stands for "no skill armed". The binding layer requires a digest for every run,
 * and a null would read as a missing field rather than a deliberate absence, so the no-skill arm
 * carries a sentinel any audit can recompute: sha256 of this fixed string, never a file's hash.
 */
export const noSkillDigest = sha256('arm-scope:no-skill-armed');

function failure(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

export function isArmed(arm) {
  if (!armVocabulary.includes(arm)) throw failure('INVALID_ARM');
  return arm !== 'none';
}

/** Validate a set's arm policy and return it in canonical order: baseline first, candidate second. */
export function normaliseArms(arms) {
  if (arms === undefined) return Object.freeze(['original', 'candidate']);
  if (!Array.isArray(arms) || arms.length !== 2 || arms.some(arm => !armVocabulary.includes(arm)) ||
    new Set(arms).size !== 2) throw failure('INVALID_ARMS');
  const baselines = arms.filter(arm => baselineArms.includes(arm));
  if (baselines.length !== 1 || !arms.includes(candidateArm)) throw failure('INVALID_ARMS');
  return Object.freeze([baselines[0], candidateArm]);
}

export function assertArmAllowed(arms, arm) {
  if (!Array.isArray(arms) || !arms.includes(arm)) throw failure(`ARM_NOT_ALLOWED: ${String(arm)}`);
  return arm;
}

/** Tool scope of a run: the no-skill arm has no `skill` tool at all, only the trial tools. */
export function toolScopeFor({ armed } = {}) {
  const trialTools = ['trial_read', 'trial_compute', 'trial_write_report'];
  return Object.freeze(armed === false ? [...trialTools] : ['skill', ...trialTools]);
}
