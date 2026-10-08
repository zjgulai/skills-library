#!/usr/bin/env python3
"""P2 wave-1 收口提取（零请求）。

对 r418–r517 逐件从证据内嵌记录提取权威读数：
- verdict/score 从 report 正文提取（表行优先＋锚定回退），输出上下文供人工核对；
- att/tokens 取内嵌 ledger：审计口径＝四字段之和；软停口径＝observedTokenTotal（不含 cacheRead）另列；
- void 判定＝reportChars==0 且无 report 文本（主目录内无读数记录）；
- 与 runs-r<k> 磁盘账本逐件对照（attempts/tokens，容差 2%）。
输出：p2-wave1-results.csv ＋ p2-wave1-closeout.json（均在 fix-plans/）。

用法：python3 -B p2-wave1-closeout.py
"""
import csv
import json
import re
from pathlib import Path

BASE = Path(__file__).resolve().parent                                  # fix-plans/
ROOT = BASE.parents[1]                                                  # dsh-skill-lifecycle/
REPO = Path('/Users/lute/project/AgentTools/思维库/skill管理')
OPT = REPO / 'skill-lifecycle/trial-home/opt-run'
SEL = json.loads((BASE / 'p2-wave1-selection.json').read_text(encoding='utf-8'))
R0 = 418
N = len(SEL['items'])

TOTAL_ANCHORS = ('综合加权总分', '加权总分', '综合总分', '综合得分', '总体得分', '评估总分', '总分', '总计')
LABELS = ('综合加权得分', '综合加权总分', '加权总分', '综合总分', '综合得分',
          '总评分', '六维总分', '总体得分', '评估总分', '最终得分', '总分')
# 门槛/预期语境标记：命中则拒绝该候选数字（出现在数字前 6 字符或后 4 字符内）
REJECT_BEFORE = ('>=', '≥', '<=', '≤', '>', '<', '达到', '门槛', '及格', '发布线',
                 '以上', '未达', '高于', '低于', '提升', '预期', '预计', '复评', '通过', '基线')
REJECT_AFTER = ('以上', '+', '＋')
VERDICTS = ('可发布', '需优化', '需重构')


def file_tokens(d):
    if not isinstance(d, dict):
        return 0
    return sum(d.get(k, 0) or 0 for k in (
        'observedInputTokens', 'observedOutputTokens',
        'observedCacheReadTokens', 'observedCacheWriteTokens'))


VERDICT_KW = ('需优化', '需重构', '可发布', 'needs_')


ARROW = ('->', '→', '修正后')


def _cell_candidate(c):
    """单元格内取分数候选（箭头/修正后句式取最后值；否则取首个）。"""
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
    if before.rstrip().endswith('/'):                      # 分母
        return None
    if re.match(r'^\s*[-~至]\s*[0-9]', c[m.end():m.end() + 4]):  # 区间
        return None
    if any(rk in before for rk in REJECT_BEFORE):
        return None
    if any(rk in c[m.end():m.end() + 4] for rk in REJECT_AFTER):
        return None
    return m.group(1)


def extract_total_table(report):
    """表行：含总分锚词的行，跳过判词单元格后取**最后一个**有效候选（兼容「满分」列布局）。
    若排除判词后无候选，回退为包含判词单元格再取最后候选。"""
    for ln in report.splitlines():
        if '|' not in ln:
            continue
        if not any(a in ln for a in TOTAL_ANCHORS):
            continue
        cells = [c.strip() for c in ln.split('|')]
        li = None
        for idx, c in enumerate(cells):
            if any(a in c for a in TOTAL_ANCHORS):
                li = idx
                break
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


def extract_total_anchor(report):
    """锚定回退：锚词后 120 字符窗口内首个通过拒绝规则的 40–100 数（与 labeled 同套防线）。"""
    for a in TOTAL_ANCHORS:
        i = report.find(a)
        while i != -1:
            window = report[i + len(a): i + len(a) + 120]
            for m in re.finditer(r'([0-9]{1,3}(?:\.[0-9]+)?)', window):
                after1 = window[m.end():m.end() + 1]
                before = report[max(0, i + len(a) + m.start() - 6): i + len(a) + m.start()]
                after_ctx = window[m.end():m.end() + 4]
                val = float(m.group(1))
                is_denominator = before.rstrip().endswith('/')
                is_range = bool(re.match(r'^\s*[-~至]\s*[0-9]', after_ctx))
                if (after1 != '%' and 5 <= val <= 100 and not is_denominator and not is_range
                        and not any(rk in before for rk in REJECT_BEFORE)
                        and not any(rk in after_ctx for rk in REJECT_AFTER)):
                    ctx = report[max(0, i - 20): i + len(a) + m.end() + 30].replace('\n', ' ')
                    return m.group(1), ctx
            i = report.find(a, i + 1)
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
    return earliest(report[:400])


