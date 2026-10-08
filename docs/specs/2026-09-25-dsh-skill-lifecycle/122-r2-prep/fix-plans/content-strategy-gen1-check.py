#!/usr/bin/env python3
"""content-strategy-gen1 静态校验（零请求）：frontmatter 规范化（root version=2.1.1＋complexity＋
tags＋compatibility）/desc 含 Do NOT use 负向/Boundaries & Fallbacks/Step-by-Step Workflow/渐进式
披露双引用/无跨包越界路径/evals≥10（含对抗与冷启动）；带负控（9 突变各自判红）。"""
import json as jsonmod
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
    if fm.get('name') != 'content-strategy':
        errs.append('name != content-strategy')
    if str(fm.get('version', '')) != '2.1.1':
        errs.append('root version 应为 2.1.1（r306 error：版本字段规范化）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r306 error）')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向（r306 warning）')
    if '../../' in text:
        errs.append('SKILL.md 残留跨包越界相对路径（r319 error）')
    for f in (root / 'references').glob('*.md'):
        ft = f.read_text(encoding='utf-8')
        if '../../' in ft:
            errs.append(f'{f.name} 残留跨包越界相对路径（r319 error）')
    if '## Boundaries & Fallbacks' not in body:
        errs.append('缺 Boundaries & Fallbacks 节（r306 warning）')
    if '冷启动兜底' not in body:
        errs.append('缺冷启动兜底规则')
    if 'copywriting' not in body:
        errs.append('缺越界移交（copywriting）说明')
    if '## Step-by-Step Workflow' not in body:
        errs.append('缺 Step-by-Step Workflow（r319-r2 warning）')
    if '仅当用户涉及 CMS 选型' not in body:
        errs.append('缺 headless-cms 触发条件（r319-r2 warning）')
    if '## Content Types' not in body:
        errs.append('缺 Content Types 指引节')
    if '## Keyword Research by Buyer Stage' not in body:
        errs.append('缺 Keyword Research 指引节')
    for ref in ('content-types.md', 'keyword-research.md'):
        p = root / 'references' / ref
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'references/{ref} 缺失')
        if ref not in body:
            errs.append(f'未被正文引用: {ref}')
    ev = root / 'evals' / 'evals.json'
    if not (ev.is_file() and ev.stat().st_size > 0):
        errs.append('evals/evals.json 缺失')
    else:
        evd = jsonmod.loads(ev.read_text(encoding='utf-8'))
        if len(evd.get('evals', [])) < 10:
            errs.append('evals 用例不足（需含对抗/冷启动各 1；r319-r2 warning）')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/content-strategy-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "2.1.1"\ncomplexity:', 'complexity:', 1),
        'drop-complexity': lambda t: t.replace('complexity: complex\ntags:', 'tags:', 1),
        'strip-compat': lambda t: t.replace('compatibility: "任何具备文本生成能力', 'runtime-note: "任何具备文本生成能力', 1),
        'strip-negative': lambda t: t.replace('Do NOT use for writing actual copy', 'Also fine for writing actual copy', 1),
        'drop-boundaries': lambda t: t.replace('## Boundaries & Fallbacks', '## Notes', 1),
        'drop-workflow': lambda t: t.replace('## Step-by-Step Workflow', '## 说明', 1),
        'unref-content-types': lambda t: t.replace('content-types.md', '内容类型说明'),
        'reintroduce-boundary': None,
        'delete-keyword-ref': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'reintroduce-boundary':
                p2 = dst / 'references' / 'headless-cms.md'
                t2 = p2.read_text(encoding='utf-8')
                m2 = t2.replace('Sanity (https://www.sanity.io/docs)', '[Sanity](../../../tools/integrations/sanity.md)')
                assert m2 != t2, 'reintroduce-boundary: 突变未生效'
                p2.write_text(m2, encoding='utf-8')
            elif name == 'delete-keyword-ref':
                (dst / 'references' / 'keyword-research.md').unlink()
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
