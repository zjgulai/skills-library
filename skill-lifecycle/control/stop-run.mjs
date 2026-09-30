const identityFields = [
  'runId', 'batchId', 'sessionId', 'skillDigest', 'inputDigest',
  'evaluatorDigest', 'environmentDigest', 'policyDigest',
];
const stops = new WeakMap();

function failure(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function isDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function validateIdentity(value) {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== identityFields.length) throw failure('INVALID_STOP_ARGS');
  const identity = {};
  for (const key of identityFields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string' || !descriptor.value.trim()) throw failure('INVALID_STOP_ARGS');
    if (key.endsWith('Digest') && !isDigest(descriptor.value)) throw failure('INVALID_STOP_ARGS');
    identity[key] = descriptor.value;
  }
  return identity;
}

function bounded(promise, waitMs) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(failure('WAIT_TIMEOUT')), waitMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function labelled(error, kind) {
  return error?.code === 'WAIT_TIMEOUT' ? `${kind}_timeout` : `${kind}_failed`;
}

function runTurn(fn) {
  return Promise.resolve().then(fn);
}

export async function stopRun({ run, binding, agent, io, reason, waitForIdle, waitMs, budget }) {
  const identity = validateIdentity(binding);
  if (typeof reason !== 'string' || !reason.trim()) throw failure('INVALID_STOP_ARGS');
  if (!Number.isSafeInteger(waitMs) || waitMs <= 0) throw failure('INVALID_STOP_ARGS');
  if (typeof waitForIdle !== 'function') throw failure('INVALID_STOP_ARGS');
  if (agent === null || typeof agent !== 'object' || typeof agent.id !== 'string' ||
    typeof agent.cancel !== 'function') {
    throw failure('INVALID_STOP_ARGS');
  }
  if (!isRecord(io) || typeof io.drain !== 'function') throw failure('INVALID_STOP_ARGS');
  if (budget !== undefined && (!isRecord(budget) || typeof budget.snapshot !== 'function')) {
    throw failure('INVALID_STOP_ARGS');
  }
  run.assertBinding(identity);
  const agentId = agent.id;
  const cancel = agent.cancel;
  const drain = io.drain;
  if (agentId !== identity.sessionId) throw failure('AGENT_SESSION_MISMATCH');

  const current = run.snapshot();
  if (current.status === 'stopped') {
    return freeze({ status: 'stopped', confirmed: true, cancelled: false, idempotent: true,
      agentId, reason: current.reason, failure: null, idle: null, drain: null });
  }
  if (current.status === 'completed') {
    return freeze({ status: 'completed', confirmed: true, cancelled: false, idempotent: true,
      agentId, reason: null, failure: null, idle: null, drain: null });
  }
  const existing = stops.get(run);
  if (existing) return existing;

  const operation = (async () => {
    const unconfirmed = async (label, { idle, drain: drainState, cancelled }) => {
      await run.markStopUnconfirmed(`${reason}:${label}`);
      return freeze({ status: 'stop_unconfirmed', confirmed: false, cancelled,
        idempotent: false, agentId, reason, failure: label, idle, drain: drainState });
    };
    if (current.status === 'prepared' || current.status === 'running') {
      try {
        await run.markStopping(reason);
      } catch (error) {
        throw failure('STOP_NOT_ADMITTED', error);
      }
    }
    try {
      await bounded(runTurn(() => cancel.call(agent, { kind: 'user' }, { keepInbox: false })), waitMs);
    } catch (error) {
      return unconfirmed(labelled(error, 'cancel'), { idle: 'not_attempted', drain: 'not_attempted', cancelled: false });
    }
    try {
      await bounded(runTurn(() => waitForIdle(agent)), waitMs);
    } catch (error) {
      return unconfirmed(labelled(error, 'idle'), { idle: 'unconfirmed', drain: 'not_attempted', cancelled: true });
    }
    try {
      await bounded(runTurn(() => drain.call(io)), waitMs);
    } catch (error) {
      return unconfirmed(labelled(error, 'drain'), { idle: 'confirmed', drain: 'unconfirmed', cancelled: true });
    }
    const details = { agentId, cancel: 'accepted', idle: 'confirmed', drain: 'drained' };
    if (budget !== undefined) {
      const snapshot = budget.snapshot();
      details.unresolvedAttempts = snapshot.attemptsReserved - snapshot.attemptsSettled;
      details.observedTokenTotal = snapshot.observedTokenTotal;
    }
    await run.markStopped(details);
    return freeze({ status: 'stopped', confirmed: true, cancelled: true, idempotent: false,
      agentId, reason: run.snapshot().reason, failure: null, idle: 'confirmed', drain: 'drained' });
  })().finally(() => stops.delete(run));
  stops.set(run, operation);
  return operation;
}

export async function completeRun({ run, binding, io, budget, details }) {
  const identity = validateIdentity(binding);
  if (!isRecord(io) || typeof io.drain !== 'function') throw failure('INVALID_STOP_ARGS');
  if (!isRecord(budget) || typeof budget.snapshot !== 'function') throw failure('INVALID_STOP_ARGS');
  let acceptance;
  try {
    if (!isRecord(details) || Reflect.ownKeys(details).length !== 1 ||
      !Object.hasOwn(details, 'acceptance')) throw failure('INVALID_ACCEPTANCE');
    const descriptor = Object.getOwnPropertyDescriptor(details, 'acceptance');
    const items = descriptor?.value;
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || !Array.isArray(items)) {
      throw failure('INVALID_ACCEPTANCE');
    }
    acceptance = [];
    const keys = Reflect.ownKeys(items).filter(key => key !== 'length');
    if (keys.length !== items.length || keys.some((key, index) => key !== String(index))) {
      throw failure('INVALID_ACCEPTANCE');
    }
    for (let index = 0; index < items.length; index += 1) {
      const item = Object.getOwnPropertyDescriptor(items, String(index));
      if (!item?.enumerable || !Object.hasOwn(item, 'value') ||
        typeof item.value !== 'string' || !item.value.trim()) throw failure('INVALID_ACCEPTANCE');
      acceptance.push(item.value);
    }
    if (acceptance.length === 0) throw failure('INVALID_ACCEPTANCE');
  } catch (error) {
    throw failure('INVALID_ACCEPTANCE', error);
  }
  const drain = io.drain;
  run.assertBinding(identity);
  if (run.snapshot().status === 'completed') {
    return freeze({ status: 'completed', confirmed: true, idempotent: true, acceptance: [] });
  }
  run.assertAdmitted(identity);
  const before = budget.snapshot();
  if (before.attempts.some(attempt => attempt.status === 'reserved')) throw failure('PENDING_REQUESTS');
  if (before.attemptsUnknown > 0) throw failure('UNRESOLVED_USAGE');
  try {
    await runTurn(() => drain.call(io));
  } catch (error) {
    throw failure('IO_NOT_DRAINED', error);
  }
  // Re-check after the drain, synchronously before markCompleted closes admission.
  const after = budget.snapshot();
  if (after.attempts.some(attempt => attempt.status === 'reserved')) throw failure('PENDING_REQUESTS');
  if (after.attemptsUnknown > 0) throw failure('UNRESOLVED_USAGE');
  if (after.revision !== before.revision) throw failure('LEDGER_ACTIVITY_DURING_COMPLETION');
  await run.markCompleted({ acceptance });
  return freeze({ status: 'completed', confirmed: true, idempotent: false, acceptance });
}
