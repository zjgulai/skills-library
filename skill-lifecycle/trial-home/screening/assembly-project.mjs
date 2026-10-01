import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 装配根投影执行器：把库内技能「复制」到装配根（`_assembly-v1`），**默认 dry-run**。
 *
 * 与 skill-repair-* 系列的差别：目标通常是新的（首次投影），所以闸门是：
 *   ① 计划摘要 `planDigest` 必须与计划内容一致（防改计划不重算）；
 *   ② 每个 op 的源文件清单（逐文件 sha256）必须与计划**当下**逐字节一致（防源漂移）；
 *   ③ 目标已存在时必须与计划清单**全等**（`already-present` 幂等），否则 `TARGET_CONFLICT` 拒收；
 *   ④ apply 用 `tmp → rename` 落位，写后**重读**核对；失败时只回滚本次自己建的目标；
 *   ⑤ 受控更新：目标存在但与清单不同时，仅当 op 带 `expectTargetDigest` 且与当下目标全等才放行——
 *      旧版整体移入 `<targetRoot 兄弟目录>/_assembly-history/<name>/<digest12>`（等价归档复用），再落新版。
 * - 源库永远只读；`.assembly-meta.json` 由本执行器在目标内生成（不计入比对清单）。
 * - 回执只在 apply 且确有落位时写，**已存在即拒**（RECEIPT_EXISTS）。
 *
 * 用法：node assembly-project.mjs --plan <plan.json> [--apply --receipt <path>] [--report <path>]
 */
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

const META_NAME = '.assembly-meta.json';
const junkDirs = new Set(['__pycache__', 'node_modules', '.git']);
const junkNames = new Set(['.DS_Store']);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

const readOrNull = async path => await readFile(path).catch(() => null);

/** 递归列出目录内的常规文件（跳过垃圾文件、符号链接与特殊文件），按 relPath 排序。 */
export async function walkFiles(rootDir) {
  const files = [];
  const skippedSymlinks = [];
  async function walk(dir, prefix) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const relPath = prefix + entry.name;
      if (entry.isSymbolicLink()) { skippedSymlinks.push(relPath); continue; }
      if (entry.isDirectory()) {
        if (junkDirs.has(entry.name)) continue;
        await walk(join(dir, entry.name), `${relPath}/`);
        continue;
      }
      if (!entry.isFile()) continue;
      if (junkNames.has(entry.name) || entry.name.endsWith('.pyc')) continue;
      const buffer = await readFile(join(dir, entry.name));
      files.push({ relPath, sha256: sha256(buffer), bytes: buffer.length });
    }
  }
  await walk(rootDir, '');
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { files, skippedSymlinks };
}

/** 与 assembly-plan-make.py 相同的清单摘要口径（行式文本 sha256）。 */
export function manifestDigest(files) {
  return sha256(Buffer.from(files.map(f => `${f.relPath}\t${f.sha256}\t${f.bytes}`).join('\n'), 'utf8'));
}

/** 与 assembly-plan-make.py 相同的计划摘要口径（dir op 带 expectTargetDigest 时并入门）。 */
export function computePlanDigest(plan) {
  const lines = [plan.planVersion, plan.planId, plan.targetRoot];
  for (const op of plan.operations) {
    if (op.mode === 'dir') {
      const fields = [op.opId, op.mode, op.name, op.sourceDir, op.sourceDigest];
      if (typeof op.expectTargetDigest === 'string') fields.push(op.expectTargetDigest);
      lines.push(fields.join('\t'));
    } else if (op.mode === 'flat-to-dir') {
      lines.push([op.opId, op.mode, op.name, op.sourceDir, op.sourceDigest,
        op.expectFlatSha256].join('\t'));
    } else {
      lines.push([op.opId, op.mode, op.name, op.sourceFile, op.sourceSha256].join('\t'));
    }
  }
  return sha256(Buffer.from(lines.join('\n'), 'utf8'));
}

const manifestEquals = (a, b) => a.length === b.length &&
  a.every((item, index) => item.relPath === b[index].relPath && item.sha256 === b[index].sha256 &&
    item.bytes === b[index].bytes);

/** 目标目录里除 meta 之外的清单（用于 already-present 比对与写后核对）。 */
async function targetManifest(dir) {
  const { files } = await walkFiles(dir);
  return files.filter(file => file.relPath !== META_NAME);
}

