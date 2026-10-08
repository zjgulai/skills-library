#!/usr/bin/env python3
"""brand-governance-os-gen1 静态校验（零请求）：brand-strategy 族——frontmatter（version/complexity/
license/tags/compatibility）/desc 含 Do NOT use/When NOT to Use 节/四步 SOP/四份 assets 均被引用/
checklist 无裸占位符残留；带负控（9 突变各自判红，含跨文件突变）。"""
import re, shutil, sys, tempfile
from pathlib import Path
import yaml

ASSETS = ['governance_checklist.md', 'intake_form.md', 'feedback_doc.md', 'governance_dashboard.md']


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
    if fm.get('name') != 'brand-governance-os':
        errs.append('name != brand-governance-os')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver/缺失（r287 warning）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r287 warning）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r287 warning）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向触发（r287 warning）')
    if '## When NOT to Use' not in body:
        errs.append('缺 When NOT to Use 节（r287 warning）')
    for step in ('### Step 1', '### Step 2', '### Step 3', '### Step 4'):
        if step not in body:
            errs.append(f'缺 SOP 步骤：{step}')
    for a in ASSETS:
        p = root / 'assets' / a
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'assets/{a} 缺失（r287 warning：模板未落地）')
        if a not in body:
            errs.append(f'未被正文引用: {a}')
    cl = root / 'assets' / 'governance_checklist.md'
    if cl.is_file():
        ct = cl.read_text(encoding='utf-8')
        for marker in ('[Attribute', '[Product/Legal/Exec]', '[Region]'):
            if marker in ct:
                errs.append(f'checklist 残留裸占位符：{marker}（r287 warning）')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/brand-governance-os-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1),
        'drop-complexity': lambda t: t.replace('complexity: standard\nlicense:', 'license:', 1),
        'strip-negative': lambda t: t.replace('Do NOT use for one-off', 'Also fine for one-off', 1),
        'drop-when-not': lambda t: t.replace('## When NOT to Use', '## Notes', 1),
        'drop-step3': lambda t: t.replace('### Step 3 — QA & consistency checks', '### QA checks', 1),
        'unref-intake': lambda t: t.replace('intake_form.md', '表单'),
        'reintroduce-placeholder': None,
        'delete-dashboard': None,
        'delete-checklist': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-dashboard':
                (dst / 'assets' / 'governance_dashboard.md').unlink()
            elif name == 'delete-checklist':
                (dst / 'assets' / 'governance_checklist.md').unlink()
            elif name == 'reintroduce-placeholder':
                p = dst / 'assets' / 'governance_checklist.md'
                t = p.read_text(encoding='utf-8')
                mutated = t.replace('On-brand per the current voice attributes?', 'Is it [Attribute 1] and [Attribute 2]?', 1)
                assert mutated != t, f'{name}: 突变未生效（锚点漂移）'
                p.write_text(mutated, encoding='utf-8')
            else:
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
