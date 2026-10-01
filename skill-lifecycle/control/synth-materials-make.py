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

用法：python3 -B synth-materials-make.py [--pack g07|g04|g03|g06|g08|g01|g02|g05|g09|g10|g11] [--out <dir>]
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


# ===== G03：硬件工程审查 / DVP&R / 批次质量与 8D-CAPA =====

BOM_G03 = [
    # (层级, 父件, 子件/物料, 名称, 用量, 单位, 单价USD, 损耗率, 版本, 供应商)
    (1, 'HM-PUMP-100', 'PUMP-UNIT-A', '泵体组件', 1, '件', 18.50, 0.01, 'B', 'MOCK-SUP-M（东莞）'),
    (1, 'HM-PUMP-100', 'BOTTLE-240', '奶瓶组件 240ml', 1, '件', 3.20, 0.01, 'A', 'MOCK-SUP-M（东莞）'),
    (1, 'HM-PUMP-100', 'SIL-DIAPHRAGM', '硅胶隔膜（D-02 版）', 2, '片', 0.85, 0.03, 'D-02', 'MOCK-SUP-S（苏州）'),
    (1, 'HM-PUMP-100', 'TUBING-SET', '管路组', 1, '套', 2.10, 0.01, 'A', 'MOCK-SUP-M（东莞）'),
    (1, 'HM-PUMP-100', 'PSU-5V', '电源适配器 5V/2A', 1, '件', 4.60, 0.005, 'C', 'MOCK-SUP-E（深圳）'),
    (1, 'HM-PUMP-100', 'BOX-A', '彩盒与内衬', 1, '套', 1.20, 0.02, 'B', 'MOCK-SUP-P（温州）'),
]
SPECS_G03 = [
    # (特性编号, 关键特性, 标称, 下差, 上差, 单位, 检验方法, 抽样与判定)
    ('KC-01', '吸力范围（负压）', -180, -9, 9, 'mmHg', '数字压力计（逐台校准）', 'AQL 0.65 关键'),
    ('KC-02', '噪音（1m）', 43, -0, 2.0, 'dB(A)', '声级计（半消室）', 'AQL 0.65 关键'),
    ('KC-03', '流量', 35, -10, 10, 'mL/min', '量杯计时 3 次取均值', 'AQL 2.5 主要'),
    ('KC-04', '瓶口口径', 60, -0.2, 0.2, 'mm', '游标卡尺', 'AQL 2.5 主要'),
    ('KC-05', '材料安全（BPA-free）', 0, 0, 0, '—', '第三方检测报告（批次抽检）', '每批 1 份报告'),
    ('KC-06', '外壳壁厚（8D 后新增）', 2.6, -0.1, 0.1, 'mm', '超声测厚', 'AQL 0.65 关键'),
]
ECO_G03 = [
    # (ECO号, 日期, 对象, 变更内容, 生效批次)
    ('ECO-2601', '2026-03-12', 'BOTTLE-240', '瓶身高光面改磨砂（防滑）', 'PB-2604 起'),
    ('ECO-2602', '2026-05-20', 'PSU-5V', '适配器改 C 口（兼容旧线）', 'PB-2606 起'),
    ('ECO-2603', '2026-08-05', 'SIL-DIAPHRAGM', '隔膜材料改 D-02 版（硬化问题整改，见 8D）', 'PB-2609 起'),
    ('ECO-2604', '2026-08-28', 'PUMP-UNIT-A（外壳）', '壁厚 1.8→2.6mm 并加加强筋（跌落裂纹整改，见 8D）', 'PB-2610 起'),
]
DVPR_G03 = [
    # (测试项, 阶段, 样本量, 条件, 判定标准, 状态)
    ('吸力循环耐久', 'DVT', 6, '满档循环 10000 次（30s 开/30s 停）', '吸力衰减 ≤10%，无功能失效', '通过'),
    ('整机跌落', 'DVT', 12, '1.2m，6 面各 2 次（含包装自由落体）', '无裂纹、无功能失效', 'FAIL→整改后通过'),
    ('噪音', 'DVT', 3, '1m 半消室满档', '≤45 dB(A)', '通过'),
    ('耐煮沸/蒸汽消毒', 'DVT', 3, '煮沸 5min×20 循环（接触件）', '无变形、无析出、无异味', '通过'),
    ('老化（湿热）', 'EVT', 3, '60℃/90%RH 96h', '外观与功能无异常', '通过'),
    ('材料安全（BPA-free）', 'PVT', '1 批', '第三方检测', '符合标准限值', '通过'),
]
TESTREPORT_G03 = [
    # (报告号, 测试项, 日期, 样本, 实测摘要, 判定, 异常说明)
    ('TR-2608-01', '吸力循环耐久', '2026-08-08', '6 台', '10000 次后吸力衰减 4.2%（-180→-172.4mmHg）', '通过', ''),
    ('TR-2608-02', '整机跌落', '2026-08-09', '12 台', '10/12 通过；2 台外壳接缝处裂纹（批 PB-2608）', 'FAIL', 'DEF-001（转 8D）'),
    ('TR-2608-03', '噪音', '2026-08-10', '3 台', '实测 43.2 / 43.8 / 44.1 dB(A)', '通过', ''),
    ('TR-2608-04', '耐煮沸', '2026-08-10', '3 套', '20 循环无变形析出', '通过', ''),
    ('TR-2609-05', '整机跌落（整改复测）', '2026-08-30', '12 台（PB-2610 试产）', '12/12 通过；含壁厚抽检 2.58–2.62mm', '通过', 'DEF-001 关闭'),
]
DEFECTS_G03 = [
    # (缺陷号, 来源, 描述, 根因, 整改措施, 复测结果, 状态)
    ('DEF-001', 'TR-2608-02 跌落', '外壳接缝裂纹（2/12）', '壁厚 1.8mm 设计裕度不足＋接缝无加强',
     '壁厚改 2.6mm＋加强筋（ECO-2604）', 'TR-2609-05 12/12 通过＋壁厚 KC-06 抽检合格', '已关闭'),
    ('DEF-002', '客诉反馈（3 例）', '隔膜使用 2 个月后硬化异响', '材料配方耐疲劳不足（D-01 版）',
     '改 D-02 版材料（ECO-2603）＋来料加硬度项', '3 批连续抽检 0 缺陷（含 8D D6 验证）', '已关闭'),
]
TRACE_G03 = [
    # (原料批, 物料, 供应商, 到货日, 消耗于生产批, 数量)
    ('RM-2607-S1', 'SIL-DIAPHRAGM（D-01）', 'MOCK-SUP-S', '2026-07-10', 'PB-2608', 2400),
    ('RM-2608-S2', 'SIL-DIAPHRAGM（D-02）', 'MOCK-SUP-S', '2026-08-20', 'PB-2610', 2400),
    ('RM-2608-M1', 'PUMP-UNIT-A（外壳 1.8mm）', 'MOCK-SUP-M', '2026-08-01', 'PB-2608', 1100),
    ('RM-2609-M2', 'PUMP-UNIT-A（外壳 2.6mm）', 'MOCK-SUP-M', '2026-08-26', 'PB-2610', 1100),
]
PROD_G03 = [
    # (生产批, 日期, 投产, 良品, 不良, 不良明细, 成品去向)
    ('PB-2608', '2026-08-02~08-14', 1050, 1000, 50, '组装不良 45（密封圈装配）+ 测试报废 5', 'FBA-2608-A 入库 500 件；其余留仓'),
    ('PB-2610', '2026-08-28~09-05', 1100, 1065, 35, '组装不良 30 + 跌落预检抽废 5', 'FBA-2609-A 入库 1000 件；其余留仓'),
]


