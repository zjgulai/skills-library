import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const dispositionVocabulary = Object.freeze(['promote', 'retain', 'retire', 'merge', 'rollback']);
const recordFields = ['record_type', 'skillId', 'version', 'disposition', 'evidenceRefs',
  'sourceDigests', 'previous', 'decidedAt'];
const inputFields = ['skillId', 'version', 'disposition', 'evidenceRefs', 'sourceDigests', 'previous'];
const maxEvidenceRefs = 32;
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

/** Key-sorted serialisation: the id must be recomputable from the file alone, whatever order it was written in. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  throw failure('INVALID_DISPOSITION');
}

/** Sealed id of a disposition payload; any auditor can recompute it from the ledger line. */
export function dispositionIdOf(payload) {
  if (!isRecord(payload)) throw failure('INVALID_DISPOSITION');
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

function validateSealed(value) {
  if (!isRecord(value)) throw failure('INVALID_DISPOSITION');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== recordFields.length || recordFields.some(key => !Object.hasOwn(value, key))) {
    throw failure('INVALID_DISPOSITION');
  }
  if (value.record_type !== 'governance_disposition') throw failure('INVALID_DISPOSITION');
  if (typeof value.skillId !== 'string' || !idPattern.test(value.skillId)) throw failure('INVALID_DISPOSITION');
  if (typeof value.version !== 'string' || !versionPattern.test(value.version)) throw failure('INVALID_DISPOSITION');
  if (!dispositionVocabulary.includes(value.disposition)) throw failure('INVALID_DISPOSITION');
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length === 0 ||
    value.evidenceRefs.length > maxEvidenceRefs ||
    value.evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim() ||
      ref.length > maxEvidenceRefChars)) throw failure('INVALID_DISPOSITION');
  if (!Array.isArray(value.sourceDigests) || value.sourceDigests.length === 0 ||
    value.sourceDigests.some(item => typeof item !== 'string' || !digestPattern.test(item))) {
    throw failure('INVALID_DISPOSITION');
  }
  if (value.previous !== null &&
    (typeof value.previous !== 'string' || !digestPattern.test(value.previous))) {
    throw failure('INVALID_DISPOSITION');
  }
  if (!Number.isSafeInteger(value.decidedAt) || value.decidedAt <= 0) throw failure('INVALID_DISPOSITION');
  return freeze({ record_type: value.record_type, skillId: value.skillId, version: value.version,
    disposition: value.disposition, evidenceRefs: [...value.evidenceRefs],
    sourceDigests: [...value.sourceDigests], previous: value.previous, decidedAt: value.decidedAt });
}

function sealInput(input, now) {
  if (!isRecord(input)) throw failure('INVALID_DISPOSITION');
  if (Reflect.ownKeys(input).some(key => !inputFields.includes(key) && key !== 'decidedAt')) {
    throw failure('INVALID_DISPOSITION');
  }
  if (inputFields.some(key => !Object.hasOwn(input, key))) throw failure('INVALID_DISPOSITION');
  return validateSealed({
    record_type: 'governance_disposition',
    skillId: input.skillId,
    version: input.version,
    disposition: input.disposition,
    evidenceRefs: input.evidenceRefs,
    sourceDigests: input.sourceDigests,
    previous: input.previous,
    decidedAt: input.decidedAt === undefined ? now() : input.decidedAt,
  });
}

/**
 * Replay the file into per-identity chains. Content is checked before meaning: a line that no longer
 * matches its sealed id is reported as tampering first, so a rewrite cannot masquerade as a typo.
 */
