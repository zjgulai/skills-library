import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { link, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { openRun } from '../control/run-state.mjs';
import { openFiles } from '../control/bounded-files.mjs';
import { makeTempCase } from './fixtures.mjs';

async function prepare(t) {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await run.start();
  return { ...f, run, options: { run, binding: f.binding,
    inputRoot: f.inputs, skillRoot: f.skill, outputRoot: f.outputs,
    files: f.inputFiles, limits: { maxInputBytes: 4096, maxReportBytes: 4096 } } };
}

const digest = value => createHash('sha256').update(value).digest('hex');

test('approved IDs read a frozen snapshot rather than changed source files', async (t) => {
  const f = await prepare(t);
  const original = await readFile(join(f.inputs, 'report.md'));
  const io = f.track(await openFiles(f.options));
  await writeFile(join(f.inputs, 'report.md'), 'changed after opening');
  const result = await io.read({ fileId: 'report', offset: 0, limit: 100 });
  assert.equal(result.content, '公开分析样例：核对分组指标。\n');
  assert.equal(result.sha256, digest(original));
  assert.equal(result.totalBytes, original.length);
  assert.equal(result.truncated, false);
  await assert.rejects(io.read({ fileId: '../../outside/sentinel.txt', offset: 0, limit: 100 }), /FILE_NOT_ALLOWED/);
});

test('read accepts issued IDs only and never exposes filesystem paths', async (t) => {
  const f = await prepare(t);
  const io = f.track(await openFiles(f.options));
  for (const fileId of ['unknown', 'toString', '__proto__', join(f.outside, 'sentinel.txt'), '../report']) {
    await assert.rejects(io.read({ fileId, offset: 0, limit: 50 }), /FILE_NOT_ALLOWED/);
  }
  const manifest = io.manifest();
  assert.equal(manifest.length, 3);
  assert.ok(manifest.some(entry => entry.fileId === 'skill' && /^[a-f0-9]{64}$/.test(entry.sha256)));
  assert.equal(JSON.stringify(manifest).includes(f.root), false);
  assert.throws(() => { manifest[0].fileId = 'changed'; }, TypeError);
});

test('opening and each operation require the bound run to admit work', async (t) => {
  const f = await prepare(t);
  await assert.rejects(openFiles({ ...f.options, binding: { ...f.binding, sessionId: 'another' } }), /BINDING_MISMATCH/);
  const io = f.track(await openFiles(f.options));
  const stopping = f.run.markStopping('cancelled');
  await assert.rejects(io.read({ fileId: 'report', offset: 0, limit: 100 }), /RUN_NOT_RUNNING/);
  await assert.rejects(io.writeReport({ content: 'not allowed' }), /RUN_NOT_RUNNING/);
  assert.throws(() => io.manifest(), /RUN_NOT_RUNNING/);
  await stopping;
  await assert.rejects(openFiles(f.options), /RUN_NOT_RUNNING/);
});

test('read pagination uses Unicode code points while size uses UTF8 bytes', async (t) => {
  const f = await prepare(t);
  await writeFile(join(f.inputs, 'report.md'), 'A数学𝄞Z');
  const io = f.track(await openFiles(f.options));
  const page = await io.read({ fileId: 'report', offset: 1, limit: 3 });
  assert.equal(page.content, '数学𝄞');
  assert.equal(page.totalBytes, 12);
  assert.equal(page.truncated, true);
  assert.equal((await io.read({ fileId: 'report', offset: 4, limit: 100 })).content, 'Z');
  assert.equal((await io.read({ fileId: 'report', offset: 5, limit: 1 })).content, '');
});

test('invalid pagination and extra fields are rejected, not coerced', async (t) => {
  const f = await prepare(t);
  const io = f.track(await openFiles(f.options));
  for (const args of [null, {}, { fileId: 'report', offset: -1, limit: 2 },
    { fileId: 'report', offset: 0.1, limit: 2 }, { fileId: 'report', offset: 0, limit: 0 },
    { fileId: 'report', offset: '0', limit: 2 }, { fileId: 'report', offset: 0, limit: Infinity },
    { fileId: 'report', offset: 0, limit: 2, path: '/outside' }]) {
    await assert.rejects(io.read(args), /INVALID_READ/);
  }
});

test('roots must exist, be real distinct directories and not overlap', async (t) => {
  const f = await prepare(t);
  await mkdir(join(f.inputs, 'nested'));
  const alias = join(f.root, 'input-alias');
  await symlink(f.inputs, alias);
  for (const changes of [
    { outputRoot: f.inputs }, { outputRoot: join(f.inputs, 'nested') },
    { inputRoot: f.root }, { skillRoot: f.inputs },
    { inputRoot: alias }, { outputRoot: join(f.root, 'absent') },
    { outputRoot: join(f.inputs, 'report.md') },
  ]) await assert.rejects(openFiles({ ...f.options, ...changes }), /INVALID_ROOT|ROOTS_OVERLAP/);
});

test('file roles and containment reject prefix neighbors and traversal', async (t) => {
  const f = await prepare(t);
  const neighbor = `${f.inputs}-other`;
  await mkdir(neighbor);
  await writeFile(join(neighbor, 'secret.txt'), 'not approved');
  for (const file of [
    { fileId: 'x', role: 'input', path: join(neighbor, 'secret.txt') },
    { fileId: 'x', role: 'skill', path: join(f.inputs, 'report.md') },
    { fileId: 'x', role: 'input', path: `${f.inputs}/../outside/sentinel.txt` },
    { fileId: 'x', role: 'other', path: join(f.inputs, 'report.md') },
  ]) await assert.rejects(openFiles({ ...f.options, files: [file] }), /FILE_OUTSIDE_ROOT|INVALID_FILE/);
});

test('input symlinks and hardlinks cannot expose another file', async (t) => {
  const f = await prepare(t);
  const sentinel = join(f.outside, 'sentinel.txt');
  const linked = join(f.inputs, 'linked.txt');
  await symlink(sentinel, linked);
  await assert.rejects(openFiles({ ...f.options, files: [{ fileId: 'linked', path: linked, role: 'input' }] }), /UNSAFE_FILE/);
  await rm(linked);
  await link(sentinel, linked);
  await assert.rejects(openFiles({ ...f.options, files: [{ fileId: 'linked', path: linked, role: 'input' }] }), /UNSAFE_FILE/);
  assert.equal(await readFile(sentinel, 'utf8'), 'public-test-sentinel');
});

test('a symlink in an input parent is rejected even if target is inside the root', async (t) => {
  const f = await prepare(t);
  await mkdir(join(f.inputs, 'real'));
  await writeFile(join(f.inputs, 'real', 'value.txt'), 'same-root');
  await symlink(join(f.inputs, 'real'), join(f.inputs, 'alias'));
  await assert.rejects(openFiles({ ...f.options,
    files: [{ fileId: 'x', path: join(f.inputs, 'alias', 'value.txt'), role: 'input' }] }), /UNSAFE_FILE/);
});

test('input budget limits the aggregate snapshot, not only each file', async (t) => {
  const f = await prepare(t);
  const paths = [join(f.inputs, 'a.txt'), join(f.inputs, 'b.txt')];
  await Promise.all(paths.map(path => writeFile(path, '123456')));
  await assert.rejects(openFiles({ ...f.options,
    files: paths.map((path, i) => ({ fileId: `f${i}`, path, role: 'input' })),
    limits: { maxInputBytes: 10, maxReportBytes: 100 } }), /INPUT_TOO_LARGE/);
  assert.deepEqual(await readdir(f.outputs), []);
});

test('input lists and byte limits cannot be ambiguous or unbounded', async (t) => {
  const f = await prepare(t);
  for (const changes of [
    { files: [f.inputFiles[0], f.inputFiles[0]] },
    { files: [{ ...f.inputFiles[0], fileId: 'validation-report' }] },
    { files: [{ ...f.inputFiles[0], fileId: '../x' }] },
    { files: [{ ...f.inputFiles[0], fileId: '' }] },
    { files: [] }, { limits: {} },
    { limits: { maxInputBytes: 0, maxReportBytes: 100 } },
    { limits: { maxInputBytes: Infinity, maxReportBytes: 100 } },
  ]) await assert.rejects(openFiles({ ...f.options, ...changes }), /INVALID_FILE|DUPLICATE_FILE|INVALID_LIMIT/);
});

test('invalid UTF8 bytes are not silently replaced in snapshots', async (t) => {
  const f = await prepare(t);
  await writeFile(join(f.inputs, 'report.md'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(openFiles(f.options), /INVALID_UTF8/);
});

test('configuration mutation after opening cannot change identity or limits', async (t) => {
  const f = await prepare(t);
  const options = { ...f.options, binding: { ...f.binding }, limits: { ...f.options.limits },
    files: f.inputFiles.map(x => ({ ...x })) };
  const io = f.track(await openFiles(options));
  options.binding.sessionId = 'changed';
  options.files[0].path = join(f.outside, 'sentinel.txt');
  options.limits.maxReportBytes = Infinity;
  assert.equal((await io.read({ fileId: 'report', offset: 0, limit: 100 })).content, '公开分析样例：核对分组指标。\n');
  await assert.rejects(io.writeReport({ content: 'x'.repeat(4097) }), /REPORT_TOO_LARGE/);
});

test('only a fixed report is written and receipts match the committed bytes', async (t) => {
  const f = await prepare(t);
  const skillBefore = await readFile(join(f.skill, 'SKILL.md'));
  const io = f.track(await openFiles(f.options));
  const content = '# Validation\n需说明限制。\n';
  const receipt = await io.writeReport({ content });
  assert.deepEqual(receipt, { artifactId: 'validation-report', sha256: digest(content), bytes: Buffer.byteLength(content) });
  assert.equal(await readFile(join(f.outputs, 'validation-report.md'), 'utf8'), content);
  const readBack = await io.read({ fileId: 'validation-report', offset: 0, limit: 100 });
  assert.equal(readBack.content, content);
  assert.equal(readBack.sha256, receipt.sha256);
  assert.deepEqual(await readFile(join(f.skill, 'SKILL.md')), skillBefore);
  assert.equal(io.manifest().find(x => x.fileId === 'validation-report').sha256, receipt.sha256);
});

test('report arguments reject a caller path, invalid strings and byte overflow', async (t) => {
  const f = await prepare(t);
  const io = f.track(await openFiles({ ...f.options, limits: { maxInputBytes: 4096, maxReportBytes: 5 } }));
  for (const args of [null, {}, { content: 1 }, { content: 'x', path: '../outside' }, { content: '\ud800' }]) {
    await assert.rejects(io.writeReport(args), /INVALID_REPORT/);
  }
  await assert.rejects(io.writeReport({ content: '中文' }), /REPORT_TOO_LARGE/);
  await io.writeReport({ content: '字A' });
  assert.equal(await readFile(join(f.outputs, 'validation-report.md'), 'utf8'), '字A');
});

test('unknown existing reports are never overwritten', async (t) => {
  const f = await prepare(t);
  const io = f.track(await openFiles(f.options));
  const path = join(f.outputs, 'validation-report.md');
  await writeFile(path, 'someone else report');
  await assert.rejects(io.writeReport({ content: 'replacement' }), /REPORT_CONFLICT/);
  assert.equal(await readFile(path, 'utf8'), 'someone else report');
  await assert.rejects(io.read({ fileId: 'validation-report', offset: 0, limit: 100 }), /FILE_NOT_ALLOWED|IO_STORAGE_FAILED/);
});

test('output report symlinks cannot overwrite an external sentinel', async (t) => {
  const f = await prepare(t);
  const io = f.track(await openFiles(f.options));
  const target = join(f.outside, 'sentinel.txt');
  await symlink(target, join(f.outputs, 'validation-report.md'));
  await assert.rejects(io.writeReport({ content: 'replacement' }), /REPORT_CONFLICT/);
  assert.equal(await readFile(target, 'utf8'), 'public-test-sentinel');
});

test('only one file manager can own an output root at a time', async (t) => {
  const f = await prepare(t);
  const io = f.track(await openFiles(f.options));
  await assert.rejects(openFiles(f.options), /OUTPUT_LOCKED/);
  await io.close();
  const next = f.track(await openFiles(f.options));
  await next.writeReport({ content: 'new owner, previously empty output' });
});

test('updates replace this manager report but not externally modified reports', async (t) => {
  const f = await prepare(t);
  const io = f.track(await openFiles(f.options));
  await io.writeReport({ content: 'first' });
  const second = await io.writeReport({ content: 'second' });
  assert.equal(second.sha256, digest('second'));
  const path = join(f.outputs, 'validation-report.md');
  await writeFile(path, 'tamper');
  await assert.rejects(io.writeReport({ content: 'third' }), /REPORT_CONFLICT/);
  assert.equal(await readFile(path, 'utf8'), 'tamper');
});

test('concurrent writes are ordered and drain observes all accepted writes', async (t) => {
  const f = await prepare(t);
  const io = f.track(await openFiles(f.options));
  const writes = ['first', 'second', 'third'].map(content => io.writeReport({ content }));
  await io.drain();
  const receipts = await Promise.all(writes);
  assert.deepEqual(receipts.map(r => r.sha256), ['first', 'second', 'third'].map(digest));
  assert.equal(await readFile(join(f.outputs, 'validation-report.md'), 'utf8'), 'third');
  assert.equal((await readdir(f.outputs)).some(name => name.endsWith('.tmp')), false);
});

test('stop after enqueue prevents publication and success receipts', async (t) => {
  const f = await prepare(t);
  const io = f.track(await openFiles(f.options));
  const result = io.writeReport({ content: 'must not publish' });
  const rejected = assert.rejects(result, /RUN_NOT_RUNNING/);
  await Promise.all([f.run.markStopping('cancelled'), rejected]);
  await io.drain();
  assert.equal((await readdir(f.outputs)).includes('validation-report.md'), false);
});

test('close immediately blocks reads and cancels queued publications', async (t) => {
  const f = await prepare(t);
  const io = f.track(await openFiles(f.options));
  const write = io.writeReport({ content: 'pending' });
  const closed = io.close();
  await assert.rejects(write, /IO_CLOSED/);
  await assert.rejects(io.read({ fileId: 'report', offset: 0, limit: 100 }), /IO_CLOSED/);
  assert.throws(() => io.manifest(), /IO_CLOSED/);
  await closed;
  await io.close();
  assert.equal((await readdir(f.outputs)).includes('validation-report.md'), false);
});

test('stop during staging prevents rename and removes temporary output', async (t) => {
  const f = await prepare(t);
  let stopping;
  const proxy = {
    assertAdmitted(binding) {
      if (!stopping && readdirSync(f.outputs).some(name => name.endsWith('.tmp'))) {
        stopping = f.run.markStopping('cancelled_during_staging');
      }
      f.run.assertAdmitted(binding);
    },
  };
  const io = f.track(await openFiles({ ...f.options, run: proxy }));
  await assert.rejects(io.writeReport({ content: 'not published' }), /RUN_NOT_RUNNING/);
  await stopping;
  await io.drain();
  assert.equal((await readdir(f.outputs)).includes('validation-report.md'), false);
  assert.equal((await readdir(f.outputs)).some(name => name.endsWith('.tmp')), false);
});

test('stop after rename returns no success receipt and keeps uncertainty blocked', async (t) => {
  const f = await prepare(t);
  const target = join(f.outputs, 'validation-report.md');
  let stopping;
  const proxy = {
    assertAdmitted(binding) {
      if (!stopping && existsSync(target)) stopping = f.run.markStopping('cancelled_after_rename');
      f.run.assertAdmitted(binding);
    },
  };
  const io = f.track(await openFiles({ ...f.options, run: proxy }));
  await assert.rejects(io.writeReport({ content: 'committed without receipt' }), /RUN_NOT_RUNNING/);
  await stopping;
  assert.equal(await readFile(target, 'utf8'), 'committed without receipt');
  await assert.rejects(io.drain(), /IO_STORAGE_FAILED/);
  await io.close();
  assert.ok((await readdir(f.outputs)).includes('.files.lock'));
});

test('simultaneous openers cannot share the output publication lock', async (t) => {
  const f = await prepare(t);
  const attempts = await Promise.allSettled([openFiles(f.options), openFiles(f.options)]);
  const winners = attempts.filter(x => x.status === 'fulfilled');
  winners.forEach(x => f.track(x.value));
  assert.equal(winners.length, 1);
  assert.match(attempts.find(x => x.status === 'rejected').reason.message, /OUTPUT_LOCKED/);
});

test('report conflict blocks queued writes even when the conflict disappears', async (t) => {
  const f = await prepare(t);
  const io = f.track(await openFiles(f.options));
  const target = join(f.outputs, 'validation-report.md');
  await mkdir(target);
  const results = await Promise.allSettled([
    io.writeReport({ content: 'one' }), io.writeReport({ content: 'two' }),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /IO_STORAGE_FAILED/);
  await rm(target, { recursive: true });
  await assert.rejects(io.writeReport({ content: 'three' }), /IO_STORAGE_FAILED/);
  await assert.rejects(io.drain(), /IO_STORAGE_FAILED/);
});

test('a read snapshot remains valid after its disk source is removed', async (t) => {
  const f = await prepare(t);
  const io = f.track(await openFiles(f.options));
  await rm(join(f.inputs, 'report.md'));
  const value = await io.read({ fileId: 'report', offset: 0, limit: 100 });
  assert.equal(value.content, '公开分析样例：核对分组指标。\n');
});

test('invalid UTF8 and size failures do not claim the output lock', async (t) => {
  const f = await prepare(t);
  await writeFile(join(f.inputs, 'report.md'), Buffer.from([0xff]));
  await assert.rejects(openFiles(f.options), /INVALID_UTF8/);
  assert.deepEqual(await readdir(f.outputs), []);
  await writeFile(join(f.inputs, 'report.md'), 'x'.repeat(4097));
  await assert.rejects(openFiles(f.options), /INPUT_TOO_LARGE/);
  assert.deepEqual(await readdir(f.outputs), []);
});

test('non-regular inputs are rejected without waiting on FIFOs', async (t) => {
  const f = await prepare(t);
  const fifo = join(f.inputs, 'pipe');
  await promisify(execFile)('/usr/bin/mkfifo', [fifo]);
  for (const path of [fifo, f.inputs]) {
    await assert.rejects(openFiles({ ...f.options,
      files: [{ fileId: 'x', role: 'input', path }] }), /UNSAFE_FILE/);
  }
  assert.deepEqual(await readdir(f.outputs), []);
});

test('file configuration and request getters are rejected before invocation', async (t) => {
  const f = await prepare(t);
  let evaluated = false;
  const entry = { ...f.inputFiles[0] };
  Object.defineProperty(entry, 'path', { enumerable: true, get() { evaluated = true; return f.inputFiles[0].path; } });
  await assert.rejects(openFiles({ ...f.options, files: [entry] }), /INVALID_FILE/);
  const io = f.track(await openFiles(f.options));
  const args = { fileId: 'report', offset: 0, limit: 10 };
  Object.defineProperty(args, 'fileId', { enumerable: true, get() { evaluated = true; return 'report'; } });
  await assert.rejects(io.read(args), /INVALID_READ/);
  const report = {};
  Object.defineProperty(report, 'content', { enumerable: true, get() { evaluated = true; return 'x'; } });
  await assert.rejects(io.writeReport(report), /INVALID_REPORT/);
  assert.equal(evaluated, false);
});

test('empty approved files and BOM text keep faithful identities', async (t) => {
  const f = await prepare(t);
  await writeFile(join(f.inputs, 'report.md'), '');
  await writeFile(join(f.inputs, 'metrics.csv'), '\ufeffa,b\n1,2\n');
  const io = f.track(await openFiles(f.options));
  assert.deepEqual(await io.read({ fileId: 'report', offset: 0, limit: 1 }), {
    fileId: 'report', content: '', totalBytes: 0, sha256: digest(''), truncated: false,
  });
  assert.equal((await io.read({ fileId: 'metrics', offset: 0, limit: 1 })).content, '\ufeff');
});

test('invalid requests do not disable valid later report writes', async (t) => {
  const f = await prepare(t);
  const io = f.track(await openFiles(f.options));
  await assert.rejects(io.writeReport({ content: 'x'.repeat(4097) }), /REPORT_TOO_LARGE/);
  await assert.rejects(io.read({ fileId: 'report', offset: -1, limit: 1 }), /INVALID_READ/);
  const receipt = await io.writeReport({ content: '' });
  assert.equal(receipt.bytes, 0);
  assert.equal((await io.read({ fileId: 'validation-report', offset: 0, limit: 1 })).content, '');
});

test('exclusive temp creation collision must preserve the preexisting file', async (t) => {
  const f = await prepare(t);
  const io = f.track(await openFiles(f.options));
  const originalOpen = fs.open;
  let collision;
  try {
    fs.open = async (path, ...args) => {
      if (typeof path === 'string' && path.endsWith('.tmp') && !collision) {
        collision = path;
        await writeFile(path, 'preexisting temporary evidence');
      }
      return originalOpen(path, ...args);
    };
    syncBuiltinESMExports();
    await assert.rejects(io.writeReport({ content: 'new report' }), { code: 'EEXIST' });
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.ok(collision);
  assert.equal(await readFile(collision, 'utf8'), 'preexisting temporary evidence');
  assert.equal(existsSync(join(f.outputs, 'validation-report.md')), false);
});

for (const method of ['writeFile', 'sync']) {
  test(`failed output-lock ${method} releases only the new uninitialized lock`, async (t) => {
    const f = await prepare(t);
    const lockPath = join(f.outputs, '.files.lock');
    const originalOpen = fs.open;
    let injected = false;
    try {
      fs.open = async (path, ...args) => {
        const handle = await originalOpen(path, ...args);
        if (path === lockPath && !injected) {
          injected = true;
          handle[method] = async () => { throw Object.assign(new Error('test disk full'), { code: 'ENOSPC' }); };
        }
        return handle;
      };
      syncBuiltinESMExports();
      await assert.rejects(openFiles(f.options), /OUTPUT_LOCK_FAILED/);
    } finally {
      fs.open = originalOpen;
      syncBuiltinESMExports();
    }
    assert.equal(injected, true);
    assert.equal(existsSync(lockPath), false);
    const next = f.track(await openFiles(f.options));
    await next.writeReport({ content: 'storage recovered' });
  });
}

test('stopping during lock initialization rejects open and releases its new lock', async (t) => {
  const f = await prepare(t);
  const lockPath = join(f.outputs, '.files.lock');
  const originalOpen = fs.open;
  let triggered = false;
  try {
    fs.open = async (path, ...args) => {
      const handle = await originalOpen(path, ...args);
      if (path === lockPath && !triggered) {
        triggered = true;
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          await f.run.markStopping('stop_during_open');
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    await assert.rejects(openFiles(f.options), /RUN_NOT_RUNNING/);
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(triggered, true);
  assert.equal(existsSync(lockPath), false);
});

test('replaced output root is detected without writing into its replacement', async (t) => {
  const f = await prepare(t);
  const io = f.track(await openFiles(f.options));
  const moved = join(f.root, 'moved-output');
  await rename(f.outputs, moved);
  await mkdir(f.outputs);
  await assert.rejects(io.writeReport({ content: 'denied' }), /OUTPUT_ROOT_CHANGED/);
  await io.close();
  assert.deepEqual(await readdir(f.outputs), []);
  assert.deepEqual(await readdir(moved), ['.files.lock']);
});

test('hard-linked existing report cannot modify its external target', async (t) => {
  const f = await prepare(t);
  const io = f.track(await openFiles(f.options));
  const sentinel = join(f.outside, 'sentinel.txt');
  await link(sentinel, join(f.outputs, 'validation-report.md'));
  await assert.rejects(io.writeReport({ content: 'denied' }), /REPORT_CONFLICT/);
  assert.equal(await readFile(sentinel, 'utf8'), 'public-test-sentinel');
});

test('closed manager cannot adopt its previous report as a new run output', async (t) => {
  const f = await prepare(t);
  const io = f.track(await openFiles(f.options));
  await io.writeReport({ content: 'previous output' });
  await io.close();
  const next = f.track(await openFiles(f.options));
  await assert.rejects(next.read({ fileId: 'validation-report', offset: 0, limit: 100 }), /FILE_NOT_ALLOWED/);
  await assert.rejects(next.writeReport({ content: 'replacement' }), /REPORT_CONFLICT/);
  assert.equal(await readFile(join(f.outputs, 'validation-report.md'), 'utf8'), 'previous output');
});

test('close cannot unlink a replacement output lock', async (t) => {
  const f = await prepare(t);
  const io = await openFiles(f.options);
  const lockPath = join(f.outputs, '.files.lock');
  await rm(lockPath);
  await writeFile(lockPath, '{"ownerId":"different-owner"}');
  await assert.rejects(io.close(), /OUTPUT_LOCK_LOST/);
  assert.equal(await readFile(lockPath, 'utf8'), '{"ownerId":"different-owner"}');
});

test('lock initialization cleanup does not remove a lock belonging to someone else', async (t) => {
  const f = await prepare(t);
  const lockPath = join(f.outputs, '.files.lock');
  const originalOpen = fs.open;
  let triggered = false;
  try {
    fs.open = async (path, ...args) => {
      const handle = await originalOpen(path, ...args);
      if (path === lockPath && !triggered) {
        triggered = true;
        handle.sync = async () => {
          await rm(lockPath);
          await writeFile(lockPath, '{"ownerId":"replacement-after-failure"}');
          throw Object.assign(new Error('sync failed'), { code: 'EIO' });
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    await assert.rejects(openFiles(f.options), /OUTPUT_LOCK_FAILED/);
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(lockPath, 'utf8'), '{"ownerId":"replacement-after-failure"}');
});

test('output-root replacement during input capture cannot acquire a lock in the new directory', async (t) => {
  const f = await prepare(t);
  const originalOpen = fs.open;
  const displaced = join(f.root, 'displaced-output');
  let replaced = false;
  try {
    fs.open = async (path, ...args) => {
      const handle = await originalOpen(path, ...args);
      if (path === join(f.inputs, 'report.md') && !replaced) {
        replaced = true;
        await rename(f.outputs, displaced);
        await mkdir(f.outputs);
      }
      return handle;
    };
    syncBuiltinESMExports();
    await assert.rejects(openFiles(f.options), /OUTPUT_ROOT_CHANGED/);
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(replaced, true);
  assert.deepEqual(await readdir(f.outputs), []);
  assert.deepEqual(await readdir(displaced), []);
});

test('directory sync failure after rename is not reported as a successful artifact', async (t) => {
  const f = await prepare(t);
  const io = f.track(await openFiles(f.options));
  const originalOpen = fs.open;
  let injected = false;
  try {
    fs.open = async (path, ...args) => {
      const handle = await originalOpen(path, ...args);
      if (path === f.outputs && !injected) {
        injected = true;
        handle.sync = async () => { throw Object.assign(new Error('directory sync failed'), { code: 'EIO' }); };
      }
      return handle;
    };
    syncBuiltinESMExports();
    await assert.rejects(io.writeReport({ content: 'unconfirmed publication' }), { code: 'EIO' });
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  assert.equal(await readFile(join(f.outputs, 'validation-report.md'), 'utf8'), 'unconfirmed publication');
  await assert.rejects(io.drain(), /IO_STORAGE_FAILED/);
  await io.close();
  await assert.rejects(openFiles(f.options), /OUTPUT_LOCKED/);
});
