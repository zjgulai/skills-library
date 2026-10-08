#!/usr/bin/env python3
"""LB-8 偏低带补齐批·收口（零请求）：按 wave 清单提取读数＋与认证基线差分＋成本汇总。

- 腿清单＝lowband-lb8/<TAG>.tsv（缺省 fire-wave1.tsv；一轮一件）。
- score/verdict 提取沿用 LB-7/strip39 同规则（表行优先→标签→锚定＋门槛句/分母/区间/判词拒绝；下界 5；
  表行容忍 **加粗**、拒 `%` 后缀——D197 教训内建于原工具）。
- 基线＝lowband-lb8/selection.json 的认证分（wave-1 读数；覆盖不全直接报红，不允许静默缺基线）。
- voidExtra＝evidence-r{R}-voidN 归档腿的成本（首轮 void 作废腿自动并入）。
- --control：仪器自证（复算 LB-7 既存读数逐数相等）。
用法：python3 -B p2-lb8-closeout.py [TAG=wave1]
"""
import csv
import json
import re
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent            # fix-plans/
NORM = BASE.parent                                 # 143-library-normalize/
REPO = Path(__file__).resolve().parents[5]         # 仓根动态发现：fix-plans 上溯五层
OPT = REPO / 'skill-lifecycle/trial-home/opt-run'
LB8 = NORM / 'lowband-lb8'
TAG = next((a for a in sys.argv[1:] if not a.startswith('-')), 'wave1')
LIST = LB8 / f'fire-{TAG}.tsv'
SEL = LB8 / 'selection.json'

TOTAL_ANCHORS = ('综合加权总分', '加权总分', '综合总分', '综合得分', '总体得分', '评估总分', '总分', '总计')
LABELS = ('综合加权得分', '综合加权总分', '加权总分', '综合总分', '综合得分', '总评分', '六维总分', '总体得分', '评估总分', '最终得分', '总分')
REJECT_BEFORE = ('>=', '≥', '<=', '≤', '>', '<', '达到', '门槛', '及格', '发布线', '以上', '未达', '高于', '低于', '提升', '预期', '预计', '复评', '通过', '基线')
REJECT_AFTER = ('以上', '+', '＋')
VERDICTS = ('可以发布', '可发布', '需优化', '需重构')
VERDICT_KW = ('需优化', '需重构', '可发布', '可以发布', 'needs_')
ARROW = ('->', '→', '修正后')


def publishable(v):
    """判词语义归类：『可以发布』不含『可发布』子串，必须按变体枚举而不是子串匹配。"""
    if not v:
        return None
    if '可以发布' in v or '可发布' in v:
        return True
    if '需优化' in v or '需重构' in v or 'needs_' in v:
        return False
    return None


def verdict_class(v):
    return 'publishable' if publishable(v) else ('reject' if publishable(v) is False else 'unknown')


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


def load_live(r):
    ev = OPT / f'evidence-r{r}'
    if not ev.is_dir():
        return None
    for f in sorted(ev.glob('armed-*.json')):
        try:
            d = json.loads(f.read_text(encoding='utf-8'))
        except json.JSONDecodeError:
            continue
        if d.get('mode') == 'live':
            return d
    return None


def void_extra(r):
    va = vt = n = 0
    for vd in sorted(OPT.glob(f'evidence-r{r}-void*')):
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
            n += 1
    return {'legs': n, 'attempts': va, 'tokensAudit': vt}


def baselines():
    """LB-8 基线＝selection.json 的认证分（wave-1 读数）。"""
    out = {}
    sel = json.loads(SEL.read_text(encoding='utf-8'))
    for it in sel['items']:
        if it.get('score'):
            out[it['name']] = {'round': it.get('round') or 0, 'score': it['score'],
                               'verdict': it.get('verdict') or '', 'band': 'lb8-base'}
    return out


