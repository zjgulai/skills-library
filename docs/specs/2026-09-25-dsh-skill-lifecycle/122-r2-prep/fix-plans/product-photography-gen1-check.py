#!/usr/bin/env python3
"""product-photography-gen1 静态校验（零请求）：genspark 族——frontmatter 标准化（去 allowed-tools
与私标标记）/desc 负向/belt 可选＋降级/无 GENSPARK ADAPTER；v2（r375）：Execution Workflow/
提示词构建公式与负向提示/渐进式披露三分并引用/metadata author+inputs+outputs/desc 边界案例/
去 npx skills add 注入/主文件瘦身 ≤8KB；带负控（15 突变各自判红，含文件删除突变）。"""
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
    if fm.get('name') != 'product-photography':
        errs.append('name != product-photography')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r362）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r362 error）')
    if 'allowed-tools' in fm:
        errs.append('allowed-tools 非标字段残留（r362-r2）')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r362 error）')
    # v2：metadata 结构化声明
    meta = fm.get('metadata')
    if not (isinstance(meta, dict) and str(meta.get('author', '')).strip()
            and str(meta.get('inputs', '')).strip() and str(meta.get('outputs', '')).strip()):
        errs.append('metadata author/inputs/outputs 缺失（r375-r1 info→硬项）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向（r362）')
        if 'Boundary cases' not in desc:
            errs.append('description 缺边界案例（r375-r1/r2）')
    if 'GENSPARK ADAPTER' in text:
        errs.append('残留 GENSPARK ADAPTER 注入段（r362-r2）')
    if 'npx skills add' in text:
        errs.append('残留 npx skills add 注入（r375-r1/r2）')
    if 'Optional execution branch' not in body:
        errs.append('缺 belt 缺失时的降级说明（r362-r2/r375）')
    if 'gsk ' in text:
        errs.append('残留 gsk CLI 平台耦合说明（r362-r2）')
    # v2：执行工作流（祈使）
    if '## Execution Workflow' not in body:
        errs.append('缺 Execution Workflow（r375-r1 warning）')
    # v2：提示词构建公式＋负向提示
    if 'Prompt Construction Formula' not in body or 'Standard negative prompt' not in body:
        errs.append('缺提示词构建公式/负向提示（r375-r2 info→硬项）')
    # v2：渐进式披露 + 引用
    for rel in ('references/lighting-and-angles.md', 'references/categories.md', 'references/e-commerce-sets.md'):
        if not (root / rel).is_file():
            errs.append(f'{rel} 缺失（r375-r1/r2 拆分）')
        if rel not in body:
            errs.append(f'未被正文引用: {rel}')
    # v2：主文件瘦身
    if len(text.encode('utf-8')) > 8000:
        errs.append(f'SKILL.md 未瘦身（>8KB）: {len(text.encode("utf-8"))}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/product-photography-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': ('SKILL.md', lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1)),
        'drop-tags': ('SKILL.md', lambda t: t.replace('tags: [photography, product, ecommerce, prompt]\n', '', 1)),
        'strip-compat': ('SKILL.md', lambda t: t.replace('compatibility: "任何具备文本生成能力', 'runtime-note: "任何具备文本生成能力', 1)),
        'strip-negative': ('SKILL.md', lambda t: t.replace('Do NOT use for general retouching', 'Also fine for general retouching', 1)),
        'drop-boundary': ('SKILL.md', lambda t: t.replace('Boundary cases: pure background removal', 'More scope: pure background removal', 1)),
        'drop-meta': ('SKILL.md', lambda t: t.replace('  author: "inference-sh skills contributors"\n', '', 1)),
        'reintroduce-adapter': ('SKILL.md', lambda t: t.replace('# Product Photography', '<!-- GENSPARK ADAPTER (auto-injected) -->\n\n# Product Photography', 1)),
        'reintroduce-allowed': ('SKILL.md', lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'version: "1.0.0"\nallowed-tools: Bash(belt *)\ncomplexity:', 1)),
        'reintroduce-gsk': ('SKILL.md', lambda t: t.replace('## Common Mistakes', '通过 `gsk mcp list` 配置\n\n## Common Mistakes', 1)),
        'reintroduce-npx': ('SKILL.md', lambda t: t.replace('## Reference Files', 'npx skills add inference-sh/skills@ai-image-generation\n\n## Reference Files', 1)),
        'drop-degrade': ('SKILL.md', lambda t: t.replace('Optional execution branch', 'Execution branch', 1)),
        'drop-workflow': ('SKILL.md', lambda t: t.replace('## Execution Workflow', '## 说明', 1)),
        'drop-formula': ('SKILL.md', lambda t: t.replace('Prompt Construction Formula', '提示词要点', 1)),
        'unref-refs': ('SKILL.md', lambda t: t.replace('references/lighting-and-angles.md', '布光速查')),
        'delete-ref': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, spec in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-ref':
                (dst / 'references' / 'categories.md').unlink()
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
