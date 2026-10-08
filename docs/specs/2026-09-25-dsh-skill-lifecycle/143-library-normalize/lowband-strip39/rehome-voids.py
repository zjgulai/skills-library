#!/usr/bin/env python3
"""把 strip39 重认轮次主目录里的空报告移档到 -voidN（只移不删；N 递增探测未占位）。

probe-b 的 skip 逻辑是「recordPath 已存在即跳过」——主目录留着空报告会让重跑被静默
跳过（r1700 实例）。移档后轮次原位可重跑；报告非空（reportChars>0 且 report 非空）
的目录不动。仅处理 recert-fire.tsv 范围内的 4 位轮号（evidence-r{R} 精确匹配）。

用法：python3 -B rehome-voids.py
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
NORM = HERE.parent
REPO = NORM.parent.parent.parent.parent
OPT = REPO / 'skill-lifecycle/trial-home/opt-run'
FULL = HERE / 'recert-fire.tsv'


def main():
    rounds = [int(ln.split('\t')[0]) for ln in FULL.read_text(encoding='utf-8').splitlines() if ln.strip()]
    moved, kept = [], []
    for r in rounds:
        d = OPT / f'evidence-r{r}'
        if not d.is_dir():
            continue
        files = sorted(d.glob('*.json'))
        if not files:
            continue
        try:
            rec = json.loads(files[0].read_text(encoding='utf-8'))
        except Exception as e:
            print(f'r{r}: 读取失败（{e}）——保留不动', file=sys.stderr)
            continue
        if (rec.get('reportChars') or 0) > 0 and rec.get('report'):
            kept.append(r)
            continue
        n = 1
        while (OPT / f'evidence-r{r}-void{n}').exists():
            n += 1
        target = OPT / f'evidence-r{r}-void{n}'
        d.rename(target)
        moved.append(f'r{r} → {target.name}')
    print(f'移档 {len(moved)} 个空报告档' + (f'；保留非空 {len(kept)} 个' if kept else ''))
    for m in moved:
        print('  ', m)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
