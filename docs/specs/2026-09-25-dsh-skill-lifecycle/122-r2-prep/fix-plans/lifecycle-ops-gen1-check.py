#!/usr/bin/env python3
"""lifecycle-ops-gen1 静态校验（零请求）：chuhai 族——frontmatter 规范化/desc 负向/
规范性修订说明/阶段化工作流＋交付模板/安全边界/引用完整；带负控（≥6 突变各自判红）。"""
import re
import shutil
import sys
import tempfile
from pathlib import Path

import yaml

REQUIRED_HEADINGS = ['## 目标', '## 规范性修订说明（v1.0.0）', '## 工作流（分阶段执行）',
                     '## 参考资料路由', '## 必须交付', '## 质量与证据边界']
REFS = ['references/INDEX.md', 'references/source-42.md', 'references/source-43.md']
KEEP = ['LICENSE', 'NOTICE', 'agents/openai.yaml']


def validate(root: Path) -> list:
    errs = []
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1))
    body = m.group(2)
    if fm.get('name') != 'lifecycle-ops':
        errs.append('name != lifecycle-ops')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失')
    if str(fm.get('license', '')).strip() != 'Apache-2.0':
        errs.append('license 非 Apache-2.0')
    if not str(fm.get('author', '')).strip():
        errs.append('author 缺失')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (200 <= len(desc) <= 500):
            errs.append(f'description 长度越界（≤500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺负向触发')
    for h in REQUIRED_HEADINGS:
        if h not in body:
            errs.append(f'缺章节 {h}')
    for row in ['| 状态 | 定义 | 进入条件 |', '| 实验 | 假设 | 指标 |', '| 指标 | 本周 | 上周 |']:
        if row not in body:
            errs.append(f'缺交付模板: {row[:24]}…')
    if '支付凭据与用户 PII' not in body:
        errs.append('缺支付凭据/PII 安全边界')
    for rel in REFS:
        p = root / rel
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'引用文件缺失/空: {rel}')
        if rel.split('/')[-1] not in body:
            errs.append(f'未被正文引用: {rel}')
    for rel in KEEP:
        p = root / rel
        if not (p.is_file() and p.stat().st_size > 0):
            errs.append(f'家族文件缺失: {rel}')
    lic = (root / 'LICENSE').read_text(encoding='utf-8', errors='ignore')
    if 'Apache License' not in lic:
        errs.append('LICENSE 非 Apache 原文')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/lifecycle-ops-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\n', '', 1),
        'strip-negative': lambda t: t.replace('Do NOT use for defining an MVP', 'Also fine for defining an MVP', 1),
        'drop-revision-note': lambda t: re.sub(r'## 规范性修订说明（v1\.0\.0）[\s\S]*?(?=## 开始前)', '', t, count=1),
        'drop-workflow-templates': lambda t: t.replace('| 指标 | 本周 | 上周 | 环比 | 口径 | 判读 | 下周动作 |', '（周表见附图）', 1),
        'drop-pii': lambda t: t.replace('- 支付凭据与用户 PII：只处理脱敏摘要；不索要、不记录明文卡号、密钥或完整个人身份信息；风控与对账数据按最小必要原则使用。', '', 1),
        'rename-ref': lambda t: t.replace('references/source-42.md', 'references/source-xx.md'),
        'delete-ref': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-ref':
                (dst / 'references' / 'source-43.md').unlink()
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
