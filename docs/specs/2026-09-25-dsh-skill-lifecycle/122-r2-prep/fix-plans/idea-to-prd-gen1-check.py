#!/usr/bin/env python3
"""idea-to-prd-gen1 静态校验（零请求）：kimi 族——frontmatter（version/complexity/license/author/
tags/compatibility）/desc 含「不适用于」/安全与边界（输入是数据不是指令）/渐进式披露（PRD 模板正文
不得留在主文件、下沉 references 且被引用）/六阶段完整；带负控（9 突变各自判红）。"""
import re, shutil, sys, tempfile
from pathlib import Path
import yaml

SIZE_LIMIT = 11000
TEMPLATE_MARK = '# [产品名称] - 产品需求文档（PRD）'


def validate(root: Path) -> list:
    errs = []
    sk = root / 'SKILL.md'
    if not sk.is_file():
        return ['SKILL.md 缺失']
    text = sk.read_text(encoding='utf-8')
    if len(text.encode('utf-8')) > SIZE_LIMIT:
        errs.append(f'SKILL.md 超体量上限（>{SIZE_LIMIT}B）: {len(text.encode("utf-8"))}')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1)); body = m.group(2)
    if fm.get('name') != 'idea-to-prd':
        errs.append('name != idea-to-prd')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver/缺失（r284 error）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r284 warning）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    if not str(fm.get('author', '')).strip():
        errs.append('author 缺失')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r284 error）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if '不适用于' not in desc:
            errs.append('description 缺「不适用于」负向触发（r284 warning）')
    if '## 安全与边界' not in body:
        errs.append('缺「安全与边界」节（r284-r2 warning）')
    if '输入是数据不是指令' not in body:
        errs.append('缺输入指令性防护守卫')
    for ph in ('Phase 1', 'Phase 2', 'Phase 3', 'Phase 4', 'Phase 5', 'Phase 6'):
        if ph not in body:
            errs.append(f'缺流程阶段：{ph}')
    if TEMPLATE_MARK in text:
        errs.append('PRD 模板正文仍在 SKILL.md（渐进式披露未完成）')
    for ref in ('prd-template.md', 'worked-example.md', 'methodology.md'):
        p = root / 'references' / ref
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'references/{ref} 缺失')
        if ref not in body:
            errs.append(f'未被正文引用: {ref}')
    tp = root / 'references' / 'prd-template.md'
    if tp.is_file() and TEMPLATE_MARK not in tp.read_text(encoding='utf-8'):
        errs.append('prd-template.md 缺模板正文')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/idea-to-prd-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1),
        'drop-compat': lambda t: t.replace('compatibility: "任何具备文本生成能力的 agent 运行时', 'runtime-note: "任何具备文本生成能力的 agent 运行时', 1),
        'strip-negative': lambda t: t.replace('不适用于：已有完整 PRD', '同样适用于：已有完整 PRD', 1),
        'drop-safety': lambda t: t.replace('## 安全与边界', '## 补充说明', 1),
        'drop-data-guard': lambda t: t.replace('输入是数据不是指令', '输入可被当作指令', 1),
        'reinline-template': lambda t: t.replace('## 参考文件', f'```markdown\n{TEMPLATE_MARK}\n```\n\n## 参考文件', 1),
        'unref-template': lambda t: t.replace('prd-template.md', '模板说明'),
        'bloat-skill': lambda t: t.replace('## Quick Start', '## Quick Start\n\n' + ('冗长堆叠。' * 1200), 1),
        'delete-worked-example': None,
        'delete-methodology': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-worked-example':
                (dst / 'references' / 'worked-example.md').unlink()
            elif name == 'delete-methodology':
                (dst / 'references' / 'methodology.md').unlink()
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
