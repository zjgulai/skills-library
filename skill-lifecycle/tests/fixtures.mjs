import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRun } from '../control/run-state.mjs';
import { openFiles } from '../control/bounded-files.mjs';
import { openBudget } from '../control/budget-ledger.mjs';

export async function makeTempCase(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'skill-run-state-'));
  const resources = [];
  t.after(async () => {
    try {
      for (const resource of resources.toReversed()) await resource.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const paths = Object.fromEntries(
    ['trusted', 'inputs', 'skill', 'outputs', 'outside'].map(name => [name, join(root, name)]),
  );
  const budget = join(paths.trusted, 'batch');
  await Promise.all([...Object.values(paths), budget].map(path => mkdir(path, { recursive: true })));
  const report = join(paths.inputs, 'report.md');
  const csv = join(paths.inputs, 'metrics.csv');
  const skill = join(paths.skill, 'SKILL.md');
  await Promise.all([
    writeFile(report, '公开分析样例：核对分组指标。\n'),
    writeFile(csv, 'segment,value,weight\nA,10,2\nB,40,1\n'),
    writeFile(skill, '---\nname: example-skill\ndescription: Public test fixture.\n---\nReview the input.\n'),
    writeFile(join(paths.outside, 'sentinel.txt'), 'public-test-sentinel'),
  ]);
  const digest = label => createHash('sha256').update(label).digest('hex');
  return {
    root,
    ...paths,
    budget,
    binding: {
      runId: `run-${randomUUID()}`,
      batchId: 'public-batch-001',
      sessionId: 'public-session-001',
      skillDigest: digest('skill'),
      inputDigest: digest('input'),
      evaluatorDigest: digest('evaluator'),
      environmentDigest: digest('environment'),
      policyDigest: digest('policy'),
    },
    inputFiles: [
      { fileId: 'report', path: report, role: 'input' },
      { fileId: 'metrics', path: csv, role: 'input' },
      { fileId: 'skill', path: skill, role: 'skill' },
    ],
    testBudget: {
      maxAttempts: 2,
      maxOutputTokensPerAttempt: 20,
      maxRequestBytes: 4096,
      observedTokenStop: 100,
      batchDeadlineMs: 5000,
      attemptTimeoutMs: 100,
    },
    track(resource) {
      resources.push(resource);
      return resource;
    },
  };
}

export async function makePluginFixture(t) {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await run.start();
  const files = f.track(await openFiles({ run, binding: f.binding, inputRoot: f.inputs,
    skillRoot: f.skill, outputRoot: f.outputs, files: f.inputFiles,
    limits: { maxInputBytes: 4096, maxReportBytes: 4096 } }));
  const budget = f.track(await openBudget({ run, binding: f.binding, root: f.budget,
    limits: f.testBudget, now: () => 1000 }));
  const tables = new Map([['metrics', {
    headers: ['segment', 'value', 'weight'],
    rows: [['A', '10', '2'], ['B', '40', '1']],
    sha256: 'a'.repeat(64),
  }]]);
  const registeredTools = [];
  const registeredGuards = [];
  const streamListeners = [];
  const auditEntries = [];
  const cancelled = [];
  const agent = {
    id: f.binding.sessionId,
    ctx: undefined,
    cancel(cause, options) { cancelled.push({ cause, options }); },
    whenIdle() { return Promise.resolve(); },
  };
  const ctx = {
    tools: {
      register(definition) {
        registeredTools.push(definition);
        return () => { definition.disposed = true; };
      },
      guard(guard) {
        registeredGuards.push(guard);
        return () => { guard.disposed = true; };
      },
    },
    on(event, listener) {
      if (event === 'llm/stream') streamListeners.push(listener);
      return () => { listener.disposed = true; };
    },
  };
  agent.ctx = ctx;
  let callSeq = 0;
  const execCall = (name, sessionId = f.binding.sessionId, args = {}) => ({
    callId: `call-${++callSeq}`, name, arguments: args,
    agent: sessionId === f.binding.sessionId ? agent : { id: sessionId },
    signal: new AbortController().signal,
  });
  const audit = entry => { auditEntries.push(entry); };
  return {
    ...f,
    run,
    files,
    budget,
    tables,
    agent,
    ctx,
    auditEntries,
    cancelled,
    registeredTools,
    registeredGuards,
    streamListeners,
    execCall,
    denyReasons(name, sessionId = f.binding.sessionId, args = {}) {
      return registeredGuards
        .map(guard => guard(execCall(name, sessionId, args)))
        .filter(reason => typeof reason === 'string');
    },
    installOptions: {
      agent,
      run,
      binding: f.binding,
      files,
      tables,
      budget,
      waitMs: 100,
      allowedSkillNames: ['validate-data'],
      defineTool: options => ({ ...options }),
      requestIdentity: () => ({ runId: f.binding.runId, sessionId: f.binding.sessionId }),
      measureRequest: options => Buffer.byteLength(JSON.stringify(options?.messages ?? []), 'utf8'),
      audit,
    },
  };
}