def extract_total_labeled(report):
    """标签优先：按标签优先级在标签后 100 字符窗口内逐数字候选，拒绝门槛/预期语境。
    返回 (score, ctx, rejectedCount)。"""
    for label in LABELS:
        rejected = 0
        pos = report.find(label)
        while pos != -1:
            window = report[pos + len(label): pos + len(label) + 100]
            for m in re.finditer(r'([0-9]{1,3}(?:\.[0-9]+)?)', window):
                after1 = window[m.end():m.end() + 1]
                before = report[max(0, pos + len(label) + m.start() - 6): pos + len(label) + m.start()]
                after_ctx = window[m.end():m.end() + 4]
                val = float(m.group(1))
                is_denominator = before.rstrip().endswith('/')          # “N / 100” 的分母 100
                is_range = bool(re.match(r'^\s*[-~至]\s*[0-9]', after_ctx))  # “70-84”/“70~84” 区间
                if (after1 != '%' and 5 <= val <= 100 and not is_denominator and not is_range
                        and not any(rk in before for rk in REJECT_BEFORE)
                        and not any(rk in after_ctx for rk in REJECT_AFTER)):
                    ctx = report[max(0, pos - 20): pos + len(label) + m.end() + 30].replace('\n', ' ')
                    return m.group(1), ctx, rejected
                rejected += 1
            pos = report.find(label, pos + 1)
    return None, None, None


def score_verdict_consistent(score, verdict):
    if score is None or verdict is None:
        return None
    s = float(score)
    expect = '可发布' if s >= 85 else ('需优化' if s >= 70 else '需重构')
    return verdict == expect


items = []
for i in range(N):
    r = R0 + i
    it = SEL['items'][i]
    ent = {
        'round': r, 'name': it['name'], 'kind': it.get('kind'),
        'relPath': it.get('relPath'),
    }
    main = OPT / f'evidence-r{r}'
    rec = None
    if main.is_dir():
        armed = sorted(main.glob('armed-*.json'))
        live = []
        for f in armed:
            try:
                d = json.loads(f.read_text(encoding='utf-8'))
            except json.JSONDecodeError:
                continue
            if d.get('mode') == 'live':
                live.append(d)
        ent['liveRecords'] = len(live)
        if live:
            rec = live[0]
    if rec is None:
        ent['void'] = True
        ent['note'] = 'main 目录无 live 记录'
        items.append(ent)
        continue
    report = rec.get('report') or ''
    ent['reportChars'] = rec.get('reportChars') or 0
    ent['replyChars'] = rec.get('replyChars') or 0
    has_report = bool(report.strip())
    ent['void'] = not has_report
    led = rec.get('ledger') or {}
    ent['attempts'] = led.get('attemptsSettled')
    ent['tokensAudit'] = file_tokens(led)
    ent['tokensSoft'] = led.get('observedTokenTotal', 0) or 0
    ent['embedded'] = {'attempts': ent['attempts'], 'tokensAudit': ent['tokensAudit']}
    if has_report:
        s1, c1 = extract_total_table(report)
        if s1 is not None and float(s1) >= 40:
            ent['score'], ent['method'], ent['ctx'] = s1, 'table', c1
        else:
            s2, c2, rej = extract_total_labeled(report)
            if s2 is not None:
                ent['score'], ent['method'], ent['ctx'] = s2, 'labeled', c2
                ent['rejectedCandidates'] = rej
            else:
                s3, c3 = extract_total_anchor(report)
                ent['score'], ent['method'], ent['ctx'] = s3, ('anchor' if s3 else None), c3
        # 一致时补记另一路读数供审计
        alt = None
        if ent.get('method') != 'labeled':
            alt, _, _ = extract_total_labeled(report)
        if alt is not None and ent.get('score') is not None and alt != ent['score']:
            ent['scoreAlt'] = alt
        ent['verdict'] = extract_verdict(report)
        consist = score_verdict_consistent(ent.get('score'), ent.get('verdict'))
        ent['consistent'] = consist
    else:
        # void 归因：finishKinds 末条 + 尝试档位
        fk = rec.get('finishKinds') or []
        maxatt = (led.get('limits') or {}).get('maxAttempts')
        if fk and all(k == 'tool-calls' for k in fk) and ent['attempts'] == maxatt:
            ent['voidClass'] = 'attempt-exhaustion'
        elif fk and str(fk[-1]).startswith('error:'):
            ent['voidClass'] = 'infra-flake'
        else:
            ent['voidClass'] = 'other'
        ent['voidTier'] = maxatt
    # void 补救目录（本轮主目录已含 void；此处仅统计 extras）
    void_dirs = sorted(OPT.glob(f'evidence-r{r}-void*'))
    if void_dirs:
        ent['voidDirs'] = [d.name for d in void_dirs]
        vt = va = 0
        for d in void_dirs:
            for f in d.glob('armed-*.json'):
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
    # 磁盘账本对照（读数与 void 一并核对）
    disk_files = sorted(OPT.glob(f'runs-r{r}/armed-*/batch/budget-ledger.json'))
    if disk_files:
        try:
            dd = json.loads(disk_files[0].read_text(encoding='utf-8'))
            ent['disk'] = {'attempts': dd.get('attemptsSettled'), 'tokensAudit': file_tokens(dd)}
            da = ent['disk']['attempts'] or 0
            dt = ent['disk']['tokensAudit'] or 0
            ea = ent.get('attempts') or 0
            et = ent.get('tokensAudit') or 0
            if da != ea:
                ent['ledgerDelta'] = f'attempts {ea} vs {da}'
            elif dt != et:
                ent['ledgerDelta'] = f'tokens {et} vs {dt}'
        except json.JSONDecodeError:
            ent['disk'] = 'unreadable'
    items.append(ent)

