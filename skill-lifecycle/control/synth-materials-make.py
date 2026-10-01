#!/usr/bin/env python3
"""合成材料生成器（零请求、确定性、内置一致性断言）：

- `--pack g07`（默认）：「GMV→净结算对账/现金」练习包（SYNTH-G07）——渠道A/B 事件账、结算一览、
  科目、汇率税口径、期初账期、承诺支出、期望对账输出。
- `--pack g04`：「PO 履约 / SKU 退出清货 / WMS-RMA / 退货处置」练习包（SYNTH-G04）——PO/收货/发票
  三方对账、短交与破损案、库存状态字典、3PL 回执、库龄处置建议。

均为**合成数据**（替代等待中的真实业务材料；用户 2026-10-01 授权自主生成）。规定：

- 全程**无随机数**：全部由固定常量/索引导出 ⇒ 任意机器可逐字节重生成。
- **一致性不变量**（写盘前断言，破坏即失败）；所有金额/数量两位小数。
- 两个包的 CSV 由本脚本生成；包内的叙述性 MD（包说明/异常案/政策）为手写件。

用法：python3 -B synth-materials-make.py [--pack g07|g04] [--out <dir>]
"""
import argparse
import csv
from datetime import date as _date
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


def pack_g07(out):
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


# ===== G04：PO 履约 / SKU 退出清货 / WMS-RMA / 退货处置 =====

PO_G04 = {
    'PO-1101': {'supplier': 'MOCK-SUP-A（深圳）', 'date': '2026-08-05', 'incoterm': 'FOB 深圳',
                'lines': [('BB-BOTTLE-240', '奶瓶 240ml', 600, 2.80),
                          ('BB-RATTLE-TOY', '摇铃玩具', 1200, 1.45),
                          ('BB-BIB-SIL', '硅胶围兜', 800, 1.10)]},
    'PO-1102': {'supplier': 'MOCK-SUP-B（宁波）', 'date': '2026-08-12', 'incoterm': 'FOB 宁波',
                'lines': [('BB-WIPES-80', '婴儿湿巾 80抽', 2400, 0.62),
                          ('BB-CREAM-50', '护臀霜 50g', 1000, 1.95)]},
}
RECEIPTS_G04 = [
    ('RCPT-1101-1', '2026-08-20', 'PO-1101',
     [('BB-BOTTLE-240', 600, 0), ('BB-RATTLE-TOY', 1000, 0), ('BB-BIB-SIL', 800, 0)], '3PL-华东A仓', ''),
    ('RCPT-1101-2', '2026-08-27', 'PO-1101',
     [('BB-RATTLE-TOY', 200, 10)], '3PL-华东A仓', '补货；10 件外箱破损扣留'),
    ('RCPT-1102-1', '2026-09-02', 'PO-1102',
     [('BB-WIPES-80', 2380, 0), ('BB-CREAM-50', 1000, 0)], '3PL-华南B仓', '短交 20（贷记结案）'),
]
RETURNS_G04 = [
    ('RMA-3001', '2026-09-08', 'BB-BOTTLE-240', 3, '未开封、封签完整', '再售', '卫生检查通过后回可售'),
    ('RMA-3002', '2026-09-09', 'BB-CREAM-50', 1, '已开封', '报废', '开封后不可再售（卫生红线）'),
    ('RMA-3003', '2026-09-10', 'BB-WIPES-80', 2, '封口破损', '报废', '封口破损不可再售（卫生红线）'),
]
AGING_G04 = [
    ('BB-RATTLE-TOY', '2026-03-10', 1190, 12, '无保质期', '清货（促销 + 渠道清仓）', '库龄>180 天且周均<15'),
    ('BB-CREAM-50', '2026-06-15', 1000, 40, '保质期至 2027-01（临期监控）', '正常销售 + 临期预警', '剩余>3 个月且周均≥30'),
    ('BB-WIPES-80', '2026-09-02', 2380, 300, '保质期至 2028-03', '正常销售', '周转健康'),
    ('BB-BIB-SIL', '2026-06-10', 800, 8, '无保质期', '监控（90 天窗口）', '库龄 90–180 天且周均<15'),
    ('BB-BOTTLE-240', '2026-08-20', 600, 60, '无保质期', '正常销售', '周转健康'),
]
STATUS_DICT_G04 = [
    ('IN_TRANSIT', '在途未到货', 'PO 已发运、3PL 未收', '否', '→ RECEIVED_PENDING_QC'),
    ('RECEIVED_PENDING_QC', '收货待检', '3PL 已收货、质检未出', '否', '→ AVAILABLE / QC_HOLD'),
    ('AVAILABLE', '可售', '质检通过、可上架销售', '是', '← RECEIVED_PENDING_QC / RESELL_READY'),
    ('QC_HOLD', '质检扣留', '外箱/外观异常待判定（如破损待索赔）', '否', '→ DAMAGED_CLAIM / AVAILABLE'),
    ('DAMAGED_CLAIM', '损件索赔中', '破损件挂账，随发票差异索赔', '否', '→ DISPOSED（或供应商补发）'),
    ('QUARANTINE', '退货隔离', 'RMA 收货后隔离，未经卫生检查不可再售', '否', '→ RESELL_READY / DISPOSED'),
    ('RESELL_READY', '复售就绪', '未开封、封签完整、批次可追溯 ⇒ 回可售', '是', '→ AVAILABLE'),
    ('DISPOSED', '已报废', '卫生红线命中（开封/封口破损等），留痕处置', '否', '（终态）'),
    ('OUTSTANDING', '未交足', 'PO 行未交数量（可补货或结案）', '否', '→ 收货 / 结案（贷记）'),
]
AS_OF_G04 = _date(2026, 9, 15)  # 库龄与临期计算基准日（合成）


