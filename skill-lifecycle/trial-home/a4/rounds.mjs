import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { judgeRound, collectObservations } from '../../control/iteration-loop.mjs';

const A4_HOME = join(import.meta.dirname);

const usage = [
  'Usage: node skill-lifecycle/trial-home/a4/rounds.mjs <evidence-dir> --round <n> [--criteria <file>] [--write]',
  '',
  'Reads W2-shaped task records, applies the pre-registered gate tokens from a4/manifest.json,',
  'prints one verdict JSON and (with --write) stores it under <evidence-dir>/rounds/round-<n>.json.',
].join('\n');

export const defaultCriteria = Object.freeze({
  targetTaskId: 't7-near-neighbor',
  targetHitsRequired: 2,
  targetRepeatsExpected: 3,
  regressionTaskIds: ['t2-recompute', 't6-boundary'],
  costTolerance: { attemptsRatio: 1.5, tokensRatio: 1.5 },
  maxRounds: 3,
});

export async function decideFrom(dir, { round, criteria = defaultCriteria } = {}) {
  const manifest = JSON.parse(await readFile(join(A4_HOME, 'manifest.json'), 'utf8'));
  const gateTokens = Object.fromEntries(manifest.tasks
    .filter(task => task.evidenceTokens)
    .map(task => [task.taskId, task.evidenceTokens]));
  const names = (await readdir(dir)).filter(name => name.endsWith('.json') &&
    !name.startsWith('batch-') && name !== 'judge-report.json');
  const records = [];
  for (const name of names) {
    const parsed = JSON.parse(await readFile(join(dir, name), 'utf8'));
    if (parsed.record_type === 'w2_ab_task' || parsed.record_type === 'terminal_task') records.push(parsed);
  }
  const observations = collectObservations(records, { gateTokens });
  const verdict = judgeRound({ round, observations, criteria });
  return { verdict, observations };
}

export async function writeRound(dir, verdict) {
  const target = join(dir, 'rounds');
  await mkdir(target, { recursive: true });
  const path = join(target, `round-${verdict.metrics.round}.json`);
  await writeFile(path, `${JSON.stringify({ record_type: 'iteration_round',
    decidedAt: new Date().toISOString(), ...verdict }, null, 2)}\n`);
  return path;
}

async function main(argv) {
  const dir = argv[0];
  const roundIndex = argv.indexOf('--round');
  const criteriaIndex = argv.indexOf('--criteria');
  if (!dir || roundIndex === -1 || argv.length < 3) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }
  const round = Number(argv[roundIndex + 1]);
  const criteria = criteriaIndex === -1
    ? defaultCriteria
    : JSON.parse(await readFile(argv[criteriaIndex + 1], 'utf8'));
  const { verdict, observations } = await decideFrom(dir, { round, criteria });
  const summary = { round, kind: verdict.kind, reasons: verdict.reasons, metrics: verdict.metrics,
    observations: observations.length, inputsDigest: verdict.inputsDigest };
  if (argv.includes('--write')) summary.written = await writeRound(dir, verdict);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return verdict.kind === 'accept' ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
