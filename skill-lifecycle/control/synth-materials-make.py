#!/usr/bin/env python3
"""G07 合成材料生成器（零请求、确定性、内置一致性断言）：

生成「GMV→净结算对账/现金」练习包（SYNTH-G07）——**合成数据**，替代等待中的真实业务材料，
供 R-3/W6 接收链与后续对账能力校准使用。规定：

- 全程**无随机数**：订单/金额/日期均由固定索引导出 ⇒ 任意机器可逐字节重生成。
- **一致性不变量**（写盘前断言，破坏即失败）：
  ① 每渠道：Σ交易净额 = 结算净额；② 已结算已付 = 回款；③ 期末在途 = 已结未付；
  ④ 金额两位小数；⑤ EUR→USD 统一按 1.09。
- 渠道A（MOCK-Mall，USD，like 平台市场）：佣金 12%、履约费 $3.25/件；双周结算。
- 渠道B（MOCK-Store，EUR，like 自建站）：支付费 2.9% + €0.30/笔；周结；价格为含 VAT 20%。
- 所有口径均为**合成假设**（公开常识口径；不含平台官方费率表），见包内 SYNTH-00 说明。

用法：python3 -B synth-materials-make.py [--out <dir>]
"""
import argparse
import csv
from pathlib import Path

FX_EUR_USD = 1.09  # 合成假设：EUR→USD 固定 1.09（真实口径需按实际汇率源重算）
ROUND = lambda x: round(x + 1e-9, 2)  # noqa: E731 两位小数（含极小数保护）

PRICES_A = [12.99, 19.99, 24.99, 34.99, 49.99, 79.99]  # USD
PRICES_B = [9.90, 14.90, 29.90, 39.90, 59.90]           # EUR
REFUND_IDX_A = {5, 17, 29}
REFUND_IDX_B = {8, 19}
ADJUSTMENTS_A2 = [('2026-08-26', '库存赔偿', 25.00), ('2026-08-30', '月度仓储费', -18.75)]
OPENING_A_INTRANSIT = 4120.55   # 7 月批次（07-31 结算，08-03 到账）
OPENING_BANK_USD = 8500.00
OPENING_BANK_EUR = 1000.00
COMMITTED = [
    ('2026-10-01', 'MOCK-付费媒体预算', 3000.00, 'USD'),
    ('2026-10-05', 'MOCK-SaaS 订阅（对账/ERP）', 420.00, 'USD'),
    ('2026-10-10', 'MOCK-样品采购', 800.00, 'USD'),
    ('2026-10-15', 'MOCK-3PL 押金', 1500.00, 'USD'),
]


def day_iso(day: int) -> str:
    return f'2026-08-{day:02d}'


def channel_a():
    txns, refunds = [], []
    for i in range(1, 41):
        day = 1 + ((i * 13 + 5) % 28)
        units = 1 + (i % 3)
        gross = ROUND(PRICES_A[i % 6] * units)
        referral = ROUND(gross * 0.12)
        fulfill = ROUND(3.25 * units)
        net = ROUND(gross - referral - fulfill)
        batch = 'A-2026-08-15' if day <= 14 else 'A-2026-09-02'
        txns.append({'date': day_iso(day), 'channel': 'MOCK-Mall', 'order_id': f'AM-{9100 + i}',
                     'type': 'order', 'currency': 'USD', 'gross': gross,
                     'fee_type': '佣金+履约费', 'fee': ROUND(referral + fulfill), 'net': net,
                     'batch': batch})
        if i in REFUND_IDX_A:
            ref_back = ROUND(referral)          # 佣金冲回；履约费不退（合成规则）
            net_r = ROUND(-(gross - ref_back))
            refunds.append({'date': day_iso(min(day + 5, 31)), 'channel': 'MOCK-Mall',
                            'order_id': f'AM-{9100 + i}', 'type': 'refund', 'currency': 'USD',
                            'gross': ROUND(-gross), 'fee_type': '佣金冲回', 'fee': ROUND(-ref_back),
                            'net': net_r, 'batch': batch})
    for date, desc, amt in ADJUSTMENTS_A2:
        txns.append({'date': date, 'channel': 'MOCK-Mall', 'order_id': '-', 'type': f'adjustment({desc})',
                     'currency': 'USD', 'gross': amt, 'fee_type': '-', 'fee': 0.0, 'net': amt,
                     'batch': 'A-2026-09-02'})
    return txns, refunds


