#!/usr/bin/env python3
"""近失带试点收口（零请求）：r518–r537 读数提取＋成本汇总。

- 主批 r518–r534（17 件）；v2 重试 r535–r537（social / artifact-presentation / app-store-growth）。
- score/verdict 提取沿用 wave-1 同规则（表行优先→标签→锚定＋门槛句/分母/区间/判词拒绝）。
- 输出：nearmiss-pilot/results.csv ＋ closeout.json
用法：python3 -B make-closeout.py
"""
import csv
import json
import re
from pathlib import Path

BASE = Path(__file__).resolve().parent            # nearmiss-pilot/
OPT = Path('/Users/lute/project/AgentTools/思维库/skill管理/skill-lifecycle/trial-home/opt-run')

ITEMS = [  # (round, name, leg)
    (518, 'codebase-design', 'main'), (519, 'social', 'v1'), (520, 'demand-validation', 'main'),
    (521, 'artifact-presentation', 'v1'), (522, 'app-store-growth', 'v1'),
    (523, 'feynman-perspective', 'main'), (524, 'huashu-flash', 'main'),
    (525, 'booking', 'main'), (526, 'action-figure-of-me', 'main'),
    (527, 'ilya-sutskever-perspective', 'main'), (528, 'mrbeast-perspective', 'main'),
    (529, 'nuwa-andrej-karpathy-perspective', 'main'), (530, 'andrej-karpathy-perspective', 'main'),
    (531, 'taleb-perspective', 'main'), (532, 'huashu-report', 'main'),
    (533, 'paul-graham-perspective', 'main'),
    (534, 'co-marketing', 'main'),
    (535, 'social', 'v2'), (536, 'artifact-presentation', 'v2'), (537, 'app-store-growth', 'v2'),
    (538, 'taleb-perspective', 'v2'), (539, 'paul-graham-perspective', 'v2'),
    (540, 'taleb-perspective', 'v3'),
]

TOTAL_ANCHORS = ('综合加权总分', '加权总分', '综合总分', '综合得分', '总体得分', '评估总分', '总分', '总计')
LABELS = ('综合加权得分', '综合加权总分', '加权总分', '综合总分', '综合得分', '总评分', '六维总分', '总体得分', '评估总分', '最终得分', '总分')
REJECT_BEFORE = ('>=', '≥', '<=', '≤', '>', '<', '达到', '门槛', '及格', '发布线', '以上', '未达', '高于', '低于', '提升', '预期', '预计', '复评', '通过', '基线')
REJECT_AFTER = ('以上', '+', '＋')
VERDICTS = ('可发布', '需优化', '需重构')
VERDICT_KW = ('需优化', '需重构', '可发布', 'needs_')


def file_tokens(d):
    if not isinstance(d, dict):
        return 0
    return sum(d.get(k, 0) or 0 for k in (
        'observedInputTokens', 'observedOutputTokens',
        'observedCacheReadTokens', 'observedCacheWriteTokens'))


def _cell_candidate(c):
    m = re.search(r'([0-9]{1,3}(?:\.[0-9]+)?)', c)
    if not m:
        return None
    after1 = c[m.end():m.end() + 1]
    before = c[:m.start()]
    val = float(m.group(1))
    if after1 == '%' or not (40 <= val <= 100):
        return None
    if before.rstrip().endswith('/'):
        return None
    if re.match(r'^\s*[-~至]\s*[0-9]', c[m.end():m.end() + 4]):
        return None
    if any(rk in before for rk in REJECT_BEFORE):
        return None
    if any(rk in c[m.end():m.end() + 4] for rk in REJECT_AFTER):
        return None
    return m.group(1)


def extract_total_table(report):
    for ln in report.splitlines():
        if '|' not in ln or not any(a in ln for a in TOTAL_ANCHORS):
            continue
        cells = [c.strip() for c in ln.split('|')]
        li = next((i for i, c in enumerate(cells) if any(a in c for a in TOTAL_ANCHORS)), None)
        if li is None:
            continue
        for use_verdict_cells in (False, True):
            cands = []
            for c in cells[li + 1:]:
                if not use_verdict_cells and any(v in c for v in VERDICT_KW):
                    continue
                v = _cell_candidate(c)
                if v is not None:
                    cands.append(v)
            if cands:
                return cands[-1], ln.strip()[:160]
    return None, None


