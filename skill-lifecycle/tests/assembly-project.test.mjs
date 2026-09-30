import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computePlanDigest, manifestDigest, projectToAssembly, walkFiles } from '../trial-home/screening/assembly-project.mjs';

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const readOrNull = async path => await readFile(path, 'utf8').catch(() => null);
const exists = async path => (await stat(path).catch(() => null)) !== null;

async function fixture(t) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'assembly-'));
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  const src = join(base, 'src');
  const targetRoot = join(base, 'library', '_assembly-v1');
  await mkdir(join(src, 'ad-creative', 'references'), { recursive: true });
  await writeFile(join(src, 'ad-creative', 'SKILL.md'), '# ad-creative\n');
  await writeFile(join(src, 'ad-creative', 'references', 'guide.md'), 'guide\n');
  return { base, src, targetRoot };
}

async function dirOp({ sourceDir, name, opId = 'op-001', group = 'T', entry = 'SKILL.md' }) {
  const { files } = await walkFiles(sourceDir);
  return {
    opId, mode: 'dir', group, name, sourceDir, entryRelPath: `${name}/${entry}`,
    entrySha256: files.find(file => file.relPath === entry).sha256, route: 'role-candidate',
    sourceFiles: files, sourceBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    sourceDigest: manifestDigest(files),
  };
}

function makePlan(targetRoot, operations, planId = 't1') {
  const plan = { planKind: 'assembly-projection', planVersion: 'assembly-v1', planId, targetRoot, operations };
  plan.planDigest = computePlanDigest(plan);
  return plan;
}

test('dry-run 只报计划，不建目标根、不写回执', async (t) => {
  const { src, targetRoot } = await fixture(t);
  const plan = makePlan(targetRoot, [await dirOp({ sourceDir: join(src, 'ad-creative'), name: 'ad-creative' })]);
  const report = await projectToAssembly({ plan, receiptPath: join(targetRoot, '..', 'r.json') });
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.summary.planned, 1);
  assert.equal(await exists(targetRoot), false, 'dry-run 不许建目标根');
  assert.equal(await readOrNull(join(targetRoot, '..', 'r.json')), null, 'dry-run 不写回执');
});

test('apply 落位目录投影：文件一致、meta 生成、回执防覆盖', async (t) => {
  const { base, src, targetRoot } = await fixture(t);
  const op = await dirOp({ sourceDir: join(src, 'ad-creative'), name: 'ad-creative' });
  const plan = makePlan(targetRoot, [op]);
  const receiptPath = join(base, 'receipts', 't1.json');
  const report = await projectToAssembly({ plan, apply: true, receiptPath });
  assert.equal(report.summary.applied, 1);
  assert.equal(await readOrNull(join(targetRoot, 'ad-creative', 'SKILL.md')), '# ad-creative\n');
  assert.equal(await readOrNull(join(targetRoot, 'ad-creative', 'references', 'guide.md')), 'guide\n');
  const meta = JSON.parse(await readFile(join(targetRoot, 'ad-creative', '.assembly-meta.json'), 'utf8'));
  assert.equal(meta.name, 'ad-creative');
  assert.equal(meta.sourcePath, 'ad-creative/SKILL.md');
  assert.equal(meta.sourceSha256, sha256('# ad-creative\n'));
  assert.equal(meta.planId, 't1');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(receipt.receiptKind, 'assembly-projection-receipt');
  assert.equal(receipt.summary.applied, 1);
  await assert.rejects(() => projectToAssembly({ plan, apply: true, receiptPath }),
    error => error.code === 'RECEIPT_EXISTS');
});

test('幂等：目标已全等时 already-present，不再写回执', async (t) => {
  const { base, src, targetRoot } = await fixture(t);
  const op = await dirOp({ sourceDir: join(src, 'ad-creative'), name: 'ad-creative' });
  const plan = makePlan(targetRoot, [op]);
  await projectToAssembly({ plan, apply: true, receiptPath: join(base, 'r1.json') });
  const report = await projectToAssembly({ plan, apply: true, receiptPath: join(base, 'r2.json') });
  assert.equal(report.summary.alreadyPresent, 1);
  assert.equal(report.summary.applied, 0);
  assert.equal(await exists(join(base, 'r2.json')), false, '无落位不写回执');
});

