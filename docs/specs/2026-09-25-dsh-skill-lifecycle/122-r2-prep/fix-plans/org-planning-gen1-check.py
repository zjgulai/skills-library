#!/usr/bin/env python3
"""org-planning-gen1 静态校验（零请求）：frontmatter 规范、body 结构、引用完整性、
第二人称/占位符扫描；带负控（三个突变必须各自判红）。用法：python3 -B <本脚本> [候选目录]"""
import re
import shutil
import sys
import tempfile
from pathlib import Path

import yaml

REQUIRED_HEADINGS = [
    '## When to Use', '## When Not to Use', '## Agent Workflow', '## Diagnostic Judgment Rules',
    '## Common Failure Modes', '## Output Templates', '## Edge Cases & Mitigation',
    '## Error Handling', '## References',
]
SECOND_PERSON = re.compile(r"\byou\b|\byour\b|\byou're\b|\byou'll\b", re.I)
PLACEHOLDER = re.compile(r'TODO|FIXME|placeholder|<your|待填|占位', re.I)


def validate(root: Path) -> list:
    errs = []
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1))
    body = m.group(2)
    if fm.get('name') != 'org-planning':
        errs.append('name != org-planning')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失')
    if not fm.get('license'):
        errs.append('license 缺失')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (200 <= len(desc) <= 1024):
            errs.append(f'description 长度越界 {len(desc)}')
        if re.search(r'[<>]', desc):
            errs.append('description 含 XML 角括')
        if 'Do NOT use' not in desc:
            errs.append('description 缺负向触发')
    if len(body) > 8000:
        errs.append(f'body 超 complex 上限 {len(body)}')
    for h in REQUIRED_HEADINGS:
        if h not in body:
            errs.append(f'缺章节 {h}')
    sp = SECOND_PERSON.findall(body)
    if sp:
        errs.append(f'body 第二人称 {len(sp)} 处')
    ph = PLACEHOLDER.findall(text)
    if ph:
        errs.append(f'占位符命中 {ph[:3]}')
    refdir = root / 'references'
    refs = sorted(refdir.glob('*.md'))
    if not refs:
        errs.append('references/ 为空')
    for f in refs:
        rel = f'references/{f.name}'
        if rel not in body:
            errs.append(f'未被引用: {rel}')
        if f.stat().st_size == 0:
            errs.append(f'空文件: {rel}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/org-planning-gen1')
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: 1.0.0\n', '', 1),
        'shrink-description': lambda t: re.sub(r'description: >\n(.*?)\n---', 'description: Plan orgs.\n---', t, count=1, flags=re.S),
        'inject-placeholder': lambda t: t.replace('# Org Planning', '# Org Planning\n<!-- TODO -->', 1),
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
    sys.exit(0 if ok else 1)


main()
