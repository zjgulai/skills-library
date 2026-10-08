#!/usr/bin/env python3
"""customer-escalation-gen1 静态校验（零请求）：frontmatter（无 argument-hint）/负向触发/
去 GENSPARK 适配段/去越界引用/去 ~~ 占位宏/拆分引用完整；带负控（≥5 突变判红）。"""
import re
import shutil
import sys
import tempfile
from pathlib import Path

import yaml

REQUIRED_HEADINGS = ['## Workflow', '## References', '## When to Escalate vs. Handle in Support',
                     '## Escalation Best Practices']
REFS = ['references/escalation-tiers.md', 'references/business-impact.md',
        'references/reproduction-steps.md', 'references/follow-up-and-deescalation.md']
PLACEHOLDER = re.compile(r'TODO|FIXME|<your')


def validate(root: Path) -> list:
    errs = []
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1))
    body = m.group(2)
    if fm.get('name') != 'customer-escalation':
        errs.append('name != customer-escalation')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失')
    if str(fm.get('license', '')).strip() != 'MIT':
        errs.append('license 非 MIT')
    if 'argument-hint' in fm:
        errs.append('残留非标准 argument-hint')
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
    if len(body) > 8000:
        errs.append(f'body 超 complex 上限 {len(body)}')
    for h in REQUIRED_HEADINGS:
        if h not in body:
            errs.append(f'缺章节 {h}')
    if 'GENSPARK' in text or 'gsk' in text:
        errs.append('残留 GENSPARK 适配段')
    if '../../' in text or 'CONNECTORS.md' in text:
        errs.append('残留越界/悬空引用')
    if '~~' in text:
        errs.append('残留 ~~ 占位宏')
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
        'skill-lifecycle/trial-home/opt-run/candidates/customer-escalation-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\n', '', 1),
        'strip-negative': lambda t: t.replace('Do NOT use for routine', 'Consider use for routine', 1),
        'reintroduce-adapter': lambda t: t.replace('# /customer-escalation', '# /customer-escalation\n<!-- GENSPARK ADAPTER -->', 1),
        'reintroduce-tilde': lambda t: t.replace('**Support platform**', '**~~support platform**', 1),
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
        (dst / 'references/escalation-tiers.md').unlink()
        e3 = validate(dst)
        red = bool(e3)
        print(f"[负控 delete-ref] {'RED(期望)' if red else 'GREEN(异常!)'} {e3[:2]}")
        ok = ok and red
    sys.exit(0 if ok else 1)


main()
