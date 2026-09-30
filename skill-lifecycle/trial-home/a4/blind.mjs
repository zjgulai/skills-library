import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPacket, writePacket, scorePacket, unblind, calibrate, certifyRound, leaks } from '../../control/blind-packet.mjs';
import { judgeRound } from '../../control/iteration-loop.mjs';
import { defaultCriteria } from './rounds.mjs';

const A4_HOME = join(import.meta.dirname);

const usage = [
  'Usage:',
  '  node skill-lifecycle/trial-home/a4/blind.mjs prepare <evidence-dir> --out <packet-dir> --seed <seed> [--tasks a,b] [--terminal w01]',
  '  node skill-lifecycle/trial-home/a4/blind.mjs score <evidence-dir> --packet <packet-dir> --verdicts <file> --round <n> [--criteria <file>] [--write]',
  '',
  'prepare: writes <packet-dir>/packet.json (judge-facing, identity-free) and <packet-dir>/keys/<id>.key.json (arm mapping).',
  'score:   validates the judge output, unblinds it, runs the iteration controller and (with --write) stores the round verdict.',
].join('\n');

async function loadRecords(dir) {
  const names = (await readdir(dir)).filter(name => name.endsWith('.json') &&
    !name.startsWith('batch-') && name !== 'judge-report.json');
  const records = [];
  for (const name of names) {
    const parsed = JSON.parse(await readFile(join(dir, name), 'utf8'));
    if (parsed.record_type === 'w2_ab_task' || parsed.record_type === 'terminal_task') records.push(parsed);
  }
  return records;
}

async function loadProbes() {
  return JSON.parse(await readFile(join(A4_HOME, 'judge-probes.json'), 'utf8'));
}

async function loadTasks({ terminal = null } = {}) {
  const criteria = JSON.parse(await readFile(join(A4_HOME, 'blind-criteria.json'), 'utf8'));
  if (terminal !== null) {
    const dispatch = join(import.meta.dirname, '..', 'terminal', terminal, 'dispatch');
    const taskIds = await readdir(dispatch);
    return taskIds.map(taskId => ({ taskId,
      request: readFile(join(dispatch, taskId, 'request.txt'), 'utf8'),
      criteria: criteria[taskId] })).filter(task => typeof task.criteria === 'string');
  }
  const manifest = JSON.parse(await readFile(join(A4_HOME, 'manifest.json'), 'utf8'));
  return manifest.tasks.map(task => ({ taskId: task.taskId, request: task.request,
    criteria: criteria[task.taskId] })).filter(task => typeof task.criteria === 'string');
}

async function resolveTasks({ terminal = null } = {}) {
  const tasks = await loadTasks({ terminal });
  return Promise.all(tasks.map(async task => ({ ...task, request: await task.request })));
}

export async function prepare({ evidenceDir, out, seed, tasks: selected, terminal = null }) {
  const allProbes = await loadProbes();
  const tasks = await resolveTasks({ terminal });
  const probeTaskIds = new Set(tasks.map(task => task.taskId));
  const selectedTasks = Array.isArray(selected) && selected.length > 0 ? new Set(selected) : null;
  const probes = allProbes.filter(probe => probeTaskIds.has(probe.taskId) &&
    (selectedTasks === null || selectedTasks.has(probe.taskId)));
  const { packet, key } = buildPacket({ records: await loadRecords(evidenceDir),
    tasks, seed, includeTasks: selected, probes });
  await mkdir(out, { recursive: true });
  const written = await writePacket({ root: out, packet, key });
  // 注意：不要拿探针 label 当泄漏 token——它们常是题号的前缀（如 u3-miss 之于 u3-missing），会假报。
  return { ...written, entries: packet.entries.length, slots: key.slots.length,
    probes: key.slots.filter(slot => slot.probe === true).length,
    leaked: leaks(packet, ['candidate', 'original', 't7-boundary-001', '"probe"', 'expectedGate',
      'attempts', 'tokens', 'skill_digest']) };
}

export async function score({ evidenceDir, out, verdictPath, round, write = false, criteria = defaultCriteria }) {
  const payload = JSON.parse(await readFile(join(out, 'packet.json'), 'utf8'));
  const keyName = (await readdir(join(out, 'keys'))).find(name => name.endsWith('.key.json'));
  const key = JSON.parse(await readFile(join(out, 'keys', keyName), 'utf8'));
  const verdicts = JSON.parse(await readFile(verdictPath, 'utf8'));
  const scores = scorePacket({ packet: payload.packet, verdicts });
  let calibration;
  try {
    calibration = calibrate({ key, scores });
  } catch (error) {
    if (error?.code !== 'NO_PROBES') throw error;
    calibration = { verdict: 'uncalibrated', probes: 0, agreements: 0, disagreements: [],
      note: 'PACKET_HAS_NO_PROBES' };
  }
  const records = await loadRecords(evidenceDir);
  const observations = unblind({ key, scores, records });
  const raw = judgeRound({ round, observations, criteria });
  const verdict = certifyRound({ calibration, verdict: raw });
  const summary = { round, kind: verdict.kind, reasons: verdict.reasons, metrics: verdict.metrics,
    certified: verdict.certified, calibration: verdict.judgeCalibration,
    observations: observations.length, inputsDigest: verdict.inputsDigest,
    packetDigest: key.packetDigest, judgeVerdicts: verdicts.length };
  if (write) {
    const target = join(evidenceDir, 'rounds');
    await mkdir(target, { recursive: true });
    // One file per packet: two blind runs of the same round must never overwrite each other.
    const path = join(target, `round-${round}-blind-${key.packetId}.json`);
    try {
      await readFile(path, 'utf8');
      throw new Error(`ROUND_EXISTS: ${path}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await writeFile(path, `${JSON.stringify({ record_type: 'iteration_round_blind',
      decidedAt: new Date().toISOString(), packetId: key.packetId, ...summary, verdict }, null, 2)}\n`);
    summary.written = path;
  }
  return summary;
}

async function main(argv) {
  const [command, evidenceDir] = argv;
  const flag = name => {
    const index = argv.indexOf(name);
    return index === -1 ? null : argv[index + 1];
  };
  if (!command || !evidenceDir) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }
  if (command === 'prepare') {
    const out = flag('--out');
    if (!out) {
      process.stderr.write(`${usage}\n`);
      return 2;
    }
    const result = await prepare({ evidenceDir, out, seed: flag('--seed') ?? 'round-1',
      tasks: flag('--tasks') ? flag('--tasks').split(',').map(item => item.trim()) : null,
      terminal: flag('--terminal') });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.leaked.length === 0 ? 0 : 3;
  }
  if (command === 'score') {
    const out = flag('--packet');
    const verdictPath = flag('--verdicts');
    const round = Number(flag('--round'));
    if (!out || !verdictPath || !Number.isSafeInteger(round)) {
      process.stderr.write(`${usage}\n`);
      return 2;
    }
    const criteriaFlag = flag('--criteria');
    const result = await score({ evidenceDir, out, verdictPath, round, write: argv.includes('--write'),
      criteria: criteriaFlag ? JSON.parse(await readFile(criteriaFlag, 'utf8')) : defaultCriteria });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.kind === 'accept' && result.certified === true ? 0 : 3;
  }
  process.stderr.write(`${usage}\n`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
