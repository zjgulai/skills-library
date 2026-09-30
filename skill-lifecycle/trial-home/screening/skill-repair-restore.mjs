import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { looksOpaque } from '../../control/skill-screen.mjs';

/**
 * 第 ② 步的第二支执行器：用可读孪生整棵替换"不透明容器"技能树。
 *
 * 为什么不解码：容器不可解（解压器全偏移全败、明文探针 0 命中），且长度恒等于明文 + 4096
 * ⇒ 内容是同一份、只是被封了。技能库不是 git 仓，所以走"先备份到项目内再逐文件替换"。
 *
 * 纪律：
 * 1. 不带 --apply 只打印（dry-run）；
 * 2. 两道身份闸门：目标 SKILL.md **必须是不透明容器**（否则拒——防止把可读技能误换掉）、
 *    源头 SKILL.md **必须是可读文本**（否则拒——别拿另一份不透明去换）；
 * 3. 逐文件决策：目标缺失→建立；逐字节相同→不动；不同→先备份再写；目标侧多出来的文件**保留**并列出；
 * 4. 全部写完后**逐文件读回与源头比对**，不一致即报错；回执记 opaqueBefore 与前后 sha256。
 */
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
// Finder 元数据不是技能内容：它跟着目录走，两边各有一份自己的，不该被孪生覆盖。
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

export async function restoreTrees({ restores, library, backupRoot, apply = false }) {
  if (!Array.isArray(restores) || restores.length === 0) throw fail('EMPTY_PLAN');
  const receipt = { record_type: 'library_restore_receipt', applied: apply,
    at: new Date().toISOString(), skills: [], refusals: [] };
  for (const item of restores) {
    const { targetDir, sourceDir } = item;
    if (typeof targetDir !== 'string' || typeof sourceDir !== 'string') throw fail('INVALID_PLAN_ENTRY');
    const targetRoot = join(library, targetDir);
    const sourceRoot = join(library, sourceDir);
    let targetSkillHead;
    let sourceSkillHead;
    try {
      targetSkillHead = (await readFile(join(targetRoot, 'SKILL.md'))).subarray(0, 8);
      sourceSkillHead = (await readFile(join(sourceRoot, 'SKILL.md'))).subarray(0, 8);
    } catch (error) {
      receipt.refusals.push({ targetDir, reason: `UNREADABLE_ENTRY: ${error.code ?? error.message}` });
      continue;
    }
    if (!looksOpaque(targetSkillHead)) {
      receipt.refusals.push({ targetDir, reason: 'TARGET_NOT_OPAQUE: 目标 SKILL.md 不是容器，拒换' });
      continue;
    }
    if (looksOpaque(sourceSkillHead)) {
      receipt.refusals.push({ targetDir, reason: 'SOURCE_UNREADABLE: 源头 SKILL.md 也是容器，拒换' });
      continue;
    }
    const sourceAll = await listFiles(sourceRoot);
    const skippedMetadata = sourceAll.filter(relPath => metadataNames.has(basename(relPath)));
    const sourceFiles = sourceAll.filter(relPath => !metadataNames.has(basename(relPath))).sort();
    const targetFiles = (await listFiles(targetRoot)).sort();
    const action = { targetDir, sourceDir, files: [], created: 0, restored: 0, identical: 0,
      opaqueBefore: 0, skippedMetadata, retained: [], backup: null };
    for (const relPath of sourceFiles) {
      const next = await readFile(join(sourceRoot, relPath));
      let current = null;
      try {
        current = await readFile(join(targetRoot, relPath));
      } catch { /* 目标侧缺这个文件 */ }
      if (current !== null && current.equals(next)) {
        action.identical += 1;
        action.files.push({ relPath, action: 'identical', sha256: sha256(next) });
        continue;
      }
      const record = { relPath, action: current === null ? 'created' : 'restored',
        sha256Before: current === null ? null : sha256(current),
        opaqueBefore: current === null ? false : looksOpaque(current.subarray(0, 8)),
        sha256After: sha256(next), backup: null };
      if (record.opaqueBefore) action.opaqueBefore += 1;
      if (apply) {
        const backupPath = join(backupRoot, targetDir, relPath);
        if (current !== null) {
          await mkdir(dirname(backupPath), { recursive: true });
          await writeFile(backupPath, current);
          record.backup = relative(process.cwd(), backupPath);
        }
        await mkdir(dirname(join(targetRoot, relPath)), { recursive: true });
        await writeFile(join(targetRoot, relPath), next);
      }
      if (record.action === 'created') action.created += 1; else action.restored += 1;
      action.files.push(record);
    }
    action.retained = targetFiles.filter(relPath => !sourceFiles.includes(relPath));
    if (apply) {
      // 逐文件读回与源头比对：不比对就不算替换完成。
      for (const relPath of sourceFiles) {
        const written = await readFile(join(targetRoot, relPath));
        const expected = await readFile(join(sourceRoot, relPath));
        if (!written.equals(expected)) throw fail(`VERIFY_FAILED: ${targetDir}/${relPath}`);
      }
      const after = (await readFile(join(targetRoot, 'SKILL.md'))).subarray(0, 8);
      if (looksOpaque(after)) throw fail(`STILL_OPAQUE: ${targetDir}`);
      action.backup = relative(process.cwd(), join(backupRoot, targetDir));
    }
    receipt.skills.push(action);
  }
  if (apply) {
    await mkdir(backupRoot, { recursive: true });
    await writeFile(join(backupRoot, 'restore-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
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
    process.stderr.write('Usage: node skill-repair-restore.mjs --plan <plan.json> --library <dir> --backup <dir> [--apply]\n');
    return 2;
  }
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  const receipt = await restoreTrees({ restores: plan.restores, library, backupRoot, apply });
  process.stdout.write(`${JSON.stringify({ applied: apply,
    receipt: apply ? join(backupRoot, 'restore-receipt.json') : null,
    skills: receipt.skills.map(item => ({ targetDir: item.targetDir, created: item.created,
      restored: item.restored, identical: item.identical, opaqueBefore: item.opaqueBefore,
      skippedMetadata: item.skippedMetadata, retained: item.retained })),
    refusals: receipt.refusals }, null, 2)}\n`);
  return receipt.refusals.length === 0 ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
