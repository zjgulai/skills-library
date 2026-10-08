#!/usr/bin/env python3
"""准入判断口径测试（零依赖 unittest）：核验 worked-example 的证据引用与三态结论。"""
import pathlib
import unittest

HERE = pathlib.Path(__file__).resolve()
EX = (HERE.parents[1] / 'references' / 'examples' / 'worked-example.md').read_text(encoding='utf-8')


class AccessRules(unittest.TestCase):
    def test_evidence_citations(self):
        # 结论必须引用证书编号（合成占位）
        for token in ('MOCK-CE-24071', 'MOCK-CE-24072', 'MOCK-EN71-2405', 'MOCK-CPC-2413', 'MOCK-REACH-2408'):
            self.assertIn(token, EX, token)

    def test_three_state_conclusions(self):
        self.assertIn('可准入（过渡期条款待确认）', EX)
        self.assertIn('待补证', EX)
        # 摇铃 EU/US 为无附加条件「可准入」
        self.assertEqual(EX.count('**可准入**'), 2)

    def test_reach_near_expiry(self):
        # 2026-10-01 评估日 → 2026-12-31 到期 = 91 天，处于临期窗口边界
        import datetime
        days = (datetime.date(2026, 12, 31) - datetime.date(2026, 10, 1)).days
        self.assertEqual(days, 91)
        self.assertIn('91 天', EX)

    def test_missing_evidence_downgraded(self):
        # 湿巾缺成分表 → 待补证；不得判可准入
        self.assertIn('湿巾', EX)
        line = [l for l in EX.splitlines() if '湿巾' in l][0]
        self.assertIn('待补证', line)

    def test_claim_binding_in_skill(self):
        skill = (HERE.parents[1] / 'SKILL.md').read_text(encoding='utf-8')
        self.assertIn('宣称', skill)
        chain = (HERE.parents[1] / 'references' / 'evidence-chain.md').read_text(encoding='utf-8')
        self.assertIn('宣称与证据绑定', chain)


if __name__ == '__main__':
    unittest.main()
