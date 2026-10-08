#!/usr/bin/env python3
"""legal-contract-gen-gen1 静态校验（零请求）：frontmatter/负向触发/模板拆分（渐进式披露）/
引用完整性；带负控（四个突变必须各自判红）。"""
import re
import shutil
import sys
import tempfile
from pathlib import Path

import yaml

REQUIRED_HEADINGS = ['## Quick Start', '## 一、支持的文书类型', '## 二、交互式问答流程（Variable Collection SOP）',
                     '## 三、文书模板库（渐进式披露索引）', '## 四、条款要点解读（帮助用户理解每个关键条款）',
                     '## 五、生成前检查清单', '## 六、Agent 行为指南']
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
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (200 <= len(desc) <= 500):
            errs.append(f'description 长度越界（≤500）: {len(desc)}')
        if '不适用于' not in desc:
            errs.append('description 缺负向触发')
    if len(body) > 8000:
        errs.append(f'body 超 complex 上限 {len(body)}（需继续拆分）')
    for h in REQUIRED_HEADINGS:
        if h not in body:
            errs.append(f'缺章节 {h}')
    if INLINE_MARK in body:
        errs.append('模板正文仍在 SKILL.md 内联（未拆分）')
    for rel in TEMPLATES:
        p = root / rel
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'模板缺失/空: {rel}')
        if rel not in body:
            errs.append(f'模板未被正文引用: {rel}')
    lic = (root / 'LICENSE').read_text(encoding='utf-8', errors='ignore') if (root / 'LICENSE').is_file() else ''
    if 'legal-doc-generator' in lic:
        errs.append('LICENSE 署名与技能名不一致（判者点名）')
    ph = PLACEHOLDER.findall(text)
    if ph:
        errs.append(f'占位符命中 {ph[:3]}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/legal-contract-gen-gen1')
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
        'restore-old-license': lambda t: t,  # 占位：license 在别文件，单独负控
    }
    del mutations['restore-old-license']
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
        dst = Path(td) / 'delete-template'
        shutil.copytree(root, dst)
        (dst / 'templates/nda.md').unlink()
        e3 = validate(dst)
        red = bool(e3)
        print(f"[负控 delete-template] {'RED(期望)' if red else 'GREEN(异常!)'} {e3[:2]}")
        ok = ok and red
        dst = Path(td) / 'old-license'
        shutil.copytree(root, dst)
        lp = dst / 'LICENSE'
        lp.write_text(lp.read_text(encoding='utf-8').replace('legal-contract-gen contributors', 'legal-doc-generator contributors'), encoding='utf-8')
        e4 = validate(dst)
        red = bool(e4)
        print(f"[负控 old-license] {'RED(期望)' if red else 'GREEN(异常!)'} {e4[:2]}")
        ok = ok and red
    sys.exit(0 if ok else 1)


main()