function analyse(lines) {
  const chains = new Map();
  const claimedParents = new Map();
  const ids = new Set();
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw failure(`INVALID_RECORD: line ${number}`);
    }
    if (!isRecord(entry) || typeof entry.dispositionId !== 'string' || !digestPattern.test(entry.dispositionId)) {
      throw failure(`INVALID_RECORD: line ${number}`);
    }
    const { dispositionId, ...rest } = entry;
    if (Reflect.ownKeys(rest).length !== recordFields.length ||
      recordFields.some(key => !Object.hasOwn(rest, key))) {
      throw failure(`INVALID_RECORD: line ${number}`);
    }
    if (dispositionIdOf(rest) !== dispositionId) throw failure(`LEDGER_TAMPERED: line ${number}`);
    const sealed = validateSealed(rest);
    if (ids.has(dispositionId)) throw failure(`DUPLICATE_DISPOSITION: line ${number}`);
    ids.add(dispositionId);
    const key = `${sealed.skillId}@${sealed.version}`;
    const chain = chains.get(key) ?? [];
    const head = chain.length === 0 ? null : chain[chain.length - 1].dispositionId;
    if (sealed.previous !== head) {
      // Two records naming the same parent is a fork (the root counts as a parent); naming a parent that
      // this chain never had is a break. Either way the ledger stops answering.
      const claimed = claimedParents.get(key) ?? new Set();
      const forked = claimed.has(sealed.previous);
      throw failure(`${forked ? 'CHAIN_FORK' : 'CHAIN_BROKEN'}: ${key} (line ${number})`);
    }
    const claimed = claimedParents.get(key) ?? new Set();
    claimed.add(sealed.previous);
    claimedParents.set(key, claimed);
    chain.push(freeze({ dispositionId, line: number, skillId: sealed.skillId, version: sealed.version,
      disposition: sealed.disposition, evidenceRefs: sealed.evidenceRefs, sourceDigests: sealed.sourceDigests,
      previous: sealed.previous, decidedAt: sealed.decidedAt }));
    chains.set(key, chain);
  }
  return { chains, ids };
}

export async function openGovernanceLedger({ root, now = Date.now } = {}) {
  if (typeof root !== 'string' || !root.trim()) throw failure('INVALID_LEDGER_ROOT');
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    throw failure('INVALID_LEDGER_ROOT', error);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw failure('INVALID_LEDGER_ROOT');
  const directory = join(root, 'governance');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'dispositions.jsonl');

  async function readLines() {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return text.split('\n').filter(line => line.length > 0);
  }

  async function read() {
    return analyse(await readLines());
  }

  async function append(input) {
    const sealed = sealInput(input, now);
    // The head is re-read from disk on every append, so a stale handle cannot fork the chain.
    const { chains, ids } = await read();
    const key = `${sealed.skillId}@${sealed.version}`;
    const chain = chains.get(key) ?? [];
    const head = chain.length === 0 ? null : chain[chain.length - 1].dispositionId;
    const dispositionId = dispositionIdOf(sealed);
    if (ids.has(dispositionId)) throw failure('DUPLICATE_DISPOSITION');
    if (sealed.previous !== head) throw failure(`CHAIN_CONFLICT: expected ${head ?? 'null'}`);
    const record = { ...sealed, dispositionId };
    await appendFile(path, `${JSON.stringify(record)}\n`);
    return freeze(record);
  }

  async function latestFor(skillId) {
    if (typeof skillId !== 'string' || !idPattern.test(skillId)) throw failure('INVALID_DISPOSITION');
    const { chains } = await read();
    const heads = [];
    for (const [key, chain] of chains) {
      const [owner] = key.split('@');
      if (owner !== skillId) continue;
      const last = chain[chain.length - 1];
      heads.push(freeze({ skillId: last.skillId, version: last.version, disposition: last.disposition,
        dispositionId: last.dispositionId, decidedAt: last.decidedAt }));
    }
    return freeze(heads.sort((left, right) => left.version.localeCompare(right.version)));
  }

  async function historyFor({ skillId, version } = {}) {
    if (typeof skillId !== 'string' || !idPattern.test(skillId) ||
      typeof version !== 'string' || !versionPattern.test(version)) throw failure('INVALID_DISPOSITION');
    const { chains } = await read();
    return freeze(chains.get(`${skillId}@${version}`) ?? []);
  }

  async function verify() {
    const { chains } = await read();
    const heads = [];
    for (const chain of chains.values()) {
      const last = chain[chain.length - 1];
      heads.push({ skillId: last.skillId, version: last.version, disposition: last.disposition,
        dispositionId: last.dispositionId, decidedAt: last.decidedAt });
    }
    return freeze({ ok: true, records: [...chains.values()].reduce((total, chain) => total + chain.length, 0),
      skills: [...new Set(heads.map(head => head.skillId))].sort(), heads });
  }

  return Object.freeze({ path, append, read, latestFor, historyFor, verify });
}
