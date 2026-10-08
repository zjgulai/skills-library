#!/usr/bin/env python3
"""近失带试点准备（零请求）：选单冻结＋修复靶单抽取＋成本估算。

输入：fix-plans/p2-wave1-closeout.json（100/100 读数）
输出：nearmiss-pilot/selection.json（17 件：轮号/分数/路径/材料量/档位）
     nearmiss-pilot/targets/<name>.md（逐件判者问题区文本，供修复采信）
     stdout：成本估算

用法：python3 -B make-pilot.py
"""
import json
import re
from pathlib import Path

BASE = Path(__file__).resolve().parent                    # nearmiss-pilot/
FIX = BASE.parent / 'fix-plans'
OPT = Path('/Users/lute/project/AgentTools/思维库/skill管理/skill-lifecycle/trial-home/opt-run')
LIB = Path('/Users/lute/project/AgentTools/技能库')

close = json.loads((FIX / 'p2-wave1-closeout.json').read_text(encoding='utf-8'))

near = [e for e in close['items'] if e.get('score') and 80 <= float(e['score']) < 85]
near.sort(key=lambda e: float(e['score']))

targets_dir = BASE / 'targets'
targets_dir.mkdir(parents=True, exist_ok=True)

items = []
for e in near:
    r = e['round']
    rec = json.loads(next((OPT / f'evidence-r{r}').glob('armed-*.json')).read_text(encoding='utf-8'))
    rep = rec.get('report') or ''
    mat_bytes = sum(m.get('bytes', 0) for m in rec.get('materials', []))
    tier = 'small' if (rec.get('ledger', {}).get('limits', {}).get('maxAttempts') == 12) else 'large'

    # 问题区抽取：行含「问题」/「严重度」/「修复建议」/error 级锚点；连续块拼接（上限 6000 字符）
    lines = rep.splitlines()
    keep = []
    buf = 0
    in_prob = False
    for ln in lines:
        t = ln.strip()
        hit = bool(re.search(r'^#{1,4}\s*[一二三四五六]?[、.]?\s*问题|^#{1,4}\s*.{0,12}(修复建议|问题清单|缺陷|阻断)', t)) \
            or ('严重度' in t and ('error' in t.lower() or 'warning' in t.lower() or '信息' in t or '建议' in t)) \
            or bool(re.match(r'^\*\*问题\s*\d+', t)) or bool(re.match(r'^###\s*问题', t)) \
            or bool(re.match(r'^\d+\.\s*\*\*(必需|推荐|修复|Schema|Missing|缺)', t))
        if hit:
            in_prob = True
        if in_prob:
            keep.append(ln)
            buf += len(ln)
            if buf > 6000:
                in_prob = False
    if not keep:
        keep = lines[-120:]
    txt = f'# {e["name"]}（r{r}；{e["score"]} {e.get("verdict")}；{tier}；材料 {mat_bytes}B）\n\n' + '\n'.join(keep)
    (targets_dir / f'{e["name"]}.md').write_text(txt + '\n', encoding='utf-8')

    items.append({
        'round': r, 'name': e['name'], 'kind': e.get('kind'), 'score': float(e['score']),
        'verdict': e.get('verdict'), 'relPath': e.get('relPath'), 'tier': tier,
        'materialBytes': mat_bytes, 'reportChars': e.get('reportChars'),
        'targetFile': f'targets/{e["name"]}.md',
    })

sel = {
    'record_type': 'p2_nearmiss_pilot_selection',
    'at': '2026-10-02',
    'basis': 'wave-1 收口 100/100 读数中 80≤score<85 的全部 17 件（按分数升序）',
    'rounds': 'r518–r534（复评）；重跑备留 r535+',
    'items': items,
}
(BASE / 'selection.json').write_text(json.dumps(sel, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')

# 成本估算：复评一跑 ≈ wave-1 分档均价（小 41.5k / 大 131.6k，审计口径）
small_avg, large_avg = 41537, 131632
est = sum(small_avg if it['tier'] == 'small' else large_avg for it in items)
n_small = sum(1 for it in items if it['tier'] == 'small')
print(json.dumps({
    'items': len(items), 'small': n_small, 'large': len(items) - n_small,
    'evalOneRoundEst': est,
    'withRerunBufferEst': round(est * 1.5),
    'note': '复评一跑估算；重跑/近线复验按 +50% 缓冲。修复编辑（agent 侧）不计入该口径。',
}, ensure_ascii=False, indent=1))
print('selection written; targets:', len(items))
for it in items:
    print(f"  r{it['round']} {it['name']}: {it['score']} [{it['tier']}] {it['materialBytes']}B")
