#!/usr/bin/env python3
"""statistical-analysis-gen1 静态校验（零请求）：genspark 族——frontmatter 全套（保留
user-invocable 开关）/desc 负向/输入边界校验节/结构化输出模板；带负控（9 突变各自判红）。"""
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
    if fm.get('name') != 'statistical-analysis':
        errs.append('name != statistical-analysis')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r338）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r338）')
    if fm.get('user-invocable') is not False:
        errs.append('user-invocable: false 开关必须保留（功能开关，勿变更）')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r338）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向（r338）')
    if '## Input Validation & Edge Cases Handling' not in body:
        errs.append('缺输入边界校验节（r338 warning）')
    if 'N < 2' not in body or '零方差' not in body:
        errs.append('缺样本量/零方差检查')
    if '## Output Specifications' not in body:
        errs.append('缺结构化输出模板（r338 info→硬项）')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/statistical-analysis-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1),
        'drop-tags': lambda t: t.replace('tags: [statistics, analysis, hypothesis-testing, outliers]\n', '', 1),
        'drop-switch': lambda t: t.replace('user-invocable: false\n', '', 1),
        'strip-compat': lambda t: t.replace('compatibility: "任何具备文本与数值处理能力', 'runtime-note: "任何具备文本与数值处理能力', 1),
        'strip-negative': lambda t: t.replace('Do NOT use for causal claims', 'Also fine for causal claims', 1),
        'drop-validation': lambda t: t.replace('## Input Validation & Edge Cases Handling', '## 说明', 1),
        'drop-n2': lambda t: t.replace('N < 2', '样本不足', 1),
        'drop-output': lambda t: t.replace('## Output Specifications', '## 附录', 1),
        'drop-zerovar': lambda t: t.replace('零方差', '常量特征', 1),
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
