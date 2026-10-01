#!/usr/bin/env python3
"""105-016 Sage 兼容静态矩阵检查器（零请求；只读 Sage，不运行 Sage）。

对象：装配根 `技能库/_assembly-v1`（173 项＝172 目录＋1 平铺）。
规则来源：`104-skills-asset-research/sage-assembly-research.md` R01—R25（含 E01—E19 证据码）。
本器只做**静态面**检查并输出机读结果；不适用/未验证的分配与 E 码引用写在 117 号报告中。

用法：python3 -B sage-matrix-make.py [--root <装配根>] [--sage <Sage 仓>] [--screen <屏检json>] [--out <json>]
"""
import argparse
import hashlib
import json
import re
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--root', default='/Users/lute/project/AgentTools/技能库/_assembly-v1')
parser.add_argument('--sage', default='/Users/lute/project/Sage')
parser.add_argument('--screen', default=None)
parser.add_argument('--yaml-probe', default=None, help='node 侧 sage-matrix-yaml.mjs 的产物路径')
parser.add_argument('--out', default=None)
args = parser.parse_args()

root = Path(args.root)
NAME_RE = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
SWITCH_OK = {True, False, 1, 0, '1', '0', 'true', 'false', 'yes', 'no', 'on', 'off'}
CAMEL_KEYS = ('disableModelInvocation', 'userInvocable')

FINGERPRINTS = {
    'apps/sage-shell/seed/pnpm-lock.yaml': '491550e6f4d4f420474325ab639644032612383af2160e50b4ce090def5a021d',
    'apps/sage-shell/src/profile/layout.ts': '45b6c9c92cf5654b173773f46b019f42f67323a628a20e3527aa7aab5badee63',
    'apps/sage-shell/src/host/composition.ts': '350c4ba777d43c076626415c10bf23015f52a307a19107e49fce47e5d993684e',
    'apps/sage-shell/src/adapter/capability-adapter.ts': 'df8c5adadd621d20205739ea49b9ade90bf28a9307ce3d9a72bae6192e720277',
    'vendor/dsh-desktop/dsh-plugin-desktop/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js': '1aea87781ba5b4d44c7cfd6184d933a1c171a3fd2791456b65ebfc8b255f1221',
    'vendor/dsh-desktop/dsh-plugin-desktop/node_modules/@deepseek-ai/dsh-skill/lib/index.js': '41137835ad018bf1974ef781c14d2a7974db4c502f484fc88d0b0608a26de88e',
    'vendor/dsh-desktop/dsh-plugin-desktop/node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js': '124b7475bdf80d842263cb2836426011cf083849371761478b2af6d2eee5defc',
    'vendor/dsh-desktop/dsh-plugin-desktop/node_modules/@deepseek-ai/dsh-agent-presets/lib/index.js': '812ab99c3082c230cd49d2e49e0949e52abe64112a11899a54d852824cfc20da',
}

# —— YAML 字段检查由 node 侧探针（sage-matrix-yaml.mjs，用真实 yaml 解析器）产出，本器读取其 JSON；
# 未提供探针产物时对应规则标记 not-evaluated。
yaml_probe = Path(args.yaml_probe) if args.yaml_probe else None

results = {'root': str(root), 'at': '2026-10-01'}

# —— 结构枚举（R06 布局 / 平铺 / symlink / 深层 SKILL.md）——
items, flat, deep_skill = [], [], []
for entry in sorted(root.iterdir()):
    if entry.is_symlink():
        results.setdefault('symlinks', []).append(str(entry))
    if entry.is_dir():
        skill = entry / 'SKILL.md'
        if skill.exists():
            items.append(entry.name)
        # 深层 SKILL.md（非直接子项）——防漏报：枚举包内两层的 SKILL.md
        for sub in entry.rglob('SKILL.md'):
            rel = sub.relative_to(root)
            if len(rel.parts) > 2:
                deep_skill.append(str(rel))
    elif entry.is_file() and entry.suffix == '.md':
        flat.append(entry.name)

