import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const A4_HOME = join(import.meta.dirname);
const normalize = text => String(text ?? '').replace(/[,，\s\u200b-\u200f\ufeff]/g, '');

function evaluateEvidence(rule, haystack) {
  const tokens = rule.tokens.filter(token => haystack.includes(normalize(token)));
  const required = Number(rule.rule.split(':')[1] ?? 1);
  return { tokens: rule.tokens, matched: tokens, required, ok: tokens.length >= required };
}

export async function judgeRecord(record, task) {
  const produced = `${record.final_text ?? ''}\n${record.report?.content ?? ''}`;
  const haystack = normalize(produced);
  const evidence = evaluateEvidence({ tokens: task.evidenceTokens, rule: task.evidenceRule }, haystack);
  const skillEvidence = Object.hasOwn(record, 'skill_loaded')
    ? record.skill_loaded === true
    : record.skill_read === true;
  const checks = {
    skill_read: skillEvidence,
    report_written: task.expectsReport ? record.report?.written === true : true,
    evidence_gate: evidence.ok,
    within_attempt_cap: record.attempts.settled + record.attempts.unknown <= record.attempts.max_attempts,
    no_unexpected_denial: !(record.denials ?? []).some(entry =>
      entry.kind === 'tool_denied' || (entry.kind === 'request_denied' && entry.reason !== 'ATTEMPTS_EXHAUSTED')),
    attempts_accounted: record.attempts.reserved === record.attempts.settled + record.attempts.unknown,
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return {
    task_id: record.task_id, arm: record.arm ?? null, category: task.category, outcome: record.outcome,
    incomplete: record.incomplete, incomplete_reason: record.incomplete_reason,
    mechanical: { checks, passed: failed.length === 0, failed },
    evidence: { matched: evidence.matched, required: evidence.required },
    attempts: record.attempts, group: record.group,
    report_bytes: record.report?.bytes ?? 0, report_sha256: record.report?.sha256 ?? null,
    tool_calls: (record.tool_calls ?? []).map(call => `${call.tool}${call.fileId ? `(${call.fileId})` : ''}${call.ok ? '' : '!'}`),
    finish_kinds: record.finish_kinds, wall_ms: record.wall_ms,
    semantic: { status: 'pending-manual', note: '按 a4-A4任务集与判定口径.md 第 3 节由主代理逐题判定' },
  };
}

async function main(argv) {
  const dir = argv[0];
  if (!dir) {
    process.stderr.write('Usage: node trial-home/a4/judge.mjs <record-dir>\n');
    return 2;
  }
  const manifest = JSON.parse(await readFile(join(A4_HOME, 'manifest.json'), 'utf8'));
  const byId = new Map(manifest.tasks.map(task => [task.taskId, task]));
  const files = (await readdir(dir)).filter(name => name.endsWith('.json') && name !== 'batch.json'
    && name !== 'judge-report.json');
  const judged = [];
  for (const name of files.sort()) {
    const record = JSON.parse(await readFile(join(dir, name), 'utf8'));
    const task = byId.get(record.task_id);
    if (!task) continue;
    judged.push(await judgeRecord(record, task));
  }
  const report = {
    record_dir: dir, judged_at: new Date().toISOString(),
    totals: {
      tasks: judged.length,
      mechanical_pass: judged.filter(item => item.mechanical.passed).length,
      incomplete: judged.filter(item => item.incomplete).length,
      settled: judged.reduce((sum, item) => sum + item.attempts.settled, 0),
      observed_tokens: judged.reduce((sum, item) =>
        sum + item.attempts.observed_input_tokens + item.attempts.observed_output_tokens, 0),
    },
    tasks: judged,
  };
  await writeFile(join(dir, 'judge-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report.totals)}\n`);
  for (const item of judged) {
    process.stdout.write(`${item.arm ? item.arm + '/' : ''}${item.task_id}: mechanical=${item.mechanical.passed ? 'pass' : `fail(${item.mechanical.failed.join(',')})`} `
      + `incomplete=${item.incomplete} attempts=${item.attempts.settled} evidence=${item.evidence.matched.length}/${item.evidence.required}\n`);
  }
  return judged.every(item => item.mechanical.passed) ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