def pack_g04(out):
    out.mkdir(parents=True, exist_ok=True)

    # ① 采购订单（01）
    po_rows, po_total = [], {}
    for po, meta in PO_G04.items():
        total = 0.0
        for sku, name, qty, unit in meta['lines']:
            amt = ROUND(qty * unit)
            total = ROUND(total + amt)
            po_rows.append([po, meta['date'], meta['supplier'], sku, name, qty, unit, amt, meta['incoterm']])
        po_total[po] = total
    with (out / 'SYNTH-01-采购订单-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['采购单', '日期', '供应商', 'SKU', '品名', '订购数量', '单价USD', '金额USD', '贸易条款'])
        w.writerows(po_rows)

    # ② 收货与差异（02）
    ordered = {(po, sku): qty for po, meta in PO_G04.items() for sku, _n, qty, _u in meta['lines']}
    recv = {}
    rc_rows = []
    for rcpt, date, po, lines, where, note in RECEIPTS_G04:
        for sku, qty, damaged in lines:
            recv[(po, sku)] = recv.get((po, sku), 0) + qty
            outstanding = ordered[(po, sku)] - recv[(po, sku)]
            assert outstanding >= 0, f'{po}/{sku} 超收'
            rc_rows.append([rcpt, date, po, sku, ordered[(po, sku)], qty, damaged, outstanding, where, note])
    with (out / 'SYNTH-02-收货与差异-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['收货单', '日期', '采购单', 'SKU', '订购数量', '实收数量', '破损件数', '未交数量', '收货地', '备注'])
        w.writerows(rc_rows)

    # ③ 发票与三方对账（03）：差异必须等于可解释的索赔/贷记额
    a_received_value = ROUND(600 * 2.80 + (1000 + 200 - 10) * 1.45 + 800 * 1.10)
    a_diff = ROUND(po_total['PO-1101'] - a_received_value)
    b_received_value = ROUND(2380 * 0.62 + 1000 * 1.95)
    b_diff = ROUND(po_total['PO-1102'] - b_received_value)
    assert a_diff == ROUND(10 * 1.45), 'A 差异应等于破损 10×1.45'
    assert b_diff == ROUND(20 * 0.62), 'B 差异应等于短交 20×0.62'
    with (out / 'SYNTH-03-发票与三方对账-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['发票号', '采购单', '按订单金额USD', '按实收价值USD', '差异USD', '处置', '状态'])
        w.writerows([
            ['INV-A-2601', 'PO-1101', po_total['PO-1101'], a_received_value, a_diff,
             '破损 10 件×1.45 索赔（供应商A）', '索赔中'],
            ['INV-B-2602', 'PO-1102', po_total['PO-1102'], b_received_value, b_diff,
             '短交 20 件×0.62 贷记 CN-B-2601', '已结'],
        ])

    # ④ 库存恒等式 + 状态字典（05）
    inventory = {'BB-BOTTLE-240': (600, 600, 0), 'BB-RATTLE-TOY': (1200, 1190, 10),
                 'BB-BIB-SIL': (800, 800, 0), 'BB-WIPES-80': (2380, 2380, 0), 'BB-CREAM-50': (1000, 1000, 0)}
    for sku, (rcvd, avail, hold) in inventory.items():
        assert rcvd == avail + hold, f'{sku} 库存恒等式破坏'
        assert rcvd == recv.get(('PO-1101', sku), 0) + recv.get(('PO-1102', sku), 0), f'{sku} 库存≠收货'
    with (out / 'SYNTH-05-库存状态字典.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['状态码', '名称', '定义', '可售性', '允许流转'])
        w.writerows(STATUS_DICT_G04)

    # ⑤ 3PL 回执（07）：收货回执（逐行）＋上架回执（无损件）＋退货回执（RMA）
    r3pl = []
    for rcpt, date, po, lines, where, _note in RECEIPTS_G04:
        for sku, qty, damaged in lines:
            r3pl.append([f'3PLR-{rcpt}-{sku}', '收货回执', date, rcpt, sku, qty, '已收货', where])
            if qty - damaged > 0:
                r3pl.append([f'3PLP-{rcpt}-{sku}', '上架回执', date, rcpt, sku, qty - damaged,
                             '已上架' if damaged == 0 else '部分上架（破损扣留）', where])
    for rma, date, sku, qty, _cond, _disp, _note in RETURNS_G04:
        r3pl.append([f'3PLR-{rma}', '退货回执', date, rma, sku, qty, '已收退货·隔离', '3PL-华东A仓'])
    with (out / 'SYNTH-07-3PL回执-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['回执号', '类型', '日期', '关联单号', 'SKU', '数量', '状态', '仓'])
        w.writerows(r3pl)

    # ⑥ 退货恒等式 + 库龄处置建议（08，库龄按基准日计算）
    total_ret = sum(r[3] for r in RETURNS_G04)
    resell = sum(r[3] for r in RETURNS_G04 if r[5] == '再售')
    dispose = sum(r[3] for r in RETURNS_G04 if r[5] == '报废')
    assert resell + dispose == total_ret, '退货处置未闭合'
    with (out / 'SYNTH-08-库龄处置建议-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['SKU', '入库日', '库龄天数', '可售数量', '近90天周均', '保质期状态', '建议处置', '规则依据'])
        for sku, entry, avail, weekly, shelf, advice, rule in AGING_G04:
            age = (AS_OF_G04 - _date.fromisoformat(entry)).days
            w.writerow([sku, entry, age, avail, weekly, shelf, advice, rule])

    print(f'SYNTH-G04 生成完成 → {out}')
    print(f'不变量全过：PO 合计 A={po_total["PO-1101"]} / B={po_total["PO-1102"]}；'
          f'发票差异 A={a_diff}（破损索赔）B={b_diff}（短交贷记）；库存恒等式 5/5；'
          f'退货 {total_ret} 件 = 再售 {resell} + 报废 {dispose}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pack', choices=['g07', 'g04'], default='g07')
    parser.add_argument('--out', default=None)
    args = parser.parse_args()
    default_out = {'g07': 'skill-lifecycle/trial-home/intake/SYNTH-G07',
                   'g04': 'skill-lifecycle/trial-home/intake/SYNTH-G04'}[args.pack]
    out = Path(args.out or default_out).resolve()
    if args.pack == 'g04':
        pack_g04(out)
    else:
        pack_g07(out)


if __name__ == '__main__':
    main()
