import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { openRun } from '../control/run-state.mjs';
import { makeTempCase } from './fixtures.mjs';

test('stopping persists and cannot restart', async (t) => {
  const f = await makeTempCase(t);
  let run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await run.start();
  await run.markStopping('budget_exhausted');
  assert.throws(() => run.assertAdmitted(f.binding), /RUN_NOT_RUNNING/);
  await run.close();
  run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  assert.equal(run.snapshot().status, 'stopping');
  await assert.rejects(run.start(), /INVALID_TRANSITION/);
});

test('prepared denies admission and successful start commits identity', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding, now: () => 1000 }));
  assert.throws(() => run.assertAdmitted(f.binding), /RUN_NOT_RUNNING/);
  await run.start();
  assert.doesNotThrow(() => run.assertAdmitted(f.binding));
  const disk = JSON.parse(await readFile(join(f.trusted, 'run-state.json'), 'utf8'));
  assert.deepEqual(disk.binding, f.binding);
  assert.equal(disk.status, 'running');
  assert.equal(disk.revision, 1);
  assert.equal(disk.createdAt, 1000);
  assert.equal(disk.updatedAt, 1000);
});

test('every binding field is required and compared for admission and reopen', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await run.start();
  for (const key of Object.keys(f.binding)) {
    const changed = { ...f.binding, [key]: key.endsWith('Digest') ? '0'.repeat(64) : 'different' };
    assert.throws(() => run.assertAdmitted(changed), /BINDING_MISMATCH/);
  }
  await run.markStopping('test');
  await run.close();
  for (const key of Object.keys(f.binding)) {
    const changed = { ...f.binding, [key]: key.endsWith('Digest') ? '0'.repeat(64) : 'different' };
    await assert.rejects(openRun({ root: f.trusted, binding: changed }), /BINDING_MISMATCH/);
  }
  const reopened = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  assert.equal(reopened.snapshot().status, 'stopping');
});

test('malformed bindings are rejected before creating files', async (t) => {
  const f = await makeTempCase(t);
  for (const key of Object.keys(f.binding)) {
    const missing = { ...f.binding };
    delete missing[key];
    await assert.rejects(openRun({ root: f.trusted, binding: missing }), /INVALID_BINDING/);
  }
  for (const binding of [null, [], { ...f.binding, runId: ' ' },
    { ...f.binding, skillDigest: 'not-a-hash' }, { ...f.binding, extra: true }]) {
    await assert.rejects(openRun({ root: f.trusted, binding }), /INVALID_BINDING/);
  }
  assert.deepEqual(await readdir(f.trusted), ['batch']);
});

test('input mutation and returned snapshots cannot alter admitted identity', async (t) => {
  const f = await makeTempCase(t);
  const input = { ...f.binding };
  const run = f.track(await openRun({ root: f.trusted, binding: input }));
  input.runId = 'mutated';
  const prepared = run.snapshot();
  assert.deepEqual(prepared.binding, f.binding);
  assert.throws(() => { prepared.binding.sessionId = 'mutated'; }, TypeError);
  await run.start();
  assert.doesNotThrow(() => run.assertAdmitted(f.binding));
  assert.equal(prepared.status, 'prepared');
  assert.notEqual(run.snapshot(), prepared);
});

test('only one concurrent opener can own a run and close releases its lock', async (t) => {
  const f = await makeTempCase(t);
  const results = await Promise.allSettled([
    openRun({ root: f.trusted, binding: f.binding }),
    openRun({ root: f.trusted, binding: f.binding }),
  ]);
  const successes = results.filter(r => r.status === 'fulfilled');
  for (const result of successes) f.track(result.value);
  assert.equal(successes.length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /RUN_LOCKED/);
  const run = successes[0].value;
  const lock = JSON.parse(await readFile(join(f.trusted, '.run.lock'), 'utf8'));
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.runId, f.binding.runId);
  assert.match(lock.ownerId, /^[0-9a-f-]{36}$/);
  await run.close();
  await run.close();
  const next = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await next.start();
  assert.doesNotThrow(() => next.assertAdmitted(f.binding));
});

