#!/usr/bin/env python3
"""crm-maintenance-gen1 静态校验（零请求）：genspark 族——去 GENSPARK ADAPTER 注入块/frontmatter 补齐
（version/complexity/compatibility）/desc 负向（非 HubSpot CRM、批量导入、删除））/6 个 reference/
文件补齐且被引用/无幽灵引用/报告格式统一；带负控（11 突变判红，含幽灵引用与文件删除）。"""
import re, shutil, sys, tempfile
from pathlib import Path
import yaml

REQUIRED = ['reference/hubspot-fields.md', 'reference/gotchas.md', 'reference/cleanup-checklist.md',
            'reference/examples/log-email-happy-path.md', 'reference/examples/log-call-happy-path.md',
            'reference/examples/cleanup-deal.md']


def validate(root: Path) -> list:
    errs = []
    sk = root / 'SKILL.md'
    if not sk.is_file():
        return ['SKILL.md 缺失']
    text = sk.read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1)); body = m.group(2)
    if fm.get('name') != 'crm-maintenance':
        errs.append('name != crm-maintenance')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r339 error）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex', 'medium'):
        errs.append('complexity 非法/缺失（r339 error）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r339 error）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向（r339 warning）')
    if 'GENSPARK ADAPTER' in text:
        errs.append('残留 GENSPARK ADAPTER 注入块（r339 error）')
    if 'gsk ' in text:
        errs.append('残留 gsk CLI 平台耦合（r339 error）')
    # 幽灵引用：正文提到的每个 reference/... 都必须存在
    mentioned = set(re.findall(r'reference/[\w.\-]+\.md', body))
    for rel in sorted(mentioned):
        if not (root / rel).is_file():
            errs.append(f'幽灵引用（文件不存在）: {rel}（r339 error）')
    for rel in REQUIRED:
        if not (root / rel).is_file():
            errs.append(f'{rel} 缺失（r339 error）')
        if rel not in body:
            errs.append(f'未被正文引用: {rel}')
    if '统一报告格式' not in body:
        errs.append('缺统一报告格式（r339 info→硬项）')
    if 'Never delete records' not in body:
        errs.append('缺「不删除记录」审批门（r339）')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/crm-maintenance-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': ('SKILL.md', lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1)),
        'drop-complexity': ('SKILL.md', lambda t: t.replace('complexity: medium\nlicense:', 'license:', 1)),
        'strip-compat': ('SKILL.md', lambda t: t.replace('compatibility: "需要宿主提供 HubSpot', 'runtime-note: "需要宿主提供 HubSpot', 1)),
        'strip-negative': ('SKILL.md', lambda t: t.replace('Do NOT use for non-HubSpot CRMs', 'Also fine for non-HubSpot CRMs', 1)),
        'reintroduce-adapter': ('SKILL.md', lambda t: t.replace('# CRM Maintenance', '<!-- GENSPARK ADAPTER (auto-injected) -->\n通过 `gsk mcp list` 配置\n\n# CRM Maintenance', 1)),
        'reghost-ref': ('SKILL.md', lambda t: t.replace('reference/gotchas.md', 'reference/gotchas-v2.md')),
        'unref-fields': ('SKILL.md', lambda t: t.replace('reference/hubspot-fields.md', '字段文档')),
        'drop-delete-gate': ('SKILL.md', lambda t: t.replace('Never delete records', 'Deleting records is allowed')),
        'drop-report-format': ('SKILL.md', lambda t: t.replace('统一报告格式', '报告格式')),
        'delete-checklist': None,
        'delete-example': 'EX',
    }
    with tempfile.TemporaryDirectory() as td:
        for name, spec in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-checklist':
                (dst / 'reference' / 'cleanup-checklist.md').unlink()
            elif name == 'delete-example':
                (dst / 'reference' / 'examples' / 'cleanup-deal.md').unlink()
            else:
                _, mutate = spec
                p = dst / 'SKILL.md'
                t = p.read_text(encoding='utf-8')
                mutated = mutate(t)
                assert mutated != t, f'{name}: 突变未生效（锚点漂移）'
                p.write_text(mutated, encoding='utf-8')
            e2 = validate(dst)
            red = bool(e2)
            print(f"[负控 {name}] {'RED(期望)' if red else 'GREEN(异常!)'} {e2[:2]}")
            ok = ok and red
    sys.exit(0 if ok else 1)


main()
