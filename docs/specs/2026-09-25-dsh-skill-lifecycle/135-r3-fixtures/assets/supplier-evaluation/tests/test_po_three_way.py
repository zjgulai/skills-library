#!/usr/bin/env python3
"""
PO 三方对账夹具测试（标准库 unittest；纯数据断言，零网络、零密钥）。

覆盖：PO 金额复算、收货闭合（Σ实收+未交=订购）、破损与短交差异归因
（差异=数量×单价）、发票处置状态（索赔中 / 贷记已结）与跨 PO 不串行。

运行（技能根目录）：
    python3 -B -m unittest discover -s tests -p "test_po_three_way.py"

数据：tests/fixtures/po-three-way/（合成练习数据，见该目录 README）。
"""
import csv
import unittest
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "po-three-way"


def load(name):
    with open(FIXTURES / name, encoding="utf-8") as f:
        return list(csv.DictReader(f))


class PoThreeWayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.po = load("po.csv")
        cls.receipts = load("receipts.csv")
        cls.invoices = load("invoices.csv")

    # —— 1. PO 金额复算 ——
    def test_po_line_amount_equals_qty_times_price(self):
        for row in self.po:
            self.assertAlmostEqual(
                float(row["金额USD"]),
                round(int(row["订购数量"]) * float(row["单价USD"]), 2),
                places=2,
                msg=f"{row['采购单']}/{row['SKU']} 行金额不等于 数量×单价",
            )

    def test_po_totals(self):
        totals = {}
        for row in self.po:
            totals[row["采购单"]] = totals.get(row["采购单"], 0.0) + float(row["金额USD"])
        self.assertAlmostEqual(totals["PO-1101"], 4300.00, places=2)
        self.assertAlmostEqual(totals["PO-1102"], 3438.00, places=2)

    # —— 2. 收货闭合：Σ实收 + 未交 = 订购 ——
    def test_receipt_closure_per_po_sku(self):
        received = {}
        outstanding = {}
        ordered = {}
        for row in self.receipts:
            key = (row["采购单"], row["SKU"])
            received[key] = received.get(key, 0) + int(row["实收数量"])
            outstanding[key] = int(row["未交数量"])  # 同 key 最后一行即最新未交
            ordered[key] = int(row["订购数量"])
        for key, qty in ordered.items():
            self.assertEqual(
                received[key] + outstanding[key],
                qty,
                msg=f"{key} 不闭合：实收 {received[key]} + 未交 {outstanding[key]} != 订购 {qty}",
            )

    def test_partial_delivery_then_replenished(self):
        rows = [r for r in self.receipts
                if r["采购单"] == "PO-1101" and r["SKU"] == "BB-RATTLE-TOY"]
        self.assertEqual(len(rows), 2, "PO-1101 摇铃应有两次收货（部分 + 补货）")
        self.assertEqual(int(rows[0]["未交数量"]), 200, "首批未交应为 200")
        self.assertEqual(int(rows[1]["实收数量"]), 200, "补货应收 200")
        self.assertEqual(int(rows[1]["未交数量"]), 0, "补货后未交应清零")
        self.assertEqual(int(rows[1]["破损件数"]), 10, "补货中 10 件外箱破损扣留")

    # —— 3. 发票差异归因（差异 = 数量 × 单价）——
    def test_invoice_variance_attribution(self):
        by_inv = {r["发票号"]: r for r in self.invoices}
        a = by_inv["INV-A-2601"]
        self.assertAlmostEqual(
            float(a["差异USD"]), round(10 * 1.45, 2), places=2,
            msg="INV-A 差异应等于 破损 10 件 × 1.45",
        )
        self.assertAlmostEqual(
            float(a["按订单金额USD"]) - float(a["按实收价值USD"]),
            float(a["差异USD"]), places=2,
        )
        b = by_inv["INV-B-2602"]
        self.assertAlmostEqual(
            float(b["差异USD"]), round(20 * 0.62, 2), places=2,
            msg="INV-B 差异应等于 短交 20 件 × 0.62",
        )

    # —— 4. 处置与状态 ——
    def test_disposition_states(self):
        by_inv = {r["发票号"]: r for r in self.invoices}
        self.assertIn("索赔", by_inv["INV-A-2601"]["处置"])
        self.assertEqual(by_inv["INV-A-2601"]["状态"], "索赔中")
        self.assertIn("CN-B-2601", by_inv["INV-B-2602"]["处置"])
        self.assertEqual(by_inv["INV-B-2602"]["状态"], "已结")

    def test_no_cross_po_leakage(self):
        # 湿巾短交行只属于 PO-1102；PO-1101 各行不得出现该收货单
        for row in self.receipts:
            if row["采购单"] == "PO-1101":
                self.assertNotEqual(row["SKU"], "BB-WIPES-80",
                                    "BB-WIPES-80 不应出现在 PO-1101")


if __name__ == "__main__":
    unittest.main()
