import { lstatSync, renameSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const stateFile = 'batch-group.json';
const limitFields = ['maxAttempts', 'observedTokenStop', 'batchDeadlineMs'];
const entryStatuses = new Set(['reserved', 'settled', 'unknown', 'released']);
const usageFields = { inputTokens: false, outputTokens: false, cacheReadTokens: true, cacheWriteTokens: true };

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
  return Object.freeze(value);
}

function validateLimits(value) {
  if (!isRecord(value)) throw failure('INVALID_LIMITS');
  if (Reflect.ownKeys(value).length !== limitFields.length || limitFields.some(key => !Object.hasOwn(value, key))) {
    throw failure('INVALID_LIMITS');
  }
  const limits = {};
  for (const key of limitFields) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw failure('INVALID_LIMITS');
    limits[key] = value[key];
  }
  return freeze(limits);
}

function validateUsage(value) {
  if (!isRecord(value)) throw failure('INVALID_USAGE');
  const usage = {};
  for (const [key, optional] of Object.entries(usageFields)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      if (optional) continue;
      throw failure('INVALID_USAGE');
    }
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || !isCount(descriptor.value)) {
      throw failure('INVALID_USAGE');
    }
    usage[key] = descriptor.value;
  }
  if (Reflect.ownKeys(value).some(key => !Object.hasOwn(usageFields, key))) throw failure('INVALID_USAGE');
  return freeze(usage);
}

function validateEntry(value) {
  if (!isRecord(value) || typeof value.attemptId !== 'string' || !value.attemptId.trim() ||
    !entryStatuses.has(value.status) || !isCount(value.at)) throw failure('INVALID_GROUP_STATE');
  if (value.status === 'settled') {
    if (!isCount(value.settledAt)) throw failure('INVALID_GROUP_STATE');
    validateUsage(value.usage);
  } else if (value.usage !== null) {
    throw failure('INVALID_GROUP_STATE');
  }
  if (value.status === 'unknown' && (typeof value.reason !== 'string' || !value.reason.trim())) {
    throw failure('INVALID_GROUP_STATE');
  }
  return value;
}

function validateState(value, groupId, limits) {
  if (!isRecord(value) || value.groupId !== groupId) throw failure('GROUP_MISMATCH');
  if (JSON.stringify(value.limits) !== JSON.stringify(limits)) throw failure('GROUP_MISMATCH');
  if (!isCount(value.createdAt) || !isCount(value.updatedAt) || !isCount(value.revision) ||
    !Array.isArray(value.entries)) throw failure('INVALID_GROUP_STATE');
  const entries = value.entries.map(validateEntry);
  const ids = new Set(entries.map(entry => entry.attemptId));
  if (ids.size !== entries.length) throw failure('INVALID_GROUP_STATE');
  return { ...value, entries };
}

function deriveCounters(entries) {
  const counters = { attemptsDispatched: 0, attemptsSettled: 0, attemptsUnknown: 0, attemptsReleased: 0,
    observedInputTokens: 0, observedOutputTokens: 0 };
  for (const entry of entries) {
    if (entry.status === 'released') {
      counters.attemptsReleased += 1;
      continue;
    }
    counters.attemptsDispatched += 1;
    if (entry.status === 'settled') {
      counters.attemptsSettled += 1;
      counters.observedInputTokens += entry.usage.inputTokens;
      counters.observedOutputTokens += entry.usage.outputTokens;
    } else if (entry.status === 'unknown') {
      counters.attemptsUnknown += 1;
    }
  }
  return counters;
}

function receipt(entry, state, limits) {
  return freeze({ attemptId: entry.attemptId, status: entry.status,
    attemptsDispatched: state.attemptsDispatched,
    remainingAttempts: limits.maxAttempts - state.attemptsDispatched });
}