def extract_total_labeled(report):
    for label in LABELS:
        pos = report.find(label)
        while pos != -1:
            window = report[pos + len(label): pos + len(label) + 100]
            for m in re.finditer(r'([0-9]{1,3}(?:\.[0-9]+)?)', window):
                after1 = window[m.end():m.end() + 1]
                before = report[max(0, pos + len(label) + m.start() - 6): pos + len(label) + m.start()]
                after_ctx = window[m.end():m.end() + 4]
                val = float(m.group(1))
                if (after1 != '%' and 40 <= val <= 100 and not before.rstrip().endswith('/')
                        and not re.match(r'^\s*[-~至]\s*[0-9]', after_ctx)
                        and not any(rk in before for rk in REJECT_BEFORE)
                        and not any(rk in after_ctx for rk in REJECT_AFTER)):
                    ctx = report[max(0, pos - 20): pos + len(label) + m.end() + 30].replace('\n', ' ')
                    return m.group(1), ctx
            pos = report.find(label, pos + 1)
    return None, None


def extract_verdict(report):
    def earliest(text):
        best = None
        for v in VERDICTS:
            p = text.find(v)
            if p != -1 and (best is None or p < best[1]):
                best = (v, p)
        return best[0] if best else None
    i = report.find('发布结论')
    while i != -1:
        got = earliest(report[i: i + 80])
        if got:
            return got
        i = report.find('发布结论', i + 1)
    got = earliest(report[:400]) or earliest(report)
    return got


rows = []
for r, name, leg in ITEMS:
    ev = OPT / f'evidence-r{r}'
    rec = None
    if ev.is_dir():
        files = sorted(ev.glob('armed-*.json'))
        for f in files:
            try:
                d = json.loads(f.read_text(encoding='utf-8'))
            except json.JSONDecodeError:
                continue
            if d.get('mode') == 'live':
                rec = d
                break
    if rec is None:
        rows.append({'round': r, 'name': name, 'leg': leg, 'status': 'no-evidence'})
        continue
    rep = rec.get('report') or ''
    led = rec.get('ledger') or {}
    ent = {'round': r, 'name': name, 'leg': leg,
           'reportChars': rec.get('reportChars') or 0,
           'attempts': led.get('attemptsSettled'),
           'tokensAudit': file_tokens(led),
           'tokensSoft': led.get('observedTokenTotal', 0) or 0}
    if not rep.strip():
        ent['status'] = 'void'
        rows.append(ent)
        continue
    s1, _ = extract_total_table(rep)
    if s1 is not None and float(s1) >= 40:
        ent['score'], ent['method'] = s1, 'table'
    else:
        s2, _ = extract_total_labeled(rep)
        ent['score'], ent['method'] = s2, ('labeled' if s2 else None)
    ent['verdict'] = extract_verdict(rep)
    ent['status'] = 'reading'
    ent['closed'] = bool(ent.get('score') and float(ent['score']) >= 85)
    rows.append(ent)

readings = [e for e in rows if e.get('status') == 'reading']
closed = [e for e in readings if e.get('closed')]
void_or_missing = [e for e in rows if e.get('status') != 'reading']

final = {}
for e in rows:
    final[e['name']] = e  # v2 覆盖 v1
final_closed = [v for v in final.values() if v.get('closed')]
final_open = [v for v in final.values() if v.get('status') == 'reading' and not v.get('closed')]
final_missing = [v for v in final.values() if v.get('status') != 'reading']

summary = {
    'rounds': f'r{ITEMS[0][0]}-r{ITEMS[-1][0]}',
    'items': len(final),
    'roundsFired': len(rows),
    'finalClosed': len(final_closed),
    'finalOpen': len(final_open),
    'finalMissing': len(final_missing),
    'tokensAuditAllRounds': sum(e.get('tokensAudit', 0) or 0 for e in rows),
    'attemptsAllRounds': sum(e.get('attempts', 0) or 0 for e in rows),
    'closedNames': sorted(v['name'] for v in final_closed),
    'openNames': sorted(v['name'] for v in final_open),
}
out = {'record_type': 'p2_nearmiss_pilot_closeout', 'summary': summary, 'rows': rows, 'final': list(final.values())}
(BASE / 'closeout.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')

cols = ['round', 'name', 'leg', 'status', 'verdict', 'score', 'method', 'closed', 'attempts', 'tokensAudit', 'tokensSoft', 'reportChars']
with (BASE / 'results.csv').open('w', newline='', encoding='utf-8') as fh:
    w = csv.writer(fh)
    w.writerow(cols)
    for e in rows:
        w.writerow([e.get(c, '') for c in cols])

print(json.dumps(summary, ensure_ascii=False, indent=1))
print('open:', [(v['name'], v.get('score')) for v in final_open])
print('missing:', [(v['name'], v.get('status')) for v in final_missing])
