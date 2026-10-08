#!/usr/bin/env python3
"""influencer-marketing-gen1 静态校验（零请求）：81-Skills 族——frontmatter（root version＋complexity＋
compat＋metadata.author）/desc ≤500 含 Do NOT use/去越界相对路径/外部工具降级注记/上下文文件回退；
带负控（≥6 突变各自判红）。"""
import re, shutil, sys, tempfile
from pathlib import Path
import yaml

def validate(root: Path) -> list:
    errs = []
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1)); body = m.group(2)
    if fm.get('name') != 'influencer-marketing':
        errs.append('name != influencer-marketing')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('root version 非 semver')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r280 error）')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r280 error）')
    meta = fm.get('metadata') or {}
    if not str(meta.get('author', '')).strip():
        errs.append('metadata.author 缺失（r280-r2）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (200 <= len(desc) <= 500):
            errs.append(f'description 长度越界（≤500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺负向触发')
    if '../../' in text:
        errs.append('残留越界相对路径')
    if 'degrade gracefully' not in body:
        errs.append('缺 social-fetch/watch-video 降级注记')
    if 'do not stall' not in body:
        errs.append('缺上下文文件回退注记')
    ref = root / 'references/ugc-creator-program.md'
    if not (ref.is_file() and ref.stat().st_size > 0):
        errs.append('references/ugc-creator-program.md 缺失')
    if 'ugc-creator-program.md' not in body:
        errs.append('未被正文引用: ugc-creator-program.md')
    ev = root / 'evals/evals.json'
    if not (ev.is_file() and ev.stat().st_size > 0):
        errs.append('evals/evals.json 缺失')
    return errs

def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/influencer-marketing-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-root-version': lambda t: t.replace('version: "1.1.0"\ncomplexity:', 'complexity:', 1),
        'strip-negative': lambda t: t.replace('Do NOT use for general organic', 'Also fine for general organic', 1),
        'reintroduce-relative': lambda t: t.replace("use the host environment's tool registry", 'see [tools registry](../../tools/REGISTRY.md); use the host registry', 1),
        'drop-degrade': lambda t: t.replace('degrade gracefully', 'proceed as usual', 1),
        'drop-stall-note': lambda t: t.replace('do not stall', 'proceed', 1),
        'unref-ref': lambda t: t.replace('ugc-creator-program.md', 'UGC 指南'),
        'delete-ref': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-ref':
                (dst / 'references' / 'ugc-creator-program.md').unlink()
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
