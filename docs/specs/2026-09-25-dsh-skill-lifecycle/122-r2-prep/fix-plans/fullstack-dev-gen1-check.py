#!/usr/bin/env python3
"""fullstack-dev-gen1 静态校验（零请求）：MinMax 族——frontmatter（含 metadata.complexity）/
desc ≤500＋负向/渐进披露（§3-13 已拆 ref）/refs 无独立 frontmatter；带负控（≥6 突变各自判红）。"""
import re
import shutil
import sys
import tempfile
from pathlib import Path

import yaml

NEWREFS = ['references/api-client-patterns.md', 'references/background-jobs-and-caching.md',
           'references/file-upload-patterns.md', 'references/real-time-patterns.md',
           'references/cross-boundary-and-hardening.md', 'references/error-handling-and-db.md']


def validate(root: Path) -> list:
    errs = []
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1))
    body = m.group(2)
    if fm.get('name') != 'fullstack-dev':
        errs.append('name != fullstack-dev')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r277 error）')
    meta = fm.get('metadata') or {}
    if meta.get('complexity') not in ('basic', 'intermediate', 'advanced') and \
       meta.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('metadata.complexity 缺失（r277-r2 error）')
    if str(fm.get('license', '')).strip() != 'MIT':
        errs.append('license 非 MIT')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (200 <= len(desc) <= 500):
            errs.append(f'description 长度越界（≤500）: {len(desc)}')
        if 'DO NOT TRIGGER' not in desc:
            errs.append('description 缺负向触发')
    lines = text.split('\n')
    if len(lines) > 520:
        errs.append(f'SKILL.md 超 520 行（{len(lines)}）')
    if len(text.encode('utf-8')) > 21000:
        errs.append(f'SKILL.md 超 21KB（{len(text.encode("utf-8"))}）')
    for rel in NEWREFS:
        p = root / rel
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'下沉引用缺失/空: {rel}')
        if rel.split('/')[-1] not in body:
            errs.append(f'未被正文引用: {rel}')
    for rp in sorted((root / 'references').glob('*.md')):
        rt = rp.read_text(encoding='utf-8')
        if rt.startswith('---\n'):
            errs.append(f'references 残留独立 frontmatter: {rp.name}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/fullstack-dev-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\ncomplexity: complex', 'complexity: complex', 1),
        'drop-meta-complexity': lambda t: t.replace('  complexity: complex\n  version: "1.0.0"', '  version: "1.0.0"', 1),
        'strip-negative': lambda t: t.replace('DO NOT TRIGGER when: single-file', 'ALSO FINE when: single-file', 1),
        'inflate-desc': lambda t: t.replace('or hello-world tutorials."', 'or hello-world tutorials. Padding text appended to push description beyond the five hundred character limit for the negative control."', 1),
        'reinsert-ref-frontmatter': lambda t: t,  # 单独处理
        'unref-realtime': lambda t: t.replace('references/real-time-patterns.md', '实时详文'),
        'delete-ref': None,
    }
    del mutations['reinsert-ref-frontmatter']
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-ref':
                (dst / 'references' / 'real-time-patterns.md').unlink()
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
        dst = Path(td) / 'ref-frontmatter'
        shutil.copytree(root, dst)
        rp = dst / 'references' / 'api-design.md'
        rp.write_text('---\nname: fullstack-dev-api-design\n---\n\n' + rp.read_text(encoding='utf-8'), encoding='utf-8')
        e3 = validate(dst)
        print(f"[负控 ref-frontmatter] {'RED(期望)' if e3 else 'GREEN(异常!)'} {e3[:1]}")
        ok = ok and bool(e3)
    sys.exit(0 if ok else 1)


main()
