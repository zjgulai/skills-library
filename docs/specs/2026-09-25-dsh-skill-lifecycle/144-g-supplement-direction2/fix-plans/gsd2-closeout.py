#!/usr/bin/env python3
"""G 续补去向② 七件候选 · live 复评收官（零请求）：提取读数（每件两跑）＋void 检查＋成本汇总。

- 提取规则沿用 LB-7/strip39/LB-8 同口径（表行优先→标签→锚定＋门槛句/分母/区间/判词拒绝；下界 5）。
- 每件两跑：evidence-r{R}/armed-o{R}-evaluate-target-r{1,2}.json；空报告（reportChars=0）＝void。
- 预注册判据：每件两跑 **≥85 且零 error** → 收口。
- --control：仪器自证（复算 r1846 brand-monitoring 既存读数，必须提取到 88.5）。
用法：python3 -B gsd2-closeout.py [--control]
"""
import csv
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
REPO = HERE.parents[5]                      # 仓根动态发现：fix-plans 上溯五层
OPT = REPO / 'skill-lifecycle/trial-home/opt-run'
OUT = HERE.parents[1] / 'receipts'

ROUNDS = [
    (1847, 'management-decision-package'),
    (1848, 'scenario-governance-review'),
    (1849, 'storefront-sellability-check'),
    (1850, 'account-health-appeal'),
    (1851, 'metric-contract-governance'),
    (1852, 'experiment-adoption-gate'),
    (1853, 'tool-contract-governance'),
]

TOTAL_ANCHORS = ('综合加权总分', '加权总分', '综合总分', '综合得分', '总体得分', '评估总分', '总分', '总计')
LABELS = ('综合加权得分', '综合加权总分', '加权总分', '综合总分', '综合得分', '总评分', '六维总分', '总体得分', '评估总分', '最终得分', '总分')
REJECT_BEFORE = ('>=', '≥', '<=', '≤', '>', '<', '达到', '门槛', '及格', '发布线', '以上', '未达', '高于', '低于', '提升', '预期', '预计', '复评', '通过', '基线')
REJECT_AFTER = ('以上', '+', '＋')
VERDICTS = ('可以发布', '可发布', '需优化', '需重构')
VERDICT_KW = ('需优化', '需重构', '可发布', '可以发布', 'needs_')
ARROW = ('->', '→', '修正后')


def publishable(v):
    if not v:
        return None
    if '可以发布' in v or '可发布' in v:
        return True
    if '需优化' in v or '需重构' in v or 'needs_' in v:
        return False
    return None


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
            m = mm
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


def zero_error(rep):
    """零 error 自证：判者自述否定式（含反引号变体与「0 error」「零阻断」措辞）；否则标记待人工核。

    注意：否定式检测必须优先于「error 级别…」字形——「无 `error` 级别缺陷」内含
    「error 级别缺陷」子串，直接用后者会误判（本批实抓：4 件报告均为否定式但被漏读）。
    """
    if not rep:
        return None
    if re.search(r'无\s*(任何\s*)?`?error`?|零\s*`?error`?|\b0\s*`?error`?|零\s*阻断|no\s+`?error`?', rep, re.I):
        return True
    # 仅当显式「存在/有/共 N 个 error」+ 后方无否定语境时才归 False
    for m in re.finditer(r'(存在|有|共)\s*[0-9一二三四五六七八九十]+\s*个?\s*`?error`?', rep, re.I):
        ctx = rep[max(0, m.start() - 8): m.start()]
        if not re.search(r'无|零|0\s*$', ctx):
            return False
    return None


def load_live(round_no, rep):
    ev = OPT / f'evidence-r{round_no}'
    f = ev / f'armed-o{round_no}-evaluate-target-r{rep}.json'
    if not f.is_file():
        return None
    try:
        d = json.loads(f.read_text(encoding='utf-8'))
    except json.JSONDecodeError:
        return None
    return d if d.get('mode') == 'live' else None


