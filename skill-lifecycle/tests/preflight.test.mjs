import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { preflight } from '../control/preflight.mjs';
import { noSkillDigest } from '../control/arm-scope.mjs';

const execFileAsync = promisify(execFile);
const cli = join(import.meta.dirname, '..', 'control', 'preflight.mjs');

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const digest = label => createHash('sha256').update(String(label)).digest('hex');

const toolNames = ['skill', 'trial_read', 'trial_compute', 'trial_write_report'];

function manifestWith(overrides = {}) {
  return {
    runId: 'run-preflight-001',
    batchId: 'batch-preflight-001',
    sessionId: 'session-preflight-001',
    skillDigest: digest('skill'),
    inputDigest: digest('input'),
    evaluatorDigest: digest('evaluator'),
    environmentDigest: digest('environment'),
    policyDigest: digest('policy'),
    files: [
      { fileId: 'report', path: '/trusted/inputs/report.md', sha256: digest('report'), maxBytes: 4096 },
      { fileId: 'metrics', path: '/trusted/inputs/metrics.csv', sha256: digest('metrics'), maxBytes: 4096 },
      { fileId: 'skill', path: '/trusted/skill/SKILL.md', sha256: digest('skill'), maxBytes: 4096 },
    ],
    toolNames: [...toolNames],
    modelSelection: { provider: 'trial-provider', model: 'trial-model' },
    budget: { maxAttempts: 2, maxOutputTokensPerAttempt: 20, maxRequestBytes: 4096,
      observedTokenStop: 100, batchDeadlineMs: 5000, attemptTimeoutMs: 100 },
    authorization: { reference: 'approval-2026-09-25-01', scopeDigest: digest('scope') },
    ...overrides,
  };
}

function capabilitiesWith(overrides = {}) {
  return {
    installedDshVersion: '0.1.5-rc.2',
    readBoundaryVerified: true,
    requestAttemptsCovered: true,
    stopVerified: true,
    authorizationVerified: true,
    nativeSessionVerified: true,
    approvedModel: { provider: 'trial-provider', model: 'trial-model' },
    approvedEnvironmentDigest: digest('environment'),
    approvedToolNames: [...toolNames],
    approvedFiles: [
      { fileId: 'report', sha256: digest('report'), maxBytes: 4096 },
      { fileId: 'metrics', sha256: digest('metrics'), maxBytes: 4096 },
      { fileId: 'skill', sha256: digest('skill'), maxBytes: 4096 },
    ],
    authorization: { reference: 'approval-2026-09-25-01', scopeDigest: digest('scope') },
    ...overrides,
  };
}

test('a missing enforcement capability blocks launch', async () => {
  const result = await preflight({
    manifest: { runId: 'r1', toolNames: ['skill', 'trial_read', 'trial_compute', 'trial_write_report'] },
    capabilities: { nativeVersionMatches: true, readBoundaryVerified: false,
      requestAttemptsCovered: false, stopVerified: false, authorizationVerified: false },
  });
  assert.equal(result.status, 'blocked');
  assert.ok(result.blockers.includes('READ_BOUNDARY_UNVERIFIED'));
  assert.ok(result.blockers.includes('AUTHORIZATION_MISSING'));
});

test('a fully evidenced manifest is ready and yields a bounded preview', async () => {
  const result = await preflight({ manifest: manifestWith(), capabilities: capabilitiesWith() });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.blockers, []);
  assert.ok(result.checks.length >= 8);
  const preview = result.preview;
  assert.deepEqual(Object.keys(preview).sort(),
    ['deadlines', 'limits', 'materials', 'model', 'tools']);
  assert.deepEqual(preview.model, { provider: 'trial-provider', model: 'trial-model' });
  assert.deepEqual(preview.tools, toolNames);
  assert.deepEqual(preview.materials.map(material => material.fileId).sort(), ['metrics', 'report', 'skill']);
  assert.equal(preview.materials.every(material => typeof material.sha256 === 'string'), true);
  assert.equal(preview.limits.maxAttempts, 2);
  assert.equal(preview.deadlines.batchDeadlineMs, 5000);
});

