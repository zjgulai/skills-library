import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { looksOpaque } from '../../control/skill-screen.mjs';

/**
 * 第 ③ 步的文本执行器：两类操作，都带闸门、备份与回执，默认 dry-run。
 *
 * - `replace`：把正文里**逐字**的 `find` 换成 `replace`。要求出现次数正好等于 `expectCount`
 *   （多一处少一处都拒——批量替换最怕"顺手多改了别的地方"），并核对改前 sha256。
 * - `copy-in`：把一个库内已有文件复制进某个包（补件）。要求目标**当前不存在**，
 *   写完逐字节比对；不做覆盖——覆盖会毁掉可能存在的本地版本。
 */
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function countOccurrences(text, needle) {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) { count += 1; index = text.indexOf(needle, index + needle.length); }
  return count;
}

export async function applyTextOps({ ops, library, backupRoot, apply = false, receiptName = 'text-receipt.json' }) {
  if (!Array.isArray(ops) || ops.length === 0) throw fail('EMPTY_PLAN');
  const receipt = { record_type: 'library_text_receipt', applied: apply,
    at: new Date().toISOString(), changes: [], refusals: [] };
  // 同一文件可能有多处操作：备份只在**首次**碰到它时写，才是"改前原件"；
  // 每处都写会把备份覆盖成"上一个操作前"的半成品（实测：四个标题的计划只留下三个标题的原件）。
  const backedUp = new Set();
  for (const op of ops) {
    if (op.kind === 'replace') {
      const { relPath, find, replace, expectCount = 1, expectSha256 } = op;
      if (typeof relPath !== 'string' || typeof find !== 'string' || typeof replace !== 'string') {
        throw fail(`INVALID_OP: ${relPath}`);
      }
      const absolute = join(library, relPath);
      const before = await readFile(absolute);
      if (looksOpaque(before.subarray(0, 8))) {
        receipt.refusals.push({ relPath, kind: op.kind, reason: 'OPAQUE_CONTAINER' });
        continue;
      }
      if (expectSha256 !== undefined && sha256(before) !== expectSha256) {
        receipt.refusals.push({ relPath, kind: op.kind, reason: 'CONTENT_CHANGED' });
        continue;
      }
      const text = before.toString('utf8');
      const occurrences = countOccurrences(text, find);
      if (occurrences !== expectCount) {
        receipt.refusals.push({ relPath, kind: op.kind,
          reason: `COUNT_MISMATCH: 期望 ${expectCount} 处，实际 ${occurrences} 处` });
        continue;
      }
      const after = text.split(find).join(replace);
      const record = { relPath, kind: op.kind, occurrences,
        sha256Before: sha256(before), sha256After: sha256(Buffer.from(after, 'utf8')), backup: null };
      if (apply) {
        const backupPath = join(backupRoot, relPath);
        if (!backedUp.has(relPath)) {
          await mkdir(dirname(backupPath), { recursive: true });
          await writeFile(backupPath, before);
          backedUp.add(relPath);
        }
        await writeFile(absolute, after);
        record.backup = relative(process.cwd(), backupPath);
      }
      receipt.changes.push(record);
      continue;
    }
    if (op.kind === 'copy-in') {
      const { relPath, source, note } = op;
      if (typeof relPath !== 'string' || typeof source !== 'string') throw fail(`INVALID_OP: ${relPath}`);
      const absolute = join(library, relPath);
      const sourceBytes = await readFile(join(library, source));
      let existing = null;
      try { existing = await readFile(absolute); } catch { /* 目标不存在，正是我们要的 */ }
      if (existing !== null) {
        receipt.refusals.push({ relPath, kind: op.kind, reason: 'TARGET_EXISTS: 补件不覆盖已有文件' });
        continue;
      }
      const record = { relPath, kind: op.kind, source, note, sourceSha256: sha256(sourceBytes),
        sha256After: sha256(sourceBytes), backup: null };
      if (apply) {
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, sourceBytes);
        const written = await readFile(absolute);
        if (!written.equals(sourceBytes)) throw fail(`VERIFY_FAILED: ${relPath}`);
        record.backup = '(补件：目标此前不存在，无需备份)';
      }
      receipt.changes.push(record);
      continue;
    }
    throw fail(`UNKNOWN_OP: ${op.kind}`);
  }
  if (apply) {
    await mkdir(backupRoot, { recursive: true });
    const receiptPath = join(backupRoot, receiptName);
    // 回执按计划命名，且**已存在即拒**：一次 apply 写一份回执，第二份计划不许把第一份盖掉
    //（第一版每轮都写 text-receipt.json，第三步的回执就被 office-to-md 那次覆盖了——已登记）。
    const exists = await readFile(receiptPath).then(() => true, () => false);
    if (exists) throw fail(`RECEIPT_EXISTS: ${receiptPath}`);
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  return receipt;
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
    process.stderr.write('Usage: node skill-repair-text.mjs --plan <plan.json> --library <dir> --backup <dir> [--apply]\n');
    return 2;
  }
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  // 回执名跟着计划走：不同计划互不覆盖，重跑同一计划会被 RECEIPT_EXISTS 挡住。
  const receiptName = `${basename(planPath).replace(/\.json$/, '')}-receipt.json`;
  const receipt = await applyTextOps({ ops: plan.ops, library, backupRoot, apply, receiptName });
  process.stdout.write(`${JSON.stringify({ applied: apply, changed: receipt.changes.length,
    refused: receipt.refusals.length,
    receipt: apply ? join(backupRoot, receiptName) : null,
    changes: receipt.changes.map(item => ({ relPath: item.relPath, kind: item.kind,
      occurrences: item.occurrences, source: item.source })),
    refusals: receipt.refusals }, null, 2)}\n`);
  return receipt.refusals.length === 0 ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
