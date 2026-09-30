import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tool = join(repoRoot, 'skill-lifecycle', 'trial-home', 'screening', 'void-audit-make.py');

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function evidence({ runId, report = true, tokens = 0, attempts = 1, mode = 'live' }) {
  return {
    record_type: 'probe_b_task', taskId: 'o100-evaluate-target', arm: 'armed', mode,
    runId, reportChars: report ? 120 : 0, replyChars: report ? 80 : 0,
    report: report ? '综合得分：90 分。' : '',
    ledger: { attemptsSettled: attempts, observedInputTokens: tokens },
  };
}

test('void-audit: readings/voids/uncovered 分类与异常（夹具）', () => {
  const root = mkdtempSync(join(tmpdir(), 'void-audit-'));
  try {
    // 覆盖读数（有磁盘账本，数字一致）
    writeJson(join(root, 'evidence-r100/armed-o100-evaluate-target-r1.json'),
      evidence({ runId: 'run-pb-armed-o100-evaluate-target-r1-x', report: true, tokens: 1000, attempts: 3 }));
    writeJson(join(root, 'runs-r100/armed-o100-evaluate-target-r1/batch/budget-ledger.json'),
      { attemptsSettled: 3, observedInputTokens: 1000 });
    // 未覆盖读数（无 run 目录）
    writeJson(join(root, 'evidence-r100/armed-o100-evaluate-target-r2.json'),
      evidence({ runId: 'run-pb-armed-o100-evaluate-target-r2-x', report: true, tokens: 300, attempts: 2 }));
    // void（void 目录）
    writeJson(join(root, 'evidence-r100-void1/armed-o100-evaluate-target-r1.json'),
      evidence({ runId: 'run-pb-armed-o100-evaluate-target-r1-x', report: false, tokens: 500, attempts: 2 }));
    // 非 live 记录必须被过滤
    writeJson(join(root, 'evidence-r100/armed-o100-evaluate-target-r9.json'),
      evidence({ runId: 'run-pb-armed-o100-evaluate-target-r9-x', report: true, tokens: 99999, mode: 'capture' }));
    // 主目录里的 void（异常）
    writeJson(join(root, 'evidence-r101/armed-o101-evaluate-target-r1.json'),
      evidence({ runId: 'run-pb-armed-o101-evaluate-target-r1-x', report: false, tokens: 700, attempts: 4 }));

    const out = join(root, 'register.json');
    execFileSync('python3', ['-B', tool, '--root', root, '--from', '100', '--to', '101', '--out', out]);
    const reg = JSON.parse(readFileSync(out, 'utf8'));

    assert.equal(reg.summary.readings.count, 2, '两条 live 读数（capture 被过滤）');
    assert.equal(reg.summary.readings.tokens, 1300);
    assert.equal(reg.summary.voids.count, 2);
    assert.equal(reg.summary.voids.tokens, 1200);
    assert.equal(reg.summary.uncoveredReadings.count, 1);
    assert.equal(reg.summary.uncoveredReadings.tokens, 300);
    const flat = reg.anomalies.map(a => a.anomaly);
    assert.ok(flat.includes('reading-uncovered-by-runs-ledger'), '未覆盖读数被点名');
    assert.ok(flat.includes('void-in-main-dir'), '主目录 void 被点名');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('void-audit: 内嵌与磁盘账本不一致时判红', () => {
  const root = mkdtempSync(join(tmpdir(), 'void-audit-'));
  try {
    writeJson(join(root, 'evidence-r102/armed-o102-evaluate-target-r1.json'),
      evidence({ runId: 'run-pb-armed-o102-evaluate-target-r1-x', report: true, tokens: 5000, attempts: 3 }));
    writeJson(join(root, 'runs-r102/armed-o102-evaluate-target-r1/batch/budget-ledger.json'),
      { attemptsSettled: 3, observedInputTokens: 1000 });

    const out = join(root, 'register.json');
    execFileSync('python3', ['-B', tool, '--root', root, '--from', '102', '--to', '102', '--out', out]);
    const reg = JSON.parse(readFileSync(out, 'utf8'));
    assert.ok(reg.anomalies.some(a => a.anomaly.startsWith('ledger-mismatch')), '不一致必须报出');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
