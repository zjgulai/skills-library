#!/usr/bin/env python3
"""hr-prompt-pack-gen1 静态校验（零请求）：genspark 族——frontmatter（version/complexity/license/
tags/compatibility）/desc 含 Do NOT use 负向/templates 五类骨架齐/compliance-disclaimers 非侵权
保留/SKILL 与 references 互链；带负控（8 突变各自判红，含跨文件突变）。"""
import re, shutil, sys, tempfile
from pathlib import Path
import yaml

DOC_TYPES = ['## 1. Job description', '## 2. Offer letter', '## 3. Performance improvement plan',
             '## 4. Exit / farewell note', '## 5. Performance review']


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
    if fm.get('name') != 'hr-prompt-pack':
        errs.append('name != hr-prompt-pack')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver/缺失（r285 warning）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r285 warning）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失（r285-r2）')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r285-r2）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向触发（r285 warning）')
        if 'COBRA' not in desc and 'EEOC' not in desc:
            errs.append('description 缺具体负向类目（COBRA/EEOC 等）')
    if 'have HR or counsel review' not in text:
        errs.append('缺法务复核 flag 规则（r285）')
    for ref in ('templates.md', 'compliance-disclaimers.md'):
        p = root / 'references' / ref
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'references/{ref} 缺失')
        if ref not in body:
            errs.append(f'未被正文引用: {ref}')
    tp = root / 'references' / 'templates.md'
    if tp.is_file():
        tpt = tp.read_text(encoding='utf-8')
        for dt in DOC_TYPES:
            if dt not in tpt:
                errs.append(f'templates.md 缺骨架：{dt}')
    cp = root / 'references' / 'compliance-disclaimers.md'
    if cp.is_file() and 'does **not** copy SHRM' not in cp.read_text(encoding='utf-8'):
        errs.append('compliance-disclaimers.md 缺非侵权声明')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/hr-prompt-pack-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1),
        'drop-complexity': lambda t: t.replace('complexity: standard\nlicense:', 'license:', 1),
        'strip-negative': lambda t: t.replace('Do NOT use for binding legal agreements', 'Also fine for binding legal agreements', 1),
        'drop-flag-rule': lambda t: t.replace('have HR or counsel review', 'review as needed'),
        'unref-templates': lambda t: t.replace('templates.md', '模板说明'),
        'strip-noninfringe': None,
        'delete-templates': None,
        'delete-compliance': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-templates':
                (dst / 'references' / 'templates.md').unlink()
            elif name == 'delete-compliance':
                (dst / 'references' / 'compliance-disclaimers.md').unlink()
            elif name == 'strip-noninfringe':
                p = dst / 'references' / 'compliance-disclaimers.md'
                t = p.read_text(encoding='utf-8')
                mutated = t.replace('does **not** copy SHRM', 'adapts SHRM')
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
