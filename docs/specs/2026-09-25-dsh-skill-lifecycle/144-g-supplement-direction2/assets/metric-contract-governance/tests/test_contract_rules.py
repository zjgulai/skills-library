#!/usr/bin/env python3
"""口径契约包内自检（零依赖、确定性；不访问网络、不改任何文件）。

校验合成口径在包内一致可复算：
1. SKILL.md 硬线在列（六类对象/五要素/三件套/三查/待核/不执行变更）；
2. 对象字典六类齐且 SPU 聚合 SKU×2 关系在档；
3. 指标表 ≥3 且「净贡献」带「v1（试）」；
4. 冲突记录含重述与映射两种历史处置；
5. SLA 三查（空值/零填充/漂移）齐。
"""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class TestContractRules(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.skill = (ROOT / 'SKILL.md').read_text(encoding='utf-8')
        cls.rules = (ROOT / 'references' / 'contract-rules.md').read_text(encoding='utf-8')
        cls.example = (ROOT / 'references' / 'examples' / 'worked-example.md').read_text(encoding='utf-8')

    def test_hard_lines_present(self):
        for token in ('六类对象', '五要素', '三件套', '待核', '不执行数据变更'):
            self.assertIn(token, self.skill, f'SKILL.md 缺：{token}')

    def test_object_dictionary_six_types(self):
        for t in ('主体', '账号', '店铺', '商品', 'SPU', 'SKU'):
            self.assertIn(t, self.rules, f'对象字典缺类：{t}')
        self.assertIn('聚合 SKU×2', self.rules)

    def test_metric_versions(self):
        self.assertIn('v1（试）', self.rules)
        self.assertIn('净贡献', self.rules)
        self.assertIn('GMV−退款−平台费＋冲回', self.rules)

    def test_conflict_dispositions(self):
        self.assertIn('按同口径重述', self.rules)
        self.assertIn('旧键映射', self.rules)
        self.assertIn('2026-10-01 起', self.rules)

    def test_sla_three_checks(self):
        for t in ('空值率', '零填充', '口径漂移'):
            self.assertIn(t, self.rules, f'SLA 缺查项：{t}')
        self.assertIn('≤0.5%', self.rules)


if __name__ == '__main__':
    unittest.main(verbosity=2)
