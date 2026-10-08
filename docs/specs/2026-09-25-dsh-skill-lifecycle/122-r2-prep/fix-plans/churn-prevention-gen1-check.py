#!/usr/bin/env python3
"""churn-prevention-gen1 静态校验（零请求）：frontmatter/描述≤500（R11）/正文<8000/
引用完整性（死链扫描）/越界引用；带负控（四个突变必须各自判红）。"""
import re
import shutil
import sys
import tempfile
from pathlib import Path

import yaml

REQUIRED_HEADINGS = [
    '## Before Starting', '## How This Skill Works', '## Cancel Flow Design', '## Proactive Retention',
    '## Failed-Payment Recovery (Dunning)', '## Common Mistakes', '## References', '## Related Skills',
]
PLACEHOLDER = re.compile(r'TODO|FIXME|placeholder|<your|待填|占位', re.I)
LINK_RE = re.compile(r'references/[a-z0-9-]+\.md')


def validate(root: Path) -> list:
    errs = []
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1))
    body = m.group(2)
    if fm.get('name') != 'churn-prevention':
        errs.append('name != churn-prevention')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失')
    if not fm.get('license'):
        errs.append('license 缺失')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失')
    if 'metadata' in fm:
        errs.append('残留非标准 metadata 层级')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (200 <= len(desc) <= 500):
            errs.append(f'description 长度越界（R11 ≤500）: {len(desc)}')
        if re.search(r'[<>]', desc):
            errs.append('description 含 XML 角括')
        if 'Do NOT use' not in desc:
            errs.append('description 缺负向触发')
    if len(body) > 8000:
        errs.append(f'body 超 complex 上限 {len(body)}')
    for h in REQUIRED_HEADINGS:
        if h not in body:
            errs.append(f'缺章节 {h}')
    if '../../' in text or '..\\..\\' in text:
        errs.append('含越界相对引用（../../）')
    ph = PLACEHOLDER.findall(text)
    if ph:
        errs.append(f'占位符命中 {ph[:3]}')
    linked = set(LINK_RE.findall(body))
    for rel in sorted(linked):
        if not (root / rel).is_file():
            errs.append(f'死链: {rel}')
    for f in sorted((root / 'references').glob('*.md')):
        if f'references/{f.name}' not in linked:
            errs.append(f'未被正文引用: references/{f.name}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/churn-prevention-gen1')
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "2.1.0"\n', '', 1),
        'oob-ref': lambda t: t.replace('# Churn Prevention', '# Churn Prevention\nSee ../../tools/REGISTRY.md.', 1),
        'dangling-ref': lambda t: t.replace('# Churn Prevention', '# Churn Prevention\nSee [references/nonexistent.md](references/nonexistent.md).', 1),
        'desc-over-500': lambda t: t.replace(
            'Do NOT use for payment-gateway',
            'Also note this deliberately padded sentence pushes the description beyond the five-hundred unit limit so the check must fail. Do NOT use for payment-gateway', 1),
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