test('an old lock is preserved rather than guessed stale', async (t) => {
  const f = await makeTempCase(t);
  const lockPath = join(f.trusted, '.run.lock');
  const old = JSON.stringify({ pid: 2147483647, ownerId: 'previous-owner', createdAt: 0 });
  await writeFile(lockPath, old);
  await assert.rejects(openRun({ root: f.trusted, binding: f.binding }), /RUN_LOCKED/);
  assert.equal(await readFile(lockPath, 'utf8'), old);
});

test('corrupt or invalid persisted state never becomes a new prepared run', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  const valid = run.snapshot();
  await run.close();
  const statePath = join(f.trusted, 'run-state.json');
  const invalid = ['{', 'null', JSON.stringify({ ...valid, status: 'anything' }),
    JSON.stringify({ ...valid, revision: -1 }), JSON.stringify({ ...valid, binding: {} })];
  for (const text of invalid) {
    await writeFile(statePath, text);
    await assert.rejects(openRun({ root: f.trusted, binding: f.binding }), /INVALID_STATE/);
    assert.equal(await readFile(statePath, 'utf8'), text);
    assert.equal((await readdir(f.trusted)).includes('.run.lock'), false);
  }
});

test('states follow explicit edges and terminal states cannot resume', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await assert.rejects(run.markStopped({}), /INVALID_TRANSITION/);
  await assert.rejects(run.markCompleted({}), /INVALID_TRANSITION/);
  await run.start();
  await assert.rejects(run.start(), /INVALID_TRANSITION/);
  await assert.rejects(run.markStopped({}), /INVALID_TRANSITION/);
  await run.markStopping('cancelled');
  await run.markStopped({ idleConfirmed: true });
  assert.throws(() => run.assertAdmitted(f.binding), /RUN_NOT_RUNNING/);
  await assert.rejects(run.start(), /INVALID_TRANSITION/);
  await assert.rejects(run.markCompleted({}), /INVALID_TRANSITION/);
  assert.equal(run.snapshot().reason, 'cancelled');
  await run.close();
  const next = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  assert.equal(next.snapshot().status, 'stopped');
  await assert.rejects(next.start(), /INVALID_TRANSITION/);
});

test('completion freezes caller details and is distinct from stopping', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await run.start();
  const details = { evidence: { id: 'public-evidence' } };
  await run.markCompleted(details);
  details.evidence.id = 'mutated';
  const state = run.snapshot();
  assert.equal(state.details.evidence.id, 'public-evidence');
  assert.throws(() => { state.details.evidence.id = 'modified'; }, TypeError);
  await assert.rejects(run.markStopping('late'), /INVALID_TRANSITION/);
  assert.throws(() => run.assertAdmitted(f.binding), /RUN_NOT_RUNNING/);
});

test('unconfirmed stop stays blocked across reopen', async (t) => {
  const f = await makeTempCase(t);
  let run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await run.start();
  await run.markStopping('deadline');
  await run.markStopUnconfirmed('idle_timeout');
  await run.close();
  run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  assert.equal(run.snapshot().status, 'stop_unconfirmed');
  assert.equal(run.snapshot().reason, 'idle_timeout');
  assert.throws(() => run.assertAdmitted(f.binding), /RUN_NOT_RUNNING/);
  await assert.rejects(run.start(), /INVALID_TRANSITION/);
});

test('close immediately blocks admission and cannot be used to keep writing', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await run.start();
  const closed = run.close();
  assert.throws(() => run.assertAdmitted(f.binding), /RUN_CLOSED/);
  await closed;
  await assert.rejects(run.markStopping('late'), /RUN_CLOSED/);
});

test('stop latches admission before its asynchronous write completes', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await run.start();
  const stopped = run.markStopping('cancelled');
  assert.throws(() => run.assertAdmitted(f.binding), /RUN_NOT_RUNNING/);
  await stopped;
  const repeated = run.snapshot();
  await run.markStopping('another reason');
  assert.deepEqual(run.snapshot(), repeated);
});

