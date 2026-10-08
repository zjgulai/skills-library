#!/usr/bin/env python3
"""
库龄处置与退货闭合夹具测试（标准库 unittest；纯数据断言，零网络、零密钥）。

覆盖：处置规则复算（按规则文本逐 SKU 验证 aging.csv 的建议列）、退货闭合
（Σ退货 = 复售 + 报废）、状态机流转合法性（returns 终态路径在 states 允许流转内）、
终态无出边（DISPOSED）。

运行（技能根目录）：
    python3 -B -m unittest discover -s tests -p "test_aging_disposal.py"

数据：tests/fixtures/aging-disposal/（合成练习数据，见该目录 README）。
"""
import csv
import unittest
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "aging-disposal"


def load(name):
    with open(FIXTURES / name, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def expected_disposition(age_days, weekly_avg, shelf_life):
    """按夹具规则文本复算期望处置（与 SYNTH-G04 库龄规则一致）。"""
    if age_days > 180 and weekly_avg < 15:
        return "清货"
    if 90 <= age_days <= 180 and weekly_avg < 15:
        return "监控"
    if shelf_life.startswith("保质期至"):  # 剩余期限内的临期监控标注
        return "正常销售 + 临期预警" if "临期" in shelf_life else "正常销售"
    return "正常销售"


class AgingDisposalTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.aging = load("aging.csv")
        cls.states = load("states.csv")
        cls.returns = load("returns.csv")

    # —— 1. 处置规则复算：csv 的建议列必须与规则文本一致 ——
    def test_disposition_matches_rules(self):
        for row in self.aging:
            expected = expected_disposition(
                int(row["库龄天数"]), int(row["近90天周均"]), row["保质期状态"])
            self.assertTrue(
                row["建议处置"].startswith(expected.split("（")[0]),
                msg=f"{row['SKU']}：建议处置「{row['建议处置']}」与规则复算「{expected}」不一致",
            )

    def test_known_sku_decisions(self):
        decisions = {r["SKU"]: r["建议处置"] for r in self.aging}
        self.assertIn("清货", decisions["BB-RATTLE-TOY"])       # 189 天，周均 12 < 15
        self.assertIn("监控", decisions["BB-BIB-SIL"])          # 97 天，周均 8 < 15
        self.assertIn("临期预警", decisions["BB-CREAM-50"])     # 92 天，周均 40，有保质期
        self.assertEqual(decisions["BB-WIPES-80"], "正常销售")   # 13 天，周转健康
        self.assertEqual(decisions["BB-BOTTLE-240"], "正常销售")  # 26 天，周转健康

    # —— 2. 退货闭合：6 = 3 + 3 ——
    def test_return_closure(self):
        total = sum(int(r["数量"]) for r in self.returns)
        resell = sum(int(r["数量"]) for r in self.returns if "复售" in r["处置"])
        scrap = sum(int(r["数量"]) for r in self.returns if r["处置"] == "报废")
        self.assertEqual(total, 6)
        self.assertEqual(resell, 3, "RMA-3001 未开封 3 件应复售")
        self.assertEqual(scrap, 3, "已开封 1 + 封口破损 2 应报废")
        self.assertEqual(total, resell + scrap, "退货必须闭合：总计 = 复售 + 报废")

    # —— 3. 卫生红线：未过检不得复售 ——
    def test_hygiene_gate(self):
        for row in self.returns:
            if row["卫生检查"] != "通过":
                self.assertNotIn("复售", row["处置"],
                                 msg=f"{row['RMA单号']}：未通过卫生检查不得复售")
                self.assertEqual(row["终态"], "DISPOSED")
            else:
                self.assertIn("RESELL_READY", row["终态"])

    # —— 4. 状态机：流转合法性与终态 ——
    def test_state_transitions_valid(self):
        allowed = {r["状态码"]: r["允许流转"] for r in self.states}
        # QUARANTINE → RESELL_READY / DISPOSED 必须都在允许流转内
        self.assertIn("RESELL_READY", allowed["QUARANTINE"])
        self.assertIn("DISPOSED", allowed["QUARANTINE"])
        # RESELL_READY → AVAILABLE
        self.assertIn("AVAILABLE", allowed["RESELL_READY"])
        # QC_HOLD → DAMAGED_CLAIM
        self.assertIn("DAMAGED_CLAIM", allowed["QC_HOLD"])

    def test_disposed_is_terminal(self):
        allowed = {r["状态码"]: r["允许流转"] for r in self.states}
        self.assertEqual(allowed["DISPOSED"], "（终态）",
                         "DISPOSED 必须是终态（无出边）")

    def test_quarantine_not_sellable(self):
        by_code = {r["状态码"]: r for r in self.states}
        self.assertEqual(by_code["QUARANTINE"]["可售性"], "否",
                         "退货隔离期间不得计为可售")
        self.assertEqual(by_code["RESELL_READY"]["可售性"], "是")


if __name__ == "__main__":
    unittest.main()
