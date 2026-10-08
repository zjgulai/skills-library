#!/usr/bin/env python3
"""define-goal-gen1 静态校验（零请求）：genspark 族——frontmatter（version/complexity/license/
tags/compatibility 含工具依赖声明）/desc 含 Do NOT use 负向与 $define-goal 触发/工具降级回退段/
六步工作流/worked-examples 被引用；带负控（8 突变各自判红）。"""
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
    if fm.get('name') != 'define-goal':
        errs.append('name != define-goal')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver/缺失（r286 warning/info）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r286 warning）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r286 warning）')
    else:
        if 'get_goal' not in compat or 'create_goal' not in compat:
            errs.append('compatibility 未声明工具依赖（get_goal/create_goal）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向触发（r286 warning）')
        if '$define-goal' not in desc:
            errs.append('description 缺 $define-goal 显式触发词（r286-r1）')
    if 'Fallback when goal tools are unavailable' not in body:
        errs.append('缺工具降级回退段（r286 warning）')
    if 'plain-text' not in body and 'plain text' not in body:
        errs.append('降级段缺纯文本输出说明')
    if '6. Create the goal only after it passes the quality bar' not in body:
        errs.append('缺第 6 步（创建前质量门槛）')
    ref = root / 'references' / 'worked-examples.md'
    if not (ref.is_file() and ref.stat().st_size > 0):
        errs.append('references/worked-examples.md 缺失')
    if 'worked-examples.md' not in body:
        errs.append('未被正文引用: worked-examples.md')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/define-goal-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1),
        'drop-complexity': lambda t: t.replace('complexity: standard\nlicense:', 'license:', 1),
        'strip-tools-compat': lambda t: t.replace('goal tools (get_goal / create_goal) are used when the host provides them', 'runs anywhere', 1),
        'strip-negative': lambda t: t.replace('Do NOT use for routine', 'Also fine for routine', 1),
        'strip-trigger-word': lambda t: t.replace('$define-goal, asks to create', 'a goal, asks to create', 1),
        'drop-fallback': lambda t: t.replace('**Fallback when goal tools are unavailable**', '**Notes**', 1),
        'unref-examples': lambda t: t.replace('worked-examples.md', 'examples doc'),
        'delete-examples': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-examples':
                (dst / 'references' / 'worked-examples.md').unlink()
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
