#!/usr/bin/env python3
"""sop-writer-gen1 静态校验（零请求）：kimi 族重度重构——frontmatter（version/complexity/license/
author/tags/compatibility）/desc 含「不适用于」/去 argument-hint 非标字段/去第一人称/四阶段工作流/
质检清单/两个 references 被引用/LICENSE.txt 纯文本；带负控（9 突变各自判红）。"""
import re, shutil, sys, tempfile
from pathlib import Path
import yaml

APACHE_MARK = 'Apache License'


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
    if fm.get('name') != 'sop-writer':
        errs.append('name != sop-writer')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver/缺失（r282 error）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r282 error）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    if not str(fm.get('author', '')).strip():
        errs.append('author 缺失（r282-r1 error）')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空（r282 warning）')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r282 warning）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if '不适用于' not in desc:
            errs.append('description 缺「不适用于」负向触发（r282 error）')
    if 'argument-hint' in text:
        errs.append('残留 argument-hint 非标字段（r282 warning）')
    for marker in ('向我描述', '我会通过提问', '帮我理清'):
        if marker in text:
            errs.append(f'残留第一人称口吻标记：{marker}（r282 warning）')
    for phase in ('阶段 1', '阶段 2', '阶段 3', '阶段 4'):
        if phase not in body:
            errs.append(f'缺四阶段工作流：{phase}')
    if '交付质检清单' not in body:
        errs.append('缺交付质检清单（r282-r2 warning）')
    for ref in ('templates.md', 'worked-example.md'):
        p = root / 'references' / ref
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'references/{ref} 缺失')
        if ref not in body:
            errs.append(f'未被正文引用: {ref}')
    lic = root / 'LICENSE.txt'
    if not lic.is_file():
        errs.append('LICENSE.txt 缺失')
    else:
        raw = lic.read_bytes()
        if b'\x00' in raw:
            errs.append('LICENSE.txt 含 NUL（不透明容器残留）')
        else:
            try:
                lt = raw.decode('utf-8')
            except UnicodeDecodeError:
                errs.append('LICENSE.txt 非 UTF-8 纯文本')
            else:
                if APACHE_MARK not in lt:
                    errs.append(f'LICENSE.txt 缺 "{APACHE_MARK}"')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/sop-writer-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1),
        'drop-tags': lambda t: t.replace('tags: [sop, process-mapping, raci, documentation]\n', '', 1),
        'strip-negative': lambda t: t.replace('不适用于：通用待办', '同样适用于：通用待办', 1),
        'reintroduce-argument-hint': lambda t: t.replace('name: sop-writer\n', 'name: sop-writer\nargument-hint: "<流程名称>"\n', 1),
        'reintroduce-firstperson': lambda t: t.replace('全程使用祈使语态', '我会通过提问帮你理清', 1),
        'drop-phase3': lambda t: t.replace('### 阶段 3 — 异常与防御挖掘', '### 异常与防御挖掘', 1),
        'unref-worked-example': lambda t: t.replace('worked-example.md', '示例说明'),
        'delete-templates': None,
        'corrupt-license': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-templates':
                (dst / 'references' / 'templates.md').unlink()
            elif name == 'corrupt-license':
                (dst / 'LICENSE.txt').write_bytes(b'\x88}\x1c\x5c\xcd\x0a\xf6\x03' + b'\x00' * 64)
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
