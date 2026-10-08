#!/usr/bin/env python3
"""retention-manager-gen1 静态校验（零请求）：frontmatter/描述/口径统一（恢复率分层）/
引用完整/脚本可执行；带负控（四个突变必须各自判红）。"""
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

REQUIRED_HEADINGS = ['## 开始之前', '## 功能模式', '## 取消流程设计', '## 退出调查设计', '## 挽留方案手册',
                     '## 被动流失：催款体系搭建', '## 指标与基准', '## 主动触发建议', '## 输出产物', '## 沟通规范']
PLACEHOLDER = re.compile(r'TODO|FIXME|placeholder|<your|待填|占位', re.I)
REFS = ['references/cancel-flow-patterns.md', 'references/cancel-flow-playbook.md',
        'references/dunning-guide.md', 'references/dunning-playbook.md']


def validate(root: Path) -> list:
    errs = []
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1))
    body = m.group(2)
    if fm.get('name') != 'retention-manager':
        errs.append('name != retention-manager')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失')
    if str(fm.get('license', '')).strip() != 'MIT':
        errs.append('license 非 MIT')
    if not str(fm.get('author', '')).strip():
        errs.append('author 缺失')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失')
    if 'metadata' in fm:
        errs.append('残留 metadata 嵌套')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (200 <= len(desc) <= 500):
            errs.append(f'description 长度越界（≤500）: {len(desc)}')
        if '不适用于' not in desc:
            errs.append('description 缺负向触发（不适用于）')
    if len(body) > 8000:
        errs.append(f'body 超 complex 上限 {len(body)}')
    for h in REQUIRED_HEADINGS:
        if h not in body:
            errs.append(f'缺章节 {h}')
    if '</output>' in text or '<output>' in text:
        errs.append('残留 output 标签')
    if '25-35% 为良好' in text:
        errs.append('恢复率旧口径残留（25-35%）')
    if '35-40% 为良好' not in text:
        errs.append('恢复率新口径（35-40% 为良好）未入 SKILL')
    pb = (root / 'references/dunning-playbook.md')
    if pb.is_file() and '恢复 50-60% 的失败支付' in pb.read_text(encoding='utf-8'):
        errs.append('playbook 恢复率旧口径残留（50-60%）')
    ph = PLACEHOLDER.findall(text)
    if ph:
        errs.append(f'占位符命中 {ph[:3]}')
    for rel in REFS:
        if not (root / rel).is_file():
            errs.append(f'引用文件缺失: {rel}')
        if rel.split('/')[-1] not in body:
            errs.append(f'未被正文引用: {rel}')
    sc = root / 'scripts/churn_impact_calculator.py'
    if not (sc.is_file() and sc.stat().st_size > 0):
        errs.append('计算脚本缺失/空')
    elif '基准口径分层' not in sc.read_text(encoding='utf-8'):
        errs.append('脚本缺基准口径注释')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/retention-manager-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    proc = subprocess.run([sys.executable, '-B', str(root / 'scripts/churn_impact_calculator.py')],
                          capture_output=True, text=True, cwd=str(root))
    good = proc.returncode == 0 and 'INCREMENTAL IMPACT' in proc.stdout
    print(f"[脚本执行] rc={proc.returncode} {'OK' if good else 'FAIL'}")
    ok = ok and good
    mutations = {
        'drop-version': lambda t: t.replace('version: "1.1.0"\n', '', 1),
        'strip-negative': lambda t: t.replace('不适用于：单笔支付退款', '可选择用于单笔支付退款', 1),
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
        dst = Path(td) / 'delete-ref'
        shutil.copytree(root, dst)
        (dst / 'references/dunning-guide.md').unlink()
        e3 = validate(dst)
        red = bool(e3)
        print(f"[负控 delete-ref] {'RED(期望)' if red else 'GREEN(异常!)'} {e3[:2]}")
        ok = ok and red
        dst = Path(td) / 'break-script'
        shutil.copytree(root, dst)
        sp = dst / 'scripts/churn_impact_calculator.py'
        st = sp.read_text(encoding='utf-8')
        st2 = st.replace('    "avg_customer_mrr": 150\n}', '    "avg_customer_mrr": 150\n}\nSAMPLE_INPUT.pop("avg_customer_mrr")', 1)
        assert st2 != st, 'break-script: 突变未生效'
        sp.write_text(st2, encoding='utf-8')
        proc2 = subprocess.run([sys.executable, '-B', str(sp)], capture_output=True, text=True, cwd=str(dst))
        red = proc2.returncode != 0
        print(f"[负控 break-script] {'RED(期望)' if red else 'GREEN(异常!)'} rc={proc2.returncode}")
        ok = ok and red
    sys.exit(0 if ok else 1)


main()
