#!/usr/bin/env python3
"""W1 首批装配投影计划生成器（只读：治理账本 + 源目录；不写目标）。

选择规则（105 号方案 P2 已批准）：
  A 组：81-Skills 全部（跳过对象状态阻断件）
  B 组：标准入口中 route=role-candidate 且不在 81-Skills 的达标件
  C 组：1 个 Qoder 平铺试点（验证平铺形态可被发现模拟识别）
摘要口径与 assembly-project.mjs 完全一致（行式清单 sha256 / 计划摘要）。

用法：python3 -B assembly-plan-make.py [--library <技能库根>] [--out <plan.json>]
"""
import argparse
import csv
import hashlib
import os
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent


def find_repo(start):
    cur = start
    for _ in range(8):
        if (cur / 'skill-lifecycle').is_dir() and (cur / 'docs').is_dir():
            return cur
        cur = cur.parent
    raise SystemExit(f'仓库根推断失败: {start}')


REPO = find_repo(BASE)
DEFAULT_LIB = Path('/Users/lute/project/AgentTools/技能库')
DEFAULT_LEDGER = REPO / 'docs/specs/2026-09-25-dsh-skill-lifecycle/106-w0-governance/governance-ledger-v1.csv'
DEFAULT_OUT = REPO / 'docs/specs/2026-09-25-dsh-skill-lifecycle/107-w1-assembly/assembly-plan-v1-batch1.json'
PILOT_NAME = 'leadership-strategy-playbook'

JUNK_DIRS = {'__pycache__', 'node_modules', '.git'}


def walk_files(root):
    files, skipped = [], []
    for dirpath, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in JUNK_DIRS)
        for name in sorted(names):
            path = Path(dirpath) / name
            if path.is_symlink():
                skipped.append(str(path.relative_to(root)))
                continue
            if name == '.DS_Store' or name.endswith('.pyc'):
                continue
            payload = path.read_bytes()
            files.append({
                'relPath': str(path.relative_to(root)).replace(os.sep, '/'),
                'sha256': hashlib.sha256(payload).hexdigest(),
                'bytes': len(payload),
            })
    files.sort(key=lambda item: item['relPath'])
    return files, skipped


def manifest_digest(files):
    text = '\n'.join(f"{f['relPath']}\t{f['sha256']}\t{f['bytes']}" for f in files)
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def plan_digest(plan):
    lines = [plan['planVersion'], plan['planId'], plan['targetRoot']]
    for op in plan['operations']:
        if op['mode'] == 'dir':
            fields = [op['opId'], op['mode'], op['name'], op['sourceDir'], op['sourceDigest']]
            if isinstance(op.get('expectTargetDigest'), str):
                fields.append(op['expectTargetDigest'])
            lines.append('\t'.join(fields))
        else:
            lines.append('\t'.join([op['opId'], op['mode'], op['name'], op['sourceFile'], op['sourceSha256']]))
    return hashlib.sha256('\n'.join(lines).encode('utf-8')).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--library', default=str(DEFAULT_LIB))
    parser.add_argument('--ledger', default=str(DEFAULT_LEDGER))
    parser.add_argument('--out', default=str(DEFAULT_OUT))
    args = parser.parse_args()
    library = Path(args.library)
    rows = list(csv.DictReader(Path(args.ledger).open(encoding='utf-8-sig')))

    def rel_path(row):
        return row['entryPath'].split('技能库/', 1)[-1]

    operations, excluded, total_bytes, total_symlinks = [], [], 0, 0

    def gate(row, group):
        if row['qualityBlocked'] == 'True':
            excluded.append({'group': group, 'path': rel_path(row), 'reason': 'quality-blocked'})
            return False
        if row['nameKebabValid'] != 'True':
            excluded.append({'group': group, 'path': rel_path(row), 'reason': 'non-kebab-name'})
            return False
        return True

    def dir_op(row, group):
        nonlocal total_bytes, total_symlinks
        source_dir = os.path.dirname(row['entryPath'])
        files, symlinks = walk_files(source_dir)
        total_symlinks += len(symlinks)
        if not any(f['relPath'] == 'SKILL.md' for f in files):
            excluded.append({'group': group, 'path': rel_path(row), 'reason': 'no-skill-md'})
            return
        total_bytes += sum(f['bytes'] for f in files)
        operations.append({
            'opId': f'op-{len(operations) + 1:03d}', 'mode': 'dir', 'group': group,
            'name': row['name'], 'route': row['route'], 'sourceKind': 'standard',
            'entryRelPath': rel_path(row), 'entrySha256': row['entrySha256'],
            'sourceDir': source_dir, 'sourceFiles': files,
            'sourceBytes': sum(f['bytes'] for f in files), 'sourceDigest': manifest_digest(files),
            **({'skippedSymlinks': symlinks} if symlinks else {}),
        })

    for row in rows:
        if row['sourceKind'] == 'standard' and rel_path(row).startswith('81-Skills/') and gate(row, 'A'):
            dir_op(row, 'A')
    for row in rows:
        if row['sourceKind'] == 'standard' and row['route'] == 'role-candidate' \
                and not rel_path(row).startswith('81-Skills/') and gate(row, 'B'):
            dir_op(row, 'B')

    pilot = next((r for r in rows if r['sourceKind'] == 'qoder' and r['name'] == PILOT_NAME), None)
    if pilot is None:
        excluded.append({'group': 'C', 'path': PILOT_NAME, 'reason': 'pilot-not-found'})
    else:
        operations.append({
            'opId': f'op-{len(operations) + 1:03d}', 'mode': 'flat', 'group': 'C',
            'name': pilot['name'], 'route': pilot['route'], 'sourceKind': 'qoder',
            'entryRelPath': rel_path(pilot), 'entrySha256': pilot['entrySha256'],
            'sourceFile': pilot['entryPath'], 'sourceSha256': pilot['entrySha256'],
            'statusSignals': pilot['statusSignals'],
        })

    names = {}
    for op in operations:
        names.setdefault(op['name'], []).append(op['opId'])
    duplicates = {name: ids for name, ids in names.items() if len(ids) > 1}

    plan = {
        'planKind': 'assembly-projection',
        'planVersion': 'assembly-v1',
        'planId': 'w1-batch1-2026-09-30',
        'targetRoot': str(library / '_assembly-v1'),
        'createdAt': datetime.now().astimezone().isoformat(),
        'selection': {
            'groupA': sum(1 for op in operations if op['group'] == 'A'),
            'groupB': sum(1 for op in operations if op['group'] == 'B'),
            'pilotFlat': sum(1 for op in operations if op['group'] == 'C'),
            'totalSourceBytes': total_bytes,
            'skippedSymlinks': total_symlinks,
            'excluded': excluded,
            'duplicateNames': duplicates,
            'basis': 'governance-ledger-v1（route/kebab/qualityBlocked 为账本口径）',
        },
        'operations': operations,
    }
    plan['planDigest'] = plan_digest(plan)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json_dump(plan) + '\n')
    print(json_dump({k: v for k, v in plan.items() if k != 'operations'}))
    print(f'operations={len(operations)} bytes={total_bytes} '
          f'symlinks={total_symlinks} targetExists={(library / "_assembly-v1").exists()}')
    return 0


def json_dump(value):
    import json
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)


if __name__ == '__main__':
    raise SystemExit(main())