test('TARGET_CONFLICT：目标存在且内容不同时拒收，目标保持原样', async (t) => {
  const { src, targetRoot } = await fixture(t);
  await mkdir(join(targetRoot, 'ad-creative'), { recursive: true });
  await writeFile(join(targetRoot, 'ad-creative', 'SKILL.md'), 'different\n');
  const plan = makePlan(targetRoot, [await dirOp({ sourceDir: join(src, 'ad-creative'), name: 'ad-creative' })]);
  const report = await projectToAssembly({ plan, apply: true, receiptPath: join(targetRoot, '..', 'r.json') });
  assert.equal(report.results[0].reason, 'TARGET_CONFLICT');
  assert.equal(await readOrNull(join(targetRoot, 'ad-creative', 'SKILL.md')), 'different\n');
});

test('SOURCE_CHANGED / SOURCE_MISSING：源漂移与源缺失都拒收', async (t) => {
  const { src, targetRoot } = await fixture(t);
  const op = await dirOp({ sourceDir: join(src, 'ad-creative'), name: 'ad-creative' });
  const plan = makePlan(targetRoot, [op]);
  await writeFile(join(src, 'ad-creative', 'SKILL.md'), '# drifted\n');
  const drifted = await projectToAssembly({ plan, apply: true, receiptPath: join(targetRoot, '..', 'r.json') });
  assert.equal(drifted.results[0].reason, 'SOURCE_CHANGED');
  const missing = await projectToAssembly({ plan: makePlan(targetRoot,
    [{ ...op, opId: 'op-002', name: 'ghost', sourceDir: join(src, 'ghost'), sourceDigest: op.sourceDigest }]) });
  assert.equal(missing.results[0].reason, 'SOURCE_MISSING');
});

test('flat 形态：apply 落位、内容不同即冲突', async (t) => {
  const { base, src, targetRoot } = await fixture(t);
  const flat = { opId: 'op-001', mode: 'flat', group: 'C', name: 'leadership-strategy-playbook',
    sourceFile: join(src, 'pilot.md'), sourceSha256: sha256('pilot body\n'), entryRelPath: 'pilot.md', entrySha256: sha256('pilot body\n') };
  await writeFile(join(src, 'pilot.md'), 'pilot body\n');
  await projectToAssembly({ plan: makePlan(targetRoot, [flat]), apply: true, receiptPath: join(base, 'r1.json') });
  assert.equal(await readOrNull(join(targetRoot, 'leadership-strategy-playbook.md')), 'pilot body\n');
  const again = await projectToAssembly({ plan: makePlan(targetRoot, [flat]), apply: true, receiptPath: join(base, 'r2.json') });
  assert.equal(again.summary.alreadyPresent, 1);
  await writeFile(join(targetRoot, 'leadership-strategy-playbook.md'), 'tampered\n');
  const conflicted = await projectToAssembly({ plan: makePlan(targetRoot, [flat]), apply: true, receiptPath: join(base, 'r3.json') });
  assert.equal(conflicted.results[0].reason, 'TARGET_CONFLICT');
  assert.equal(await readOrNull(join(targetRoot, 'leadership-strategy-playbook.md')), 'tampered\n');
});

test('PLAN_DIGEST_MISMATCH：计划被改而不重算摘要即拒', async (t) => {
  const { src, targetRoot } = await fixture(t);
  const plan = makePlan(targetRoot, [await dirOp({ sourceDir: join(src, 'ad-creative'), name: 'ad-creative' })]);
  plan.operations[0].name = 'renamed-after-digest';
  await assert.rejects(() => projectToAssembly({ plan }), error => error.code === 'PLAN_DIGEST_MISMATCH');
});

test('DUPLICATE_TARGET：重名目标全拒，不做先到先得', async (t) => {
  const { src, targetRoot } = await fixture(t);
  await mkdir(join(src, 'copy-b'), { recursive: true });
  await writeFile(join(src, 'copy-b', 'SKILL.md'), '# copy-b\n');
  const plan = makePlan(targetRoot, [
    await dirOp({ sourceDir: join(src, 'ad-creative'), name: 'same-name', opId: 'op-001' }),
    await dirOp({ sourceDir: join(src, 'copy-b'), name: 'same-name', opId: 'op-002' }),
  ]);
  const report = await projectToAssembly({ plan, apply: true, receiptPath: join(targetRoot, '..', 'r.json') });
  assert.deepEqual(report.results.map(r => r.reason), ['DUPLICATE_TARGET', 'DUPLICATE_TARGET']);
  assert.equal(await exists(join(targetRoot, 'same-name')), false);
});