export async function projectToAssembly({ plan, apply = false, receiptPath = null, reportPath = null }) {
  if (!plan || plan.planKind !== 'assembly-projection' || !Array.isArray(plan.operations) ||
    plan.operations.length === 0) throw fail('INVALID_PLAN');
  if (typeof plan.targetRoot !== 'string' || !plan.targetRoot) throw fail('INVALID_PLAN: targetRoot');
  if (computePlanDigest(plan) !== plan.planDigest) throw fail('PLAN_DIGEST_MISMATCH');
  if (apply) {
    if (typeof receiptPath !== 'string' || !receiptPath) throw fail('INVALID_ARGS: receiptPath');
    if ((await readOrNull(receiptPath)) !== null) throw fail('RECEIPT_EXISTS');
  }

  // 同名目标（含 dir 名与 flat 文件名互相顶撞）一律全拒：不做任意"先到先得"。
  const nameCount = new Map();
  for (const op of plan.operations) nameCount.set(op.name, (nameCount.get(op.name) ?? 0) + 1);
  const duplicated = new Set([...nameCount].filter(([, n]) => n > 1).map(([name]) => name));

  const startedAt = new Date().toISOString();
  const receiptRef = receiptPath ?? `_assembly-receipts/${plan.planId}.json`;
  const results = [];
  for (const op of plan.operations) {
    const record = { opId: op.opId, mode: op.mode, name: op.name, group: op.group ?? null };
    if (duplicated.has(op.name)) { results.push({ ...record, status: 'rejected', reason: 'DUPLICATE_TARGET' }); continue; }
    if (op.mode === 'dir') {
      await projectDirOp({ op, record, plan, apply, targetRoot: plan.targetRoot, receiptRef, results });
    } else if (op.mode === 'flat') {
      await projectFlatOp({ op, record, plan, apply, targetRoot: plan.targetRoot, results });
    } else if (op.mode === 'flat-to-dir') {
      await projectFlatToDirOp({ op, record, plan, apply, targetRoot: plan.targetRoot, receiptRef, results });
    } else {
      results.push({ ...record, status: 'rejected', reason: `INVALID_OP_MODE: ${op.mode}` });
    }
  }

  const summary = {
    applied: results.filter(r => r.status === 'applied').length,
    updated: results.filter(r => r.status === 'updated').length,
    alreadyPresent: results.filter(r => r.status === 'already-present').length,
    planned: results.filter(r => r.status === 'planned' || r.status === 'planned-update').length,
    rejected: results.filter(r => r.status === 'rejected').length,
    skippedSymlinks: results.reduce((sum, r) => sum + (r.skippedSymlinks ?? 0), 0),
  };
  const report = { reportKind: 'assembly-projection', mode: apply ? 'apply' : 'dry-run',
    planId: plan.planId, planDigest: plan.planDigest, targetRoot: plan.targetRoot,
    startedAt, finishedAt: new Date().toISOString(), summary, results };
  if (typeof reportPath === 'string' && reportPath) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (apply && (summary.applied > 0 || summary.updated > 0)) {
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify({ ...report, receiptKind: 'assembly-projection-receipt' }, null, 2)}\n`);
  }
  return report;
}

async function projectDirOp({ op, record, plan, apply, targetRoot, receiptRef, results }) {
  const sourceStat = await stat(op.sourceDir).catch(() => null);
  if (sourceStat === null || !sourceStat.isDirectory()) {
    results.push({ ...record, status: 'rejected', reason: 'SOURCE_MISSING' });
    return;
  }
  const walked = await walkFiles(op.sourceDir);
  if (manifestDigest(walked.files) !== op.sourceDigest) {
    results.push({ ...record, status: 'rejected', reason: 'SOURCE_CHANGED',
      skippedSymlinks: walked.skippedSymlinks.length });
    return;
  }
  const target = join(targetRoot, op.name);
  const targetStat = await stat(target).catch(() => null);
  if (targetStat !== null) {
    if (!targetStat.isDirectory()) { results.push({ ...record, status: 'rejected', reason: 'TARGET_CONFLICT' }); return; }
    const current = await targetManifest(target);
    if (manifestEquals(current, op.sourceFiles)) {
      results.push({ ...record, status: 'already-present', skippedSymlinks: walked.skippedSymlinks.length });
      return;
    }
    if (typeof op.expectTargetDigest !== 'string') {
      results.push({ ...record, status: 'rejected', reason: 'TARGET_CONFLICT' });
      return;
    }
    const currentDigest = manifestDigest(current);
    if (currentDigest !== op.expectTargetDigest) {
      results.push({ ...record, status: 'rejected', reason: 'CONTENT_CHANGED',
        targetDigest: currentDigest.slice(0, 16) });
      return;
    }
    const replacedDigest = currentDigest.slice(0, 16);
    if (!apply) {
      results.push({ ...record, status: 'planned-update', files: op.sourceFiles.length, bytes: op.sourceBytes,
        skippedSymlinks: walked.skippedSymlinks.length, replacedDigest });
      return;
    }
    const tmp = join(targetRoot, `.tmp-${plan.planId}-${op.opId}`);
    if (!(await writeCopy({ tmp, op, plan, receiptRef, replacedDigest }))) {
      results.push({ ...record, status: 'rejected', reason: 'COPY_FAILED' });
      return;
    }
    const historyRoot = join(dirname(targetRoot), '_assembly-history');
    let archived;
    try {
      archived = await archiveHistory(historyRoot, op.name, currentDigest, target);
      if (!archived.moved) await rm(target, { recursive: true, force: true });
      await rename(tmp, target);
    } catch {
      await rm(tmp, { recursive: true, force: true });
      if (archived !== undefined) await restoreTarget(target, archived);
      results.push({ ...record, status: 'rejected', reason: 'COPY_FAILED' });
      return;
    }
    const afterUpdate = await targetManifest(target);
    if (!manifestEquals(afterUpdate, op.sourceFiles)) {
      await restoreTarget(target, archived);
      results.push({ ...record, status: 'rejected', reason: 'VERIFY_FAILED', rolledBack: true });
      return;
    }
    results.push({ ...record, status: 'updated', files: op.sourceFiles.length, bytes: op.sourceBytes,
      skippedSymlinks: walked.skippedSymlinks.length, replacedDigest,
      historyPath: archived.path, historyReused: !archived.moved });
    return;
  }
  if (typeof op.expectTargetDigest === 'string') {
    results.push({ ...record, status: 'rejected', reason: 'TARGET_MISSING' });
    return;
  }
  if (!apply) {
    results.push({ ...record, status: 'planned', files: op.sourceFiles.length, bytes: op.sourceBytes,
      skippedSymlinks: walked.skippedSymlinks.length });
    return;
  }
  const tmp = join(targetRoot, `.tmp-${plan.planId}-${op.opId}`);
  if (!(await writeCopy({ tmp, op, plan, receiptRef }))) {
    results.push({ ...record, status: 'rejected', reason: 'COPY_FAILED' });
    return;
  }
  try {
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { recursive: true, force: true });
    results.push({ ...record, status: 'rejected',
      reason: (error.code === 'EEXIST' || error.code === 'ENOTEMPTY' || error.code === 'ENOTDIR') ? 'TARGET_CONFLICT' : 'COPY_FAILED' });
    return;
  }
  const after = await targetManifest(target);
  if (!manifestEquals(after, op.sourceFiles)) {
    await rm(target, { recursive: true, force: true });
    results.push({ ...record, status: 'rejected', reason: 'VERIFY_FAILED', rolledBack: true });
    return;
  }
  results.push({ ...record, status: 'applied', files: op.sourceFiles.length, bytes: op.sourceBytes,
    skippedSymlinks: walked.skippedSymlinks.length });
}

/** 把 op.sourceFiles + meta 写进 tmp（不落位）；失败清掉 tmp 返回 false。 */
async function writeCopy({ tmp, op, plan, receiptRef, replacedDigest = null }) {
  await mkdir(tmp, { recursive: true });
  try {
    for (const file of op.sourceFiles) {
      const destination = join(tmp, file.relPath);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(op.sourceDir, file.relPath), destination, { preserveTimestamps: true });
    }
    const meta = {
      name: op.name, sourceKind: op.sourceKind ?? 'standard', sourcePath: op.entryRelPath,
      sourceSha256: op.entrySha256, sourceEntryKind: 'standard-entry',
      planId: plan.planId, projectedAt: new Date().toISOString(), projectionReceipt: receiptRef,
    };
    if (replacedDigest !== null) meta.replacedDigest = replacedDigest;
    await writeFile(join(tmp, META_NAME), `${JSON.stringify(meta, null, 2)}\n`);
    return true;
  } catch {
    await rm(tmp, { recursive: true, force: true });
    return false;
  }
}

const pathExists = async path => (await stat(path).catch(() => null)) !== null;

/**
 * 把被替换的旧目标整体移入 `<historyRoot>/<name>/<digest12>`。
 * 已有同 digest 且内容等价的归档时直接复用（moved:false，调用方只需删掉 target）；
 * digest 前缀碰撞或归档不等价时加 `-2`、`-3`… 后缀。
 */
async function archiveHistory(historyRoot, name, digest, target) {
  const base = join(historyRoot, name, digest.slice(0, 12));
  if (await pathExists(base) &&
    manifestEquals(await targetManifest(base), await targetManifest(target))) {
    return { path: base, moved: false };
  }
  let path = base;
  for (let suffix = 2; await pathExists(path); suffix += 1) path = `${base}-${suffix}`;
  await mkdir(dirname(path), { recursive: true });
  await rename(target, path);
  return { path, moved: true };
}

/** 更新失败后的回滚：目标不在原位时，从归档移回（复用档用复制还原）。 */
async function restoreTarget(target, archived) {
  if (await pathExists(target)) return;
  if (archived.moved) await rename(archived.path, target).catch(() => {});
  else await cp(archived.path, target, { recursive: true, preserveTimestamps: true }).catch(() => {});
}

async function projectFlatOp({ op, record, plan, apply, targetRoot, results }) {
  const source = await readOrNull(op.sourceFile);
  if (source === null) { results.push({ ...record, status: 'rejected', reason: 'SOURCE_MISSING' }); return; }
  if (sha256(source) !== op.sourceSha256) {
    results.push({ ...record, status: 'rejected', reason: 'SOURCE_CHANGED' });
    return;
  }
  const target = join(targetRoot, `${op.name}.md`);
  const existing = await readOrNull(target);
  if (existing !== null) {
    if (sha256(existing) === op.sourceSha256) {
      results.push({ ...record, status: 'already-present' });
    } else {
      results.push({ ...record, status: 'rejected', reason: 'TARGET_CONFLICT' });
    }
    return;
  }
  if (!apply) {
    results.push({ ...record, status: 'planned', bytes: source.length });
    return;
  }
  const tmp = join(targetRoot, `.tmp-${plan.planId}-${op.opId}.md`);
  await mkdir(targetRoot, { recursive: true });
  try {
    await writeFile(tmp, source);
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true });
    results.push({ ...record, status: 'rejected',
      reason: (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') ? 'TARGET_CONFLICT' : 'COPY_FAILED' });
    return;
  }
  const after = await readOrNull(target);
  if (after === null || sha256(after) !== op.sourceSha256) {
    await rm(target, { force: true });
    results.push({ ...record, status: 'rejected', reason: 'VERIFY_FAILED', rolledBack: true });
    return;
  }
  results.push({ ...record, status: 'applied', bytes: source.length, files: 1 });
}

/**
 * `flat-to-dir`：受控替换——把平铺 `<name>.md` 换成目录 `<name>/`。
 * 闸门：源目录清单逐字节一致（防源漂移）；平铺目标必须存在且 sha256 与计划一致（防换错对象）；
 * 目录目标不得已存在（已等且平铺已清 ⇒ already-present 幂等）。apply 顺序＝档案化平铺 → 落目录 → 双向核对；
 * 任一步失败回滚平铺。旧平铺进 `<historyRoot>/<name>/<digest12>.md`（等价档复用）。
 */
async function projectFlatToDirOp({ op, record, plan, apply, targetRoot, receiptRef, results }) {
  const sourceStat = await stat(op.sourceDir).catch(() => null);
  if (sourceStat === null || !sourceStat.isDirectory()) {
    results.push({ ...record, status: 'rejected', reason: 'SOURCE_MISSING' });
    return;
  }
  const walked = await walkFiles(op.sourceDir);
  if (manifestDigest(walked.files) !== op.sourceDigest) {
    results.push({ ...record, status: 'rejected', reason: 'SOURCE_CHANGED',
      skippedSymlinks: walked.skippedSymlinks.length });
    return;
  }
  const dirTarget = join(targetRoot, op.name);
  const dirStat = await stat(dirTarget).catch(() => null);
  const flatTarget = join(targetRoot, op.expectFlatRelPath);
  const flatNow = await readOrNull(flatTarget);
  if (dirStat !== null) {
    if (!dirStat.isDirectory()) { results.push({ ...record, status: 'rejected', reason: 'TARGET_CONFLICT' }); return; }
    const current = await targetManifest(dirTarget);
    if (flatNow === null && manifestEquals(current, op.sourceFiles)) {
      results.push({ ...record, status: 'already-present', skippedSymlinks: walked.skippedSymlinks.length });
      return;
    }
    results.push({ ...record, status: 'rejected', reason: 'TARGET_CONFLICT' });
    return;
  }
  if (flatNow === null) {
    results.push({ ...record, status: 'rejected', reason: 'FLAT_MISSING' });
    return;
  }
  if (sha256(flatNow) !== op.expectFlatSha256) {
    results.push({ ...record, status: 'rejected', reason: 'FLAT_CHANGED',
      flatDigest: sha256(flatNow).slice(0, 16) });
    return;
  }
  const replacedFlatDigest = op.expectFlatSha256.slice(0, 16);
  if (!apply) {
    results.push({ ...record, status: 'planned-update', files: op.sourceFiles.length,
      bytes: op.sourceBytes, skippedSymlinks: walked.skippedSymlinks.length, replacedFlatDigest });
    return;
  }
  const historyRoot = join(dirname(targetRoot), '_assembly-history');
  const flatBase = join(historyRoot, op.name, `${op.expectFlatSha256.slice(0, 12)}.md`);
  let archived;
  const reuseOk = await pathExists(flatBase) &&
    sha256(await readFile(flatBase)) === op.expectFlatSha256;
  if (reuseOk) {
    archived = { path: flatBase, moved: false };
  } else {
    let path = flatBase;
    for (let suffix = 2; await pathExists(path); suffix += 1) path = `${flatBase.slice(0, -3)}-${suffix}.md`;
    await mkdir(dirname(path), { recursive: true });
    await rename(flatTarget, path);
    archived = { path, moved: true };
  }
  if (!archived.moved) await rm(flatTarget, { force: true });
  const restoreFlat = async () => {
    if (await readOrNull(flatTarget) !== null) return;
    if (archived.moved) await rename(archived.path, flatTarget).catch(() => {});
    else await cp(archived.path, flatTarget, { preserveTimestamps: true }).catch(() => {});
  };
  const tmp = join(targetRoot, `.tmp-${plan.planId}-${op.opId}`);
  if (!(await writeCopy({ tmp, op, plan, receiptRef, replacedDigest: replacedFlatDigest }))) {
    await restoreFlat();
    results.push({ ...record, status: 'rejected', reason: 'COPY_FAILED' });
    return;
  }
  try {
    await rename(tmp, dirTarget);
  } catch (error) {
    await rm(tmp, { recursive: true, force: true });
    await restoreFlat();
    results.push({ ...record, status: 'rejected',
      reason: (error.code === 'EEXIST' || error.code === 'ENOTEMPTY' || error.code === 'ENOTDIR') ? 'TARGET_CONFLICT' : 'COPY_FAILED' });
    return;
  }
  const after = await targetManifest(dirTarget);
  const flatAfter = await readOrNull(flatTarget);
  if (!manifestEquals(after, op.sourceFiles) || flatAfter !== null) {
    await rm(dirTarget, { recursive: true, force: true });
    await restoreFlat();
    results.push({ ...record, status: 'rejected', reason: 'VERIFY_FAILED', rolledBack: true });
    return;
  }
  results.push({ ...record, status: 'updated', files: op.sourceFiles.length, bytes: op.sourceBytes,
    skippedSymlinks: walked.skippedSymlinks.length, replacedFlatDigest,
    historyPath: archived.path, historyReused: !archived.moved });
}

async function main(argv) {
  const flag = name => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  const planPath = flag('plan');
  if (!planPath) {
    process.stderr.write('Usage: node assembly-project.mjs --plan <plan.json> [--apply --receipt <path>] [--report <path>]\n');
    return 2;
  }
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  const report = await projectToAssembly({ plan, apply: argv.includes('--apply'),
    receiptPath: flag('receipt'), reportPath: flag('report') });
  process.stdout.write(`${JSON.stringify({ mode: report.mode, planId: report.planId,
    summary: report.summary, rejections: report.results.filter(r => r.status === 'rejected') }, null, 2)}\n`);
  return report.summary.rejected === 0 ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
