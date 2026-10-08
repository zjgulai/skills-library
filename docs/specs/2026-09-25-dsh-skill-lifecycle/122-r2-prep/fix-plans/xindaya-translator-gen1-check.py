#!/usr/bin/env python3
"""xindaya-translator-gen1 静态校验（零请求）：kimi 族——frontmatter 全套/desc 何时不用/
H1 统一/四领域 references 拆分且被引用/主文件瘦身（≤9KB）；带负控（9 突变各自判红）。"""
import re, shutil, sys, tempfile
from pathlib import Path
import yaml


def validate(root: Path) -> list:
    errs = []
    sk = root / 'SKILL.md'
    if not sk.is_file():
        return ['SKILL.md 缺失']
    text = sk.read_text(encoding='utf-8')
    if len(text.encode('utf-8')) > 9000:
        errs.append(f'SKILL.md 未瘦身（>9KB）: {len(text.encode("utf-8"))}')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1)); body = m.group(2)
    if fm.get('name') != 'xindaya-translator':
        errs.append('name != xindaya-translator')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r335）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r335）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r335）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if '何时不用' not in desc:
            errs.append('description 缺「何时不用」负向（r335）')
    if '# Pro Translator' in text:
        errs.append('H1 命名不一致（Pro Translator）')
    if '# Xindaya Translator' not in body:
        errs.append('缺统一后的 H1')
    for ref in ('academic-translation.md', 'business-translation.md', 'technical-translation.md', 'legal-translation.md'):
        p = root / 'references' / ref
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'references/{ref} 缺失')
        if ref not in body:
            errs.append(f'未被正文引用: {ref}')
    if '## 六、翻译质量检查清单' not in body:
        errs.append('质量检查清单不应被拆分（保留在主文件）')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/xindaya-translator-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1),
        'drop-tags': lambda t: t.replace('tags: [translation, chinese-english, localization, terminology]\n', '', 1),
        'strip-compat': lambda t: t.replace('compatibility: "任何具备文本生成能力', 'runtime-note: "任何具备文本生成能力', 1),
        'strip-negative': lambda t: t.replace('何时不用：日常单字词典查词', '同样用于：日常单字词典查词', 1),
        'reintroduce-h1': lambda t: t.replace('# Xindaya Translator', '# Pro Translator', 1),
        'bloat-skill': lambda t: t.replace('# Xindaya Translator', '# Xindaya Translator\n\n' + ('冗长堆叠内容。' * 900), 1),
        'unref-academic': lambda t: t.replace('academic-translation.md', '学术翻译说明'),
        'delete-legal-ref': None,
        'drop-checklist': lambda t: t.replace('## 六、翻译质量检查清单', '## 附录', 1),
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-legal-ref':
                (dst / 'references' / 'legal-translation.md').unlink()
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
