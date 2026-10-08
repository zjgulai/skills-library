#!/usr/bin/env python3
"""risk-assessment-gen1 静态校验（零请求）：genspark 族——frontmatter 补齐（version/complexity/
compatibility/metadata.author）/desc 负向（代码调试/安全扫描/法务意见）/五步工作流/定级锚点＋
策略类＋固有-剩余拆分/示例拆分并被引用/安全边界（注入防护＋不臆造阈值）；负控 12 突变判红。"""
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
    if fm.get('name') != 'risk-assessment':
        errs.append('name != risk-assessment')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r341 error）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex', 'medium', 'basic', 'low'):
        errs.append('complexity 非法/缺失（r341 error）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    meta = fm.get('metadata')
    if not (isinstance(meta, dict) and str(meta.get('author', '')).strip()):
        errs.append('metadata.author 缺失（r341 error）')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r341 error）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向（r341 error）')
    if '## When to Use / When NOT to Use' not in body:
        errs.append('缺 何时不用对照（r341 error）')
    if '## Workflow' not in body or '### Step 5' not in body:
        errs.append('缺五步工作流（r341 error/warning）')
    if 'Inherent' not in body or 'Residual' not in body:
        errs.append('缺固有/剩余风险（r341 warning）')
    if 'Avoid' not in body or 'Transfer' not in body or 'Mitigate' not in body or 'Accept' not in body:
        errs.append('缺策略四类（r341 warning）')
    if '## Safety Boundaries' not in body or '注入' not in body or '[按组织口径校准]' not in body:
        errs.append('缺安全边界/口径占位（r341）')
    for rel in ('references/scoring-anchors.md', 'references/example-vendor-switch.md'):
        if not (root / rel).is_file():
            errs.append(f'{rel} 缺失（r341）')
        if rel not in body:
            errs.append(f'未被正文引用: {rel}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/risk-assessment-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': ('SKILL.md', lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1)),
        'drop-complexity': ('SKILL.md', lambda t: t.replace('complexity: standard\nlicense:', 'license:', 1)),
        'drop-author': ('SKILL.md', lambda t: t.replace('  author: "risk-assessment contributors"\n', '', 1)),
        'strip-compat': ('SKILL.md', lambda t: t.replace('compatibility: "任何具备文本推理能力', 'runtime-note: "任何具备文本推理能力', 1)),
        'strip-negative': ('SKILL.md', lambda t: t.replace('Do NOT use for code-level debugging', 'Also fine for code-level debugging', 1)),
        'drop-whennot': ('SKILL.md', lambda t: t.replace('## When to Use / When NOT to Use', '## 适用', 1)),
        'drop-workflow': ('SKILL.md', lambda t: t.replace('## Workflow', '## 步骤概览', 1)),
        'drop-residual': ('SKILL.md', lambda t: t.replace('Residual', '复核后')),
        'drop-strategy': ('SKILL.md', lambda t: t.replace('Avoid / Transfer / Mitigate / Accept', '相应策略')),
        'unref-anchors': ('SKILL.md', lambda t: t.replace('references/scoring-anchors.md', '锚点文件')),
        'unref-example': ('SKILL.md', lambda t: t.replace('references/example-vendor-switch.md', '示例文件')),
        'delete-example': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, spec in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-example':
                (dst / 'references' / 'example-vendor-switch.md').unlink()
            else:
                _, mutate = spec
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
