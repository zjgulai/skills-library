import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealTerminalSet, openTerminalSet, reveal, assertFresh, assertRootsDisjoint, scanForLeaks }
  from '../control/terminal-set.mjs';

const ANSWERS = ['单位不一致：报告按万元、表格按元', '复算总额应为 588,000 元'];

function tasks() {
  return [
    { taskId: 'tt-1', request: '核验这份《季度营收核对表》：数据表 data.csv，报告 report.md。',
      files: [
        { name: 'report.md', content: '# 季度营收核对（节选）\n\n- 本季度营收 58.8 万元。\n' },
        { name: 'data.csv', content: 'month,revenue\n1月,196000\n2月,196000\n3月,196000\n' },
      ],
      answers: ANSWERS },
    { taskId: 'tt-2', request: '核验这份《库存周转分析》：数据表 data.csv，报告 report.md。',
      files: [
        { name: 'report.md', content: '# 库存周转分析（节选）\n\n- 周转天数 45 天，较上季改善。\n' },
        { name: 'data.csv', content: 'month,turnover_days\n1月,47\n2月,45\n3月,43\n' },
      ],
      answers: ['无可复现缺陷；结论与数据一致'] },
  ];
}

async function sealedSet(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'terminal-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  const sealed = await sealTerminalSet({ root, setId: 'w1', tasks: tasks(), now: () => 1000 });
  return { root, sealed };
}

test('answers land only in the custodian area', async (t) => {
  const { root, sealed } = await sealedSet(t);
  const manifest = await readFile(join(sealed.setRoot, 'manifest.json'), 'utf8');
  assert.equal(manifest.includes(ANSWERS[0]), false, 'the manifest must not carry answers');
  const dispatchReport = await readFile(join(sealed.dispatchRoot, 'tt-1', 'report.md'), 'utf8');
  assert.equal(dispatchReport.includes(ANSWERS[0]), false, 'the dispatch copy must not carry answers');
  const answers = JSON.parse(await readFile(join(sealed.custodianRoot, 'answers.json'), 'utf8'));
  assert.deepEqual(answers.answers.find(entry => entry.taskId === 'tt-1').answers, ANSWERS);
  const clean = await scanForLeaks({ root, setId: 'w1', tokens: ANSWERS });
  assert.equal(clean.clean, true);
  assert.deepEqual(clean.findings, []);
});

test('a sealed set is immutable and never re-sealed', async (t) => {
  const { root } = await sealedSet(t);
  await assert.rejects(sealTerminalSet({ root, setId: 'w1', tasks: tasks() }), /SET_EXISTS/);
  await assert.rejects(openTerminalSet({ root, setId: 'missing' }), /UNKNOWN_SET/);
});

test('copyInto hands the runner only the declared inputs', async (t) => {
  const { root } = await sealedSet(t);
  const runRoot = join(root, 'run-1');
  const set = await openTerminalSet({ root, setId: 'w1' });
  const handed = await set.copyInto({ taskId: 'tt-1', runRoot });
  assert.match(handed.request, /数据表 data.csv/);
  assert.deepEqual(handed.inputs.map(input => input.name).sort(), ['data.csv', 'report.md']);
  assert.deepEqual((await readdir(join(runRoot, 'inputs'))).sort(), ['data.csv', 'report.md']);
  const planted = await readdir(runRoot);
  assert.equal(planted.includes('custodian'), false, 'no answer directory may be reachable from the run root');
  await assert.rejects(set.copyInto({ taskId: 'nope', runRoot }), /UNKNOWN_TASK/);
});

test('a tampered dispatch input is refused before it reaches the runner', async (t) => {
  const { root, sealed } = await sealedSet(t);
  await writeFile(join(sealed.dispatchRoot, 'tt-1', 'data.csv'), 'month,revenue\n1月,1\n');
  const set = await openTerminalSet({ root, setId: 'w1' });
  await assert.rejects(set.copyInto({ taskId: 'tt-1', runRoot: join(root, 'run-2') }),
    /INPUT_IDENTITY_CHANGED/);
});