test('queued start cannot admit work after a concurrent stop request', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  const starting = run.start();
  const stopping = run.markStopping('cancelled');
  await starting;
  assert.throws(() => run.assertAdmitted(f.binding), /RUN_NOT_RUNNING/);
  await stopping;
  assert.equal(run.snapshot().status, 'stopping');
});

test('failed persistence blocks admission even after the filesystem recovers', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await run.start();
  const statePath = join(f.trusted, 'run-state.json');
  const committed = await readFile(statePath, 'utf8');
  await rm(statePath);
  await mkdir(statePath);
  await assert.rejects(run.markStopping('cancelled'), /STATE_PERSIST_FAILED/);
  assert.throws(() => run.assertAdmitted(f.binding), /RUN_STORAGE_FAILED/);
  assert.equal(run.snapshot().status, 'running');
  await rm(statePath, { recursive: true });
  await writeFile(statePath, committed);
  await assert.rejects(run.markCompleted({}), /RUN_STORAGE_FAILED/);
  assert.throws(() => run.assertAdmitted(f.binding), /RUN_STORAGE_FAILED/);
  assert.equal((await readdir(f.trusted)).some(name => name.endsWith('.tmp')), false);
});

test('reopening a previously running state requires recovery rather than admitting work', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await run.start();
  await run.close();
  const next = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  assert.throws(() => next.assertAdmitted(f.binding), /RUN_RECOVERY_REQUIRED/);
  await assert.rejects(next.start(), /INVALID_TRANSITION/);
  await next.markStopping('recovery');
  await next.markStopped({ checked: true });
  assert.equal(next.snapshot().status, 'stopped');
});

test('an invalid transition does not silently close a healthy run', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await run.start();
  await assert.rejects(run.markStopped({}), /INVALID_TRANSITION/);
  assert.doesNotThrow(() => run.assertAdmitted(f.binding));
  await assert.rejects(run.markStopUnconfirmed('not-stopping'), /INVALID_TRANSITION/);
  assert.doesNotThrow(() => run.assertAdmitted(f.binding));
  await run.markCompleted({ checked: true });
});

test('rejecting completion before start does not prevent a later start', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await assert.rejects(run.markCompleted({}), /INVALID_TRANSITION/);
  await run.start();
  assert.doesNotThrow(() => run.assertAdmitted(f.binding));
});

test('a queued stop prevents a later completion from overtaking it', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await run.start();
  const stopping = run.markStopping('cancelled');
  const completing = assert.rejects(run.markCompleted({ passed: true }), /INVALID_TRANSITION/);
  await Promise.all([stopping, completing]);
  assert.equal(run.snapshot().status, 'stopping');
  assert.equal(run.snapshot().revision, 2);
});

test('concurrent starts yield exactly one persisted transition', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  const results = await Promise.allSettled([run.start(), run.start()]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(run.snapshot().revision, 1);
  assert.doesNotThrow(() => run.assertAdmitted(f.binding));
});

test('non-JSON completion details are rejected without disabling admission', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await run.start();
  const cycle = {};
  cycle.self = cycle;
  const sparse = Array(1);
  const withSymbol = { [Symbol('hidden')]: 'not-json' };
  for (const details of [null, [], { x: undefined }, { x: Infinity }, { x: 1n },
    { x: () => true }, { x: new Date() }, cycle, { x: sparse }, withSymbol]) {
    await assert.rejects(run.markCompleted(details), /INVALID_DETAILS/);
    assert.doesNotThrow(() => run.assertAdmitted(f.binding));
    assert.equal(run.snapshot().revision, 1);
  }
});

test('invalid stop reasons leave the active run usable', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await run.start();
  for (const reason of ['', ' ', null, undefined, 1]) {
    await assert.rejects(run.markStopping(reason), /INVALID_REASON/);
    assert.doesNotThrow(() => run.assertAdmitted(f.binding));
  }
});

