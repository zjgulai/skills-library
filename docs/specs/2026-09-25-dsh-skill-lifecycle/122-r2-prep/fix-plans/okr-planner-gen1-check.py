#!/usr/bin/env python3
"""okr-planner-gen1 静态校验（零请求）：kimi 族——frontmatter 全套/desc 何时不用负向/references
三拆分件被引用/安全边界节/制定与拆解 SOP 保留；带负控（9 突变各自判红）。"""
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
    if fm.get('name') != 'okr-planner':
        errs.append('name != okr-planner')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r310 warning）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r310 warning）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r310 warning）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if '何时不用' not in desc:
            errs.append('description 缺「何时不用」负向（r310 warning）')
    if '## 安全边界与异常处理' not in body:
        errs.append('缺安全边界与异常处理节（r310-r2 info→硬项）')
    if '注入' not in body:
        errs.append('缺注入防护说明')
    if '## 第二部分：OKR 制定 SOP' not in body or '## 第三部分：OKR 拆解 SOP' not in body:
        errs.append('制定/拆解 SOP 不应被拆分（保留在主文件）')
    for ref in ('okr-spec-and-anti-patterns.md', 'okr-check-rubric.md', 'okr-review-template.md'):
        p = root / 'references' / ref
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'references/{ref} 缺失')
        if ref not in body:
            errs.append(f'未被正文引用: {ref}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/okr-planner-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1),
        'drop-complexity': lambda t: t.replace('complexity: standard\nlicense:', 'license:', 1),
        'drop-tags': lambda t: t.replace('tags: [okr, goal-management, coaching, review]\n', '', 1),
        'strip-compat': lambda t: t.replace('compatibility: "任何具备文本生成能力', 'runtime-note: "任何具备文本生成能力', 1),
        'strip-negative': lambda t: t.replace('何时不用：日常任务', '同样用于：日常任务', 1),
        'drop-safety': lambda t: t.replace('## 安全边界与异常处理', '## 说明', 1),
        'drop-part2': lambda t: t.replace('## 第二部分：OKR 制定 SOP', '## 制定说明', 1),
        'unref-rubric': lambda t: t.replace('okr-check-rubric.md', '检查量表'),
        'delete-review-template': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-review-template':
                (dst / 'references' / 'okr-review-template.md').unlink()
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
