import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { armVocabulary, isArmed, noSkillDigest, toolScopeFor } from './arm-scope.mjs';

const PINNED_DSH_VERSION = '0.1.5-rc.2';
const skillFileId = 'skill';
const bindingFields = ['runId', 'batchId', 'sessionId', 'skillDigest', 'inputDigest',
  'evaluatorDigest', 'environmentDigest', 'policyDigest'];
const limitFields = ['maxAttempts', 'maxOutputTokensPerAttempt', 'maxRequestBytes',
  'observedTokenStop', 'batchDeadlineMs', 'attemptTimeoutMs'];
const fileFields = ['fileId', 'path', 'sha256', 'maxBytes'];
const optionalFileFields = ['bytes'];
const approvedFileFields = ['fileId', 'sha256', 'maxBytes'];
const authorizationFields = ['reference', 'scopeDigest'];
const modelFields = ['provider', 'model'];
const checkIds = ['binding', 'nativeVersion', 'readBoundary', 'requestAttempts', 'stop',
  'authorization', 'files', 'tools', 'model', 'budget', 'environment', 'nativeSession'];
const maxDeclaredTools = 16;
const maxDeclaredFiles = 64;

function isRecord(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function isDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function own(object, key) {
  if (object === null || typeof object !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function record(value, fields) {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== fields.length) return null;
  const copy = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function collector() {
  const checks = [];
  const blockers = [];
  const seen = new Set();
  return {
    checks,
    blockers,
    add(blocker) {
      if (typeof blocker !== 'string' || seen.has(blocker)) return;
      seen.add(blocker);
      blockers.push(blocker);
    },
    verdict(id, ok, detail) {
      const passed = Boolean(ok);
      checks.push(freeze({ id, ok: passed, detail: passed ? null : (detail ?? null) }));
      if (!passed && detail !== undefined && detail !== null) this.add(detail);
    },
  };
}

function readBinding(manifest, sink) {
  const binding = {};
  for (const key of bindingFields) {
    const value = own(manifest, key);
    if (typeof value !== 'string' || !value.trim() || (key.endsWith('Digest') && !isDigest(value))) {
      sink.verdict('binding', false, 'BINDING_INCOMPLETE');
      return null;
    }
    binding[key] = value;
  }
  sink.verdict('binding', true);
  return binding;
}

function checkFiles(manifest, capabilities, budget, sink, skillArmed) {
  const declared = own(manifest, 'files');
  const approved = own(capabilities, 'approvedFiles');
  if (!Array.isArray(declared) || !Array.isArray(approved)) {
    sink.verdict('files', false, 'FILES_UNVERIFIED');
    return [];
  }
  if (declared.length > maxDeclaredFiles) {
    sink.verdict('files', false, 'FILES_UNVERIFIED');
    return [];
  }
  if (!skillArmed && (declared.some(entry => own(entry, 'fileId') === skillFileId) ||
    approved.some(entry => own(entry, 'fileId') === skillFileId))) {
    sink.add('UNARMED_SKILL_MATERIAL');
  }
  const approvedById = new Map();
  for (const entry of approved) {
    const item = record(entry, approvedFileFields);
    if (item === null || typeof item.fileId !== 'string' || !item.fileId.trim() ||
      !isDigest(item.sha256) || !Number.isSafeInteger(item.maxBytes) || item.maxBytes <= 0 ||
      approvedById.has(item.fileId)) {
      sink.verdict('files', false, 'INVALID_CAPABILITIES');
      return [];
    }
    approvedById.set(item.fileId, item);
  }
  const seen = new Set();
  const materials = [];
  let totalActualBytes = 0;
  let actualComplete = true;
  let failed = false;
  for (const entry of declared) {
    const file = record(entry, fileFields) ?? record(entry, [...fileFields, ...optionalFileFields]);
    const actualBytes = isRecord(entry) && Reflect.ownKeys(entry).length === fileFields.length + 1
      ? own(entry, 'bytes') : undefined;
    if (file === null || typeof file.fileId !== 'string' || !file.fileId.trim() ||
      typeof file.path !== 'string' || !file.path.trim() || !isDigest(file.sha256) ||
      !Number.isSafeInteger(file.maxBytes) || file.maxBytes <= 0 ||
      (actualBytes !== undefined && (!Number.isSafeInteger(actualBytes) || actualBytes < 0 ||
        actualBytes > file.maxBytes)) || seen.has(file.fileId)) {
      failed = true;
      sink.add('INVALID_MANIFEST');
      continue;
    }
    seen.add(file.fileId);
    const allowed = approvedById.get(file.fileId);
    if (allowed === undefined) sink.add(`FILE_NOT_ALLOWED: ${file.fileId}`);
    else if (allowed.sha256 !== file.sha256) sink.add(`FILE_IDENTITY_CHANGED: ${file.fileId}`);
    else if (file.maxBytes > allowed.maxBytes) sink.add(`FILE_TOO_LARGE: ${file.fileId}`);
    else {
      materials.push({ fileId: file.fileId, sha256: file.sha256, maxBytes: file.maxBytes,
        bytes: actualBytes === undefined ? null : actualBytes });
      if (actualBytes === undefined) actualComplete = false;
      else totalActualBytes += actualBytes;
    }
  }
  for (const fileId of approvedById.keys()) {
    if (!seen.has(fileId)) sink.add(`FILE_MISSING: ${fileId}`);
  }
  if (materials.length === 0) sink.add('NO_MATERIALS');
  const blockers = sink.blockers.filter(blocker => blocker.startsWith('FILE_') ||
    blocker === 'NO_MATERIALS' || blocker === 'INVALID_CAPABILITIES' || blocker === 'INVALID_MANIFEST');
  sink.verdict('files', blockers.length === 0 && !failed, blockers[0]);
  if (budget !== null) {
    if ((actualComplete && totalActualBytes > budget.maxRequestBytes) ||
      materials.some(material => material.maxBytes > budget.maxRequestBytes)) {
      sink.add('MATERIAL_BYTES_EXCEED_REQUEST_BUDGET');
    }
  }
  return materials.sort((left, right) => left.fileId.localeCompare(right.fileId));
}

export async function preflight(options = {}) {
  const sink = collector();
  try {
    const manifest = own(options, 'manifest');
    const capabilities = own(options, 'capabilities');
    if (!isRecord(manifest)) sink.add('INVALID_MANIFEST');
    if (!isRecord(capabilities)) sink.add('INVALID_CAPABILITIES');

    const binding = readBinding(manifest, sink);

    const declaredArm = own(manifest, 'arm');
    let skillArmed = true;
    if (declaredArm !== undefined) {
      if (typeof declaredArm !== 'string' || !armVocabulary.includes(declaredArm)) {
        sink.add('INVALID_MANIFEST');
      } else {
        skillArmed = isArmed(declaredArm);
      }
    }
    if (binding !== null && (binding.skillDigest === noSkillDigest) === skillArmed) {
      sink.verdict('binding', false, 'SKILL_DIGEST_SCOPE_MISMATCH');
    }

    const installed = own(capabilities, 'installedDshVersion');
    const installedProvided = isRecord(capabilities) &&
      Reflect.ownKeys(capabilities).includes('installedDshVersion');
    if (installedProvided && (typeof installed !== 'string' || !installed.trim())) {
      sink.add('INVALID_CAPABILITIES');
    }
    const versionMatches = installedProvided
      ? installed === PINNED_DSH_VERSION
      : own(capabilities, 'nativeVersionMatches') === true;
    sink.verdict('nativeVersion', versionMatches,
      installedProvided && !versionMatches ? 'NATIVE_VERSION_MISMATCH'
        : (versionMatches ? null : 'NATIVE_VERSION_UNVERIFIED'));

    sink.verdict('readBoundary', own(capabilities, 'readBoundaryVerified') === true,
      'READ_BOUNDARY_UNVERIFIED');
    sink.verdict('requestAttempts', own(capabilities, 'requestAttemptsCovered') === true,
      'REQUEST_ATTEMPTS_UNVERIFIED');
    sink.verdict('stop', own(capabilities, 'stopVerified') === true, 'STOP_UNVERIFIED');

    const hostAuthorization = record(own(capabilities, 'authorization'), authorizationFields);
    const manifestAuthorizationValue = own(manifest, 'authorization');
    const manifestAuthorization = manifestAuthorizationValue === undefined ? null
      : record(manifestAuthorizationValue, authorizationFields);
    if (manifestAuthorizationValue !== undefined && manifestAuthorization === null) {
      sink.add('INVALID_MANIFEST');
    }
    const hostAuthorizationValid = hostAuthorization !== null &&
      typeof hostAuthorization.reference === 'string' && hostAuthorization.reference.trim() &&
      isDigest(hostAuthorization.scopeDigest);
    if (own(capabilities, 'authorizationVerified') === true && hostAuthorization !== null &&
      !hostAuthorizationValid) sink.add('INVALID_CAPABILITIES');
    const authorizationOk = own(capabilities, 'authorizationVerified') === true &&
      hostAuthorizationValid && manifestAuthorization !== null;
    sink.verdict('authorization', authorizationOk, 'AUTHORIZATION_MISSING');
    if (authorizationOk) {
      if (manifestAuthorization.scopeDigest !== hostAuthorization.scopeDigest) {
        sink.verdict('authorization', false, 'AUTHORIZATION_SCOPE_MISMATCH');
      } else if (manifestAuthorization.reference !== hostAuthorization.reference) {
        sink.verdict('authorization', false, 'AUTHORIZATION_REFERENCE_MISMATCH');
      }
    }

    const budget = record(own(manifest, 'budget'), limitFields);
    const budgetValid = budget !== null &&
      limitFields.every(key => Number.isSafeInteger(budget[key]) && budget[key] > 0);
    sink.verdict('budget', budgetValid, budget === null ? 'BUDGET_MISSING' : 'BUDGET_INVALID');

    const materials = checkFiles(manifest, capabilities, budgetValid ? budget : null, sink, skillArmed);

    const expectedTools = toolScopeFor({ armed: skillArmed });
    const declaredTools = own(manifest, 'toolNames');
    const approvedTools = own(capabilities, 'approvedToolNames');
    const toolProblems = [];
    if (!Array.isArray(declaredTools)) toolProblems.push('TOOLS_UNVERIFIED');
    else if (declaredTools.length > maxDeclaredTools) toolProblems.push('TOOL_SCOPE_MISMATCH');
    else {
      if (new Set(declaredTools).size !== declaredTools.length) {
        toolProblems.push(`TOOL_DUPLICATE: ${declaredTools.find((name, index) => declaredTools.indexOf(name) !== index)}`);
      }
      for (const name of declaredTools) {
        if (!expectedTools.includes(name)) toolProblems.push(`TOOL_NOT_ALLOWED: ${String(name)}`);
      }
      for (const name of expectedTools) {
        if (!declaredTools.includes(name)) toolProblems.push(`TOOL_MISSING: ${name}`);
      }
      if (!Array.isArray(approvedTools) || approvedTools.length !== expectedTools.length ||
        new Set(approvedTools).size !== approvedTools.length ||
        expectedTools.some(name => !approvedTools.includes(name))) {
        toolProblems.push('TOOL_SCOPE_MISMATCH');
      }
    }
    sink.verdict('tools', toolProblems.length === 0, toolProblems[0]);
    toolProblems.slice(1).forEach(problem => sink.add(problem));

    const selection = record(own(manifest, 'modelSelection'), modelFields);
    const approvedModel = record(own(capabilities, 'approvedModel'), modelFields);
    const selectionValid = selection !== null &&
      typeof selection.provider === 'string' && selection.provider.trim() &&
      typeof selection.model === 'string' && selection.model.trim();
    const approvedModelValid = approvedModel !== null &&
      typeof approvedModel.provider === 'string' && approvedModel.provider.trim() &&
      typeof approvedModel.model === 'string' && approvedModel.model.trim();
    if (approvedModel !== null && !approvedModelValid) sink.add('INVALID_CAPABILITIES');
    const modelOk = selectionValid && approvedModelValid &&
      selection.provider === approvedModel.provider && selection.model === approvedModel.model;
    sink.verdict('model', modelOk,
      selection === null ? 'MODEL_MISSING' : (selectionValid ? 'MODEL_NOT_APPROVED' : 'MODEL_INVALID'));

    const environmentOk = binding !== null &&
      own(capabilities, 'approvedEnvironmentDigest') === binding.environmentDigest;
    sink.verdict('environment', environmentOk, 'ENVIRONMENT_MISMATCH');

    sink.verdict('nativeSession', own(capabilities, 'nativeSessionVerified') === true,
      'NATIVE_SESSION_UNVERIFIED');

    const orderedChecks = [];
    for (const id of checkIds) {
      const matches = sink.checks.filter(check => check.id === id);
      orderedChecks.push(matches.length > 0 ? matches[matches.length - 1]
        : freeze({ id, ok: false, detail: null }));
    }

    const preview = freeze({
      materials: materials.map(material => ({ fileId: material.fileId, sha256: material.sha256,
        bytes: material.bytes ?? material.maxBytes })),
      model: selectionValid ? { provider: selection.provider, model: selection.model } : null,
      tools: Array.isArray(declaredTools) ? [...declaredTools] : [],
      limits: budgetValid ? Object.fromEntries(limitFields.map(key => [key, budget[key]])) : null,
      deadlines: budgetValid
        ? { batchDeadlineMs: budget.batchDeadlineMs, attemptTimeoutMs: budget.attemptTimeoutMs }
        : null,
    });

    return freeze({
      status: sink.blockers.length === 0 ? 'ready' : 'blocked',
      checks: orderedChecks,
      blockers: sink.blockers,
      preview,
    });
  } catch {
    return freeze({ status: 'blocked', checks: [], blockers: ['PREFLIGHT_ERROR'], preview: null });
  }
}

const usage = [
  'Usage: node skill-lifecycle/control/preflight.mjs --manifest <manifest.json> [--capabilities <capabilities.json>]',
  '',
  'Prints one JSON object to stdout: { status, checks, blockers, preview }.',
  'Exit codes: 0 ready, 3 blocked, 2 usage error.',
  'The command never creates a session, sends a request or executes a task.',
].join('\n');

async function readJson(path) {
  try {
    return { value: JSON.parse(await readFile(path, 'utf8')) };
  } catch {
    return { error: true };
  }
}

async function main(argv) {
  const known = ['--manifest', '--capabilities'];
  const unknown = argv.filter((token, index) => index % 2 === 0 && !known.includes(token));
  if (argv.length === 0 || unknown.length > 0 || !argv.includes('--manifest') ||
    argv.length % 2 !== 0) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }
  const manifestPath = argv[argv.indexOf('--manifest') + 1];
  const manifestRead = await readJson(manifestPath);
  if (manifestRead.error) {
    process.stdout.write(`${JSON.stringify({ status: 'blocked', blockers: ['MANIFEST_UNREADABLE'],
      checks: [], preview: null })}\n`);
    return 3;
  }
  const capabilitiesIndex = argv.indexOf('--capabilities');
  if (capabilitiesIndex === -1) {
    process.stdout.write(`${JSON.stringify({ status: 'blocked', blockers: ['CAPABILITIES_MISSING'],
      checks: [], preview: null })}\n`);
    return 3;
  }
  const capabilitiesRead = await readJson(argv[capabilitiesIndex + 1]);
  if (capabilitiesRead.error) {
    process.stdout.write(`${JSON.stringify({ status: 'blocked', blockers: ['CAPABILITIES_UNREADABLE'],
      checks: [], preview: null })}\n`);
    return 3;
  }
  const result = await preflight({ manifest: manifestRead.value, capabilities: capabilitiesRead.value });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.status === 'ready' ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
