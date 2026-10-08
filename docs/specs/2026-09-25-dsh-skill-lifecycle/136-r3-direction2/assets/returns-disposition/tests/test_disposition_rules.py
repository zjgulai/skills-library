#!/usr/bin/env python3
"""
退货处置规则断言（标准库 unittest；纯数据断言，零网络、零密钥）。

覆盖：判定规则复算（红线/再售条件）、退货闭合核验（Σ=复售+报废）、
状态机流转合法性与终态、隔离期不可售。

运行（技能根目录）：
    python3 -B -m unittest discover -s tests -p "test_disposition_rules.py"

数据：内嵌练习数据（与 references/examples/worked-example.md 同源）。
"""
import unittest

# —— 练习数据（与算例同源）——
RETURNS = [
    {"rma": "RMA-3001", "qty": 3, "state": "未开封、封签完整", "traceable": True,
     "shelf_months": 12, "check": "通过", "disposition": "复售", "terminal": "RESELL_READY→AVAILABLE"},
    {"rma": "RMA-3002", "qty": 1, "state": "已开封", "traceable": True,
     "shelf_months": 12, "check": "不通过", "disposition": "报废", "terminal": "DISPOSED"},
    {"rma": "RMA-3003", "qty": 2, "state": "封口破损", "traceable": True,
     "shelf_months": 12, "check": "不通过", "disposition": "报废", "terminal": "DISPOSED"},
]

STATES = {
    "IN_TRANSIT": {"sellable": False, "to": ["RECEIVED_PENDING_QC"]},
    "RECEIVED_PENDING_QC": {"sellable": False, "to": ["AVAILABLE", "QC_HOLD"]},
    "AVAILABLE": {"sellable": True, "to": []},
    "QC_HOLD": {"sellable": False, "to": ["DAMAGED_CLAIM", "AVAILABLE"]},
    "DAMAGED_CLAIM": {"sellable": False, "to": ["DISPOSED"]},
    "QUARANTINE": {"sellable": False, "to": ["RESELL_READY", "DISPOSED"]},
    "RESELL_READY": {"sellable": True, "to": ["AVAILABLE"]},
    "DISPOSED": {"sellable": False, "to": []},  # 终态
    "OUTSTANDING": {"sellable": False, "to": []},
}

RED_LINES = ["已开封", "封口破损", "包装破损", "污染", "异味", "受潮", "批次不可追溯"]


def rule_disposition(state, traceable, shelf_months, checked):
    """按红线与再售条件复算期望处置。"""
    if not checked:
        return "隔离（待检查）"
    if any(r in state for r in RED_LINES) or not traceable or shelf_months <= 3:
        return "报废"
    if shelf_months > 6:
        return "复售"
    return "报废"


class DispositionRulesTest(unittest.TestCase):
    # —— 1. 判定规则复算 ——
    def test_rules_match_worked_example(self):
        for r in RETURNS:
            expected = rule_disposition(r["state"], r["traceable"], r["shelf_months"], True)
            self.assertEqual(expected, r["disposition"], f"{r['rma']} 判定与规则不符")

    def test_redline_opened_or_broken_is_scrap(self):
        self.assertEqual(rule_disposition("已开封", True, 12, True), "报废")
        self.assertEqual(rule_disposition("封口破损", True, 12, True), "报废")

    def test_untraceable_batch_is_scrap(self):
        self.assertEqual(rule_disposition("未开封、封签完整", False, 12, True), "报废",
                         "批次不可追溯应命中红线")

    def test_unchecked_stays_quarantine(self):
        self.assertEqual(rule_disposition("未开封、封签完整", True, 12, False), "隔离（待检查）")

    # —— 2. 闭合核验 6 = 3 + 3 ——
    def test_return_closure(self):
        total = sum(r["qty"] for r in RETURNS)
        resell = sum(r["qty"] for r in RETURNS if r["disposition"] == "复售")
        scrap = sum(r["qty"] for r in RETURNS if r["disposition"] == "报废")
        self.assertEqual(total, 6)
        self.assertEqual((resell, scrap), (3, 3))
        self.assertEqual(total, resell + scrap, "Σ退货 = 复售 + 报废")

    # —— 3. 状态机 ——
    def test_quarantine_paths_allowed(self):
        self.assertIn("RESELL_READY", STATES["QUARANTINE"]["to"])
        self.assertIn("DISPOSED", STATES["QUARANTINE"]["to"])
        self.assertNotIn("AVAILABLE", STATES["QUARANTINE"]["to"],
                         "QUARANTINE 不得直连 AVAILABLE（必经判定）")

    def test_disposed_is_terminal(self):
        self.assertEqual(STATES["DISPOSED"]["to"], [], "DISPOSED 必须为终态")

    def test_quarantine_not_sellable(self):
        self.assertFalse(STATES["QUARANTINE"]["sellable"])
        self.assertTrue(STATES["RESELL_READY"]["sellable"])
        self.assertFalse(STATES["DAMAGED_CLAIM"]["sellable"])

    # —— 4. 终态路径一致性 ——
    def test_terminal_states_match_disposition(self):
        for r in RETURNS:
            if r["disposition"] == "报废":
                self.assertEqual(r["terminal"], "DISPOSED")
            else:
                self.assertIn("RESELL_READY", r["terminal"])


if __name__ == "__main__":
    unittest.main()
