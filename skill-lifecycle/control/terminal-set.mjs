import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { normaliseArms } from './arm-scope.mjs';

const judgeRole = 'judge';
const fileFields = ['name', 'content'];

function failure(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function safeName(name) {
  if (typeof name !== 'string' || !name.trim() || name.includes('/') || name.includes('\\') ||
    name.startsWith('.')) throw failure('INVALID_TASK_FILE');
  return name;
}

function validateTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw failure('INVALID_TASKS');
  return tasks.map(task => {
    if (!isRecord(task) || typeof task.taskId !== 'string' || !task.taskId.trim() ||
      typeof task.request !== 'string' || !task.request.trim() ||
      !Array.isArray(task.files) || task.files.length === 0 ||
      !Array.isArray(task.answers) || task.answers.length === 0 ||
      task.answers.some(answer => typeof answer !== 'string' || !answer.trim())) {
      throw failure('INVALID_TASKS');
    }
    if (task.expectsReport !== undefined && typeof task.expectsReport !== 'boolean') {
      throw failure('INVALID_TASKS');
    }
    const files = task.files.map(file => {
      if (!isRecord(file) || Reflect.ownKeys(file).length !== fileFields.length ||
        !Object.hasOwn(file, 'name') || !Object.hasOwn(file, 'content') ||
        typeof file.content !== 'string') throw failure('INVALID_TASK_FILE');
      return freeze({ name: safeName(file.name), content: file.content });
    });
    const names = new Set(files.map(file => file.name));
    if (names.size !== files.length) throw failure('INVALID_TASK_FILE');
    return freeze({ taskId: task.taskId, expectsReport: task.expectsReport !== false,
      request: task.request, files, answers: [...task.answers] });
  });
}

async function mustBeDirectory(path, code) {
  let stat_;
  try {
    stat_ = lstatSync(path);
  } catch (error) {
    throw failure(code, error);
  }
  if (!stat_.isDirectory() || stat_.isSymbolicLink()) throw failure(code);
  return path;
}

function within(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

/** The runner must never be handed a root that contains (or equals) the custodian root. */
export function assertRootsDisjoint({ custodianRoot, roots = [] } = {}) {
  if (typeof custodianRoot !== 'string' || !custodianRoot.trim()) throw failure('INVALID_ROOT_SET');
  if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string' || !root.trim())) {
    throw failure('INVALID_ROOT_SET');
  }
  const custodian = resolve(custodianRoot);
  const overlapping = roots.filter(root => within(custodian, resolve(root)) || within(resolve(root), custodian));
  if (overlapping.length > 0) throw failure(`OVERLAPPING_ROOTS: ${overlapping.join(',')}`);
  return freeze({ custodianRoot: custodian, roots: roots.map(root => resolve(root)) });
}

