#!/usr/bin/env python3
"""ddd-glossary-gen-gen1 静态校验（零请求）：kimi 族——frontmatter 补齐（version/author/complexity/
tags/compatibility）/desc 收紧触发＋何时不触发/写入保护（合并/确认/只读降级）/限界上下文准则/
evals；负控 10 突变判红。"""
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
    if fm.get('name') != 'ddd-glossary-gen':
        errs.append('name != ddd-glossary-gen')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r365 error）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r365 warning）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    if not str(fm.get('author', '')).strip():
        errs.append('author 缺失（r365 error）')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空（r365 error）')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if '何时不触发' not in desc:
            errs.append('description 缺何时不触发（r365 warning）')
    if '不静默覆盖' not in body or '只读' not in body:
        errs.append('缺写入保护/只读降级（r365 warning）')
    if '限界上下文' not in body or 'Bounded Context' not in body:
        errs.append('缺限界上下文准则（r365-r2 warning）')
    for rel in ('evals/evals.json',):
        if not (root / rel).is_file():
            errs.append(f'{rel} 缺失（r365 info）')
        if rel not in body:
            errs.append(f'未被正文引用: {rel}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/ddd-glossary-gen-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': ('SKILL.md', lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1)),
        'drop-complexity': ('SKILL.md', lambda t: t.replace('complexity: standard\nlicense:', 'license:', 1)),
        'drop-author': ('SKILL.md', lambda t: t.replace('author: "Matt Pocock"\n', '', 1)),
        'drop-tags': ('SKILL.md', lambda t: t.replace('tags: [ddd, domain-driven-design, ubiquitous-language, glossary, documentation]\n', '', 1)),
        'strip-compat': ('SKILL.md', lambda t: t.replace('compatibility: "任何具备文本生成与文件写入能力', 'runtime-note: "任何具备文本生成与文件写入能力', 1)),
        'strip-negative': ('SKILL.md', lambda t: t.replace('何时不触发：仅咨询 DDD 理论概念', '同样适用于：仅咨询 DDD 理论概念', 1)),
        'drop-write-protection': ('SKILL.md', lambda t: t.replace('不静默覆盖', '直接覆盖').replace('若工作区只读或无写入工具', '若工作区可写')),
        'drop-context-rule': ('SKILL.md', lambda t: t.replace('区分限界上下文（Bounded Context）', '术语分组规则')),
        'unref-evals': ('SKILL.md', lambda t: t.replace('evals/evals.json', '测试文件')),
        'delete-evals': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, spec in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-evals':
                (dst / 'evals' / 'evals.json').unlink()
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
