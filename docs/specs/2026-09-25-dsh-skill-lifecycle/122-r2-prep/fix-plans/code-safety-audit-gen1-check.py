#!/usr/bin/env python3
"""code-safety-audit-gen1 静态校验（零请求）：kimi 族——frontmatter 全套/desc 何时不用负向/
H1 命名统一/Agent 工作流四步/错误降级策略/脚本完好被引用；带负控（8 突变各自判红）。"""
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
    if fm.get('name') != 'code-safety-audit':
        errs.append('name != code-safety-audit')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver/缺失（r332 error）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r332 warning）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空（r332 error）')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r332 warning）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if '何时不用' not in desc:
            errs.append('description 缺「何时不用」负向（r332 error）')
    if '# security-scanner' in text:
        errs.append('H1 仍为 security-scanner（r332 warning：命名不一致）')
    if '# Code Safety Audit' not in body:
        errs.append('缺统一后的 H1「# Code Safety Audit」')
    if '## Agent 工作流（执行步骤）' not in body:
        errs.append('缺 Agent 工作流节（r332 error 面）')
    for step in ('### Step 1', '### Step 2', '### Step 3', '### Step 4'):
        if step not in body:
            errs.append(f'缺工作流步骤：{step}')
    if '## 错误处理与降级策略' not in body:
        errs.append('缺错误处理与降级策略节（r332 warning）')
    if '跳过该模块' not in body:
        errs.append('缺降级说明（审计工具缺失跳过）')
    sp = root / 'scripts' / 'security_scan.py'
    if not (sp.is_file() and sp.stat().st_size > 0):
        errs.append('scripts/security_scan.py 缺失')
    if 'security_scan.py' not in body:
        errs.append('未被正文引用: security_scan.py')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/code-safety-audit-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1),
        'drop-tags': lambda t: t.replace('tags: [security, code-audit, vulnerability-scan, owasp]\n', '', 1),
        'strip-negative': lambda t: t.replace('何时不用：单纯咨询安全概念', '同样用于：单纯咨询安全概念', 1),
        'reintroduce-h1': lambda t: t.replace('# Code Safety Audit', '# security-scanner', 1),
        'drop-workflow': lambda t: t.replace('## Agent 工作流（执行步骤）', '## 说明', 1),
        'drop-degrade': lambda t: t.replace('## 错误处理与降级策略', '## 附录', 1),
        'unref-script': lambda t: t.replace('security_scan.py', '扫描脚本'),
        'delete-script': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-script':
                (dst / 'scripts' / 'security_scan.py').unlink()
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