export async function sealTerminalSet({ root, setId, tasks, arms, now = Date.now } = {}) {
  if (typeof root !== 'string' || !root.trim()) throw failure('INVALID_TERMINAL_ROOT');
  if (typeof setId !== 'string' || !/^[a-z0-9][a-z0-9-]{1,31}$/.test(setId)) throw failure('INVALID_SET_ID');
  const validated = validateTasks(tasks);
  const armPolicy = normaliseArms(arms);
  await mustBeDirectory(root, 'INVALID_TERMINAL_ROOT');
  const setRoot = join(root, setId);
  try {
    lstatSync(setRoot);
    throw failure('SET_EXISTS');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const dispatchRoot = join(setRoot, 'dispatch');
  const custodianRoot = join(setRoot, 'custodian');
  await mkdir(custodianRoot, { recursive: true });
  const manifest = { setId, sealedAt: now(), arms: [...armPolicy], tasks: [] };
  for (const task of validated) {
    const taskRoot = join(dispatchRoot, task.taskId);
    await mkdir(taskRoot, { recursive: true });
    await writeFile(join(taskRoot, 'request.txt'), `${task.request}\n`);
    const files = [];
    for (const file of task.files) {
      await writeFile(join(taskRoot, file.name), file.content);
      files.push({ name: file.name, sha256: sha256(file.content), bytes: Buffer.byteLength(file.content, 'utf8') });
    }
    manifest.tasks.push({ taskId: task.taskId, expectsReport: task.expectsReport !== false, files,
      requestDigest: sha256(`${task.request}\n`), answersDigest: sha256(JSON.stringify(task.answers)) });
  }
  await writeFile(join(custodianRoot, 'answers.json'),
    `${JSON.stringify({ setId, answers: validated.map(task => ({ taskId: task.taskId, answers: task.answers })) }, null, 2)}\n`);
  await writeFile(join(setRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return freeze({ setId, setRoot, dispatchRoot, custodianRoot, taskIds: validated.map(task => task.taskId) });
}

export async function openTerminalSet({ root, setId } = {}) {
  await mustBeDirectory(root, 'INVALID_TERMINAL_ROOT');
  const setRoot = join(root, setId);
  await mustBeDirectory(setRoot, 'UNKNOWN_SET');
  const manifest = JSON.parse(await readFile(join(setRoot, 'manifest.json'), 'utf8'));
  const dispatchRoot = join(setRoot, 'dispatch');
  const custodianRoot = join(setRoot, 'custodian');
  return freeze({
    setId,
    setRoot,
    dispatchRoot,
    custodianRoot,
    arms: normaliseArms(manifest.arms),
    taskIds: manifest.tasks.map(task => task.taskId),
    expectsReport: taskId => manifest.tasks.find(task => task.taskId === taskId)?.expectsReport !== false,
    manifest,
    /** Copy only this task's declared inputs into the run workspace; answers stay behind. */
    async copyInto({ taskId, runRoot }) {
      const task = manifest.tasks.find(candidate => candidate.taskId === taskId);
      if (task === undefined) throw failure('UNKNOWN_TASK');
      const inputs = join(runRoot, 'inputs');
      await mkdir(inputs, { recursive: true });
      const receipts = [];
      for (const file of task.files) {
        const source = join(dispatchRoot, taskId, file.name);
        const content = await readFile(source, 'utf8');
        if (sha256(content) !== file.sha256) throw failure(`INPUT_IDENTITY_CHANGED: ${file.name}`);
        await writeFile(join(inputs, file.name), content);
        receipts.push({ name: file.name, sha256: file.sha256, bytes: file.bytes });
      }
      const request = await readFile(join(dispatchRoot, taskId, 'request.txt'), 'utf8');
      if (sha256(request) !== task.requestDigest) throw failure('REQUEST_IDENTITY_CHANGED');
      const answerText = await readFile(join(custodianRoot, 'answers.json'), 'utf8');
      if (answerText.includes(String(receipts[0]?.sha256 ?? 'impossible'))) {
        throw failure('CUSTODY_LEAK');
      }
      return freeze({ taskId, request: request.trimEnd(), inputs: receipts });
    },
  });
}

export async function reveal({ root, setId, taskId, actor, reason, now = Date.now } = {}) {
  if (actor !== judgeRole) throw failure('ANSWER_ACCESS_DENIED');
  if (typeof reason !== 'string' || !reason.trim()) throw failure('INVALID_REASON');
  const set = await openTerminalSet({ root, setId });
  if (!set.taskIds.includes(taskId)) throw failure('UNKNOWN_TASK');
  const payload = JSON.parse(await readFile(join(set.custodianRoot, 'answers.json'), 'utf8'));
  const record = payload.answers.find(entry => entry.taskId === taskId);
  await appendFile(join(set.custodianRoot, 'reveals.jsonl'),
    `${JSON.stringify({ revealedAt: now(), actor, reason, taskId })}\n`);
  return freeze({ taskId, answers: record.answers });
}

export async function assertFresh({ root, setId, taskIds } = {}) {
  const set = await openTerminalSet({ root, setId });
  let lines = [];
  try {
    lines = (await readFile(join(set.custodianRoot, 'reveals.jsonl'), 'utf8')).trim().split('\n')
      .filter(line => line.length > 0).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const burned = lines.map(line => line.taskId)
    .filter(id => (Array.isArray(taskIds) && taskIds.length > 0 ? taskIds : set.taskIds).includes(id));
  const unique = [...new Set(burned)];
  if (unique.length > 0) {
    const error = failure('TASK_BURNED');
    error.message = `TASK_BURNED: ${unique.join(',')}`;
    error.taskIds = unique;
    throw error;
  }
  return freeze({ fresh: true, taskIds: set.taskIds });
}

export async function scanForLeaks({ root, setId, tokens } = {}) {
  const set = await openTerminalSet({ root, setId });
  let scanTokens = tokens;
  if (scanTokens === undefined) {
    const payload = JSON.parse(await readFile(join(set.custodianRoot, 'answers.json'), 'utf8'));
    scanTokens = payload.answers.flatMap(entry => entry.answers);
  }
  if (!Array.isArray(scanTokens) || scanTokens.length === 0 ||
    scanTokens.some(token => typeof token !== 'string' || !token.trim())) throw failure('INVALID_TOKENS');
  const tokens_ = scanTokens;
  const findings = [];
  for (const taskId of set.taskIds) {
    const taskRoot = join(set.dispatchRoot, taskId);
    for (const name of await readdir(taskRoot)) {
      const content = await readFile(join(taskRoot, name), 'utf8');
      for (const token of tokens_) {
        if (content.includes(token)) findings.push({ taskId, file: name, token });
      }
    }
  }
  return freeze({ clean: findings.length === 0, findings });
}
