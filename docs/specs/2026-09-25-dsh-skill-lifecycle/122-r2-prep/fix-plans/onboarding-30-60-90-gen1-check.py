#!/usr/bin/env python3
"""onboarding-30-60-90-gen1 静态校验（零请求）：genspark 族模式——frontmatter 规范化/
desc ≤500 且含负向/四份 assets 落地并被引用/关键节完整性；带负控（≥5 突变必须各自判红）。"""
import re
import shutil
import sys
import tempfile
from pathlib import Path

import yaml

REQUIRED_HEADINGS = ['## When to Use', '## When NOT to Use', '## Output Format',
                     '## Edge Cases', '## Safety & Boundaries', '## Non-Infringement Notes']
ASSETS = ['assets/plan_template.md', 'assets/role_examples.md',
          'assets/manager_checkin_questions.md', 'assets/red_flags.md']


def validate(root: Path) -> list:
    errs = []
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1))
    body = m.group(2)
    if fm.get('name') != 'onboarding-30-60-90':
        errs.append('name != onboarding-30-60-90')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失')
    if str(fm.get('license', '')).strip() != 'MIT':
        errs.append('license 非 MIT')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失')
    if 'keywords' in fm:
        errs.append('残留非标准 keywords 顶层字段')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (200 <= len(desc) <= 500):
            errs.append(f'description 长度越界（≤500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺负向触发')
    for h in REQUIRED_HEADINGS:
        if h not in body:
            errs.append(f'缺章节 {h}')
    if '~~' in text:
        errs.append('残留占位宏 ~~')
    if 'CONNECTORS' in text:
        errs.append('残留 CONNECTORS 引用')
    for rel in ASSETS:
        p = root / rel
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'引用文件缺失/空: {rel}')
        if rel.split('/')[-1] not in body:
            errs.append(f'未被正文引用: {rel}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/onboarding-30-60-90-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\n', '', 1),
        'strip-negative': lambda t: t.replace('Do NOT use for interns', 'Also fine for interns', 1),
        'inflate-desc': lambda t: t.replace(
            'or generic HR/IT checklists.',
            'or generic HR/IT checklists. Padding text appended to push the description beyond the five hundred character limit for the negative control case.', 1),
        'unreference-asset': lambda t: t.replace('`assets/red_flags.md`', '`the red-flag sheet`', 1),
        'rename-asset-ref': lambda t: t.replace('assets/manager_checkin_questions.md', 'assets/checkin.md', 1),
        'drop-safety': lambda t: re.sub(r'## Safety & Boundaries[\s\S]*?(?=## Non-Infringement Notes)', '', t, count=1),
        'delete-asset': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-asset':
                (dst / 'assets' / 'plan_template.md').unlink()
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
