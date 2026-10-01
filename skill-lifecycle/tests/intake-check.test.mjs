import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = fileURLToPath(new URL('../control/intake-check.mjs', import.meta.url));
const { scanBatch, looksOpaque, isZeroFill } = await import(SCRIPT);

async function makeBatch(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'intake-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  const clean = join(root, 'clean');
  const flagged = join(root, 'flagged');
  await mkdir(join(clean, 'sub'), { recursive: true });
  await mkdir(flagged, { recursive: true });
  await writeFile(join(clean, 'a.md'), '普通材料，utf8 正文。\n');
  await writeFile(join(clean, 'sub', 'b.md'), '第二份材料。\n');
  await writeFile(join(flagged, 'empty.txt'), '');
  await writeFile(join(flagged, 'nonutf8.bin'), Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x80]));
  await writeFile(join(flagged, 'opaque.dat'), Buffer.concat([Buffer.from([0x88, 0x7d, 0x1c]), Buffer.from('payload')]));
  await writeFile(join(flagged, 'zero.bin'), Buffer.alloc(4096));
  await writeFile(join(flagged, 'secret.md'),
    '配置：sk-abcdefgh12345678\n-----BEGIN RSA PRIVATE KEY-----\n见 ~/.dsh/.credentials.yaml\n');
  return { root, clean, flagged };
}

test('干净包：清单/sha256 正确、无旗标', async (t) => {
  const { clean } = await makeBatch(t);
  const scan = await scanBatch(clean);
  assert.equal(scan.summary.files, 2);
  assert.equal(scan.summary.flagCounts.EMPTY_FILE, undefined);
  assert.equal(scan.summary.sensitiveHitCount, 0);
  assert.equal(scan.summary.ready, true);
  const a = scan.files.find(f => f.relPath === 'a.md');
  assert.equal(a.sha256, createHash('sha256').update('普通材料，utf8 正文。\n').digest('hex'));
  assert.deepEqual(a.flags, []);
});

test('旗标检测器会红：空文件/非UTF-8/不透明容器/零填充逐项命中', async (t) => {
  const { flagged } = await makeBatch(t);
  const scan = await scanBatch(flagged);
  const byName = Object.fromEntries(scan.files.map(f => [f.relPath, f.flags]));
  assert.deepEqual(byName['empty.txt'], ['EMPTY_FILE']);
  assert.deepEqual(byName['nonutf8.bin'], ['NON_UTF8']);
  assert.deepEqual(byName['opaque.dat'], ['OPAQUE_CONTAINER']);
  assert.deepEqual(byName['zero.bin'], ['SUSPECT_ZERO_FILL']);
  assert.equal(scan.summary.ready, false, '空文件导致 ready=false');
  assert.equal(looksOpaque(Buffer.from([0x88, 0x7d, 0x1c])), true);
  assert.equal(looksOpaque(Buffer.from('plain')), false);
  assert.equal(isZeroFill(Buffer.alloc(10)), true);
  assert.equal(isZeroFill(Buffer.alloc(0)), false);
});

test('敏感命中照实记录（含 sk-/私钥/凭据文件三族）', async (t) => {
  const { flagged } = await makeBatch(t);
  const scan = await scanBatch(flagged);
  const secret = scan.files.find(f => f.relPath === 'secret.md');
  const ids = new Set(secret.sensitiveHits.map(h => h.pattern));
  assert.ok(ids.has('sk-token'), 'sk- 命中');
  assert.ok(ids.has('private-key'), '私钥头命中');
  assert.ok(ids.has('credential-file'), '凭据文件引用命中');
  assert.ok(scan.summary.sensitiveHitCount >= 3);
});

test('CLI：dry-run 不写盘；apply 写回执；重复 apply 拒覆盖；缺目录退 2', async (t) => {
  const { clean } = await makeBatch(t);
  const dry = spawnSync(process.execPath, [SCRIPT, '--batch', clean, '--batch-id', 'B-T1'], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /"mode": "dry-run"/);
  await assert.rejects(readFile(join(clean, 'intake-receipt-B-T1.json')));

  const out = join(clean, 'receipt.json');
  const first = spawnSync(process.execPath, [SCRIPT, '--batch', clean, '--batch-id', 'B-T1', '--apply', '--out', out], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const receipt = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(receipt.record_type, 'w6-intake-receipt');
  assert.equal(receipt.batchId, 'B-T1');
  assert.equal(receipt.files.length, 2);
  assert.equal(receipt.summary.ready, true);

  const second = spawnSync(process.execPath, [SCRIPT, '--batch', clean, '--batch-id', 'B-T1', '--apply', '--out', out], { encoding: 'utf8' });
  assert.equal(second.status, 3);
  assert.match(second.stderr, /拒绝覆盖/);

  const missing = spawnSync(process.execPath, [SCRIPT, '--batch', join(clean, 'nope')], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /批次目录不存在/);
});

test('敏感命中时回执带人工辨认提醒', async (t) => {
  const { flagged } = await makeBatch(t);
  const out = join(flagged, 'receipt.json');
  const run = spawnSync(process.execPath, [SCRIPT, '--batch', flagged, '--batch-id', 'B-T2', '--apply', '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const receipt = JSON.parse(await readFile(out, 'utf8'));
  assert.ok(receipt.cautions.length >= 1);
  assert.match(receipt.cautions[0], /假阳性|人工辨认/);
});
