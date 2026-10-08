#!/usr/bin/env python3
"""容器 2 件恢复批 —— 候选构建器（零请求、幂等、逐字节）

把 recovered-from-upstream/<name>/SKILL.md 逐字节复制到
opt-run/candidates/<name>-gen1/SKILL.md（恢复件＝上游原文，verbatim，不做任何归一）。
已存在且一致 → skip；已存在但不一致 → 报错（--force 覆盖）。

同时产出草稿回执 receipts/c3r-draft-receipt.json（含上游 pin 与 treeDigest 冻结）。

用法：python3 -B c3r-build.py [--force] [--name <name>]
"""
import argparse
import hashlib
import json
import shutil
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve()


def find_root(start: Path) -> Path:
    for anc in (start, *start.parents):
        if (anc / 'skill-lifecycle').is_dir() and (anc / 'docs').is_dir():
            return anc
    raise SystemExit(f'仓根未发现（从 {start} 上溯）')


ROOT = find_root(HERE)                      # 思维库/skill管理（动态发现，防层数写死）
SALV = HERE.parents[1]                      # container3-salvage
SRC = SALV / 'recovered-from-upstream'
CAND = ROOT / 'skill-lifecycle' / 'trial-home' / 'opt-run' / 'candidates'
OUT = SALV / 'receipts'

UPSTREAM = {
    'ecommerce-marketing-strategy-builder': {
        'repo': 'nexscope-ai/eCommerce-Skills',
        'path': 'ecommerce-marketing-strategy-builder/SKILL.md',
        'commit': '0419aee14305551df5c9fb9b9590ff785e85f43b',
        'commitDate': '2026-04-09',
        'license': 'MIT（仓库级）',
    },
    'tiktok-influencer-marketing': {
        'repo': 'nexscope-ai/eCommerce-Skills',
        'path': 'tiktok-influencer-marketing/SKILL.md',
        'commit': 'd4bcacb0bdc4e0bc1c67a92a07cb91974688f478',
        'commitDate': '2026-06-08',
        'license': 'MIT（仓库级）',
    },
}
ITEMS = list(UPSTREAM)
FAILURES = []


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def tree_digest(root: Path) -> str:
    """冻结口径（沿用 gsd2 prefire）：rglob 排序 relpath\\tSHA256 以 \\n 串接、无尾换行。"""
    rows = []
    for p in sorted(root.rglob('*')):
        if p.is_file():
            rows.append(f'{p.relative_to(root).as_posix()}\t{sha256_file(p)}')
    return hashlib.sha256('\n'.join(rows).encode('utf-8')).hexdigest()


def build_one(name: str, force: bool):
    src = SRC / name / 'SKILL.md'
    dst = CAND / f'{name}-gen1' / 'SKILL.md'
    print(f'=== {name} ===')
    if not src.is_file():
        FAILURES.append(f'恢复件不存在：{src}')
        return None
    src_sha = sha256_file(src)
    if dst.exists():
        if sha256_file(dst) == src_sha:
            print('  [skip] 候选已一致')
        elif not force:
            FAILURES.append(f'候选已存在且不一致（需 --force）：{dst}')
            return None
        else:
            shutil.copyfile(src, dst)
            print('  [ok] --force 覆盖')
    else:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        print('  [ok] 新建')
    dst_sha = sha256_file(dst)
    if dst_sha != src_sha:
        FAILURES.append(f'复制后 sha 不一致：{name}')
        return None
    return {'name': name, 'source': str(src.relative_to(ROOT)), 'sourceSha256': src_sha,
            'candidate': str(dst.parent.relative_to(ROOT)), 'candSha256': dst_sha,
            'bytes': dst.stat().st_size,
            'treeDigest': tree_digest(dst.parent), 'upstream': UPSTREAM[name]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--name')
    args = ap.parse_args()
    names = [args.name] if args.name else ITEMS
    for name in names:
        if name not in UPSTREAM:
            print(f'未知件：{name}')
            sys.exit(2)
    items = []
    for name in names:
        rec = build_one(name, args.force)
        if rec:
            items.append(rec)
    print()
    if FAILURES:
        print(f'RESULT: FAIL（{len(FAILURES)} 项）')
        for f in FAILURES:
            print('  -', f)
        sys.exit(1)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'c3r-draft-receipt.json').write_text(json.dumps(
        {'record_type': 'c3r_draft_receipt', 'at': date.today().isoformat(),
         'note': '容器 2 件恢复批：上游原文 verbatim 候选（无归一、无改写）；treeDigest 口径同 gsd2 prefire',
         'items': items}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('RESULT: PASS（候选构建完成/幂等跳过；草稿回执已写）')


if __name__ == '__main__':
    main()
