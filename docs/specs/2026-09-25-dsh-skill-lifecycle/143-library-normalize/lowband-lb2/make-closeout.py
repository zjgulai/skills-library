#!/usr/bin/env python3
"""低带选择性修复·LB-2 收口（零请求）：r1130–r1178 读数提取＋成本汇总。

- 主批 r1130–r1178（49 件单跑）；重试腿（gen2/gen3）追加在 lowband-lb2/retry-legs.json。
- score/verdict 提取沿用 wave-2 同规则（表行优先→标签→锚定＋门槛句/分母/区间/判词拒绝；下界 5）。
- 输出：lowband-lb2/results.csv ＋ closeout.json
用法：python3 -B make-closeout.py
"""
import csv
import json
import re
from pathlib import Path

BASE = Path(__file__).resolve().parent            # lowband-lb2/
OPT = Path('/Users/lute/project/AgentTools/思维库/skill管理/skill-lifecycle/trial-home/opt-run')
R0 = 1130

TOTAL_ANCHORS = ('综合加权总分', '加权总分', '综合总分', '综合得分', '总体得分', '评估总分', '总分', '总计')
LABELS = ('综合加权得分', '综合加权总分', '加权总分', '综合总分', '综合得分', '总评分', '六维总分', '总体得分', '评估总分', '最终得分', '总分')
REJECT_BEFORE = ('>=', '≥', '<=', '≤', '>', '<', '达到', '门槛', '及格', '发布线', '以上', '未达', '高于', '低于', '提升', '预期', '预计', '复评', '通过', '基线')
REJECT_AFTER = ('以上', '+', '＋')
VERDICTS = ('可以发布', '可发布', '需优化', '需重构')
VERDICT_KW = ('需优化', '需重构', '可发布', '可以发布', 'needs_')
ARROW = ('->', '→', '修正后')


def file_tokens(d):
    if not isinstance(d, dict):
        return 0
    return sum(d.get(k, 0) or 0 for k in (
        'observedInputTokens', 'observedOutputTokens',
        'observedCacheReadTokens', 'observedCacheWriteTokens'))


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
            pos = rep.find(label, pos + 1)
    return None, None


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


# 腿清单：主批（selection 顺序，r997+）＋重试腿（retry-legs.json，可后补）
sel = json.loads((BASE / 'selection.json').read_text(encoding='utf-8'))
legs = [(R0 + i, it['name'], it.get('kind'), 'main') for i, it in enumerate(sel['items'])]
retry_file = BASE / 'retry-legs.json'
if retry_file.exists():
    for it in json.loads(retry_file.read_text(encoding='utf-8')):
        legs.append((it['round'], it['name'], it.get('kind'), it.get('leg', 'v2')))

rows = []
for r, name, kind, leg in legs:
    ent = {'round': r, 'name': name, 'kind': kind, 'leg': leg}
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

main_rows = [e for e in rows if e['leg'] == 'main']
readings = [e for e in rows if e.get('status') == 'reading']
voids = [e for e in rows if e.get('status') == 'void']
missing = [e for e in rows if e.get('status') == 'no-evidence']

# 逐件终态：同名的最后一条腿
final = {}
for e in rows:
    if e.get('status') == 'reading':
        prev = final.get(e['name'])
        if prev is None or e['round'] >= prev['round']:
            final[e['name']] = e
final_closed = sorted(n for n, e in final.items() if e.get('closed'))
final_open = sorted(n for n, e in final.items() if not e.get('closed'))
unclosed_missing = sorted(set(it['name'] for it in sel['items']) - set(final))

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
    'rounds': f'r{R0}-r{R0 + len(sel["items"]) - 1}（重试腿另计）',
    'items': len(sel['items']),
    'legsFired': len(rows),
    'readings': len(readings),
    'voids': len(voids),
    'noEvidence': len(missing),
    'firstPassClosed': sum(1 for e in main_rows if e.get('closed')),
    'finalClosed': len(final_closed),
    'finalOpen': len(final_open),
    'finalMissing': len(unclosed_missing),
    'closedNames': final_closed,
    'openNames': final_open + unclosed_missing,
    'buckets': buckets,
    'tokensAuditAllLegs': sum(e.get('tokensAudit', 0) or 0 for e in rows),
    'attemptsAllLegs': sum(e.get('attempts', 0) or 0 for e in rows),
    'voidExtraTokensAudit': sum((e.get('voidExtra') or {}).get('tokensAudit', 0) for e in rows),
    'grandTotalTokensAudit': sum(e.get('tokensAudit', 0) or 0 for e in rows) + sum((e.get('voidExtra') or {}).get('tokensAudit', 0) for e in rows),
}
out = {'record_type': 'p2_lb2_closeout', 'summary': summary, 'rows': rows}
(BASE / 'closeout.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')

cols = ['round', 'name', 'leg', 'kind', 'status', 'verdict', 'score', 'method', 'closed', 'attempts', 'tokensAudit', 'tokensSoft', 'reportChars']
with (BASE / 'results.csv').open('w', newline='', encoding='utf-8') as fh:
    w = csv.writer(fh)
    w.writerow(cols)
    for e in rows:
        w.writerow([e.get(c, '') for c in cols])

print(json.dumps(summary, ensure_ascii=False, indent=1))
print('voids:', [(e['round'], e['name']) for e in voids][:20])
