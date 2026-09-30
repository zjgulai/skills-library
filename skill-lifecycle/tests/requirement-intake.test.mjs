import test from 'node:test';
import assert from 'node:assert/strict';
import { draftContract } from '../control/requirement-intake.mjs';

const signals = (overrides = {}) => ({ recurring: true, existingSkillCovers: false,
  needsJudgment: true, ...overrides });
const draft = (overrides = {}) => ({
  triggers: ['用户要求核验一份本地分析报告'],
  inputs: ['报告文件', '数据表'],
  outputs: ['核验报告（含逐条发现与依据）'],
  constraints: ['只读输入', '不联网'],
  outOfScope: ['重做分析', '出图'],
  openQuestions: [],
  ...overrides,
});

test('a recurring, uncovered need with judgement drafts a contract', () => {
  const result = draftContract({ requirement: '核验本地经营分析报告', signals: signals(), draft: draft() });
  assert.equal(result.verdict, 'draftable');
  assert.deepEqual(result.reasons, []);
  assert.equal(result.contract.need, '核验本地经营分析报告');
  assert.deepEqual(result.contract.triggers, ['用户要求核验一份本地分析报告']);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.contract), true);
});

test('an existing skill covering the need ends the intake without drafting', () => {
  const result = draftContract({ requirement: '核验分析报告', signals: signals({ existingSkillCovers: true }), draft: draft() });
  assert.equal(result.verdict, 'not-worth-skillifying');
  assert.deepEqual(result.reasons, ['EXISTING_SKILL_COVERS']);
  assert.equal(result.contract, null);
});

test('a one-off need is not worth building, even when drafted material is supplied', () => {
  const result = draftContract({ requirement: '帮我把这份月报核验一遍', signals: signals({ recurring: false }), draft: draft() });
  assert.equal(result.verdict, 'not-worth-skillifying');
  assert.deepEqual(result.reasons, ['ONE_OFF_NEED']);
  assert.equal(result.contract, null);
});

test('a recurring need without a draft asks for user input', () => {
  const result = draftContract({ requirement: '核验分析报告', signals: signals() });
  assert.equal(result.verdict, 'needs-user-input');
  assert.deepEqual(result.reasons, ['CONTRACT_NOT_DRAFTED']);
  assert.equal(result.contract, null);
});

test('blocking open questions downgrade a draft to needs-user-input', () => {
  const result = draftContract({ requirement: '核验分析报告', signals: signals(),
    draft: draft({ openQuestions: ['BLOCKING: 输入数据表的口径由谁确认？'] }) });
  assert.equal(result.verdict, 'needs-user-input');
  assert.deepEqual(result.reasons, ['OPEN_BLOCKING_QUESTIONS']);
  assert.notEqual(result.contract, null);
  const nonBlocking = draftContract({ requirement: '核验分析报告', signals: signals(),
    draft: draft({ openQuestions: ['报告是否包含图表？'] }) });
  assert.equal(nonBlocking.verdict, 'draftable');
});

test('a deterministic flow is drafted but flagged', () => {
  const result = draftContract({ requirement: '把日报汇总成周报', signals: signals({ needsJudgment: false }), draft: draft() });
  assert.equal(result.verdict, 'draftable');
  assert.deepEqual(result.reasons, ['NOTE_DETERMINISTIC_FLOW']);
});

test('requirement and signals are validated before any verdict', () => {
  assert.throws(() => draftContract({ requirement: '  ', signals: signals(), draft: draft() }), /INVALID_REQUIREMENT/);
  assert.throws(() => draftContract({ requirement: 'x'.repeat(501), signals: signals(), draft: draft() }), /INVALID_REQUIREMENT/);
  assert.throws(() => draftContract({ requirement: 'x', signals: { recurring: true }, draft: draft() }), /INVALID_SIGNALS/);
  assert.throws(() => draftContract({ requirement: 'x', signals: signals({ recurring: 'yes' }), draft: draft() }),
    /INVALID_SIGNALS/);
});

test('the draft must carry every contract field, bounded', () => {
  const missing = draft();
  delete missing.outputs;
  assert.throws(() => draftContract({ requirement: 'x', signals: signals(), draft: missing }), /INVALID_DRAFT/);
  assert.throws(() => draftContract({ requirement: 'x', signals: signals(), draft: draft({ triggers: [] }) }),
    /INVALID_DRAFT/);
  assert.throws(() => draftContract({ requirement: 'x', signals: signals(),
    draft: draft({ inputs: new Array(13).fill('i') }) }), /INVALID_DRAFT/);
  assert.throws(() => draftContract({ requirement: 'x', signals: signals(),
    draft: draft({ constraints: ['c'.repeat(501)] }) }), /INVALID_DRAFT/);
  const emptyOptional = draftContract({ requirement: 'x', signals: signals(),
    draft: draft({ outOfScope: [], openQuestions: [] }) });
  assert.equal(emptyOptional.verdict, 'draftable');
  assert.deepEqual(emptyOptional.contract.outOfScope, []);
});

test('the verdict never depends on the requirement prose', () => {
  const oneOff = draftContract({ requirement: '以后每个月都帮我核验报告，最好做成技能',
    signals: signals({ recurring: false }), draft: draft() });
  assert.equal(oneOff.verdict, 'not-worth-skillifying', 'the prose promising repetition must not override signals');
  const covered = draftContract({ requirement: '我们还没有任何技能能做这件事',
    signals: signals({ existingSkillCovers: true }), draft: draft() });
  assert.equal(covered.verdict, 'not-worth-skillifying', 'the prose claiming novelty must not override signals');
});
