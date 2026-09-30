import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const bindingFields = [
  'runId', 'batchId', 'sessionId', 'skillDigest', 'inputDigest',
  'evaluatorDigest', 'environmentDigest', 'policyDigest',
];
const statuses = new Set(['prepared', 'running', 'stopping', 'stopped', 'completed', 'stop_unconfirmed']);
const stateFields = ['schemaVersion', 'binding', 'status', 'revision', 'createdAt', 'updatedAt', 'reason', 'details'];

function failure(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function validateBinding(value) {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== bindingFields.length) throw failure('INVALID_BINDING');
  const identity = {};
  for (const key of bindingFields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string' || !descriptor.value.trim()) throw failure('INVALID_BINDING');
    if (key.endsWith('Digest') && !/^[a-f0-9]{64}$/.test(descriptor.value)) throw failure('INVALID_BINDING');
    identity[key] = descriptor.value;
  }
  return identity;
}

function sameBinding(left, right) {
  return bindingFields.every(key => left[key] === right[key]);
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function copyDetails(value) {
  const seen = new Set();
  function check(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if ((!Array.isArray(item) && !isRecord(item)) || seen.has(item)) throw failure('INVALID_DETAILS');
    const keys = Reflect.ownKeys(item).filter(key => key !== 'length' || !Array.isArray(item));
    if (Array.isArray(item) && (keys.length !== item.length ||
      keys.some((key, index) => key !== String(index)))) throw failure('INVALID_DETAILS');
    seen.add(item);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw failure('INVALID_DETAILS');
      }
      check(descriptor.value);
    }
    seen.delete(item);
  }
  if (!isRecord(value)) throw failure('INVALID_DETAILS');
  check(value);
  return JSON.parse(JSON.stringify(value));
}

function timestamp(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw failure('INVALID_CLOCK');
  return value;
}

function validateState(value) {
  try {
    if (!isRecord(value) || Object.keys(value).length !== stateFields.length ||
      !stateFields.every(key => Object.hasOwn(value, key)) || value.schemaVersion !== 1 ||
      !statuses.has(value.status) || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 ||
      !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.createdAt ||
      (value.reason !== null && (typeof value.reason !== 'string' || !value.reason.trim()))) {
      throw failure('INVALID_STATE');
    }
    validateBinding(value.binding);
    if (value.details !== null) copyDetails(value.details);
    if (['stopping', 'stopped', 'stop_unconfirmed'].includes(value.status) && value.reason === null) {
      throw failure('INVALID_STATE');
    }
    if (['prepared', 'running', 'completed'].includes(value.status) && value.reason !== null) {
      throw failure('INVALID_STATE');
    }
    if ((value.status === 'prepared' && value.revision !== 0) ||
      (value.status === 'running' && value.revision !== 1) ||
      (value.status === 'stopping' && ![1, 2].includes(value.revision)) ||
      (value.status === 'completed' && value.revision !== 2) ||
      (value.status === 'stop_unconfirmed' && ![2, 3].includes(value.revision)) ||
      (value.status === 'stopped' && ![2, 3, 4].includes(value.revision))) throw failure('INVALID_STATE');
    const hasDetails = ['stopped', 'completed'].includes(value.status);
    if (hasDetails ? value.details === null : value.details !== null) throw failure('INVALID_STATE');
    return freeze(value);
  } catch (error) {
    throw failure('INVALID_STATE', error);
  }
}

