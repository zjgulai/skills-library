import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { looksOpaque } from '../../control/skill-screen.mjs';

/**
 * 退役执行器：删掉"与孪生逐字节相同"的重复技能目录。
 *
 * 这是本批里**唯一会删东西**的执行器，所以闸门比其它几个更硬：
 * 1. 目标是可读技能（容器不让删——那会毁掉唯一一份）；
 * 2. 目标里**每个内容文件**都必须与孪生同名文件逐字节相同（元数据白名单除外），
 *    有任何一处不同就整份拒收——"差不多相同"不够；
 * 3. 删之前把整棵树（含元数据）复制到项目内备份；
 * 4. dry-run 是默认；回执记文件数、SKILL.md 前后 sha256 与备份路径。
 */
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const metadataNames = new Set(['.DS_Store']);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function listFiles(root, prefix = '', collected = []) {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await listFiles(root, relPath, collected);
    else if (entry.isFile()) collected.push(relPath);
  }
  return collected;
}

export async function retireTrees({ retires, library, backupRoot, apply = false }) {
  if (!Array.isArray(retires) || retires.length === 0) throw fail('EMPTY_PLAN');
  const receipt = { record_type: 'library_retire_receipt', applied: apply,
    at: new Date().toISOString(), retired: [], refusals: [] };
  for (const item of retires) {
    const { targetDir, twinDir } = item;
    if (typeof targetDir !== 'string' || typeof twinDir !== 'string') throw fail('INVALID_PLAN_ENTRY');
    const targetRoot = join(library, targetDir);
    const twinRoot = join(library, twinDir);
    let targetFiles;
    try {
      targetFiles = (await listFiles(targetRoot)).sort();
    } catch (error) {
      receipt.refusals.push({ targetDir, reason: `UNREADABLE_TARGET: ${error.code ?? error.message}` });
      continue;
    }
    const targetHead = (await readFile(join(targetRoot, 'SKILL.md'))).subarray(0, 8);
    if (looksOpaque(targetHead)) {
      receipt.refusals.push({ targetDir, reason: 'TARGET_OPAQUE: 目标本身不可读，不能退役' });
      continue;
    }
    const mismatches = [];
    const compared = [];
    for (const relPath of targetFiles) {
      if (metadataNames.has(basename(relPath))) continue;
      const mine = await readFile(join(targetRoot, relPath));
      let twin = null;
      try {
        twin = await readFile(join(twinRoot, relPath));
      } catch { /* 孪生没有这个文件 */ }
      compared.push(relPath);
      if (twin === null || !mine.equals(twin)) mismatches.push(relPath);
    }
    if (mismatches.length > 0) {
      receipt.refusals.push({ targetDir,
        reason: `NOT_IDENTICAL: 与孪生不一致（${mismatches.slice(0, 3).join('、')}${mismatches.length > 3 ? ' 等' : ''}）` });
      continue;
    }
    if (compared.length === 0) {
      receipt.refusals.push({ targetDir, reason: 'EMPTY_COMPARISON: 没有任何可比内容文件' });
      continue;
    }
    const record = { targetDir, twinDir, files: targetFiles.length, compared: compared.length,
      sha256: sha256(await readFile(join(targetRoot, 'SKILL.md'))), backup: null, removed: false };
    if (apply) {
      for (const relPath of targetFiles) {
        const backupPath = join(backupRoot, targetDir, relPath);
        await mkdir(dirname(backupPath), { recursive: true });
        await writeFile(backupPath, await readFile(join(targetRoot, relPath)));
      }
      record.backup = relative(process.cwd(), join(backupRoot, targetDir));
      await rm(targetRoot, { recursive: true, force: false });
      record.removed = true;
    }
    receipt.retired.push(record);
  }
  if (apply) {
    await mkdir(backupRoot, { recursive: true });
    await writeFile(join(backupRoot, 'retire-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
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
    process.stderr.write('Usage: node skill-repair-retire.mjs --plan <plan.json> --library <dir> --backup <dir> [--apply]\n');
    return 2;
  }
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  const receipt = await retireTrees({ retires: plan.retires, library, backupRoot, apply });
  process.stdout.write(`${JSON.stringify({ applied: apply,
    receipt: apply ? join(backupRoot, 'retire-receipt.json') : null,
    retired: receipt.retired.map(item => ({ targetDir: item.targetDir, files: item.files,
      compared: item.compared, removed: item.removed })), refusals: receipt.refusals }, null, 2)}\n`);
  return receipt.refusals.length === 0 ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
