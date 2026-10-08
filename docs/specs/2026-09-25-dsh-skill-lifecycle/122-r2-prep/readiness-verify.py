#!/usr/bin/env python3
"""R-2 就绪收据复核（零请求）：重算 readiness-receipt-v1.json 的全部 pin 与选单件身份，报告漂移。

用法：python3 -B readiness-verify.py [--receipt <json>] [--library <技能库根>]
退出码：0 全一致；1 有漂移（逐条打印）；2 用法/文件缺失。
「能红」演示：把收据里任一 sha 改一位后复跑应退 1（负控）。
"""
import argparse
import hashlib
import json
from pathlib import Path

BASE = Path(__file__).resolve().parent
REPO = BASE.parents[3]  # 122-r2-prep → 2026-09-25-dsh-skill-lifecycle → specs → docs → 仓库根
DEFAULT_RECEIPT = BASE / 'readiness-receipt-v1.json'
DEFAULT_LIBRARY = Path('/Users/lute/project/AgentTools/技能库')


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--receipt', default=str(DEFAULT_RECEIPT))
    parser.add_argument('--library', default=str(DEFAULT_LIBRARY))
    args = parser.parse_args()
    receipt_path = Path(args.receipt)
    if not receipt_path.exists():
        print(f'RECEIPT_MISSING {receipt_path}')
        return 2
    receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
    library = Path(args.library)
    drift = []
    checked = 0
    for key, expected in sorted(receipt['pins'].items()):
        if key.startswith('LIB__'):
            # LIB__<skill>__<rel>：库内实物（判者仪器等），按固定库路径重算（81-Skills 为标准入口）
            _, skill, rel = key.split('__', 2)
            target = library / '81-Skills' / skill / rel
        else:
            target = REPO / key
        if not target.exists():
            drift.append(f'MISSING {key}')
            continue
        actual = sha256_file(target)
        checked += 1
        if actual != expected:
            drift.append(f'DRIFT {key}: expected {expected[:12]}… got {actual[:12]}…')
    selection = json.loads((REPO / receipt['selection']).read_text(encoding='utf-8'))
    for item in selection['items']:
        target = library / item['sourceDir'] / 'SKILL.md'
        if not target.exists():
            drift.append(f'MISSING skill {item["name"]}')
            continue
        actual = sha256_file(target)
        checked += 1
        if actual != item['skMdSha256']:
            drift.append(f'DRIFT skill {item["name"]}: expected {item["skMdSha256"][:12]}… got {actual[:12]}…')
    if drift:
        print(f'DRIFT ({len(drift)}):')
        for line in drift:
            print(' ', line)
        return 1
    print(f'PASS：{checked} 项全部一致（收据 {receipt_path.name}）')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