def control_lb7():
    """仪器自证：同一套规则复算 LB-7 既存读数，必须与 lowband-lb7/results.csv 逐数相等。

    只有会红的仪器才能给本批出账——复算不一致就拒绝。
    """
    f = NORM / 'lowband-lb7' / 'results.csv'
    if not f.is_file():
        raise SystemExit('CONTROL SKIP: 找不到 lowband-lb7/results.csv，无法自证取数规则')
    # 判词归一化的正/负例（「可以发布」不含「可发布」子串＝历史踩过的坑）
    for probe, want in (('可以发布', True), ('可发布', True), ('**可发布 (good)**', True),
                        ('需优化', False), ('需重构', False), ('needs_optimization', False)):
        if publishable(probe) is not want:
            print(f'  VERDICT-CLASS FAIL: {probe!r} → {publishable(probe)}，期望 {want}')
            return 1
    if publishable('') is not None or publishable('含糊的说法') is not None:
        print('  VERDICT-CLASS FAIL: 空值/未知判词必须归 None，好让差分把它单独记账')
        return 1
    tested = bad = 0
    seen = set()
    with f.open(encoding='utf-8') as fh:
        for r in csv.DictReader(fh):
            if r.get('status') != 'reading' or not r.get('score'):
                continue
            rec = load_live(int(r['round']))
            if rec is None or not (rec.get('report') or '').strip():
                continue
            s, _m = extract_score(rec['report'])
            v = extract_verdict(rec['report'])
            tested += 1
            seen.add((s, v))
            if s != r['score'] or (v or '') != (r.get('verdict') or ''):
                bad += 1
                if bad <= 8:
                    print(f'  MISMATCH r{r["round"]} {r["name"]}: 复算={s}/{v} 台账={r["score"]}/{r.get("verdict")}')
            if tested >= 120:
                break
    # 判别力自证：复算出的 (score,verdict) 必须是一组互不相同的值，否则「全对」可能是常数返回
    print(f'CONTROL: LB-7 既存读数复算 {tested} 条，不一致 {bad} 条，distinct (score,verdict) {len(seen)} 组')
    return 0 if (tested >= 60 and bad == 0 and len(seen) >= 20) else 1


