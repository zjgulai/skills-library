#!/usr/bin/env python3
"""G 收官批·三族夹具增强 —— 候选构建器（零请求、幂等）

对五件执行：
  ① 基线复制：源库现行版 → candidates/<name>-genN（N=已有最高代+1；排除 .DS_Store/.assembly-meta.json）
  ② 资产落盘：137-g-fixtures/assets/<name>/ 下新文件逐字节复制进候选
     （已存在且一致 → skip；已存在但不一致 → 报错，除非 --force）

源库（批一计划 sourceDir）：
  tech-pack-generator → 技能库/81-Skills/
  contract-review / customer-escalation / legal-risk-assessment → 技能库/skills-genspark/
  customer-reply-craft → 技能库/skills/kimi/skills/

用法：python3 -B gfixtures-build.py [--force] [--name <name>]
"""
import argparse
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
ROOT = HERE.parents[5]                      # 思维库/skill管理
LIB = HERE.parents[7] / '技能库'             # AgentTools/技能库
ASSETS = HERE.parents[1] / 'assets'
CAND = ROOT / 'skill-lifecycle' / 'trial-home' / 'opt-run' / 'candidates'

EXCLUDE = {'.DS_Store', '.assembly-meta.json'}

ITEMS = {
    'tech-pack-generator': '81-Skills/tech-pack-generator',
    'customer-reply-craft': 'skills/kimi/skills/customer-reply-craft',
    'customer-escalation': 'skills-genspark/customer-escalation',
    'contract-review': 'skills-genspark/contract-review',
    'compliance-check': 'skills-genspark/compliance-check',
}

FAILURES = []


def target_gen(name: str) -> int:
    """本批目标代数：含本批资产签名的最新一代；若无则最高代+1。
    签名法保证幂等复跑命中同一目标（不复建新代）。"""
    sig = [str(p.relative_to(ASSETS / name)) for p in (ASSETS / name).rglob('*') if p.is_file()]
    pat = re.compile(rf'^{re.escape(name)}-gen(\d+)$')
    gens = sorted((int(m.group(1)), p) for p in CAND.iterdir()
                  if p.is_dir() and (m := pat.match(p.name)))
    for g, p in reversed(gens):
        if any((p / s).exists() for s in sig):
            return g
    return (gens[-1][0] + 1) if gens else 1


def copytree(src: Path, dst: Path):
    dst.mkdir(parents=True, exist_ok=True)
    for p in sorted(src.rglob('*')):
        if p.name in EXCLUDE:
            continue
        rel = p.relative_to(src)
        target = dst / rel
        if p.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            shutil.copy2(p, target)


def copy_asset_file(src: Path, dst: Path, force: bool, label: str):
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
    src = LIB / ITEMS[name]
    gen = target_gen(name)
    cand = CAND / f'{name}-gen{gen}'
    print(f'=== {name} → {cand.name} ===')
    if not src.is_dir():
        FAILURES.append(f'源库不存在：{src}')
        return
    if not cand.exists():
        copytree(src, cand)
        print(f'  [ok] 基线复制（{sum(1 for p in cand.rglob("*") if p.is_file())} 文件）')
    else:
        print('  [skip] 候选已存在（幂等复跑）')
    aroot = ASSETS / name
    n = 0
    for p in sorted(aroot.rglob('*')):
        if p.is_file():
            copy_asset_file(p, cand / p.relative_to(aroot), force, f'资产 {p.relative_to(aroot)}')
            n += 1
    print(f'  [ok] 资产处理 {n} 件')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--name')
    args = ap.parse_args()
    names = [args.name] if args.name else list(ITEMS)
    for name in names:
        if name not in ITEMS:
            print(f'未知件：{name}')
            sys.exit(2)
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
