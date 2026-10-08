#!/usr/bin/env python3
"""split-test-evaluator-gen1 静态校验（零请求）：frontmatter/负向触发/章节/资产完整性、
脚本含 SRM、测试可执行；带负控（四个突变必须各自判红）。"""
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

REQUIRED_HEADINGS = [
    '## 适用场景', '## 不适用场景', '## 执行工作流', '## 输入与运行', '## 输出解读',
    '## 报告模板', '## 错误处理与边界', '## References',
]
PLACEHOLDER = re.compile(r'TODO|FIXME|placeholder|<your|待填|占位', re.I)


def validate(root: Path) -> list:
    errs = []
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1))
    body = m.group(2)
    if fm.get('name') != 'split-test-evaluator':
        errs.append('name != split-test-evaluator')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失')
    if not fm.get('license'):
        errs.append('license 缺失')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (200 <= len(desc) <= 1024):
            errs.append(f'description 长度越界 {len(desc)}')
        if re.search(r'[<>]', desc):
            errs.append('description 含 XML 角括')
        if '不适用于' not in desc:
            errs.append('description 缺负向触发（不适用于）')
    if len(body) > 8000:
        errs.append(f'body 超 complex 上限 {len(body)}')
    for h in REQUIRED_HEADINGS:
        if h not in body:
            errs.append(f'缺章节 {h}')
    ph = PLACEHOLDER.findall(text)
    if ph:
        errs.append(f'占位符命中 {ph[:3]}')
    script = (root / 'scripts/ab_test_analyze.py')
    tests = (root / 'tests/test_ab_test_analyze.py')
    lic = root / 'LICENSE'
    for f, why in ((script, '统计脚本'), (tests, '测试'), (lic, 'LICENSE')):
        if not (f.is_file() and f.stat().st_size > 0):
            errs.append(f'{why}缺失/空: {f.name}')
    if script.is_file():
        st = script.read_text(encoding='utf-8')
        if '_srm_check' not in st or 'mismatch' not in st:
            errs.append('脚本缺 SRM 检测实现')
        if 'warnings' not in st:
            errs.append('脚本缺 warnings 输出')
    if tests.is_file() and 'def test_' not in tests.read_text(encoding='utf-8'):
        errs.append('测试文件无用例')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/split-test-evaluator-gen1')
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    # 行为验证：本地跑自测（零请求）
    proc = subprocess.run([sys.executable, '-B', str(root / 'tests/test_ab_test_analyze.py')],
                          capture_output=True, text=True)
    print(f"[自测执行] rc={proc.returncode} {'OK' if proc.returncode == 0 else 'FAIL'}")
    if proc.returncode != 0:
        print(proc.stdout[-500:], proc.stderr[-500:])
    ok = ok and proc.returncode == 0
    mutations = {
        'drop-version': lambda t: t.replace('version: 1.0.0\n', '', 1),
        'strip-negative': lambda t: t.replace('不适用于：连续型指标', '适用于：连续型指标', 1),
    }
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
        dst = Path(td) / 'strip-srm'
        shutil.copytree(root, dst)
        sp = dst / 'scripts/ab_test_analyze.py'
        sp.write_text(sp.read_text(encoding='utf-8').replace('_srm_check', 'zz_srm_probe'), encoding='utf-8')
        e3 = validate(dst)
        red = bool(e3)
        print(f"[负控 strip-srm] {'RED(期望)' if red else 'GREEN(异常!)'} {e3[:2]}")
        ok = ok and red
        dst = Path(td) / 'delete-tests'
        shutil.copytree(root, dst)
        (dst / 'tests/test_ab_test_analyze.py').unlink()
        e4 = validate(dst)
        red = bool(e4)
        print(f"[负控 delete-tests] {'RED(期望)' if red else 'GREEN(异常!)'} {e4[:2]}")
        ok = ok and red
    sys.exit(0 if ok else 1)


main()
