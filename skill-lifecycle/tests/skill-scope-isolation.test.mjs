import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const APP = '/Applications/DSH Desktop.app/Contents/Resources/app';
const require_ = createRequire(join(APP, 'package.json'));
const load = async name => await import(pathToFileURL(require_.resolve('@deepseek-ai/' + name)).href);
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

const { Context } = await load('cordis');
const toolsMod = await load('dsh-tools');
const llmMod = await load('dsh-llm');

// 同名技能的两份不同正文：装配根里的是"本轮要跑的那一份"，另一份来自别处。
const armed = ['---', 'name: validate-data', 'description: The armed copy for this round.', '---', '',
  '# validate-data', '', 'ARMED-COPY-MARKER', ''].join('\n');
const shadow = ['---', 'name: validate-data', 'description: A same-named copy from another root.', '---', '',
  '# validate-data', '', 'SHADOW-COPY-MARKER', ''].join('\n');

async function makeGraph(t, { customSkillDirs, skill } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'scope-'));
  const isolated = {};
  for (const key of ['dshHome', 'agentsHome', 'bundledSkillDir']) {
    isolated[key] = join(root, key);
    await mkdir(isolated[key], { recursive: true });
  }
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const armedRoot = join(root, 'armed-root', 'validate-data');
  await mkdir(armedRoot, { recursive: true });
  await writeFile(join(armedRoot, 'SKILL.md'), skill ?? armed);

  const dirs = customSkillDirs === undefined ? [join(root, 'armed-root')] : customSkillDirs(root);
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
    includeDefaultRoots: false, watch: false, customSkillDirs: dirs,
    dshHome: isolated.dshHome, agentsHome: isolated.agentsHome, bundledSkillDir: isolated.bundledSkillDir,
  });
  const toolSkillMod = await load('dsh-tool-skill');
  await ctx.plugin({ apply: toolSkillMod.apply, inject: toolSkillMod.inject, name: toolSkillMod.name,
    Config: toolSkillMod.Config }, {});
  t.after(async () => {
    try { await ctx.fiber?.dispose?.(); } catch { /* best effort */ }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return { root, ctx, workspace, isolated, armedRoot };
}

async function loadSkill(ctx, workspace, callId = 'scope-call') {
  const agent = { id: 'scope-agent-001', session: { header: { cwd: workspace } } };
  const result = await ctx.tools.execute({ callId, name: 'skill',
    arguments: { name: 'validate-data' }, agent, signal: new AbortController().signal });
  if (result.isError) return { error: result };
  return { body: String(result.value.content ?? ''), provider: result.value.provider };
}

test('a same-named skill outside the armed root does not join the run', async (t) => {
  const g = await makeGraph(t);
  // 默认根（隔离家目录）里放一份同名不同内容的技能：隔离装配必须看不见它。
  const homeSkill = join(g.isolated.dshHome, 'skills', 'validate-data');
  await mkdir(homeSkill, { recursive: true });
  await writeFile(join(homeSkill, 'SKILL.md'), shadow);

  const listed = await g.ctx.skills.list({ cwd: g.workspace });
  assert.equal(listed.filter(skill => skill.name === 'validate-data').length, 1,
    `exactly one validate-data must be visible, got ${JSON.stringify(listed.map(skill => skill.name))}`);
  const loaded = await loadSkill(g.ctx, g.workspace);
  assert.equal(loaded.error, undefined, 'the armed copy must load');
  assert.ok(loaded.body.includes('ARMED-COPY-MARKER'), 'the armed copy is the one that loads');
  assert.equal(loaded.body.includes('SHADOW-COPY-MARKER'), false,
    'a same-named skill under the default home must not shadow the armed one');
  assert.equal(sha256(loaded.body), sha256(armed.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()));
});

test('two roots with the same skill name resolve to one deterministic winner', async (t) => {
  const first = ['---', 'name: validate-data', 'description: First root copy.', '---', '', 'FIRST-ROOT-MARKER', ''].join('\n');
  const second = ['---', 'name: validate-data', 'description: Second root copy.', '---', '', 'SECOND-ROOT-MARKER', ''].join('\n');
  const g = await makeGraph(t, { skill: first, customSkillDirs: root => [join(root, 'armed-root'), join(root, 'other-root')] });
  const otherRoot = join(g.root, 'other-root', 'validate-data');
  await mkdir(otherRoot, { recursive: true });
  await writeFile(join(otherRoot, 'SKILL.md'), second);

  const listed = await g.ctx.skills.list({ cwd: g.workspace });
  const nameCount = listed.filter(skill => skill.name === 'validate-data').length;
  assert.equal(nameCount, 1, 'a name collision must collapse to a single visible skill');

  const firstLoad = await loadSkill(g.ctx, g.workspace, 'scope-call-1');
  const secondLoad = await loadSkill(g.ctx, g.workspace, 'scope-call-2');
  assert.equal(firstLoad.error, undefined, 'a collision must still resolve to a loadable skill');
  assert.equal(sha256(firstLoad.body), sha256(secondLoad.body),
    'the winner must be the same on every load, not dependent on call order');
  const candidates = [first, second].map(text => sha256(text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()));
  assert.ok(candidates.includes(sha256(firstLoad.body)),
    'the winner must be one of the two copies on disk, never a merge of them');
  // 本机 DSH 0.1.5-rc.2 实测：先声明的 custom 根胜出。钉住它，优先级一旦变化就要报警——
  // 我们的装配依赖"装配根就是被加载的那一份"。
  assert.ok(firstLoad.body.includes('FIRST-ROOT-MARKER'),
    'the first declared custom root must win; a precedence change must fail loudly');
  assert.equal(secondLoad.body.includes('SECOND-ROOT-MARKER'), false);
  console.log(`[scope] collision resolved: ${nameCount} entr${nameCount === 1 ? 'y' : 'ies'}, winner=first`);
});
