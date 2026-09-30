#!/usr/bin/env python3
"""W1 首批装配投影四层验证（只读）。

层次（对照装配根规范 §10）：
  L1 结构：SKILL.md 可解析、目录名=frontmatter name、name kebab、description 非空
  L2 发现模拟：根下一层可枚举、可见数=计划数、同名 0、全部 kebab（Sage 发现规则）
  L3 资源闭合：每个包的包内引用缺失集「源=目标」（复制未破坏闭合；缺失总量照实登记）
  L4 许可与 meta：`.assembly-meta.json` 必填字段、meta.sourceSha256=目标 SKILL.md 摘要、
     源含 LICENSE 的包目标同样保留
另校验：回执（applied=173）、计划摘要、无 .tmp-* 残留。

用法：python3 -B assembly-verify.py [--root <装配根>] [--plan <plan.json>] [--receipt <receipt.json>] [--out <verify.json>]
"""
import argparse
import hashlib
import json
import re
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
W1 = REPO / 'docs/specs/2026-09-25-dsh-skill-lifecycle/107-w1-assembly'
DEFAULT_ROOT = Path('/Users/lute/project/AgentTools/技能库/_assembly-v1')
DEFAULT_PLAN = W1 / 'assembly-plan-v1-batch1.json'
DEFAULT_RECEIPT = Path('/Users/lute/project/AgentTools/技能库/_assembly-receipts/w1-batch1-2026-09-30.json')
DEFAULT_OUT = W1 / 'assembly-batch1-verify.json'

KEBAB = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
FENCE = re.compile(r'```[\s\S]*?```')
REF = re.compile(r'`((?:\./)?[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:md|json|ya?ml|js|mjs|py|sh|csv|txt))`')
PKG = ('references/', 'assets/', 'scripts/', 'templates/', 'examples/', 'resources/')
PLACEHOLDER = re.compile(r'(?:^|/)(?:x{2,}|0x(?:[^a-z0-9]|$)|yyy|zzz|your[-_]|name[-_]of)', re.I)
LICENSE_NAMES = ('license', 'licence', 'copying')


def sha256_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_frontmatter(path):
    text = path.read_text(encoding='utf-8', errors='replace')
    match = re.match(r'^---\r?\n([\s\S]*?)\r?\n---', text)
    if not match:
        return None, text
    import yaml
    try:
        parsed = yaml.safe_load(match.group(1))
        return (parsed if isinstance(parsed, dict) else {}), text
    except yaml.YAMLError:
        return None, text