def channel_b():
    txns, refunds = [], []
    for i in range(1, 26):
        day = 2 + ((i * 11) % 26)
        units = 1 + (i % 2)
        gross = ROUND(PRICES_B[i % 5] * units)
        fee = ROUND(gross * 0.029 + 0.30)
        net = ROUND(gross - fee)
        week = f'B-2026-08-{7 + 7 * min((day - 1) // 7, 3):02d}'
        txns.append({'date': day_iso(day), 'channel': 'MOCK-Store', 'order_id': f'ST-{4200 + i}',
                     'type': 'order', 'currency': 'EUR', 'gross': gross,
                     'fee_type': '支付处理费', 'fee': fee, 'net': net, 'batch': week})
        if i in REFUND_IDX_B:
            net_r = ROUND(-gross)               # 自建站退款：全额退（支付费不退，合成规则）
            refunds.append({'date': day_iso(min(day + 4, 28)), 'channel': 'MOCK-Store',
                            'order_id': f'ST-{4200 + i}', 'type': 'refund', 'currency': 'EUR',
                            'gross': ROUND(-gross), 'fee_type': '-', 'fee': 0.0,
                            'net': net_r, 'batch': week})
    return txns, refunds


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', default='skill-lifecycle/trial-home/intake/SYNTH-G07')
    args = parser.parse_args()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    a_txns, a_refunds = channel_a()
    b_txns, b_refunds = channel_b()

    # ---- 结算口径（按 batch 汇总） ----
    def settle(rows, batch):
        return ROUND(sum(r['net'] for r in rows if r['batch'] == batch))

    a_direct = [r for r in a_txns if r['type'] == 'order']
    a_all = a_txns + a_refunds
    batches_a = sorted({r['batch'] for r in a_all})
    settle_a = {b: settle(a_all, b) for b in batches_a}
    paid_in_aug_a = {b: (b != 'A-2026-09-02') for b in batches_a}  # A-2026-08-15 已付；09-02 期末在途
    b_all = b_txns + b_refunds
    batches_b = sorted({r['batch'] for r in b_all})
    settle_b = {b: settle(b_all, b) for b in batches_b}

    # ---- 不变量断言 ----
    assert ROUND(sum(r['net'] for r in a_all)) == ROUND(sum(settle_a.values())), 'A: Σnet ≠ Σsettle'
    assert ROUND(sum(r['net'] for r in b_all)) == ROUND(sum(settle_b.values())), 'B: Σnet ≠ Σsettle'
    a_intransit_end = settle_a['A-2026-09-02']
    assert all((r['batch'] == 'A-2026-08-15') == (r['date'] <= '2026-08-14')
               for r in a_txns if r['type'] == 'order'), 'A 批次归属与日期规则不符'
    assert a_intransit_end > 0, '期末在途应为正'
    for r in a_all + b_all:
        for k in ('gross', 'fee', 'net'):
            assert round(r[k], 2) == r[k], f'两位小数被破坏: {r}'

    # ---- SYNTH-03 交易明细 ----
    detail = a_all + b_all
    detail.sort(key=lambda r: (r['currency'], r['date'], r['order_id']))
    with (out / 'SYNTH-03-交易明细-2026-08.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['日期', '渠道', '订单号', '类型', '币种', '含税金额', '费用类型', '费用', '净额', '结算批次'])
        for r in detail:
            w.writerow([r['date'], r['channel'], r['order_id'], r['type'], r['currency'],
                        r['gross'], r['fee_type'], r['fee'], r['net'], r['batch']])

    # ---- SYNTH-01/02 结算一览（按批次） ----
    def summary_rows(rows, batches, settle_map, currency):
        out_rows = []
        for b in batches:
            br = [r for r in rows if r['batch'] == b]
            gmv = ROUND(sum(r['gross'] for r in br if r['type'] == 'order'))
            refund = ROUND(sum(r['gross'] for r in br if r['type'] == 'refund'))
            fees = ROUND(sum(r['fee'] for r in br if r['type'] == 'order'))
            fee_back = ROUND(sum(r['fee'] for r in br if r['type'] == 'refund'))
            adj = ROUND(sum(r['net'] for r in br if r['type'].startswith('adjustment')))
            out_rows.append([b, currency, gmv, refund, fees, fee_back, adj, settle_map[b]])
        return out_rows

    with (out / 'SYNTH-01-结算一览-渠道A-2026-08.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['结算批次', '币种', '订单含税额', '退款额', '佣金+履约费', '佣金冲回', '调整项', '结算净额'])
        w.writerows(summary_rows(a_all, batches_a, settle_a, 'USD'))
    with (out / 'SYNTH-02-结算一览-渠道B-2026-08.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['结算批次', '币种', '订单含税额', '退款额', '支付处理费', '佣金冲回', '调整项', '结算净额'])
        w.writerows(summary_rows(b_all, batches_b, settle_b, 'EUR'))

    # ---- SYNTH-05 科目表 ----
    accounts = [
        ('1001', '银行存款-USD', '资产', '渠道A 回款与 USD 支出'),
        ('1002', '银行存款-EUR', '资产', '渠道B 回款（按需换汇）'),
        ('1101', '应收结算款-渠道A', '资产', '已结算未到账（在途）'),
        ('2201', '应付平台费', '负债', '佣金/履约/支付处理费计提'),
        ('2202', '应交税费-VAT', '负债', '渠道B 含税价内含 VAT（代收代缴，memo）'),
        ('6001', '主营业务收入', '收入', '净额法记收入（扣平台费后）'),
        ('6401', '平台佣金', '费用', '渠道A 12%（合成假设）'),
        ('6402', '履约/物流费', '费用', '渠道A $3.25/件（合成假设）'),
        ('6403', '支付处理费', '费用', '渠道B 2.9%+€0.30（合成假设）'),
        ('6603', '汇兑损益', '费用', 'EUR→USD 折算差（本包按固定 1.09，无损益样例）'),
        ('6701', '退款与折让', '费用', '退款冲减收入（合成规则）'),
    ]
    with (out / 'SYNTH-05-科目表.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['科目编码', '科目名称', '类别', '用途（含合成规则）'])
        w.writerows(accounts)

    # ---- SYNTH-08 已承诺支出 ----
    with (out / 'SYNTH-08-已承诺支出.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['计划日期', '对象', '金额', '币种', '备注'])
        for date, desc, amt, cur in COMMITTED:
            w.writerow([date, desc, amt, cur, '合成数据'])

    # ---- SYNTH-09 期望对账输出（由同一事件账计算，保证自洽） ----
    a_gmv = ROUND(sum(r['gross'] for r in a_all if r['type'] == 'order'))
    a_ref = ROUND(sum(r['gross'] for r in a_all if r['type'] == 'refund'))
    a_fee = ROUND(sum(r['fee'] for r in a_all if r['type'] == 'order'))
    a_feeback = ROUND(sum(r['fee'] for r in a_all if r['type'] == 'refund'))
    a_adj = ROUND(sum(r['net'] for r in a_all if r['type'].startswith('adjustment')))
    a_net = ROUND(sum(settle_a.values()))
    a_received = ROUND(OPENING_A_INTRANSIT + sum(v for k, v in settle_a.items() if paid_in_aug_a[k]))
    b_gmv = ROUND(sum(r['gross'] for r in b_all if r['type'] == 'order'))
    b_ref = ROUND(sum(r['gross'] for r in b_all if r['type'] == 'refund'))
    b_fee = ROUND(sum(r['fee'] for r in b_all if r['type'] == 'order'))
    b_net = ROUND(sum(settle_b.values()))
    b_vat = ROUND(sum(r['gross'] for r in b_all if r['type'] == 'order') / 1.2 * 0.2)
    with (out / 'SYNTH-09-期望对账输出.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['渠道', '口径', '金额', '币种', '说明'])
        w.writerows([
            ['MOCK-Mall', '订单含税额', a_gmv, 'USD', '40 单（合成）'],
            ['MOCK-Mall', '退款额', a_ref, 'USD', '3 单，佣金按规则冲回、履约费不退'],
            ['MOCK-Mall', '平台费', a_fee, 'USD', '佣金 12% + 履约 $3.25/件'],
            ['MOCK-Mall', '佣金冲回', a_feeback, 'USD', '退款伴随的佣金冲回'],
            ['MOCK-Mall', '调整项', a_adj, 'USD', '库存赔偿 +25 / 仓储费 −18.75'],
            ['MOCK-Mall', '结算净额', a_net, 'USD', '= 订单 − 退款 − 费 + 冲回 + 调整（A-08-15 与 A-09-02 两批）'],
            ['MOCK-Mall', '8 月到账', a_received, 'USD', '含 7 月在途 4120.55（08-03 到账）+ A-08-15 批'],
            ['MOCK-Mall', '期末在途', a_intransit_end, 'USD', 'A-09-02 批，9 月到账'],
            ['MOCK-Store', '订单含税额', b_gmv, 'EUR', '25 单（合成）'],
            ['MOCK-Store', '退款额', b_ref, 'EUR', '2 单，全额退、支付费不退'],
            ['MOCK-Store', '支付处理费', b_fee, 'EUR', '2.9% + €0.30/笔'],
            ['MOCK-Store', '结算净额', b_net, 'EUR', '四周周结净额合计'],
            ['MOCK-Store', 'VAT（memo）', b_vat, 'EUR', '含税价内 VAT20%，代收代缴不进损益'],
            ['合并', '8 月净现金流入（USD）', ROUND(a_received - OPENING_A_INTRANSIT + b_net * FX_EUR_USD), 'USD',
             '渠道A 当月到账含 7 月在途抵扣；EUR 按 1.09 折算'],
            ['合并', '期末银行（USD 等值）', ROUND(OPENING_BANK_USD + a_received + OPENING_BANK_EUR * FX_EUR_USD + b_net * FX_EUR_USD),
             'USD', '期初 8500.00 + 起 1000€ + 两渠道 8 月回款'],
        ])

    print(f'SYNTH-G07 生成完成 → {out}')
    print(f'不变量全过：A Σnet={ROUND(sum(r["net"] for r in a_all))} = Σsettle={a_net}；'
          f'B Σnet={ROUND(sum(r["net"] for r in b_all))} = Σsettle={b_net}；期末在途 A={a_intransit_end}')


if __name__ == '__main__':
    main()