# —— 汇总 ——
readings = [e for e in items if not e.get('void')]
voids = [e for e in items if e.get('void')]
closed = [e for e in readings if e.get('score') is not None and float(e['score']) >= 85]
below = [e for e in readings if e.get('score') is None or float(e['score']) < 85]
no_score = [e for e in readings if e.get('score') is None]
inconsistent = [e for e in readings if e.get('consistent') is False]
ledger_mismatch = [e for e in items if e.get('ledgerDelta')]


def agg(es):
    return {
        'count': len(es),
        'tokensAudit': sum(e.get('tokensAudit', 0) or 0 for e in es),
        'tokensSoft': sum(e.get('tokensSoft', 0) or 0 for e in es),
        'attempts': sum(e.get('attempts', 0) or 0 for e in es),
    }


by_kind = {}
for k in ('fixed', 'clean'):
    es = [e for e in items if e.get('kind') == k]
    rs = [e for e in es if not e.get('void')]
    by_kind[k] = {
        'items': len(es),
        'closed': len([e for e in rs if e.get('score') and float(e['score']) >= 85]),
        'below': len([e for e in rs if not e.get('score') or float(e['score']) < 85]),
        'voids': len([e for e in es if e.get('void')]),
        **agg(es),
    }

# 补救前历史 void 耗（-void<M> 档；补救后主档为读数、历史耗在此单列）
void_extra = [e['voidExtra'] for e in items if e.get('voidExtra')]
void_extra_agg = {
    'count': len(void_extra),
    'tokensAudit': sum(v.get('tokensAudit', 0) or 0 for v in void_extra),
    'attempts': sum(v.get('attempts', 0) or 0 for v in void_extra),
}

summary = {
    'items': len(items),
    'readings': len(readings),
    'voids': len(voids),
    'voidClasses': {c: len([e for e in voids if e.get('voidClass') == c])
                    for c in ('infra-flake', 'attempt-exhaustion', 'other')},
    'closed': len(closed),
    'below': len(below),
    'noScore': len(no_score),
    'inconsistent': len(inconsistent),
    'ledgerMismatch': len(ledger_mismatch),
    'all': agg(items),
    'readingsAgg': agg(readings),
    'voidsAgg': agg(voids),
    'voidExtra': void_extra_agg,
    'grandTotalTokensAudit': agg(items)['tokensAudit'] + void_extra_agg['tokensAudit'],
    'byKind': by_kind,
}

out = {
    'record_type': 'p2_wave1_closeout',
    'scope': f'r{R0}-r{R0 + N - 1}',
    'generatedBy': 'fix-plans/p2-wave1-closeout.py',
    'method': 'score/verdict 从 report 正文（表行优先＋锚定回退）；tokens 审计口径＝四字段和，软停口径＝observedTokenTotal；void＝reportChars==0；逐件与 runs-r* 磁盘账本对照；补救后历史 void 耗单列 voidExtra（-void<M> 档），grandTotal＝主档＋历史档。',
    'summary': summary,
    'items': items,
}
(BASE / 'p2-wave1-closeout.json').write_text(
    json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')

cols = ['r', 'name', 'kind', 'reportChars', 'verdict', 'score', 'method', 'consistent',
        'attempts', 'tokensAudit', 'tokensSoft', 'void', 'voidExtraAtt', 'voidExtraTok',
        'ledgerDelta', 'note']
with (BASE / 'p2-wave1-results.csv').open('w', newline='', encoding='utf-8') as fh:
    w = csv.writer(fh)
    w.writerow(cols)
    for e in items:
        ve = e.get('voidExtra') or {}
        w.writerow([
            e['round'], e['name'], e.get('kind', ''), e.get('reportChars', ''),
            e.get('verdict') or '', e.get('score') or '', e.get('method') or '',
            '' if e.get('consistent') is None else ('Y' if e['consistent'] else 'N'),
            e.get('attempts', ''), e.get('tokensAudit', ''), e.get('tokensSoft', ''),
            'Y' if e.get('void') else '', ve.get('attempts', ''), ve.get('tokensAudit', ''),
            e.get('ledgerDelta', ''), e.get('note', ''),
        ])

print(json.dumps(summary, ensure_ascii=False, indent=1))
print('noScore:', [(e['round'], e['name']) for e in no_score])
print('inconsistent:', [(e['round'], e['name'], e.get('score'), e.get('verdict')) for e in inconsistent])
print('ledgerMismatch:', [(e['round'], e['name'], e.get('ledgerDelta')) for e in ledger_mismatch])
print('voids:', [(e['round'], e['name']) for e in voids])