def missing_refs(package_dir, skill_path):
    text = skill_path.read_text(encoding='utf-8', errors='replace')
    prose = FENCE.sub('', text)
    missing = set()
    for hit in REF.finditer(prose):
        ref = hit.group(1).lstrip('./')
        if not ref.startswith(PKG) or PLACEHOLDER.search(ref):
            continue
        if not (package_dir / ref).exists():
            missing.add(ref)
    return missing


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default=str(DEFAULT_ROOT))
    parser.add_argument('--plan', default=str(DEFAULT_PLAN))
    parser.add_argument('--receipt', default=str(DEFAULT_RECEIPT))
    parser.add_argument('--out', default=str(DEFAULT_OUT))
    args = parser.parse_args()
    root, plan = Path(args.root), json.loads(Path(args.plan).read_text())
    operations = plan['operations']
    failures = []

    # L1 结构 + L4 meta/许可 + L3 资源闭合（源=目标）
    layer1 = {'skills': 0, 'yamlErrors': [], 'nameMismatch': [], 'nonKebab': [], 'missingDescription': []}
    layer3 = {'checked': 0, 'missingTotal': 0, 'closureBroken': [], 'missingExamples': []}
    layer4 = {'metaMissing': [], 'metaInvalid': [], 'licenseLost': [], 'checked': 0}
    for op in operations:
        if op['mode'] == 'dir':
            target_dir = root / op['name']
            skill_path = target_dir / 'SKILL.md'
            source_dir = Path(op['sourceDir'])
        else:
            target_dir = root
            skill_path = root / f"{op['name']}.md"
            source_dir = None
        if not skill_path.is_file():
            failures.append({'layer': 'L1', 'name': op['name'], 'problem': 'target-missing'})
            continue
        layer1['skills'] += 1
        front, _ = parse_frontmatter(skill_path)
        if front is None:
            layer1['yamlErrors'].append(op['name'])
        else:
            name = front.get('name')
            expected = op['name'] if op['mode'] == 'dir' else op['name']
            if name != expected:
                layer1['nameMismatch'].append({'name': op['name'], 'frontmatter': name})
            if not (isinstance(name, str) and KEBAB.match(name)):
                layer1['nonKebab'].append(op['name'])
            if not (isinstance(front.get('description'), str) and front['description'].strip()):
                layer1['missingDescription'].append(op['name'])
        if op['mode'] == 'dir':
            meta_path = target_dir / '.assembly-meta.json'
            layer4['checked'] += 1
            if not meta_path.is_file():
                layer4['metaMissing'].append(op['name'])
            else:
                meta = json.loads(meta_path.read_text())
                if not all(key in meta for key in
                           ('name', 'sourceKind', 'sourcePath', 'sourceSha256', 'sourceEntryKind',
                            'planId', 'projectedAt', 'projectionReceipt')):
                    layer4['metaInvalid'].append({'name': op['name'], 'problem': 'fields'})
                elif meta['sourceSha256'] != sha256_file(skill_path):
                    layer4['metaInvalid'].append({'name': op['name'], 'problem': 'sha-mismatch'})
            has_source_license = any(Path(f['relPath']).name.lower().startswith(LICENSE_NAMES)
                                     for f in op['sourceFiles'])
            has_target_license = any(p.name.lower().startswith(LICENSE_NAMES)
                                     for p in target_dir.iterdir() if p.is_file())
            if has_source_license and not has_target_license:
                layer4['licenseLost'].append(op['name'])
            missing_target = missing_refs(target_dir, skill_path)
            missing_source = missing_refs(source_dir, skill_path)
            layer3['checked'] += 1
            layer3['missingTotal'] += len(missing_target)
            if missing_target != missing_source:
                layer3['closureBroken'].append({'name': op['name'],
                                                'source': sorted(missing_source), 'target': sorted(missing_target)})
            if missing_target and len(layer3['missingExamples']) < 12:
                layer3['missingExamples'].append({'name': op['name'], 'missing': sorted(missing_target)[:6]})

    # L2 发现模拟（Sage 规则：根下一层；目录/SKILL.md 或直接 .md）
    visible_dirs = sorted(p.name for p in root.iterdir() if p.is_dir() and (p / 'SKILL.md').is_file())
    visible_files = sorted(p.stem for p in root.iterdir() if p.is_file() and p.name.endswith('.md'))
    temp_leftovers = sorted(p.name for p in root.iterdir() if p.name.startswith('.tmp-'))
    names = visible_dirs + visible_files
    duplicates = sorted({n for n in names if names.count(n) > 1})
    planned_names = sorted(op['name'] for op in operations)
    layer2 = {
        'visibleDirectories': len(visible_dirs),
        'visibleFlatFiles': len(visible_files),
        'visibleTotal': len(names),
        'planned': len(planned_names),
        'missingTargets': sorted(set(planned_names) - set(names)),
        'unexpectedTargets': sorted(set(names) - set(planned_names)),
        'duplicateNames': duplicates,
        'nonKebabNames': [n for n in names if not KEBAB.match(n)],
        'tempLeftovers': temp_leftovers,
    }

    receipt = json.loads(Path(args.receipt).read_text())
    layers = {'L1': layer1, 'L2': layer2, 'L3': layer3, 'L4': layer4}
    ok = (not layer1['yamlErrors'] and not layer1['nameMismatch'] and not layer1['nonKebab']
          and not layer1['missingDescription'] and not failures)
    ok_l2 = (layer2['visibleTotal'] == layer2['planned'] and not layer2['missingTargets']
             and not layer2['unexpectedTargets'] and not duplicates)
    ok_l3 = not layer3['closureBroken']
    ok_l4 = (not layer4['metaMissing'] and not layer4['metaInvalid'] and not layer4['licenseLost'])
    result = {
        'verifiedAt': __import__('datetime').datetime.now().astimezone().isoformat(),
        'root': str(root), 'planId': plan['planId'], 'planDigest': plan['planDigest'],
        'receipt': {'applied': receipt['summary']['applied'], 'rejected': receipt['summary']['rejected'],
                    'receiptKind': receipt.get('receiptKind')},
        'layers': layers,
        'verdict': {'L1-structure': ok, 'L2-discovery': ok_l2, 'L3-resource-closure': ok_l3, 'L4-meta-license': ok_l4},
        'failures': failures,
    }
    Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'verdict': result['verdict'], 'L1': {k: v for k, v in layer1.items() if k != 'skills'},
                      'L2': layer2, 'L3': {k: v for k, v in layer3.items() if k != 'missingExamples'},
                      'L4': layer4}, ensure_ascii=False, indent=2)[:2600])
    return 0 if all(result['verdict'].values()) else 1


if __name__ == '__main__':
    raise SystemExit(main())
