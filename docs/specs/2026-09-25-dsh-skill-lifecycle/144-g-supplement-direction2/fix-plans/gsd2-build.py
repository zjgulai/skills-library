#!/usr/bin/env python3
"""G 续补去向②新技能制作 —— gen1 候选构建器（零请求、幂等）

把 assets/<name>/ 下的起草内容复制到 candidates/<name>-gen1/（新制作候选，无库内基线）。
已存在且一致 → skip；已存在但不一致 → 报错（--force 覆盖）。

用法：python3 -B gsd2-build.py [--force] [--name <name>]
"""
import argparse
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
ROOT = HERE.parents[5]                      # 思维库/skill管理
ASSETS = HERE.parents[1] / 'assets'
CAND = ROOT / 'skill-lifecycle' / 'trial-home' / 'opt-run' / 'candidates'

ITEMS = ['management-decision-package', 'scenario-governance-review',
         'storefront-sellability-check', 'account-health-appeal',
         'metric-contract-governance', 'experiment-adoption-gate',
         'tool-contract-governance']
FAILURES = []


def copy_asset(src: Path, dst: Path, force: bool, label: str):
    if dst.exists() and dst.read_bytes() == src.read_bytes():
        print(f'  [skip] {label}（已一致）')
        return
    if dst.exists() and not force:
        FAILURES.append(f'{label}: 目标已存在且不一致（需 --force）：{dst}')
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    print(f'  [ok] {label}')


def build_one(name: str, force: bool):
    src = ASSETS / name
    dst = CAND / f'{name}-gen1'
    print(f'=== {name} → {dst.name} ===')
    if not src.is_dir():
        FAILURES.append(f'assets 不存在：{src}')
        return
    n = 0
    for p in sorted(src.rglob('*')):
        if p.is_file():
            copy_asset(p, dst / p.relative_to(src), force, f'{p.relative_to(src)}')
            n += 1
    print(f'  [ok] 资产处理 {n} 件')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--name')
    args = ap.parse_args()
    names = [args.name] if args.name else ITEMS
    for name in names:
        if name not in ITEMS:
            print(f'未知件：{name}')
            sys.exit(2)
    for name in names:
        build_one(name, args.force)
    print()
    if FAILURES:
        print(f'RESULT: FAIL（{len(FAILURES)} 项）')
        for f in FAILURES:
            print('  -', f)
        sys.exit(1)
    print('RESULT: PASS（全部构建完成/幂等跳过）')


if __name__ == '__main__':
    main()
