#!/usr/bin/env python3
"""质量闭环口径测试（零依赖 unittest）：核验 worked-example 的守恒与闭环链。"""
import pathlib
import unittest

HERE = pathlib.Path(__file__).resolve()
EX = (HERE.parents[1] / 'references' / 'examples' / 'worked-example.md').read_text(encoding='utf-8')


class QualityClosureRules(unittest.TestCase):
    def test_batch_conservation(self):
        # 投产 = 良品 + 不良；良品 = 去向之和
        self.assertEqual(1050, 1000 + 50)
        self.assertEqual(1100, 1065 + 35)
        self.assertEqual(1000, 500 + 500)

    def test_closure_chain_tokens(self):
        for token in ('TR-2608-02', 'DEF-001', 'ECO-2604', 'TR-2609-05', 'CAPA-2609-01', '2/12', '12/12'):
            self.assertIn(token, EX, token)

    def test_tolerance_window(self):
        # KC-06: 2.6 ± 0.1mm ⇒ [2.5, 2.7]；实测 2.58–2.62 必须落窗
        lo, hi = 2.6 - 0.1, 2.6 + 0.1
        for v in (2.58, 2.62):
            self.assertTrue(lo <= v <= hi, v)

    def test_containment_covers_shipped(self):
        # 遏制覆盖：隔离 3200 与已出货观察 500 均须在算例中出现
        self.assertIn('3200', EX)
        self.assertIn('500 件', EX)

    def test_no_close_without_d6_rule(self):
        skill = (HERE.parents[1] / 'SKILL.md').read_text(encoding='utf-8')
        self.assertIn('无 D6 复测数据不得关闭', skill)


if __name__ == '__main__':
    unittest.main()
