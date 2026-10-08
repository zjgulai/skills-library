#!/usr/bin/env python3
"""customer-research-gen1 静态校验（零请求）：genspark 族——frontmatter 补齐（version/complexity/
license/tags/compatibility；metadata.version 提升）/desc 重构（去关键词堆叠＋Do NOT use）/去人格化开头/
source-guides 补齐并被引用/evals 用例；负控 10 突变判红。"""
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
    if fm.get('name') != 'customer-research':
        errs.append('name != customer-research')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r363）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r363 warning）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r363 error）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向（r363 warning）')
    if 'You are an expert customer researcher' in text:
        errs.append('残留人格化开头（r363 info）')
    for rel in ('references/source-guides.md', 'evals/evals.json'):
        if not (root / rel).is_file():
            errs.append(f'{rel} 缺失（r363 error）')
        if rel not in body:
            errs.append(f'未被正文引用: {rel}')
    sg = root / 'references' / 'source-guides.md'
    if sg.is_file():
        c = sg.read_text(encoding='utf-8')
        if 'Reddit' not in c or 'G2' not in c or 'SparkToro' not in c:
            errs.append('source-guides 平台覆盖不足（r363 error）')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/customer-research-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': ('SKILL.md', lambda t: t.replace('version: "2.0.0"\ncomplexity:', 'complexity:', 1)),
        'drop-complexity': ('SKILL.md', lambda t: t.replace('complexity: standard\nlicense:', 'license:', 1)),
        'strip-compat': ('SKILL.md', lambda t: t.replace('compatibility: "任何具备文本分析能力', 'runtime-note: "任何具备文本分析能力', 1)),
        'strip-negative': ('SKILL.md', lambda t: t.replace('Do NOT use for writing copy', 'Also fine for writing copy', 1)),
        'restore-persona': ('SKILL.md', lambda t: t.replace('Uncover what customers actually think', 'You are an expert customer researcher. Uncover what customers actually think', 1)),
        'unref-guides': ('SKILL.md', lambda t: t.replace('references/source-guides.md', '来源指南')),
        'guides-thin': ('guides', lambda t: t.replace('Reddit', '论坛').replace('G2', '评论站').replace('SparkToro', '受众工具')),
        'delete-evals': 'E',
        'delete-guides': None,
        'drop-whennot': ('SKILL.md', lambda t: t.replace('Do NOT use for writing copy (see copywriting)', 'More info: writing copy (see copywriting)', 1)),
    }
    with tempfile.TemporaryDirectory() as td:
        for name, spec in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-evals':
                (dst / 'evals' / 'evals.json').unlink()
            elif name == 'delete-guides':
                (dst / 'references' / 'source-guides.md').unlink()
            else:
                target, mutate = spec
                p = dst / ('SKILL.md' if target == 'SKILL.md' else 'references/source-guides.md')
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
