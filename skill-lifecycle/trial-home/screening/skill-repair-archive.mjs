import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { looksOpaque } from '../../control/skill-screen.mjs';

/**
 * 跨实现退役执行器：把库内**整棵技能树**移出到项目内归档区（P3 撞名替换用）。
 *
 * 与 `skill-repair-retire.mjs` 的分工：那个只删"与孪生逐字节相同的重复目录"；
 * 本执行器处理的是**不同实现**的退役（A 侧要取这个名字，B 侧让位）——所以闸门换成：
 *  1. 目标必须是可读技能（SKILL.md 存在且不是不透明容器）——不可读的 Tree 不能退役（那是唯一一份）；
 *  2. **身份闸门**：frontmatter 的 name 必须等于 `expectName`（防止"移错了目录"）；
 *  3. 归档目标不存在（不覆盖既有归档）；
 *  4. apply 时：先整树复制到归档区 → **逐文件 sha256 比对 + 文件集合相等** → 才删源树 → 再验源树已消失；
 *  5. 默认 dry-run；回执记录文件数与 SKILL.md 前后 sha256、归档路径。
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

export async function archiveTrees({ moves, library, archiveRoot, apply = false,
  receiptName = 'archive-receipt.json' }) {
  if (!Array.isArray(moves) || moves.length === 0) throw fail('EMPTY_PLAN');
  const receiptPath = join(archiveRoot, receiptName);
  if (apply && (await readFile(receiptPath).catch(() => null)) !== null) throw fail('RECEIPT_EXISTS');
  const receipt = { record_type: 'library_archive_receipt', applied: apply,
    at: new Date().toISOString(), moved: [], refusals: [] };
  for (const item of moves) {
    const { relDir, expectName } = item ?? {};
    if (typeof relDir !== 'string' || typeof expectName !== 'string') throw fail('INVALID_PLAN_ENTRY');
    const source = join(library, relDir);
    const destination = join(archiveRoot, basename(relDir));
    let skillMd;
    try { skillMd = await readFile(join(source, 'SKILL.md')); }
    catch { receipt.refusals.push({ relDir, reason: 'UNREADABLE_TARGET' }); continue; }
    if (looksOpaque(skillMd.subarray(0, 8))) {
      receipt.refusals.push({ relDir, reason: 'TARGET_OPAQUE: 不可读的树不能退役' });
      continue;
    }
    const nameMatch = skillMd.toString('utf8').match(/^name:\s*"?([^"\n]+)"?\s*$/m);
    const actualName = nameMatch ? nameMatch[1].trim() : '';
    if (actualName !== expectName) {
      receipt.refusals.push({ relDir, reason: `IDENTITY_MISMATCH: 期望 ${expectName}，实为 ${actualName || '(缺 name)'}` });
      continue;
    }
    if ((await stat(destination).catch(() => null)) !== null) {
      receipt.refusals.push({ relDir, reason: 'ARCHIVE_EXISTS' });
      continue;
    }
    const files = await listFiles(source);
    if (apply) {
      await mkdir(archiveRoot, { recursive: true });
      await cp(source, destination, { recursive: true });
      // 逐文件核对：归档必须与源逐字节一致、且文件集合相等
      const movedFiles = await listFiles(destination);
      const norm = list => [...list].sort().join('\n');
      if (norm(files) !== norm(movedFiles)) throw fail(`ARCHIVE_INCOMPLETE: ${relDir}`);
      for (const relPath of files) {
        const [a, b] = await Promise.all([readFile(join(source, relPath)), readFile(join(destination, relPath))]);
        if (sha256(a) !== sha256(b)) throw fail(`ARCHIVE_MISMATCH: ${relDir}/${relPath}`);
      }
      await rm(source, { recursive: true, force: true });
      if ((await stat(source).catch(() => null)) !== null) throw fail(`SOURCE_STILL_PRESENT: ${relDir}`);
    }
    receipt.moved.push({ relDir, files: files.length, skillMdSha256: sha256(skillMd),
      archive: relative(process.cwd(), destination) });
  }
  if (apply && receipt.moved.length > 0) {
    await mkdir(archiveRoot, { recursive: true });
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
  const archive = flag('archive');
  const apply = argv.includes('--apply');
  if (!planPath || !library || !archive) {
    process.stderr.write('Usage: node skill-repair-archive.mjs --plan <plan.json> --library <dir> --archive <dir> [--apply]\n');
    return 2;
  }
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  const receipt = await archiveTrees({ moves: plan.moves, library, archiveRoot: archive, apply });
  process.stdout.write(`${JSON.stringify({ applied: apply, moved: receipt.moved.length,
    refused: receipt.refusals.length, receipt: apply ? join(archive, 'archive-receipt.json') : null,
    movedDetail: receipt.moved, refusals: receipt.refusals }, null, 2)}\n`);
  return receipt.refusals.length === 0 ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
void dirname;
