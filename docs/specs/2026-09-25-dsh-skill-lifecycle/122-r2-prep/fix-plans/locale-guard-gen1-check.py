#!/usr/bin/env python3
"""locale-guard-gen1 静态校验（零请求）：kimi 族模式——frontmatter 规范化/desc 负向/
审计脚本退出码与豁免/references 模板/新节完整性；带负控（≥5 突变必须各自判红）。"""
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

import yaml

REQUIRED_HEADINGS = ['## 概述', '## 核心能力', '## 工作流程（审计 -> 修复 -> 验证）',
                     '## 规范约束', '## 动态翻译键与复数避坑', '## 交付物', '## 资源']
REQUIRED_SCRIPT_MARKERS = ['IGNORE_MARKER = "i18n-audit-ignore"',
                           'return 1 if has_error else 0', 'return 2']
REFS = ['references/locale-template.json']


def validate(root: Path) -> list:
    errs = []
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1))
    body = m.group(2)
    if fm.get('name') != 'locale-guard':
        errs.append('name != locale-guard')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失')
    if str(fm.get('license', '')).strip() != 'MIT':
        errs.append('license 非 MIT')
    if not str(fm.get('author', '')).strip():
        errs.append('author 缺失')
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
        if '不适用于' not in desc:
            errs.append('description 缺负向触发')
    for h in REQUIRED_HEADINGS:
        if h not in body:
            errs.append(f'缺章节 {h}')
    if 'GENSPARK' in text:
        errs.append('残留 GENSPARK 适配段')
    if 'CONNECTORS' in text:
        errs.append('残留 CONNECTORS 引用')
    if '~~' in text:
        errs.append('残留占位宏 ~~')
    script = (root / 'scripts' / 'i18n_audit.py').read_text(encoding='utf-8')
    try:
        compile(script, 'i18n_audit.py', 'exec')
    except SyntaxError as exc:
        errs.append(f'i18n_audit.py 语法错误: {exc}')
    for marker in REQUIRED_SCRIPT_MARKERS:
        if marker not in script:
            errs.append(f'脚本缺标记: {marker}')
    for rel in REFS:
        p = root / rel
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'引用文件缺失/空: {rel}')
        if rel.split('/')[-1] not in body:
            errs.append(f'未被正文引用: {rel}')
    tpl = root / 'references' / 'locale-template.json'
    if tpl.is_file():
        try:
            data = json.loads(tpl.read_text(encoding='utf-8'))
            for key in ('en-US', 'zh-CN'):
                if key not in data:
                    errs.append(f'模板缺语言段: {key}')
        except json.JSONDecodeError as exc:
            errs.append(f'模板非合法 JSON: {exc}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/locale-guard-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\n', '', 1),
        'strip-negative': lambda t: t.replace('不适用于：后端框架', '适用于：后端框架', 1),
        'restore-keywords': lambda t: t.replace('license: MIT\n', 'license: MIT\nkeywords: [i18n]\n', 1),
        'drop-dynamic-section': lambda t: re.sub(
            r'## 动态翻译键与复数避坑[\s\S]*?(?=## 交付物)', '', t, count=1),
        'break-exit': None,  # 在脚本文件上做突变（见下）
        'delete-ref': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'break-exit':
                p = dst / 'scripts' / 'i18n_audit.py'
                t = p.read_text(encoding='utf-8')
                mutated = t.replace('return 1 if has_error else 0', 'return 0')
                assert mutated != t, f'{name}: 突变未生效（锚点漂移）'
                p.write_text(mutated, encoding='utf-8')
            elif name == 'delete-ref':
                (dst / 'references' / 'locale-template.json').unlink()
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
