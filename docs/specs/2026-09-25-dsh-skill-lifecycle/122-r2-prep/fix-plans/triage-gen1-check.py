#!/usr/bin/env python3
"""triage-gen1 静态校验（零请求）：mactt 族——frontmatter 全套（含保留 disable-model-invocation
功能开关）/desc DO NOT use/When to Use 节/默认 Label 映射/子技能降级/错误处理节；带负控（9 突变）。"""
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
    if fm.get('name') != 'triage':
        errs.append('name != triage')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r334 error）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r334 error）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失（r334 error）')
    if fm.get('disable-model-invocation') is not True:
        errs.append('disable-model-invocation 开关必须保留为顶层 true（功能开关，勿挪位）')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r334 error）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向（r334 warning）')
    if '## When to Use / When NOT to Use' not in body:
        errs.append('缺 When to Use / When NOT to Use 节（r334-r1）')
    if 'status:needs-triage' not in body:
        errs.append('缺默认 Label 映射表（r334）')
    if 'run the same loop inline' not in body:
        errs.append('缺 grilling/domain-modeling 降级（r334）')
    if '## Troubleshooting / 错误处理' not in body:
        errs.append('缺错误处理节（r334-r1 info→硬项）')
    for f_ in ('AGENT-BRIEF.md', 'OUT-OF-SCOPE.md'):
        if not (root / f_).is_file():
            errs.append(f'{f_} 缺失')
        if f_ not in body:
            errs.append(f'未被正文引用: {f_}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/triage-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1),
        'drop-license': lambda t: t.replace('license: MIT\nauthor:', 'author:', 1),
        'drop-switch': lambda t: t.replace('disable-model-invocation: true\n', '', 1),
        'strip-compat': lambda t: t.replace('compatibility: "需要具备 Issue Tracker', 'runtime-note: "需要具备 Issue Tracker', 1),
        'strip-negative': lambda t: t.replace('Do NOT use for feature implementation', 'Also fine for feature implementation', 1),
        'drop-whennot': lambda t: t.replace('## When to Use / When NOT to Use', '## 说明', 1),
        'drop-default-map': lambda t: t.replace('status:needs-triage', '需要分诊'),
        'drop-fallback': lambda t: t.replace('run the same loop inline', '等待宿主提供'),
        'drop-troubleshooting': lambda t: t.replace('## Troubleshooting / 错误处理', '## 附录', 1),
        'delete-brief': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-brief':
                (dst / 'AGENT-BRIEF.md').unlink()
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
