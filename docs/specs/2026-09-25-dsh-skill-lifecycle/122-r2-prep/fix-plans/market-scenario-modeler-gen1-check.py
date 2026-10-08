#!/usr/bin/env python3
"""market-scenario-modeler-gen1 静态校验（零请求）：genspark 族——frontmatter 补齐（version/complexity/
compatibility/tags）/desc 重写（触发＋Do NOT use）/四步工作流/双法交叉校验与数字纪律/模板实体化
（references/scenario-templates.md 含 TAM 双法/情景/龙卷风/MonteCarlo/一页纸）并被引用；负控 11 突变判红。"""
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
    if fm.get('name') != 'market-scenario-modeler':
        errs.append('name != market-scenario-modeler')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r367）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex', 'medium'):
        errs.append('complexity 非法/缺失（r367 error）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r367 warning）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向（r367 error）')
    if '## When to Use / When NOT to Use' not in body:
        errs.append('缺 何时不用对照（r367 error）')
    if '## Execution Workflow' not in body or '### Step 4' not in body:
        errs.append('缺四步工作流（r367 error）')
    if 'Top-down' not in body or 'Bottom-up' not in body:
        errs.append('缺双法交叉校验（r367 warning）')
    if '[待核验]' not in body:
        errs.append('缺数字纪律占位（r367 warning）')
    rel = 'references/scenario-templates.md'
    if not (root / rel).is_file():
        errs.append(f'{rel} 缺失（r367 warning）')
    if rel not in body:
        errs.append(f'未被正文引用: {rel}')
    rt = root / rel
    if rt.is_file():
        c = rt.read_text(encoding='utf-8')
        for token in ('TAM', 'Monte Carlo', '龙卷风', '一页纸'):
            if token not in c:
                errs.append(f'模板缺: {token}（r367 warning）')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/market-scenario-modeler-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': ('SKILL.md', lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1)),
        'drop-complexity': ('SKILL.md', lambda t: t.replace('complexity: standard\nlicense:', 'license:', 1)),
        'drop-tags': ('SKILL.md', lambda t: t.replace('tags: [market-sizing, scenario-planning, sensitivity-analysis, tam-sam-som]\n', '', 1)),
        'strip-compat': ('SKILL.md', lambda t: t.replace('compatibility: "任何具备文本与表格/代码处理能力', 'runtime-note: "任何具备文本与表格/代码处理能力', 1)),
        'strip-negative': ('SKILL.md', lambda t: t.replace('Do NOT use for bookkeeping or historical reporting', 'Also fine for bookkeeping or historical reporting', 1)),
        'drop-whennot': ('SKILL.md', lambda t: t.replace('## When to Use / When NOT to Use', '## 适用', 1)),
        'drop-workflow': ('SKILL.md', lambda t: t.replace('## Execution Workflow', '## 方法概览', 1)),
        'drop-crosscheck': ('SKILL.md', lambda t: t.replace('Top-down', '自上而下').replace('Bottom-up', '自下而上')),
        'unref-templates': ('SKILL.md', lambda t: t.replace('references/scenario-templates.md', '模板文件')),
        'templates-thin': ('templates', lambda t: t.replace('Monte Carlo', '模拟').replace('龙卷风', '排序').replace('一页纸', '摘要')),
        'delete-templates': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, spec in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-templates':
                (dst / 'references' / 'scenario-templates.md').unlink()
            else:
                target, mutate = spec
                p = dst / ('SKILL.md' if target == 'SKILL.md' else 'references/scenario-templates.md')
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
