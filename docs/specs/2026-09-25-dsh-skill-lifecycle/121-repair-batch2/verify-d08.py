#!/usr/bin/env python3
"""D-08 验证：skill-evaluator 权重合计=100 与全包一致性（零请求；可红）。"""
import re, sys, shutil, subprocess, tempfile
from pathlib import Path

PKG = Path('/Users/lute/project/AgentTools/技能库/81-Skills/skill-evaluator')
fail = []

def check(name, cond, detail=''):
    print(f"{'PASS' if cond else 'FAIL'}  {name}{('  — ' + detail) if detail else ''}")
    if not cond: fail.append(name)

def weights_sum(root: Path):
    t = (root/'references/scoring-criteria.md').read_text(encoding='utf-8')
    ws = []
    for line in t.split('\n'):
        if line.startswith('│') and '%' in line and '总计' not in line and '满分' not in line:
            m = re.search(r'(\d+)%', line)
            if m: ws.append(int(m.group(1)))
    return ws

def yaml_sum(root: Path):
    t = (root/'examples/sample-evaluation-report.yaml').read_text(encoding='utf-8')
    block = t.split('weights:')[1].split('\n\n')[0]
    return sum(float(x) for x in re.findall(r':\s*(0\.\d+)', block))

ws = weights_sum(PKG)
check('权重表 6 维合计 = 100', sum(ws) == 100 and len(ws) == 6, f'{ws} sum={sum(ws)}')
ys = yaml_sum(PKG)
check('yaml weights 合计 = 1.00', abs(ys - 1.0) < 1e-9, f'{ys}')
allt = '\n'.join((PKG/f).read_text(encoding='utf-8') for f in
    ['SKILL.md','README.md','references/scoring-criteria.md','references/evaluation-guide.md',
     'examples/sample-evaluation-report.md','examples/sample-evaluation-report.yaml'])
check('无 82.5 残留', '82.5' not in allt)
check('无「质量门槛…10%」残留', not re.search(r'质量门槛[^\n]{0,12}10%', allt))
check('样例总分 = 83.2', '83.2' in allt)
check('「总计 100%」行仍在其位（现与算术自洽）', '总计                100%' in (PKG/'references/scoring-criteria.md').read_text(encoding='utf-8'))

# —— 负控：篡改副本（Gate 5%→10%）必须判红 ——
tmp = Path(tempfile.mkdtemp())
try:
    shutil.copytree(PKG, tmp/'pkg')
    f = tmp/'pkg/references/scoring-criteria.md'
    t = f.read_text(encoding='utf-8').replace('质量门槛达标          5%', '质量门槛达标         10%', 1)
    f.write_text(t, encoding='utf-8')
    ws2 = weights_sum(tmp/'pkg')
    check('负控：篡改副本合计≠100（判红路径有效）', sum(ws2) != 100, f'{ws2} sum={sum(ws2)}')
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
if fail: print('FAILURES:', fail); sys.exit(1)
print('ALL CHECKS PASSED')
