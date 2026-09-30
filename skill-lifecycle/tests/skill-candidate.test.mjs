import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCandidate } from '../control/skill-candidate.mjs';

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

const SOURCE_TEXT = [
  '---',
  'name: validate-data',
  'description: QA an analysis before sharing.',
  '---',
  '',
  '# /validate-data',
  '',
  '## Workflow',
  '',
  '### 1. Review Methodology',
  '',
  'Checks the framing.',
  '',
  '### 2. Run the QA Checklist',
  '',
  'Walks the checklist.',
  '',
].join('\n');

const CANDIDATE_TEXT = SOURCE_TEXT.replace(
  'Walks the checklist.',
  'Walks the checklist.\n\n### 2b. Scope Boundary\n\nIf the request is not a validation task, state the boundary before doing anything else.');

function changeSets() {
  return {
    changes: [{ target: '### 2. Run the QA Checklist', kind: 'edit',
      rationale: 'A4 t7 负读数：非核验请求未被界定范围' }],
    hypothesis: {
      claim: '加入范围界定条款后，非核验请求会被明确界定而不是被当作核验任务执行',
      evidence: 'A4 轮三 t7：模型完成汇总与术语解释但未界定“这不是核验请求”，判 inconclusive',
      expectedEffect: 't7 产出中出现范围界定表述，且在读技能后更早给出',
      regressionRisk: 't1—t6 的核验流程被额外条款干扰，报告变长或误判范围',
    },
    affectedScope: ['t7-near-neighbor', 't1-consistent', 't2-recompute'],
  };
}

async function makeCase(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'candidate-'));
  const sourcePath = join(root, 'SKILL.md');
  await writeFile(sourcePath, SOURCE_TEXT);
  const digest = sha256(SOURCE_TEXT);
  const candidatesRoot = join(root, 'candidates');
  await mkdir(candidatesRoot, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  return { root, sourcePath, digest, candidatesRoot };
}

async function openCase(t, overrides = {}) {
  const base = await makeCase(t);
  const specs = changeSets();
  const options = { root: base.candidatesRoot, candidateId: 'cand-001',
    source: { path: base.sourcePath, digest: base.digest }, ...specs, ...overrides.options };
  const candidate = await openCandidate(options);
  return { ...base, candidate, texts: overrides.texts ?? { source: SOURCE_TEXT, candidate: CANDIDATE_TEXT } };
}

test('root, id, source, changes and hypothesis are validated', async (t) => {
  const base = await makeCase(t);
  const specs = changeSets();
  await assert.rejects(openCandidate({ root: join(base.root, 'missing'), candidateId: 'cand-001',
    source: { path: base.sourcePath, digest: base.digest }, ...specs }), /INVALID_CANDIDATE_ROOT/);
  await assert.rejects(openCandidate({ root: base.candidatesRoot, candidateId: 'X',
    source: { path: base.sourcePath, digest: base.digest }, ...specs }), /INVALID_CANDIDATE_ID/);
  await assert.rejects(openCandidate({ root: base.candidatesRoot, candidateId: 'cand-001',
    source: { path: base.sourcePath, digest: 'nope' }, ...specs }), /INVALID_CANDIDATE_SOURCE/);
  await assert.rejects(openCandidate({ root: base.candidatesRoot, candidateId: 'cand-001',
    source: { path: base.sourcePath, digest: base.digest }, ...specs, changes: [] }), /INVALID_CHANGES/);
  await assert.rejects(openCandidate({ root: base.candidatesRoot, candidateId: 'cand-001',
    source: { path: base.sourcePath, digest: base.digest }, changes: specs.changes,
    hypothesis: { claim: 'x' } }), /INVALID_HYPOTHESIS/);
});

test('a source whose digest no longer matches is refused before anything is written', async (t) => {
  const base = await makeCase(t);
  await writeFile(base.sourcePath, `${SOURCE_TEXT}\nchanged\n`);
  const specs = changeSets();
  await assert.rejects(openCandidate({ root: base.candidatesRoot, candidateId: 'cand-001',
    source: { path: base.sourcePath, digest: base.digest }, ...specs }), /SOURCE_IDENTITY_CHANGED/);
});

test('an existing candidate id is never overwritten', async (t) => {
  const f = await openCase(t);
  await f.candidate.writeCandidate(CANDIDATE_TEXT);
  const specs = changeSets();
  await assert.rejects(openCandidate({ root: f.candidatesRoot, candidateId: 'cand-001',
    source: { path: f.sourcePath, digest: f.digest }, ...specs }), /CANDIDATE_EXISTS/);
});

