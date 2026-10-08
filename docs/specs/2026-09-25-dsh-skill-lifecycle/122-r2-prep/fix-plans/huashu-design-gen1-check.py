#!/usr/bin/env python3
"""huashu-design-gen1 静态校验（零请求）：frontmatter 规范化/desc 收窄含负向/渐进式披露
（主干 ≤500 行且两节已拆 ref）/环境三级矩阵/assets 非必需声明/新 ref 引用完整；
带负控（≥8 突变各自判红）。"""
import re
import shutil
import sys
import tempfile
from pathlib import Path

import yaml

REFS = ['references/design-philosophy.md', 'references/direction-advisor.md']


def validate(root: Path) -> list:
    errs = []
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1))
    body = m.group(2)
    if fm.get('name') != 'huashu-design':
        errs.append('name != huashu-design')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r268 error 点名）')
    if str(fm.get('license', '')).strip() != 'MIT':
        errs.append('license 非 MIT')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r268 error 点名）')
    if 'keywords' in fm:
        errs.append('残留非标准 keywords 顶层字段')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (200 <= len(desc) <= 500):
            errs.append(f'description 长度越界（≤500）: {len(desc)}')
        if '不适用于' not in desc:
            errs.append('description 缺负向触发')
    lines = text.split('\n')
    if len(lines) > 320:
        errs.append(f'SKILL.md 超 320 行（{len(lines)}）——渐进式披露未达标（r268/r269 点名）')
    if len(text.encode('utf-8')) > 23000:
        errs.append(f'SKILL.md 超 23KB（{len(text.encode("utf-8"))}）——r269 点名 15-20KB 目标带余量')
    for h in ['## 核心哲学（优先级从高到低）', '## 设计方向顾问（Fallback 模式）', '## 工作流程']:
        if h not in body:
            errs.append(f'缺章节 {h}')
    for ref in REFS:
        p = root / ref
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'引用文件缺失/空: {ref}')
        if ref.split('/')[-1] not in body:
            errs.append(f'未被正文引用: {ref}')
    if 'Level 1 · 零外部依赖' not in body:
        errs.append('缺运行环境三级矩阵（r268 点名）')
    if '不是运行时必需项' not in body:
        errs.append('缺 assets 非必需声明（r268 点名）')
    if '大节' in text:
        errs.append('残留失效指针（大节）')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/huashu-design-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\n', '', 1),
        'strip-negative': lambda t: t.replace('不适用于：生产级', '可适用于：生产级', 1),
        'inflate-lines': lambda t: t + '\n' + '\n'.join(['冗余行' for _ in range(300)]),
        'reintroduce-dajie': lambda t: t.replace('## 工作流程', '> 见下方大节\n\n## 工作流程', 1),
        'drop-env-matrix': lambda t: re.sub(r'### 运行环境三级支持（缺依赖时显式降级，绝不中途抛错）[\s\S]*?(?=\n## )', '', t, count=1),
        'drop-assets-note': lambda t: t.replace('不是运行时必需项', '为随包素材', 1),
        'unref-advisor': lambda t: t.replace('`references/direction-advisor.md`', '`fallback 文档`'),
        'delete-philosophy-ref': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-philosophy-ref':
                (dst / 'references' / 'design-philosophy.md').unlink()
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
