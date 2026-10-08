#!/usr/bin/env python3
"""legal-risk-assessment-gen1 静态校验（零请求）：genspark 族——frontmatter 全套/desc Do not use/
Workflow 五步/矩阵保留；v2（r349）：author 补齐/去人格化开头（禁 You are...assistant）/模板与升级细则
拆分 references 并被引用/tests 用例；带负控（14 突变各自判红，含文件删除突变）。"""
import re, shutil, sys, tempfile
from pathlib import Path
import yaml

BANNED_PHRASES = ['You are a legal risk assessment assistant']


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
    if fm.get('name') != 'legal-risk-assessment':
        errs.append('name != legal-risk-assessment')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r336）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r336）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    # v2：author 必填（r349-r1 error）
    if not str(fm.get('author', '')).strip():
        errs.append('author 缺失（r349-r1 error）')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r336 info→硬项）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do not use' not in desc:
            errs.append('description 缺 Do not use 负向（r336）')
    if '## Workflow / Operating Instructions' not in body:
        errs.append('缺 Workflow 五步（r336 warning）')
    for s in ('**Intake**', '**Severity evaluation**', '**Likelihood evaluation**', '**Action & escalation mapping**', '**Memo generation**'):
        if s not in body:
            errs.append(f'缺工作流步骤：{s}')
    if '### Severity x Likelihood Matrix' not in body:
        errs.append('严重性矩阵不应被拆分')
    # v2：去人格化开头
    for ph in BANNED_PHRASES:
        if ph in text:
            errs.append(f'残留人格化表述: {ph!r}（r349-r1 warning）')
    # v2：references 拆分 + 引用
    for rel in ('references/risk-memo-template.md', 'references/escalation-guidelines.md'):
        if not (root / rel).is_file():
            errs.append(f'{rel} 缺失（r349-r1/r2 拆分）')
        if rel not in body:
            errs.append(f'未被正文引用: {rel}')
    # v2：快速决策表保留
    if 'Mandatory' not in body or 'Strongly recommended' not in body:
        errs.append('缺升级快速决策表（r349-r1/r2）')
    # v2：tests 用例
    if not (root / 'tests' / 'cases.json').is_file():
        errs.append('tests/cases.json 缺失（r349-r1/r2）')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/legal-risk-assessment-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': ('SKILL.md', lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1)),
        'drop-tags': ('SKILL.md', lambda t: t.replace('tags: [legal, risk-assessment, compliance, matrix, in-house-counsel, legal-ops]\n', '', 1)),
        'strip-compat': ('SKILL.md', lambda t: t.replace('compatibility: "任何具备文本推理能力', 'runtime-note: "任何具备文本推理能力', 1)),
        'strip-negative': ('SKILL.md', lambda t: t.replace('Do not use for generic financial', 'Also fine for generic financial', 1)),
        'drop-author': ('SKILL.md', lambda t: t.replace('author: "legal-risk-assessment contributors"\n', '', 1)),
        'drop-workflow': ('SKILL.md', lambda t: t.replace('## Workflow / Operating Instructions', '## 说明', 1)),
        'drop-step1': ('SKILL.md', lambda t: t.replace('**Intake**', '**收集**', 1)),
        'rename-matrix': ('SKILL.md', lambda t: t.replace('### Severity x Likelihood Matrix', '### 矩阵', 1)),
        'drop-complexity': ('SKILL.md', lambda t: t.replace('complexity: standard\nlicense:', 'license:', 1)),
        'restore-persona': ('SKILL.md', lambda t: t.replace('Guide in-house legal teams to evaluate, classify, and document legal risks', 'You are a legal risk assessment assistant. You help evaluate, classify, and document legal risks', 1)),
        'unref-memo': ('SKILL.md', lambda t: t.replace('references/risk-memo-template.md', '备忘录模板')),
        'unref-escalation': ('SKILL.md', lambda t: t.replace('references/escalation-guidelines.md', '升级细则')),
        'drop-quicktable': ('SKILL.md', lambda t: t.replace('Strongly recommended', 'Strongly suggested')),
        'delete-tests': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, spec in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-tests':
                (dst / 'tests' / 'cases.json').unlink()
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
