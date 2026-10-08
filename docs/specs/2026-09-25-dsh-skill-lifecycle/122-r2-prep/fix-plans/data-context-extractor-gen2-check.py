#!/usr/bin/env python3
"""data-context-extractor-gen2 静态校验（零请求）：在 gen1 基础上加 v2 五项——
tags/desc 边界案例/Phase 2 祈使交互规则/路径统一（无 references/tables/）/打包前自检；
带负控（≥10 突变各自判红）。"""
import re
import shutil
import sys
import tempfile
from pathlib import Path

import yaml

REQUIRED_HEADINGS = ['# Data Context Extractor', '## Bootstrap Mode', '## Iteration Mode',
                     '## Reference File Standards', '## Quality Checklist']
REFS = ['references/skill-template.md', 'references/sql-dialects.md', 'references/domain-template.md']


def validate(root: Path) -> list:
    errs = []
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1))
    body = m.group(2)
    if fm.get('name') != 'data-context-extractor':
        errs.append('name != data-context-extractor')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失')
    if str(fm.get('license', '')).strip() != 'MIT':
        errs.append('license 非 MIT')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失')
    if 'keywords' in fm:
        errs.append('残留非标准 keywords 顶层字段')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags):
        errs.append('tags 缺失（v2 增补）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (200 <= len(desc) <= 500):
            errs.append(f'description 长度越界（≤500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺负向触发')
        if 'Boundary: if a user only shares DDL' not in desc:
            errs.append('description 缺边界案例（v2 增补）')
    for h in REQUIRED_HEADINGS:
        if h not in body:
            errs.append(f'缺章节 {h}')
    if '~~' in text:
        errs.append('残留占位宏 ~~')
    if 'GENSPARK' in text:
        errs.append('残留 GENSPARK 适配段')
    if 'CONNECTORS' in text:
        errs.append('残留 CONNECTORS 引用')
    if 'argument-hint' in text:
        errs.append('残留 argument-hint')
    if 'at most **2 core entity questions per message**' not in body:
        errs.append('缺 Phase 2 祈使交互规则（v2 增补）')
    st_text = (root / 'references' / 'skill-template.md').read_text(encoding='utf-8') if (root / 'references' / 'skill-template.md').is_file() else ''
    if 'references/tables/' in text or 'references/tables/' in st_text:
        errs.append('路径未统一（残留 references/tables/）')
    if 'run the Quality Checklist at the end of this file' not in body:
        errs.append('缺打包前自检（v2 增补）')
    for rel in REFS:
        p = root / rel
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'引用文件缺失/空: {rel}')
        if rel.split('/')[-1] not in body:
            errs.append(f'未被正文引用: {rel}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/data-context-extractor-gen2')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\n', '', 1),
        'reinsert-macro': lambda t: t.replace(
            'the connected data-warehouse tools (query and schema, e.g., a warehouse MCP integration) to connect',
            '~~data warehouse tools to connect', 1),
        'drop-negative': lambda t: t.replace('Do NOT use for one-off SQL writing', 'Also fine for one-off SQL writing', 1),
        'inflate-desc': lambda t: t.replace(
            'Do NOT use for one-off SQL writing.',
            'Do NOT use for one-off SQL writing. Padding text appended to push the description beyond the five hundred character limit for the negative control case run today now.', 1),
        'drop-tags': lambda t: t.replace('tags: [data-analysis, meta-skill, context-extraction, sql]\n', '', 1),
        'strip-boundary': lambda t: t.replace(
            'Boundary: if a user only shares DDL for explanation, explain it directly instead of generating a skill.',
            'Boundary: see workflow.', 1),
        'drop-p2rules': lambda t: t.replace('- Ask at most **2 core entity questions per message** — never dump the whole list at once.\n', '', 1),
        'reintroduce-tables-path': lambda t: t.replace(
            'Create `references/[domain].md` using the domain template',
            'Create `references/tables/[domain].md` using the domain template', 1),
        'drop-p4check': lambda t: t.replace(
            '1. Before packaging, run the Quality Checklist at the end of this file against the generated skill and fix any gaps — do not package a skill that fails its own checklist.',
            '1. Review the files before packaging.', 1),
        'delete-ref-domain-template': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-ref-domain-template':
                (dst / 'references' / 'domain-template.md').unlink()
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
