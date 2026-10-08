#!/usr/bin/env python3
"""huashu-slides-gen1 静态校验（零请求）：frontmatter 规范化/desc 含负向/去宿主私有绝对路径/
去外部仓库悬空引用/去营销段/预设拆分（presets ref 落地）/create_slides 走包内脚本；
带负控（≥8 突变各自判红）。"""
import re
import shutil
import sys
import tempfile
from pathlib import Path

import yaml

REFS = ['references/design-system-presets.md']
FORBIDDEN = [r'~/\.', r'\.claude/skills', r'\.agents/skills', r'process\.env\.HOME', r'huashu-wechat-image', r'30万\+粉丝']


def validate(root: Path) -> list:
    errs = []
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1))
    body = m.group(2)
    if fm.get('name') != 'huashu-slides':
        errs.append('name != huashu-slides')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r270 点名）')
    if str(fm.get('license', '')).strip() != 'MIT':
        errs.append('license 非 MIT')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r270 error 点名）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (200 <= len(desc) <= 500):
            errs.append(f'description 长度越界（≤500）: {len(desc)}')
        if '不适用于' not in desc:
            errs.append('description 缺负向触发')
    lines = text.split('\n')
    if len(lines) > 560:
        errs.append(f'SKILL.md 超 560 行（{len(lines)}）——渐进式披露未达标')
    if len(text.encode('utf-8')) > 25000:
        errs.append(f'SKILL.md 超 25KB（{len(text.encode("utf-8"))}）')
    for pat in FORBIDDEN:
        if re.search(pat, text):
            errs.append(f'残留宿主私有/悬空引用: {pat}')
    for ref in REFS:
        p = root / ref
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'引用文件缺失/空: {ref}')
        if ref.split('/')[-1] not in body:
            errs.append(f'未被正文引用: {ref}')
    if 'scripts/create_slides.py' not in body:
        errs.append('create_slides.py 未走包内脚本（r270 点名）')
    if '降级为 Path A 纯布局模式' not in body:
        errs.append('缺外部依赖降级说明（r270 点名）')
    if 'assets/style-samples' in text:
        errs.append('悬空 style-samples 引用残留（r271 双跑点名）')
    if '<nano-banana-pro>' in text or '<pptx-skill>' in text:
        errs.append('伪路径占位符残留（r271-r2 点名）')
    if '安全边界与防御约束' not in body:
        errs.append('缺安全边界节（r271-r1 点名）')
    if '17 tested visual styles' in text:
        errs.append('17/18 风格计数冲突未修（r271-r1 点名）')
    pkg_alias = 'image-to-slides' in text
    for ref in (root / 'references').glob('*.md'):
        if 'image-to-slides' in ref.read_text(encoding='utf-8'):
            pkg_alias = True
    if pkg_alias:
        errs.append('残留旧名 image-to-slides（r271-r2 点名）')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/huashu-slides-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\n', '', 1),
        'strip-negative': lambda t: t.replace('不适用于：仅提取或阅读', '可适用于：仅提取或阅读', 1),
        'reintroduce-home-path': lambda t: t.replace(
            '不假定其安装路径，不拼接任何主机目录。',
            '示例：uv run ~/.claude/skills/nano-banana-pro/scripts/generate_image.py', 1),
        'reintroduce-sibling-repo': lambda t: t.replace(
            '流程照常完成）。', '流程照常完成）。备用：huashu-wechat-image/scripts/generate_image.py', 1),
        'reintroduce-marketing': lambda t: t.replace('> 作者：alchaincyf（花叔）· MIT License',
            '> 花叔出品 | 公众号「花叔」| 30万+粉丝', 1),
        'break-script-path': lambda t: t.replace('scripts/create_slides.py', '~/x/create_slides.py'),
        'drop-degrade-note': lambda t: t.replace('降级为 Path A 纯布局模式', '照常处理'),
        'unref-presets': lambda t: t.replace('`references/design-system-presets.md`', '`预设文档`'),
        'reinsert-style-samples': lambda t: t.replace('**风格样例', '**风格样例') if '风格样例' in t else t.replace('### Design System Presets', '### Design System Presets\n\n**风格样例图片：** `assets/style-samples/` 目录', 1),
        'reinsert-placeholder': lambda t: t.replace('**Illustration Generation** — 需宿主具备图像生成能力（可选）：', '**Illustration Generation**：示例 `uv run <nano-banana-pro>/scripts/generate_image.py`', 1),
        'drop-security': lambda t: re.sub(r'## 安全边界与防御约束[\s\S]*?(?=## Design Quick Reference)', '', t, count=1),
        'reintroduce-alias': None,
        'delete-presets-ref': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-presets-ref':
                (dst / 'references' / 'design-system-presets.md').unlink()
            elif name == 'reintroduce-alias':
                ds = dst / 'references' / 'design-styles.md'
                d2 = ds.read_text(encoding='utf-8')
                ds.write_text(d2.replace('huashu-slides 技能执行生成', 'image-to-slides skill 执行生成', 1), encoding='utf-8')
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