test('timestamps stay monotonic when the wall clock moves backwards', async (t) => {
  const f = await makeTempCase(t);
  let time = 2000;
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding, now: () => time }));
  time = 1000;
  await run.start();
  assert.equal(run.snapshot().createdAt, 2000);
  assert.equal(run.snapshot().updatedAt, 2000);
  time = 3000;
  await run.markStopping('done');
  assert.equal(run.snapshot().updatedAt, 3000);
});

test('structurally valid but impossible persisted states are rejected', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  const base = run.snapshot();
  await run.close();
  const statePath = join(f.trusted, 'run-state.json');
  for (const change of [
    { status: 'prepared', revision: 1 },
    { status: 'running', revision: 0 },
    { status: 'running', revision: 1, details: { passed: true } },
    { status: 'stopping', revision: 0, reason: 'stopped' },
    { status: 'stopped', revision: 2, reason: 'stopped', details: null },
    { status: 'completed', revision: 2, details: null },
  ]) {
    await writeFile(statePath, JSON.stringify({ ...base, ...change }));
    await assert.rejects(openRun({ root: f.trusted, binding: f.binding }), /INVALID_STATE/);
  }
});

test('binding accessors and hidden fields cannot redefine the frozen identity', async (t) => {
  const f = await makeTempCase(t);
  let called = false;
  const accessor = { ...f.binding };
  Object.defineProperty(accessor, 'runId', {
    enumerable: true,
    get() { called = true; return f.binding.runId; },
  });
  const hidden = { ...f.binding };
  Object.defineProperty(hidden, 'secret', { value: 'hidden' });
  const symbolic = { ...f.binding, [Symbol('extra')]: 'hidden' };
  for (const binding of [accessor, hidden, symbolic]) {
    await assert.rejects(openRun({ root: f.trusted, binding }), /INVALID_BINDING/);
  }
  assert.equal(called, false);
  assert.deepEqual(await readdir(f.trusted), ['batch']);
});

test('invalid clock before opening does not leave a lock', async (t) => {
  const f = await makeTempCase(t);
  for (const value of [-1, NaN, Infinity, 0.5]) {
    await assert.rejects(openRun({ root: f.trusted, binding: f.binding, now: () => value }), /INVALID_CLOCK/);
  }
  assert.deepEqual(await readdir(f.trusted), ['batch']);
});

test('a valid stop whose clock fails cannot silently restore admission', async (t) => {
  const f = await makeTempCase(t);
  let time = 1000;
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding, now: () => time }));
  await run.start();
  time = NaN;
  await assert.rejects(run.markStopping('cancelled'), /INVALID_CLOCK/);
  assert.throws(() => run.assertAdmitted(f.binding), /RUN_STORAGE_FAILED/);
  time = 2000;
  await assert.rejects(run.markCompleted({}), /RUN_STORAGE_FAILED/);
});

test('storage failure retains the lock across close and rejects reopen', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await run.start();
  const path = join(f.trusted, 'run-state.json');
  await rm(path);
  await mkdir(path);
  await assert.rejects(run.markStopping('cancelled'), /STATE_PERSIST_FAILED/);
  await run.close();
  await assert.rejects(openRun({ root: f.trusted, binding: f.binding }), /RUN_LOCKED/);
});

test('close never removes another owner lock', async (t) => {
  const f = await makeTempCase(t);
  const run = await openRun({ root: f.trusted, binding: f.binding });
  await run.start();
  const path = join(f.trusted, '.run.lock');
  await rm(path);
  const replacement = JSON.stringify({ ownerId: 'replacement', pid: process.pid });
  await writeFile(path, replacement);
  await assert.rejects(run.close(), /RUN_LOCK_LOST/);
  assert.equal(await readFile(path, 'utf8'), replacement);
  assert.throws(() => run.assertAdmitted(f.binding), /RUN_CLOSED/);
});

