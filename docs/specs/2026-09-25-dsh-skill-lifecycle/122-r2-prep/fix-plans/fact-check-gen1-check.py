#!/usr/bin/env python3
"""fact-check-gen1 静态校验（零请求）：genspark 族——frontmatter 规范化（version/complexity/
compatibility/license；triggers 收敛入 metadata）/desc 负向（观点·预测排除）/evals 回归集＋
verdict 指南拆分并被引用/保留 unverified≠false 边界；带负控（10 突变各自判红，含内容与文件删除）。"""
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
    if fm.get('name') != 'fact-check':
        errs.append('name != fact-check')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r313）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex', 'medium'):
        errs.append('complexity 非法/缺失（r313 error）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r313 warning）')
    if 'triggers' in fm:
        errs.append('triggers 不应在顶层（r313 info）')
    meta = fm.get('metadata')
    if not (isinstance(meta, dict) and isinstance(meta.get('triggers'), list) and meta.get('triggers')):
        errs.append('metadata.triggers 缺失（r313 info）')
    if str(fm.get('allowed-tools', '')).strip() == '':
        errs.append('allowed-tools 缺失')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向（r313 warning）')
    if 'Distinguish false from unverified' not in body:
        errs.append('缺 unverified≠false 边界（r313）')
    for rel in ('references/verdict-guidelines.md', 'evals/evals.json'):
        if not (root / rel).is_file():
            errs.append(f'{rel} 缺失（r313 info）')
        if rel not in body:
            errs.append(f'未被正文引用: {rel}')
    vg = root / 'references' / 'verdict-guidelines.md'
    if vg.is_file():
        v = vg.read_text(encoding='utf-8')
        if 'Unverified' not in v:
            errs.append('verdict 指南缺 Unverified 档（r313）')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/fact-check-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': ('SKILL.md', lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1)),
        'drop-complexity': ('SKILL.md', lambda t: t.replace('complexity: medium\nlicense:', 'license:', 1)),
        'strip-compat': ('SKILL.md', lambda t: t.replace('compatibility: "需要宿主提供 Genspark', 'runtime-note: "需要宿主提供 Genspark', 1)),
        'strip-negative': ('SKILL.md', lambda t: t.replace('Do NOT use for opinions, predictions', 'Also fine for opinions, predictions', 1)),
        'hoist-triggers': ('SKILL.md', lambda t: t.replace('---\n\n# Fact Check', '\ntriggers:\n  - fact-check this\n---\n\n# Fact Check', 1)),
        'drop-allowed': ('SKILL.md', lambda t: t.replace('allowed-tools: create_task\n', '', 1)),
        'drop-unverified-rule': ('SKILL.md', lambda t: t.replace('Distinguish false from unverified', '区分真假与未核实', 1)),
        'unref-evals': ('SKILL.md', lambda t: t.replace('evals/evals.json', '评测用例文件')),
        'verdict-strip-unverified': ('verdict', lambda t: t.replace('Unverified', 'Unknown')),
        'delete-evals': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, spec in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-evals':
                (dst / 'evals' / 'evals.json').unlink()
            else:
                target, mutate = spec
                p = dst / ('SKILL.md' if target == 'SKILL.md' else 'references/verdict-guidelines.md')
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
