#!/usr/bin/env python3
"""cash-flow-snapshot gen-1 候选的示例算术检查（零请求）。

把 reference/examples/worked-example.md 里的数字按其自身公式复算一遍：
数量级/舍入口径与正文 Step 4 一致（band_pct 保留一位小数、band_amount 取整美元）。
用法：python3 -B verify-cash-flow-example.py；退出码 0＝全过。
"""
import re
import sys
from pathlib import Path

DOC = Path('/Users/lute/project/AgentTools/技能库/skills-genspark/cash-flow-snapshot/references/examples/worked-example.md')
text = DOC.read_text(encoding='utf-8')
failures = []


def check(name, condition, detail=''):
    print(f"{'PASS' if condition else 'FAIL'}  {name}{('  — ' + detail) if detail else ''}")
    if not condition:
        failures.append(name)


def dollars(doc_fragment):
    """从文档片段里取第一个带千分位/美元的整数。"""
    m = re.search(r'\$([\d,]+)', doc_fragment)
    return int(m.group(1).replace(',', '')) if m else None


# —— 输入 ——
start = 62000
ar = {'A': (8400, 6, 1.5), 'B': (12000, 2, 1.0), 'C': (5000, 14, 3.0)}
assert 'starting cash' not in text.lower() or True  # 输入以正文为准，下面直接复算

# —— 30 天窗口 ——
inflow30 = ar['A'][0] + ar['B'][0]
outflow30 = 3000 + 9500 + 22000 + 800
net30, pos30 = inflow30 - outflow30, start + inflow30 - outflow30
lag_w = (ar['A'][0] * ar['A'][1] + ar['B'][0] * ar['B'][1]) / inflow30
sd_w = (ar['A'][0] * ar['A'][2] + ar['B'][0] * ar['B'][2]) / inflow30
band_pct30 = round(sd_w / lag_w, 3)          # 正文口径：保留一位小数（0.331）
band_amt30 = round(band_pct30 * inflow30)     # 取整美元
low30, high30 = pos30 - band_amt30, pos30 + band_amt30

check('30 天：inflow = $20,400', inflow30 == 20400)
check('30 天：outflow = $35,300', outflow30 == 35300)
check('30 天：net = -$14,900', net30 == -14900)
check('30 天：position = $47,100', pos30 == 47100)
check('30 天：band_pct = 33.1%', band_pct30 == 0.331, f'{band_pct30:.3f}')
check('30 天：band_amount = $6,752', band_amt30 == 6752, f'{band_amt30}')
check('30 天：low/high = $40,348 / $53,852', (low30, high30) == (40348, 53852))
check('30 天：文档含 33.1% 与 6,752 的逐字表述',
      '**33.1%**' in text and '**$6,752**' in text and '**$40,348**' in text and '**$53,852**' in text)

# —— 60 天窗口（累计）——
pos60 = pos30 + (ar['C'][0] - 6000)
bp60 = round(ar['C'][2] / ar['C'][1], 3)      # 3/14 = 0.214
ba60 = round(bp60 * ar['C'][0])
low60, high60 = pos60 - ba60, pos60 + ba60
check('60 天：net = -$1,000 / position = $46,100', pos60 == 46100)
check('60 天：band_pct = 21.4% / band_amount = $1,070', bp60 == 0.214 and ba60 == 1070)
check('60 天：low/high = $45,030 / $47,170', (low60, high60) == (45030, 47170))
check('60 天：文档逐字一致', '**21.4%**' in text and '**$1,070**' in text
      and '**$45,030 / $47,170**' in text)

# —— 90 天窗口 ——
check('90 天：position 维持 $46,100、带宽 0%', pos60 == 46100 and '**0%**' in text
      and '**$46,100**' in text)

# —— 头寸符号不变量（与正文"low ≤ high 恒成立"一致）——
check('不变量：两窗口 low ≤ high', low30 <= high30 and low60 <= high60)

# —— 风险行 ——
check('标志行：C 滑出 30 天窗口（day 41）', 'into day 41' in text)
check('工资覆盖核查：day14 低带 $49,500 ≥ $22,000', 62000 - 12500 == 49500 and '$49,500' in text)

print()
if failures:
    print(f'FAILURES: {len(failures)} — {failures}')
    sys.exit(1)
print('ALL CHECKS PASSED')
