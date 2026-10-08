#!/usr/bin/env python3
"""flutter-dev-gen1 静态校验（零请求）：MinMax 族——frontmatter 全套（version/complexity/
license/compatibility/metadata.{complexity,author}）/desc TRIGGER+DO NOT TRIGGER/MANDATORY
WORKFLOW 四步/Error Handling & Boundaries 节/references 完好；带负控（8 突变各自判红）。"""
import re, shutil, sys, tempfile
from pathlib import Path
import yaml


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
    if fm.get('name') != 'flutter-dev':
        errs.append('name != flutter-dev')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver/缺失（r304 warning）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r304 error）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r304 error）')
    meta = fm.get('metadata') or {}
    if not str(meta.get('author', '')).strip():
        errs.append('metadata.author 缺失（r304-r1 error）')
    if meta.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('metadata.complexity 缺失')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'DO NOT TRIGGER' not in desc:
            errs.append('description 缺 DO NOT TRIGGER 负向（r304 warning）')
    if '## MANDATORY WORKFLOW' not in body:
        errs.append('缺 MANDATORY WORKFLOW（r304 error 面）')
    for step in ('### Step 1', '### Step 2', '### Step 3', '### Step 4'):
        if step not in body:
            errs.append(f'缺工作流步骤：{step}')
    if '## Error Handling & Boundaries' not in body:
        errs.append('缺 Error Handling & Boundaries 节（r304-r2 info→硬项）')
    if 'Version conflicts' not in body:
        errs.append('缺版本冲突处理（r304-r1 warning）')
    refs = ['widget-patterns.md', 'riverpod-state.md', 'bloc-state.md', 'gorouter-navigation.md',
            'project-structure.md', 'performance.md', 'testing.md', 'platform-specific.md',
            'animations.md', 'networking.md', 'forms.md', 'localization.md']
    for r in refs:
        if not (root / 'references' / r).is_file():
            errs.append(f'references/{r} 缺失')
        if r not in body:
            errs.append(f'未被正文引用: {r}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/flutter-dev-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-complexity': lambda t: t.replace('complexity: complex\nlicense:', 'license:', 1),
        'drop-compat': lambda t: t.replace('compatibility: "Agent runtime with code generation.', 'runtime-note: "Agent runtime with code generation.', 1),
        'drop-meta-author': lambda t: t.replace('  author: "flutter-dev contributors"\n', '', 1),
        'strip-negative': lambda t: t.replace('DO NOT TRIGGER for pure Dart', 'Also fine for pure Dart', 1),
        'drop-workflow': lambda t: t.replace('## MANDATORY WORKFLOW', '## Overview', 1),
        'drop-step4': lambda t: t.replace('### Step 4 — Verify statically and by profiling', '### Verification', 1),
        'drop-boundaries': lambda t: t.replace('## Error Handling & Boundaries', '## Notes', 1),
        'delete-ref': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-ref':
                (dst / 'references' / 'widget-patterns.md').unlink()
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