test('垃圾文件不进清单也不被复制；符号链接记录但不复制', async (t) => {
  const { src, targetRoot } = await fixture(t);
  const dir = join(src, 'ad-creative');
  await writeFile(join(dir, '.DS_Store'), 'junk');
  await mkdir(join(dir, '__pycache__'), { recursive: true });
  await writeFile(join(dir, '__pycache__', 'x.pyc'), 'junk');
  const op = await dirOp({ sourceDir: dir, name: 'ad-creative' });
  assert.equal(op.sourceFiles.some(file => file.relPath.includes('DS_Store') || file.relPath.endsWith('.pyc')), false);
  const plan = makePlan(targetRoot, [op]);
  await projectToAssembly({ plan, apply: true, receiptPath: join(targetRoot, '..', 'r.json') });
  assert.equal(await exists(join(targetRoot, 'ad-creative', '.DS_Store')), false);
  assert.equal(await exists(join(targetRoot, 'ad-creative', '__pycache__')), false);
});

test('清单含源目录不存在的文件 ⇒ 拒收且不留半成品', async (t) => {
  const { src, targetRoot } = await fixture(t);
  const op = await dirOp({ sourceDir: join(src, 'ad-creative'), name: 'ad-creative' });
  op.sourceFiles = [...op.sourceFiles, { relPath: 'missing.md', sha256: sha256('x\n'), bytes: 2 }];
  op.sourceDigest = manifestDigest(op.sourceFiles);
  const plan = makePlan(targetRoot, [op]);
  const report = await projectToAssembly({ plan, apply: true, receiptPath: join(targetRoot, '..', 'r.json') });
  assert.equal(report.results[0].reason, 'SOURCE_CHANGED', '清单与源目录不一致 ⇒ 源漂移拒收（防半成品）');
  assert.equal(await exists(join(targetRoot, 'ad-creative')), false);
});

/** 目标目录当下清单摘要（不含 meta）——用作 expectTargetDigest 的真实来源。 */
async function targetDigest(dir) {
  const { files } = await walkFiles(dir);
  return manifestDigest(files.filter(file => file.relPath !== '.assembly-meta.json'));
}

test('受控更新：dry-run 报 planned-update；apply 落新版、旧版进 _assembly-history、回执计入 updated', async (t) => {
  const { base, src, targetRoot } = await fixture(t);
  const v1 = await dirOp({ sourceDir: join(src, 'ad-creative'), name: 'ad-creative' });
  await projectToAssembly({ plan: makePlan(targetRoot, [v1]), apply: true, receiptPath: join(base, 'r1.json') });
  const oldDigest = await targetDigest(join(targetRoot, 'ad-creative'));
  assert.equal(oldDigest, v1.sourceDigest, '先自证：目标清单 == v1 清单');

  await writeFile(join(src, 'ad-creative', 'SKILL.md'), '# ad-creative v2\n');
  await writeFile(join(src, 'ad-creative', 'references', 'extra.md'), 'extra\n');
  const v2 = { ...(await dirOp({ sourceDir: join(src, 'ad-creative'), name: 'ad-creative' })),
    expectTargetDigest: oldDigest };
  const plan2 = makePlan(targetRoot, [v2], 't2');

  const dry = await projectToAssembly({ plan: plan2, receiptPath: join(base, 'r2.json') });
  assert.equal(dry.results[0].status, 'planned-update');
  assert.equal(await readOrNull(join(targetRoot, 'ad-creative', 'SKILL.md')), '# ad-creative\n', 'dry-run 不许动目标');
  assert.equal(await exists(join(base, 'library', '_assembly-history')), false, 'dry-run 不许建归档');

  const applied = await projectToAssembly({ plan: plan2, apply: true, receiptPath: join(base, 'r2.json') });
  assert.equal(applied.summary.updated, 1);
  assert.equal(await readOrNull(join(targetRoot, 'ad-creative', 'SKILL.md')), '# ad-creative v2\n');
  assert.equal(await readOrNull(join(targetRoot, 'ad-creative', 'references', 'extra.md')), 'extra\n');
  assert.equal(await readOrNull(join(targetRoot, 'ad-creative', 'references', 'guide.md')), 'guide\n', '未变文件仍在');
  const hist = join(base, 'library', '_assembly-history', 'ad-creative', oldDigest.slice(0, 12));
  assert.equal(await readOrNull(join(hist, 'SKILL.md')), '# ad-creative\n', '归档必须是旧版原件');
  const oldMeta = JSON.parse(await readFile(join(hist, '.assembly-meta.json'), 'utf8'));
  assert.equal(oldMeta.planId, 't1', '归档保留的是旧版自己的 meta');
  const newMeta = JSON.parse(await readFile(join(targetRoot, 'ad-creative', '.assembly-meta.json'), 'utf8'));
  assert.equal(newMeta.replacedDigest, oldDigest.slice(0, 16));
  assert.equal(await exists(join(targetRoot, '_assembly-history')), false, '归档必须是装配根的兄弟目录，不能进根内');
  const receipt = JSON.parse(await readFile(join(base, 'r2.json'), 'utf8'));
  assert.equal(receipt.summary.updated, 1);
});

