#!/usr/bin/env python3
"""log-diagnostic-gen1 静态校验（零请求）：frontmatter/负向触发/Agent 工作流/边界处理/
脚本引用/署名一致性；带负控（四个突变必须各自判红）。"""
import re
import shutil
import sys
import tempfile
from pathlib import Path

import yaml

REQUIRED_HEADINGS = ['## Agent 执行工作流', '## 边界与错误处理', '## 何时不该使用', '## 输出说明']
PLACEHOLDER = re.compile(r'TODO|FIXME|placeholder|<your', re.I)


def validate(root: Path) -> list:
    errs = []
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1))
    body = m.group(2)
    if fm.get('name') != 'log-diagnostic':
        errs.append('name != log-diagnostic')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失')
    if str(fm.get('license', '')).strip() != 'MIT':
        errs.append('license 非 MIT')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (200 <= len(desc) <= 500):
            errs.append(f'description 长度越界（≤500）: {len(desc)}')
        if '不适用于' not in desc:
            errs.append('description 缺负向触发')
    if len(body) > 8000:
        errs.append(f'body 超 complex 上限 {len(body)}')
    for h in REQUIRED_HEADINGS:
        if h not in body:
            errs.append(f'缺章节 {h}')
    if 'analyze_logs.py' not in body:
        errs.append('缺脚本调用说明')
    sc = root / 'scripts/analyze_logs.py'
    if not (sc.is_file() and sc.stat().st_size > 0):
        errs.append('脚本缺失/空')
    lic = (root / 'LICENSE').read_text(encoding='utf-8', errors='ignore') if (root / 'LICENSE').is_file() else ''
    if 'log-analyzer contributors' in lic:
        errs.append('LICENSE 署名与技能名不一致')
    ph = PLACEHOLDER.findall(text)
    if ph:
        errs.append(f'占位符命中 {ph[:3]}')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/log-diagnostic-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.0.0"\n', '', 1),
        'strip-negative': lambda t: t.replace('不适用于：实时抓包', '可适用于：实时抓包', 1),
        'drop-workflow': lambda t: re.sub(r'## Agent 执行工作流[\s\S]*?(?=## 使用方式)', '', t, count=1),
        'restore-license': lambda t: t,  # 占位，license 单独负控
    }
    del mutations['restore-license']
    with tempfile.TemporaryDirectory() as td:
        for name, mutate in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            p = dst / 'SKILL.md'
            t = p.read_text(encoding='utf-8')
            mutated = mutate(t)
            assert mutated != t, f'{name}: 突变未生效（锚点漂移）'
            p.write_text(mutated, encoding='utf-8')
            e2 = validate(dst)
            red = bool(e2)
            print(f"[负控 {name}] {'RED(期望)' if red else 'GREEN(异常!)'} {e2[:2]}")
            ok = ok and red
        dst = Path(td) / 'delete-script'
        shutil.copytree(root, dst)
        (dst / 'scripts/analyze_logs.py').unlink()
        e3 = validate(dst)
        red = bool(e3)
        print(f"[负控 delete-script] {'RED(期望)' if red else 'GREEN(异常!)'} {e3[:2]}")
        ok = ok and red
        dst = Path(td) / 'old-license'
        shutil.copytree(root, dst)
        lp = dst / 'LICENSE'
        lp.write_text(lp.read_text(encoding='utf-8').replace('log-diagnostic contributors', 'log-analyzer contributors'), encoding='utf-8')
        e4 = validate(dst)
        red = bool(e4)
        print(f"[负控 old-license] {'RED(期望)' if red else 'GREEN(异常!)'} {e4[:2]}")
        ok = ok and red
    sys.exit(0 if ok else 1)


main()
