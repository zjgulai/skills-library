import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const identityFields = [
  'runId', 'batchId', 'sessionId', 'skillDigest', 'inputDigest',
  'evaluatorDigest', 'environmentDigest', 'policyDigest',
];
const limitFields = ['maxAttempts', 'maxOutputTokensPerAttempt', 'maxRequestBytes',
  'observedTokenStop', 'batchDeadlineMs', 'attemptTimeoutMs'];
const attemptFields = ['attemptId', 'attemptNumber', 'status', 'batchId', 'runId', 'sessionId',
  'skillDigest', 'inputDigest', 'evaluatorDigest', 'environmentDigest', 'policyDigest',
  'requestBytes', 'maxOutputTokens', 'reservedAt', 'settledAt', 'usage', 'reason'];
const usageFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const amendmentFields = ['at', 'reference', 'previousConfigDigest', 'nextConfigDigest',
  'previousPolicyDigest', 'nextPolicyDigest', 'previousEnvironmentDigest', 'nextEnvironmentDigest'];
const ledgerFields = ['schemaVersion', 'batchId', 'policyDigest', 'environmentDigest', 'configDigest', 'limits',
  'createdAt', 'updatedAt', 'revision', 'attemptsReserved', 'attemptsSettled', 'attemptsUnknown',
  'observedInputTokens', 'observedOutputTokens', 'observedCacheReadTokens', 'observedCacheWriteTokens',
  'amendments', 'attempts'];
const counterFields = ['attemptsReserved', 'attemptsSettled', 'attemptsUnknown',
  'observedInputTokens', 'observedOutputTokens', 'observedCacheReadTokens', 'observedCacheWriteTokens'];
const statuses = new Set(['reserved', 'settled', 'unknown']);

function failure(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function isDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function record(value, fields, code) {
  if (!isRecord(value)) throw failure(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length) throw failure(code);
  const copy = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw failure(code);
    }
    copy[key] = descriptor.value;
  }
  return copy;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function timestamp(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw failure('INVALID_CLOCK');
  return value;
}

function validateIdentity(value) {
  const identity = record(value, identityFields, 'INVALID_BINDING');
  for (const key of identityFields) {
    if (typeof identity[key] !== 'string' || !identity[key].trim()) throw failure('INVALID_BINDING');
    if (key.endsWith('Digest') && !isDigest(identity[key])) throw failure('INVALID_BINDING');
  }
  return identity;
}

function validateLimits(value) {
  let limits;
  try {
    limits = record(value, limitFields, 'INVALID_LIMITS');
  } catch (error) {
    throw failure('INVALID_LIMITS', error);
  }
  if (limitFields.some(key => !Number.isSafeInteger(limits[key]) || limits[key] <= 0)) {
    throw failure('INVALID_LIMITS');
  }
  return freeze(limits);
}

function configDigest(limits) {
  const canonical = Object.fromEntries([...limitFields].sort().map(key => [key, limits[key]]));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function validateUsage(value) {
  let usage;
  try {
    usage = isRecord(value) ? value : null;
    if (!usage) throw failure('INVALID_USAGE');
    const keys = Reflect.ownKeys(usage);
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(usage, key);
      if (typeof key !== 'string' || !usageFields.includes(key) || !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, 'value') || !isCount(descriptor.value)) throw failure('INVALID_USAGE');
      copy[key] = descriptor.value;
    }
    for (const required of ['inputTokens', 'outputTokens']) {
      if (!Object.hasOwn(copy, required)) throw failure('INVALID_USAGE');
    }
    return freeze({ inputTokens: copy.inputTokens, outputTokens: copy.outputTokens,
      ...(Object.hasOwn(copy, 'cacheReadTokens') ? { cacheReadTokens: copy.cacheReadTokens } : {}),
      ...(Object.hasOwn(copy, 'cacheWriteTokens') ? { cacheWriteTokens: copy.cacheWriteTokens } : {}) });
  } catch (error) {
    throw failure('INVALID_USAGE', error);
  }
}

function sameUsage(left, right) {
  return usageFields.every(key => (left[key] ?? null) === (right[key] ?? null));
}

function describeUsage(usage) {
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0, cacheWriteTokens: usage.cacheWriteTokens ?? 0 };
}

