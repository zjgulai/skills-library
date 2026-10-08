#!/usr/bin/env python3
"""web-security-audit-gen1 静态校验（零请求）：kimi 族——frontmatter 补齐/desc 负向/主文件瘦身 ≤10KB＋
A01-A10 下沉重载 references/污点追踪与误报/样例拆分并被引用/安全边界（脱敏+拒绝载荷）/全覆盖要求保留；
负控 11 突变判红（含回涨与文件删除）。"""
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
    if fm.get('name') != 'web-security-audit':
        errs.append('name != web-security-audit')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r360）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r360 error）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r360 warning）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if '何时不用' not in desc and 'Do NOT use' not in desc:
            errs.append('description 缺负向边界（r360 error）')
    size = len(text.encode('utf-8'))
    if size > 10000:
        errs.append(f'主文件未瘦身（>10KB）: {size}（r360 error）')
    if '## 安全边界' not in body or '脱敏' not in body or '拒绝攻击载荷' not in body:
        errs.append('缺安全边界（脱敏/拒绝载荷）（r360 error）')
    if '分块检索' not in body:
        errs.append('缺大仓库分块检索指引（r360 info）')
    if '所有 10 项都必须出现' not in body:
        errs.append('缺全覆盖要求（r360）')
    if 'bandit' not in body:
        errs.append('缺自动化工具表（r360）')
    for rel in ('references/owasp-top10-rules.md', 'references/taint-and-false-positives.md', 'examples/sample-audit-report.md'):
        if not (root / rel).is_file():
            errs.append(f'{rel} 缺失（r360 error）')
        if rel not in body:
            errs.append(f'未被正文引用: {rel}')
    rr = root / 'references' / 'owasp-top10-rules.md'
    if rr.is_file():
        c = rr.read_text(encoding='utf-8')
        if 'A01' not in c or 'A10' not in c:
            errs.append('A01-A10 规则库不完整（r360 error）')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/web-security-audit-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': ('SKILL.md', lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1)),
        'drop-complexity': ('SKILL.md', lambda t: t.replace('complexity: standard\nlicense:', 'license:', 1)),
        'drop-tags': ('SKILL.md', lambda t: t.replace('tags: [security, code-review, owasp, vulnerability]\n', '', 1)),
        'strip-compat': ('SKILL.md', lambda t: t.replace('compatibility: "任何具备文本与代码阅读能力', 'runtime-note: "任何具备文本与代码阅读能力', 1)),
        'strip-negative': ('SKILL.md', lambda t: t.replace('何时不用：非 Web 领域审计', '同样用于：非 Web 领域审计', 1)),
        'drop-security': ('SKILL.md', lambda t: t.replace('## 安全边界（必读）', '## 备注', 1).replace('脱敏', '处理').replace('拒绝攻击载荷', '谨慎处理')),
        'rebloat': ('SKILL.md', lambda t: t + '\n' + ('填充段。' * 3200)),
        'drop-coverage-rule': ('SKILL.md', lambda t: t.replace('所有 10 项都必须出现', '重点项出现即可', 1)),
        'unref-rules': ('SKILL.md', lambda t: t.replace('references/owasp-top10-rules.md', '规则库文件')),
        'delete-taint': 'T',
        'delete-example': 'E',
    }
    with tempfile.TemporaryDirectory() as td:
        for name, spec in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-taint':
                (dst / 'references' / 'taint-and-false-positives.md').unlink()
            elif name == 'delete-example':
                (dst / 'examples' / 'sample-audit-report.md').unlink()
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
