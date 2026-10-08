#!/usr/bin/env python3
"""近失带修复批 / LB-1/2/3/4 回执生成（零请求）：读 closeout.json（含重试腿）产 receipts/*.json。

用法：python3 -B make-receipt.py nearmiss2|lb1|lb2|lb3|lb4
"""
import json
import sys
from pathlib import Path

NORM = Path(__file__).resolve().parents[1]          # 143-library-normalize/
BATCHES = {
    'nearmiss2': dict(
        dirn='nearmiss-pilot2',
        out='receipts/p2-nearmiss2-receipt.json',
        record_type='p2_nearmiss2_receipt',
        scope='近失带 80–84.99 件 51 件（wave-2 内）；主批 r997–r1047 ＋ void 补救 ＋ 重试腿',
        estimate_one=3830192, estimate_buffer=5745288),
    'lb1': dict(
        dirn='lowband-lb1',
        out='receipts/p2-lb1-receipt.json',
        record_type='p2_lb1_receipt',
        scope='低带选择性修复 LB-1：79–79.99 件 18 件；主批 r1100–r1117 ＋ void 补救 ＋ 重试腿',
        estimate_one=None, estimate_buffer=None),
    'lb2': dict(
        dirn='lowband-lb2',
        out='receipts/p2-lb2-receipt.json',
        record_type='p2_lb2_receipt',
        scope='低带选择性修复 LB-2：78–78.99 件 49 件；主批 r1130–r1178 ＋ void 补救 ＋ 重试腿',
        estimate_one=None, estimate_buffer=None),
    'lb3': dict(
        dirn='lowband-lb3',
        out='receipts/p2-lb3-receipt.json',
        record_type='p2_lb3_receipt',
        scope='低带选择性修复 LB-3：76–77.99 件 75 件；主批 r1200–r1274 ＋ void 补救 ＋ 重试腿',
        estimate_one=None, estimate_buffer=None),
    'lb4': dict(
        dirn='lowband-lb4',
        out='receipts/p2-lb4-receipt.json',
        record_type='p2_lb4_receipt',
        scope='低带选择性修复 LB-4：75.0–75.99 件 14 件；主批 r1290–r1303 ＋ void 补救 ＋ 重试腿',
        estimate_one=None, estimate_buffer=None),
    'lb5': dict(
        dirn='lowband-lb5',
        out='receipts/p2-lb5-receipt.json',
        record_type='p2_lb5_receipt',
        scope='低带选择性修复 LB-5：70–74.99 件 74 件；主批 r1320–r1393 ＋ void 补救 ＋ 重试腿',
        estimate_one=None, estimate_buffer=None),
    'lb6': dict(
        dirn='lowband-lb6',
        out='receipts/p2-lb6-receipt.json',
        record_type='p2_lb6_receipt',
        scope='低带选择性修复 LB-6：60–69 件 58 件；主批 r1420–r1477 ＋ void 补救 ＋ 重试腿',
        estimate_one=None, estimate_buffer=None),
    'lb7': dict(
        dirn='lowband-lb7',
        out='receipts/p2-lb7-receipt.json',
        record_type='p2_lb7_receipt',
        scope='低带选择性修复 LB-7：<60 分带 112 件；主批 r1500–r1611（108 腿）＋ D2 尾腿 3 ＋ void 补救 3 ＋ 重认腿 r1620–r1627',
        estimate_one=None, estimate_buffer=None),
}


def main():
    batch = sys.argv[1]
    cfg = BATCHES[batch]
    base = NORM / cfg['dirn']
    c = json.loads((base / 'closeout.json').read_text(encoding='utf-8'))
    sel = json.loads((base / 'selection.json').read_text(encoding='utf-8'))

    by_name = {}
    for e in c['rows']:
        by_name.setdefault(e['name'], []).append(e)

    items = []
    for it in sel['items']:
        name = it['name']
        legs = by_name.get(name, [])
        legs = sorted(legs, key=lambda x: x['round'])
        main = next((x for x in legs if x.get('leg') == 'main'), legs[0] if legs else None)
        final = None
        for x in legs:
            if x.get('status') == 'reading':
                final = x
        void_tok = sum((x.get('voidExtra') or {}).get('tokensAudit', 0) for x in legs)
        void_att = sum((x.get('voidExtra') or {}).get('attempts', 0) for x in legs)
        tok = sum((x.get('tokensAudit') or 0) for x in legs) + void_tok
        att = sum((x.get('attempts') or 0) for x in legs)
        items.append({
            'name': name,
            'rounds': [x['round'] for x in legs],
            'legs': [x.get('leg') for x in legs],
            'firstPassClosed': bool(main and main.get('closed')),
            'firstPassScore': main.get('score') if main else None,
            'finalScore': final.get('score') if final else None,
            'finalVerdict': final.get('verdict') if final else None,
            'finalClosed': bool(final and final.get('closed')),
            'tokensAudit': tok,
            'attempts': att,
            'voidExtra': {'tokensAudit': void_tok, 'attempts': void_att} if void_tok else None,
        })

    s = c['summary']
    n = len(items)
    tok_total = sum(x['tokensAudit'] for x in items)
    att_total = sum(x['attempts'] for x in items)
    summary = {
        'items': n,
        'evalRuns': len(c['rows']),
        'firstPassClosed': s.get('firstPassClosed'),
        'firstPassRate': round(s.get('firstPassClosed', 0) / n, 4) if n else None,
        'finalClosed': s.get('finalClosed'),
        'finalOpen': s.get('finalOpen'),
        'voidsRemaining': s.get('voids'),
        'tokensAuditTotal': tok_total,
        'attemptsTotal': att_total,
        'tokensPerItem': round(tok_total / n) if n else None,
    }
    if cfg.get('estimate_one'):
        summary['estimateOneRound'] = cfg['estimate_one']
        summary['estimateWithBuffer'] = cfg['estimate_buffer']
    out = {
        'record_type': cfg['record_type'],
        'scope': cfg['scope'],
        'method': '逐件：gen1 修复候选 → 单跑复评；未过者 gen2+（判者反馈定向补丁）重试；void 移档同轮重跑（升档）。成本＝审计口径（四字段和），含 voidExtra。',
        'summary': summary,
        'items': items,
    }
    dst = NORM / cfg['out']
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    print('written:', dst)


if __name__ == '__main__':
    main()