test('writing a candidate records identity, diff and a preview without touching the source', async (t) => {
  const f = await openCase(t);
  const preview = f.candidate.preview();
  assert.equal(preview.candidateId, 'cand-001');
  assert.equal(preview.sourceDigest, f.digest);
  assert.equal(preview.hypothesis.claim, changeSets().hypothesis.claim);
  assert.deepEqual(preview.affectedScope, changeSets().affectedScope);
  const receipt = await f.candidate.writeCandidate(CANDIDATE_TEXT);
  assert.equal(receipt.sha256, sha256(CANDIDATE_TEXT));
  assert.equal(receipt.bytes, Buffer.byteLength(CANDIDATE_TEXT, 'utf8'));
  const manifest = JSON.parse(await readFile(join(f.candidatesRoot, 'cand-001', 'candidate.json'), 'utf8'));
  assert.equal(manifest.source.digest, f.digest);
  assert.equal(manifest.candidateDigest, receipt.sha256);
  assert.equal(manifest.diffSummary.addedLines, 4);
  assert.equal(manifest.diffSummary.removedLines, 0);
  assert.equal(manifest.sealed, false);
  const diff = await readFile(join(f.candidatesRoot, 'cand-001', 'candidate.diff'), 'utf8');
  assert.ok(diff.includes('+### 2b. Scope Boundary'), 'the inserted section must show as an addition');
  assert.ok(diff.includes(' Walks the checklist.'), 'untouched lines keep their context prefix');
  assert.ok(!diff.includes('-Walks the checklist.'), 'a pure insertion must not delete the anchor line');
  assert.equal(await readFile(f.sourcePath, 'utf8'), SOURCE_TEXT, 'the source stays untouched');
  assert.equal(sha256(await readFile(f.sourcePath, 'utf8')), f.digest);
});

test('a candidate that does not change anything is refused', async (t) => {
  const f = await openCase(t);
  await assert.rejects(f.candidate.writeCandidate(SOURCE_TEXT), /EMPTY_CHANGE/);
});

test('a candidate may not rename the skill', async (t) => {
  const f = await openCase(t);
  const renamed = CANDIDATE_TEXT.replace('name: validate-data', 'name: validate-data-v2');
  await assert.rejects(f.candidate.writeCandidate(renamed), /SKILL_NAME_CHANGED/);
});

test('declared change targets must exist on the claimed side', async (t) => {
  const f = await openCase(t, { options: { changes: [{ target: '### 9. Missing Section',
    kind: 'edit', rationale: 'claims a section that does not exist' }] } });
  await assert.rejects(f.candidate.writeCandidate(CANDIDATE_TEXT), /CHANGE_TARGET_MISSING/);
});

test('oversized and malformed candidate text is refused', async (t) => {
  const f = await openCase(t, { options: { maxBytes: 200 } });
  await assert.rejects(f.candidate.writeCandidate(CANDIDATE_TEXT), /CANDIDATE_TOO_LARGE/);
  const g = await openCase(t, { options: { candidateId: 'cand-002' } });
  await assert.rejects(g.candidate.writeCandidate(''), /INVALID_CANDIDATE_TEXT/);
});

test('sealing freezes the candidate and later writes are rejected', async (t) => {
  const f = await openCase(t);
  await f.candidate.writeCandidate(CANDIDATE_TEXT);
  const sealed = await f.candidate.seal();
  assert.equal(sealed.sealed, true);
  await assert.rejects(f.candidate.writeCandidate(`${CANDIDATE_TEXT}\nmore\n`), /CANDIDATE_SEALED/);
  const manifest = JSON.parse(await readFile(join(f.candidatesRoot, 'cand-001', 'candidate.json'), 'utf8'));
  assert.equal(manifest.sealed, true);
  assert.equal(typeof manifest.sealedAt, 'number');
});

test('verify detects a tampered candidate and a modified source', async (t) => {
  const f = await openCase(t);
  await f.candidate.writeCandidate(CANDIDATE_TEXT);
  assert.deepEqual(await f.candidate.verify(), { ok: true, checks: ['source', 'candidate', 'diff'] });
  await writeFile(join(f.candidatesRoot, 'cand-001', 'candidate', 'SKILL.md'), `${CANDIDATE_TEXT}\n# tampered\n`);
  await assert.rejects(f.candidate.verify(), /CANDIDATE_IDENTITY_CHANGED/);
  const g = await openCase(t, { options: { candidateId: 'cand-003' } });
  await g.candidate.writeCandidate(CANDIDATE_TEXT);
  await writeFile(g.sourcePath, 'changed');
  await assert.rejects(g.candidate.assertSourceUnchanged(), /SOURCE_IDENTITY_CHANGED/);
});

test('the candidate root refuses symlinked or missing directories', async (t) => {
  const base = await makeCase(t);
  const link = join(base.root, 'linked');
  await symlink(base.candidatesRoot, link);
  const specs = changeSets();
  await assert.rejects(openCandidate({ root: link, candidateId: 'cand-001',
    source: { path: base.sourcePath, digest: base.digest }, ...specs }), /INVALID_CANDIDATE_ROOT/);
});
