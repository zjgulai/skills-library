#!/usr/bin/env python3
"""company-setup-gen1 静态校验（零请求）：frontmatter/描述负向/边界章节/交付模板/用例/
自检清单/署名与变更声明/引用完整性；带负控（五个突变必须各自判红）。"""
import re
import shutil
import sys
import tempfile
from pathlib import Path

import yaml

REQUIRED_HEADINGS = ['## 目标', '## 适用与不适用边界', '## 开始前', '## 工作流', '## 参考资料路由',
                     '## 必须交付', '## 典型用例（路由/回归参考）', '## 质量与证据边界', '## 自检清单（交付前逐项打钩）']
PLACEHOLDER = re.compile(r'TODO|FIXME|placeholder|<your|待填|占位', re.I)
SOURCES = ['source-03', 'source-20', 'source-45', 'source-46']


def validate(root: Path) -> list:
    errs = []
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1))
    body = m.group(2)
    if fm.get('name') != 'company-setup':
        errs.append('name != company-setup')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失')
    if str(fm.get('license', '')).strip() != 'Apache-2.0':
        errs.append('license 非 Apache-2.0')
    if not str(fm.get('author', '')).strip():
        errs.append('author 缺失')
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
    if '修订说明' not in body:
        errs.append('缺 Apache 变更声明（修订说明）')
    if '不是法律或税务意见' not in body:
        errs.append('缺免责边界句')
    if '客户 → 合同主体' not in body:
        errs.append('缺资金链模板')
    for f, why in (('LICENSE', 'LICENSE'), ('NOTICE', 'NOTICE'), ('agents/openai.yaml', 'openai 适配件')):
        p = root / f
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'{why} 缺失/空')
    for s in SOURCES:
        p = root / 'references' / f'{s}.md'
        if not p.is_file():
            errs.append(f'引用文件缺失: references/{s}.md')
        if s not in body:
            errs.append(f'未被正文引用: {s}')
    if not (root / 'references/INDEX.md').is_file() or 'INDEX' not in body:
        errs.append('INDEX 缺失或未引用')
    ph = PLACEHOLDER.findall(text)
    if ph:
        errs.append(f'占位符命中 {ph[:3]}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/company-setup-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\n', '', 1),
        'strip-negative': lambda t: t.replace('Do NOT use', 'Prefer to use', 1),
        'remove-notice': lambda t: re.sub(r'> 规范性修订说明：[^\n]*\n\n', '', t, count=1),
        'drop-boundary': lambda t: re.sub(r'## 适用与不适用边界[\s\S]*?(?=## 开始前)', '', t, count=1),
        'drop-cases': lambda t: re.sub(r'## 典型用例（路由/回归参考）[\s\S]*?(?=## 质量与证据边界)', '', t, count=1),
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
        dst = Path(td) / 'delete-source'
        shutil.copytree(root, dst)
        (dst / 'references/source-45.md').unlink()
        e3 = validate(dst)
        red = bool(e3)
        print(f"[负控 delete-source] {'RED(期望)' if red else 'GREEN(异常!)'} {e3[:2]}")
        ok = ok and red
    sys.exit(0 if ok else 1)


main()
