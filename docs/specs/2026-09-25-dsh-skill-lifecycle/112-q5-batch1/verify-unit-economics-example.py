#!/usr/bin/env python3
"""unit-economics gen-1 候选的算例算术检查（零请求）。

把 examples/worked-example.md 里的数字按其自身公式复算一遍，并逐行钉死文档表述
（整行断言，任何数字被改动都会判红）。默认指向候选；写回后可用 --doc 指向库内件复跑（回归）。
用法：python3 -B verify-unit-economics-example.py [--doc <path>]；退出码 0＝全过。
"""
import argparse
import re
import sys
from pathlib import Path

DEFAULT = Path(__file__).resolve().parents[4] / 'skill-lifecycle/trial-home/opt-run/candidates/unit-economics-gen1/examples/worked-example.md'

parser = argparse.ArgumentParser()
parser.add_argument('--doc', default=str(DEFAULT))
args = parser.parse_args()

text = Path(args.doc).read_text(encoding='utf-8')
norm = re.sub(r'\s+', ' ', text)
failures = []


def check(name, condition, detail=''):
    print(f"{'PASS' if condition else 'FAIL'}  {name}{('  — ' + detail) if detail else ''}")
    if not condition:
        failures.append(name)


# —— 输入（与文档「输入」表一致）——
spend_media, creative, tools, customers = 40000, 3000, 5000, 200
list_price, fee_rate, var_cost, churn = 29.0, 0.03, 6.1, 0.06

net = round(list_price * (1 - fee_rate), 2)              # 28.13
contrib = round(net - var_cost, 2)                        # 22.03
cac_media = spend_media / customers                       # 200.00
cac_full = (spend_media + creative + tools) / customers   # 240.00
payback = round(cac_full / contrib, 1)                    # 10.9

seq = [round(contrib * (1 - churn) ** k, 2) for k in range(6)]
cum6 = round(sum(contrib * (1 - churn) ** k for k in range(6)), 2)   # 113.87
progress = round(cum6 / cac_full * 100, 1)                # 47.4

month, cum = 0, 0.0
while cum < cac_full:
    month += 1
    cum += contrib * (1 - churn) ** (month - 1)
cum_first = round(cum, 2)                                 # 246.62 @ 第 18 个月

marginal = 10000 / 40                                     # 250.00
tier1_cac = 30000 / 160                                   # 187.50
net_channel = round(cum6 - cac_full, 2)                   # -126.13
max6 = round(contrib * 6, 2)                              # 132.18
max6_pct = round(max6 / cac_full * 100, 1)                # 55.1

# —— 复算断言 ——
check('月净收入 = 28.13', net == 28.13)
check('月贡献毛利 = 22.03', contrib == 22.03)
check('媒体 CAC = 200.00', cac_media == 200.00)
check('全口径 CAC = 240.00', cac_full == 240.00)
check('公式回收月数 = 10.9', payback == 10.9)
check('cohort 六个月序列一致', seq == [22.03, 20.71, 19.47, 18.30, 17.20, 16.17], str(seq))
check('6 个月累计 = 113.87', cum6 == 113.87)
check('回收进度 = 47.4%', progress == 47.4)
check('cohort 首次回本 = 第 18 个月 / 246.62', (month, cum_first) == (18, 246.62), f'{month}/{cum_first}')
check('边际 CAC = 250.00（档1 档内 187.50）', marginal == 250.00 and tier1_cac == 187.50)
check('渠道净贡献 = −126.13', net_channel == -126.13)
check('零流失 6 个月上限 = 132.18 / 55.1%', max6 == 132.18 and max6_pct == 55.1)

# —— 文档整行钉死（normalize 空白后逐行包含；任何数字改动即红）——
expected_lines = [
    '1. 月净收入/客户 = 29.0 × (1 − 3%) = 28.13 元',
    '2. 月贡献毛利/客户 = 28.13 − 6.1 = 22.03 元',
    '3. 媒体 CAC = 40,000 ÷ 200 = 200.00 元',
    '4. 全口径 CAC = (40,000 + 3,000 + 5,000) ÷ 200 = 240.00 元',
    '5. 公式回收月数 = 240.00 ÷ 22.03 ≈ 10.9 个月',
    '6. cohort 逐月贡献（按 6% 月流失）：22.03 / 20.71 / 19.47 / 18.30 / 17.20 / 16.17 元',
    '7. 前 6 个月累计贡献 = 113.87 元，回收进度 113.87 ÷ 240.00 ≈ 47.4%',
    '8. 含流失的 cohort 口径：第 18 个月累计 246.62 元才首次超过全口径 CAC',
    '9. 第 2 档预算边际：追加 10,000 元 → 新增 40 人，边际 CAC = 250.00 元（第 1 档 30,000 元 / 160 人，档内 CAC 187.50 元）',
    '10. 渠道净贡献 = 113.87 − 240.00 = −126.13 元/客户（尚未回本）',
    '| 公式回收月数 / cohort 首次回本月 | 10.9 / 第 18 个月 |',
    '| 6 个月回收进度 | 47.4% |',
    '| 渠道净贡献（6 个月） | −126.13 元/客户 |',
    '| Meta | 40,000 | 200 | 200.00 | 240.00 | 250.00（第 2 档） | 113.87 | 修复漏斗（留存） |',
    '零流失上限 = 22.03 × 6 = 132.18 元（55.1%）',
]
for line in expected_lines:
    check(f'文档钉死 {line[:28]}…', re.sub(r'\s+', ' ', line) in norm)

print()
if failures:
    print(f'FAILURES: {len(failures)} — {failures}')
    sys.exit(1)
print('ALL CHECKS PASSED')
