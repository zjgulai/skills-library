import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openRun } from '../control/run-state.mjs';
import { openFiles } from '../control/bounded-files.mjs';
import { openBudget } from '../control/budget-ledger.mjs';
import { installTrialControl } from '../control/dsh-plugin.mjs';

// 运行时基座（2026-10-01 切换 Sage）：T_APP_ROOT 覆盖 → Sage 内置 harness 构建 → Sage 开发树（dist 重建窗口兜底）→ 旧应用路径；找不到即显式失败。
const APP = (() => {
  const fs = process.getBuiltinModule('node:fs');
  const path = process.getBuiltinModule('node:path');
  const candidates = [
    process.env.T_APP_ROOT,
    '/Users/lute/project/Sage/vendor/dsh-desktop/dsh-plugin-desktop/dist/mac-arm64/DSH Desktop.app/Contents/Resources/app',
    '/Users/lute/project/Sage/vendor/dsh-desktop/dsh-plugin-desktop',
    '/Applications/DSH Desktop.app/Contents/Resources/app',
  ].filter(Boolean);
  const found = candidates.find(candidate => fs.existsSync(path.join(candidate, 'package.json')));
  if (!found) throw new Error(`harness app root 未找到（试过：${candidates.join(' | ')}；可用 T_APP_ROOT 指定）`);
  return found;
})();
const TRIAL_HOME = join(import.meta.dirname, '..', 'trial-home');
const SKILL_PATH = join(TRIAL_HOME, 'skills', 'validate-data', 'SKILL.md');
const FROZEN_SKILL_SHA = '1e424822043480375b80aef9416227b1c8083af749ca536568716265f79ca54b';
const require_ = createRequire(join(APP, 'package.json'));
const load = async name => await import(pathToFileURL(require_.resolve('@deepseek-ai/' + name)).href);
const sha256 = text => createHash('sha256').update(text).digest('hex');

const { Context } = await load('cordis');
const toolsMod = await load('dsh-tools');
const llmMod = await load('dsh-llm');

function stripFrontmatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

