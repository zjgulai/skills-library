import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const APP = '/Applications/DSH Desktop.app/Contents/Resources/app';
const require_ = createRequire(join(APP, 'package.json'));
const load = async name => await import(pathToFileURL(require_.resolve('@deepseek-ai/' + name)).href);
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const stripFrontmatter = text => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

/**
 * Zero-egress observation window: mount the native skill chain over the installed tree, load the
 * skill through the real `skill` tool, and prove the served content is the installed content.
 * No provider route is ever mounted — the observation cannot produce network traffic.
 */
export async function smokeObserver({ skillId, root }) {
  const scratch = await mkdtemp(join(await realpath(tmpdir()), 'smoke-'));
  const isolated = {};
  for (const key of ['dshHome', 'agentsHome', 'bundledSkillDir']) {
    isolated[key] = join(scratch, key);
    await mkdir(isolated[key], { recursive: true });
  }
  const { Context } = await load('cordis');
  const toolsMod = await load('dsh-tools');
  const ctx = new Context();
  let outcome;
  // 该根下"实际被发现"的技能名：用来机读对照——非法名字（如中文）会被逐份忽略、不出现在这里。
  let discovered = [];
  try {
    await ctx.plugin((await load('dsh-system-prompt')).SystemPrompt);
    await ctx.plugin(toolsMod.ToolRuntime);
    await ctx.plugin((await load('dsh-agent')).AgentRegistry ?? (await load('dsh-agent')).default);
    await ctx.plugin((await load('dsh-skill')).default, {});
    const skillFs = await load('dsh-skill-filesystem');
    await ctx.plugin({ apply: skillFs.apply, inject: skillFs.inject, name: skillFs.name,
      Config: skillFs.Config }, {
      includeDefaultRoots: false, watch: false, customSkillDirs: [dirname(root)],
      dshHome: isolated.dshHome, agentsHome: isolated.agentsHome, bundledSkillDir: isolated.bundledSkillDir,
    });
    const toolSkill = await load('dsh-tool-skill');
    await ctx.plugin({ apply: toolSkill.apply, inject: toolSkill.inject, name: toolSkill.name,
      Config: toolSkill.Config }, {});

    const listed = await ctx.skills.list({ cwd: root });
    discovered = listed.map(skill => skill.name);
    const summary = listed.find(skill => skill.name === skillId);
    if (summary === undefined) {
      outcome = { mode: 'capture', ok: false, detail: `SKILL_NOT_DISCOVERED: ${skillId}`, route: 'none' };
    } else {
      const agent = { id: `smoke-${skillId}`, session: { header: { cwd: root } } };
      const result = await ctx.tools.execute({ callId: 'smoke-skill-load', name: 'skill',
        arguments: { name: skillId }, agent, signal: new AbortController().signal });
      const installedText = await readFile(join(root, 'SKILL.md'), 'utf8');
      const installedDigest = sha256(stripFrontmatter(installedText).trim());
      const servedDigest = sha256(String(result?.value?.content ?? ''));
      outcome = {
        mode: 'capture',
        ok: result?.isError === false && servedDigest === installedDigest,
        detail: result?.isError === false
          ? (servedDigest === installedDigest
            ? `skill loaded natively; content identity ${servedDigest.slice(0, 16)} matches the installed tree`
            : `CONTENT_MISMATCH: installed ${installedDigest.slice(0, 16)} vs served ${servedDigest.slice(0, 16)}`)
          : `SKILL_TOOL_ERROR: ${JSON.stringify(result?.content ?? null).slice(0, 200)}`,
        route: 'none',
        provider: result?.value?.provider ?? null,
      };
    }
  } catch (error) {
    outcome = { mode: 'capture', ok: false, detail: `SMOKE_ERROR: ${error?.message ?? String(error)}`,
      route: 'none' };
  } finally {
    try { await ctx.fiber?.dispose?.(); } catch { /* best effort */ }
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  return { ...outcome, files: [`${skillId}/SKILL.md`], discovered };
}
