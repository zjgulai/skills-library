#!/usr/bin/env python3
"""quarterly-review-gen1 静态校验（零请求）：genspark 族——去 GENSPARK ADAPTER/frontmatter 补齐
（version/author/complexity/compatibility）/desc 负向/business-pulse 依赖声明与降级/Step6 PDF 渲染
具体化（pandoc 范式）/qbr 模板＋样例数据拆分并被引用；带负控（11 突变判红，含文件删除）。"""
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
    if fm.get('name') != 'quarterly-review':
        errs.append('name != quarterly-review')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r340 error）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex', 'medium'):
        errs.append('complexity 非法/缺失（r340 error）')
    if not str(fm.get('author', '')).strip():
        errs.append('author 缺失（r340 error）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r340 warning）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向（r340 warning）')
    if 'GENSPARK ADAPTER' in text:
        errs.append('残留 GENSPARK ADAPTER 注入块（r340 warning）')
    if 'gsk ' in text:
        errs.append('残留 gsk CLI 平台耦合（r340 warning）')
    if 'business-pulse' not in body or '降级' not in body:
        errs.append('缺 business-pulse 声明/降级路径（r340 warning）')
    if 'pandoc' not in body or 'qbr-{YYYY-QN}.md' not in body:
        errs.append('缺 Step6 PDF 渲染具体命令（r340 warning）')
    if 'Connector failures' not in body:
        errs.append('缺连接器失败处理段（r340）')
    for rel in ('references/qbr-template.md', 'tests/sample-qbr-data.json'):
        if not (root / rel).is_file():
            errs.append(f'{rel} 缺失（r340 info）')
        if rel not in body:
            errs.append(f'未被正文引用: {rel}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/quarterly-review-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': ('SKILL.md', lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1)),
        'drop-complexity': ('SKILL.md', lambda t: t.replace('complexity: medium\nlicense:', 'license:', 1)),
        'drop-author': ('SKILL.md', lambda t: t.replace('author: "Analytics Team"\n', '', 1)),
        'strip-compat': ('SKILL.md', lambda t: t.replace('compatibility: "需要宿主提供财务数据能力', 'runtime-note: "需要宿主提供财务数据能力', 1)),
        'strip-negative': ('SKILL.md', lambda t: t.replace('Do NOT use for weekly/monthly light briefings', 'Also fine for weekly/monthly light briefings', 1)),
        'reintroduce-adapter': ('SKILL.md', lambda t: t.replace('Run the quarterly business review.', '<!-- GENSPARK ADAPTER (auto-injected) -->\n通过 `gsk mcp list` 配置\n\nRun the quarterly business review.', 1)),
        'drop-degrade': ('SKILL.md', lambda t: t.replace('降级：business-pulse 不可用时', '路径：business-pulse 可用时', 1)),
        'drop-export-cmd': ('SKILL.md', lambda t: t.replace('pandoc', '渲染工具')),
        'unref-template': ('SKILL.md', lambda t: t.replace('references/qbr-template.md', '报告模板')),
        'delete-template': None,
        'delete-tests': 'T',
    }
    with tempfile.TemporaryDirectory() as td:
        for name, spec in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-template':
                (dst / 'references' / 'qbr-template.md').unlink()
            elif name == 'delete-tests':
                (dst / 'tests' / 'sample-qbr-data.json').unlink()
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