test('the preview never carries secrets or undeclared fields', async () => {
  const manifest = manifestWith({ notes: 'SENTINEL-SECRET', goldAnswer: 'SENTINEL-GOLD' });
  const capabilities = capabilitiesWith({ secretToken: 'SENTINEL-TOKEN' });
  const result = await preflight({ manifest, capabilities });
  const serialized = JSON.stringify(result.preview);
  assert.equal(serialized.includes('SENTINEL-SECRET'), false);
  assert.equal(serialized.includes('SENTINEL-GOLD'), false);
  assert.equal(serialized.includes('SENTINEL-TOKEN'), false);
  assert.equal(serialized.includes('/trusted/inputs'), false);
});

test('every blocker is reported instead of stopping at the first', async () => {
  const result = await preflight({
    manifest: manifestWith({ toolNames: [...toolNames, 'bash'], budget: undefined,
      modelSelection: { provider: 'trial-provider', model: 'other-model' } }),
    capabilities: capabilitiesWith({ installedDshVersion: '0.1.4', stopVerified: false,
      authorizationVerified: false }),
  });
  assert.equal(result.status, 'blocked');
  for (const expected of ['NATIVE_VERSION_MISMATCH', 'STOP_UNVERIFIED', 'AUTHORIZATION_MISSING',
    'TOOL_NOT_ALLOWED: bash', 'BUDGET_MISSING', 'MODEL_NOT_APPROVED']) {
    assert.ok(result.blockers.includes(expected), `missing blocker ${expected}`);
  }
});

test('the tool scope must be exactly the frozen whitelist', async () => {
  const extra = await preflight({ manifest: manifestWith({ toolNames: [...toolNames, 'run_code'] }),
    capabilities: capabilitiesWith() });
  assert.ok(extra.blockers.includes('TOOL_NOT_ALLOWED: run_code'));
  const missing = await preflight({ manifest: manifestWith({ toolNames: toolNames.slice(0, 3) }),
    capabilities: capabilitiesWith() });
  assert.ok(missing.blockers.includes('TOOL_MISSING: trial_write_report'));
  const drifted = await preflight({ manifest: manifestWith(),
    capabilities: capabilitiesWith({ approvedToolNames: ['skill', 'trial_read'] }) });
  assert.ok(drifted.blockers.includes('TOOL_SCOPE_MISMATCH'));
});

test('file identity, allowance and size are checked before launch', async () => {
  const changed = await preflight({
    manifest: manifestWith({ files: [
      { fileId: 'report', path: '/trusted/inputs/report.md', sha256: digest('tampered'), maxBytes: 4096 },
      { fileId: 'metrics', path: '/trusted/inputs/metrics.csv', sha256: digest('metrics'), maxBytes: 4096 },
      { fileId: 'skill', path: '/trusted/skill/SKILL.md', sha256: digest('skill'), maxBytes: 4096 },
    ] }), capabilities: capabilitiesWith() });
  assert.ok(changed.blockers.includes('FILE_IDENTITY_CHANGED: report'));
  const hidden = await preflight({
    manifest: manifestWith({ files: [
      { fileId: 'hidden', path: '/trusted/inputs/extra.md', sha256: digest('hidden'), maxBytes: 4096 },
      { fileId: 'report', path: '/trusted/inputs/report.md', sha256: digest('report'), maxBytes: 4096 },
      { fileId: 'metrics', path: '/trusted/inputs/metrics.csv', sha256: digest('metrics'), maxBytes: 4096 },
      { fileId: 'skill', path: '/trusted/skill/SKILL.md', sha256: digest('skill'), maxBytes: 4096 },
    ] }), capabilities: capabilitiesWith() });
  assert.ok(hidden.blockers.includes('FILE_NOT_ALLOWED: hidden'));
  const oversized = await preflight({
    manifest: manifestWith({ files: [
      { fileId: 'report', path: '/trusted/inputs/report.md', sha256: digest('report'), maxBytes: 999999 },
      { fileId: 'metrics', path: '/trusted/inputs/metrics.csv', sha256: digest('metrics'), maxBytes: 4096 },
      { fileId: 'skill', path: '/trusted/skill/SKILL.md', sha256: digest('skill'), maxBytes: 4096 },
    ] }), capabilities: capabilitiesWith() });
  assert.ok(oversized.blockers.includes('FILE_TOO_LARGE: report'));
});

