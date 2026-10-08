#!/usr/bin/env python3
"""105-014 三件修复的算术验证（零请求、只读）。

每项都带负控：旧式/错误口径在同一检查下必须失败——"不会红的检查不是检查"。
用法：python3 -B verify-formulas.py；退出码 0＝全过。
"""
import sys
from pathlib import Path

LIB = Path('/Users/lute/project/AgentTools/技能库')
failures = []


def check(name, condition, detail=''):
    status = 'PASS' if condition else 'FAIL'
    print(f'{status}  {name}{("  — " + detail) if detail else ""}')
    if not condition:
        failures.append(name)


# ---------- cash-flow-snapshot ----------
cf_path = LIB / 'skills-genspark/cash-flow-snapshot/SKILL.md'
cf = cf_path.read_text(encoding='utf-8')

check('cash-flow: 公式块已替换（位置口径 band_amount）',
      'band_amount = band_pct × expected_inflows' in cf and 'low  = position − band_amount' in cf)
check('cash-flow: 零时滞分母已设守卫', 'avg lag = 0 ⇒ band_pct = 0' in cf)
check('cash-flow: 表格含"起始现金＋累计净流量"的现金头寸行',
      'Starting cash + cumulative net cash flow through this window' in cf)
check('cash-flow: 已把"净流量不是头寸"写进数据采集步',
      'Net flows alone are not a cash position' in cf)


def old_band(net_cash, band_pct):
    return net_cash * (1 - band_pct), net_cash * (1 + band_pct)


def new_band(position, band_pct, expected_inflows):
    band_amount = band_pct * expected_inflows
    return position - band_amount, position + band_amount


# 负控：旧式在净值为负时 low>high（倒置）——这个检查必须能红
old_low, old_high = old_band(-100.0, 0.2)
check('cash-flow 负控: 旧式负值区间倒置（low > high）确实复现', old_low > old_high,
      f'old low={old_low} high={old_high}')
# 新式符号扫描：任何符号/幅度下 low ≤ high
bad = []
for position in (-500, -100, -1, 0, 1, 100, 500):
    for pct in (0.0, 0.05, 0.2, 0.5):
        low, high = new_band(position, pct, 200.0)
        if low > high:
            bad.append((position, pct))
check('cash-flow: 新式符号扫描 low ≤ high 恒成立', not bad, f'violations={bad}')
low, high = new_band(-100.0, 0.2, 200.0)
check('cash-flow: 示例（position −100、含 40 带宽）→ low −140 / high −60', (low, high) == (-140.0, -60.0))

# ---------- variance-analysis ----------
va_path = LIB / 'skills-genspark/variance-analysis/SKILL.md'
va = va_path.read_text(encoding='utf-8')

check('variance: 三项分解已换为守恒的有序分解',
      'Mix Effect    = (Actual Mix - Budget Mix)       x Actual Volume x Actual Price' in va
      and 'exact, with this order of attribution' in va)
check('variance: 两效应验证式已补（需同总量归一）',
      '(Actual Blended Rate - Budget Blended Rate) x Actual Total Volume' in va)


def old_three_way(Pb, Qb, Mb, Pa, Qa, Ma):
    vol = (Qa - Qb) * Pb * Mb
    price = (Pa - Pb) * Qb * Ma
    mix = Pb * Qb * (Ma - Mb)
    return vol, price, mix


def new_three_way(Pb, Qb, Mb, Pa, Qa, Ma):
    vol = (Qa - Qb) * Pb * Mb
    price = (Pa - Pb) * Qa * Mb
    mix = (Ma - Mb) * Qa * Pa
    return vol, price, mix


Pb, Qb, Mb, Pa, Qa, Ma = 50.0, 10000.0, 0.5, 48.0, 11000.0, 0.6
total = Pa * Qa * Ma - Pb * Qb * Mb
ov, op, om = old_three_way(Pb, Qb, Mb, Pa, Qa, Ma)
nv, np_, nm = new_three_way(Pb, Qb, Mb, Pa, Qa, Ma)
check('variance 负控: 旧三项分解不守恒（实测）', abs(ov + op + om - total) > 1e-6,
      f'old sum={ov + op + om} vs total={total}')
check('variance: 新三项分解精确守恒', abs(nv + np_ + nm - total) < 1e-9,
      f'new sum={nv + np_ + nm} vs total={total}')


def rate_mix(segments, av, exp):
    rate = sum(av[i] * (segments[i][1] - segments[i][0]) for i in range(len(segments)))
    mix = sum(segments[i][0] * (av[i] - exp[i]) for i in range(len(segments)))
    return rate, mix


# 段: (预算率, 实际率)；总量 1000 归一下：实际 400/600，预算混合 500/500
r, m = rate_mix([(0.6, 0.6), (0.4, 0.4)], [400, 600], [500, 500])
check('variance: Rate+Mix 与"混合率差×实际总量"一致', abs((r + m) - (0.48 - 0.50) * 1000) < 1e-9,
      f'rate={r} mix={m}')

# ---------- paid-advertising ----------
pa = (LIB / '81-Skills/paid-advertising/references/ad-audit-playbook.md').read_text(encoding='utf-8')
core = (LIB / '81-Skills/paid-advertising/scripts/core.py').read_text(encoding='utf-8')
check('paid: Playbook 口径已改为"增量收入 / 增量花费"', '（**增量收入 / 增量花费**；' in pa)
check('paid 负控: 旧倒置口径不再出现', '增量花费 / 增量收入' not in pa)
check('paid: 与代码口径一致（core.py 文档字符串）', '增量收入/增量花费' in core)

print()
if failures:
    print(f'FAILURES: {len(failures)} — {failures}')
    sys.exit(1)
print('ALL CHECKS PASSED')
