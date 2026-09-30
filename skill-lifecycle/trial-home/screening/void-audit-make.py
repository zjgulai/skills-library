#!/usr/bin/env python3
"""void 审计与入账生成器（零请求）。

背景（113 号复盘 §3.3-3 待拍板项，用户已确认）：
- 运行器把每次 live 尝试的证据写进 `evidence-r<k>/`（好读数）或 `evidence-r<k>-void<N>/`（void）；
  每条证据内嵌该次尝试的 `ledger`（attempts/tokens），**void 与未覆盖读数的消耗只存在于证据内**。
- `runs-r<k>/armed-*/batch/budget-ledger.json` 只覆盖带 run 目录的读法，void 不在其中 ⇒ 账目缺口。

本工具只报**磁盘事实**：每条 live 证据（内嵌账本口径）＋与磁盘账本的对照＋异常清单。
登记裁决（每条 void 的归因、估算与追认）由人在 register 的 notes 里写。

用法：python3 -B void-audit-make.py [--root <opt-run 目录>] [--from <轮>] [--to <轮>] [--out <json>]
"""
import argparse
import json
import re
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--root', default=str(Path(__file__).resolve().parents[1] / 'opt-run'))
parser.add_argument('--from', dest='rfrom', type=int, default=0)
parser.add_argument('--to', dest='rto', type=int, default=10**9)
parser.add_argument('--out', default=None)
args = parser.parse_args()

root = Path(args.root)


def tok(d):
    if not isinstance(d, dict):
        return 0
    return ((d.get('observedInputTokens', 0) or 0) + (d.get('observedOutputTokens', 0) or 0)
            + (d.get('observedCacheReadTokens', 0) or 0) + (d.get('observedCacheWriteTokens', 0) or 0))


ANCHORS = ('综合加权得分', '综合得分', '加权总分', '综合总分', '总分')


def score_of(report):
    """启发式分数提取：按短语锚定（综合加权得分/综合得分/加权总分/综合总分）
    取其后 80 字符内的**首个**分数（N 或 N.N，排除百分比）。
    本字段仅供审计索引；计分正则已知易错（opt-loop 前例），裁读一律回报告正文。"""
    if not report:
        return None
    for anchor in ANCHORS:
        i = report.find(anchor)
        if i == -1:
            continue
        window = report[i + len(anchor): i + len(anchor) + 80]
        for m in re.finditer(r'([0-9]{1,3}(?:\.[0-9]+)?)', window):
            after = window[m.end():m.end() + 1]
            if after == '%':
                continue
            try:
                n = float(m.group(1))
            except ValueError:
                continue
            if 40 <= n <= 100:
                return m.group(1)
    return None


def iter_evidence_dirs():
    for d in sorted(root.glob('evidence-r*')):
        if not d.is_dir():
            continue
        m = re.fullmatch(r'evidence-r(\d+)(-void(\d+))?', d.name)
        if not m:
            continue
        rnd = int(m.group(1))
        if not (args.rfrom <= rnd <= args.rto):
            continue
        yield rnd, (int(m.group(3)) if m.group(3) else None), d


def iter_disk_ledgers():
    for f in sorted(root.glob('runs-r*/armed-*/batch/budget-ledger.json')):
        stem = f.parts[-3]                      # runs-r191/armed-o191-…-r1/batch/budget-ledger.json
        m = re.search(r'armed-o(\d+)', stem)
        rnd = int(m.group(1)) if m else None
        if rnd is not None and not (args.rfrom <= rnd <= args.rto):
            continue
        d = json.loads(f.read_text(encoding='utf-8'))
        yield rnd, stem, {'attempts': d.get('attemptsSettled'), 'tokens': tok(d), 'file': str(f)}


disk = {}
for rnd, stem, info in iter_disk_ledgers():
    disk[(rnd, stem)] = info

rounds = {}
for rnd, voidn, d in iter_evidence_dirs():
    for f in sorted(d.glob('armed-*.json')):
        try:
            rec = json.loads(f.read_text(encoding='utf-8'))
        except json.JSONDecodeError:
            continue
        if rec.get('mode') != 'live':
            continue
        rep = rec.get('report') or ''
        has_report = (rec.get('reportChars') or 0) > 0 or (rec.get('replyChars') or 0) > 0
        emb = rec.get('ledger') or {}
        stem = f.stem
        entry = {
            'round': rnd, 'dirKind': 'void' if voidn else 'main', 'voidIndex': voidn,
            'file': str(f.relative_to(root)),
            'runId': rec.get('runId'),
            'report': has_report, 'score': score_of(rep),
            'embeddedAttempts': emb.get('attemptsSettled') if isinstance(emb, dict) else None,
            'embeddedTokens': tok(emb),
        }
        info = disk.get((rnd, stem))
        entry['diskLedger'] = info
        entry['anomalies'] = []
        if voidn is None and not has_report:
            entry['anomalies'].append('void-in-main-dir')
        if voidn is not None and has_report:
            entry['anomalies'].append('report-in-void-dir')
        if has_report and info is None:
            entry['anomalies'].append('reading-uncovered-by-runs-ledger')
        # void 目录里的尝试与"同 stem 的成功 run"本就不同次（运行器 reset 各自账本），
        # 只对主目录读数做内嵌/磁盘一致性校验，void 的消耗以 embedded 为准。
        if voidn is None and info is not None and entry['embeddedTokens'] and info['tokens']:
            delta = abs(entry['embeddedTokens'] - info['tokens']) / max(info['tokens'], 1)
            if delta > 0.02:
                entry['anomalies'].append(f'ledger-mismatch({entry["embeddedTokens"]} vs {info["tokens"]})')
        rounds.setdefault(rnd, []).append(entry)

# —— 汇总 ——
summary = {
    'readings': {'count': 0, 'tokens': 0},
    'voids': {'count': 0, 'tokens': 0},
    'uncoveredReadings': {'count': 0, 'tokens': 0},
}
anomalies = []
for rnd in sorted(rounds):
    for e in rounds[rnd]:
        if e['report']:
            summary['readings']['count'] += 1
            summary['readings']['tokens'] += e['embeddedTokens']
            if e['diskLedger'] is None:
                summary['uncoveredReadings']['count'] += 1
                summary['uncoveredReadings']['tokens'] += e['embeddedTokens']
        else:
            summary['voids']['count'] += 1
            summary['voids']['tokens'] += e['embeddedTokens']
        for a in e['anomalies']:
            anomalies.append({'round': rnd, 'file': e['file'], 'anomaly': a})

register = {
    'record_type': 'void-and-coverage-register',
    'scope': f'r{args.rfrom}-r{args.rto}',
    'method': '每条 live 证据取内嵌 ledger 的 attempts/tokens；与磁盘 runs-r*/batch/budget-ledger.json 按 (轮, stem) 对照；'
              'void＝无报告；登记裁决由人写 notes。',
    'summary': summary,
    'anomalies': anomalies,
    'rounds': {str(rnd): rounds[rnd] for rnd in sorted(rounds)},
}

print(json.dumps({'summary': summary, 'anomalyCount': len(anomalies)}, ensure_ascii=False, indent=1))
for a in anomalies[:40]:
    print(' !', a['round'], a['file'], '→', a['anomaly'])

if args.out:
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(register, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print('register written:', out)
