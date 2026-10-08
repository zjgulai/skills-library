#!/usr/bin/env python3
"""performance-review-gen1 静态校验（零请求）：genspark 族——frontmatter 规范化（去 argument-hint；
version/complexity/compatibility）/desc 负向/去 ../../CONNECTORS.md 越界死链与 ~~ 伪标记/
H1 统一/Execution Workflow＋SBI-STAR 方法论拆分/连接器拆分；带负控（11 突变各自判红）。"""
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
    if fm.get('name') != 'performance-review':
        errs.append('name != performance-review')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r314 error）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex', 'medium'):
        errs.append('complexity 非法/缺失（r314 error）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r314 error）')
    if 'argument-hint' in fm:
        errs.append('argument-hint 非标字段残留（r314 info）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向（r314 warning）')
    if 'CONNECTORS.md' in text or '../../' in body:
        errs.append('残留 ../../CONNECTORS.md 越界死链（r314 error）')
    if '~~' in text:
        errs.append('残留 ~~ 伪标记（r314 info）')
    if '# /performance-review' in body:
        errs.append('H1 未统一（r314）')
    if '# Performance Review' not in body:
        errs.append('缺统一后的 H1')
    if '## Execution Workflow' not in body or 'SBI/STAR' not in body:
        errs.append('缺 Execution Workflow / SBI-STAR 指引（r314 warning）')
    for rel in ('references/methodology.md', 'references/connectors.md'):
        if not (root / rel).is_file():
            errs.append(f'{rel} 缺失（r314 warning）')
        if rel not in body:
            errs.append(f'未被正文引用: {rel}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/performance-review-gen1')
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
        'strip-negative': ('SKILL.md', lambda t: t.replace('Do NOT use for routine 1-on-1', 'Also fine for routine 1-on-1', 1)),
        'reintroduce-argument-hint': ('SKILL.md', lambda t: t.replace('name: performance-review\n', 'name: performance-review\nargument-hint: "<x>"\n', 1)),
        'reintroduce-connectors-link': ('SKILL.md', lambda t: t.replace('# Performance Review', '# /performance-review\n\n> [CONNECTORS.md](../../CONNECTORS.md)\n\n# Performance Review', 1)),
        'reintroduce-tilde': ('SKILL.md', lambda t: t.replace('HRIS 或项目跟踪工具，可拉取', '~~HRIS 或 ~~项目跟踪工具，可拉取', 1)),
        'drop-workflow': ('SKILL.md', lambda t: t.replace('## Execution Workflow', '## 说明', 1)),
        'unref-methodology': ('SKILL.md', lambda t: t.replace('references/methodology.md', '方法论文件')),
        'unref-connectors': ('SKILL.md', lambda t: t.replace('references/connectors.md', '连接器说明')),
        'delete-methodology': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, spec in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-methodology':
                (dst / 'references' / 'methodology.md').unlink()
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
