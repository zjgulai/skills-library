#!/usr/bin/env python3
"""validate-data-gen1 静态校验（零请求）：frontmatter（无 argument-hint）/描述负向/
拆分（悬空链接清除、references 完整）/正文上限；带负控（四个突变必须各自判红）。"""
import re
import shutil
import sys
import tempfile
from pathlib import Path

import yaml

REQUIRED_HEADINGS = ['## Workflow', '## Output Format', '## References', '## Examples', '## Tips']
REFS = ['references/pre-delivery-qa-checklist.md', 'references/pitfalls.md',
        'references/sanity-checking.md', 'references/documentation-standards.md']
PLACEHOLDER = re.compile(r'TODO|FIXME|<your')  # 本件正文含合法单词 placeholders，不收窄会误伤


def validate(root: Path) -> list:
    errs = []
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1))
    body = m.group(2)
    if fm.get('name') != 'validate-data':
        errs.append('name != validate-data')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失')
    if str(fm.get('license', '')).strip() != 'MIT':
        errs.append('license 非 MIT')
    if 'argument-hint' in fm:
        errs.append('残留非标准 argument-hint（判者点名）')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (200 <= len(desc) <= 500):
            errs.append(f'description 长度越界（≤500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺负向触发')
        if ' -- ' in desc:
            errs.append('description 含非规范双连字符（判者点名）')
    if len(body) > 8000:
        errs.append(f'body 超 complex 上限 {len(body)}')
    for h in REQUIRED_HEADINGS:
        if h not in body:
            errs.append(f'缺章节 {h}')
    if '../../' in text:
        errs.append('残留越界相对引用（../../）')
    if 'CONNECTORS.md' in text:
        errs.append('残留 CONNECTORS 引用（判者点名）')
    for rel in REFS:
        p = root / rel
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'引用缺失/空: {rel}')
        if rel not in body:
            errs.append(f'未被正文引用: {rel}')
    ph = PLACEHOLDER.findall(text)
    if ph:
        errs.append(f'占位符命中 {ph[:3]}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/validate-data-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\n', '', 1),
        'strip-negative': lambda t: t.replace('Do NOT use for writing', 'Consider use for writing', 1),
        'reinsert-connectors': lambda t: t.replace('# /validate-data', '# /validate-data\n\n> see [CONNECTORS.md](../../CONNECTORS.md)', 1),
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            p = dst / 'SKILL.md'
            t = p.read_text(encoding='utf-8')
            mutated = mutate(t)
            assert mutated != t, f'{name}: 突变未生效（锚点漂移）'
            p.write_text(mutated, encoding='utf-8')
            e2 = validate(dst)
            red = bool(e2)
            print(f"[负控 {name}] {'RED(期望)' if red else 'GREEN(异常!)'} {e2[:2]}")
            ok = ok and red
        dst = Path(td) / 'delete-ref'
        shutil.copytree(root, dst)
        (dst / 'references/pitfalls.md').unlink()
        e3 = validate(dst)
        red = bool(e3)
        print(f"[负控 delete-ref] {'RED(期望)' if red else 'GREEN(异常!)'} {e3[:2]}")
        ok = ok and red
    sys.exit(0 if ok else 1)


main()
