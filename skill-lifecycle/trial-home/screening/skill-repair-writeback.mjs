import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rmdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 文件级写回执行器（`put` / `remove`），带闸门、备份与回执，**默认 dry-run**。
 *
 * - `put`：把 `source`（候选产物）写到库内 `relPath`。三道闸门：
 *   ① 源摘要必须等于 `sourceSha256`（防止"写的不是被评的那份"）；
 *   ② 目标要么声明 `expectAbsent: true` 且确实不存在，要么当前摘要等于 `expectSha256`（清单过期就拒收）；
 *   ③ 写成后**重读**核对摘要。
 * - `remove`：删除库内 `relPath`，要求当前摘要等于 `expectSha256`，删后确认已消失。
 * - 备份：同一文件只备份一次（首次碰到的才是"改前原件"，多次覆盖会把备份写成半成品）；
 *   回执落在 `--backup` 根，**已存在即拒**（不覆盖既有回执）。
 *
 * 用法：node skill-repair-writeback.mjs --plan <plan.json> --library <技能库根> --backup <备份根> [--apply]
 */
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

const readOrNull = async path => await readFile(path).catch(() => null);

export async function applyWritebackOps({ ops, library, backupRoot, apply = false,
  receiptName = 'writeback-receipt.json' }) {
  if (!Array.isArray(ops) || ops.length === 0) throw fail('EMPTY_PLAN');
  const receiptPath = join(backupRoot, receiptName);
  if (apply && (await readOrNull(receiptPath)) !== null) throw fail('RECEIPT_EXISTS');
  const receipt = { record_type: 'library_writeback_receipt', applied: apply,
    at: new Date().toISOString(), changes: [], refusals: [] };
  const backedUp = new Set();
  const acceptedRemoves = new Set();
  for (const op of ops) {
    if (!op || (op.kind !== 'prune-empty-dirs' && typeof op.relPath !== 'string') || typeof op.kind !== 'string') throw fail('INVALID_OP');
    const record = { kind: op.kind, relPath: op.relPath ?? op.root };
    if (op.kind === 'prune-empty-dirs') {
      // 删除只看文件、空目录会留下壳（momcozy 事故）。本 op 显式收口：只在 root 之内、
      // 只删"此刻已空或经本计划删空"的目录，**root 自身不删**（避免把整棵技能树删掉）。
      if (typeof op.root !== 'string') throw fail('INVALID_OP: prune-empty-dirs 缺 root');
      const rootAbs = join(library, op.root);
      const rootStat = await stat(rootAbs).catch(() => null);
      if (rootStat === null || !rootStat.isDirectory()) {
        receipt.refusals.push({ ...record, reason: 'ROOT_MISSING' });
        continue;
      }
      const prunable = await findPrunableDirs(rootAbs, acceptedRemoves);
      if (apply) {
        for (const dir of prunable) await rmdir(dir);   // 只删空目录；非空会 ENOTEMPTY 而不是误删内容
        const left = await findPrunableDirs(rootAbs, acceptedRemoves);
        if (left.length > 0) throw fail(`VERIFY_FAILED: ${op.root}`);
      }
      receipt.changes.push({ ...record, pruned: prunable.map(dir => relative(library, dir)) });
      continue;
    }
    const absolute = join(library, op.relPath);
    if (op.kind === 'put') {
      if (typeof op.source !== 'string' || typeof op.sourceSha256 !== 'string'
        || (op.expectAbsent !== true && typeof op.expectSha256 !== 'string')) {
        throw fail(`INVALID_OP: ${op.relPath}`);
      }
      const source = await readOrNull(op.source);
      if (source === null || sha256(source) !== op.sourceSha256) {
        receipt.refusals.push({ ...record, reason: 'SOURCE_CHANGED' });
        continue;
      }
      const before = await readOrNull(absolute);
      if (op.expectAbsent === true) {
        if (before !== null) { receipt.refusals.push({ ...record, reason: 'TARGET_EXISTS' }); continue; }
      } else if (before === null) {
        receipt.refusals.push({ ...record, reason: 'TARGET_MISSING' });
        continue;
      } else if (sha256(before) !== op.expectSha256) {
        receipt.refusals.push({ ...record, reason: 'CONTENT_CHANGED' });
        continue;
      }
      if (apply) {
        if (before !== null && !backedUp.has(op.relPath)) {
          await writeBackup(backupRoot, op.relPath, before);
          backedUp.add(op.relPath);
        }
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, source);
        const after = await readOrNull(absolute);
        if (after === null || sha256(after) !== op.sourceSha256) throw fail(`VERIFY_FAILED: ${op.relPath}`);
      }
      receipt.changes.push({ ...record, before: before === null ? null : sha256(before).slice(0, 16),
        after: op.sourceSha256.slice(0, 16),
        backup: before === null ? null : relative(process.cwd(), join(backupRoot, op.relPath)) });
    } else if (op.kind === 'remove') {
      if (typeof op.expectSha256 !== 'string') throw fail(`INVALID_OP: ${op.relPath}`);
      const before = await readOrNull(absolute);
      if (before === null) { receipt.refusals.push({ ...record, reason: 'TARGET_MISSING' }); continue; }
      if (sha256(before) !== op.expectSha256) {
        receipt.refusals.push({ ...record, reason: 'CONTENT_CHANGED' });
        continue;
      }
      if (apply) {
        if (!backedUp.has(op.relPath)) {
          await writeBackup(backupRoot, op.relPath, before);
          backedUp.add(op.relPath);
        }
        await rm(absolute);
        if ((await readOrNull(absolute)) !== null) throw fail(`VERIFY_FAILED: ${op.relPath}`);
      }
      acceptedRemoves.add(absolute);
      receipt.changes.push({ ...record, before: sha256(before).slice(0, 16), after: null,
        backup: relative(process.cwd(), join(backupRoot, op.relPath)) });
    } else {
      throw fail(`INVALID_OP_KIND: ${op.kind}`);
    }
  }
  // 回执＝"这次写回真的发生过"的标记：全被拒（没有任何变更）时不落回执，
  // 否则一次误报的拒收会把后续重跑挡在 RECEIPT_EXISTS 之外。
  if (apply && receipt.changes.length > 0) {
    await mkdir(backupRoot, { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  return receipt;
}

async function writeBackup(backupRoot, relPath, contents) {
  const target = join(backupRoot, relPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

/**
 * 找出 root 下"可清空"的目录（不含 root 自身），深到浅返回。
 * 判定：目录的每个条目要么是本函数认定的可清空子目录，要么是在本计划里已被接受的删除件。
 */
async function findPrunableDirs(rootAbs, acceptedRemoves) {
  const result = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return false; }
    let prunable = true;
    const subdirs = [];
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) { subdirs.push(child); continue; }
      if (!acceptedRemoves.has(child)) { prunable = false; }
    }
    for (const child of subdirs) {
      const childPrunable = await walk(child);
      if (childPrunable) result.push(child);
      else prunable = false;
    }
    return prunable;
  }
  await walk(rootAbs);
  return result;   // 子目录在其父之前入列 ⇒ 深到浅
}

async function main(argv) {
  const flag = name => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  const planPath = flag('plan');
  const library = flag('library');
  const backupRoot = flag('backup');
  const apply = argv.includes('--apply');
  if (!planPath || !library || !backupRoot) {
    process.stderr.write('Usage: node skill-repair-writeback.mjs --plan <plan.json> --library <dir> --backup <dir> [--apply]\n');
    return 2;
  }
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  if (!Array.isArray(plan.ops) || plan.ops.length === 0) throw fail('EMPTY_PLAN');
  const receipt = await applyWritebackOps({ ops: plan.ops, library, backupRoot, apply });
  process.stdout.write(`${JSON.stringify({ applied: apply, changed: receipt.changes.length,
    refused: receipt.refusals.length, receipt: apply ? join(backupRoot, 'writeback-receipt.json') : null,
    changes: receipt.changes, refusals: receipt.refusals }, null, 2)}\n`);
  return receipt.refusals.length === 0 ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
