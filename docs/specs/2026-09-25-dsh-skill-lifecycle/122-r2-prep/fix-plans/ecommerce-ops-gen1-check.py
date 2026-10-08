#!/usr/bin/env python3
"""ecommerce-ops-gen1 静态校验（零请求）：chuhai 族——frontmatter 全套（version/complexity/
license/author/compatibility）/desc 负向/关键计算与阈值节（落地成本＋退款阈值）/openai.yaml
引导参数/examples 样例落地；带负控（8 突变各自判红，含跨文件突变）。"""
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
    if fm.get('name') != 'ecommerce-ops':
        errs.append('name != ecommerce-ops')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver/缺失')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r303 error 面）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    if not str(fm.get('author', '')).strip():
        errs.append('author 缺失')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r303 error 面）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向（r303 error 面）')
    if '## 关键计算与阈值' not in body:
        errs.append('缺「关键计算与阈值」节（r303 warning）')
    if '落地单件成本' not in body:
        errs.append('缺落地成本公式（r303-r1 warning）')
    if '退款率' not in body or '5%' not in body:
        errs.append('缺退款率阈值行（r303-r2 warning）')
    oy = root / 'agents' / 'openai.yaml'
    if not (oy.is_file() and 'landed-cost cash model' in oy.read_text(encoding='utf-8')):
        errs.append('openai.yaml default_prompt 未升级（r303 warning）')
    ex = root / 'examples' / 'sample-four-week-validation.md'
    if not (ex.is_file() and ex.stat().st_size > 0):
        errs.append('examples/sample-four-week-validation.md 缺失（r303-r2 info）')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/ecommerce-ops-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-complexity': lambda t: t.replace('complexity: complex\nlicense:', 'license:', 1),
        'drop-author': lambda t: t.replace('author: "Velocity1, LLC (出海去孵化器)"\n', '', 1),
        'strip-compat': lambda t: t.replace('compatibility: "任何具备文本生成能力', 'runtime-note: "任何具备文本生成能力', 1),
        'strip-negative': lambda t: t.replace('Do NOT use for pure software', 'Also fine for pure software', 1),
        'drop-thresholds': lambda t: t.replace('## 关键计算与阈值', '## 计算说明', 1),
        'drop-landed-cost': lambda t: t.replace('落地单件成本', '成本合计'),
        'revert-openai': None,
        'delete-examples': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-examples':
                (dst / 'examples').rename(dst / 'examples-moved')
            elif name == 'revert-openai':
                p = dst / 'agents' / 'openai.yaml'
                t = p.read_text(encoding='utf-8')
                mutated = t.replace('landed-cost cash model', 'help me complete this task')
                assert mutated != t, f'{name}: 突变未生效'
                p.write_text(mutated, encoding='utf-8')
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
