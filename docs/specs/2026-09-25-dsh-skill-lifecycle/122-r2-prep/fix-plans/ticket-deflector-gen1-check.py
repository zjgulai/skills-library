#!/usr/bin/env python3
"""ticket-deflector-gen1 静态校验（零请求）：frontmatter 规范、宿主专有残留、触发边界、
引用完整性、第二人称/占位符扫描；带负控（四个突变必须各自判红）。"""
import re
import shutil
import sys
import tempfile
from pathlib import Path

import yaml

REQUIRED_HEADINGS = [
    '## Runtime connectors', '## Quick start', '## Workflow', '## Approval gates', '## References',
]
HOST_RESIDUE = re.compile(r'GENSPARK|gsk\s|Personal Tools|gsk\b', re.I)
SECOND_PERSON = re.compile(r"\byou\b|\byour\b|\byou're\b|\byou'll\b", re.I)
PLACEHOLDER = re.compile(r'TODO|FIXME|placeholder|<your|待填|占位', re.I)
BAD_TRIGGERS = re.compile(r"where's my order|I want a refund", re.I)
REFS = ['references/gotchas.md', 'references/examples/respond-refund-request.md']


def validate(root: Path) -> list:
    errs = []
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1))
    body = m.group(2)
    if fm.get('name') != 'ticket-deflector':
        errs.append('name != ticket-deflector')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失')
    if not fm.get('license'):
        errs.append('license 缺失')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (200 <= len(desc) <= 1024):
            errs.append(f'description 长度越界 {len(desc)}')
        if re.search(r'[<>]', desc):
            errs.append('description 含 XML 角括')
        if 'Do NOT use' not in desc:
            errs.append('description 缺负向触发')
        if BAD_TRIGGERS.search(desc):
            errs.append('description 含终端买家口语触发词（已判高危）')
    if len(body) > 8000:
        errs.append(f'body 超 complex 上限 {len(body)}')
    for h in REQUIRED_HEADINGS:
        if h not in body:
            errs.append(f'缺章节 {h}')
    hr = HOST_RESIDUE.findall(text)
    if hr:
        errs.append(f'宿主专有残留 {hr[:3]}')
    if 'Claude' in text:
        errs.append('正文含硬编码模型名 Claude')
    sp = SECOND_PERSON.findall(body)
    if sp:
        errs.append(f'body 第二人称 {len(sp)} 处')
    ph = PLACEHOLDER.findall(text)
    if ph:
        errs.append(f'占位符命中 {ph[:3]}')
    for rel in REFS:
        p = root / rel
        if not p.is_file() or p.stat().st_size == 0:
            errs.append(f'引用文件缺失/空: {rel}')
        if rel not in body:
            errs.append(f'未被正文引用: {rel}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/ticket-deflector-gen1')
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: 1.0.0\n', '', 1),
        'strip-negative': lambda t: t.replace('Do NOT use', 'Especially use', 1),
        'reintroduce-host-block': lambda t: t.replace('# Ticket Deflector', '# Ticket Deflector\n<!-- GENSPARK ADAPTER -->', 1),
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            p = dst / 'SKILL.md'
            t = p.read_text(encoding='utf-8')
            mutated = mutate(t)
            assert mutated != t, f'{name}: 突变未生效（锚点漂移）'
            p.write_text(mutated, encoding='utf-8')
            e2 = validate(dst)
            red = bool(e2)
            print(f"[负控 {name}] {'RED(期望)' if red else 'GREEN(异常!)'} {e2[:2]}")
            ok = ok and red
        # 第四负控：删除一个引用文件
        dst = Path(td) / 'delete-ref'
        shutil.copytree(root, dst)
        (dst / 'references/gotchas.md').unlink()
        e3 = validate(dst)
        red = bool(e3)
        print(f"[负控 delete-ref] {'RED(期望)' if red else 'GREEN(异常!)'} {e3[:2]}")
        ok = ok and red
    sys.exit(0 if ok else 1)


main()
