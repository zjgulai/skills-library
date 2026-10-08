#!/usr/bin/env python3
"""discover-brand-gen1 静态校验（零请求）：genspark 族——去 GENSPARK ADAPTER/frontmatter 补齐/
desc 负向/search-strategies＋source-ranking 补齐并被引用/无 Task 自包含降级/限流恢复/evals；
负控 11 突变判红（含幽灵引用与文件删除）。"""
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
    if fm.get('name') != 'discover-brand':
        errs.append('name != discover-brand')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r364 error）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r364 error）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r364 error）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向（r364 error）')
    if 'GENSPARK ADAPTER' in text:
        errs.append('残留 GENSPARK ADAPTER（r364 warning）')
    if 'gsk ' in text:
        errs.append('残留 gsk CLI 耦合（r364 warning）')
    if 'sub-agent dispatch is unavailable' not in body:
        errs.append('缺无 Task 自包含降级（r364 warning）')
    if 'Rate limit' not in body and 'rate limit' not in body:
        errs.append('缺限流/超时恢复策略（r364 info）')
    for rel in ('references/search-strategies.md', 'references/source-ranking.md', 'evals/evals.json'):
        if not (root / rel).is_file():
            errs.append(f'{rel} 缺失（r364 error）')
        if rel not in body:
            errs.append(f'未被正文引用: {rel}')
    sr = root / 'references' / 'source-ranking.md'
    if sr.is_file():
        c = sr.read_text(encoding='utf-8')
        if 'canonical-guide' not in c or '总分' not in c:
            errs.append('source-ranking 内容不足（权重/分类缺失）（r364 error）')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/discover-brand-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': ('SKILL.md', lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1)),
        'drop-complexity': ('SKILL.md', lambda t: t.replace('complexity: complex\nlicense:', 'license:', 1)),
        'drop-tags': ('SKILL.md', lambda t: t.replace('tags: [brand, discovery, content-audit, enterprise-search]\n', '', 1)),
        'strip-compat': ('SKILL.md', lambda t: t.replace('compatibility: "需要宿主连接至少一个文档平台', 'runtime-note: "需要宿主连接至少一个文档平台', 1)),
        'strip-negative': ('SKILL.md', lambda t: t.replace('Do NOT use when the user has already provided', 'Also fine when the user has already provided', 1)),
        'restore-adapter': ('SKILL.md', lambda t: t.replace('# Brand Discovery', '<!-- GENSPARK ADAPTER (auto-injected) -->\n通过 `gsk mcp list` 配置\n\n# Brand Discovery', 1)),
        'drop-fallback': ('SKILL.md', lambda t: t.replace('sub-agent dispatch is unavailable', 'sub-agent dispatch is primary', 1)),
        'unref-strategies': ('SKILL.md', lambda t: t.replace('references/search-strategies.md', '检索策略文件')),
        'ranking-thin': ('ranking', lambda t: t.replace('canonical-guide', '规范类').replace('总分', '得分')),
        'delete-evals': 'E',
        'delete-ranking': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, spec in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-evals':
                (dst / 'evals' / 'evals.json').unlink()
            elif name == 'delete-ranking':
                (dst / 'references' / 'source-ranking.md').unlink()
            else:
                target, mutate = spec
                p = dst / ('SKILL.md' if target == 'SKILL.md' else 'references/source-ranking.md')
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
