import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGovernanceLedger, dispositionIdOf } from '../control/governance-ledger.mjs';

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const digest = label => sha256(label);

async function ledgerCase(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'governance-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  const ledger = await openGovernanceLedger({ root, now: () => 1000 });
  return { root, ledger };
}

function disposition(overrides = {}) {
  return {
    skillId: 'validate-data', version: 'original-1e424822', disposition: 'retain',
    evidenceRefs: ['31-P1批A实测与判定.md#7'], sourceDigests: [digest('validate-data')],
    previous: null, ...overrides,
  };
}

test('a first disposition chains from nothing and is readable by identity', async (t) => {
  const { ledger } = await ledgerCase(t);
  const written = await ledger.append(disposition());
  assert.match(written.dispositionId, /^[a-f0-9]{64}$/);
  assert.equal(written.previous, null);
  assert.equal(written.record_type, 'governance_disposition');
  assert.equal(written.decidedAt, 1000);
  const latest = await ledger.latestFor('validate-data');
  assert.deepEqual(latest.map(entry => [entry.version, entry.disposition]), [['original-1e424822', 'retain']]);
  const history = await ledger.historyFor({ skillId: 'validate-data', version: 'original-1e424822' });
  assert.deepEqual(history.map(entry => entry.dispositionId), [written.dispositionId]);
  assert.deepEqual(await ledger.latestFor('unknown-skill'), []);
  assert.deepEqual(await ledger.historyFor({ skillId: 'validate-data', version: 'nope' }), []);
});

test('a decision cannot be overwritten: the chain only grows by follow-ups', async (t) => {
  const { ledger } = await ledgerCase(t);
  const first = await ledger.append(disposition());
  await assert.rejects(ledger.append(disposition()), /DUPLICATE_DISPOSITION/,
    'the identical decision must not be recorded twice');
  await assert.rejects(ledger.append(disposition({ disposition: 'retire' })),
    new RegExp(`CHAIN_CONFLICT: expected ${first.dispositionId}`),
    'a later decision must name the record it follows, not fork the chain');
  const followUp = await ledger.append(disposition({ disposition: 'rollback', previous: first.dispositionId,
    evidenceRefs: ['33-w03终测运行记录.md#6'] }));
  assert.equal(followUp.previous, first.dispositionId);
  const history = await ledger.historyFor({ skillId: 'validate-data', version: 'original-1e424822' });
  assert.deepEqual(history.map(entry => entry.disposition), ['retain', 'rollback'],
    'the superseded decision stays readable, in order');
  const latest = await ledger.latestFor('validate-data');
  assert.deepEqual(latest.map(entry => entry.disposition), ['rollback']);
});

test('the ledger is append-only on disk', async (t) => {
  const { ledger } = await ledgerCase(t);
  const first = await ledger.append(disposition());
  const before = await readFile(ledger.path, 'utf8');
  await ledger.append(disposition({ disposition: 'retire', previous: first.dispositionId }));
  const after = await readFile(ledger.path, 'utf8');
  assert.equal(after.startsWith(before), true, 'the existing bytes must be untouched');
  assert.equal(after.split('\n').filter(line => line.length > 0).length, 2);
});

test('only pointers are stored, never evidence content', async (t) => {
  const { ledger } = await ledgerCase(t);
  await assert.rejects(ledger.append(disposition({ evidenceRefs: ['x'.repeat(501)] })), /INVALID_DISPOSITION/);
  await assert.rejects(ledger.append(disposition({ evidenceRefs: [] })), /INVALID_DISPOSITION/);
  await assert.rejects(ledger.append(disposition({
    evidenceRefs: Array.from({ length: 33 }, (unused, index) => `ref-${index}`) })), /INVALID_DISPOSITION/);
  await assert.rejects(ledger.append(disposition({ sourceDigests: ['not-a-digest'] })), /INVALID_DISPOSITION/);
  await assert.rejects(ledger.append(disposition({ sourceDigests: [] })), /INVALID_DISPOSITION/);
});

