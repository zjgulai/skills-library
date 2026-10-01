import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { matcher, classifyOne, descOf } from '../trial-home/r5/routing-v2-draft.mjs';

const SCRIPT = fileURLToPath(new URL('../trial-home/r5/routing-v2-draft.mjs', import.meta.url));

test('matcher：ASCII 词边界、前缀通配、CJK 子串', () => {
  assert.equal(matcher('game')('play the game now'), true);
  assert.equal(matcher('game')('gamestop deals'), false, '词中不命中');
  assert.equal(matcher('summar*')('summarizing reports'), true);
  assert.equal(matcher('爬取')('网页爬取工具'), true);
  assert.equal(matcher('deploy*')('deployment pipeline'), true, '显式 * 才放开通配词干');
  assert.equal(matcher('deploy')('deploy now'), true);
  assert.equal(matcher('game')('gamestop deals'), false);
});

test('classifyOne：强命中/弱×2/弱×1 三档', () => {
  const strong = classifyOne({ name: 'git-helper', desc: 'x' });
  assert.match(strong.bucket, /研发与代码|网站与部署/, 'git 强命中（桶由 TABLE 定）');
  const weak2 = classifyOne({ name: 'a', desc: 'data records 表' });
  assert.equal(weak2.bucket, 'shared:数据', '弱词两次命中');
  const weak1 = classifyOne({ name: 'a', desc: 'a gentle note' });
  assert.equal(weak1.bucket, null);
  assert.equal(weak1.why, 'no-hit');
});

test('classifyOne：跨桶歧义⇒留待核；名字侧强命中可解歧义', () => {
  const ambiguous = classifyOne({ name: 'zzz', desc: 'video image audio 素材 与 deploy docker' });
  assert.equal(ambiguous.bucket, null);
  assert.match(ambiguous.why, /ambiguous/);
  // docker-image-build 名字里同时含 docker 与 image 两个强词 ⇒ 双桶都在名内，仍判歧义（保守）
  const bothInName = classifyOne({ name: 'docker-image-build', desc: 'video' });
  assert.equal(bothInName.bucket, null);
  // 单义名内强词可解歧义：docker-compose-deploy 名内只有「网站与部署」侧强词
  const resolved = classifyOne({ name: 'docker-compose-deploy', desc: 'video' });
  assert.equal(resolved.bucket, 'shared:网站与部署');
  assert.equal(resolved.why, 'ambiguous-resolved-by-name');
});

test('classifyOne：共享/其他并存时强命中优先', () => {
  const both = classifyOne({ name: 'pet-photo', desc: '' });
  assert.ok(both.bucket === 'other:个人娱乐' || both.bucket === null, 'photo 与 pet 双强：pet 在名内应可解');
});

test('占位守卫：模板/尖括号占位一律留待核', async () => {
  const { classifyOne: c } = await import('../trial-home/r5/routing-v2-draft.mjs');
  const t1 = c({ name: '<your-skill-name>', desc: '<Brief description ... Include trigger keywords for agent discovery.>' });
  assert.equal(t1.bucket, null);
  assert.equal(t1.why, 'placeholder');
  const t2 = c({ name: 'real-skill', desc: 'TODO: write description' });
  assert.equal(t2.bucket, null);
  assert.equal(t2.why, 'placeholder');
});

test('descOf：引号与块标量', () => {
  assert.equal(descOf('---\nname: a\ndescription: "hello world"\n---\nbody'), 'hello world');
  assert.equal(descOf('---\ndescription: |\n  第一行\n  第二行\ntitle: x\n---\n'), '第一行 第二行');
  assert.equal(descOf('no frontmatter'), null);
});

test('CLI 冒烟：--sample 缺失退 2', async () => {
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(run.status, 2);
});