def pack_g03(out):
    out.mkdir(parents=True, exist_ok=True)

    # ① BOM（含材料成本断言）
    bom_rows = []
    mat_cost = 0.0
    for lvl, parent, child, name, qty, unit, price, loss, rev, sup in BOM_G03:
        line_cost = ROUND(qty * price * (1 + loss))
        mat_cost = ROUND(mat_cost + line_cost)
        bom_rows.append([lvl, parent, child, name, qty, unit, price, loss, rev, sup,
                         ROUND(qty * price), line_cost])
    expect_cost = ROUND(ROUND(18.50 * 1.01) + ROUND(3.20 * 1.01) + ROUND(2 * 0.85 * 1.03)
                        + ROUND(2.10 * 1.01) + ROUND(4.60 * 1.005) + ROUND(1.20 * 1.02))
    assert mat_cost == expect_cost, f'G03 BOM 材料成本 {mat_cost} != {expect_cost}'
    with (out / 'SYNTH-01-BOM-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['层级', '父件', '子件/物料', '名称', '用量', '单位', '单价USD', '损耗率',
                    '版本', '供应商', '行金额USD', '含损耗成本USD'])
        w.writerows(bom_rows)

    # ② 规格与公差（断言 min<nom<max；KC-06 与 8D 整改一致）
    spec_rows = []
    for kc, name, nom, lo, hi, unit, method, sampling in SPECS_G03:
        assert lo <= 0 <= hi, f'{kc} 公差方向异常'
        spec_rows.append([kc, name, nom, lo, hi, unit, method, sampling])
    assert any(r[0] == 'KC-06' and r[2] == 2.6 for r in spec_rows), 'KC-06 应为 8D 后新增壁厚项'
    with (out / 'SYNTH-02-规格与公差-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['特性编号', '关键特性', '标称', '下差', '上差', '单位', '检验方法', '抽样与判定'])
        w.writerows(spec_rows)

    # ③ 图纸与变更记录
    with (out / 'SYNTH-03-图纸与变更记录-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['ECO号', '日期', '对象', '变更内容', '生效批次'])
        w.writerows([list(r) for r in ECO_G03])

    # ④ DVP&R（断言：fail 项与缺陷记录来源一致）
    dvpr_rows = [list(r) for r in DVPR_G03]
    fails = [r for r in dvpr_rows if str(r[5]).startswith('FAIL')]
    assert len(fails) == 1 and fails[0][0] == '整机跌落', 'DVP&R 应有且仅有跌落项 FAIL（对应 DEF-001）'
    with (out / 'SYNTH-04-试验计划DVP&R-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['测试项', '阶段', '样本量', '条件', '判定标准', '状态'])
        w.writerows(dvpr_rows)

    # ⑤ 试验报告（断言：TR-2608-02 FAIL 与 DEF-001 对应；复测报告存在）
    tr_rows = [list(r) for r in TESTREPORT_G03]
    assert any('FAIL' in r[5] and 'DEF-001' in r[6] for r in tr_rows), '跌落 FAIL 应指向 DEF-001'
    assert any('整改复测' in r[1] and r[5] == '通过' for r in tr_rows), '应有整改复测通过报告'
    with (out / 'SYNTH-05-试验报告-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['报告号', '测试项', '日期', '样本', '实测摘要', '判定', '异常说明'])
        w.writerows(tr_rows)

    # ⑥ 缺陷与复测（断言：两条均关闭且复测可追溯）
    def_rows = [list(r) for r in DEFECTS_G03]
    assert all(r[6] == '已关闭' for r in def_rows), '缺陷均应关闭'
    assert def_rows[0][5].startswith('TR-2609-05'), 'DEF-001 复测应指向 TR-2609-05'
    with (out / 'SYNTH-06-缺陷与复测-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['缺陷号', '来源', '描述', '根因', '整改措施', '复测结果', '状态'])
        w.writerows(def_rows)

    # ⑦ 批次追溯（断言：消耗量 ≤ 到货量；生产批守恒）
    trace_rows = [list(r) for r in TRACE_G03]
    for _batch, mat, _sup, _d, _pb, qty in trace_rows:
        need = 2 * 1050 if 'DIAPHRAGM' in mat else 1050
        assert qty >= need, f'{_batch} 消耗量不足（{qty} < {need}）'
    prod_rows = [list(r) for r in PROD_G03]
    for pb, _d, start, good, bad, _detail, _dest in prod_rows:
        assert start == good + bad, f'{pb} 投产≠良品+不良'
    assert prod_rows[0][3] + prod_rows[0][4] == prod_rows[0][2] == 1050, 'PB-2608 守恒 1050=1000+50'
    assert prod_rows[1][3] + prod_rows[1][4] == prod_rows[1][2] == 1100, 'PB-2610 守恒 1100=1065+35'
    with (out / 'SYNTH-07-批次追溯-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['原料批', '物料', '供应商', '到货日', '消耗于生产批', '数量'])
        w.writerows(trace_rows)
    with (out / 'SYNTH-07b-生产批与去向-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['生产批', '日期', '投产', '良品', '不良', '不良明细', '成品去向'])
        w.writerows(prod_rows)

    print(f'SYNTH-G03 生成完成 → {out}')
    print(f'不变量全过：BOM 材料成本={mat_cost}；规格 6 项（含 KC-06 新增）；'
          f'DVP&R fail=1（跌落→DEF-001→TR-2609-05 复测通过）；批次守恒 PB-2608=1050/PB-2610=1100；缺陷 2/2 关闭')



# ===== G06：核准售前指导 / 售后补救与安全使用教育 =====

FAQ_G06 = [
    # (产品/型号, 核准表述, 适用范围, 禁忌/边界, 常见问题&核准回答)
    ('HM-PUMP-100 吸奶器', '单边电动吸奶器，6 档吸力+3 档频率', '哺乳期妈妈居家/办公使用（非医疗用途）',
     '非医疗器械；不用于治疗乳腺炎等疾病；早产/特殊医学情况请遵医嘱',
     'Q：吸力越大越好吗？A：按舒适档使用，出现疼痛应降低档位并咨询专业。'),
    ('HM-PUMP-200 吸奶器', '双边电动吸奶器，双边同步节省时间', '同 100（非医疗用途）',
     '同 100；双边使用需注意管路清洁', 'Q：和 100 的区别？A：双边同步、档位更多，见型号差异表。'),
    ('BB-WIPES-80 婴儿湿巾', '无香精婴儿湿巾（80 抽）', '婴儿日常清洁（手口、臀部）',
     '不可用于伤口；出现红疹停用并咨询医生', 'Q：可以擦嘴吗？A：手口适用（核准表述），眼部避免。'),
    ('BB-CREAM-50 护臀霜', '氧化锌护臀隔离霜', '尿布区皮肤日常隔离防护',
     '不可用于破损皮肤/感染部位；皮肤异常请就医', 'Q：多久见效？A：属防护用品，持续异常请就医。'),
    ('BB-BOTTLE-240 奶瓶', 'PPSU 奶瓶 240ml，宽口', '0-12 月喂养',
     '不可高温干烧；奶嘴开裂即更换', 'Q：能微波吗？A：可消毒（说明书条件），不建议微波加热奶液。'),
]
MODEL_DIFF_G06 = [
    # (特性, HM-PUMP-100, HM-PUMP-200)
    ('吸力方式', '单边', '双边同步'),
    ('档位', '吸力 6 档 + 频率 3 档', '吸力 8 档 + 频率 4 档'),
    ('标配配件', '单侧喇叭口×1、奶瓶×1', '双侧喇叭口×2、奶瓶×2'),
    ('噪音（标称）', '≤45 dB(A)', '≤43 dB(A)'),
    ('电池', '内置 2000mAh（约 90min）', '内置 2600mAh（约 120min）'),
    ('适用场景（核准）', '居家/办公单侧使用', '需双边效率的职场背奶等场景'),
]
BANNED_CLAIMS_G06 = [
    # (禁用表述, 原因, 合规替代表述)
    ('治疗乳腺炎 / 治愈堵奶', '未获医疗宣称许可，属治疗功能宣称', '帮助舒缓涨奶不适（非医疗）'),
    ('医用级 / 医疗器械同款', '未按医疗器械注册，禁用误导性资质表述', '母婴电器（按国家标准生产）'),
    ('最安全 / 100% 无害', '绝对化用语，无法证明', '符合 GB 相关标准（提供检测报告编号）'),
    ('提高奶量 / 催奶', '功效性医学宣称无依据', '按个人舒适节奏使用'),
    ('宝宝用了不哭闹', '行为性效果承诺，不可证明', '（删除，改为功能描述）'),
    ('无任何副作用', '绝对化安全承诺', '出现不适请停止使用并咨询专业'),
    ('替代母乳 / 替代亲喂', '违背喂养倡导，误导性表述', '辅助吸乳/储存母乳的工具'),
    ('FDA 认证', '无该认证，虚假资质', '（删除；如有实际检测报告按实引用）'),
]
ESCALATE_G06 = [
    # (场景, 判定要点, 处置, 转交对象, 红线)
    ('健康类：宝宝皮肤红肿/破溃相关咨询', '涉及健康状况判断', '不诊断、不给用药建议；表达关心+引导就医', '儿科/皮肤科医疗资源（平台健康指引）', '禁止医疗诊断与用药建议'),
    ('健康类：妈妈乳腺炎/发热等症状', '涉及疾病症状', '不判断轻重、不推荐药物；提示及时就医', '医疗资源', '禁止医学判断'),
    ('健康类：询问药物与哺乳相容性', '涉及用药安全', '引导咨询医生或药师', '医疗/药学专业人员', '禁止用药建议'),
    ('使用指导类：剂量/频次询问（吸乳时长）', '可能被理解为使用指导', '仅按说明书核准范围回答，超范围转专业', '产品顾问/说明书', '禁止超出说明书建议'),
    ('心理支持类：情绪困扰/产后情绪低落表述', '涉及心理支持边界', '表达共情，不代办判断，提供关怀转交', '心理支持资源', '禁止心理诊断'),
]
POLICY_G06 = [
    # (情形, 时限, 处理方式, 依据/边界)
    ('质量问题（功能性故障）', '签收后 30 天内', '免费换新（同型号），承担往返运费', '需故障视频/照片或寄回检测'),
    ('质量问题（非人为损坏）', '31–90 天', '免费维修；不可修复换新', '检测确认非人为'),
    ('物流破损', '签收后 7 天内', '补发或全额退款（保外包装照片+面单）', '超 7 天按质量通道评估'),
    ('少发/错发', '签收后 7 天内', '补发所缺/换正确型号，承担运费', '核对开箱视频/照片'),
    ('无理由退货（未开封）', '签收后 14 天内', '全额退款（运费按平台规则）', '商品完好未使用'),
    ('卫生类商品（湿巾/护臀霜/奶嘴）', '开封后', '不支持无理由退货（卫生红线）', '密封破损/已开封一律不可退（质量问题除外）'),
    ('人为损坏', '任意时间', '不属保修；提供付费维修通道', '明显撞击/私自拆修痕迹'),
    ('赔付上限', '—', '任何情形赔付不超过订单实付金额（法定情形除外）', '医疗费/间接损失不予承诺，引导依法途径'),
]
UPGRADE_G06 = [
    # (场景, 升级层级, 时限, 回访)
    ('普通咨询/售前', '一线', '当次会话内', '无需回访'),
    ('订单异常/退款争议', '一线→主管', '24 小时内升级', '处理完成后 48h 回访'),
    ('健康/安全相关问题', '一线→专业转交（不得自行判断）', '当次会话内完成转交话术', '按转交资源流程'),
    ('投诉平台/监管提及', '主管→合规', '立即升级（当轮）', '合规跟进记录'),
    ('批量性问题（同问题≥3 例）', '主管→产品/质检', '24 小时内汇总上报', '质检反馈后回访'),
]
TICKETS_G06 = [
    # (工单号, 摘要, 客户诉求, 期望处置, 依据列)
    ('TK-6001', '「用了奶瓶宝宝拉肚子，要赔偿医疗费」', '医疗费赔偿', '共情+引导就医；不承诺医疗赔付；核对订单后按政策处理商品问题',
     '政策：赔付上限；转交：健康类'),
    ('TK-6002', '「护臀霜已开封，想退货」', '开封退货', '说明卫生类开封不支持无理由退货（红线）；如质量问题按质量通道',
     '政策：卫生类商品'),
    ('TK-6003', '「客服能不能告诉我每次吃多少毫升」', '喂养剂量建议', '不提供剂量建议；引导按说明书/医生建议；表述关怀',
     '转交：剂量/频次询问'),
    ('TK-6004', '「吸奶器吸力变小，已过保 95 天」', '免费维修', '超保说明；提供付费维修/以旧换新通道；先收集故障信息',
     '政策：质量问题'),
    ('TK-6005', '「发错色号，还用过了」', '换货', '错发属我方责任：换正确型号并承担运费（已使用不影响）',
     '政策：少发/错发'),
]


def pack_g06(out):
    out.mkdir(parents=True, exist_ok=True)

    # ① 核准 FAQ（断言：每条含禁忌/边界列）
    faq_rows = [list(r) for r in FAQ_G06]
    assert all(r[3] for r in faq_rows), 'FAQ 每条需含禁忌/边界'
    with (out / 'SYNTH-01-核准FAQ-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['产品/型号', '核准表述', '适用范围', '禁忌/边界', '常见问题与核准回答'])
        w.writerows(faq_rows)

    # ② 型号差异（断言：两个型号列均非空）
    diff_rows = [list(r) for r in MODEL_DIFF_G06]
    assert all(r[1] and r[2] for r in diff_rows), '型号差异矩阵不得有空缺'
    with (out / 'SYNTH-02-型号差异-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['特性', 'HM-PUMP-100', 'HM-PUMP-200'])
        w.writerows(diff_rows)

    # ③ 禁用宣称（断言：每条有替代或明确删除）
    ban_rows = [list(r) for r in BANNED_CLAIMS_G06]
    assert all(r[2] for r in ban_rows), '禁用宣称需给出替代表述'
    with (out / 'SYNTH-03-禁用宣称-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['禁用表述', '原因', '合规替代表述'])
        w.writerows(ban_rows)

    # ④ 健康转交（断言：每条含红线；健康类≥3）
    esc_rows = [list(r) for r in ESCALATE_G06]
    assert all('禁止' in r[4] for r in esc_rows), '转交条件须含红线'
    health_scenes = [r for r in esc_rows if ('健康' in r[0] or '医疗' in r[0] or '就医' in r[2]
                      or '医生' in r[2] or '医学' in r[4])]
    assert len(health_scenes) >= 3, '健康类转交场景应≥3'
    with (out / 'SYNTH-04-健康转交条件-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['场景', '判定要点', '处置', '转交对象', '红线'])
        w.writerows(esc_rows)

    # ⑤ 保修赔付政策
    pol_rows = [list(r) for r in POLICY_G06]
    assert any('卫生红线' in r[2] for r in pol_rows), '政策含卫生红线条目'
    assert any('赔付上限' == r[0] for r in pol_rows), '政策含赔付上限'
    with (out / 'SYNTH-05-保修赔付政策-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['情形', '时限', '处理方式', '依据/边界'])
        w.writerows(pol_rows)

    # ⑥ 难例工单（断言：每条依据逐段可追溯至政策/转交条目）
    tk_rows = [list(r) for r in TICKETS_G06]
    for _no, _sum, _ask, _expect, ref in tk_rows:
        for part in ref.split('；'):
            kind, _, k = part.partition('：')
            if kind == '政策':
                hit = any(k in r[0] for r in pol_rows)
            else:
                hit = any(k in r[0] for r in esc_rows)
            assert hit, f'工单 {_no} 依据「{k}」未在{kind}表命中'
    with (out / 'SYNTH-06-难例工单-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['工单号', '摘要', '客户诉求', '期望处置', '依据'])
        w.writerows(tk_rows)

    # ⑦ 升级与回访规则
    up_rows = [list(r) for r in UPGRADE_G06]
    assert any('健康' in r[0] and '转交' in r[1] for r in up_rows), '健康类须走专业转交而非普通升级'
    with (out / 'SYNTH-07-升级与回访规则-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['场景', '升级层级', '时限', '回访'])
        w.writerows(up_rows)

    print(f'SYNTH-G06 生成完成 → {out}')
    print(f'不变量全过：FAQ {len(faq_rows)} 条（含禁忌）；型号差异 {len(diff_rows)} 特性无空缺；'
          f'禁用宣称 {len(ban_rows)} 条均有替代；健康转交 {len(esc_rows)} 场景含红线；政策 {len(pol_rows)} 条；'
          f'工单 {len(tk_rows)} 条可追溯；升级 {len(up_rows)} 条')


# ===== G08：税务实体资料 / IP 与合同证据 / 市场准入与隐私 =====

ENTITIES_G08 = [
    # (实体, 法域, 注册号(合成), 状态, 适用期间, 备注)
    ('MOCK-Trade GmbH', 'DE', 'HRB MOCK-88231', '在营', '2026 全年', '进口主体；IOSS 注册 MOCK-IM-4061'),
    ('MOCK-Store Ltd', 'UK', 'CRN MOCK-11882204', '在营', '2026 全年', '本地销售主体'),
    ('MOCK-Retail LLC', 'US', 'EIN MOCK-88-3341290', '在营', '2026 全年', '销售税按州 nexus 管理'),
]
TAX_G08 = [
    # (税种, 法域, 税率, 申报期, 缴纳方式, 依据)
    ('VAT', 'DE', '19%（标准）/7%（食品·出版物）', '季度（次月 10 日前）', 'ELSTER 电子申报', '实体 E-1 进口与本地仓发货'),
    ('VAT', 'UK', '20%（标准）', '季度（MTD）', 'MTD 兼容软件', '实体 E-2；低值进口另有 IOSS 流程'),
    ('IOSS', 'EU', '按目的国税率', '月度', 'IOSS 中介申报', '≤€150 低值货物订单'),
    ('销售税', 'US', '按州（经济 nexus）', '月度/季度（按州）', '州门户或 CSP', '实体 E-3'),
]
CERTS_G08 = [
    # (证书, 标准, 发证/实验室, 编号(合成), 有效期至, 覆盖产品/法域)
    ('CE-EMC', 'EN 55014 / EN 61000', 'TÜV MOCK-01', 'MOCK-CE-24071', '2027-05-31', '吸奶器（EU）'),
    ('CE-LVD', 'EN 60335', 'TÜV MOCK-01', 'MOCK-CE-24072', '2027-05-31', '吸奶器（EU）'),
    ('EN 71', 'EN 71-1/-2/-3 玩具安全', 'TÜV MOCK-01', 'MOCK-EN71-2405', '2027-03-31', '摇铃玩具（EU）'),
    ('CPC', 'ASTM F963 / CPSIA', 'SGS MOCK-02', 'MOCK-CPC-2413', '2027-02-28', '摇铃玩具（US）'),
    ('REACH 声明', 'SVHC ≤0.1%', 'SGS MOCK-02', 'MOCK-REACH-2408', '2026-12-31', '全品类（EU）'),
]
LABS_G08 = [
    # (机构, 认可范围, 审阅意见节选, 要点)
    ('TÜV MOCK-01', 'EMC / LVD / 玩具安全', '审阅时点 2026-06；意见：吸奶器 LVD 新版 EN 60335-2-xx 过渡期待确认（合成）', '样本证书按现行版引用'),
    ('SGS MOCK-02', '材料 / CPSIA / REACH', '审阅时点 2026-07；意见：「BPA-free」宣称需以检测报告为据（报告号引用）', '宣称与证据绑定'),
    ('顾问审阅（税务）', 'EU VAT / IOSS 流程', '审阅时点 2026-07；意见：IOSS 低值申报与 DE 常规 VAT 链路分开建账（合成）', '两链路分开'),
]
CLAUSES_G08 = [
    # (条款类型, 底线要求, 可让步区间, 说明)
    ('责任上限', '不超过订单金额 1×', '1–2×（大额订单需法务复核）', '排除间接损失'),
    ('管辖', '供应商所在地法院', '仲裁（约定机构）可谈', '跨境执行成本评估'),
    ('IP 归属', '交付物（图纸/模具/文档）归我方', '既有技术背景除外（清晰界定）', '模具产权与转移条件写明'),
    ('质量索赔期', '到货后 12 个月', '9–12 个月', '与行业惯例对齐'),
    ('保密期限', '合作期 + 3 年', '2–3 年', '技术资料单独加密层级'),
    ('数据条款', '不得转售/转移客户数据', '去标识化统计可谈', '与隐私矩阵联动'),
]
DATA_G08 = [
    # (数据类别, 用途, 同意基础, 保留期, 删除机制)
    ('订单与物流数据', '合同履行/客服', '合同必要（无需同意）', '税务留存 7 年', '到期匿名化'),
    ('营销联络数据', '邮件/短信营销', '明示同意（opt-in）', '2 年或撤回即删', '撤回触发删除流程（≤30 天）'),
    ('健康相关咨询记录', '服务支持（特殊类别）', '明示同意+受限处理', '6 个月', '到期删除；访问最小化'),
    ('退货/赔付记录', '售后与反欺诈', '合同必要+正当利益', '24 个月', '与财务凭证分离保留'),
]
ACCESS_G08 = [
    # (产品, 市场, 准入要件, 证据(引用), 结论)
    ('吸奶器（HM-PUMP-100）', 'EU', 'CE-EMC + CE-LVD；包装警示文案', 'MOCK-CE-24071/24072', '可准入（过渡期条款待确认）'),
    ('摇铃玩具', 'EU', 'EN 71 全套 + CE', 'MOCK-EN71-2405', '可准入'),
    ('摇铃玩具', 'US', 'CPC（ASTM F963/CPSIA）', 'MOCK-CPC-2413', '可准入；小零件警示标注'),
    ('湿巾', 'EU', '按化妆品常规（成分/标签）；生物杀灭边界另核', '待补成分表（合成缺）', '待补证'),
]
PRIVACY_G08 = [
    # (请求类型, 例, 时限, 流程)
    ('访问（DSAR）', '客户请求全部个人数据副本', '1 个月（可延长 2 个月）', '身份核验→数据汇总→脱敏交付'),
    ('删除/被遗忘', '无未结交易客户请求删除', '1 个月', '保留义务核查→可删范围删除→确认'),
    ('更正', '收货地址/联系方式更正', '尽快（≤30 天）', '核验→更正→下游同步'),
    ('撤回同意', '退订营销', '即时生效', '渠道退订→营销库删除→记录留痕'),
]


def pack_g08(out):
    out.mkdir(parents=True, exist_ok=True)

    # ① 实体与法域档案
    ent_rows = [list(r) for r in ENTITIES_G08]
    assert all(r[3] == '在营' for r in ent_rows), '实体均应正常状态'
    with (out / 'SYNTH-01-实体与法域档案-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['实体', '法域', '注册号(合成)', '状态', '适用期间', '备注'])
        w.writerows(ent_rows)

    # ② 税务口径（断言：税种法域与实体表交叉）
    tax_rows = [list(r) for r in TAX_G08]
    juris = {r[1] for r in ent_rows}
    for r in tax_rows:
        assert r[1] in juris or r[1] == 'EU', f'税务法域 {r[1]} 无实体对应'
    assert any(r[0] == 'VAT' and r[1] == 'DE' and '19%' in r[2] for r in tax_rows), 'DE VAT 19% 缺'
    with (out / 'SYNTH-02-税务口径-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['税种', '法域', '税率', '申报期', '缴纳方式', '依据'])
        w.writerows(tax_rows)

    # ③ 证书台账（断言：有效期晚于审阅基准）
    cert_rows = [list(r) for r in CERTS_G08]
    for r in cert_rows:
        assert r[4] >= '2026-12-31', f'{r[0]} 有效期过近（{r[4]}）'
    with (out / 'SYNTH-03-证书台账-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['证书', '标准', '发证/实验室', '编号(合成)', '有效期至', '覆盖产品/法域'])
        w.writerows(cert_rows)

    # ④ 实验室与顾问口径
    lab_rows = [list(r) for r in LABS_G08]
    assert all('审阅时点' in r[2] for r in lab_rows), '实验室口径含审阅时点'
    with (out / 'SYNTH-04-实验室与顾问口径-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['机构', '认可范围', '审阅意见节选', '要点'])
        w.writerows(lab_rows)

    # ⑤ 合同条款底线
    clause_rows = [list(r) for r in CLAUSES_G08]
    assert sum(1 for r in clause_rows if '不得' in r[1] or '归我方' in r[1]) >= 2, '底线条款应至少 2 条硬约束'
    with (out / 'SYNTH-05-合同条款底线-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['条款类型', '底线要求', '可让步区间', '说明'])
        w.writerows(clause_rows)

    # ⑥ 数据类别与处理约束（断言：撤回即删＋7 年留存）
    data_rows = [list(r) for r in DATA_G08]
    assert any('撤回' in r[3] or '撤回' in r[4] for r in data_rows), '营销数据须含撤回即删'
    assert any('7 年' in r[3] for r in data_rows), '税务留存 7 年缺'
    with (out / 'SYNTH-06-数据类别与处理约束-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['数据类别', '用途', '同意基础', '保留期', '删除机制'])
        w.writerows(data_rows)

    # ⑦ 准入判断样例（断言：结论与证据联动）
    access_rows = [list(r) for r in ACCESS_G08]
    for r in access_rows:
        if r[4].startswith('可准入'):
            assert r[3].startswith('MOCK-'), f'{r[0]}/{r[1]} 可准入需有证书证据'
        else:
            assert '待补' in r[4] and '待补' in r[3], '待补结论需明示缺证据'
    with (out / 'SYNTH-07-准入判断样例-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['产品', '市场', '准入要件', '证据(引用)', '结论'])
        w.writerows(access_rows)

    # ⑧ 隐私请求处理
    pv_rows = [list(r) for r in PRIVACY_G08]
    assert any('撤回' in r[0] and '即时' in r[2] for r in pv_rows), '撤回同意须即时生效'
    with (out / 'SYNTH-08-隐私请求处理-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['请求类型', '例', '时限', '流程'])
        w.writerows(pv_rows)

    print(f'SYNTH-G08 生成完成 → {out}')
    print(f'不变量全过：实体 {len(ent_rows)}；税务 {len(tax_rows)} 条（与实体交叉）；证书 {len(cert_rows)}（有效期合规）；'
          f'条款 {len(clause_rows)}；数据 {len(data_rows)}（撤回即删/7 年留存）；准入 {len(access_rows)}（证据联动）；隐私 {len(pv_rows)}')



# ===================== G 续补六包（141 号；2026-10-02）=====================
# G01 三管理角色决策包 / G02 场景规则治理 / G05 独立站可售与账号健康 /
# G09 对象与指标契约 / G10 增量实验与归因 / G11 工具契约与运行恢复。全为合成数据。

G01_ROLE_FILES = [
    ('SYNTH-01-全局组合决策包-样例.csv', 'MGT-001 全局经营', [
        ('D-101 渠道组合重排', 'A:收缩B渠道预算/B:维持/C:加码C渠道', '约 3,000 USD', '现金占用 vs 增速', 'G07 现金视图；G10 实验', '否', '无'),
        ('D-102 库存组合', 'A:降安全库存/B:维持/C:提升备货', '约 12,000 USD 存货', '断货风险 vs 现金', 'G04 库龄；G09 口径', '否', '无'),
    ]),
    ('SYNTH-02-增长组合决策包-样例.csv', 'MGT-002 增长组合', [
        ('D-201 新品投放节奏', 'A:两新品/B:单品深挖/C:暂停新品', '约 8,000 USD', '学习速度 vs 现金', 'G10 实验设计', '否', '无'),
        ('D-202 付费渠道配比', 'A:4:6/B:6:4/C:维持', '约 5,000 USD/月', 'CAC vs 规模', 'G05 价格与优惠；G10 归因', '是——在既定授权内', '无'),
    ]),
    ('SYNTH-03-治理与能力组合决策包-样例.csv', 'MGT-003 治理与能力', [
        ('D-301 数据口径治理排期', 'A:先行GMV/B:全指标/C:暂缓', '约 1.5 人月', '一致性 vs 上线速度', 'G09 口径契约', '是——按既定规则', '无'),
        ('D-302 审计独立复核配置', 'A:内部轮换/B:外部引入', '约 2,000 USD/季', '独立性 vs 成本', 'G02 独立性规则', '否', '自涉：拟定人参与过被审事项'),
    ]),
]
G01_NOT_AUTO = [
    ('D-101 渠道组合重排', '跨域资源取舍与经营后果', 'MGT-001（会商增长与治理）', '依赖现金与实验证据齐备'),
    ('D-102 库存组合', '占用现金与断货风险权衡', 'MGT-001（会商供给）', '库龄与口径先行'),
    ('D-201 新品投放节奏', '学习速度与现金约束权衡', 'MGT-002', '实验设计先行'),
    ('D-302 审计独立复核配置', '自涉回避要求，涉人配置', 'MGT-003（自涉者回避后由替补决定）', 'G02 独立性规则'),
]
G01_CONFLICTS = [
    ('C-01 十月现金分配', '增长;治理', '增长：加投付费', '治理：先保合规支出', '现金上限 20,000 USD', '按 G07 现金视图排序，MGT-001 会商仲裁'),
    ('C-02 口径冻结时点', '治理;数据平台', '治理：尽早冻结', '平台：待修正样例齐后再冻', '冻结后变更需版本+历史留痕', 'G09 修正样例先行，两阶段切换'),
]
G01_STOPS = [
    ('S-01 B 渠道收缩', 'B 渠道 90 天增长目标', '连续两窗口 CAC 超上限', '停止加投；保留自然流量与履约', '投放对账与归因报告；库存清货计划', 'MGT-002（增长）'),
    ('S-02 表结构迁移试点', '支撑场景数据结构迁移', '变更影响面评估超授权范围', '移交数据平台治理议程', '影响面评估与只读回滚点', 'MGT-003（治理）'),
]


def pack_g01(out):
    out.mkdir(parents=True, exist_ok=True)
    total = 0
    for fname, role, rows in G01_ROLE_FILES:
        assert len(rows) >= 2, f'{role} 决策项不足'
        with (out / fname).open('w', encoding='utf-8-sig', newline='') as f:
            w = csv.writer(f)
            w.writerow(['决策项', '选项', '资源/月', '关键取舍', '依赖(引用)', '可自动?', '自涉标注'])
            w.writerows([list(r) for r in rows])
        total += len(rows)
    assert total >= 6, '三份决策包合计应 ≥6 项'
    not_auto_keys = {r[0] for rows in [r for _, _, r in G01_ROLE_FILES] for r in rows if r[5].startswith('否')}
    listed = {r[0] for r in G01_NOT_AUTO}
    assert not_auto_keys == listed, f'不可自动清单与决策包不一致：{not_auto_keys ^ listed}'
    assert any('自涉' in r[6] for _, _, rows in G01_ROLE_FILES for r in rows), '缺自涉标注'
    assert all('回避' in r[2] or '回避' in r[3] for r in G01_NOT_AUTO if '自涉' in r[1] or '自涉' in r[3]), '自涉项须写明回避'
    with (out / 'SYNTH-04-不可自动决策清单-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['决策项', '不可自动原因', '需谁决定', '依据'])
        w.writerows([list(r) for r in G01_NOT_AUTO])
    for r in G01_CONFLICTS:
        assert len(r[1].split(';')) >= 2, f'{r[0]} 须涉及 ≥2 域'
    with (out / 'SYNTH-05-跨域资源冲突-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['冲突', '涉及域', '诉求A', '诉求B', '约束', '仲裁路径'])
        w.writerows([list(r) for r in G01_CONFLICTS])
    for r in G01_STOPS:
        assert r[4].strip(), f'{r[0]} 缺交接物'
    with (out / 'SYNTH-06-停止与移交案例-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['案例', '原目标', '停止/移交原因', '处置', '交接物', '责任人'])
        w.writerows([list(r) for r in G01_STOPS])
    print(f'SYNTH-G01 生成完成 → {out}')
    print(f'不变量全过：决策 {total} 项（三份≥2/份；否项与清单一致）；冲突 {len(G01_CONFLICTS)}（各≥2 域）；停止/移交 {len(G01_STOPS)}（交接物齐）')


G02_SCENES = [
    ('经营场景', '与GMV/客户直接相关的端到端经营链', 'A 级（全量接收）', '无明确经营对象或指标'),
    ('控制场景', '资金、账号、合规控制类', 'A 级（全量接收）', '无控制对象与红线'),
    ('支撑场景', '数据、工具、知识支撑类', 'B 级（按需接收）', '不服务任何已识别场景'),
    ('实验场景', '带假设与护栏的增量探索', 'B 级（按需接收）', '无停止条件'),
]
G02_SAMPLING = [
    ('A 级场景', '全量排队＋按周抽样复核', '≥8/周', '每周', '一致性<90% 触发全量复核'),
    ('B 级场景', '分层抽样', '≥5/月', '每月', '关键项错 1 处即全量'),
    ('口径与契约', '按变更事件触发', '每次变更', '事件驱动', '历史修正未留痕即不通过'),
    ('资金与账号动作', '高风险全查', '100%', '每次', '任一缺证据即待补证'),
]
G02_INDEPENDENCE = [
    ('审计抽样', '抽样与判定不得同人', '同人兼任', '强制轮换或外部复核'),
    ('口径裁定', '裁定人不得参与被审实现', '自涉', '回避后由替补裁定'),
    ('方法生效', '生效决定与制作分离', '制作人自批', '按 C-055 由有权责任方决定'),
]
G02_RESULTS = [
    ('AUD-2609-01', 'A 渠道结算场景', '通过', '抽样 8/8 一致；依据 G07 对账', '—'),
    ('AUD-2609-02', 'B 级支撑场景（迁移）', '不通过', '变更未附影响面评估', '整改后重审'),
    ('AUD-2609-03', '促销叠加场景', '待补证', '缺优惠叠加边界样例（缺证据）', '补样例后复核'),
]
G02_METHOD_SCOPE = [
    ('对账方法 v1.2', '渠道结算对账', '双渠道账单＋事件账齐备', '前提齐备即范围生效', '越界（多币种重估）退回'),
    ('退赔判定 v1.0', '母婴售后判定', '政策矩阵与订单事实齐', '范围生效（DE/UK/US）', '政策缺口列待确认'),
]


def pack_g02(out):
    out.mkdir(parents=True, exist_ok=True)
    assert len({r[0] for r in G02_SCENES}) == 4, '四类场景齐'
    with (out / 'SYNTH-01-场景分类与接收标准-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['场景类别', '判定要件', '接收级', '不接收情形'])
        w.writerows([list(r) for r in G02_SCENES])
    with (out / 'SYNTH-02-审计抽样规则-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['对象', '抽样口径', '样本量', '频次', '阈值/触发'])
        w.writerows([list(r) for r in G02_SAMPLING])
    assert sum(1 for r in G02_INDEPENDENCE if '不得' in r[1]) >= 2, '独立性规则 ≥2 条硬约束'
    with (out / 'SYNTH-03-独立性规则-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['事项', '独立性要求', '冲突情形', '处理'])
        w.writerows([list(r) for r in G02_INDEPENDENCE])
    concl = {r[2] for r in G02_RESULTS}
    assert concl == {'通过', '不通过', '待补证'}, f'审计结论三态不齐：{concl}'
    for r in G02_RESULTS:
        if r[2] == '待补证':
            assert '缺' in r[3], '待补证须明示缺证据'
    with (out / 'SYNTH-04-审计结论样例-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['记录号', '对象', '结论', '依据', '后续'])
        w.writerows([list(r) for r in G02_RESULTS])
    with (out / 'SYNTH-05-方法范围化生效样例-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['方法版本', '范围', '前提条件', '生效判定', '越界处理'])
        w.writerows([list(r) for r in G02_METHOD_SCOPE])
    print(f'SYNTH-G02 生成完成 → {out}')
    print(f'不变量全过：场景 4 类；抽样 {len(G02_SAMPLING)}；独立性 {len(G02_INDEPENDENCE)}（含硬约束）；'
          f'审计三态齐 {len(G02_RESULTS)}；方法范围化 {len(G02_METHOD_SCOPE)}')


G05_PLATFORMS = [
    ('MOCK-Store（独立站）', 'DE', 'EUR', 'MOCK-Trade GmbH', 'IOSS 低值链路见 G08'),
    ('MOCK-Store（独立站）', 'UK', 'GBP', 'MOCK-Store Ltd', 'MTD 申报'),
    ('MOCK-Mall', 'US', 'USD', 'MOCK-Retail LLC', '按州销售税'),
]
G05_FACTS = [
    ('HM-PUMP-100', '吸力档位', '5 档', '工厂规格书 v2', '已核验'),
    ('HM-PUMP-100', '材质（接触件）', 'PP+PPSU', '检测报告 MOCK-REACH-2408', '已核验'),
    ('HM-PUMP-100', '噪声', '≤45 dB(A)', '出厂检测 TR-2608-03', '已核验'),
    ('RL-BELL-01', '适用年龄', '3 月+', '待工厂确认', '待核'),
]
G05_PROMO = [
    ('券', '满 59 减 5', '第 1 顺位', '与折扣互斥（二选一）'),
    ('折扣', '9 折', '第 2 顺位', '叠加封顶：合计优惠 ≤30%'),
    ('运费', '满 79 免运费', '第 3 顺位', '优惠后金额判定（非原价）'),
]
G05_CASES = [
    ('AV-01 可售核验', '新 SKU 上架前事实核验', '材质/年龄缺 1 项', '补齐后放行；不得先上后补', 'G05 事实包'),
    ('AV-02 支付失败', 'DE 站支付失败回落', '3DS 超时率升高', '切换通道并观察；不重复扣款', '支付日志'),
    ('AV-03 退款异常', '部分退款到账慢', '卡组织入账 T+5', '解释口径；给查询链接', '退款记录'),
    ('AV-04 库存不同步', '独立站与仓库存差', '缓存延迟约 15 分钟', '下单前二次校验', '库存回执'),
]
G05_ACCOUNT = [
    ('P-2609-01', 'listing 图未标 warning', '已补警示文案', '整改截图与新版详情', '已完成'),
    ('P-2609-02', '侵权投诉（已申诉）', '提交授权链证据', '品牌授权与采购凭证', '进行中'),
]


def pack_g05(out):
    out.mkdir(parents=True, exist_ok=True)
    with (out / 'SYNTH-01-平台与市场清单-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['平台', '站点', '货币', '运营主体', '备注'])
        w.writerows([list(r) for r in G05_PLATFORMS])
    assert any(r[4] == '待核' for r in G05_FACTS), '事实包须含待核项（防"先上后补"）'
    with (out / 'SYNTH-02-商品事实包-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['SKU', '字段', '值', '来源', '核验状态'])
        w.writerows([list(r) for r in G05_FACTS])
    assert any('互斥' in r[3] for r in G05_PROMO) and any('封顶' in r[3] for r in G05_PROMO), '优惠规则须含互斥与封顶'
    with (out / 'SYNTH-03-费用与优惠叠加规则-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['类型', '规则', '叠加顺序', '边界'])
        w.writerows([list(r) for r in G05_PROMO])
    labels = [r[1] for r in G05_CASES]
    assert any('支付失败' in x for x in labels) and any('退款' in x for x in labels), '案例须含支付失败与退款'
    with (out / 'SYNTH-04-可售核验与支付失败案例-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['案例', '情形', '现象', '处置', '依据'])
        w.writerows([list(r) for r in G05_CASES])
    for r in G05_ACCOUNT:
        assert r[3].strip() and r[4] in ('已完成', '进行中'), f'{r[0]} 纠正证据/状态不合规'
    with (out / 'SYNTH-05-账号健康与申诉-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['通知', '原因', '纠正动作', '证据', '状态'])
        w.writerows([list(r) for r in G05_ACCOUNT])
    print(f'SYNTH-G05 生成完成 → {out}')
    print(f'不变量全过：平台 {len(G05_PLATFORMS)}；事实 {len(G05_FACTS)}（含待核）；优惠 {len(G05_PROMO)}（互斥+封顶）；'
          f'案例 {len(G05_CASES)}（支付/退款齐）；账号 {len(G05_ACCOUNT)}（证据联动）')

G09_OBJECTS = [
    ('主体', 'MOCK-Trade GmbH', '拥有 账号×2／店铺×1', '税务实体见 G08'),
    ('账号', 'ACC-M-001（MOCK-Mall）', '归属 主体；绑定 店铺×1', ''),
    ('店铺', 'SHOP-DE-01', '归属 账号；上架 商品', ''),
    ('商品', 'ITEM-PUMP-100', '对应 SPU×1', ''),
    ('SPU', 'SPU-PUMP-100', '聚合 SKU×2', '颜色差异'),
    ('SKU', 'SKU-PUMP-100-W', '最小库存/销售单元', ''),
]
G09_METRICS = [
    ('GMV', '订单含税成交额（退款/取消前）', 'MGT-001（经营）', '经营看板', 'v1'),
    ('净收入', 'GMV−退款−平台费＋冲回', '财务（合账）', '结算与报表', 'v1'),
    ('利润', '净收入−商品成本−履约−投放', '财务', '经营复盘', 'v1'),
    ('净贡献', '利润−固定分摊', '财务', '组合决策', 'v1（试）'),
]
G09_FIXES = [
    ('F-2609-01 GMV 口径', '含税 GMV', '去税净额', '经营主口径＝含税（报表另列净额）', '历史 8 月报表按同口径重述', '2026-10-01 起'),
    ('F-2609-02 SKU 归并', '颜色未拆分', '按颜色拆分', '拆分为 2 SKU，历史按旧键映射', '映射表留痕', '2026-10-01 起'),
]
G09_SLA = [
    ('空值率', '关键字段 ≤0.5%', '每日', '超阈告警并回溯来源'),
    ('零填充嫌疑', '0 值连续 ≥3 列为排查对象', '每日', '人工核验后入更正'),
    ('口径漂移', '同指标多版本并存即预警', '变更触发', '按 G09 修正样例留痕'),
]


def pack_g09(out):
    out.mkdir(parents=True, exist_ok=True)
    kinds = {r[0] for r in G09_OBJECTS}
    assert kinds == {'主体', '账号', '店铺', '商品', 'SPU', 'SKU'}, f'对象字典缺类：{kinds}'
    with (out / 'SYNTH-01-对象字典-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['对象', '示例', '关系', '备注'])
        w.writerows([list(r) for r in G09_OBJECTS])
    assert len(G09_METRICS) >= 3 and all(r[4].startswith('v1') for r in G09_METRICS), '指标口径须含版本'
    with (out / 'SYNTH-02-指标口径与所有者-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['指标', '口径定义', '所有者', '用途', '版本'])
        w.writerows([list(r) for r in G09_METRICS])
    assert any('重述' in r[4] or '留痕' in r[4] for r in G09_FIXES), '修正须含历史处置'
    with (out / 'SYNTH-03-冲突与历史修正样例-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['冲突', '口径A', '口径B', '裁定', '更正与历史', '生效'])
        w.writerows([list(r) for r in G09_FIXES])
    with (out / 'SYNTH-04-数据质量SLA-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['检查项', '阈值', '频次', '处置'])
        w.writerows([list(r) for r in G09_SLA])
    print(f'SYNTH-G09 生成完成 → {out}')
    print(f'不变量全过：对象 6 类齐；指标 {len(G09_METRICS)}（含版本）；修正 {len(G09_FIXES)}（历史留痕）；SLA {len(G09_SLA)}')


G10_EXPERIMENTS = [
    ('E-2609-01', '主图改版', '提升详情转化', '14 天/两臂各 50%（分层随机）', '随机', '48,200', '3.1%→3.4%', '0', '无', '增量疑似 +0.3pp（置信区间含 0）'),
    ('E-2609-02', '优惠券门槛', '提客单', '21 天/门槛 59 vs 49', '随机', '31,500', '转化 -0.4pp；客单 +6.2%', '券成本 1,240 USD', '毛利护栏', '净贡献 +3.1%（护栏内）'),
    ('E-2609-03', '站外达人跳转', '拉新', '30 天/自然对照', '非随机', '19,400', '跳转转化 1.8%', '8,000 USD', 'CAC ≤ 25', '不作增量强结论（混杂）'),
    ('E-2609-04', '仓库分流', '降履约费', '14 天/两仓对照', '随机', '12,300 单', '履约费 -0.42 USD/单', '—', '时效不劣化', '采用（范围：US 西岸仓）'),
    ('E-2609-05', '邮件频次', '提复购', '21 天/降频对照', '随机', '4,100', '开信率方差大', '—', '—', '样本不足，无效'),
]
G10_INVALID = [
    ('E-2609-01', '置信区间含 0', '两臂差 -0.1~0.7pp', '不作增量成立结论', '延长观察或复跑'),
    ('E-2609-03', '非随机＋同期活动混杂', '对照基线不平行', '仅作方向参考', '需随机化或差分设计'),
    ('E-2609-05', '样本不足', '开信率方差大', '无效；不进采用通道', '扩样本或降频次试验'),
]
G10_ADOPT = [
    ('E-2609-02', '采用（范围化）', 'DE 站新客券门槛 49', '净贡献 +3.1% 且护栏内', '毛利护栏持续监控'),
    ('E-2609-04', '采用', 'US 西岸仓分流', '履约费降且时效不劣', '时效 SLA 监控'),
    ('E-2609-01', '继续观察', '—', '增量不确定', '复跑或延长窗口'),
]
G10_LIMITS = [
    ('达人投放', '平台口径归因偏满', '增量 ROI 类结论', '自然流量与活动叠加'),
    ('站内推荐位', '位置偏差', 'CTR 对比结论', '库存与价格差异'),
    ('季节性窗口', '同比混季节', '同比提升类结论', '宏观与投放同步变化'),
]


def pack_g10(out):
    out.mkdir(parents=True, exist_ok=True)
    mech = {r[4] for r in G10_EXPERIMENTS}
    assert '随机' in mech and '非随机' in mech, '机制须含随机与非随机'
    ids = {r[0] for r in G10_EXPERIMENTS}
    assert {r[0] for r in G10_INVALID} <= ids and {r[0] for r in G10_ADOPT} <= ids, '反例/采用记录须对应实验'
    with (out / 'SYNTH-01-实验设计与结果-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['实验号', '名称', '目标', '样本', '机制', '曝光量', '转化/结果值', '成本', '护栏', '结果'])
        w.writerows([list(r) for r in G10_EXPERIMENTS])
    for r in G10_INVALID:
        assert '不作' in r[3] or '无效' in r[3] or '仅作' in r[3], f'{r[0]} 无效结论表述不合规'
    with (out / 'SYNTH-02-无效与反例-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['实验号', '无效原因', '证据', '结论', '教训'])
        w.writerows([list(r) for r in G10_INVALID])
    assert all(r[2].strip() for r in G10_ADOPT), '采用决定须写明范围'
    with (out / 'SYNTH-03-采用决定样例-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['实验号', '决定', '范围', '依据', '前提/护栏'])
        w.writerows([list(r) for r in G10_ADOPT])
    with (out / 'SYNTH-04-归因局限说明-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['场景', '已知局限', '受影响的结论类型', '替代解释'])
        w.writerows([list(r) for r in G10_LIMITS])
    print(f'SYNTH-G10 生成完成 → {out}')
    print(f'不变量全过：实验 {len(G10_EXPERIMENTS)}（随机/非随机齐）；反例 {len(G10_INVALID)}（结论合规）；'
          f'采用 {len(G10_ADOPT)}（范围齐）；归因局限 {len(G10_LIMITS)}')


G11_CONTRACTS = [
    ('T-101 库存查询', '读', '库存/批次', '—（只读）', '查询回执（快照时间戳）', '无需审批'),
    ('T-102 订单查询', '读', '订单/退款', '—（只读）', '查询回执', '无需审批'),
    ('T-201 结算导出', '读', '结算账单', '—（只读）', '导出清单＋sha256', '无需审批（敏感字段脱敏）'),
    ('T-301 改价', '写', 'listing 价格', 'plan-id（幂等）', '变更回执（前后价）', '需 MGT-002 授权'),
    ('T-302 退款处置', '写', '订单退款', 'case-id', '退款回执（金额/渠道）', '按 G06 判定＋主管复核'),
    ('T-401 账号申诉提交', '写', '平台申诉', 'dispute-id', '提交回执（编号/状态）', '需合规会签'),
]
G11_IDEMPOTENCY = [
    ('重复提交', '相同幂等键仅生效一次', '返回首次回执', '键＋时间戳留痕'),
    ('取消中', '取消为请求语义', '未完成前状态＝取消中', '状态流转留痕'),
    ('未知结果', '超时未达视为未知', '先只读核验再决定重试', '未知标记不自动重试'),
    ('重试', '仅同幂等键允许重试', '重试前后同键', '重试计数留痕'),
]
G11_ACCESS = [
    ('MGT-002', '改价（T-301）', '带额度授权', '在额定价格带内', '季审撤销'),
    ('客服主管', '退款（T-302）', '判定＋复核', '按 G06 政策', '月度重签'),
    ('合规', '申诉（T-401）', '会签授权', '涉平台监管事项', '事件触发回收'),
    ('数据平台', '结算导出（T-201）', '只读授权', '脱敏导出', '季审'),
]
G11_RECOVERY = [
    ('R-01 批量任务中断', '导出到一半会话断开', '按清单校验后断点续跑', '分片 hash 对齐后去重', '完成；无重复数据'),
    ('R-02 改价部分生效', '网关超时未知', '只读核验实际价格→按需同幂等键重试', '前后价回执比对', '收敛；仅一次生效'),
    ('R-03 会话过期', '长任务执行中凭据过期', '失败即停，重新取号重跑（新 plan-id）', '旧键作废留痕', '重跑完成；旧键无副作用'),
]


def pack_g11(out):
    out.mkdir(parents=True, exist_ok=True)
    reads = [r for r in G11_CONTRACTS if r[1] == '读']
    writes = [r for r in G11_CONTRACTS if r[1] == '写']
    assert len(reads) >= 3 and all('无需审批' in r[5] for r in reads), '读类契约须 ≥3 且无需审批'
    assert writes and all('无需审批' not in r[5] for r in writes), '写类契约须有审批要求'
    with (out / 'SYNTH-01-工具契约清单-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['工具/动作', '读/写', '对象', '幂等键', '期望回执', '审批要求'])
        w.writerows([list(r) for r in G11_CONTRACTS])
    assert any('未知结果' in r[0] and '只读核验' in r[2] for r in G11_IDEMPOTENCY), '未知结果语义须含只读核验'
    with (out / 'SYNTH-02-幂等取消与未知结果语义-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['情形', '语义', '处置', '留痕'])
        w.writerows([list(r) for r in G11_IDEMPOTENCY])
    with (out / 'SYNTH-03-访问授权规则-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['角色', '工具/数据', '授权类型', '前提', '期限/撤销'])
        w.writerows([list(r) for r in G11_ACCESS])
    assert all(r[3].strip() for r in G11_RECOVERY), '恢复案例须含幂等核验'
    with (out / 'SYNTH-04-运行恢复案例-样例.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['事件', '现象', '恢复步骤', '幂等核验', '结果'])
        w.writerows([list(r) for r in G11_RECOVERY])
    print(f'SYNTH-G11 生成完成 → {out}')
    print(f'不变量全过：契约 {len(G11_CONTRACTS)}（读 {len(reads)} 免审批/写 {len(writes)} 有审批）；'
          f'幂等语义 {len(G11_IDEMPOTENCY)}（含未知结果）；授权 {len(G11_ACCESS)}；恢复 {len(G11_RECOVERY)}（幂等核验齐）')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pack', choices=['g07', 'g04', 'g03', 'g06', 'g08', 'g01', 'g02', 'g05', 'g09', 'g10', 'g11'], default='g07')
    parser.add_argument('--out', default=None)
    args = parser.parse_args()
    default_out = {'g07': 'skill-lifecycle/trial-home/intake/SYNTH-G07',
                   'g04': 'skill-lifecycle/trial-home/intake/SYNTH-G04',
                   'g03': 'skill-lifecycle/trial-home/intake/SYNTH-G03',
                   'g06': 'skill-lifecycle/trial-home/intake/SYNTH-G06',
                   'g08': 'skill-lifecycle/trial-home/intake/SYNTH-G08',
                   'g01': 'skill-lifecycle/trial-home/intake/SYNTH-G01',
                   'g02': 'skill-lifecycle/trial-home/intake/SYNTH-G02',
                   'g05': 'skill-lifecycle/trial-home/intake/SYNTH-G05',
                   'g09': 'skill-lifecycle/trial-home/intake/SYNTH-G09',
                   'g10': 'skill-lifecycle/trial-home/intake/SYNTH-G10',
                   'g11': 'skill-lifecycle/trial-home/intake/SYNTH-G11'}[args.pack]
    out = Path(args.out or default_out).resolve()
    {'g04': pack_g04, 'g03': pack_g03, 'g06': pack_g06, 'g08': pack_g08,
     'g01': pack_g01, 'g02': pack_g02, 'g05': pack_g05, 'g09': pack_g09,
     'g10': pack_g10, 'g11': pack_g11}.get(args.pack, pack_g07)(out)


if __name__ == '__main__':
    main()