test('records are validated before they touch the file', async (t) => {
  const { ledger } = await ledgerCase(t);
  await assert.rejects(ledger.append(disposition({ disposition: 'delete' })), /INVALID_DISPOSITION/);
  await assert.rejects(ledger.append(disposition({ skillId: 'Bad Name' })), /INVALID_DISPOSITION/);
  await assert.rejects(ledger.append(disposition({ version: '' })), /INVALID_DISPOSITION/);
  await assert.rejects(ledger.append(disposition({ previous: 'abc' })), /INVALID_DISPOSITION/);
  await assert.rejects(ledger.append(disposition({ decidedAt: 'yesterday' })), /INVALID_DISPOSITION/);
  await assert.rejects(ledger.append(disposition({ evidence: 'sneaked in' })), /INVALID_DISPOSITION/);
  await assert.rejects(ledger.append({ skillId: 'x-y' }), /INVALID_DISPOSITION/);
  await assert.rejects(readFile(ledger.path, 'utf8'), /ENOENT/,
    'a refused record must not leave a ledger file behind');
});

test('identity queries stay consistent across versions and skills', async (t) => {
  const { ledger } = await ledgerCase(t);
  await ledger.append(disposition({ version: 'v1', disposition: 'promote' }));
  await ledger.append(disposition({ skillId: 'checker-lite', version: 'draft-001', disposition: 'retain' }));
  await ledger.append(disposition({ version: 'v2', disposition: 'retire' }));
  const latest = await ledger.latestFor('validate-data');
  assert.deepEqual(latest.map(entry => [entry.version, entry.disposition]).sort(), [['v1', 'promote'], ['v2', 'retire']]);
  assert.deepEqual((await ledger.latestFor('checker-lite')).map(entry => entry.version), ['draft-001']);
  const report = await ledger.verify();
  assert.equal(report.ok, true);
  assert.equal(report.records, 3);
  assert.deepEqual([...report.skills].sort(), ['checker-lite', 'validate-data']);
});

test('a tampered, forked or truncated ledger is refused instead of answered', async (t) => {
  const { ledger } = await ledgerCase(t);
  const first = await ledger.append(disposition());
  await ledger.append(disposition({ disposition: 'retire', previous: first.dispositionId }));
  const lines = (await readFile(ledger.path, 'utf8')).split('\n').filter(line => line.length > 0);
  const intact = await readFile(ledger.path, 'utf8');

  await writeFile(ledger.path, intact.replace('"retire"', '"retired"'));
  await assert.rejects(ledger.verify(), /LEDGER_TAMPERED: line 2/);
  await assert.rejects(ledger.latestFor('validate-data'), /LEDGER_TAMPERED: line 2/,
    'a query must not answer from a ledger it cannot vouch for');

  const fork = { record_type: 'governance_disposition', skillId: 'validate-data', version: 'original-1e424822',
    disposition: 'merge', evidenceRefs: ['32-w03终测集铸造记录.md'], sourceDigests: [digest('validate-data')],
    previous: null, decidedAt: 2000 };
  await writeFile(ledger.path, `${[lines[0], JSON.stringify({ ...fork,
    dispositionId: dispositionIdOf(fork) })].join('\n')}\n`);
  await assert.rejects(ledger.verify(), /CHAIN_FORK: validate-data@original-1e424822/);

  await writeFile(ledger.path, `${lines[0]}\n`);
  const second = await ledger.append(disposition({ disposition: 'retire', previous: first.dispositionId }));
  await ledger.append(disposition({ disposition: 'merge', previous: second.dispositionId }));
  const three = (await readFile(ledger.path, 'utf8')).split('\n').filter(line => line.length > 0);
  assert.equal(three.length, 3);
  await writeFile(ledger.path, `${[three[0], three[2]].join('\n')}\n`);
  await assert.rejects(ledger.verify(), /CHAIN_BROKEN: validate-data@original-1e424822/,
    'a deleted link must break the chain, not silently re-link it');
});

test('a foreign record that parses as JSON but is not a disposition is refused', async (t) => {
  const { ledger } = await ledgerCase(t);
  await appendFile(ledger.path, `${JSON.stringify({ record_type: 'w2_ab_task', arm: 'candidate' })}\n`);
  await assert.rejects(ledger.verify(), /INVALID_RECORD: line 1/);
  await assert.rejects(ledger.latestFor('validate-data'), /INVALID_RECORD: line 1/);
  assert.throws(() => dispositionIdOf(null), /INVALID_DISPOSITION/);
});
