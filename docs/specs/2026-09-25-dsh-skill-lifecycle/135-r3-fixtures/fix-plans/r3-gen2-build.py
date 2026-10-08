#!/usr/bin/env python3
"""R-3 去向①夹具增强批 —— gen2 候选构建器（零请求、幂等、逐项断言）

对五件执行三类操作：
  ① 基线复制：源库现行版 → candidates/<name>-gen2（排除 .DS_Store / .assembly-meta.json）
  ② 资产落盘：135-r3-fixtures/assets/<name>/ 下的新文件逐字节复制进候选
     （已存在且一致 → skip；已存在但不一致 → 报错，除非 --force）
  ③ SKILL.md 引用行 patch（对账族三件：在 Reference files 表锚行后插入算例行；
     断言行存在 → skip；锚行不存在 → 报错）

源库（= 写回目标同源）：
  reconciliation / journal-entry-prep / cash-flow-snapshot → 技能库/skills-genspark/<name>/
  supplier-evaluation / inventory-demand-forecaster        → 技能库/81-Skills/<name>/

用法：python3 -B r3-gen2-build.py [--force] [--name <name>]
"""
import argparse
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
ROOT = HERE.parents[5]                      # 思维库/skill管理
LIB = HERE.parents[7] / '技能库'             # AgentTools/技能库
ASSETS = HERE.parents[1] / 'assets'
CAND = ROOT / 'skill-lifecycle' / 'trial-home' / 'opt-run' / 'candidates'

EXCLUDE = {'.DS_Store', '.assembly-meta.json'}

# 件 → (源库相对路径, SKILL.md 锚行, 新引用行)
ITEMS = {
    'reconciliation': (
        'skills-genspark/reconciliation',
        '| `references/examples/bank-rec-example.md` |',
        '| `references/examples/channel-settlement-example.md` | Two-channel multi-currency settlement reconciliation — batch-line arithmetic, clawback checks, in-transit classification |',
    ),
    'journal-entry-prep': (
        'skills-genspark/journal-entry-prep',
        '| `references/examples/month-end-accrual-example.md` |',
        '| `references/examples/settlement-journal-example.md` | Booking platform settlement batches and payouts (receivable / bank / revenue) with facilitator VAT memo |',
    ),
    'cash-flow-snapshot': (
        'skills-genspark/cash-flow-snapshot',
        '| `references/examples/worked-example.md` |',
        '| `references/examples/settlement-cash-timing-example.md` | Modeling settlement in-transit, payout cadence and committed spend in the 30/60/90 view |',
    ),
    'supplier-evaluation': (
        '81-Skills/supplier-evaluation',
        None, None,
    ),
    'inventory-demand-forecaster': (
        '81-Skills/inventory-demand-forecaster',
        None, None,
    ),
}

FAILURES = []


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
        FAILURES.append(f'{label}: 目标已存在且不一致（需 --force 覆盖）：{dst}')
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    print(f'  [ok] {label}')


def patch_skill_md(cand: Path, anchor: str, new_line: str, force: bool):
    skill = cand / 'SKILL.md'
    text = skill.read_text(encoding='utf-8')
    if new_line + '\n' in text:
        print('  [skip] SKILL.md 引用行（已应用）')
        return
    if anchor not in text:
        FAILURES.append(f'SKILL.md 锚行不存在：{anchor[:60]}…')
        return
    lines = text.splitlines(keepends=True)
    out = []
    inserted = False
    for ln in lines:
        out.append(ln)
        if not inserted and ln.startswith(anchor):
            out.append(new_line + '\n')
            inserted = True
    if not inserted:
        FAILURES.append('锚行定位失败（未插入）')
        return
    skill.write_text(''.join(out), encoding='utf-8')
    print('  [ok] SKILL.md 引用行插入')


def build_one(name: str, force: bool):
    src_rel, anchor, new_line = ITEMS[name]
    src = LIB / src_rel
    cand = CAND / f'{name}-gen2'
    print(f'=== {name} → {cand.name} ===')
    if not src.is_dir():
        FAILURES.append(f'源库不存在：{src}')
        return
    if not cand.exists():
        copytree(src, cand)
        print(f'  [ok] 基线复制（{sum(1 for p in cand.rglob("*") if p.is_file())} 文件）')
    else:
        print('  [skip] 候选已存在（幂等复跑）')
    # 资产落盘
    aroot = ASSETS / name
    n = 0
    for p in sorted(aroot.rglob('*')):
        if p.is_file():
            rel = p.relative_to(aroot)
            copy_asset_file(p, cand / rel, force, f'资产 {rel}')
            n += 1
    print(f'  [ok] 资产处理 {n} 件')
    # SKILL.md patch（仅对账族）
    if anchor:
        patch_skill_md(cand, anchor, new_line, force)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true', help='覆盖已存在且不一致的资产文件')
    ap.add_argument('--name', help='只处理单件')
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