def main():
    if '--control' in sys.argv:
        raise SystemExit(control_lb7())
    legs = []

    for ln in LIST.read_text(encoding='utf-8').splitlines():
        if not ln.strip():
            continue
        r, name, att, tok = ln.split('\t')
        legs.append((int(r), name, 'lb8'))
    excluded = []
    base = baselines()
    missing_base = sorted(set(n for _, n, _ in legs if n not in base))
    if missing_base:
        raise SystemExit(f'基线缺失 {len(missing_base)} 件，拒绝出账：{missing_base}')

    rows = []
    for r, name, lbl in legs:
        ent = {'round': r, 'name': name, 'leg': lbl, 'kind': 'lb8'}
        rec = load_live(r)
        if rec is None:
            ent['status'] = 'no-evidence'
            rows.append(ent)
            continue
        rep = rec.get('report') or ''
        led = rec.get('ledger') or {}
        ve = void_extra(r)
        if ve['legs']:
            ent['voidExtra'] = ve
        ent.update({
            'reportChars': rec.get('reportChars') or 0,
            'attempts': led.get('attemptsSettled'),
            'tokensAudit': file_tokens(led),
            'tokensSoft': led.get('observedTokenTotal', 0) or 0,
        })
        if not rep.strip():
            ent['status'] = 'void'
            rows.append(ent)
            continue
        score, method = extract_score(rep)
        b = base[name]
        ent.update({
            'status': 'reading', 'score': score, 'method': method,
            'verdict': extract_verdict(rep),
            'baseScore': b['score'], 'baseVerdict': b['verdict'], 'baseBand': b['band'],
        })
        ent['closed'] = bool(score and float(score) >= 85)
        if score and b['score']:
            ent['delta'] = round(float(score) - float(b['score']), 2)
        rows.append(ent)

    readings = [e for e in rows if e.get('status') == 'reading']
    voids = [e for e in rows if e.get('status') == 'void']
    missing = [e for e in rows if e.get('status') == 'no-evidence']
    unscored = [e for e in readings if not e.get('score')]

    # 逐件终态：同件多腿取中位数分、判词取多数类（把判者方差与真实回落分开）
    per_item = {}
    for e in readings:
        per_item.setdefault(e['name'], []).append(e)
    finals = {}
    for name, es in per_item.items():
        scored = [float(e['score']) for e in es if e.get('score')]
        med = sorted(scored)[len(scored) // 2] if len(scored) % 2 else \
            (sorted(scored)[len(scored) // 2 - 1] + sorted(scored)[len(scored) // 2]) / 2
        classes = [verdict_class(e.get('verdict')) for e in es]
        pub = sum(1 for c in classes if c == 'publishable')
        final_verdict = 'publishable' if pub * 2 > len(classes) else 'reject'
        finals[name] = {'legs': len(es), 'scores': [e.get('score') for e in es],
                        'median': round(med, 2) if scored else None,
                        'verdicts': [e.get('verdict') for e in es], 'verdictClass': final_verdict,
                        'baseScore': es[0].get('baseScore'), 'baseVerdictClass': verdict_class(es[0].get('baseVerdict')),
                        'baseBand': es[0].get('baseBand'),
                        'closed': bool(scored and med >= 85)}
    certified_keep = sorted(n for n, f in finals.items() if f['closed'] and f['verdictClass'] == 'publishable')
    dropped = sorted(n for n, f in finals.items() if not (f['closed'] and f['verdictClass'] == 'publishable'))
    verdict_flips = sorted(n for n, f in finals.items()
                           if None not in (f['verdictClass'], f['baseVerdictClass'])
                           and f['verdictClass'] != f['baseVerdictClass'])
    moved = sorted((n, f['baseScore'], f['median'], round(f['median'] - float(f['baseScore']), 2))
                   for n, f in finals.items()
                   if f['baseScore'] and abs(f['median'] - float(f['baseScore'])) >= 0.5)
    repeated = {n: {'scores': f['scores'], 'median': f['median'], 'verdicts': f['verdicts']}
                for n, f in finals.items() if f['legs'] > 1}

    planned = sorted(set(n for _, n, lbl in legs if lbl == 'lb8'))
    unaccounted = sorted(set(planned) - set(per_item)
                         - {e['name'] for e in voids + missing})
    deltas = [f['median'] - float(f['baseScore']) for f in finals.values()
              if f['median'] is not None and f['baseScore']]
    summary = {
        'rounds': f'r{min(r for r, _, _ in legs)}-r{max(r for r, _, _ in legs)}',
        'items': len(planned),
        'plannedItems': len(planned),
        'unaccounted': unaccounted,
        'legsFired': len(rows),
        'repeatLegs': sum(1 for _, _, l in legs if l == 'repeat'),
        'excludedLegs': excluded,
        'readings': len(readings),
        'voids': len(voids),
        'noEvidence': len(missing),
        'scoreMissing': [e['name'] for e in unscored],
        'certifiedKeep': len(certified_keep),
        'openItems': dropped,
        'belowThresholdOnly': sorted(n for n, f in finals.items()
                                     if f['median'] is not None and f['median'] < 85),
        'verdictChanged': verdict_flips,
        'movedItems': moved,
        'repeatedItems': repeated,
        'delta': {'min': round(min(deltas), 2), 'max': round(max(deltas), 2),
                  'mean': round(sum(deltas) / len(deltas), 3),
                  'zero': sum(1 for d in deltas if d == 0)} if deltas else None,
        'voidExtraLegs': sum((e.get('voidExtra') or {}).get('legs', 0) for e in rows),
        'voidExtraTokensAudit': sum((e.get('voidExtra') or {}).get('tokensAudit', 0) for e in rows),
        'tokensAuditAllLegs': sum(e.get('tokensAudit', 0) or 0 for e in rows),
        'attemptsAllLegs': sum(e.get('attempts', 0) or 0 for e in rows),
        'grandTotalTokensAudit': (sum(e.get('tokensAudit', 0) or 0 for e in rows)
                                  + sum((e.get('voidExtra') or {}).get('tokensAudit', 0) for e in rows)),
        'untrackedNote': 'LB-8 无被删档；void 作废腿成本经 voidExtra 自动并入',
    }
    out = {'record_type': 'p2_lb8_closeout', 'tag': TAG, 'summary': summary,
           'finals': finals, 'rows': rows}
    (LB8 / f'{TAG}-closeout.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')

    cols = ['round', 'name', 'leg', 'kind', 'status', 'verdict', 'score', 'method', 'closed',
            'baseScore', 'baseVerdict', 'baseBand', 'delta', 'attempts', 'tokensAudit',
            'tokensSoft', 'reportChars']
    with (LB8 / f'{TAG}-results.csv').open('w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh, lineterminator='\n')
        w.writerow(cols)
        for e in rows:
            w.writerow([e.get(c, '') for c in cols])

    print(json.dumps(summary, ensure_ascii=False, indent=1))
    if voids or missing or unaccounted:
        print('未收口:', [(e['round'], e['name'], e['status']) for e in voids + missing],
              '无终态的在册件:', unaccounted)


if __name__ == '__main__':
    main()
