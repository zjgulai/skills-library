#!/usr/bin/env python3
"""legal-contract-gen-gen2 静态校验（零请求）：在 gen1 基础上加 v2 四项——
语言声明校正（仅 NDA 双语）/desc 典型场景正例/快速通道节/条款联动与 examples 指针；带负控（9 突变各自判红）。"""
import re
import shutil
import sys
import tempfile
from pathlib import Path

import yaml

REQUIRED_HEADINGS = ['## Quick Start', '## 一、支持的文书类型', '## 二、交互式问答流程（Variable Collection SOP）',
                     '## 三、文书模板库（渐进式披露索引）', '## 四、条款要点解读（帮助用户理解每个关键条款）',
                     '## 五、生成前检查清单', '## 六、Agent 行为指南', '### 6.5 快速通道（变量齐全时）']
TEMPLATES = ['templates/nda.md', 'templates/service-agreement.md', 'templates/privacy-policy.md',
             'templates/cooperation-agreement.md']
INLINE_MARK = '第一条 保密信息的定义'
PLACEHOLDER = re.compile(r'TODO|FIXME|placeholder|<your', re.I)  # 本件正文含教学用「待填/占位」字样，收窄正则防误伤


def validate(root: Path) -> list:
    errs = []
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1))
    body = m.group(2)
    if fm.get('name') != 'legal-contract-gen':
        errs.append('name != legal-contract-gen')
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
        errs.append('compatibility 缺失（判者点名 error）')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags):
        errs.append('tags 缺失（v2 增补）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (200 <= len(desc) <= 500):
            errs.append(f'description 长度越界（≤500）: {len(desc)}')
        if '不适用于' not in desc:
            errs.append('description 缺负向触发')
        if '帮我起草一份双方保密协议' not in desc:
            errs.append('description 缺典型场景正例（v2 增补）')
    if len(body) > 8000:
        errs.append(f'body 超 complex 上限 {len(body)}（需继续拆分）')
    for h in REQUIRED_HEADINGS:
        if h not in body:
            errs.append(f'缺章节 {h}')
    if INLINE_MARK in body:
        errs.append('模板正文仍在 SKILL.md 内联（未拆分）')
    if '**仅 NDA 提供中英双语模板' not in body:
        errs.append('语言声明未校正（仍宣称模板双语）')
    if '条款联动' not in body:
        errs.append('缺条款联动检查（v2 增补）')
    for rel in TEMPLATES:
        p = root / rel
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'模板缺失/空: {rel}')
        if rel not in body:
            errs.append(f'模板未被正文引用: {rel}')
    ex = root / 'examples/worked-examples.md'
    if not (ex.is_file() and ex.stat().st_size > 0):
        errs.append('examples/worked-examples.md 缺失/空')
    if 'examples/worked-examples.md' not in body:
        errs.append('examples 未被正文引用')
    lic = (root / 'LICENSE').read_text(encoding='utf-8', errors='ignore') if (root / 'LICENSE').is_file() else ''
    if 'legal-doc-generator' in lic:
        errs.append('LICENSE 署名与技能名不一致（判者点名）')
    ph = PLACEHOLDER.findall(text)
    if ph:
        errs.append(f'占位符命中 {ph[:3]}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/legal-contract-gen-gen2')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\n', '', 1),
        'strip-negative': lambda t: t.replace('不适用于：具体诉讼策略', '可适用于：具体诉讼策略', 1),
        'reinsert-inline': lambda t: t.replace('# Legal Doc Generator', '# Legal Doc Generator\n第一条 保密信息的定义', 1),
        'restore-dual-claim': lambda t: t.replace('——**仅 NDA 提供中英双语模板', '（模板内含中文与英文两版', 1),
        'drop-fastpath': lambda t: re.sub(r'### 6\.5 快速通道（变量齐全时）[\s\S]*$', '', t, count=1),
        'drop-clause-link': lambda t: t.replace('条款联动', '条款检查'),
        'drop-tags': lambda t: t.replace('tags: [legal, contract, document-generation]\n', '', 1),
        'unref-example': lambda t: t.replace('`examples/worked-examples.md`', '`examples/`', 1),
        'delete-template': None,
        'old-license': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-template':
                (dst / 'templates/nda.md').unlink()
            elif name == 'old-license':
                lp = dst / 'LICENSE'
                lp.write_text(lp.read_text(encoding='utf-8').replace('legal-contract-gen contributors', 'legal-doc-generator contributors'), encoding='utf-8')
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
