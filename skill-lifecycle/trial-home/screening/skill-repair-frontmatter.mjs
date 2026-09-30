import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { looksOpaque, screenSkills } from '../../control/skill-screen.mjs';

/**
 * 第 ② 步执行器：把起草好的 name/description 插成 SKILL.md 的 frontmatter。
 *
 * 纪律：
 * 1. 只动草稿清单里列出的文件；不带 --apply 一律 dry-run（默认不写盘）；
 * 2. 三道拒收：文件是二进制容器（写下去等于毁文件）、正文与草稿的哈希不符（清单过期）、
 *    已经有 frontmatter（重复执行会插第二份）；
 * 3. 每份先原样备份到项目内，再写回；回执记录前后 sha256 与 description 长度；
 * 4. 写盘前先用筛查器自检渲染结果（name 能读出来、结构类缺陷为零）——引号/冒号这类
 *    YAML 坑要在这里当场暴露，而不是等你打开技能库才发现。
 */
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const frontmatterHead = /^---\r?\n/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function renderFrontmatter({ name, description }) {
  // 单行 JSON 引号标量：description 里带 ": "、引号或换行都不会破 YAML。
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
}

export async function applyDrafts({ drafts, library, backupRoot, apply = false }) {
  if (!Array.isArray(drafts) || drafts.length === 0) throw fail('EMPTY_DRAFTS');
  if (typeof library !== 'string' || !library) throw fail('INVALID_LIBRARY');
  if (typeof backupRoot !== 'string' || !backupRoot) throw fail('INVALID_BACKUP');
  const receipt = { record_type: 'library_frontmatter_receipt', applied: apply,
    at: new Date().toISOString(), changes: [], refusals: [] };
  for (const draft of drafts) {
    const { relPath, name, description } = draft;
    if (typeof relPath !== 'string' || typeof name !== 'string' || typeof description !== 'string') {
      throw fail(`INVALID_DRAFT: ${relPath}`);
    }
    const absolute = join(library, relPath);
    // 先当字节读：容器判定必须落在原始字节上（utf8 解码会把魔数变成 U+FFFD）。
    const before = await readFile(absolute);
    if (looksOpaque(before)) {
      receipt.refusals.push({ relPath, reason: 'OPAQUE_CONTAINER: 二进制容器，插 frontmatter 也读不了' });
      continue;
    }
    const text = before.toString('utf8');
    // 顺序有讲究："已经有 frontmatter"优先于"哈希不符"——重复执行时前者才是真诊断，
    // 否则第二次跑会被 CONTENT_CHANGED 抢先报到，掩盖"其实是插过了"。
    if (frontmatterHead.test(text)) {
      receipt.refusals.push({ relPath, reason: 'FRONTMATTER_EXISTS: 已有 frontmatter，重复插入会写坏' });
      continue;
    }
    if (typeof draft.bodySha256 === 'string' && sha256(before) !== draft.bodySha256) {
      receipt.refusals.push({ relPath, reason: 'CONTENT_CHANGED: 正文与草稿哈希不符（清单过期或文件被改）' });
      continue;
    }
    const after = `${renderFrontmatter({ name, description })}${text}`;
    const selfCheck = screenSkills({ files: [{ relPath, content: after,
      head: Uint8Array.from(Buffer.from('---\nname')) }] }).skills[0];
    const codes = selfCheck.findings.map(item => item.code);
    const structural = ['MISSING_FRONTMATTER', 'MISSING_NAME', 'MISSING_DESCRIPTION', 'OPAQUE_CONTAINER']
      .filter(code => codes.includes(code));
    if (selfCheck.name !== name || structural.length > 0) {
      throw fail(`VERIFY_FAILED: ${relPath} codes=${[...new Set(codes)].join(',')}`);
    }
    const record = { relPath, name, descriptionChars: [...description].length,
      sha256Before: sha256(before), sha256After: sha256(Buffer.from(after, 'utf8')), backup: null };
    if (apply) {
      const backupPath = join(backupRoot, relPath);
      await mkdir(dirname(backupPath), { recursive: true });
      await writeFile(backupPath, before);
      await writeFile(absolute, after);
      record.backup = relative(process.cwd(), backupPath);
    }
    receipt.changes.push(record);
  }
  if (apply) {
    await mkdir(backupRoot, { recursive: true });
    await writeFile(join(backupRoot, 'frontmatter-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  }
  return receipt;
}

async function main(argv) {
  const flag = name => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  const draftsPath = flag('drafts');
  const library = flag('library');
  const backupRoot = flag('backup');
  const apply = argv.includes('--apply');
  if (!draftsPath || !library || !backupRoot) {
    process.stderr.write('Usage: node skill-repair-frontmatter.mjs --drafts <drafts.json> --library <dir> --backup <dir> [--apply]\n');
    return 2;
  }
  const doc = JSON.parse(await readFile(draftsPath, 'utf8'));
  const receipt = await applyDrafts({ drafts: doc.drafts ?? doc, library, backupRoot, apply });
  process.stdout.write(`${JSON.stringify({ applied: apply, changed: receipt.changes.length,
    refused: receipt.refusals.length,
    receipt: apply ? join(backupRoot, 'frontmatter-receipt.json') : null,
    sample: receipt.changes.slice(0, 3), refusals: receipt.refusals }, null, 2)}\n`);
  return receipt.refusals.length === 0 ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
