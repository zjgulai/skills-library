#!/usr/bin/env python3
"""ui-blueprint-gen1 静态校验（零请求）：kimi 族——frontmatter 全套/desc 何时不触发负向/第五步
沙箱降级兜底/PRD 落盘路径统一/祈使化开头；v2（r320-r2）：CRA→Vite 弃用替换/输出契约统一
（src/designs 口径）/提取后对比度校验/Task 子代理降级说明；带负控（13 突变各自判红）。"""
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
    if fm.get('name') != 'ui-blueprint':
        errs.append('name != ui-blueprint')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r309 warning）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r309 warning）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r309 warning）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if '何时不触发' not in desc:
            errs.append('description 缺「何时不触发」负向（r309 warning）')
    if '跳过安装步骤' not in body:
        errs.append('缺第五步沙箱降级兜底（r309 warning）')
    if 'documents/prd/{创意文件名}_prd.md' not in body:
        errs.append('缺 PRD 统一落盘路径（r309 info→硬项）')
    if '按以下多步骤工作流执行' not in body:
        errs.append('概述未祈使化（r309 info）')
    # v2（r320-r2）：CRA 已弃用 → Vite
    if 'create-react-app' in text:
        errs.append('残留 create-react-app（CRA 已弃用，r320-r2）')
    if 'npm create vite@latest' not in body:
        errs.append('缺 Vite 脚手架（r320-r2）')
    # v2：产物组织契约统一
    if 'src/designs/[方案名称]' not in body:
        errs.append('主文件缺统一产物组织契约（r320-r2）')
    tmpl = root / 'assets' / 'vibe-design-template.md'
    if tmpl.is_file():
        tt = tmpl.read_text(encoding='utf-8')
        if 'src/designs/[方案名称]' not in tt:
            errs.append('模板输出契约未统一（r320-r2）')
        if 'index.html' in tt:
            errs.append('模板残留 index.html 单文件口径（r320-r2）')
    else:
        errs.append('assets/vibe-design-template.md 缺失')
    # v2：提取后对比度校验
    if 'WCAG' not in body and '对比度' not in body:
        errs.append('缺对比度校验（r320-r2）')
    # v2：Task 子代理降级
    if '无 Task' not in body and '不支持子代理' not in body:
        errs.append('缺 Task 子代理降级说明（r320-r2 info）')
    for a in ('assets/design-system.md', 'assets/app-overview-generator.md', 'assets/vibe-design-template.md'):
        if a not in body:
            errs.append(f'未被正文引用: {a}')
        elif not (root / a).is_file():
            errs.append(f'{a} 缺失')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/ui-blueprint-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1),
        'drop-tags': lambda t: t.replace('tags: [ui, design-system, layout, mvp]\n', '', 1),
        'strip-compat': lambda t: t.replace('compatibility: "需要具备子代理调用能力', 'runtime-note: "需要具备子代理调用能力', 1),
        'strip-negative': lambda t: t.replace('何时不触发：已有现成设计系统', '同样用于：已有现成设计系统', 1),
        'drop-fallback': lambda t: t.replace('跳过安装步骤', '照常安装', 1),
        'drop-persist': lambda t: t.replace('documents/prd/{创意文件名}_prd.md', 'documents/prd/（路径待定）', 1),
        'revert-intro': lambda t: t.replace('按以下多步骤工作流执行：', '该 skill 支持通过多步骤工作流：', 1),
        'restore-cra': lambda t: t.replace('npm create vite@latest my-app -- --template react', 'npx create-react-app my-app', 1),
        'drop-vite': lambda t: t.replace('npm create vite@latest', 'npx create-next-app@latest'),
        'break-contract': lambda t: t.replace('src/designs/[方案名称]', '方案目录', 1),
        'drop-contrast': lambda t: t.replace('WCAG', '（标准待定）').replace('对比度', '（检查项）'),
        'drop-task-fallback': lambda t: t.replace('无 Task 子代理时的降级', '（拓展说明）', 1).replace('不支持子代理分发', '支持子代理分发', 1),
        'delete-asset': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-asset':
                (dst / 'assets' / 'design-system.md').unlink()
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
