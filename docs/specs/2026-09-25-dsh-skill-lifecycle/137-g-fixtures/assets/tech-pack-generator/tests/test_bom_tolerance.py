#!/usr/bin/env python3
"""
工艺包 BOM/公差/变更/验证链夹具测试（标准库 unittest；纯数据断言，零网络、零密钥）。

覆盖：BOM 成本复算（逐行舍入口径）、公差方向、ECO 生效批次、DVP&R FAIL 链路闭合。
运行（技能根目录）：
    python3 -B -m unittest discover -s tests -p "test_bom_tolerance.py"

数据：tests/fixtures/bom-tolerance-hm-pump.json（对齐 SYNTH-G03 合成包数字）。
"""
import json
import unittest
from pathlib import Path

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "bom-tolerance-hm-pump.json"


def load():
    with open(FIXTURE, encoding="utf-8") as f:
        return json.load(f)


class BomToleranceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d = load()

    # —— 1. BOM 成本复算（逐行两位舍入后累加口径）——
    def test_material_cost_line_round_then_sum(self):
        total = 0.0
        for line in self.d["bom"]:
            line_cost = round(line["qty"] * line["unit_price"] * (1 + line["loss_rate"]) + 1e-9, 2)
            total += line_cost
        total = round(total + 1e-9, 2)
        self.assertEqual(total, self.d["expected_material_cost"],
                         "材料成本应按逐行舍入后累加（31.63），不得用汇总一次舍入")
        self.assertEqual(total, 31.63)

    # —— 2. 公差方向 ——
    def test_tolerance_direction(self):
        for s in self.d["specs"]:
            self.assertLessEqual(s["tol_minus"], 0, f"{s['id']} 下差应为 ≤0")
            self.assertGreaterEqual(s["tol_plus"], 0, f"{s['id']} 上差应为 ≥0")

    # —— 3. KC-06 与 ECO-2604 一致（8D 整改后新增）——
    def test_kc06_tied_to_eco2604(self):
        kc06 = [s for s in self.d["specs"] if s["id"] == "KC-06"]
        self.assertEqual(len(kc06), 1, "应恰有 KC-06")
        self.assertEqual(kc06[0]["nominal"], 2.6)
        ecos = {e["eco"]: e for e in self.d["ecos"]}
        self.assertIn("2.6", ecos["ECO-2604"]["change"], "ECO-2604 应记录壁厚 2.6 整改")
        self.assertEqual(ecos["ECO-2604"]["effective_batch"], "PB-2610 起")

    # —— 4. DVP&R FAIL 链路闭合 ——
    def test_dvpr_fail_chain_closed(self):
        c = self.d["dvpr_chain"]
        self.assertEqual(c["fail_item"], "整机跌落")
        self.assertEqual(c["closure_result"].startswith("12/12 通过"), True)
        # 链路五段齐（报告→缺陷→ECO→复测）
        for k in ("fail_report", "defect", "closure_eco", "closure_report"):
            self.assertTrue(c.get(k), f"链路缺 {k}")

    # —— 5. ECO 生效批次格式 ——
    def test_eco_batch_format(self):
        for e in self.d["ecos"]:
            self.assertRegex(e["effective_batch"], r"^PB-\d{4} 起$",
                             f"{e['eco']} 生效批次格式应为 'PB-XXXX 起'")


if __name__ == "__main__":
    unittest.main()
