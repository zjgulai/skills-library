#!/usr/bin/env python3
"""software-testing-guide-gen1 静态校验（零请求）：kimi 族模式——frontmatter/去 keywords/
描述负向/去夸大表述/悬挂引用修复/排错节/引用完整性；带负控（≥5 突变必须各自判红）。"""
import re
import shutil
import sys
import tempfile
from pathlib import Path

import yaml

REQUIRED_HEADINGS = ['## 何时使用此 Skill', '## 何时不该使用此 Skill', '## 快速开始',
                     '## 脚本排错（常见错误自查）', '## 参考文档']
HYPE = re.compile(r'100 倍|零人为错误|世界级')
PLACEHOLDER = re.compile(r'TODO|FIXME|placeholder|<your|待填|占位', re.I)
REFS = ['references/master_qa_prompt.md', 'references/google_testing_standards.md',
        'references/ground_truth_principle.md', 'references/day1_onboarding.md',
        'references/llm_prompts_library.md']
SCRIPTS = ['scripts/init_qa_project.py', 'scripts/calculate_metrics.py']


def validate(root: Path) -> list:
    errs = []
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1))
    body = m.group(2)
    if fm.get('name') != 'software-testing-guide':
        errs.append('name != software-testing-guide')
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
    hp = HYPE.findall(text)
    if hp:
        errs.append(f'夸大表述残留: {hp[:3]}')
    if '02-CLI-TEST-CASES.md' in text:
        errs.append('残留无依据文件名 02-CLI-TEST-CASES.md')
    if '0X-<模块>' not in body:
        errs.append('缺占位式文档命名说明')
    for f, why in (('LICENSE', 'LICENSE'), ('assets/templates/TEST-CASE-TEMPLATE.md', '用例模板')):
        p = root / f
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'{why} 缺失/空')
    for rel in REFS + SCRIPTS:
        if not (root / rel).is_file():
            errs.append(f'引用文件缺失: {rel}')
        if rel.split('/')[-1] not in body:
            errs.append(f'未被正文引用: {rel}')
    ph = PLACEHOLDER.findall(text)
    if ph:
        errs.append(f'占位符命中 {ph[:3]}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/software-testing-guide-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.1.0"\n', '', 1),
        'strip-negative': lambda t: t.replace('不适用于：单个函数', '可适用于：单个函数', 1),
        'reinsert-hype': lambda t: t.replace('**特点**：', '**特点**：零人为错误；', 1),
        'restore-keywords': lambda t: t.replace('compatibility: "', 'keywords: [qa]\ncompatibility: "', 1),
        'drop-nouse': lambda t: re.sub(r'## 何时不该使用此 Skill[\s\S]*?(?=## 脚本排错)', '', t, count=1),
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
