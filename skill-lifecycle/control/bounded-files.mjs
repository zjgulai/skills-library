import { createHash, randomUUID } from 'node:crypto';
import { constants, renameSync } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

const reportId = 'validation-report';
const reportName = 'validation-report.md';
const sha256 = value => createHash('sha256').update(value).digest('hex');

function failure(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

function record(value, keys, code) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) {
    throw failure(code);
  }
  const copy = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    copy[key] = descriptor.value;
  }
  return copy;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchanged(left, right) {
  return sameFile(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.nlink === right.nlink;
}

function within(path, root) {
  const rest = relative(root, path);
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`));
}

async function inspectPath(path, directory, code) {
  if (typeof path !== 'string' || path.includes('\0') || !isAbsolute(path) || resolve(path) !== path) {
    throw failure(code);
  }
  try {
    const base = parse(path).root;
    let current = base;
    const segments = path.slice(base.length).split(sep).filter(Boolean);
    for (let i = 0; i < segments.length; i += 1) {
      current = join(current, segments[i]);
      const stat = await lstat(current, { bigint: true });
      if (stat.isSymbolicLink() || (i < segments.length - 1 && !stat.isDirectory())) throw failure(code);
    }
    const stat = await lstat(path, { bigint: true });
    if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) throw failure(code);
    if (await realpath(path) !== path) throw failure(code);
    return stat;
  } catch (error) {
    throw failure(code, error);
  }
}

async function readBytes(path, maxBytes, expected) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || !unchanged(expected, before)) throw failure('UNSAFE_FILE');
    if (before.size > BigInt(maxBytes)) throw failure('INPUT_TOO_LARGE');
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(65536, maxBytes - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw failure('INPUT_TOO_LARGE');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (!unchanged(before, await handle.stat({ bigint: true })) || BigInt(total) !== before.size) {
      throw failure('INPUT_CHANGED');
    }
    return { bytes: Buffer.concat(chunks, total), stat: before };
  } finally {
    await handle.close();
  }
}

function snapshot(fileId, bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw failure('INVALID_UTF8', error);
  }
  return { fileId, sha256: sha256(bytes), totalBytes: bytes.length, chars: Array.from(text) };
}

export async function openFiles({ run, binding, inputRoot, skillRoot, outputRoot, files, limits }) {
  run.assertAdmitted(binding);
  const identity = Object.freeze({ ...binding });
  const bounds = record(limits, ['maxInputBytes', 'maxReportBytes'], 'INVALID_LIMIT');
  if (Object.values(bounds).some(n => !Number.isSafeInteger(n) || n <= 0)) throw failure('INVALID_LIMIT');
  if (!Array.isArray(files) || files.length === 0) throw failure('INVALID_FILE');
  const ids = new Set();
  const entries = files.map(value => {
    const entry = record(value, ['fileId', 'path', 'role'], 'INVALID_FILE');
    if (typeof entry.fileId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.fileId) ||
      entry.fileId === reportId || !['input', 'skill'].includes(entry.role)) throw failure('INVALID_FILE');
    if (ids.has(entry.fileId)) throw failure('DUPLICATE_FILE');
    ids.add(entry.fileId);
    return entry;
  });
  const roots = [inputRoot, skillRoot, outputRoot];
  const rootStats = await Promise.all(roots.map(path => inspectPath(path, true, 'INVALID_ROOT')));
  for (let i = 0; i < roots.length; i += 1) {
    for (let j = i + 1; j < roots.length; j += 1) {
      if (within(roots[i], roots[j]) || within(roots[j], roots[i]) || sameFile(rootStats[i], rootStats[j])) {
        throw failure('ROOTS_OVERLAP');
      }
    }
  }
  const snapshots = new Map();
  let total = 0;
  for (const entry of entries) {
    const root = entry.role === 'input' ? inputRoot : skillRoot;
    if (typeof entry.path !== 'string' || !isAbsolute(entry.path) || !within(entry.path, root)) {
      throw failure('FILE_OUTSIDE_ROOT');
    }
    const expected = await inspectPath(entry.path, false, 'UNSAFE_FILE');
    const { bytes } = await readBytes(entry.path, bounds.maxInputBytes - total, expected);
    total += bytes.length;
    snapshots.set(entry.fileId, snapshot(entry.fileId, bytes));
  }
  run.assertAdmitted(identity);
  const outputNow = await inspectPath(outputRoot, true, 'OUTPUT_ROOT_CHANGED');
  if (!sameFile(rootStats[2], outputNow)) throw failure('OUTPUT_ROOT_CHANGED');
  const lockPath = join(outputRoot, '.files.lock');
  const targetPath = join(outputRoot, reportName);
  let lock;
  try {
    lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw failure('OUTPUT_LOCKED');
    throw error;
  }
  let lockStat;
  const owner = { ownerId: randomUUID(), runId: identity.runId, pid: process.pid };
  try {
    lockStat = await lock.stat({ bigint: true });
    await lock.writeFile(`${JSON.stringify(owner)}\n`);
    await lock.sync();
    run.assertAdmitted(identity);
  } catch (error) {
    try {
      if (lockStat) {
        const rootNow = await lstat(outputRoot, { bigint: true });
        const lockNow = await lstat(lockPath, { bigint: true });
        if (sameFile(rootStats[2], rootNow) && lockNow.isFile() && sameFile(lockStat, lockNow)) {
          await unlink(lockPath);
        }
      }
    } finally {
      await lock.close();
    }
    if (error.code?.startsWith('RUN_') || error.code === 'BINDING_MISMATCH') throw error;
    throw failure('OUTPUT_LOCK_FAILED', error);
  }
  let queue = Promise.resolve();
  let closing = false;
  let closePromise;
  let fault;
  let ownedReport;

  function assertOpen() {
    if (closing) throw failure('IO_CLOSED');
    if (fault) throw failure('IO_STORAGE_FAILED', fault);
    run.assertAdmitted(identity);
  }

  async function assertOutputOwner() {
    const current = await inspectPath(outputRoot, true, 'OUTPUT_ROOT_CHANGED');
    if (!sameFile(rootStats[2], current)) throw failure('OUTPUT_ROOT_CHANGED');
    const stat = await inspectPath(lockPath, false, 'OUTPUT_LOCK_LOST');
    if (!sameFile(lockStat, stat)) throw failure('OUTPUT_LOCK_LOST');
    const { bytes } = await readBytes(lockPath, 4096, stat);
    if (JSON.parse(bytes.toString('utf8')).ownerId !== owner.ownerId) throw failure('OUTPUT_LOCK_LOST');
  }

  async function verifyReport() {
    let stat;
    try { stat = await lstat(targetPath, { bigint: true }); } catch (error) {
      if (error.code === 'ENOENT' && !ownedReport) return;
      throw failure('REPORT_CONFLICT', error);
    }
    if (!ownedReport || !stat.isFile() || stat.nlink !== 1n || !unchanged(ownedReport.stat, stat)) {
      throw failure('REPORT_CONFLICT');
    }
    const { bytes } = await readBytes(targetPath, bounds.maxReportBytes, stat);
    if (sha256(bytes) !== ownedReport.sha256) throw failure('REPORT_CONFLICT');
  }

  async function publish(bytes) {
    let tempPath;
    let tempStat;
    let handle;
    let published = false;
    try {
      assertOpen();
      await assertOutputOwner();
      await verifyReport();
      assertOpen();
      tempPath = join(outputRoot, `.validation-report-${randomUUID()}.tmp`);
      handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      tempStat = await handle.stat({ bigint: true });
      await handle.writeFile(bytes);
      await handle.sync();
      const expected = await handle.stat({ bigint: true });
      await handle.close();
      handle = undefined;
      await assertOutputOwner();
      await verifyReport();
      const staged = await inspectPath(tempPath, false, 'REPORT_CONFLICT');
      if (!unchanged(expected, staged)) throw failure('REPORT_CONFLICT');
      assertOpen();
      // Keep the final admission check and rename in the same event-loop turn.
      renameSync(tempPath, targetPath);
      published = true;
      const parent = await open(outputRoot, constants.O_RDONLY);
      try { await parent.sync(); } finally { await parent.close(); }
      const stat = await inspectPath(targetPath, false, 'REPORT_CONFLICT');
      if (!sameFile(expected, stat) || stat.size !== BigInt(bytes.length)) throw failure('REPORT_CONFLICT');
      assertOpen();
      const saved = snapshot(reportId, bytes);
      ownedReport = { stat, sha256: saved.sha256 };
      snapshots.set(reportId, saved);
      return Object.freeze({ artifactId: reportId, sha256: saved.sha256, bytes: bytes.length });
    } catch (error) {
      const denied = ['RUN_NOT_RUNNING', 'RUN_CLOSED', 'RUN_RECOVERY_REQUIRED', 'IO_CLOSED'].includes(error.code);
      if (!denied || published) fault = error;
      throw error;
    } finally {
      try {
        if (tempStat && !published) {
          const rootNow = await lstat(outputRoot, { bigint: true });
          const tempNow = await lstat(tempPath, { bigint: true });
          if (sameFile(rootStats[2], rootNow) && tempNow.isFile() && sameFile(tempStat, tempNow)) {
            await unlink(tempPath);
          }
        }
      } finally {
        if (handle) await handle.close();
      }
    }
  }

  return Object.freeze({
    async read(args) {
      assertOpen();
      const { fileId, offset, limit } = record(args, ['fileId', 'offset', 'limit'], 'INVALID_READ');
      if (typeof fileId !== 'string' || !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(limit) || limit <= 0) throw failure('INVALID_READ');
      const value = snapshots.get(fileId);
      if (!value) throw failure('FILE_NOT_ALLOWED');
      const end = offset + Math.min(limit, value.chars.length - Math.min(offset, value.chars.length));
      return Object.freeze({ fileId, sha256: value.sha256, totalBytes: value.totalBytes,
        content: value.chars.slice(offset, end).join(''), truncated: end < value.chars.length });
    },
    writeReport(args) {
      let content;
      let bytes;
      try {
        assertOpen();
        ({ content } = record(args, ['content'], 'INVALID_REPORT'));
        if (typeof content !== 'string' || !content.isWellFormed()) throw failure('INVALID_REPORT');
        if (Buffer.byteLength(content) > bounds.maxReportBytes) throw failure('REPORT_TOO_LARGE');
        bytes = Buffer.from(content, 'utf8');
      } catch (error) { return Promise.reject(error); }
      const operation = queue.then(() => publish(bytes));
      queue = operation.catch(() => {});
      return operation;
    },
    manifest() {
      assertOpen();
      return Object.freeze(Array.from(snapshots.values(), value => Object.freeze({
        fileId: value.fileId, sha256: value.sha256, totalBytes: value.totalBytes,
      })));
    },
    async drain() {
      let previous;
      do { await (previous = queue); } while (previous !== queue);
      if (fault) throw failure('IO_STORAGE_FAILED', fault);
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = queue.then(async () => {
        try {
          if (!fault) {
            await assertOutputOwner();
            await unlink(lockPath);
          }
        } finally {
          snapshots.clear();
          ownedReport = undefined;
          await lock.close();
        }
      });
      return closePromise;
    },
  });
}