async function readRegular(path) {
  const expected = await lstat(path);
  if (!expected.isFile() || expected.nlink !== 1) throw failure('INVALID_STATE_FILE');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== expected.dev || stat.ino !== expected.ino) {
      throw failure('INVALID_STATE_FILE');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function openRun({ root, binding, now = Date.now }) {
  const identity = freeze(validateBinding(binding));
  const createdAt = timestamp(now);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw failure('INVALID_RUN_ROOT');
  const directory = await realpath(root);
  const statePath = join(directory, 'run-state.json');
  const lockPath = join(directory, '.run.lock');
  const owner = { ownerId: randomUUID(), pid: process.pid, runId: identity.runId, createdAt };
  let lock;
  try {
    lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw failure('RUN_LOCKED');
    throw error;
  }
  const lockStat = await lock.stat();
  let state;
  let storageFault;
  let closing = false;
  let closePromise;
  let queue = Promise.resolve();
  let pendingClosures = 0;
  let recoveryRequired = false;

  async function assertOwner() {
    const current = await lstat(lockPath);
    if (!current.isFile() || current.dev !== lockStat.dev || current.ino !== lockStat.ino ||
      JSON.parse(await readRegular(lockPath)).ownerId !== owner.ownerId) throw failure('RUN_LOCK_LOST');
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
    const tempPath = join(directory, `.run-state-${randomUUID()}.tmp`);
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
      await rename(tempPath, statePath);
      published = true;
      const parent = await open(directory, constants.O_RDONLY);
      try { await parent.sync(); } finally { await parent.close(); }
      state = freeze(next);
    } catch (error) {
      storageFault = error;
      throw failure('STATE_PERSIST_FAILED', error);
    } finally {
      if (handle) await handle.close();
      if (created && !published) await unlink(tempPath);
    }
  }

  try {
    await lock.writeFile(`${JSON.stringify(owner)}\n`);
    await lock.sync();
    let text;
    try {
      text = await readRegular(statePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw failure('INVALID_STATE', error);
    }
    if (text !== undefined) {
      try { state = validateState(JSON.parse(text)); } catch (error) { throw failure('INVALID_STATE', error); }
      if (!sameBinding(identity, state.binding)) throw failure('BINDING_MISMATCH');
      recoveryRequired = state.status === 'running';
    } else {
      await persist({ schemaVersion: 1, binding: identity, status: 'prepared', revision: 0,
        createdAt, updatedAt: createdAt, reason: null, details: null });
    }
  } catch (error) {
    if (storageFault) await lock.close();
    else await release();
    throw error;
  }

  function assertHealthy() {
    if (storageFault) throw failure('RUN_STORAGE_FAILED', storageFault);
  }

  function transition(target, allowed, payload = {}) {
    if (closing) return Promise.reject(failure('RUN_CLOSED'));
    const closesAdmission = target !== 'running';
    if (closesAdmission) pendingClosures += 1;
    const operation = queue.then(async () => {
      assertHealthy();
      if (state.status === target && ['stopping', 'stopped', 'stop_unconfirmed'].includes(target)) return state;
      if (!allowed.includes(state.status)) throw failure('INVALID_TRANSITION');
      if (recoveryRequired && target === 'completed') throw failure('RUN_RECOVERY_REQUIRED');
      try {
        await persist({ ...state, ...payload, status: target, revision: state.revision + 1,
          updatedAt: Math.max(timestamp(now), state.updatedAt) });
      } catch (error) {
        storageFault ??= error;
        throw error;
      }
      return state;
    }).finally(() => {
      if (closesAdmission) pendingClosures -= 1;
    });
    queue = operation.catch(() => {});
    return operation;
  }

  function reasonTransition(target, allowed, reason) {
    if (typeof reason !== 'string' || !reason.trim()) return Promise.reject(failure('INVALID_REASON'));
    return transition(target, allowed, { reason });
  }

  function detailsTransition(target, allowed, details) {
    let copied;
    try { copied = copyDetails(details); } catch (error) { return Promise.reject(error); }
    return transition(target, allowed, { details: copied });
  }

  return Object.freeze({
    start: () => transition('running', ['prepared']),
    markStopping: reason => reasonTransition('stopping', ['prepared', 'running'], reason),
    markStopped: details => detailsTransition('stopped', ['stopping', 'stop_unconfirmed'], details),
    markCompleted: details => detailsTransition('completed', ['running'], details),
    markStopUnconfirmed: reason => reasonTransition('stop_unconfirmed', ['stopping'], reason),
    assertBinding(candidate) {
      if (closing) throw failure('RUN_CLOSED');
      assertHealthy();
      if (!sameBinding(identity, validateBinding(candidate))) throw failure('BINDING_MISMATCH');
    },
    assertAdmitted(candidate) {
      if (closing) throw failure('RUN_CLOSED');
      assertHealthy();
      if (!sameBinding(identity, validateBinding(candidate))) throw failure('BINDING_MISMATCH');
      if (pendingClosures > 0 || state.status !== 'running') throw failure('RUN_NOT_RUNNING');
      if (recoveryRequired) throw failure('RUN_RECOVERY_REQUIRED');
    },
    snapshot: () => state,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = queue.then(async () => {
        // Retain the lock after an uncertain write so reopening cannot bypass reconciliation.
        if (storageFault) await lock.close();
        else await release();
      });
      return closePromise;
    },
  });
}
