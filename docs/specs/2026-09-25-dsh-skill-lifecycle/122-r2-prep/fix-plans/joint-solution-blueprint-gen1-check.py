#!/usr/bin/env python3
"""joint-solution-blueprint-gen1 静态校验（零请求）：partnership 族——frontmatter（version/
complexity/license/tags/compatibility）/desc 含 Do NOT use/When NOT to Use/五步工作流/反模式节/
输入输出规范/质量清单/三份 assets 均被引用/软依赖自包含声明；带负控（8 突变各自判红）。"""
import re, shutil, sys, tempfile
from pathlib import Path
import yaml

ASSETS = ['solution_brief.md', 'architecture_checklist.md', 'launch_plan.md']


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
    if fm.get('name') != 'joint-solution-blueprint':
        errs.append('name != joint-solution-blueprint')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver/缺失（r288 error 面）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r288 error 面）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空（r288-r2）')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r288 error 面）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向触发（r288 error 面）')
    if '## When NOT to Use' not in body:
        errs.append('缺 When NOT to Use 节（r288）')
    for step in ('### Step 1', '### Step 2', '### Step 3', '### Step 4', '### Step 5'):
        if step not in body:
            errs.append(f'缺工作流步骤：{step}（r288 error 面：无可执行工作流）')
    if '## Anti-Patterns & Best Practices' not in body:
        errs.append('缺反模式与最佳实践节（r288-r1 warning）')
    if '## Input & Output Specification' not in body:
        errs.append('缺输入输出规范节（r288-r2 info）')
    if '## Quality Checklist' not in body:
        errs.append('缺质量自检清单（r288-r2 info）')
    if 'self-contained' not in body:
        errs.append('缺软依赖自包含声明（r288 info：build-co-sell-playbook）')
    for a in ASSETS:
        p = root / 'assets' / a
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'assets/{a} 缺失（r288 error 面：模板未实际交付）')
        if a not in body:
            errs.append(f'未被正文引用: {a}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/joint-solution-blueprint-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1),
        'drop-tags': lambda t: t.replace('tags: [partnership, solution-architecture, gtm]\n', '', 1),
        'strip-negative': lambda t: t.replace('Do NOT use for single-vendor', 'Also fine for single-vendor', 1),
        'drop-when-not': lambda t: t.replace('## When NOT to Use', '## Notes', 1),
        'drop-step5': lambda t: t.replace('### Step 5 — Support & lifecycle', '### Support & lifecycle', 1),
        'unref-brief': lambda t: t.replace('solution_brief.md', '简介模板'),
        'delete-launch-plan': None,
        'delete-arch-checklist': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-launch-plan':
                (dst / 'assets' / 'launch_plan.md').unlink()
            elif name == 'delete-arch-checklist':
                (dst / 'assets' / 'architecture_checklist.md').unlink()
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
