#!/usr/bin/env python3
"""incident-retrospective-gen1 静态校验（零请求）：kimi 族——frontmatter 全套/desc 何时不用/
H1 命名统一/非交互执行指引/脚本完好被引用；带负控（8 突变各自判红）。"""
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
    if fm.get('name') != 'incident-retrospective':
        errs.append('name != incident-retrospective')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r358 error 面）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r358 error 面）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空（r358-r1）')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if '何时不用' not in desc:
            errs.append('description 缺「何时不用」负向（r358 warning）')
    if '# postmortem-writer' in text:
        errs.append('H1 仍为 postmortem-writer（r358-r2：命名不一致）')
    if '# Incident Retrospective' not in body:
        errs.append('缺统一后的 H1')
    if '## Agent 执行指引（非交互环境优先）' not in body:
        errs.append('缺非交互执行指引（r358-r2）')
    if '--input incident.json' not in body:
        errs.append('缺非交互脚本调用方式')
    sp = root / 'scripts' / 'generate_postmortem.py'
    if not (sp.is_file() and sp.stat().st_size > 0):
        errs.append('scripts/generate_postmortem.py 缺失')
    if 'generate_postmortem.py' not in body:
        errs.append('未被正文引用: generate_postmortem.py')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/incident-retrospective-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1),
        'drop-tags': lambda t: t.replace('tags: [sre, postmortem, rca, incident]\n', '', 1),
        'strip-negative': lambda t: t.replace('何时不用：正在发生的故障紧急止损', '同样用于：正在发生的故障紧急止损', 1),
        'reintroduce-h1': lambda t: t.replace('# Incident Retrospective', '# postmortem-writer', 1),
        'drop-guide': lambda t: t.replace('## Agent 执行指引（非交互环境优先）', '## 说明', 1),
        'drop-input-usage': lambda t: t.replace('--input incident.json', '--file data.json'),
        'unref-script': lambda t: t.replace('generate_postmortem.py', '脚本'),
        'delete-script': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-script':
                (dst / 'scripts' / 'generate_postmortem.py').unlink()
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