test('a manifest authorization is a claim, never the authorization itself', async () => {
  const unverified = await preflight({ manifest: manifestWith(),
    capabilities: capabilitiesWith({ authorizationVerified: false }) });
  assert.ok(unverified.blockers.includes('AUTHORIZATION_MISSING'));
  const wrongScope = await preflight({ manifest: manifestWith(),
    capabilities: capabilitiesWith({ authorization: { reference: 'approval-2026-09-25-01', scopeDigest: digest('other-scope') } }) });
  assert.ok(wrongScope.blockers.includes('AUTHORIZATION_SCOPE_MISMATCH'));
  const selfApproved = await preflight({ manifest: manifestWith({
    authorization: { reference: 'approval-2026-09-25-01', scopeDigest: digest('scope'), approved: true } }),
  capabilities: capabilitiesWith() });
  assert.ok(selfApproved.blockers.includes('INVALID_MANIFEST'));
  assert.equal(selfApproved.status, 'blocked');
});

test('offline evidence alone still cannot launch a real session', async () => {
  const result = await preflight({ manifest: manifestWith(),
    capabilities: capabilitiesWith({ nativeSessionVerified: false }) });
  assert.equal(result.status, 'blocked');
  assert.ok(result.blockers.includes('NATIVE_SESSION_UNVERIFIED'));
});

test('budget and environment must be concrete and matching', async () => {
  const emptyBudget = await preflight({ manifest: manifestWith({
    budget: { maxAttempts: 0, maxOutputTokensPerAttempt: 20, maxRequestBytes: 4096,
      observedTokenStop: 100, batchDeadlineMs: 5000, attemptTimeoutMs: 100 } }),
  capabilities: capabilitiesWith() });
  assert.ok(emptyBudget.blockers.includes('BUDGET_INVALID'));
  const driftedEnvironment = await preflight({ manifest: manifestWith(),
    capabilities: capabilitiesWith({ approvedEnvironmentDigest: digest('other-environment') }) });
  assert.ok(driftedEnvironment.blockers.includes('ENVIRONMENT_MISMATCH'));
  const incompleteBinding = await preflight({ manifest: manifestWith({ policyDigest: undefined }),
    capabilities: capabilitiesWith() });
  assert.ok(incompleteBinding.blockers.includes('BINDING_INCOMPLETE'));
});

test('the checks list reports each requirement with its verdict', async () => {
  const result = await preflight({ manifest: manifestWith(),
    capabilities: capabilitiesWith({ stopVerified: false }) });
  const ids = result.checks.map(check => check.id);
  for (const expected of ['binding', 'nativeVersion', 'readBoundary', 'requestAttempts',
    'stop', 'authorization', 'files', 'tools', 'model', 'budget', 'environment']) {
    assert.ok(ids.includes(expected), `missing check ${expected}`);
  }
  const stop = result.checks.find(check => check.id === 'stop');
  assert.equal(stop.ok, false);
  assert.equal(stop.detail, 'STOP_UNVERIFIED');
  assert.ok(Object.isFrozen(result.checks[0]));
});