function deriveCounters(attempts) {
  const counters = { attemptsReserved: attempts.length, attemptsSettled: 0, attemptsUnknown: 0,
    observedInputTokens: 0, observedOutputTokens: 0, observedCacheReadTokens: 0, observedCacheWriteTokens: 0 };
  for (const attempt of attempts) {
    if (attempt.status === 'settled') {
      counters.attemptsSettled += 1;
      counters.observedInputTokens += attempt.usage.inputTokens;
      counters.observedOutputTokens += attempt.usage.outputTokens;
      counters.observedCacheReadTokens += attempt.usage.cacheReadTokens ?? 0;
      counters.observedCacheWriteTokens += attempt.usage.cacheWriteTokens ?? 0;
    } else if (attempt.status === 'unknown') {
      counters.attemptsUnknown += 1;
    }
  }
  return counters;
}

function validateAttempt(value, index) {
  const attempt = record(value, attemptFields, 'INVALID_LEDGER');
  if (typeof attempt.attemptId !== 'string' || !attempt.attemptId.trim() ||
    attempt.attemptNumber !== index + 1 || !statuses.has(attempt.status) ||
    typeof attempt.batchId !== 'string' || !attempt.batchId.trim() ||
    typeof attempt.runId !== 'string' || !attempt.runId.trim() ||
    typeof attempt.sessionId !== 'string' || !attempt.sessionId.trim() ||
    !['skillDigest', 'inputDigest', 'evaluatorDigest', 'environmentDigest', 'policyDigest']
      .every(key => isDigest(attempt[key])) ||
    !isCount(attempt.requestBytes) || !Number.isSafeInteger(attempt.maxOutputTokens) ||
    attempt.maxOutputTokens <= 0 || !isCount(attempt.reservedAt)) throw failure('INVALID_LEDGER');
  if (attempt.status === 'settled') {
    if (!isCount(attempt.settledAt) || attempt.reason !== null) throw failure('INVALID_LEDGER');
    validateUsage(attempt.usage);
  } else if (attempt.status === 'unknown') {
    if (attempt.usage !== null || typeof attempt.reason !== 'string' || !attempt.reason.trim() ||
      attempt.settledAt !== null) throw failure('INVALID_LEDGER');
  } else if (attempt.usage !== null || attempt.reason !== null || attempt.settledAt !== null) {
    throw failure('INVALID_LEDGER');
  }
  return attempt;
}

function validateLedger(value) {
  try {
    const ledger = record(value, ledgerFields, 'INVALID_LEDGER');
    if (ledger.schemaVersion !== 1 || typeof ledger.batchId !== 'string' || !ledger.batchId.trim() ||
      !isDigest(ledger.policyDigest) || !isDigest(ledger.environmentDigest) || !isDigest(ledger.configDigest) ||
      !isCount(ledger.createdAt) || !isCount(ledger.updatedAt) || ledger.updatedAt < ledger.createdAt ||
      !isCount(ledger.revision) || counterFields.some(key => !isCount(ledger[key])) ||
      !Array.isArray(ledger.amendments) || !Array.isArray(ledger.attempts)) throw failure('INVALID_LEDGER');
    const limits = validateLimits(ledger.limits);
    if (configDigest(limits) !== ledger.configDigest) throw failure('INVALID_LEDGER');
    let previous = null;
    for (const entry of ledger.amendments) {
      const amendment = record(entry, amendmentFields, 'INVALID_LEDGER');
      if (!isCount(amendment.at) || typeof amendment.reference !== 'string' || !amendment.reference.trim() ||
        !isDigest(amendment.previousConfigDigest) || !isDigest(amendment.nextConfigDigest) ||
        !isDigest(amendment.previousPolicyDigest) || !isDigest(amendment.nextPolicyDigest) ||
        !isDigest(amendment.previousEnvironmentDigest) || !isDigest(amendment.nextEnvironmentDigest)) {
        throw failure('INVALID_LEDGER');
      }
      if (previous && (amendment.previousConfigDigest !== previous.nextConfigDigest ||
        amendment.previousPolicyDigest !== previous.nextPolicyDigest ||
        amendment.previousEnvironmentDigest !== previous.nextEnvironmentDigest)) throw failure('INVALID_LEDGER');
      previous = amendment;
    }
    if (previous && (previous.nextConfigDigest !== ledger.configDigest ||
      previous.nextPolicyDigest !== ledger.policyDigest ||
      previous.nextEnvironmentDigest !== ledger.environmentDigest)) throw failure('INVALID_LEDGER');
    ledger.attempts.forEach((attempt, index) => validateAttempt(attempt, index));
    const derived = deriveCounters(ledger.attempts);
    if (counterFields.some(key => derived[key] !== ledger[key])) throw failure('INVALID_LEDGER');
    return { ...ledger, limits, ...derived };
  } catch (error) {
    throw failure('INVALID_LEDGER', error);
  }
}