test('answers are only revealed to the judge role, and every reveal is logged', async (t) => {
  const { root } = await sealedSet(t);
  await assert.rejects(reveal({ root, setId: 'w1', taskId: 'tt-1', actor: 'runner', reason: 'peek' }),
    /ANSWER_ACCESS_DENIED/);
  await assert.rejects(reveal({ root, setId: 'w1', taskId: 'tt-1', actor: 'judge', reason: '' }),
    /INVALID_REASON/);
  const first = await reveal({ root, setId: 'w1', taskId: 'tt-1', actor: 'judge', reason: 'round-1 verdict' });
  assert.deepEqual(first.answers, ANSWERS);
  await reveal({ root, setId: 'w1', taskId: 'tt-1', actor: 'judge', reason: 're-check' });
  const log = (await readFile(join(root, 'w1', 'custodian', 'reveals.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(log.length, 2, 'every reveal must be auditable');
  assert.equal(JSON.parse(log[0]).reason, 'round-1 verdict');
});

test('a revealed task is burned for later rounds', async (t) => {
  const { root } = await sealedSet(t);
  await assertFresh({ root, setId: 'w1' });
  await reveal({ root, setId: 'w1', taskId: 'tt-2', actor: 'judge', reason: 'round-1' });
  await assert.rejects(assertFresh({ root, setId: 'w1' }), /TASK_BURNED: tt-2/);
  const fresh = await assertFresh({ root, setId: 'w1', taskIds: ['tt-1'] });
  assert.deepEqual(fresh.taskIds, ['tt-1', 'tt-2']);
});

test('the custodian root must be disjoint from every runner-facing root', () => {
  const ok = assertRootsDisjoint({ custodianRoot: '/tmp/terminal/w1/custodian',
    roots: ['/tmp/terminal/w1/dispatch', '/tmp/runs/run-1'] });
  assert.equal(ok.roots.length, 2);
  assert.throws(() => assertRootsDisjoint({ custodianRoot: '/tmp/x/w1/custodian',
    roots: ['/tmp/x/w1'] }), /OVERLAPPING_ROOTS/);
  assert.throws(() => assertRootsDisjoint({ custodianRoot: '/tmp/x/w1/custodian',
    roots: ['/tmp/x/w1/custodian/answers.json'] }), /OVERLAPPING_ROOTS/);
  assert.throws(() => assertRootsDisjoint({ custodianRoot: '/tmp/x', roots: ['/tmp/x'] }),
    /OVERLAPPING_ROOTS/);
});

test('sealing validates ids, tasks and files', async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'terminal-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  await assert.rejects(sealTerminalSet({ root, setId: 'BAD', tasks: tasks() }), /INVALID_SET_ID/);
  await assert.rejects(sealTerminalSet({ root, setId: 'w1', tasks: [] }), /INVALID_TASKS/);
  await assert.rejects(sealTerminalSet({ root, setId: 'w1', tasks: [
    { taskId: 'x', request: 'r', files: [{ name: '../escape.md', content: 'x' }], answers: ['a'] }] }),
  /INVALID_TASK_FILE/);
  await assert.rejects(sealTerminalSet({ root, setId: 'w1', tasks: [
    { taskId: 'x', request: 'r', files: [{ name: 'a.md', content: 'x' }], answers: [''] }] }),
  /INVALID_TASKS/);
  await assert.rejects(sealTerminalSet({ root: join(root, 'missing'), setId: 'w1', tasks: tasks() }),
    /INVALID_TERMINAL_ROOT/);
});

test('scanForLeaks reports answer text that reached a dispatch file', async (t) => {
  const { root, sealed } = await sealedSet(t);
  await writeFile(join(sealed.dispatchRoot, 'tt-1', 'notes.md'), `备注：${ANSWERS[0]}\n`);
  const result = await scanForLeaks({ root, setId: 'w1', tokens: ANSWERS });
  assert.equal(result.clean, false);
  assert.deepEqual(result.findings, [{ taskId: 'tt-1', file: 'notes.md', token: ANSWERS[0] }]);
});

test('the runner-facing roots of a real trial run are disjoint from custody', async (t) => {
  const { root, sealed } = await sealedSet(t);
  const runRoot = join(root, 'runs', 'tt-1');
  await mkdir(join(runRoot, 'inputs'), { recursive: true });
  await mkdir(join(runRoot, 'outputs'), { recursive: true });
  const skillRoot = join(root, 'skill-root');
  await mkdir(join(skillRoot, 'validate-data'), { recursive: true });
  const disjoint = assertRootsDisjoint({ custodianRoot: sealed.custodianRoot,
    roots: [join(runRoot, 'inputs'), join(runRoot, 'outputs'), skillRoot] });
  assert.equal(disjoint.roots.length, 3);
  const set = await openTerminalSet({ root, setId: 'w1' });
  await set.copyInto({ taskId: 'tt-1', runRoot });
  const leaked = await scanForLeaks({ root, setId: 'w1', tokens: ANSWERS });
  assert.equal(leaked.clean, true, 'copying into a run root must not move answers anywhere');
});

test('a set declares which arms may run it', async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'terminal-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  await sealTerminalSet({ root, setId: 'w1', tasks: tasks() });
  const existing = await openTerminalSet({ root, setId: 'w1' });
  assert.deepEqual(existing.arms, ['original', 'candidate'],
    'a set sealed without an explicit policy stays an existing-skill set');
  await sealTerminalSet({ root, setId: 'n1', tasks: tasks(), arms: ['none', 'candidate'] });
  const fresh = await openTerminalSet({ root, setId: 'n1' });
  assert.deepEqual(fresh.arms, ['none', 'candidate'], 'a new-skill set carries no original arm');
  const manifest = JSON.parse(await readFile(join(root, 'n1', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.arms, ['none', 'candidate'], 'the policy is part of the sealed manifest');
  await assert.rejects(sealTerminalSet({ root, setId: 'x1', tasks: tasks(), arms: [] }), /INVALID_ARMS/);
  await assert.rejects(sealTerminalSet({ root, setId: 'x2', tasks: tasks(), arms: ['candidate'] }),
    /INVALID_ARMS/, 'a set without a baseline cannot be compared');
  await assert.rejects(sealTerminalSet({ root, setId: 'x3', tasks: tasks(), arms: ['original', 'none'] }),
    /INVALID_ARMS/, 'two baselines are not a comparison');
  await assert.rejects(sealTerminalSet({ root, setId: 'x4', tasks: tasks(),
    arms: ['original', 'candidate', 'none'] }), /INVALID_ARMS/);
  await assert.rejects(sealTerminalSet({ root, setId: 'x5', tasks: tasks(), arms: ['original', 'original'] }),
    /INVALID_ARMS/);
  await assert.rejects(sealTerminalSet({ root, setId: 'x6', tasks: tasks(), arms: ['candidate', 'beta'] }),
    /INVALID_ARMS/, 'an unknown arm is not silently accepted');
});