async function makeSkillGraph(t, { watch = false, allowedSkillNames = ['validate-data'] } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'w4-skill-'));
  const isolated = {};
  for (const key of ['dshHome', 'agentsHome', 'bundledSkillDir']) {
    isolated[key] = join(root, key);
    await mkdir(isolated[key], { recursive: true });
  }
  const sessions = join(root, 'sessions');
  await mkdir(sessions, { recursive: true });

  const ctx = new Context();
  await ctx.plugin((await load('dsh-system-prompt')).SystemPrompt);
  await ctx.plugin(toolsMod.ToolRuntime);
  await ctx.plugin(llmMod.LlmRuntime);
  await ctx.plugin((await load('dsh-agent')).AgentRegistry ?? (await load('dsh-agent')).default);
  await ctx.plugin((await load('dsh-session')).default);
  await ctx.plugin((await load('dsh-session-persistence-jsonl')).default, { root: sessions });
  await ctx.plugin((await load('dsh-session-projection')).default);
  await ctx.plugin((await load('dsh-agent-loop')).AgentLoop ?? (await load('dsh-agent-loop')).default, {});
  await ctx.plugin((await load('dsh-skill')).default, {});
  const filesystemMod = await load('dsh-skill-filesystem');
  await ctx.plugin({ apply: filesystemMod.apply, inject: filesystemMod.inject, name: filesystemMod.name,
    Config: filesystemMod.Config }, {
    includeDefaultRoots: false, watch, customSkillDirs: [join(TRIAL_HOME, 'skills')],
    dshHome: isolated.dshHome, agentsHome: isolated.agentsHome, bundledSkillDir: isolated.bundledSkillDir,
  });
  const toolSkillMod = await load('dsh-tool-skill');
  await ctx.plugin({ apply: toolSkillMod.apply, inject: toolSkillMod.inject, name: toolSkillMod.name,
    Config: toolSkillMod.Config }, {});

  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, 'inputs'), { recursive: true });
  await mkdir(join(workspace, 'outputs'), { recursive: true });
  await mkdir(join(root, 'run'), { recursive: true });
  await mkdir(join(root, 'batch'), { recursive: true });
  t.after(async () => {
    try { await ctx.fiber?.dispose?.(); } catch { /* best effort */ }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return { root, ctx, workspace, isolated, sessions };
}

test('the native skill provider lists the frozen skill under an isolated home', async (t) => {
  const g = await makeSkillGraph(t);
  const listed = await g.ctx.skills.list({ cwd: g.workspace });
  const names = listed.map(skill => skill.name);
  assert.ok(names.includes('validate-data'), `expected validate-data in ${JSON.stringify(names)}`);
  const summary = listed.find(skill => skill.name === 'validate-data');
  assert.equal(summary.provider, 'filesystem');
  assert.equal(summary.invocation.modelInvocable, true);
  assert.match(summary.description, /analysis/i);
});

test('the real skill tool returns the frozen skill body with matching identity', async (t) => {
  const g = await makeSkillGraph(t);
  const agent = { id: 'w4-agent-001', session: { header: { cwd: g.workspace } } };
  const result = await g.ctx.tools.execute({ callId: 'w4-call-1', name: 'skill',
    arguments: { name: 'validate-data' }, agent, signal: new AbortController().signal });
  assert.equal(result.isError, false, 'the native load must not error');
  assert.equal(result.value.name, 'validate-data');
  assert.equal(result.value.provider, 'filesystem');
  const fileText = await readFile(SKILL_PATH, 'utf8');
  assert.equal(sha256(fileText), FROZEN_SKILL_SHA, 'the frozen skill must keep its identity');
  const body = stripFrontmatter(fileText).trim();
  const content = String(result.value.content ?? '');
  assert.equal(sha256(content), sha256(body),
    'the native tool must serve exactly the frozen skill body (frontmatter stripped)');
  assert.ok(content.includes('Pre-Delivery QA Checklist'));
  const rendered = result.content.map(block => block.text ?? '').join('');
  assert.ok(rendered.includes('<skill_content name="validate-data">'),
    'the model-facing block must name the loaded skill');
});

test('the frozen skill file is read-only evidence, not a writable copy', async (t) => {
  const g = await makeSkillGraph(t);
  const before = await stat(SKILL_PATH);
  const listed = await g.ctx.skills.list({ cwd: g.workspace });
  assert.equal(listed.length, 1, 'the isolated trial root must expose exactly one skill');
  const after = await stat(SKILL_PATH);
  assert.equal(before.mtimeMs, after.mtimeMs, 'listing must not mutate the frozen skill');
});

test('the trial guard still restricts skill names and records successful loads', async (t) => {
  const g = await makeSkillGraph(t);
  const binding = {
    runId: 'run-w4-001', batchId: 'batch-w4-001', sessionId: 'w4-session-001',
    skillDigest: FROZEN_SKILL_SHA, inputDigest: sha256('w4-input'), evaluatorDigest: sha256('w4-eval'),
    environmentDigest: sha256('w4-env'), policyDigest: sha256('w4-policy'),
  };
  const run = await openRun({ root: join(g.root, 'run'), binding });
  await run.start();
  const files = await openFiles({ run, binding, inputRoot: join(g.workspace, 'inputs'),
    skillRoot: join(TRIAL_HOME, 'skills'), outputRoot: join(g.workspace, 'outputs'),
    files: [{ fileId: 'skill', path: SKILL_PATH, role: 'skill' }],
    limits: { maxInputBytes: 65536, maxReportBytes: 65536 } });
  const budget = await openBudget({ run, binding, root: join(g.root, 'batch'),
    limits: { maxAttempts: 2, maxOutputTokensPerAttempt: 20, maxRequestBytes: 4096,
      observedTokenStop: 100, batchDeadlineMs: 5000, attemptTimeoutMs: 100 } });
  const audit = [];
  const agent = { id: binding.sessionId, ctx: g.ctx, session: { header: { cwd: g.workspace } },
    cancel() {}, whenIdle: () => Promise.resolve() };
  const control = await installTrialControl({ agent, run, binding, files, budget,
    tables: new Map([['data', { headers: ['a'], rows: [['1']], sha256: sha256('a') }]]),
    defineTool: toolsMod.defineTool, allowedSkillNames: ['validate-data'],
    requestIdentity: () => ({ runId: binding.runId, sessionId: binding.sessionId }),
    measureRequest: () => 1, audit: entry => { audit.push(entry); } });
  t.after(async () => { control.dispose(); await files.close().catch(() => {}); await budget.close().catch(() => {}); await run.close().catch(() => {}); });

  const denied = await g.ctx.tools.execute({ callId: 'w4-call-2', name: 'skill',
    arguments: { name: 'other-skill' }, agent, signal: new AbortController().signal });
  assert.equal(denied.isError, true, 'a non-allowlisted skill name must be denied');
  assert.match(JSON.stringify(denied.content), /SKILL_NOT_ALLOWED/);
  assert.ok(audit.some(entry => entry.kind === 'tool_denied' && entry.reason === 'SKILL_NOT_ALLOWED'),
    `expected SKILL_NOT_ALLOWED in ${JSON.stringify(audit)}`);

  const loaded = await g.ctx.tools.execute({ callId: 'w4-call-3', name: 'skill',
    arguments: { name: 'validate-data' }, agent, signal: new AbortController().signal });
  assert.equal(loaded.isError, false);
  assert.equal(loaded.value.name, 'validate-data');
  assert.ok(audit.some(entry => entry.kind === 'tool_admitted' && entry.tool === 'skill'
    && entry.skillName === 'validate-data'),
  `a successful native load must be recorded; audit=${JSON.stringify(audit)}`);
});