function readRegular(path, code) {
  return (async () => {
    const expected = await lstat(path);
    if (!expected.isFile() || expected.nlink !== 1) throw failure(code);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== expected.dev || stat.ino !== expected.ino) {
        throw failure(code);
      }
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  })();
}

export async function openBudget({ run, binding, root, limits, now = Date.now, amendment }) {
  const identity = freeze(validateIdentity(binding));
  run.assertBinding(identity);
  const createdAt = timestamp(now);
  let amendmentRequest;
  if (amendment !== undefined) {
    const entry = record(amendment, ['reference'], 'INVALID_AMENDMENT');
    if (typeof entry.reference !== 'string' || !entry.reference.trim()) throw failure('INVALID_AMENDMENT');
    amendmentRequest = entry.reference;
  }
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw failure('INVALID_BUDGET_ROOT');
  const directory = await realpath(root);
  const ledgerPath = join(directory, 'budget-ledger.json');
  const lockPath = join(directory, '.budget.lock');
  const owner = { ownerId: randomUUID(), pid: process.pid, batchId: identity.batchId, createdAt };
  let lock;
  try {
    lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw failure('BUDGET_LOCKED');
    throw error;
  }
  const lockStat = await lock.stat();
  let state;
  let storageFault;
  let closing = false;
  let closePromise;
  let queue = Promise.resolve();

  async function assertOwner() {
    const current = await lstat(lockPath);
    if (!current.isFile() || current.dev !== lockStat.dev || current.ino !== lockStat.ino ||
      JSON.parse(await readRegular(lockPath, 'BUDGET_LOCK_LOST')).ownerId !== owner.ownerId) {
      throw failure('BUDGET_LOCK_LOST');
    }
  }

  async function release() {
    try {
      await assertOwner();
      await unlink(lockPath);
    } finally {
      await lock.close();
    }
  }

  async function persist(next) {
    const tempPath = join(directory, `.budget-ledger-${randomUUID()}.tmp`);
    let handle;
    let created = false;
    let published = false;
    try {
      await assertOwner();
      handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      created = true;
      await handle.writeFile(`${JSON.stringify(next)}\n`);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await assertOwner();
      await rename(tempPath, ledgerPath);
      published = true;
      const parent = await open(directory, constants.O_RDONLY);
      try { await parent.sync(); } finally { await parent.close(); }
      state = freeze(next);
    } catch (error) {
      storageFault = error;
      throw failure('BUDGET_PERSIST_FAILED', error);
    } finally {
      if (handle) await handle.close();
      if (created && !published) await unlink(tempPath);
    }
  }

  async function sweepTempFiles() {
    for (const name of await readdir(directory)) {
      if (!name.startsWith('.budget-ledger-') || !name.endsWith('.tmp')) continue;
      const candidate = join(directory, name);
      const stat = await lstat(candidate).catch(() => null);
      if (stat?.isFile() && stat.nlink === 1) await unlink(candidate);
    }
  }

  try {
    await lock.writeFile(`${JSON.stringify(owner)}\n`);
    await lock.sync();
    await sweepTempFiles();
    let text;
    try {
      text = await readRegular(ledgerPath, 'INVALID_LEDGER_FILE');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (text === undefined) {
      const initial = validateLimits(limits);
      await persist({ schemaVersion: 1, batchId: identity.batchId, policyDigest: identity.policyDigest,
        environmentDigest: identity.environmentDigest, configDigest: configDigest(initial),
        limits: initial, createdAt, updatedAt: createdAt,
        revision: 0, attemptsReserved: 0, attemptsSettled: 0, attemptsUnknown: 0,
        observedInputTokens: 0, observedOutputTokens: 0, observedCacheReadTokens: 0,
        observedCacheWriteTokens: 0, amendments: [], attempts: [] });
    } else {
      let loaded;
      try { loaded = validateLedger(JSON.parse(text)); } catch (error) { throw failure('INVALID_LEDGER', error); }
      if (loaded.batchId !== identity.batchId) throw failure('BATCH_MISMATCH');
      const nextLimits = limits === undefined ? loaded.limits : validateLimits(limits);
      const nextConfig = configDigest(nextLimits);
      const configChanged = nextConfig !== loaded.configDigest;
      const policyChanged = loaded.policyDigest !== identity.policyDigest;
      const environmentChanged = loaded.environmentDigest !== identity.environmentDigest;
      if (configChanged || policyChanged || environmentChanged) {
        if (amendmentRequest === undefined) throw failure('BUDGET_REVISION_REQUIRED');
        const at = Math.max(timestamp(now), loaded.updatedAt);
        await persist({ ...loaded, limits: nextLimits, configDigest: nextConfig,
          policyDigest: identity.policyDigest, environmentDigest: identity.environmentDigest,
          updatedAt: at, revision: loaded.revision + 1,
          amendments: [...loaded.amendments, { at, reference: amendmentRequest,
            previousConfigDigest: loaded.configDigest, nextConfigDigest: nextConfig,
            previousPolicyDigest: loaded.policyDigest, nextPolicyDigest: identity.policyDigest,
            previousEnvironmentDigest: loaded.environmentDigest,
            nextEnvironmentDigest: identity.environmentDigest }] });
      } else {
        state = freeze(loaded);
      }
    }
  } catch (error) {
    if (storageFault) await lock.close();
    else await release();
    throw error;
  }

  function assertHealthy() {
    if (storageFault) throw failure('BUDGET_STORAGE_FAILED', storageFault);
  }

  function enqueue(operation) {
    if (closing) return Promise.reject(failure('BUDGET_CLOSED'));
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  function receipt(attempt) {
    return freeze({ attemptId: attempt.attemptId, attemptNumber: attempt.attemptNumber,
      status: attempt.status, batchId: attempt.batchId, runId: attempt.runId,
      requestBytes: attempt.requestBytes, maxOutputTokens: attempt.maxOutputTokens,
      reservedAt: attempt.reservedAt, usage: attempt.usage === null ? null : describeUsage(attempt.usage) });
  }

  async function reconcileExpiredAttempt(at) {
    const index = state.attempts.findIndex(attempt => attempt.status === 'reserved');
    if (index === -1) return;
    const attempt = state.attempts[index];
    if (at - attempt.reservedAt < state.limits.attemptTimeoutMs) return;
    const attempts = state.attempts.with(index, { ...attempt, status: 'unknown', reason: 'attempt_timeout' });
    await persist({ ...state, attempts, ...deriveCounters(attempts),
      updatedAt: Math.max(at, state.updatedAt), revision: state.revision + 1 });
  }

  function reserve(args) {
    let request;
    try {
      request = record(args, ['attemptId', 'requestBytes', 'maxOutputTokens'], 'INVALID_ATTEMPT');
      if (typeof request.attemptId !== 'string' || !request.attemptId.trim() ||
        !isCount(request.requestBytes) || !Number.isSafeInteger(request.maxOutputTokens) ||
        request.maxOutputTokens <= 0) throw failure('INVALID_ATTEMPT');
    } catch (error) {
      return Promise.reject(error);
    }
    return enqueue(async () => {
      assertHealthy();
      run.assertBinding(identity);
      run.assertAdmitted(identity);
      const at = timestamp(now);
      if (state.attempts.some(attempt => attempt.attemptId === request.attemptId)) {
        throw failure('ATTEMPT_ID_REUSED');
      }
      await reconcileExpiredAttempt(at);
      if (state.attemptsUnknown > 0) throw failure('UNRESOLVED_USAGE');
      if (state.attempts.some(attempt => attempt.status === 'reserved')) throw failure('ATTEMPT_IN_FLIGHT');
      if (state.attemptsReserved >= state.limits.maxAttempts) throw failure('ATTEMPTS_EXHAUSTED');
      if (request.requestBytes > state.limits.maxRequestBytes) throw failure('REQUEST_TOO_LARGE');
      if (request.maxOutputTokens > state.limits.maxOutputTokensPerAttempt) throw failure('OUTPUT_TOO_LARGE');
      if (state.observedInputTokens + state.observedOutputTokens >= state.limits.observedTokenStop) {
        throw failure('OBSERVED_TOKEN_STOP');
      }
      if (at - state.createdAt >= state.limits.batchDeadlineMs) throw failure('BUDGET_DEADLINE_EXCEEDED');
      const attempt = { attemptId: request.attemptId, attemptNumber: state.attemptsReserved + 1,
        status: 'reserved', batchId: identity.batchId, runId: identity.runId, sessionId: identity.sessionId,
        skillDigest: identity.skillDigest, inputDigest: identity.inputDigest,
        evaluatorDigest: identity.evaluatorDigest, environmentDigest: identity.environmentDigest,
        policyDigest: identity.policyDigest, requestBytes: request.requestBytes,
        maxOutputTokens: request.maxOutputTokens, reservedAt: at, settledAt: null, usage: null, reason: null };
      const attempts = [...state.attempts, attempt];
      await persist({ ...state, attempts, ...deriveCounters(attempts),
        updatedAt: Math.max(at, state.updatedAt), revision: state.revision + 1 });
      return freeze({ ...receipt(attempt),
        remainingAttempts: state.limits.maxAttempts - state.attemptsReserved });
    });
  }

  function settle(args) {
    let request;
    try {
      request = record(args, ['attemptId', 'usage'], 'INVALID_USAGE');
      if (typeof request.attemptId !== 'string' || !request.attemptId.trim()) throw failure('INVALID_USAGE');
    } catch (error) {
      return Promise.reject(error);
    }
    return enqueue(async () => {
      assertHealthy();
      const index = state.attempts.findIndex(attempt => attempt.attemptId === request.attemptId);
      if (index === -1) throw failure('ATTEMPT_NOT_FOUND');
      const attempt = state.attempts[index];
      if (attempt.runId !== identity.runId || attempt.sessionId !== identity.sessionId) {
        throw failure('ATTEMPT_NOT_OWNED');
      }
      if (attempt.status === 'settled') {
        let usage;
        try { usage = validateUsage(request.usage); } catch (error) { throw failure('USAGE_CONFLICT', error); }
        if (!sameUsage(attempt.usage, usage)) throw failure('USAGE_CONFLICT');
        return freeze({ ...receipt(attempt), usage: describeUsage(attempt.usage),
          observedTokenTotal: state.observedInputTokens + state.observedOutputTokens });
      }
      let usage;
      try {
        usage = validateUsage(request.usage);
      } catch (error) {
        if (attempt.status === 'reserved') {
          const attempts = state.attempts.with(index, { ...attempt, status: 'unknown', reason: 'invalid_usage' });
          await persist({ ...state, attempts, ...deriveCounters(attempts),
            updatedAt: Math.max(timestamp(now), state.updatedAt), revision: state.revision + 1 });
        }
        throw error;
      }
      const at = timestamp(now);
      const attempts = state.attempts.with(index,
        { ...attempt, status: 'settled', usage, settledAt: at, reason: null });
      await persist({ ...state, attempts, ...deriveCounters(attempts),
        updatedAt: Math.max(at, state.updatedAt), revision: state.revision + 1 });
      return freeze({ ...receipt(state.attempts[index]), usage: describeUsage(usage),
        observedTokenTotal: state.observedInputTokens + state.observedOutputTokens });
    });
  }

  function markUnknown(args) {
    let request;
    try {
      request = record(args, ['attemptId', 'reason'], 'INVALID_REASON');
      if (typeof request.attemptId !== 'string' || !request.attemptId.trim() ||
        typeof request.reason !== 'string' || !request.reason.trim()) throw failure('INVALID_REASON');
    } catch (error) {
      return Promise.reject(error);
    }
    return enqueue(async () => {
      assertHealthy();
      const index = state.attempts.findIndex(attempt => attempt.attemptId === request.attemptId);
      if (index === -1) throw failure('ATTEMPT_NOT_FOUND');
      const attempt = state.attempts[index];
      if (attempt.runId !== identity.runId || attempt.sessionId !== identity.sessionId) {
        throw failure('ATTEMPT_NOT_OWNED');
      }
      if (attempt.status === 'settled') throw failure('ATTEMPT_ALREADY_SETTLED');
      if (attempt.status === 'unknown') return receipt(attempt);
      const attempts = state.attempts.with(index, { ...attempt, status: 'unknown', reason: request.reason });
      await persist({ ...state, attempts, ...deriveCounters(attempts),
        updatedAt: Math.max(timestamp(now), state.updatedAt), revision: state.revision + 1 });
      return receipt(attempts[index]);
    });
  }

  return Object.freeze({
    reserve,
    settle,
    markUnknown,
    snapshot: () => freeze({ ...state, limits: state.limits, amendments: state.amendments,
      attempts: state.attempts, observedTokenTotal: state.observedInputTokens + state.observedOutputTokens }),
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = queue.then(async () => {
        if (storageFault) await lock.close();
        else await release();
      });
      return closePromise;
    },
  });
}
