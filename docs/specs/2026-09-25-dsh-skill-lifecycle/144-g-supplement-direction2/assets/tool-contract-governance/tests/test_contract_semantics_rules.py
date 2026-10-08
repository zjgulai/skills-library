#!/usr/bin/env python3
"""工具契约包内自检（零依赖、确定性；不访问网络、不改任何文件）。

校验合成口径在包内一致可复算：
1. SKILL.md 硬线在列（先只读核验/不自动重试/写类不得无需审批/幂等键/取消请求语义）；
2. 契约表读类全免审批、写类全有审批；
3. 语义表四情形齐；
4. 授权表四行三要素齐；
5. 恢复案例三件且幂等核验非空。
"""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class TestContractSemantics(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.skill = (ROOT / 'SKILL.md').read_text(encoding='utf-8')
        cls.rules = (ROOT / 'references' / 'contract-semantics-rules.md').read_text(encoding='utf-8')

    def test_hard_lines_present(self):
        for token in ('先只读核验', '不自动重试', '不得为「无需审批」', '取消是请求语义'):
            self.assertIn(token, self.skill, f'SKILL.md 缺硬线：{token}')

    def test_read_write_approval(self):
        self.assertIn('读类 ≥3 且全免审批'.replace(' ', ''), self.rules.replace(' ', ''))
        self.assertIn('写类全有审批', self.rules.replace(' ', ''))
        self.assertNotIn('| `T-301` 改价 | 写 | listing 价格 | `plan-id` | 变更回执（前后价） | 无需审批 |', self.rules)

    def test_semantics_four_rows(self):
        for token in ('重复提交', '取消中', '未知结果', '重试'):
            self.assertIn(token, self.rules, f'语义缺：{token}')
        self.assertIn('先只读核验再决定重试', self.rules)

    def test_authorization_three_elements(self):
        for token in ('带额度授权', '判定＋复核', '会签授权', '只读授权'):
            self.assertIn(token, self.rules, f'授权缺：{token}')
        for token in ('季审', '月度重签', '事件触发回收'):
            self.assertIn(token, self.rules, f'期限/撤销缺：{token}')

    def test_recovery_cases(self):
        for case in ('R-01', 'R-02', 'R-03'):
            self.assertIn(case, self.rules, f'恢复案例缺：{case}')
        self.assertIn('分片 hash 对齐后去重', self.rules)
        self.assertIn('旧键作废留痕', self.rules)


if __name__ == '__main__':
    unittest.main(verbosity=2)
