#!/usr/bin/env python3
"""variance-analysis-gen1 静态校验（零请求）：genspark 族——frontmatter 全套（去 argument-hint）/
desc 负向/五步工作流/两个 references 拆分且被引用；带负控（9 突变各自判红）。"""
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
    if fm.get('name') != 'variance-analysis':
        errs.append('name != variance-analysis')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r337）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r337）')
    if 'argument-hint' in text:
        errs.append('残留 argument-hint 非标字段（r337）')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r337）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc and 'Do not use' not in desc:
            errs.append('description 缺 Do NOT use 负向（r337）')
    if '## Step-by-Step Workflow' not in body:
        errs.append('缺五步工作流（r337 warning）')
    for ref in ('decomposition-formulas.md', 'waterfall-templates.md'):
        p = root / 'references' / ref
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'references/{ref} 缺失')
        if ref not in body:
            errs.append(f'未被正文引用: {ref}')
    if '## Materiality Thresholds and Investigation Triggers' not in body:
        errs.append('重大性阈值节不应被拆分')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/variance-analysis-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1),
        'drop-tags': lambda t: t.replace('tags: [finance, variance, analysis, reporting]\n', '', 1),
        'reintroduce-argument-hint': lambda t: t.replace('version: "1.0.0"\n', 'version: "1.0.0"\nargument-hint: "<line item>"\n', 1),
        'strip-compat': lambda t: t.replace('compatibility: "任何具备文本与表格处理能力', 'runtime-note: "任何具备文本与表格处理能力', 1),
        'strip-negative': lambda t: t.replace('Do NOT use for bookkeeping entries', 'Also fine for bookkeeping entries', 1),
        'drop-workflow': lambda t: t.replace('## Step-by-Step Workflow', '## 说明', 1),
        'unref-formulas': lambda t: t.replace('decomposition-formulas.md', '分解公式说明'),
        'delete-waterfall-ref': None,
        'drop-materiality': lambda t: t.replace('## Materiality Thresholds and Investigation Triggers', '## 阈值', 1),
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-waterfall-ref':
                (dst / 'references' / 'waterfall-templates.md').unlink()
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
