#!/usr/bin/env python3
"""api-doc-gen-gen1 静态校验（零请求）：kimi 工具族——frontmatter 全套/desc 何时不用/H1 统一/
Agent 执行工作流/安全边界/脚本被引用；带负控（8 突变各自判红）。"""
import re, shutil, sys, tempfile
from pathlib import Path
import yaml


def validate(root: Path) -> list:
    errs = []
    sk = root / 'SKILL.md'
    if not sk.is_file():
        return ['SKILL.md 缺失']
    text = sk.read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1)); body = m.group(2)
    if fm.get('name') != 'api-doc-gen':
        errs.append('name != api-doc-gen')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r307 error）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r307 error）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r307 error）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if '何时不用' not in desc:
            errs.append('description 缺「何时不用」负向（r307 warning）')
    if '# api-doc-generator' in text:
        errs.append('H1 命名不一致（api-doc-generator）')
    if '# API Doc Generator' not in body:
        errs.append('缺统一后的 H1')
    if '## Agent 执行工作流' not in body:
        errs.append('缺 Agent 执行工作流（r307 warning）')
    if '## 安全边界' not in body:
        errs.append('缺安全边界节（r307-r2 info→硬项）')
    sp = root / 'scripts' / 'generate_api_doc.py'
    if not (sp.is_file() and sp.stat().st_size > 0):
        errs.append('scripts/generate_api_doc.py 缺失')
    if 'generate_api_doc.py' not in body:
        errs.append('未被正文引用: generate_api_doc.py')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/api-doc-gen-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1),
        'drop-tags': lambda t: t.replace('tags: [api, openapi, documentation, codegen]\n', '', 1),
        'strip-compat': lambda t: t.replace('compatibility: "需要可执行 Python 3.7+', 'runtime-note: "需要可执行 Python 3.7+', 1),
        'strip-negative': lambda t: t.replace('何时不用：手工撰写单接口说明', '同样用于：手工撰写单接口说明', 1),
        'reintroduce-h1': lambda t: t.replace('# API Doc Generator', '# api-doc-generator', 1),
        'drop-workflow': lambda t: t.replace('## Agent 执行工作流', '## 说明', 1),
        'drop-safety': lambda t: t.replace('## 安全边界', '## 附录', 1),
        'unref-script': lambda t: t.replace('generate_api_doc.py', '生成脚本'),
        'delete-script': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-script':
                (dst / 'scripts' / 'generate_api_doc.py').unlink()
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