test('a lost lock aborts the next transition without changing committed state', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await run.start();
  const before = await readFile(join(f.trusted, 'run-state.json'), 'utf8');
  const path = join(f.trusted, '.run.lock');
  await rm(path);
  await writeFile(path, JSON.stringify({ ownerId: 'replacement' }));
  await assert.rejects(run.markCompleted({ checked: true }), /STATE_PERSIST_FAILED/);
  assert.equal(await readFile(join(f.trusted, 'run-state.json'), 'utf8'), before);
  assert.throws(() => run.assertAdmitted(f.binding), /RUN_STORAGE_FAILED/);
});

test('persisted state links are rejected without changing the external file', async (t) => {
  const f = await makeTempCase(t);
  const source = join(f.outside, 'sentinel.txt');
  const before = await readFile(source, 'utf8');
  const path = join(f.trusted, 'run-state.json');
  await symlink(source, path);
  await assert.rejects(openRun({ root: f.trusted, binding: f.binding }), /INVALID_STATE/);
  await rm(path);
  await link(source, path);
  await assert.rejects(openRun({ root: f.trusted, binding: f.binding }), /INVALID_STATE/);
  assert.equal(await readFile(source, 'utf8'), before);
  assert.equal((await readdir(f.trusted)).includes('.run.lock'), false);
});

// 子进程断言的是"不会永久挂住"，不是"必须多快完成"：全量并行时 node 冷启动 + 模块加载
// 可能超过 2s 而被 kill（间歇红签名：execFile killed:true）。放宽到 15s，语义不变。
const CHILD_TIMEOUT_MS = 15000;

test('state path type is checked before it can block on a FIFO', async (t) => {
  const f = await makeTempCase(t);
  const path = join(f.trusted, 'run-state.json');
  const runFile = promisify(execFile);
  await runFile('/usr/bin/mkfifo', [path]);
  const moduleUrl = new URL('../control/run-state.mjs', import.meta.url).href;
  const code = `import { openRun } from ${JSON.stringify(moduleUrl)};
    try { await openRun({root:process.argv[1],binding:JSON.parse(process.argv[2])}); process.exitCode=2; }
    catch(error) { console.log(error.code); }`;
  const result = await runFile(process.execPath, ['--input-type=module', '-e', code, f.trusted, JSON.stringify(f.binding)],
    { timeout: CHILD_TIMEOUT_MS });
  assert.equal(result.stdout.trim(), 'INVALID_STATE');
});

test('abrupt owner exit leaves its lock and does not permit a second run', async (t) => {
  const f = await makeTempCase(t);
  const moduleUrl = new URL('../control/run-state.mjs', import.meta.url).href;
  const code = `import { openRun } from ${JSON.stringify(moduleUrl)};
    const run=await openRun({root:process.argv[1],binding:JSON.parse(process.argv[2])});
    await run.start(); process.exit(0);`;
  await promisify(execFile)(process.execPath,
    ['--input-type=module', '-e', code, f.trusted, JSON.stringify(f.binding)], { timeout: CHILD_TIMEOUT_MS });
  await assert.rejects(openRun({ root: f.trusted, binding: f.binding }), /RUN_LOCKED/);
  const state = JSON.parse(await readFile(join(f.trusted, 'run-state.json'), 'utf8'));
  assert.equal(state.status, 'running');
});

test('readers observe complete JSON while transitions atomically publish', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  const statePath = join(f.trusted, 'run-state.json');
  let finished = false;
  const observed = [];
  const reader = (async () => {
    while (!finished) {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      assert.deepEqual(state.binding, f.binding);
      assert.ok(['prepared', 'running', 'stopping', 'stopped'].includes(state.status));
      observed.push(state.status);
    }
  })();
  try {
    await run.start();
    await run.markStopping('cancelled');
    await run.markStopped({ idleConfirmed: true });
  } finally {
    finished = true;
    await reader;
  }
  assert.ok(observed.length > 0);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).status, 'stopped');
});

test('close drains accepted writes before allowing another owner', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  const starting = run.start();
  const closing = run.close();
  await Promise.all([starting, closing]);
  const next = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  assert.equal(next.snapshot().status, 'running');
  assert.throws(() => next.assertAdmitted(f.binding), /RUN_RECOVERY_REQUIRED/);
});
