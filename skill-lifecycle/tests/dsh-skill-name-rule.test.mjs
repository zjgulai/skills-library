import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * DSH 的技能名规则：`^[a-z0-9]+(?:-[a-z0-9]+)*$`（kebab-case ASCII）。
 * 应用包源码两处为证：
 * - `dsh-skill/lib/index.js`：`SKILL_NAME` 校验 + `validateCandidate` 抛 `invalid skill name`；
 * - `dsh-skill-filesystem/lib/index.js`：`if (!isSkillName(name)) { warn("skill file ... ignored: invalid skill name"); return; }`
 *   —— 即**逐份忽略**（其余技能照常加载），不是整根报错。
 *
 * 这条规则决定了库里的中文名技能在 DSH 里是**隐形**的，所以钉成回归测试。
 */
const APP = '/Applications/DSH Desktop.app/Contents/Resources/app';
const require_ = createRequire(join(APP, 'package.json'));
const load = async name => await import(pathToFileURL(require_.resolve('@deepseek-ai/' + name)).href);

const skillText = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n## 工作流\n\n1. 按说明完成动作，并把依据写进交付物，便于复核与回滚。\n`;

test('a non-kebab (Chinese) skill name is ignored by the native provider, the rest still load', async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'name-rule-'));
  const skillRoot = join(root, 'skills');
  for (const name of ['kebab-ok', 'Skill评估师']) {
    await mkdir(join(skillRoot, name), { recursive: true });
    await writeFile(join(skillRoot, name, 'SKILL.md'),
      skillText(name, `当用户需要 ${name} 这类流程时使用；触发词：${name}。`));
  }
  const isolated = {};
  for (const key of ['dshHome', 'agentsHome', 'bundledSkillDir']) {
    isolated[key] = join(root, key);
    await mkdir(isolated[key], { recursive: true });
  }
  const { Context } = await load('cordis');
  const ctx = new Context();
  const warnings = [];
  ctx.logger = Object.assign(Object.create(ctx.logger ?? {}), {
    warn: message => warnings.push(String(message)),
  });
  const filesystemMod = await load('dsh-skill-filesystem');
  await ctx.plugin({ apply: filesystemMod.apply, inject: filesystemMod.inject, name: filesystemMod.name,
    Config: filesystemMod.Config }, {
    includeDefaultRoots: false, watch: false, customSkillDirs: [skillRoot],
    dshHome: isolated.dshHome, agentsHome: isolated.agentsHome, bundledSkillDir: isolated.bundledSkillDir,
  });
  await ctx.plugin((await load('dsh-skill')).default, {});
  t.after(async () => {
    try { await ctx.fiber?.dispose?.(); } catch { /* best effort */ }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const listed = await ctx.skills.list({ cwd: root });
  const names = listed.map(skill => skill.name);
  assert.deepEqual(names, ['kebab-ok'],
    `非 kebab 名必须被忽略、其余照常：实际 ${JSON.stringify(names)}`);
  assert.equal(warnings.some(message => message.includes('invalid skill name')), true,
    `应留下 "invalid skill name" 警告：${JSON.stringify(warnings)}`);
});
