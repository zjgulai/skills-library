#!/usr/bin/env python3
"""装配根受控更新·计划生成器（Q3 update op 的配套；只读源库与装配根，产计划不改盘）。

对每个点名技能：
  - 源 = 库内当前实物（技能库/<相对路径>）；目标 = <target-root>/<name>；
  - expectTargetDigest = 目标**当下**清单摘要（不含 .assembly-meta.json）；
  - sourceFiles/sourceDigest = 源清单逐文件摘要（与执行器同口径：跳垃圾件/符号链接）。

用法：python3 -B assembly-update-make.py --names cash-flow-snapshot paid-advertising \
        --out <plan.json> [--library /Users/lute/project/AgentTools/技能库] [--target-root <dir>]
"""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path

BASE = Path(__file__).resolve().parent
SPEC = BASE.parents[2] / 'docs/specs/2026-09-25-dsh-skill-lifecycle'
PLAN_B1 = SPEC / '107-w1-assembly/assembly-plan-v1-batch1.json'
DEFAULT_LIB = Path('/Users/lute/project/AgentTools/技能库')
META_NAME = '.assembly-meta.json'
JUNK_DIRS = {'__pycache__', 'node_modules', '.git'}
JUNK_NAMES = {'.DS_Store'}


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def walk_files(root):
    files, symlinks = [], []

    def walk(d, prefix):
        for entry in sorted(os.scandir(d), key=lambda e: e.name):
            if entry.is_symlink():
                symlinks.append(prefix + entry.name)
                continue
            if entry.is_dir():
                if entry.name in JUNK_DIRS:
                    continue
                walk(entry.path, prefix + entry.name + '/')
                continue
            if not entry.is_file():
                continue
            if entry.name in JUNK_NAMES or entry.name.endswith('.pyc'):
                continue
            b = Path(entry.path).read_bytes()
            files.append({'relPath': prefix + entry.name,
                          'sha256': hashlib.sha256(b).hexdigest(), 'bytes': len(b)})

    walk(root, '')
    files.sort(key=lambda f: f['relPath'])
    return {'files': files, 'skippedSymlinks': symlinks}


def manifest_digest(files):
    text = '\n'.join(f"{f['relPath']}\t{f['sha256']}\t{f['bytes']}" for f in files)
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def compute_plan_digest(plan):
    lines = [plan['planVersion'], plan['planId'], plan['targetRoot']]
    for op in plan['operations']:
        if op['mode'] == 'dir':
            fields = [op['opId'], op['mode'], op['name'], op['sourceDir'], op['sourceDigest']]
            if isinstance(op.get('expectTargetDigest'), str):
                fields.append(op['expectTargetDigest'])
            lines.append('\t'.join(fields))
        elif op['mode'] == 'flat-to-dir':
            lines.append('\t'.join([op['opId'], op['mode'], op['name'], op['sourceDir'],
                                    op['sourceDigest'], op['expectFlatSha256']]))
        else:
            lines.append('\t'.join([op['opId'], op['mode'], op['name'], op['sourceFile'], op['sourceSha256']]))
    return hashlib.sha256('\n'.join(lines).encode('utf-8')).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--names', nargs='+', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--library', default=str(DEFAULT_LIB))
    ap.add_argument('--target-root', default=None)
    ap.add_argument('--plan-id', default=None)
    args = ap.parse_args()

    library = Path(args.library)
    base = json.loads(PLAN_B1.read_text())
    target_root = args.target_root or base['targetRoot']
    by_name = {op['name']: op for op in base['operations']}
    plan_id = args.plan_id or ('update-' + '-'.join(sorted(args.names))[:60])
    operations = []
    for i, name in enumerate(sorted(args.names), start=1):
        src = by_name.get(name)
        if src is None:
            raise SystemExit(f'批一计划里没有 {name}（更新生成器当前只覆盖批一指定集）')
        if src.get('mode') == 'flat':
            # 平铺件受控换形：库内已转目录（<sourceFile 同目录>/<name>），装配根仍是 <name>.md。
            flat_lib_dir = Path(library) / Path(src['sourceFile']).relative_to(library).parent / name
            if not flat_lib_dir.is_dir():
                raise SystemExit(f'{name}: 平铺件尚未转目录（库内缺 {flat_lib_dir}）')
            walked = walk_files(flat_lib_dir)
            if not any(f['relPath'] == 'SKILL.md' for f in walked['files']):
                raise SystemExit(f'{name}: 源目录缺 SKILL.md')
            flat_target = Path(target_root) / f'{name}.md'
            if not flat_target.is_file():
                raise SystemExit(f'{name}: 装配根平铺件缺失（可能已换形——已等幂等场景请直接核对）')
            entry = next(f for f in walked['files'] if f['relPath'] == 'SKILL.md')
            operations.append({
                'opId': f'op-{i:03d}', 'mode': 'flat-to-dir', 'group': src.get('group'), 'name': name,
                'route': src.get('route'), 'sourceKind': src.get('sourceKind'),
                'entryRelPath': f'{name}/SKILL.md', 'entrySha256': entry['sha256'],
                'sourceDir': str(flat_lib_dir), 'sourceFiles': walked['files'],
                'sourceBytes': sum(f['bytes'] for f in walked['files']),
                'sourceDigest': manifest_digest(walked['files']),
                'expectFlatRelPath': f'{name}.md',
                'expectFlatSha256': hashlib.sha256(flat_target.read_bytes()).hexdigest(),
            })
            continue
        source_dir = src['sourceDir']
        walked = walk_files(source_dir)
        if not any(f['relPath'] == 'SKILL.md' for f in walked['files']):
            raise SystemExit(f'{name}: 源目录缺 SKILL.md')
        target = Path(target_root) / name
        if not target.is_dir():
            raise SystemExit(f'{name}: 目标不存在（更新仅对既有目标；新建走投影计划）')
        cur = walk_files(target)
        cur_files = [f for f in cur['files'] if f['relPath'] != META_NAME]
        entry = next(f for f in walked['files'] if f['relPath'] == 'SKILL.md')
        operations.append({
            'opId': f'op-{i:03d}', 'mode': 'dir', 'group': src.get('group'), 'name': name,
            'route': src.get('route'), 'sourceKind': src.get('sourceKind'),
            'entryRelPath': f'{name}/SKILL.md', 'entrySha256': entry['sha256'],
            'sourceDir': source_dir, 'sourceFiles': walked['files'],
            'sourceBytes': sum(f['bytes'] for f in walked['files']),
            'sourceDigest': manifest_digest(walked['files']),
            'expectTargetDigest': manifest_digest(cur_files),
        })
    plan = {'planKind': 'assembly-projection', 'planVersion': 'assembly-v1', 'planId': plan_id,
            'targetRoot': target_root, 'createdAt': '2026-09-30', 'selection': {
                'kind': 'controlled-update', 'names': sorted(args.names),
                'basis': 'Q3 受控更新（旧版归档 _assembly-history/<name>/<digest12>）'},
            'operations': operations}
    plan['planDigest'] = compute_plan_digest(plan)
    Path(args.out).write_text(json.dumps(plan, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(json.dumps({'plan': args.out, 'ops': len(operations), 'planDigest': plan['planDigest'][:16],
                      'names': sorted(args.names)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
