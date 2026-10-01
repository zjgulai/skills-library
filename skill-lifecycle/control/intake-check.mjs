#!/usr/bin/env node
/**
 * W6 材料接收·文件级校验（119 号 §2.2/§2.3 的机读件，零请求）。
 *
 * 对 `trial-home/intake/<BATCH-ID>/` 的原始材料包做：
 *   清单登记（名称/size/sha256）＋文件级校验（空文件、非 UTF-8、不透明容器、
 *   零填充怀疑、敏感模式扫描）→ 产出回执 intake-receipt-<BATCH-ID>.json。
 *
 * 边界：只报事实不判处置——六要素逐份回执、去向分档、台账回填仍是人工步骤（119 §2.4—2.6）。
 * `sk-` 一类命中会误中技能名等假阳性，工具照实标记（119 §2.3 已注明），人工辨认。
 *
 * 用法：
 *   node skill-lifecycle/control/intake-check.mjs --batch <dir> [--batch-id <ID>] [--apply] [--out <receipt.json>]
 *   默认 dry-run（只打印摘要，不写盘）；--apply 写回执（已存在则拒绝覆盖）。
 * 退出码：0 正常；2 用法错/批次目录不存在；3 已有回执拒绝。
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ZERO_PROBE = 8192;

const SENSITIVE_PATTERNS = [
  { id: 'sk-token', pattern: /sk-[A-Za-z0-9_-]{8,}/g },
  { id: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'credential-file', pattern: /\.credentials\.ya?ml/g },
  { id: 'key-assignment', pattern: /(api[_-]?key|apikey|password|passwd|secret)\s*[:=]\s*['"]?[A-Za-z0-9_\-.]{8,}/gi },
];

export function looksOpaque(buffer) {
  return buffer.length >= 3 && buffer[0] === 0x88 && buffer[1] === 0x7d && buffer[2] === 0x1c;
}

export function isZeroFill(buffer) {
  if (buffer.length === 0) return false;
  const head = buffer.subarray(0, Math.min(ZERO_PROBE, buffer.length));
  if (!head.every(byte => byte === 0)) return false;
  if (buffer.length <= ZERO_PROBE) return true;
  const tail = buffer.subarray(Math.max(0, buffer.length - ZERO_PROBE));
  return tail.every(byte => byte === 0);
}

async function walk(dir, prefix, out) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.DS_Store') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, rel, out);
    else if (entry.isFile()) out.push({ rel, full });
  }
}

export async function scanBatch(batchDir) {
  const entries = [];
  await walk(batchDir, '', entries);
  const files = [];
  const flagCounts = {};
  let sensitiveHits = 0;
  for (const { rel, full } of entries) {
    const buffer = await readFile(full);
    const flags = [];
    if (buffer.length === 0) flags.push('EMPTY_FILE');
    if (looksOpaque(buffer)) flags.push('OPAQUE_CONTAINER');
    if (isZeroFill(buffer)) flags.push('SUSPECT_ZERO_FILL');
    let text = null;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      // 不透明容器天然非 UTF-8：具体诊断已给出，不再重复标 NON_UTF8
      if (!flags.includes('OPAQUE_CONTAINER')) flags.push('NON_UTF8');
    }
    const hits = [];
    if (text !== null && !flags.includes('OPAQUE_CONTAINER')) {
      const lines = text.split(/\r?\n/);
      for (const { id, pattern } of SENSITIVE_PATTERNS) {
        for (let index = 0; index < lines.length; index += 1) {
          const re = new RegExp(pattern.source, pattern.flags);
          if (re.test(lines[index])) {
            hits.push({ pattern: id, line: index + 1, excerpt: lines[index].trim().slice(0, 80) });
          }
        }
      }
    }
    for (const flag of flags) flagCounts[flag] = (flagCounts[flag] ?? 0) + 1;
    sensitiveHits += hits.length;
    files.push({
      relPath: rel,
      size: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      flags,
      sensitiveHits: hits,
    });
  }
  const stats = await stat(batchDir);
  return {
    files,
    summary: {
      files: files.length,
      bytes: files.reduce((sum, f) => sum + f.size, 0),
      flagCounts,
      sensitiveHitCount: sensitiveHits,
      batchMtimeIso: stats.mtime.toISOString(),
      ready: entries.length > 0 && !flagCounts.EMPTY_FILE,
    },
  };
}

function receiptFor(batchId, scan) {
  return {
    record_type: 'w6-intake-receipt',
    tool: 'intake-check.mjs v1（119 号 §2.2/§2.3 机读件）',
    batchId,
    at: new Date().toISOString(),
    summary: scan.summary,
    cautions: scan.summary.sensitiveHitCount > 0
      ? ['敏感命中可能含假阳性（如 sk- 命中技能名一类），须人工辨认后再定去向（119 §2.3）']
      : [],
    humanSteps: '六要素逐份回执、去向分档、g-supplement-status received[] 回填为人工步骤（119 §2.4—2.6）',
    files: scan.files,
  };
}

export async function main(argv) {
  const flag = name => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  const batch = flag('batch');
  const apply = argv.includes('--apply');
  if (!batch) {
    process.stderr.write('Usage: node skill-lifecycle/control/intake-check.mjs --batch <dir> [--batch-id <ID>] [--apply] [--out <receipt.json>]\n');
    return 2;
  }
  if (!existsSync(batch)) {
    process.stderr.write(`批次目录不存在：${batch}\n`);
    return 2;
  }
  const batchId = flag('batch-id') ?? basename(batch);
  const scan = await scanBatch(batch);
  const receipt = receiptFor(batchId, scan);
  const out = flag('out') ?? join(batch, `intake-receipt-${batchId}.json`);
  const printable = { batchId, out, ...receipt.summary,
    flagDetail: Object.fromEntries(scan.files.filter(f => f.flags.length).map(f => [f.relPath, f.flags])),
    sensitiveDetail: scan.files.filter(f => f.sensitiveHits.length)
      .map(f => ({ relPath: f.relPath, hits: f.sensitiveHits.length })) };
  if (!apply) {
    console.log(JSON.stringify({ mode: 'dry-run', ...printable }, null, 1));
    return 0;
  }
  if (existsSync(out)) {
    process.stderr.write(`已有回执，拒绝覆盖：${out}\n`);
    return 3;
  }
  await writeFile(out, `${JSON.stringify(receipt, null, 1)}\n`);
  console.log(JSON.stringify({ mode: 'apply', receipt: out, ...printable }, null, 1));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
