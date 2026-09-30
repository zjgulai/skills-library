import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDraftCandidate } from '../control/draft-candidate.mjs';
import { draftContract } from '../control/requirement-intake.mjs';

const signals = { recurring: true, existingSkillCovers: false, needsJudgment: true };
const draft = {
  triggers: ['用户要求核验一份本地分析报告'],
  inputs: ['报告文件', '数据表'],
  outputs: ['核验报告（含逐条发现与依据）'],
  constraints: ['只读输入，不修改源文件', '不联网、不访问外部服务'],
  outOfScope: ['重做分析', '出图'],
  openQuestions: [],
};

function contract() {
  return draftContract({ requirement: '为团队提供一份核验清单的自动化', signals, draft });
}

const SKILL_MD = [
  '---',
  'name: checker-lite',
  'description: QA a local analysis before sharing.',
  '---',
  '',
  '# checker-lite',
  '',
  '## Constraints',
  '',
  '- 只读输入，不修改源文件',
  '- 不联网、不访问外部服务',
  '',
  '## Workflow',
  '',
  '1. 读取报告与数据表。',
  '2. 逐条核验并给出依据。',
  '',
].join('\n');

async function makeCase(t, overrides = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'draft-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  const candidate = await openDraftCandidate({ root, candidateId: 'checker-lite-001',
    contract: contract(), name: 'checker-lite', description: 'QA a local analysis before sharing.',
    hypothesis: { claim: '把核验清单固化成技能后，非核验请求也会先被界定',
      expectedEffect: '回应开头出现范围界定语' },
    affectedScope: ['defect-tasks', 'non-validation-requests'], now: () => 1000, ...overrides });
  return { root, candidate };
}

test('a draft bound to a draftable contract writes, seals and verifies', async (t) => {
  const { root, candidate } = await makeCase(t);
  const preview = candidate.preview();
  assert.equal(preview.skillName, 'checker-lite');
  assert.deepEqual(preview.contractConstraints, draft.constraints);
  const written = await candidate.writeDraft({ 'SKILL.md': SKILL_MD, 'refs/checklist.md': '- 复算\n' });
  assert.equal(typeof written.draftDigest, 'string');
  assert.deepEqual(written.files.map(file => file.relPath), ['SKILL.md', 'refs/checklist.md']);
  const sealed = await candidate.seal();
  assert.equal(sealed.sealed, true);
  assert.deepEqual(await candidate.verify({ contract: contract() }),
    { ok: true, checks: ['contract', 'file-set', 'digests'], contractDigest: preview.contractDigest });
  const manifest = JSON.parse(await readFile(join(root, 'checker-lite-001', 'candidate.json'), 'utf8'));
  assert.equal(manifest.record_type, 'draft_candidate');
  assert.equal(manifest.contractDigest, preview.contractDigest);
  assert.equal(manifest.sealed, true);
});

test('a contract that is not draftable is refused', async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'draft-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  const notDraftable = draftContract({ requirement: '一次性需求', signals: { ...signals, recurring: false }, draft });
  await assert.rejects(openDraftCandidate({ root, candidateId: 'x-001', contract: notDraftable,
    name: 'checker-lite', description: 'd', hypothesis: { claim: 'c', expectedEffect: 'e' },
    affectedScope: ['a'] }), /CONTRACT_NOT_DRAFTABLE/);
  await assert.rejects(openDraftCandidate({ root, candidateId: 'x-001', contract: { verdict: 'draftable',
    contract: { need: 'n', triggers: [], inputs: [], outputs: [], constraints: [], outOfScope: [], openQuestions: [] } },
    name: 'checker-lite', description: 'd', hypothesis: { claim: 'c', expectedEffect: 'e' },
    affectedScope: ['a'] }), /INVALID_CONTRACT/);
});

test('the draft may not rename itself away from the declared skill name', async (t) => {
  const { candidate } = await makeCase(t);
  const renamed = SKILL_MD.replace('name: checker-lite', 'name: checker-lite-v2');
  await assert.rejects(candidate.writeDraft({ 'SKILL.md': renamed }), /SKILL_NAME_MISMATCH/);
  const otherDescription = SKILL_MD.replace('description: QA a local analysis before sharing.',
    'description: something else');
  await assert.rejects(candidate.writeDraft({ 'SKILL.md': otherDescription }), /SKILL_DESCRIPTION_MISMATCH/);
});

test('every contract constraint must be carried verbatim in SKILL.md', async (t) => {
  const { candidate } = await makeCase(t);
  const dropped = SKILL_MD.replace('- 不联网、不访问外部服务\n', '');
  await assert.rejects(candidate.writeDraft({ 'SKILL.md': dropped }),
    /CONSTRAINT_NOT_COVERED: 不联网、不访问外部服务/);
});