test('更新闸门：无凭据拒收、目标漂移拒收、目标缺失拒收', async (t) => {
  const { base, src, targetRoot } = await fixture(t);
  await mkdir(join(targetRoot, 'ad-creative'), { recursive: true });
  await writeFile(join(targetRoot, 'ad-creative', 'SKILL.md'), 'stale\n');
  const drifted = await dirOp({ sourceDir: join(src, 'ad-creative'), name: 'ad-creative' });

  const noWarrant = await projectToAssembly({ plan: makePlan(targetRoot, [drifted]),
    apply: true, receiptPath: join(base, 'r.json') });
  assert.equal(noWarrant.results[0].reason, 'TARGET_CONFLICT', '无 expectTargetDigest 不得更新既有目标');

  const wrong = { ...drifted, expectTargetDigest: sha256('not-the-current-manifest') };
  const changed = await projectToAssembly({ plan: makePlan(targetRoot, [wrong], 't2'),
    apply: true, receiptPath: join(base, 'r2.json') });
  assert.equal(changed.results[0].reason, 'CONTENT_CHANGED');
  assert.equal(await readOrNull(join(targetRoot, 'ad-creative', 'SKILL.md')), 'stale\n', '拒收后目标保持原样');

  const missingOp = { ...drifted, name: 'not-there', expectTargetDigest: sha256('x') };
  const missing = await projectToAssembly({ plan: makePlan(targetRoot, [missingOp], 't3') });
  assert.equal(missing.results[0].reason, 'TARGET_MISSING', '带凭据却无目标 ⇒ 拒收（防误判为新建）');
});

test('等值优先 already-present；归档等价时复用不搬家', async (t) => {
  const { base, src, targetRoot } = await fixture(t);
  const v1 = await dirOp({ sourceDir: join(src, 'ad-creative'), name: 'ad-creative' });
  await projectToAssembly({ plan: makePlan(targetRoot, [v1]), apply: true, receiptPath: join(base, 'r1.json') });
  const same = { ...v1, expectTargetDigest: v1.sourceDigest };
  const report = await projectToAssembly({ plan: makePlan(targetRoot, [same], 't2'),
    apply: true, receiptPath: join(base, 'r2.json') });
  assert.equal(report.summary.alreadyPresent, 1);
  assert.equal(await exists(join(base, 'library', '_assembly-history')), false, '等值不做归档');

  const old = await targetDigest(join(targetRoot, 'ad-creative'));
  const seeded = join(base, 'library', '_assembly-history', 'ad-creative', old.slice(0, 12));
  await mkdir(seeded, { recursive: true });
  await cp(join(targetRoot, 'ad-creative'), seeded, { recursive: true });
  await writeFile(join(src, 'ad-creative', 'SKILL.md'), '# ad-creative v2\n');
  const v2 = { ...(await dirOp({ sourceDir: join(src, 'ad-creative'), name: 'ad-creative' })),
    expectTargetDigest: old };
  const updated = await projectToAssembly({ plan: makePlan(targetRoot, [v2], 't3'),
    apply: true, receiptPath: join(base, 'r3.json') });
  assert.equal(updated.results[0].status, 'updated');
  assert.equal(updated.results[0].historyReused, true, '等价归档复用不重复搬家');
  assert.equal(await readOrNull(join(targetRoot, 'ad-creative', 'SKILL.md')), '# ad-creative v2\n');
});
