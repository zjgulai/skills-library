import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * First-party record of "who depends on which skill version". The planners ask for `dependents`
 * as an input; this registry is where those facts come from instead of whoever writes the plan.
 * Append-only, and every line is sealed with a recomputable id so a quiet edit is not survivable.
 */
export const dependentKinds = Object.freeze(['terminal-set', 'task-set', 'candidate', 'install', 'skill']);
const recordFields = ['record_type', 'dependencyId', 'dependent', 'provider', 'evidenceRef', 'recordedAt'];
const dependentFields = ['kind', 'id'];
const providerFields = ['skillId', 'version'];
const maxEvidenceRefChars = 500;
const idPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
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

function dependencyIdOf(sealed) {
  return createHash('sha256').update(canonicalJson(sealed), 'utf8').digest('hex');
}

function validateProvider(provider) {
  if (!isRecord(provider) || Reflect.ownKeys(provider).length !== providerFields.length ||
    providerFields.some(key => !Object.hasOwn(provider, key))) throw failure('INVALID_DEPENDENCY');
  if (typeof provider.skillId !== 'string' || !idPattern.test(provider.skillId) ||
    typeof provider.version !== 'string' || !versionPattern.test(provider.version)) {
    throw failure('INVALID_DEPENDENCY');
  }
  return { skillId: provider.skillId, version: provider.version };
}

function validateDependent(dependent) {
  if (!isRecord(dependent) || Reflect.ownKeys(dependent).length !== dependentFields.length ||
    dependentFields.some(key => !Object.hasOwn(dependent, key))) throw failure('INVALID_DEPENDENCY');
  if (typeof dependent.kind !== 'string' || !dependentKinds.includes(dependent.kind) ||
    typeof dependent.id !== 'string' || !idPattern.test(dependent.id)) throw failure('INVALID_DEPENDENCY');
  return { kind: dependent.kind, id: dependent.id };
}

function sealFact(fact, now) {
  if (!isRecord(fact) ||
    Reflect.ownKeys(fact).some(key => !['dependent', 'provider', 'evidenceRef', 'recordedAt'].includes(key)) ||
    !Object.hasOwn(fact, 'dependent') || !Object.hasOwn(fact, 'provider') ||
    !Object.hasOwn(fact, 'evidenceRef')) throw failure('INVALID_DEPENDENCY');
  if (typeof fact.evidenceRef !== 'string' || !fact.evidenceRef.trim() ||
    fact.evidenceRef.length > maxEvidenceRefChars) throw failure('INVALID_DEPENDENCY');
  const recordedAt = fact.recordedAt === undefined ? now() : fact.recordedAt;
  if (!Number.isSafeInteger(recordedAt) || recordedAt <= 0) throw failure('INVALID_DEPENDENCY');
  return freeze({ record_type: 'skill_dependency', dependent: validateDependent(fact.dependent),
    provider: validateProvider(fact.provider), evidenceRef: fact.evidenceRef, recordedAt });
}

export async function openDependencyRegistry({ root, now = Date.now } = {}) {
  if (typeof root !== 'string' || !root.trim()) throw failure('INVALID_REGISTRY_ROOT');
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    throw failure('INVALID_REGISTRY_ROOT', error);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw failure('INVALID_REGISTRY_ROOT');
  const directory = join(root, 'governance');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'dependencies.jsonl');

  async function readEntries() {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const lines = text.split('\n').filter(line => line.length > 0);
    return lines.map((line, index) => {
      const number = index + 1;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        throw failure(`INVALID_RECORD: line ${number}`);
      }
      if (!isRecord(entry) || typeof entry.dependencyId !== 'string' ||
        !digestPattern.test(entry.dependencyId) ||
        Reflect.ownKeys(entry).length !== recordFields.length ||
        recordFields.some(key => !Object.hasOwn(entry, key))) throw failure(`INVALID_RECORD: line ${number}`);
      const { dependencyId, ...rest } = entry;
      let sealed;
      try {
        sealed = sealFact({ dependent: rest.dependent, provider: rest.provider,
          evidenceRef: rest.evidenceRef, recordedAt: rest.recordedAt }, now);
      } catch {
        throw failure(`INVALID_RECORD: line ${number}`);
      }
      if (rest.record_type !== 'skill_dependency' || dependencyIdOf(sealed) !== dependencyId) {
        throw failure(`DEPENDENCY_TAMPERED: line ${number}`);
      }
      return freeze({ dependencyId, ...sealed });
    });
  }

  async function record(fact) {
    const sealed = sealFact(fact, now);
    const entries = await readEntries();
    const dependencyId = dependencyIdOf(sealed);
    if (entries.some(entry => entry.dependencyId === dependencyId)) throw failure('DUPLICATE_DEPENDENCY');
    const line = { ...sealed, dependencyId };
    await appendFile(path, `${JSON.stringify(line)}\n`);
    return freeze(line);
  }

  async function list() {
    return freeze(await readEntries());
  }

  async function forProvider(provider) {
    const wanted = validateProvider(provider);
    const entries = await readEntries();
    return freeze(entries.filter(entry => entry.provider.skillId === wanted.skillId &&
      entry.provider.version === wanted.version));
  }

  return Object.freeze({ path, record, list, forProvider });
}

/**
 * The planner's `dependents` entries carry the dependent as `skillId` (the field was named for that
 * case). Dependents here are often not skills, so the reported identity is `<kind>-<id>` — the kind
 * stays visible instead of dissolving into a bare id.
 */
export async function dependentsOf({ registry, provider }) {
  const entries = await registry.forProvider(provider);
  return freeze(entries.map(entry => ({ skillId: `${entry.dependent.kind}-${entry.dependent.id}`,
    evidenceRef: entry.evidenceRef })));
}