export async function openBatchGroup({ root, groupId, limits, now = Date.now } = {}) {
  if (typeof groupId !== 'string' || !groupId.trim()) throw failure('INVALID_GROUP_ID');
  const bounds = validateLimits(limits);
  if (typeof now !== 'function' || !isCount(now())) throw failure('INVALID_CLOCK');
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    throw failure('INVALID_GROUP_ROOT', error);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw failure('INVALID_GROUP_ROOT');
  const path = join(root, stateFile);

  const fresh = () => {
    const at = now();
    const state = { groupId, limits: bounds, createdAt: at, updatedAt: at, revision: 0, entries: [] };
    return { ...state, ...deriveCounters(state.entries) };
  };

  let state;
  try {
    state = validateState(JSON.parse(await readFile(path, 'utf8')), groupId, bounds);
    if (state.entries.some(entry => entry.status === 'reserved')) {
      const entries = state.entries.map(entry => entry.status === 'reserved'
        ? { ...entry, status: 'unknown', reason: 'group_recovered_in_flight' } : entry);
      state = { ...state, entries, ...deriveCounters(entries), revision: state.revision + 1 };
      await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
    }
    state = { ...state, ...deriveCounters(state.entries) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error.code === 'GROUP_MISMATCH' ? error : failure('INVALID_GROUP_STATE', error);
    state = fresh();
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
  }

  let queue = Promise.resolve();
  let closing = false;
  let storageFault = null;

  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  function assertHealthy() {
    if (storageFault) throw failure('GROUP_STORAGE_FAILED', storageFault);
  }

  async function persist(next) {
    const payload = { ...next, ...deriveCounters(next.entries), updatedAt: Math.max(now(), next.updatedAt),
      revision: next.revision + 1 };
    try {
      const temporary = `${path}.tmp`;
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`);
      renameSync(temporary, path);
    } catch (error) {
      storageFault = error;
      throw failure('GROUP_STORAGE_FAILED', error);
    }
    state = payload;
    return state;
  }

  function findEntry(attemptId) {
    const index = state.entries.findIndex(entry => entry.attemptId === attemptId);
    if (index === -1) throw failure('ATTEMPT_NOT_FOUND');
    return { index, entry: state.entries[index] };
  }

  function reserve(args) {
    const attemptId = args?.attemptId;
    if (typeof attemptId !== 'string' || !attemptId.trim()) {
      return Promise.reject(failure('INVALID_ATTEMPT'));
    }
    return enqueue(async () => {
      if (closing) throw failure('GROUP_CLOSED');
      assertHealthy();
      if (state.entries.some(entry => entry.attemptId === attemptId)) throw failure('ATTEMPT_ID_REUSED');
      if (state.attemptsUnknown > 0) throw failure('UNRESOLVED_USAGE');
      if (state.attemptsDispatched >= state.limits.maxAttempts) throw failure('ATTEMPTS_EXHAUSTED');
      if (state.observedInputTokens + state.observedOutputTokens >= state.limits.observedTokenStop) {
        throw failure('OBSERVED_TOKEN_STOP');
      }
      const at = now();
      if (at - state.createdAt >= state.limits.batchDeadlineMs) throw failure('BUDGET_DEADLINE_EXCEEDED');
      const entry = { attemptId, status: 'reserved', at, settledAt: null, usage: null, reason: null };
      await persist({ ...state, entries: [...state.entries, entry] });
      return receipt(entry, state, state.limits);
    });
  }

  function release(args) {
    const attemptId = args?.attemptId;
    if (typeof attemptId !== 'string' || !attemptId.trim()) {
      return Promise.reject(failure('INVALID_ATTEMPT'));
    }
    return enqueue(async () => {
      if (closing) throw failure('GROUP_CLOSED');
      assertHealthy();
      const { index, entry } = findEntry(attemptId);
      if (entry.status !== 'reserved') throw failure('ATTEMPT_NOT_RESERVED');
      const entries = state.entries.with(index, { ...entry, status: 'released' });
      await persist({ ...state, entries });
      return freeze({ attemptId, released: true, attemptsDispatched: state.attemptsDispatched });
    });
  }

  function settle(args) {
    let usage;
    try {
      usage = validateUsage(args?.usage);
      if (typeof args?.attemptId !== 'string' || !args.attemptId.trim()) throw failure('INVALID_ATTEMPT');
    } catch (error) {
      return Promise.reject(error);
    }
    const attemptId = args.attemptId;
    return enqueue(async () => {
      if (closing) throw failure('GROUP_CLOSED');
      assertHealthy();
      const { index, entry } = findEntry(attemptId);
      if (entry.status === 'released') throw failure('ATTEMPT_RELEASED');
      if (entry.status === 'unknown') throw failure('ATTEMPT_ALREADY_UNKNOWN');
      if (entry.status === 'settled') {
        if (entry.usage.inputTokens !== usage.inputTokens || entry.usage.outputTokens !== usage.outputTokens) {
          throw failure('USAGE_CONFLICT');
        }
        return receipt(entry, state, state.limits);
      }
      const settled = { ...entry, status: 'settled', settledAt: now(), usage };
      await persist({ ...state, entries: state.entries.with(index, settled) });
      return receipt(settled, state, state.limits);
    });
  }

  function markUnknown(args) {
    const attemptId = args?.attemptId;
    const reason = args?.reason;
    if (typeof attemptId !== 'string' || !attemptId.trim()) return Promise.reject(failure('INVALID_ATTEMPT'));
    if (typeof reason !== 'string' || !reason.trim()) return Promise.reject(failure('INVALID_REASON'));
    return enqueue(async () => {
      if (closing) throw failure('GROUP_CLOSED');
      assertHealthy();
      const { index, entry } = findEntry(attemptId);
      if (entry.status === 'released') throw failure('ATTEMPT_RELEASED');
      if (entry.status === 'settled') throw failure('ATTEMPT_ALREADY_SETTLED');
      if (entry.status === 'unknown') return receipt(entry, state, state.limits);
      const marked = { ...entry, status: 'unknown', reason };
      await persist({ ...state, entries: state.entries.with(index, marked) });
      return receipt(marked, state, state.limits);
    });
  }

  return Object.freeze({
    groupId,
    limits: state.limits,
    reserve,
    release,
    settle,
    markUnknown,
    snapshot: () => freeze({ groupId, limits: state.limits, createdAt: state.createdAt,
      updatedAt: state.updatedAt, revision: state.revision,
      attemptsDispatched: state.attemptsDispatched, attemptsSettled: state.attemptsSettled,
      attemptsUnknown: state.attemptsUnknown, attemptsReleased: state.attemptsReleased,
      observedInputTokens: state.observedInputTokens, observedOutputTokens: state.observedOutputTokens,
      observedTokenTotal: state.observedInputTokens + state.observedOutputTokens,
      entries: state.entries }),
    close() {
      closing = true;
      return queue;
    },
  });
}

export function composeBudget({ ledger, group }) {
  for (const [label, value, methods] of [['ledger', ledger, ['reserve', 'settle', 'markUnknown', 'snapshot']],
    ['group', group, ['reserve', 'release', 'settle', 'markUnknown', 'snapshot']]]) {
    if (!isRecord(value) || methods.some(method => typeof value[method] !== 'function')) {
      throw failure(`INVALID_COMPOSITE: ${label}`);
    }
  }
  return Object.freeze({
    async reserve(args) {
      await group.reserve(args);
      try {
        return await ledger.reserve(args);
      } catch (error) {
        await group.release(args).catch(() => undefined);
        throw error;
      }
    },
    async settle(args) {
      const receipt_ = await ledger.settle(args);
      try {
        await group.settle(args);
      } catch {
        // The ledger stays authoritative; the group keeps the reservation for the sticky-unknown path.
      }
      return receipt_;
    },
    async markUnknown(args) {
      const receipt_ = await ledger.markUnknown(args);
      try {
        await group.markUnknown(args);
      } catch {
        // Same as settle: a group-side refusal must not mask the ledger's decision.
      }
      return receipt_;
    },
    snapshot: () => freeze({ ...ledger.snapshot(), group: group.snapshot() }),
  });
}
