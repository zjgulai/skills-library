#!/usr/bin/env python3
"""legal-risk-analyzer-gen1 静态校验（零请求）：kimi 族——frontmatter（version/complexity/license/
author/tags/compatibility）/desc 含「不适用于」负向/去顶部开发注释/四步工作流/完整示例/两个 references
被引用/LICENSE.txt 纯文本（替换不透明容器）；带负控（8 突变各自判红）。"""
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
    if fm.get('name') != 'legal-risk-analyzer':
        errs.append('name != legal-risk-analyzer')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver/缺失（r281 warning）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r281 warning）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    if not str(fm.get('author', '')).strip():
        errs.append('author 缺失（r281 warning）')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空（r281 warning）')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r280 同族 error 类）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if '不适用于' not in desc:
            errs.append('description 缺「不适用于」负向触发（r281 warning）')
    if '<!--' in text or 'Changes (zh)' in text:
        errs.append('残留 HTML 开发注释（r281-r2 info）')
    if '## 评估工作流程与执行步骤' not in body:
        errs.append('缺四步工作流节（r281 warning）')
    for step in ('Step 1', 'Step 2', 'Step 3', 'Step 4'):
        if step not in body:
            errs.append(f'工作流缺 {step}')
    if '## 完整示例' not in body:
        errs.append('缺完整示例（r281-r1 info）')
    for ref in ('templates.md', 'external-counsel.md'):
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
        'skill-lifecycle/trial-home/opt-run/candidates/legal-risk-analyzer-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1),
        'drop-tags': lambda t: t.replace('tags: [legal, risk-assessment, risk-matrix, compliance]\n', '', 1),
        'strip-negative': lambda t: t.replace('不适用于：起草或修改', '同样适用于：起草或修改', 1),
        'reintroduce-devcomment': lambda t: t.replace('# 法律风险评估技能\n', '# 法律风险评估技能\n\n<!-- Changes (zh): 开发维护注释 -->\n', 1),
        'drop-workflow': lambda t: t.replace('## 评估工作流程与执行步骤', '## 框架概览', 1),
        'unref-templates': lambda t: t.replace('templates.md', '模板说明'),
        'delete-external-counsel': None,
        'corrupt-license': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-external-counsel':
                (dst / 'references' / 'external-counsel.md').unlink()
            elif name == 'corrupt-license':
                (dst / 'LICENSE.txt').write_bytes(b'\x88}\x1c3\xcd\x0a\xf6\x03F7' + b'\x00' * 64)
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
