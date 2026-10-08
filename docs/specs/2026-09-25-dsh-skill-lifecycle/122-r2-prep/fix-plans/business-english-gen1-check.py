#!/usr/bin/env python3
"""business-english-gen1 静态校验（零请求）：frontmatter/描述（含宽泛词收敛）/Apache 署名
与变更声明/引用完整性；带负控（四个突变必须各自判红）。"""
import re
import shutil
import sys
import tempfile
from pathlib import Path

import yaml

REQUIRED_HEADINGS = ['## 目标', '## 开始前', '## 工作流', '## 参考资料路由', '## 必须交付', '## 质量与证据边界']
PLACEHOLDER = re.compile(r'TODO|FIXME|placeholder|<your|待填|占位', re.I)
STANDALONE_KOUYU = re.compile(r'(?<!商务)口语')


def validate(root: Path) -> list:
    errs = []
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1))
    body = m.group(2)
    if fm.get('name') != 'business-english':
        errs.append('name != business-english')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失')
    if str(fm.get('license', '')).strip() != 'Apache-2.0':
        errs.append(f'license 非 Apache-2.0（署名技能不得改许可）: {fm.get("license")}')
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
        if STANDALONE_KOUYU.search(desc):
            errs.append('description 含孤立宽泛词「口语」')
    if len(body) > 8000:
        errs.append(f'body 超 complex 上限 {len(body)}')
    for h in REQUIRED_HEADINGS:
        if h not in body:
            errs.append(f'缺章节 {h}')
    if '修订说明' not in body:
        errs.append('缺 Apache 变更声明（修订说明）')
    for f, why in (('LICENSE', 'LICENSE'), ('NOTICE', 'NOTICE'), ('agents/openai.yaml', 'openai 适配件')):
        p = root / f
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'{why} 缺失/空')
    lic = (root / 'LICENSE').read_text(encoding='utf-8', errors='ignore') if (root / 'LICENSE').is_file() else ''
    if 'Apache License' not in lic:
        errs.append('LICENSE 非 Apache 文本')
    for rel in ('references/INDEX.md', 'references/source-04.md'):
        if not (root / rel).is_file():
            errs.append(f'引用文件缺失: {rel}')
        if rel not in body and rel.split('/')[-1] not in body:
            errs.append(f'未被正文引用: {rel}')
    ph = PLACEHOLDER.findall(text)
    if ph:
        errs.append(f'占位符命中 {ph[:3]}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/business-english-gen1')
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\n', '', 1),
        'strip-negative': lambda t: t.replace('Do NOT use', 'Prefer it', 1),
        'broad-word': lambda t: t.replace('商务口语', '口语', 1),
        'remove-notice': lambda t: t.replace('> 规范性修订说明：本文件由技能库维护流程在原始内容基础上做过规范化修订（修订日期 2026-10；修订内容：frontmatter 规范化、工作流阶段化、交付模板补充）。原始版权与许可见 NOTICE 与 LICENSE（Apache-2.0）。\n\n', '', 1),
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
