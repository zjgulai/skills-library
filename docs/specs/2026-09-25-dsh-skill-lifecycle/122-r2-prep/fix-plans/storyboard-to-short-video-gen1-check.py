#!/usr/bin/env python3
"""storyboard-to-short-video-gen1 静态校验（零请求）：genspark 族——frontmatter 全套（complexity:
complex）/desc 触发与 Do NOT use/无幽灵 references（正文提及的每个 references/*.md 都必须存在）/
4 个拆分件存在且被引用；带负控（9 突变各自判红，含幽灵引用与文件删除突变）。"""
import re, shutil, sys, tempfile
from pathlib import Path
import yaml

REQUIRED_REFS = ['references/prompt-templates.md', 'references/recipes.md',
                 'references/consistency.md', 'references/examples.md']


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
    if fm.get('name') != 'storyboard-to-short-video':
        errs.append('name != storyboard-to-short-video')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r311）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r311 error）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r311 warning）')
    elif 'gsk' not in compat:
        errs.append('compatibility 未声明 gsk 依赖（r311 error）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向（r311 warning）')
    # 幽灵引用：正文提到的每个 references/*.md 都必须存在
    mentioned = set(re.findall(r'references/[\w.\-]+\.md', body))
    for rel in sorted(mentioned):
        if not (root / rel).is_file():
            errs.append(f'幽灵引用（文件不存在）: {rel}（r311 error）')
    # 必需拆分件：存在且被引用
    for rel in REQUIRED_REFS:
        if not (root / rel).is_file():
            errs.append(f'{rel} 缺失（r311 error）')
        if rel not in body:
            errs.append(f'未被正文引用: {rel}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/storyboard-to-short-video-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': ('SKILL.md', lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1)),
        'drop-complexity': ('SKILL.md', lambda t: t.replace('complexity: complex\nlicense:', 'license:', 1)),
        'drop-tags': ('SKILL.md', lambda t: t.replace('tags: [video, storyboard, short-video, multimodal, consistency]\n', '', 1)),
        'strip-compat': ('SKILL.md', lambda t: t.replace('compatibility: "需要宿主提供 `gsk` CLI', 'runtime-note: "需要宿主提供 `gsk` CLI', 1)),
        'strip-negative': ('SKILL.md', lambda t: t.replace('Do NOT use for single static shots', 'Also fine for single static shots', 1)),
        'reghost-ref': ('SKILL.md', lambda t: t.replace('references/recipes.md', 'references/recipes-v2.md')),
        'unref-template': ('SKILL.md', lambda t: t.replace('references/prompt-templates.md', '提示词模板')),
        'delete-ref': None,
        'delete-skills-md': 'SKILL_DELETE',
    }
    with tempfile.TemporaryDirectory() as td:
        for name, spec in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-ref':
                (dst / 'references' / 'consistency.md').unlink()
            elif name == 'delete-skills-md':
                (dst / 'SKILL.md').unlink()
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
