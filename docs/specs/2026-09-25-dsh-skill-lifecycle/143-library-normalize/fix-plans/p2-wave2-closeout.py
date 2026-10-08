#!/usr/bin/env python3
"""P2 wave-2 收口（零请求）：r541–r996 读数提取＋成本/分档汇总。

用法：python3 -B p2-wave2-closeout.py [--limit N]（默认全部）
输出：143-library-normalize/fix-plans/p2-wave2-results.csv ＋ p2-wave2-closeout.json
"""
import csv
import json
import re
from pathlib import Path

BASE = Path(__file__).resolve().parent          # fix-plans/
OPT = Path('/Users/lute/project/AgentTools/思维库/skill管理/skill-lifecycle/trial-home/opt-run')
R0 = 541
sel = json.loads((BASE / 'p2-wave2-selection.json').read_text(encoding='utf-8'))

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


ARROW = ('->', '→', '修正后')


def _cell_candidate(c):
    picks = re.findall(r'([0-9]{1,3}(?:\.[0-9]+)?)', c)
    if not picks:
        return None
    if any(a in c for a in ARROW) and len(picks) > 1:
        m = None
        for mm in re.finditer(r'([0-9]{1,3}(?:\.[0-9]+)?)', c):
            m = mm  # 取最后一个
        before = c[:m.start()].replace('->', ' ').replace('→', ' ')
    else:
        m = re.search(r'([0-9]{1,3}(?:\.[0-9]+)?)', c)
        before = c[:m.start()]
    after1 = c[m.end():m.end() + 1]
    val = float(m.group(1))
    if after1 == '%' or not (5 <= val <= 100):
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


def extract_score(rep):
    for ln in rep.splitlines():
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
                return cands[-1], 'table'
    for label in LABELS:
        pos = rep.find(label)
        while pos != -1:
            window = rep[pos + len(label): pos + len(label) + 100]
            for m in re.finditer(r'([0-9]{1,3}(?:\.[0-9]+)?)', window):
                after1 = window[m.end():m.end() + 1]
                before = rep[max(0, pos + len(label) + m.start() - 6): pos + len(label) + m.start()]
                after_ctx = window[m.end():m.end() + 4]
                val = float(m.group(1))
                if (after1 != '%' and 5 <= val <= 100 and not before.rstrip().endswith('/')
                        and not re.match(r'^\s*[-~至]\s*[0-9]', after_ctx)
                        and not any(rk in before for rk in REJECT_BEFORE)
                        and not any(rk in after_ctx for rk in REJECT_AFTER)):
                    return m.group(1), 'labeled'
            pos = report_find_next(rep, label, pos)
    return None, None


def report_find_next(rep, label, pos):
    return rep.find(label, pos + 1)


def extract_verdict(rep):
    def earliest(text):
        best = None
        for v in VERDICTS:
            p = text.find(v)
            if p != -1 and (best is None or p < best[1]):
                best = (v, p)
        return best[0] if best else None
    i = rep.find('发布结论')
    while i != -1:
        got = earliest(rep[i: i + 80])
        if got:
            return got
        i = rep.find('发布结论', i + 1)
    return earliest(rep[:400]) or earliest(rep)


rows = []
for i, it in enumerate(sel['items']):
    r = R0 + i
    ent = {'round': r, 'name': it['name'], 'kind': it.get('kind')}
    ev = OPT / f'evidence-r{r}'
    rec = None
    if ev.is_dir():
        for f in sorted(ev.glob('armed-*.json')):
            try:
                d = json.loads(f.read_text(encoding='utf-8'))
            except json.JSONDecodeError:
                continue
            if d.get('mode') == 'live':
                rec = d
                break
    if rec is None:
        ent['status'] = 'no-evidence'
        rows.append(ent)
        continue
    rep = rec.get('report') or ''
    led = rec.get('ledger') or {}
    ent.update({
        'reportChars': rec.get('reportChars') or 0,
        'attempts': led.get('attemptsSettled'),
        'tokensAudit': file_tokens(led),
        'tokensSoft': led.get('observedTokenTotal', 0) or 0,
    })
    ve_dirs = sorted(OPT.glob(f'evidence-r{r}-void*'))
    if ve_dirs:
        va = vt = 0
        for vd in ve_dirs:
            for f in vd.glob('armed-*.json'):
                try:
                    dv = json.loads(f.read_text(encoding='utf-8'))
                except json.JSONDecodeError:
                    continue
                if dv.get('mode') != 'live':
                    continue
                vl = dv.get('ledger') or {}
                va += vl.get('attemptsSettled') or 0
                vt += file_tokens(vl)
        ent['voidExtra'] = {'attempts': va, 'tokensAudit': vt}
    if not rep.strip():
        ent['status'] = 'void'
        rows.append(ent)
        continue
    score, method = extract_score(rep)
    ent['score'], ent['method'] = score, method
    ent['verdict'] = extract_verdict(rep)
    ent['status'] = 'reading'
    ent['closed'] = bool(score and float(score) >= 85)
    rows.append(ent)

readings = [e for e in rows if e.get('status') == 'reading']
voids = [e for e in rows if e.get('status') == 'void']
missing = [e for e in rows if e.get('status') == 'no-evidence']
closed = [e for e in readings if e.get('closed')]

buckets = {'85+': 0, '80-84': 0, '70-79': 0, '60-69': 0, '<60': 0, 'score-missing': 0}
for e in readings:
    if not e.get('score'):
        buckets['score-missing'] += 1
        continue
    s = float(e['score'])
    if s >= 85:
        buckets['85+'] += 1
    elif s >= 80:
        buckets['80-84'] += 1
    elif s >= 70:
        buckets['70-79'] += 1
    elif s >= 60:
        buckets['60-69'] += 1
    else:
        buckets['<60'] += 1

summary = {
    'rounds': f'r{R0}-r{R0 + len(sel["items"]) - 1}',
    'selectionItems': len(sel['items']),
    'processed': len(rows),
    'readings': len(readings),
    'voids': len(voids),
    'noEvidence': len(missing),
    'closed': len(closed),
    'closedNames': sorted(e['name'] for e in closed),
    'buckets': buckets,
    'tokensAudit': sum(e.get('tokensAudit', 0) or 0 for e in rows),
    'attempts': sum(e.get('attempts', 0) or 0 for e in rows),
    'tokensAuditReadings': sum(e.get('tokensAudit', 0) or 0 for e in readings),
    'voidExtraTokensAudit': sum((e.get('voidExtra') or {}).get('tokensAudit', 0) for e in rows),
    'grandTotalTokensAudit': sum(e.get('tokensAudit', 0) or 0 for e in rows) + sum((e.get('voidExtra') or {}).get('tokensAudit', 0) for e in rows),
}
out = {'record_type': 'p2_wave2_closeout', 'summary': summary, 'rows': rows}
(BASE / 'p2-wave2-closeout.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')

cols = ['round', 'name', 'kind', 'status', 'verdict', 'score', 'method', 'closed', 'attempts', 'tokensAudit', 'tokensSoft', 'reportChars']
with (BASE / 'p2-wave2-results.csv').open('w', newline='', encoding='utf-8') as fh:
    w = csv.writer(fh)
    w.writerow(cols)
    for e in rows:
        w.writerow([e.get(c, '') for c in cols])

print(json.dumps(summary, ensure_ascii=False, indent=1))
print('voids:', [(e['round'], e['name']) for e in voids][:20])
