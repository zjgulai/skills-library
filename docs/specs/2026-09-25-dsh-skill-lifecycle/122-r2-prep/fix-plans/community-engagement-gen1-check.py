#!/usr/bin/env python3
"""community-engagement-gen1 静态校验（零请求）：genspark 族——frontmatter 补齐（version/complexity/
compatibility）/desc 重写含负向/何时不用对照/Execution Workflow 四步/模板实体化（references/templates.md
含 P0-P3 矩阵）＋平台细则（Discord/指标公式）＋evals；安全边界与交付自检；带负控（12 突变判红）。"""
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
    if fm.get('name') != 'community-engagement':
        errs.append('name != community-engagement')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r315 error）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex', 'medium'):
        errs.append('complexity 非法/缺失（r315 error）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r315 error）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向（r315 error）')
    if '## When to Use / When NOT to Use' not in body:
        errs.append('缺 何时不用对照（r315 warning）')
    if '## Execution Workflow' not in body or '场景诊断与受众画像' not in body:
        errs.append('缺 Execution Workflow 四步（r315 error）')
    if '## Safety Boundaries' not in body or '水军' not in body:
        errs.append('缺安全边界（r315 info→硬项）')
    if '## Delivery Checklist' not in body or '[ ]' not in body:
        errs.append('缺交付自检清单（r315 info）')
    for rel in ('references/templates.md', 'references/platform-playbook.md', 'evals/evals.json'):
        if not (root / rel).is_file():
            errs.append(f'{rel} 缺失（r315）')
        if rel not in body:
            errs.append(f'未被正文引用: {rel}')
    tp = root / 'references' / 'templates.md'
    if tp.is_file():
        t = tp.read_text(encoding='utf-8')
        if 'P0' not in t or '欢迎' not in t:
            errs.append('模板实体化不足（缺 P0 矩阵或欢迎脚本）（r315 error）')
    pp = root / 'references' / 'platform-playbook.md'
    if pp.is_file():
        p = pp.read_text(encoding='utf-8')
        if 'Discord' not in p or '参与率' not in p:
            errs.append('平台细则不足（缺平台差异或指标公式）（r315 warning）')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/community-engagement-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': ('SKILL.md', lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1)),
        'drop-complexity': ('SKILL.md', lambda t: t.replace('complexity: medium\nlicense:', 'license:', 1)),
        'strip-compat': ('SKILL.md', lambda t: t.replace('compatibility: "任何具备文本生成能力', 'runtime-note: "任何具备文本生成能力', 1)),
        'strip-negative': ('SKILL.md', lambda t: t.replace('Do NOT use for generic ad campaign', 'Also fine for generic ad campaign', 1)),
        'drop-whennot': ('SKILL.md', lambda t: t.replace('## When to Use / When NOT to Use', '## 适用', 1)),
        'drop-workflow': ('SKILL.md', lambda t: t.replace('## Execution Workflow', '## 说明', 1)),
        'drop-safety': ('SKILL.md', lambda t: t.replace('## Safety Boundaries', '## 备注', 1)),
        'drop-checklist': ('SKILL.md', lambda t: t.replace('## Delivery Checklist', '## 结尾', 1)),
        'unref-templates': ('SKILL.md', lambda t: t.replace('references/templates.md', '模板文件')),
        'unref-playbook': ('SKILL.md', lambda t: t.replace('references/platform-playbook.md', '平台细则')),
        'templates-strip-p0': ('templates', lambda t: t.replace('P0', '一级')),
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
                p = dst / ('SKILL.md' if target == 'SKILL.md' else 'references/templates.md')
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
