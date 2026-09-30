import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDependencyRegistry, dependentsOf } from '../control/dependency-registry.mjs';

async function registryCase(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'deps-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  const registry = await openDependencyRegistry({ root, now: () => 1000 });
  return { root, registry };
}

function fact(overrides = {}) {
  return { dependent: { kind: 'terminal-set', id: 'w03' },
    provider: { skillId: 'validate-data', version: 'original-1e424822' },
    evidenceRef: '32-w03终测集铸造记录.md', ...overrides };
}

test('a dependency fact is recorded once and queryable by provider', async (t) => {
  const { registry } = await registryCase(t);
  const written = await registry.record(fact());
  assert.match(written.dependencyId, /^[a-f0-9]{64}$/);
  assert.equal(written.recordedAt, 1000);
  assert.equal(written.record_type, 'skill_dependency');
  const found = await registry.forProvider({ skillId: 'validate-data', version: 'original-1e424822' });
  assert.deepEqual(found.map(entry => [entry.dependent.kind, entry.dependent.id]), [['terminal-set', 'w03']]);
  assert.deepEqual(await registry.forProvider({ skillId: 'validate-data', version: 'other' }), []);
  assert.deepEqual((await registry.list()).map(entry => entry.dependencyId), [written.dependencyId]);
});

test('the same dependency is not recorded twice', async (t) => {
  const { registry } = await registryCase(t);
  await registry.record(fact());
  await assert.rejects(registry.record(fact()), /DUPLICATE_DEPENDENCY/);
  const other = await registry.record(fact({ dependent: { kind: 'task-set', id: 'a4' } }));
  assert.notEqual(other.dependencyId, (await registry.list())[0].dependencyId);
});

test('records are validated before they touch the file', async (t) => {
  const { registry } = await registryCase(t);
  await assert.rejects(registry.record(fact({ dependent: { kind: 'nonsense', id: 'w03' } })),
    /INVALID_DEPENDENCY/);
  await assert.rejects(registry.record(fact({ dependent: { kind: 'terminal-set' } })), /INVALID_DEPENDENCY/);
  await assert.rejects(registry.record(fact({ dependent: { kind: 'terminal-set', id: 'Bad Id' } })),
    /INVALID_DEPENDENCY/);
  await assert.rejects(registry.record(fact({ provider: { skillId: 'validate-data' } })), /INVALID_DEPENDENCY/);
  await assert.rejects(registry.record(fact({ provider: { skillId: 'validate-data', version: '' } })),
    /INVALID_DEPENDENCY/);
  await assert.rejects(registry.record(fact({ evidenceRef: '  ' })), /INVALID_DEPENDENCY/);
  await assert.rejects(registry.record(fact({ evidenceRef: 'x'.repeat(501) })), /INVALID_DEPENDENCY/);
  await assert.rejects(registry.record(fact({ extra: true })), /INVALID_DEPENDENCY/);
  await assert.rejects(registry.record(null), /INVALID_DEPENDENCY/);
  await assert.rejects(readFile(registry.path, 'utf8'), /ENOENT/, 'a refused fact must not leave a file');
});

test('the registry is append-only on disk', async (t) => {
  const { registry } = await registryCase(t);
  await registry.record(fact());
  const before = await readFile(registry.path, 'utf8');
  await registry.record(fact({ dependent: { kind: 'candidate', id: 't7-boundary-001' } }));
  const after = await readFile(registry.path, 'utf8');
  assert.equal(after.startsWith(before), true);
  assert.equal(after.split('\n').filter(line => line.length > 0).length, 2);
});

test('a tampered registry stops answering', async (t) => {
  const { registry } = await registryCase(t);
  await registry.record(fact());
  const line = JSON.parse((await readFile(registry.path, 'utf8')).trim());
  const rewrite = { ...line, evidenceRef: '别的记录.md' };
  await rm(registry.path);
  await writeFile(registry.path, `${JSON.stringify(rewrite)}\n`);
  await assert.rejects(registry.list(), /DEPENDENCY_TAMPERED: line 1/);
  await assert.rejects(registry.forProvider({ skillId: 'validate-data', version: 'original-1e424822' }),
    /DEPENDENCY_TAMPERED: line 1/);
});

test('dependentsOf feeds the planner shape directly', async (t) => {
  const { registry } = await registryCase(t);
  await registry.record(fact());
  await registry.record(fact({ dependent: { kind: 'task-set', id: 'a4' } }));
  const dependents = await dependentsOf({ registry,
    provider: { skillId: 'validate-data', version: 'original-1e424822' } });
  assert.deepEqual(dependents, [
    { skillId: 'terminal-set-w03', evidenceRef: '32-w03终测集铸造记录.md' },
    { skillId: 'task-set-a4', evidenceRef: '32-w03终测集铸造记录.md' },
  ]);
  const { planRetire } = await import('../control/change-plans.mjs');
  const heads = [{ skillId: 'validate-data', version: 'original-1e424822', disposition: 'retain',
    dispositionId: 'b'.repeat(64), decidedAt: 1 }];
  const base = { heads, skillId: 'validate-data', version: 'original-1e424822',
    replacement: { drop: true, reason: '不再需要' }, reason: '下线', evidenceRefs: ['46-工程缺口收口记录.md'],
    now: 2000, dependents };
  assert.throws(() => planRetire(base), /MIGRATION_REQUIRED/,
    'the registry-derived dependents must trigger the planner migration rule');
  const planned = planRetire({ ...base,
    migration: { note: '终测集转到新技能', evidenceRef: '46-工程缺口收口记录.md' } });
  assert.equal(planned.impact.dependents.length, 2);
});