def extract_one(round_no, rep):
    d = load_live(round_no, rep)
    if d is None:
        return {'score': None, 'path': 'missing', 'verdict': '', 'void': True,
                'reportChars': 0, 'att': 0, 'tok': 0, 'finish': '', 'errFlag': None}
    rep_text = d.get('report') or ''
    chars = d.get('reportChars') or 0
    led = d.get('ledger') or {}
    void = chars == 0
    score = path = None
    verdict = ''
    ze = None
    if not void:
        score, path = extract_score(rep_text)
        verdict = extract_verdict(rep_text) or ''
        ze = zero_error(rep_text)
    return {'score': float(score) if score else None, 'path': path or '', 'verdict': verdict,
            'void': void, 'reportChars': chars, 'att': led.get('attemptsSettled') or 0,
            'tok': file_tokens(led), 'finish': ','.join(d.get('finishKinds') or []),
            'elapsedMs': d.get('elapsedMs') or 0, 'errFlag': ze}


def control():
    """仪器自证：复算 r1846 brand-monitoring（期望 88.5）与 r1846 报告判词。"""
    d = load_live(1846, 1)
    if d is None:
        print('CONTROL SKIP: r1846 记录不可读'); return 1
    rep = d.get('report') or ''
    s, path = extract_score(rep)
    v = extract_verdict(rep)
    ok = (s == '88.5') and publishable(v) is True
    print(f'  control r1846: score={s} path={path} verdict={v} → {"PASS" if ok else "FAIL"}')
    # 判词变体负例
    for probe, want in (('可以发布', True), ('**可发布 (good)**', True), ('需优化', False), ('需重构', False)):
        if publishable(probe) is not want:
            print(f'  VERDICT-CLASS FAIL: {probe!r}'); return 1
    return 0 if ok else 1


def main():
    if '--control' in sys.argv:
        rc = control()
        print('CONTROL', 'PASS' if rc == 0 else 'FAIL')
        sys.exit(rc)
    rows = []
    summary = []
    tot_tok = tot_att = 0
    for r, name in ROUNDS:
        reps = [extract_one(r, 1), extract_one(r, 2)]
        for i, e in enumerate(reps, 1):
            rows.append({'round': r, 'name': name, 'rep': i, **e})
            tot_tok += e['tok']; tot_att += e['att']
        scores = [e['score'] for e in reps]
        voids = [e['void'] for e in reps]
        zeds = [e['errFlag'] for e in reps]
        closed = (not any(voids)) and all(s is not None and s >= 85 for s in scores) and all(z is True for z in zeds)
        summary.append({'round': r, 'name': name, 'scores': scores, 'voids': voids,
                        'zeroError': zeds, 'closed': closed})
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'gsd2-results.json').write_text(json.dumps(
        {'record_type': 'gsd2_live_closeout', 'at': '2026-10-04', 'items': summary,
         'cost': {'tokensAudit': tot_tok, 'attempts': tot_att}},
        ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    with open(OUT / 'gsd2-results.csv', 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=['round', 'name', 'rep', 'score', 'verdict', 'void',
                                          'reportChars', 'att', 'tok', 'finish', 'errFlag', 'path', 'elapsedMs'],
                           lineterminator='\n')
        w.writeheader()
        for row in rows:
            w.writerow(row)
    print(f'{"round":>5}  {"name":38s}  rep1      rep2      void        closed')
    closed_n = 0
    for s in summary:
        sc = [('%.2f' % x) if x is not None else '—' for x in s['scores']]
        print(f"{s['round']:>5}  {s['name']:38s}  {sc[0]:9s} {sc[1]:9s} {str(s['voids']):11s} {s['closed']}")
        closed_n += 1 if s['closed'] else 0
    print(f'\nclosed {closed_n}/{len(ROUNDS)}  tokensAudit={tot_tok:,}  attempts={tot_att}')
    sys.exit(0 if closed_n == len(ROUNDS) else 1)


if __name__ == '__main__':
    main()