test('draft files are validated before anything is written', async (t) => {
  const { candidate, root } = await makeCase(t);
  await assert.rejects(candidate.writeDraft({}), /INVALID_DRAFT_FILES/);
  await assert.rejects(candidate.writeDraft({ 'refs/notes.md': 'x' }), /INVALID_DRAFT_FILES/,
    'a draft without SKILL.md is not a skill');
  await assert.rejects(candidate.writeDraft({ 'SKILL.md': SKILL_MD, '../escape.md': 'x' }), /INVALID_DRAFT_FILES/);
  await assert.rejects(candidate.writeDraft({ 'SKILL.md': 'x'.repeat(65537) }), /INVALID_DRAFT_FILES/);
  await assert.rejects(readFile(join(root, 'checker-lite-001', 'candidate', 'SKILL.md'), 'utf8'), /ENOENT/);
});

test('sealing blocks later writes and verify detects tampering', async (t) => {
  const { candidate, root } = await makeCase(t);
  await candidate.writeDraft({ 'SKILL.md': SKILL_MD });
  await candidate.seal();
  await assert.rejects(candidate.writeDraft({ 'SKILL.md': SKILL_MD }), /CANDIDATE_SEALED/);
  await writeFile(join(root, 'checker-lite-001', 'candidate', 'SKILL.md'), `${SKILL_MD}\n# tampered\n`);
  await assert.rejects(candidate.verify(), /CANDIDATE_FILE_CHANGED: SKILL\.md/);
  await writeFile(join(root, 'checker-lite-001', 'candidate', 'extra.md'), 'extra\n');
  await assert.rejects(candidate.verify(), /CANDIDATE_FILE_CHANGED|CANDIDATE_FILE_SET_CHANGED/);
});

test('a nested file is tracked and tampering with it is detected', async (t) => {
  const { candidate, root } = await makeCase(t);
  const files = { 'SKILL.md': SKILL_MD, 'refs/checklist.md': '- 复算\n' };
  await candidate.writeDraft(files);
  await candidate.seal();
  const ok = await candidate.verify({ contract: contract() });
  assert.equal(ok.ok, true, 'a clean nested draft must verify (basename-only sets fail here)');
  const nested = join(root, 'checker-lite-001', 'candidate', 'refs', 'checklist.md');
  await writeFile(nested, '- 篡改\n');
  await assert.rejects(candidate.verify(), /CANDIDATE_FILE_CHANGED: refs\/checklist\.md/);
  await writeFile(nested, files['refs/checklist.md']);
  assert.equal((await candidate.verify()).ok, true, 'restoring the bytes restores the identity');
  await writeFile(join(root, 'checker-lite-001', 'candidate', 'refs', 'extra.md'), 'x\n');
  await assert.rejects(candidate.verify(), /CANDIDATE_FILE_SET_CHANGED/);
});

test('a contract that changed after opening is refused at verify time', async (t) => {
  const { candidate } = await makeCase(t);
  await candidate.writeDraft({ 'SKILL.md': SKILL_MD });
  const revised = draftContract({ requirement: '为团队提供一份核验清单的自动化', signals,
    draft: { ...draft, constraints: ['只读输入，不修改源文件', '不联网、不访问外部服务', '不得写生产目录'] } });
  await assert.rejects(candidate.verify({ contract: revised }), /CONTRACT_CHANGED/);
});

test('ids, hypothesis and scope are validated', async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'draft-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  const base = { root, candidateId: 'checker-lite-001', contract: contract(),
    name: 'checker-lite', description: 'QA a local analysis before sharing.' };
  await assert.rejects(openDraftCandidate({ ...base, candidateId: 'Bad',
    hypothesis: { claim: 'c', expectedEffect: 'e' }, affectedScope: ['a'] }), /INVALID_CANDIDATE_ID/);
  await assert.rejects(openDraftCandidate({ ...base, name: 'Bad_Name',
    hypothesis: { claim: 'c', expectedEffect: 'e' }, affectedScope: ['a'] }), /INVALID_SKILL_NAME/);
  await assert.rejects(openDraftCandidate({ ...base, hypothesis: { claim: 'c' }, affectedScope: ['a'] }),
    /INVALID_HYPOTHESIS/);
  await assert.rejects(openDraftCandidate({ ...base, hypothesis: { claim: 'c', expectedEffect: 'e' },
    affectedScope: [] }), /INVALID_AFFECTED_SCOPE/);
  const created = await openDraftCandidate({ ...base, hypothesis: { claim: 'c', expectedEffect: 'e' },
    affectedScope: ['a'] });
  assert.equal(created.skillName, 'checker-lite');
  await assert.rejects(openDraftCandidate({ ...base, hypothesis: { claim: 'c', expectedEffect: 'e' },
    affectedScope: ['a'] }), /CANDIDATE_EXISTS/);
});
