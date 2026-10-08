#!/usr/bin/env python3
"""LB-7 切片冻结（零请求）：<60 带 112 件 → selection.json ＋ 逐件靶单 ＋ fire.tsv。

用法：python3 -B lowband-lb7/make-freeze.py
输入：lowband-triage-sub60/triage.json（分诊）＋ opt-run/evidence-r{wave2Round}/armed-*.json（判者原文）
                                     ＋ opt-run/r{wave2Round}/stage.json（交付文件数定档）
"""
import json
import re
import pathlib

BASE = pathlib.Path(__file__).resolve().parent      # lowband-lb7/
ROOT = BASE.parents[0]                              # 143-library-normalize/
OPT = pathlib.Path('/Users/lute/project/AgentTools/思维库/skill管理/skill-lifecycle/trial-home/opt-run')
R0 = 1500                                            # 主批起始轮次（r1500–r1611）
TRIAGE = ROOT / 'lowband-triage-sub60/triage.json'


def judge_report(round_no):
    ev = OPT / f'evidence-r{round_no}'
    files = sorted(ev.glob('armed-*.json')) if ev.is_dir() else []
    if not files:
        return None
    return json.loads(files[-1].read_text(encoding='utf-8'))


def main():
    items = json.loads(TRIAGE.read_text(encoding='utf-8'))['items']
    items.sort(key=lambda x: x['name'].lower())
    targets = BASE / 'targets'
    targets.mkdir(exist_ok=True)
    sel, rows, missing = [], [], []
    for i, it in enumerate(items):
        rec = judge_report(it['round'])
        if rec is None:
            missing.append(it['name'])
            continue
        rep = rec.get('report') or ''
        st = OPT / f"r{it['round']}/stage.json"
        delivered = json.loads(st.read_text(encoding='utf-8')).get('delivered') if st.exists() else None
        rnd = R0 + i
        (targets / f"{it['name']}.md").write_text(
            f"# {it['name']}（wave-2 r{it['round']}；{it['score']} {it.get('verdict') or ''}；"
            f"材料 {it['materialBytes']}B；报告 {len(rep)} 字符）\n\n{rep.strip()}\n", encoding='utf-8')
        entry = {'round': rnd, 'name': it['name'], 'kind': it['kind'], 'score': it['score'],
                 'verdict': it.get('verdict'), 'relPath': it['relPath'],
                 'tier': 'small' if (delivered or 0) <= 6 else 'large',
                 'materialBytes': it['materialBytes'], 'wave2Round': it['round'],
                 'delivered': delivered, 'targetFile': f'lowband-lb7/targets/{it["name"]}.md'}
        sel.append(entry)
        att, tok = (12, 80000) if entry['tier'] == 'small' else (40, 240000)
        rows.append(f'{rnd}\t{it["name"]}\t{att}\t{tok}')
    (BASE / 'selection.json').write_text(json.dumps(
        {'record_type': 'p2_lb7_selection', 'at': '2026-10-03', 'band': 'sub-60',
         'count': len(sel), 'r0': R0, 'items': sel, 'missing_evidence': missing},
        ensure_ascii=False, indent=1), encoding='utf-8')
    (BASE / 'fire.tsv').write_text('\n'.join(rows) + '\n', encoding='utf-8')
    small = sum(1 for s in sel if s['tier'] == 'small')
    print(f'冻结件数 = {len(sel)}（small {small}／large {len(sel)-small}）；缺判者原文 = {missing}')
    print(f'轮次 = r{R0}–r{R0 + len(sel) - 1}；靶单目录 = lowband-lb7/targets/；发射清单 = lowband-lb7/fire.tsv')


if __name__ == '__main__':
    main()