test('unverifiable file or tool scopes block instead of passing', async () => {
  const noApprovedFiles = await preflight({ manifest: manifestWith(),
    capabilities: capabilitiesWith({ approvedFiles: undefined }) });
  assert.ok(noApprovedFiles.blockers.includes('FILES_UNVERIFIED'));
  const malformedApprovedFile = await preflight({ manifest: manifestWith(),
    capabilities: capabilitiesWith({ approvedFiles: [{ fileId: 'report', sha256: 'nope', maxBytes: 0 }] }) });
  assert.ok(malformedApprovedFile.blockers.includes('INVALID_CAPABILITIES'));
  const noTools = await preflight({ manifest: manifestWith({ toolNames: undefined }),
    capabilities: capabilitiesWith() });
  assert.ok(noTools.blockers.includes('TOOLS_UNVERIFIED'));
  const malformedFile = await preflight({ manifest: manifestWith({ files: [
    { fileId: 'report', sha256: digest('report'), maxBytes: 4096 },
    { fileId: 'metrics', path: '/trusted/inputs/metrics.csv', sha256: digest('metrics'), maxBytes: 4096 },
    { fileId: 'skill', path: '/trusted/skill/SKILL.md', sha256: digest('skill'), maxBytes: 4096 },
  ] }), capabilities: capabilitiesWith() });
  assert.ok(malformedFile.blockers.includes('INVALID_MANIFEST'));
  assert.equal(malformedFile.status, 'blocked');
});

test('the CLI reports an unreadable manifest as blocked JSON', async (t) => {
  const { makeTempCase } = await import('./fixtures.mjs');
  const f = await makeTempCase(t);
  const missing = await runCli([cli, '--manifest', join(f.trusted, 'absent.json')]);
  assert.equal(missing.code, 3);
  assert.deepEqual(JSON.parse(missing.stdout).blockers, ['MANIFEST_UNREADABLE']);
  const malformedPath = join(f.trusted, 'broken.json');
  await writeFile(malformedPath, '{ not json');
  const malformed = await runCli([cli, '--manifest', malformedPath]);
  assert.equal(malformed.code, 3);
  assert.deepEqual(JSON.parse(malformed.stdout).blockers, ['MANIFEST_UNREADABLE']);
});

test('model and tool scopes must be exact, typed and duplicate-free', async () => {
  const emptyModel = await preflight({ manifest: manifestWith({
    modelSelection: { provider: '', model: '' } }), capabilities: capabilitiesWith() });
  assert.ok(emptyModel.blockers.includes('MODEL_INVALID'));
  const typedModel = await preflight({ manifest: manifestWith({
    modelSelection: { provider: null, model: null } }), capabilities: capabilitiesWith() });
  assert.ok(typedModel.blockers.includes('MODEL_INVALID'));
  assert.equal(typedModel.preview.model, null);
  const duplicatedTools = await preflight({ manifest: manifestWith({
    toolNames: ['skill', 'skill', 'trial_read', 'trial_compute', 'trial_write_report'] }),
  capabilities: capabilitiesWith() });
  assert.ok(duplicatedTools.blockers.some(blocker => blocker.startsWith('TOOL_DUPLICATE')));
  const duplicatedFiles = await preflight({ manifest: manifestWith({ files: [
    { fileId: 'report', path: '/trusted/inputs/report.md', sha256: digest('report'), maxBytes: 4096 },
    { fileId: 'report', path: '/trusted/inputs/report.md', sha256: digest('report'), maxBytes: 4096 },
    { fileId: 'metrics', path: '/trusted/inputs/metrics.csv', sha256: digest('metrics'), maxBytes: 4096 },
    { fileId: 'skill', path: '/trusted/skill/SKILL.md', sha256: digest('skill'), maxBytes: 4096 },
  ] }), capabilities: capabilitiesWith() });
  assert.ok(duplicatedFiles.blockers.includes('INVALID_MANIFEST'));
  assert.equal(duplicatedFiles.status, 'blocked');
});

