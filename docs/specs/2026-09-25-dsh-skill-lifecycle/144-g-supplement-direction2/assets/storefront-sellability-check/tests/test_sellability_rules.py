#!/usr/bin/env python3
"""可售核验包内自检（零依赖、确定性；不访问网络、不改任何文件）。

校验合成口径在包内一致可复算：
1. SKILL.md 硬线在列（不得先上后补 / 互斥 / ≤30% / 优惠后金额 / 不重复扣款 / 二次校验）；
2. 优惠算例可复算：62×0.9=55.8；55.8<79 → 不免运费；10%≤30%；
3. 规则表含三顺位与互斥/封顶/判定基准；
4. 算例含待核 SKU 与三类异常案例。
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class TestSellabilityRules(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.skill = (ROOT / 'SKILL.md').read_text(encoding='utf-8')
        cls.rules = (ROOT / 'references' / 'sellability-rules.md').read_text(encoding='utf-8')
        cls.example = (ROOT / 'references' / 'examples' / 'worked-example.md').read_text(encoding='utf-8')

    def test_hard_lines_present(self):
        for token in ('不得先上后补', '互斥', '≤30%', '优惠后金额', '不重复扣款', '二次校验'):
            self.assertIn(token, self.skill, f'SKILL.md 缺硬线：{token}')

    def test_promotion_math(self):
        base = 62
        discounted = round(base * 0.9, 1)
        self.assertEqual(discounted, 55.8)
        self.assertLess(discounted, 79)          # 优惠后 < 门槛 → 不免运费
        self.assertLessEqual(10, 30)             # 9 折 = 10% 优惠 ≤ 30% 封顶
        self.assertIn('55.8', self.example)
        self.assertIn('62×0.9', self.example)

    def test_stacking_order_and_boundaries(self):
        for token in ('第 1 顺位', '第 2 顺位', '第 3 顺位', '与折扣**互斥**', '合计优惠 **≤30%**'):
            self.assertIn(token, self.rules, f'规则表缺：{token}')

    def test_waiting_item_and_cases(self):
        self.assertIn('RL-BELL-01', self.example)
        self.assertIn('待核', self.example)
        for case in ('AV-02', 'AV-03', 'AV-04'):
            self.assertIn(case, self.example, f'算例缺案例：{case}')


if __name__ == '__main__':
    unittest.main(verbosity=2)
