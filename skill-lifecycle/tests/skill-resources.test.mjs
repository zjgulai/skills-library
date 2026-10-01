import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openRun } from '../control/run-state.mjs';
import { openFiles } from '../control/bounded-files.mjs';

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
const require_ = createRequire(join(APP, 'package.json'));
const load = async name => await import(pathToFileURL(require_.resolve('@deepseek-ai/' + name)).href);
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

const { Context } = await load('cordis');
const toolsMod = await load('dsh-tools');
const llmMod = await load('dsh-llm');

const CHECKLIST = '# 核验清单\n\n- 复算总额并与报告对照\n- 检查单位与口径\n';
const SKILL_MD = ['---', 'name: resource-probe', 'description: A package that ships a checklist resource.',
  '---', '', '# resource-probe', '', '先从 `references/checklist.md` 取清单，再逐条核验。', ''].join('\n');

async function makePackage(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'resources-'));
  const packageRoot = join(root, 'pkg', 'resource-probe');
  await mkdir(join(packageRoot, 'references'), { recursive: true });
  await writeFile(join(packageRoot, 'SKILL.md'), SKILL_MD);
  await writeFile(join(packageRoot, 'references', 'checklist.md'), CHECKLIST);
  // 包外的一份材料：它不该能借 role:"skill" 混进来。
  await mkdir(join(root, 'shared'), { recursive: true });
  await writeFile(join(root, 'shared', 'notes.md'), '# 包外笔记\n');
  const isolated = {};
  for (const key of ['dshHome', 'agentsHome', 'bundledSkillDir']) {
    isolated[key] = join(root, key);
    await mkdir(isolated[key], { recursive: true });
  }
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const ctx = new Context();
  await ctx.plugin((await load('dsh-system-prompt')).SystemPrompt);
  await ctx.plugin(toolsMod.ToolRuntime);
  await ctx.plugin(llmMod.LlmRuntime);
  await ctx.plugin((await load('dsh-agent')).AgentRegistry ?? (await load('dsh-agent')).default);
  await ctx.plugin((await load('dsh-session')).default);
  await ctx.plugin((await load('dsh-session-projection')).default);
  await ctx.plugin((await load('dsh-skill')).default, {});
  const filesystemMod = await load('dsh-skill-filesystem');
  await ctx.plugin({ apply: filesystemMod.apply, inject: filesystemMod.inject, name: filesystemMod.name,
    Config: filesystemMod.Config }, {
    includeDefaultRoots: false, watch: false, customSkillDirs: [join(root, 'pkg')],
    dshHome: isolated.dshHome, agentsHome: isolated.agentsHome, bundledSkillDir: isolated.bundledSkillDir,
  });
  const toolSkillMod = await load('dsh-tool-skill');
  await ctx.plugin({ apply: toolSkillMod.apply, inject: toolSkillMod.inject, name: toolSkillMod.name,
    Config: toolSkillMod.Config }, {});
  t.after(async () => {
    try { await ctx.fiber?.dispose?.(); } catch { /* best effort */ }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return { root, ctx, workspace, packageRoot };
}

test('a package resource is listed with the skill but served separately from its body', async (t) => {
  const g = await makePackage(t);
  const listed = await g.ctx.skills.list({ cwd: g.workspace });
  const summary = listed.find(skill => skill.name === 'resource-probe');
  assert.ok(summary, `the package must be listed, got ${JSON.stringify(listed.map(skill => skill.name))}`);
  const agent = { id: 'res-agent-001', session: { header: { cwd: g.workspace } } };
  const result = await g.ctx.tools.execute({ callId: 'res-call-1', name: 'skill',
    arguments: { name: 'resource-probe' }, agent, signal: new AbortController().signal });
  assert.equal(result.isError, false, 'the package must load');
  const body = String(result.value.content ?? '');
  assert.ok(body.includes('references/checklist.md'), 'the body must point at its resource');
  assert.equal(body.includes('复算总额并与报告对照'), false,
    'resource content must stay in the resource, not be inlined into the skill body');
});

test('the resource is readable under the same identity rules as the skill body', async (t) => {
  const g = await makePackage(t);
  const skillPath = join(g.packageRoot, 'SKILL.md');
  const resourcePath = join(g.packageRoot, 'references', 'checklist.md');
  const binding = {
    runId: 'run-res-001', batchId: 'batch-res-001', sessionId: 'res-session-001',
    skillDigest: sha256(SKILL_MD), inputDigest: sha256('res-input'), evaluatorDigest: sha256('res-eval'),
    environmentDigest: sha256('res-env'), policyDigest: sha256('res-policy'),
  };
  await mkdir(join(g.root, 'run'), { recursive: true });
  const run = await openRun({ root: join(g.root, 'run'), binding });
  await run.start();
  await mkdir(join(g.workspace, 'inputs'), { recursive: true });
  await mkdir(join(g.workspace, 'outputs'), { recursive: true });
  const files = await openFiles({ run, binding, inputRoot: join(g.workspace, 'inputs'),
    skillRoot: g.packageRoot, outputRoot: join(g.workspace, 'outputs'),
    files: [{ fileId: 'skill', path: skillPath, role: 'skill' },
      { fileId: 'skill-resource', path: resourcePath, role: 'skill' }],
    limits: { maxInputBytes: 65536, maxReportBytes: 65536 } });
  t.after(async () => { await files.close().catch(() => {}); await run.close().catch(() => {}); });

  const read = await files.read({ fileId: 'skill-resource', offset: 0, limit: 4000 });
  assert.equal(sha256(read.content), sha256(CHECKLIST), 'the resource must be byte-identical to the package file');
  assert.equal(read.content.includes('复算总额并与报告对照'), true);
  const body = await files.read({ fileId: 'skill', offset: 0, limit: 4000 });
  assert.equal(sha256(body.content), sha256(SKILL_MD));
});

test('a file outside the package cannot ride in as a skill resource', async (t) => {
  const g = await makePackage(t);
  const binding = {
    runId: 'run-res-002', batchId: 'batch-res-002', sessionId: 'res-session-002',
    skillDigest: sha256(SKILL_MD), inputDigest: sha256('res-input'), evaluatorDigest: sha256('res-eval'),
    environmentDigest: sha256('res-env'), policyDigest: sha256('res-policy'),
  };
  await mkdir(join(g.root, 'run2'), { recursive: true });
  const run = await openRun({ root: join(g.root, 'run2'), binding });
  await run.start();
  await mkdir(join(g.workspace, 'inputs'), { recursive: true });
  await mkdir(join(g.workspace, 'outputs'), { recursive: true });
  t.after(async () => { await run.close().catch(() => {}); });
  await assert.rejects(openFiles({ run, binding, inputRoot: join(g.workspace, 'inputs'),
    skillRoot: g.packageRoot, outputRoot: join(g.workspace, 'outputs'),
    files: [{ fileId: 'skill', path: join(g.packageRoot, 'SKILL.md'), role: 'skill' },
      { fileId: 'outsider', path: join(g.root, 'shared', 'notes.md'), role: 'skill' }],
    limits: { maxInputBytes: 65536, maxReportBytes: 65536 } }), /FILE_OUTSIDE_ROOT/,
  'an out-of-package reference must be refused, not silently resolved');
});
