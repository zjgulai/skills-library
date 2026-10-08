#!/usr/bin/env python3
"""evidence-decisions-gen1 静态校验（零请求）：chuhai 族——frontmatter 全套（Apache-2.0/author）/
desc 负向/证据冲突与权重裁决/四栏证据表模板/openai.yaml 同步/参考资料被引用；负控 10 突变判红。"""
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
    if fm.get('name') != 'evidence-decisions':
        errs.append('name != evidence-decisions')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r359 error）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r359 error）')
    if 'Apache-2.0' not in str(fm.get('license', '')):
        errs.append('license != Apache-2.0（chuhai 族）')
    if 'Velocity1' not in str(fm.get('author', '')):
        errs.append('author 缺失/不符（chuhai 族）')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r359 warning）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向（r359 error）')
    if '证据冲突与权重裁决' not in body or '一手数据' not in body:
        errs.append('缺证据冲突与权重裁决（r359-r2 warning）')
    if '四栏证据表模板' not in body:
        errs.append('缺四栏证据表模板（r359-r2 warning）')
    oy = root / 'agents' / 'openai.yaml'
    if not oy.is_file():
        errs.append('agents/openai.yaml 缺失')
    else:
        oyx = oy.read_text(encoding='utf-8')
        if 'decision log' not in oyx and 'falsification' not in oyx:
            errs.append('openai.yaml 未同步边界/反证属性（r359 info）')
    for rel in ('references/INDEX.md', 'references/source-03.md'):
        if not (root / rel).is_file():
            errs.append(f'{rel} 缺失')
        elif rel not in body:
            errs.append(f'未被正文引用: {rel}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/evidence-decisions-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': ('SKILL.md', lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1)),
        'drop-complexity': ('SKILL.md', lambda t: t.replace('complexity: standard\nlicense:', 'license:', 1)),
        'strip-compat': ('SKILL.md', lambda t: t.replace('compatibility: "任何具备文本生成能力', 'runtime-note: "任何具备文本生成能力', 1)),
        'strip-negative': ('SKILL.md', lambda t: t.replace('Do NOT use for pure domain fact lookups', 'Also fine for pure domain fact lookups', 1)),
        'drop-arbitration': ('SKILL.md', lambda t: t.replace('证据冲突与权重裁决', '处理机制', 1)),
        'drop-template': ('SKILL.md', lambda t: t.replace('四栏证据表模板', '表格说明', 1)),
        'unref-index': ('SKILL.md', lambda t: t.replace('references/INDEX.md', '来源索引') ),
        'degrade-openai': ('openai', lambda t: t.replace('falsification', '复核').replace('decision log', '决策记录')),
        'delete-source': None,
        'strip-author': ('SKILL.md', lambda t: t.replace('author: "Velocity1, LLC (出海去孵化器)"\n', '', 1)),
    }
    with tempfile.TemporaryDirectory() as td:
        for name, spec in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-source':
                (dst / 'references' / 'source-03.md').unlink()
            else:
                target, mutate = spec
                p = dst / ('SKILL.md' if target == 'SKILL.md' else 'agents/openai.yaml')
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