# symlink 扫描覆盖子树（R07 静态面）
tree_symlinks = []
for p in root.rglob('*'):
    if p.is_symlink():
        tree_symlinks.append(str(p.relative_to(root)))

results['layout'] = {
    'dirItems': len(items), 'flatItems': flat, 'deepSkillMd': deep_skill,
    'treeSymlinks': tree_symlinks,
    'duplicateNames': len(items) != len(set(items)),
}

# —— YAML 侧结果（若 node 探针已产出）——
names_ok = names_bad = 0
yaml_rows = None
if yaml_probe and yaml_probe.exists():
    yaml_rows = json.loads(yaml_probe.read_text(encoding='utf-8'))
    results['yamlProbe'] = {
        'source': str(yaml_probe), 'items': len(yaml_rows['items']),
    }
    results['R01'] = {'pass': [r['dir'] for r in yaml_rows['items'] if r['nameOk']],
                      'fail': [r['dir'] for r in yaml_rows['items'] if not r['nameOk']]}
    results['R02'] = {'fail': [r['dir'] for r in yaml_rows['items'] if not r['frontmatterOk']]}
    results['R03'] = {'fail': [r['dir'] for r in yaml_rows['items']
                               if not r['nameTypeOk'] or not r['descTypeOk']
                               or r['nameLen'] == 0 or r['descLen'] == 0]}
    results['R03']['blankDesc'] = [r['dir'] for r in yaml_rows['items'] if r['descBlankOnly']]
    results['R09'] = {'names': len(set(r['name'] for r in yaml_rows['items'] if r['nameOk'])),
                      'unique': len(set(r['name'] for r in yaml_rows['items'] if r['nameOk'])) ==
                                len([r for r in yaml_rows['items'] if r['nameOk']])}
    results['R10'] = {
        'badSwitch': [r['dir'] for r in yaml_rows['items']
                      if r['switches'] and any(v not in SWITCH_OK and not isinstance(v, str) for v in r['switches'].values())],
        'nonCanonicalSwitch': [r['dir'] for r in yaml_rows['items']
                               if r['switches'] and any(isinstance(v, str) and v not in ('1', '0', 'true', 'false', 'yes', 'no', 'on', 'off') for v in r['switches'].values())],
        'camelKeys': [r['dir'] for r in yaml_rows['items'] if r.get('camelKeys')],
    }
    over = [(r['dir'], r['descJsLen']) for r in yaml_rows['items'] if r['descJsLen'] > 500]
    results['R11'] = {'over500': over, 'maxDescJsLen': max((r['descJsLen'] for r in yaml_rows['items']), default=0)}
    keys = {}
    for r in yaml_rows['items']:
        for k in r['topKeys']:
            keys[k] = keys.get(k, 0) + 1
    results['R14'] = {'topKeyFreq': dict(sorted(keys.items(), key=lambda x: -x[1]))}

# —— 指纹复算（只读 Sage）——
fp = {}
for rel, want in FINGERPRINTS.items():
    p = Path(args.sage) / rel
    if not p.exists():
        fp[rel] = 'MISSING'
    else:
        got = hashlib.sha256(p.read_bytes()).hexdigest()
        fp[rel] = 'same' if got == want else f'DRIFT({got[:16]})'
results['fingerprints'] = fp

# —— 屏检引用闭包（R13 附注材料）——
if args.screen and Path(args.screen).exists():
    sc = json.loads(Path(args.screen).read_text(encoding='utf-8'))
    by = sc.get('summary', {}).get('byCode', {})
    results['screen'] = {'source': args.screen, 'byCode': by,
                         'skills': sc.get('summary', {}).get('skills')}

print(json.dumps({'layout': results['layout'],
                  'fingerprints': fp,
                  'hasYamlProbe': yaml_rows is not None}, ensure_ascii=False, indent=1))
if args.out:
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print('matrix json written:', out)
