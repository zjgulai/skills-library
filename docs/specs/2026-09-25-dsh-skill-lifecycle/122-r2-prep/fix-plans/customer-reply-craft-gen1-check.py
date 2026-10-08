#!/usr/bin/env python3
"""customer-reply-craft-gen1 静态校验（零请求）：frontmatter 规范、负向触发、祈使语态残留、
引用完整性、LICENSE 存在；带负控（四个突变必须各自判红）。"""
import re
import shutil
import sys
import tempfile
from pathlib import Path

import yaml

REQUIRED_HEADINGS = [
    '## 适用场景', '## 不适用场景', '## 执行工作流', '## 输入要求', '## 四大场景框架',
    '## 五级情绪策略（速查）', '## 黄金法则', '## 输出格式', '## References',
]
PERSONA_RESIDUE = re.compile(r'你是一位|你将|请你')
PLACEHOLDER = re.compile(r'TODO|FIXME|placeholder|<your|待填|占位', re.I)
REFS = ['references/scenario-templates.md', 'references/emotion-guidelines.md',
        'references/escalation-and-testcases.md']


def validate(root: Path) -> list:
    errs = []
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1))
    body = m.group(2)
    if fm.get('name') != 'customer-reply-craft':
        errs.append('name != customer-reply-craft')
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
        if '不适用于' not in desc:
            errs.append('description 缺负向触发（不适用于）')
    if len(body) > 8000:
        errs.append(f'body 超 complex 上限 {len(body)}')
    for h in REQUIRED_HEADINGS:
        if h not in body:
            errs.append(f'缺章节 {h}')
    pr = PERSONA_RESIDUE.findall(body)
    if pr:
        errs.append(f'角色扮演语态残留 {pr[:3]}')
    ph = PLACEHOLDER.findall(text)
    if ph:
        errs.append(f'占位符命中 {ph[:3]}')
    for rel in REFS:
        p = root / rel
        if not p.is_file() or p.stat().st_size == 0:
            errs.append(f'引用文件缺失/空: {rel}')
        if rel not in body:
            errs.append(f'未被正文引用: {rel}')
    lic = root / 'LICENSE'
    if not (lic.is_file() and lic.stat().st_size > 0):
        errs.append('LICENSE 缺失/空')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/customer-reply-craft-gen1')
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: 1.0.0\n', '', 1),
        'strip-negative': lambda t: t.replace('不适用于：客服机器人', '可用于：客服机器人', 1),
        'reintroduce-persona': lambda t: t.replace('# 客服话术生成器', '# 客服话术生成器\n\n你是一位资深客服培训专家。', 1),
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
        (dst / 'references/scenario-templates.md').unlink()
        e3 = validate(dst)
        red = bool(e3)
        print(f"[负控 delete-ref] {'RED(期望)' if red else 'GREEN(异常!)'} {e3[:2]}")
        ok = ok and red
    sys.exit(0 if ok else 1)


main()
