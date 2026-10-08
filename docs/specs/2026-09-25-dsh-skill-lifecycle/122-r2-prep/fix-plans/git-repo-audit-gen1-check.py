#!/usr/bin/env python3
"""git-repo-audit-gen1 静态校验（零请求）：kimi 工具族——frontmatter 全套＋allowed-tools/
desc 何时不用/H1 统一/执行工作流/安全边界与性能建议/脚本被引用；带负控（9 突变各自判红）。"""
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
    if fm.get('name') != 'git-repo-audit':
        errs.append('name != git-repo-audit')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r308 warning）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    at_ = fm.get('allowed-tools')
    if not (isinstance(at_, list) and 'bash' in at_):
        errs.append('allowed-tools 缺失（r308-r1 warning）')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if '何时不用' not in desc:
            errs.append('description 缺「何时不用」负向（r308 warning）')
    if '# Git Forensics' in text:
        errs.append('H1 命名不一致（Git Forensics）')
    if '# Git Repo Audit' not in body:
        errs.append('缺统一后的 H1')
    if '## 执行工作流' not in body:
        errs.append('缺执行工作流（r308 warning）')
    if '## 安全边界与性能建议' not in body:
        errs.append('缺安全边界与性能建议节（r308 warning）')
    if '轮换' not in body:
        errs.append('缺密钥处理准则（轮换提示）')
    for s in ('hotfiles.sh', 'ownership.sh', 'secret-scan.sh'):
        if not (root / 'scripts' / s).is_file():
            errs.append(f'scripts/{s} 缺失')
        if s not in body:
            errs.append(f'未被正文引用: {s}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/git-repo-audit-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-allowed-tools': lambda t: t.replace('allowed-tools:\n  - bash\n', '', 1),
        'strip-compat': lambda t: t.replace('compatibility: "需要可执行 bash 与 git', 'runtime-note: "需要可执行 bash 与 git', 1),
        'strip-negative': lambda t: t.replace('何时不用：非 Git 仓库的目录分析', '同样用于：非 Git 仓库的目录分析', 1),
        'reintroduce-h1': lambda t: t.replace('# Git Repo Audit', '# Git Forensics', 1),
        'drop-workflow': lambda t: t.replace('## 执行工作流', '## 说明', 1),
        'drop-safety': lambda t: t.replace('## 安全边界与性能建议', '## 附录', 1),
        'drop-rotate': lambda t: t.replace('轮换', '保存', 1),
        'unref-secret-scan': lambda t: t.replace('secret-scan.sh', '密钥扫描脚本'),
        'delete-script': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-script':
                (dst / 'scripts' / 'secret-scan.sh').unlink()
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
