#!/usr/bin/env python3
"""P2 wave-1 void 补救收口账目生成器（零请求）。

输入：fix-plans/p2-wave1-closeout-preremedy.json（冻结的补救前快照：void 归因/历史耗）
     ＋ fix-plans/p2-wave1-closeout.json（补救后重生成：主档读数＋voidExtra）
输出：receipts/p2-wave1-void-register.json（逐件合并账目＋总账＋对照估算）

用法（批流完成后）：python3 -B p2-wave1-void-register.py
"""
import json
from pathlib import Path

BASE = Path(__file__).resolve().parent                     # fix-plans/
ROOT = BASE.parents[1]                                     # dsh-skill-lifecycle/
OUT_DIR = BASE.parent / 'receipts'

pre = json.loads((BASE / 'p2-wave1-closeout-preremedy.json').read_text(encoding='utf-8'))
post = json.loads((BASE / 'p2-wave1-closeout.json').read_text(encoding='utf-8'))

pre_by_round = {e['round']: e for e in pre['items']}
post_by_round = {e['round']: e for e in post['items']}

void_rounds = sorted(e['round'] for e in pre['items'] if e.get('void'))
rows = []
for r in void_rounds:
    a, b = pre_by_round[r], post_by_round[r]
    ve = b.get('voidExtra') or {}
    row = {
        'round': r,
        'name': a['name'],
        'kind': a.get('kind'),
        'voidClass': a.get('voidClass'),
        'originalTier': a.get('voidTier'),
        'originalAttempts': a.get('attempts'),
        'originalTokensAudit': a.get('tokensAudit'),
        'remedyTier': 40 if a.get('voidClass') == 'attempt-exhaustion' else 12,
        'remedyAttempts': b.get('attempts') if not b.get('void') else None,
        'remedyTokensAudit': b.get('tokensAudit') if not b.get('void') else None,
        'remedyVerdict': b.get('verdict'),
        'remedyScore': b.get('score'),
        'remedyClosed': bool(b.get('score') and float(b['score']) >= 85),
        'stillVoid': bool(b.get('void')),
        'ledgerDelta': b.get('ledgerDelta') or '',
        'voidExtraFromDir': ve,
    }
    rows.append(row)

remedy_only = sum(r['remedyTokensAudit'] or 0 for r in rows)
remedy_att = sum(r['remedyAttempts'] or 0 for r in rows)
orig_spend = sum(r['originalTokensAudit'] or 0 for r in rows)
still = [r for r in rows if r['stillVoid']]
closed_new = [r for r in rows if r['remedyClosed']]

register = {
    'record_type': 'p2_wave1_void_register',
    'scope': f'wave-1 void 补救（{len(void_rounds)} 件；r418–r517 内）',
    'method': 'void 归因来自补救前快照（-void1 档内嵌账本）；补救结果来自重跑主档；'
              'totals.waveGrand ＝补救后 closeout 的 grandTotalTokensAudit（100 主档＋12 历史 void 档）。',
    'estimate': {'central': 1129109, 'range': [903287, 1806574], 'note': '按分档读数均价估算；上限按 G 批重跑尝试数（27/23）外推。'},
    'rows': rows,
    'totals': {
        'items': len(rows),
        'remedied': len(rows) - len(still),
        'stillVoid': len(still),
        'newClosed': len(closed_new),
        'originalVoidSpend': orig_spend,
        'remedySpend': remedy_only,
        'remedyAttempts': remedy_att,
        'waveGrandTokensAudit': post['summary'].get('grandTotalTokensAudit'),
    },
}

OUT_DIR.mkdir(parents=True, exist_ok=True)
(OUT_DIR / 'p2-wave1-void-register.json').write_text(
    json.dumps(register, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')

print(json.dumps(register['totals'], ensure_ascii=False, indent=1))
print('stillVoid:', [(r['round'], r['name']) for r in still])
print('newClosed:', [(r['round'], r['name'], r['remedyScore']) for r in closed_new])
print('register written:', OUT_DIR / 'p2-wave1-void-register.json')
