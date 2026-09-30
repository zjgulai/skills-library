import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 身份改名执行器，两种用法：
 *
 * - **name＋目录一起改**（默认，51/63 号用过）：`{ relPath, expectName, nextName }`——写新 name 并把技能目录改成 `nextName`；
 * - **只改目录**（67 号后新增）：`{ relPath, expectName, nextDir }`——frontmatter 一个字不动，只有目录改名。
 *   用途：已经 kebab 化的技能在库内把中文目录对齐成同一身份（D70 的"只维护映射"若被明确推翻时）。
 *
 * 纪律：
 * 1. 只动清单里列出的技能目录，别的一律不碰；
 * 2. 改之前核对 frontmatter 的 name 与清单里的 `expectName` 一致，不一致就拒（防止清单过期误改）；
 * 3. 先原样备份 SKILL.md 到项目内，再落地；改完**重读核对**（新路径内容摘要相符、旧路径不得残留）；
 * 4. 回执记录前后 sha256 与目录从/到，落盘留档；回执已存在则拒（不覆盖既有回执）。
 *
 * 用法：node ... --plan <plan.json> --library <技能库根> --backup <备份根> [--apply]
 * 不带 --apply 时只打印将要做的改动（dry-run）。
 */
const namePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function readName(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (match === null) throw fail('NO_FRONTMATTER');
  const line = match[1].split(/\r?\n/).find(candidate => /^name\s*:/.test(candidate));
  if (line === undefined) throw fail('NO_NAME');
  return line.replace(/^name\s*:\s*/, '').trim().replace(/^['"]|['"]$/g, '');
}

function replaceName(text, next) {
  return text.replace(/^(---\r?\n[\s\S]*?^name\s*:\s*)(.*)$/m,
    (whole, head) => `${head}${JSON.stringify(next).replace(/^"|"$/g, '')}`);
}

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

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
    process.stderr.write('Usage: node skill-repair-rename.mjs --plan <plan.json> --library <dir> --backup <dir> [--apply]\n');
    return 2;
  }
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  if (!Array.isArray(plan.renames) || plan.renames.length === 0) throw fail('EMPTY_PLAN');

  const receiptPath = join(backupRoot, 'rename-receipt.json');
  if (apply && (await readFile(receiptPath, 'utf8').catch(() => null)) !== null) throw fail('RECEIPT_EXISTS');
  const receipt = { record_type: 'library_rename_receipt', applied: apply, at: new Date().toISOString(),
    changes: [], refusals: [] };
  for (const entry of plan.renames) {
    const { relPath, expectName } = entry;
    const nextName = typeof entry.nextName === 'string' ? entry.nextName : null;
    const nextDir = typeof entry.nextDir === 'string' ? entry.nextDir : null;
    if (nextName === null && nextDir === null) throw fail(`NO_TARGET: ${relPath}`);
    if (nextName !== null && !namePattern.test(nextName)) throw fail(`INVALID_NEXT_NAME: ${nextName}`);
    if (nextDir !== null && !namePattern.test(nextDir)) throw fail(`INVALID_NEXT_DIR: ${nextDir}`);
    const absolute = join(library, relPath);
    const before = await readFile(absolute, 'utf8');
    const currentName = readName(before);
    if (currentName !== expectName) {
      receipt.refusals.push({ relPath, reason: `NAME_MISMATCH: 清单期望 ${expectName}，实际 ${currentName}` });
      continue;
    }
    const skillDir = dirname(relPath);
    const currentDirName = basename(skillDir);
    const targetDirName = nextDir ?? nextName ?? currentDirName;
    const changeName = nextName !== null && nextName !== expectName;
    const changeDir = targetDirName !== currentDirName;
    if (!changeName && !changeDir) throw fail(`NO_CHANGE: ${relPath}`);
    if (entry.renameDir === false && changeDir) throw fail(`CONFLICT: renameDir=false 但目录要改: ${relPath}`);
    const after = changeName ? replaceName(before, nextName) : before;
    if (changeName && readName(after) !== nextName) throw fail(`REPLACE_FAILED: ${relPath}`);
    const record = { relPath, from: expectName, to: changeName ? nextName : expectName,
      sha256Before: sha256(before), sha256After: sha256(after) };
    const backupPath = join(backupRoot, relPath);
    if (entry.renameDir !== false && (changeName || changeDir)) {
      const nextSkillDir = join(dirname(skillDir), targetDirName);
      record.dirFrom = skillDir;
      record.dirTo = nextSkillDir;
      if (apply) {
        await mkdir(dirname(backupPath), { recursive: true });
        await writeFile(backupPath, before);
        if (changeName) await writeFile(absolute, after);
        if (changeDir) {
          await rename(join(library, skillDir), join(library, nextSkillDir));
          const moved = await readFile(join(library, nextSkillDir, basename(relPath)), 'utf8').catch(() => null);
          if (moved === null || sha256(moved) !== record.sha256After) throw fail(`VERIFY_FAILED: ${relPath}`);
          const stale = await readFile(join(library, skillDir, basename(relPath)), 'utf8').catch(() => null);
          if (stale !== null) throw fail(`STALE_DIR: ${skillDir}`);
        }
        record.backup = relative(process.cwd(), backupPath);
      }
    } else if (apply) {
      await mkdir(dirname(backupPath), { recursive: true });
      await writeFile(backupPath, before);
      await writeFile(absolute, after);
      record.backup = relative(process.cwd(), backupPath);
    }
    receipt.changes.push(record);
  }
  if (apply) {
    await mkdir(backupRoot, { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ applied: apply, changed: receipt.changes.length,
    refused: receipt.refusals.length, receipt: apply ? receiptPath : null,
    sample: receipt.changes.slice(0, 4), refusals: receipt.refusals }, null, 2)}\n`);
  return receipt.refusals.length === 0 ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
