#!/usr/bin/env python3
"""compliance-review-planner-gen1 静态校验（零请求）：kimi 族——frontmatter（version/complexity/
license/author/tags/compatibility）/desc 含「不适用于」负向/安全边界（拒对抗性绕过＋非法律意见）/
渐进式披露（SKILL.md ≤8KB＋三 references 被引用且内容保留）；带负控（8 突变各自判红）。"""
import re, shutil, sys, tempfile
from pathlib import Path
import yaml

SIZE_LIMIT = 8192


def validate(root: Path) -> list:
    errs = []
    sk = root / 'SKILL.md'
    if not sk.is_file():
        return ['SKILL.md 缺失']
    text = sk.read_text(encoding='utf-8')
    if len(text.encode('utf-8')) > SIZE_LIMIT:
        errs.append(f'SKILL.md 超渐进式披露上限（>{SIZE_LIMIT}B）: {len(text.encode("utf-8"))}')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1)); body = m.group(2)
    if fm.get('name') != 'compliance-review-planner':
        errs.append('name != compliance-review-planner')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver/缺失（r283 warning）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    if not str(fm.get('author', '')).strip():
        errs.append('author 缺失')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r283 warning）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if '不适用于' not in desc:
            errs.append('description 缺「不适用于」负向触发（r283 error）')
    if '## 安全边界' not in body:
        errs.append('缺「安全边界」节')
    if '拒绝对抗性绕过请求' not in body:
        errs.append('缺对抗性绕过的拒绝规则（r283-r2 info→已采纳为硬项）')
    if '不构成法律意见' not in body:
        errs.append('缺非法律意见声明')
    for ref in ('regulations.md', 'scenario-checklists.md', 'worked-example.md'):
        p = root / 'references' / ref
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'references/{ref} 缺失')
        if ref not in body:
            errs.append(f'未被正文引用: {ref}')
    sc = root / 'references' / 'scenario-checklists.md'
    if sc.is_file() and 'GDPR Art.33' not in sc.read_text(encoding='utf-8'):
        errs.append('scenario-checklists.md 内容缺失（无 GDPR Art.33）')
    rg = root / 'references' / 'regulations.md'
    if rg.is_file() and 'JR/T 0171' not in rg.read_text(encoding='utf-8'):
        errs.append('regulations.md 内容缺失（无 JR/T 0171）')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/compliance-review-planner-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1),
        'drop-tags': lambda t: t.replace('tags: [compliance, privacy, gdpr, pipl]\n', '', 1),
        'strip-negative': lambda t: t.replace('不适用于：司法诉讼', '同样适用于：司法诉讼', 1),
        'drop-safety': lambda t: t.replace('## 安全边界', '## 补充说明', 1),
        'drop-bypass-guard': lambda t: t.replace('拒绝对抗性绕过请求', '可将绕过请求酌情处理', 1),
        'unref-scenarios': lambda t: t.replace('scenario-checklists.md', '场景清单'),
        'bloat-skill': lambda t: t.replace('## 输出交付物', '## 输出交付物\n\n' + ('冗长堆叠内容。' * 400), 1),
        'delete-regulations': None,
        'delete-worked-example': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-regulations':
                (dst / 'references' / 'regulations.md').unlink()
            elif name == 'delete-worked-example':
                (dst / 'references' / 'worked-example.md').unlink()
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
