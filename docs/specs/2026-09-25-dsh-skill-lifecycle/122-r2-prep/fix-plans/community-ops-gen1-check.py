#!/usr/bin/env python3
"""community-ops-gen1 静态校验（零请求）：chuhai 族——frontmatter 全套/desc 负向/关键模板节/references 完好；带负控（8 突变各自判红）。"""
import re, shutil, sys, tempfile
from pathlib import Path
import yaml

REF_FILE = 'source-39.md'
NEG_MARK = "Discord 频道骨架"


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
    if fm.get('name') != 'community-ops':
        errs.append('name != community-ops')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver/缺失')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（基线 warning）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    if not str(fm.get('author', '')).strip():
        errs.append('author 缺失')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（基线 warning）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc and 'Do not use' not in desc:
            errs.append('description 缺 Do NOT use 负向（基线 warning）')
    if '## 关键模板' not in body:
        errs.append('缺「关键模板」节（判者建议）')
    if NEG_MARK not in body:
        errs.append(f'关键模板内容缺失: {NEG_MARK}')
    ref = root / 'references' / REF_FILE
    if not (ref.is_file() and ref.stat().st_size > 0):
        errs.append(f'references/{REF_FILE} 缺失')
    if 'INDEX.md' not in body:
        errs.append('未被正文引用: INDEX.md')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/community-ops-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1),
        'drop-complexity': lambda t: t.replace('complexity: complex\nlicense:', 'license:', 1),
        'drop-author': lambda t: t.replace('author: "Velocity1, LLC (出海去孵化器)"\n', '', 1),
        'strip-compat': lambda t: t.replace('compatibility: "任何具备文本生成能力', 'runtime-note: "任何具备文本生成能力', 1),
        'strip-negative': lambda t: t.replace('Do NOT use for', 'Also fine for', 1).replace('Do not use for', 'Also fine for', 1),
        'drop-kata': lambda t: t.replace('## 关键模板', '## 说明', 1),
        'strip-kata-mark': lambda t: t.replace(NEG_MARK, '（略）'),
        'delete-ref': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-ref':
                (dst / 'references' / REF_FILE).unlink()
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