test('materials that cannot fit the request budget block the launch', async () => {
  const capTooSmall = await preflight({ manifest: manifestWith({
    budget: { maxAttempts: 2, maxOutputTokensPerAttempt: 20, maxRequestBytes: 64,
      observedTokenStop: 100, batchDeadlineMs: 5000, attemptTimeoutMs: 100 } }),
  capabilities: capabilitiesWith() });
  assert.ok(capTooSmall.blockers.includes('MATERIAL_BYTES_EXCEED_REQUEST_BUDGET'));
  const actualTooLarge = await preflight({ manifest: manifestWith({ files: [
    { fileId: 'report', path: '/trusted/inputs/report.md', sha256: digest('report'), maxBytes: 4096, bytes: 4000 },
    { fileId: 'metrics', path: '/trusted/inputs/metrics.csv', sha256: digest('metrics'), maxBytes: 4096, bytes: 3000 },
    { fileId: 'skill', path: '/trusted/skill/SKILL.md', sha256: digest('skill'), maxBytes: 4096, bytes: 100 },
  ] }), capabilities: capabilitiesWith() });
  assert.ok(actualTooLarge.blockers.includes('MATERIAL_BYTES_EXCEED_REQUEST_BUDGET'));
});

test('a manifest with no materials or an inherited prototype capability blocks', async () => {
  const noMaterials = await preflight({ manifest: manifestWith({ files: [] }),
    capabilities: capabilitiesWith({ approvedFiles: [] }) });
  assert.ok(noMaterials.blockers.includes('NO_MATERIALS'));
  assert.equal(noMaterials.status, 'blocked');
  const inherited = Object.create({ readBoundaryVerified: true, nativeSessionVerified: true });
  inherited.installedDshVersion = '0.1.5-rc.2';
  const polluted = await preflight({ manifest: manifestWith(), capabilities: inherited });
  assert.equal(polluted.status, 'blocked');
  assert.ok(polluted.blockers.includes('INVALID_CAPABILITIES'));
  const fakeVersion = await preflight({ manifest: manifestWith(),
    capabilities: capabilitiesWith({ installedDshVersion: null, nativeVersionMatches: true }) });
  assert.equal(fakeVersion.status, 'blocked');
  assert.ok(fakeVersion.blockers.includes('INVALID_CAPABILITIES'));
});

test('the CLI prints usage without a manifest and never starts a run', async () => {
  const withoutArgs = await runCli([cli]);
  assert.notEqual(withoutArgs.code, 0);
  assert.match(`${withoutArgs.stdout}${withoutArgs.stderr}`, /--manifest/);
  assert.equal(withoutArgs.stdout.includes('"status"'), false);
  const withUnknownFlag = await runCli([cli, '--run']);
  assert.notEqual(withUnknownFlag.code, 0);
  assert.match(`${withUnknownFlag.stdout}${withUnknownFlag.stderr}`, /Usage/i);
});

test('the CLI emits JSON for a real manifest file and exits blocked until T08 exists', async (t) => {
  const { makeTempCase } = await import('./fixtures.mjs');
  const f = await makeTempCase(t);
  const manifestPath = join(f.trusted, 'manifest.json');
  const capabilitiesPath = join(f.trusted, 'capabilities.json');
  await writeFile(manifestPath, `${JSON.stringify(manifestWith())}\n`);
  await writeFile(capabilitiesPath, `${JSON.stringify(capabilitiesWith({ nativeSessionVerified: false }))}\n`);
  const blocked = await runCli([cli, '--manifest', manifestPath, '--capabilities', capabilitiesPath]);
  assert.equal(blocked.code, 3);
  const parsed = JSON.parse(blocked.stdout);
  assert.equal(parsed.status, 'blocked');
  assert.ok(parsed.blockers.includes('NATIVE_SESSION_UNVERIFIED'));
  await writeFile(capabilitiesPath, `${JSON.stringify(capabilitiesWith())}\n`);
  const ready = await runCli([cli, '--manifest', manifestPath, '--capabilities', capabilitiesPath]);
  assert.equal(ready.code, 0);
  assert.equal(JSON.parse(ready.stdout).status, 'ready');
  const missingCapabilities = await runCli([cli, '--manifest', manifestPath,
    '--capabilities', join(f.trusted, 'absent.json')]);
  assert.equal(missingCapabilities.code, 3);
  assert.ok(JSON.parse(missingCapabilities.stdout).blockers.includes('CAPABILITIES_UNREADABLE'));
});

const unarmedTools = ['trial_read', 'trial_compute', 'trial_write_report'];
const unarmedFiles = [
  { fileId: 'report', path: '/trusted/inputs/report.md', sha256: digest('report'), maxBytes: 4096 },
  { fileId: 'metrics', path: '/trusted/inputs/metrics.csv', sha256: digest('metrics'), maxBytes: 4096 },
];
const approvedUnarmed = unarmedFiles.map(({ fileId, sha256, maxBytes }) => ({ fileId, sha256, maxBytes }));

test('the no-skill arm declares a three-tool scope and no skill material', () => {
  const manifest = manifestWith({ arm: 'none', skillDigest: noSkillDigest,
    files: unarmedFiles, toolNames: [...unarmedTools] });
  const capabilities = capabilitiesWith({ approvedToolNames: [...unarmedTools],
    approvedFiles: approvedUnarmed });
  return preflight({ manifest, capabilities }).then(result => {
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.preview.tools, [...unarmedTools]);
    assert.deepEqual(result.preview.materials.map(material => material.fileId).sort(), ['metrics', 'report']);
  });
});

test('an unarmed manifest that keeps the skill tool, skill material or a real skill digest is blocked', async () => {
  const armed = await preflight({ manifest: manifestWith({ arm: 'none', skillDigest: noSkillDigest }),
    capabilities: capabilitiesWith() });
  assert.equal(armed.status, 'blocked');
  assert.ok(armed.blockers.includes('TOOL_NOT_ALLOWED: skill'),
    'a no-skill arm must not declare the skill tool');
  const material = await preflight({
    manifest: manifestWith({ arm: 'none', skillDigest: noSkillDigest, files: unarmedFiles,
      toolNames: [...unarmedTools] }),
    capabilities: capabilitiesWith({ approvedToolNames: [...unarmedTools],
      approvedFiles: [...approvedUnarmed, { fileId: 'skill', sha256: digest('skill'), maxBytes: 4096 }] }) });
  assert.equal(material.status, 'blocked');
  assert.ok(material.blockers.includes('UNARMED_SKILL_MATERIAL'));
  const digestScope = await preflight({
    manifest: manifestWith({ arm: 'none', skillDigest: digest('skill'), files: unarmedFiles,
      toolNames: [...unarmedTools] }),
    capabilities: capabilitiesWith({ approvedToolNames: [...unarmedTools], approvedFiles: approvedUnarmed }) });
  assert.equal(digestScope.status, 'blocked');
  assert.ok(digestScope.blockers.includes('SKILL_DIGEST_SCOPE_MISMATCH'));
  const sentinelWhileArmed = await preflight({ manifest: manifestWith({ skillDigest: noSkillDigest }),
    capabilities: capabilitiesWith() });
  assert.equal(sentinelWhileArmed.status, 'blocked');
  assert.ok(sentinelWhileArmed.blockers.includes('SKILL_DIGEST_SCOPE_MISMATCH'),
    'an armed run may not carry the absence digest');
  const bogus = await preflight({ manifest: manifestWith({ arm: 'beta' }), capabilities: capabilitiesWith() });
  assert.equal(bogus.status, 'blocked');
  assert.ok(bogus.blockers.includes('INVALID_MANIFEST'));
});
