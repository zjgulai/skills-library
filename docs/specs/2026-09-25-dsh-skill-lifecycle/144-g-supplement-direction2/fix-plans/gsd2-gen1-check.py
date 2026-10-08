#!/usr/bin/env python3
"""G 续补去向②新技能制作 —— gen1 候选校验器（零请求、静态、带负控矩阵）

对七件新制作候选（candidates/<name>-gen1）做三类检查：
  A. 结构：SKILL.md frontmatter（name/version/complexity/license/compatibility/description
     长度与负向边界）、References 引用存在性（死链）与完备性、正文长度、evals schema
  B. 内容一致性：从产物文件解析关键规则/数字并核对（每件定点 token）
  C. 负控矩阵：每件 3 突变 → 必须判红（含预期错误类别关键词）

用法：python3 -B gsd2-gen1-check.py [--name <name>]
"""
import argparse
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve()
ROOT = HERE.parents[5]
CAND = ROOT / 'skill-lifecycle' / 'trial-home' / 'opt-run' / 'candidates'

ITEMS = ['management-decision-package', 'scenario-governance-review',
         'storefront-sellability-check', 'account-health-appeal',
         'metric-contract-governance', 'experiment-adoption-gate',
         'tool-contract-governance']


def load_fm(text: str):
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return None, None
    fm_text, body = m.group(1), m.group(2)
    fm, key, buf = {}, None, []
    for line in fm_text.splitlines():
        mm = re.match(r'^([a-z_]+):\s*(.*)$', line)
        if mm:
            if key:
                fm[key] = ' '.join(buf).strip().strip('"')
            key, val = mm.group(1), mm.group(2).strip()
            if val in ('>', '|'):          # 块标量：收集缩进续行
                buf = []
            else:
                fm[key] = val.strip('"')
                key, buf = None, []
        elif key and line.startswith((' ', '\t')):
            buf.append(line.strip())
    if key:
        fm[key] = ' '.join(buf).strip().strip('"')
    return fm, body


def check_common(root: Path, name: str):
    errs = []
    skill = root / 'SKILL.md'
    if not skill.is_file():
        return ['缺 SKILL.md']
    text = skill.read_text(encoding='utf-8')
    fm, body = load_fm(text)
    if fm is None:
        return ['frontmatter 围栏不规范']
    if fm.get('name') != name:
        errs.append(f"name != {name}（{fm.get('name')}）")
    if not re.fullmatch(r'\d+\.\d+\.\d+', fm.get('version', '')):
        errs.append('version 非 semver')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append(f"complexity 非法：{fm.get('complexity')}")
    if not fm.get('license'):
        errs.append('license 缺失')
    if not fm.get('compatibility'):
        errs.append('compatibility 缺失')
    desc = fm.get('description', '')
    if not (200 <= len(desc) <= 500):
        errs.append(f'description 长度越界（200–500）：{len(desc)}')
    if '何时不用' not in desc:
        errs.append('description 缺负向边界（何时不用）')
    if len(body.encode('utf-8')) > 8000:
        errs.append(f'body 超限：{len(body.encode("utf-8"))}')
    # 引用存在性 + 引用完备性（每个 references/*.md 必须被正文引用）
    linked = set()
    for m in re.finditer(r'`(references/[^`]+\.md)`', body):
        linked.add(m.group(1))
        if not (root / m.group(1)).is_file():
            errs.append(f'死链: {m.group(1)}')
    for p in sorted((root / 'references').rglob('*.md')):
        rel = str(p.relative_to(root)).replace('\\', '/')
        if rel not in linked:
            errs.append(f'未被正文引用: {rel}')
    # evals
    ev = root / 'evals' / 'evals.json'
    if not ev.is_file():
        errs.append('缺 evals/evals.json')
    else:
        try:
            d = json.loads(ev.read_text(encoding='utf-8'))
            if d.get('skill_name') != name:
                errs.append('evals skill_name 不匹配')
            evs = d.get('evals', [])
            if len(evs) < 3:
                errs.append(f'evals 题数不足：{len(evs)}')
            for e in evs:
                for k in ('id', 'prompt', 'expected_output', 'assertions'):
                    if k not in e:
                        errs.append(f"evals id={e.get('id')} 缺 {k}")
                if len(e.get('assertions', [])) < 3:
                    errs.append(f"evals id={e.get('id')} assertions<3")
        except Exception as ex:
            errs.append(f'evals 解析失败：{ex}')
    return errs


def _require(root: Path, rel: str, tokens, errs: list, label: str):
    p = root / rel
    if not p.is_file():
        errs.append(f'缺 {rel}')
        return
    t = p.read_text(encoding='utf-8')
    for tok in tokens:
        if tok not in t:
            errs.append(f'{label}缺失：{tok}')


def v_g01(root: Path) -> list:
    errs = check_common(root, 'management-decision-package')
    _require(root, 'references/decision-package-rules.md',
             ['双向集合相等', '自涉者回避后由替补决定', '≥2 个域', '交接物非空'],
             errs, '决策包规则')
    _require(root, 'references/examples/worked-example.md',
             ['D-101', 'D-102', 'D-201', 'D-202', 'D-301', 'D-302',
              'C-01', 'C-02', 'S-01', 'S-02',
              '3,000', '12,000', '8,000', '5,000', '1.5 人月', '2,000 USD/季',
              '连续两窗口 CAC 超上限', '投放对账与归因报告'],
             errs, '算例')
    _require(root, 'SKILL.md', ['双向集合相等', '不代决', '只读'], errs, 'SKILL')
    return errs


def v_g02(root: Path) -> list:
    errs = check_common(root, 'scenario-governance-review')
    _require(root, 'references/scenario-governance-rules.md',
             ['≥8/周', '≥5/月', '一致性 <90%', '关键项错 1 处即全量', '高风险全查', '100%',
              '不得同人', '不得参与被审实现', '制作人自批＝冲突',
              '待补证', '缺证据', '对账方法 v1.2', '退赔判定 v1.0', '多币种重估'],
             errs, '场景治理规则')
    _require(root, 'references/examples/worked-example.md',
             ['AUD-2609-01', 'AUD-2609-02', 'AUD-2609-03',
              '缺优惠叠加边界样例', '8/8', '不通过', '待补证'],
             errs, '算例')
    _require(root, 'SKILL.md', ['自主批准', '不得同人', '三态'], errs, 'SKILL')
    return errs


def v_g05a(root: Path) -> list:
    errs = check_common(root, 'storefront-sellability-check')
    _require(root, 'references/sellability-rules.md',
             ['不得先上后补', 'RL-BELL-01', '待核', '与折扣**互斥**',
              '合计优惠 **≤30%**', '优惠后金额', '缓存延迟约 15 分钟',
              '不重复扣款', 'T+5', '第 1 顺位', '第 2 顺位', '第 3 顺位'],
             errs, '可售规则')
    _require(root, 'references/examples/worked-example.md',
             ['HM-PUMP-100', 'RL-BELL-01', '62×0.9', '55.8',
              'AV-02', 'AV-03', 'AV-04', '补齐后放行'],
             errs, '算例')
    _require(root, 'SKILL.md',
             ['不得先上后补', '互斥', '≤30%', '优惠后金额', '不重复扣款', '二次校验'],
             errs, 'SKILL')
    if not (root / 'tests' / 'test_sellability_rules.py').is_file():
        errs.append('缺 tests/test_sellability_rules.py')
    return errs


def v_g05b(root: Path) -> list:
    errs = check_common(root, 'account-health-appeal')
    _require(root, 'references/account-health-rules.md',
             ['纠正证据必须非空', 'P-2609-01', '已完成 / 进行中', '两态制',
              '品牌授权', '采购凭证', '补证清单', '复发'],
             errs, '账号健康规则')
    _require(root, 'references/examples/worked-example.md',
             ['P-2609-01', 'P-2609-02', '整改截图与新版详情',
              '进行中（等待平台审核）', '2/3 项'],
             errs, '算例')
    _require(root, 'SKILL.md', ['不代提交', '四要素', '两态'], errs, 'SKILL')
    return errs


def v_g09(root: Path) -> list:
    errs = check_common(root, 'metric-contract-governance')
    _require(root, 'references/contract-rules.md',
             ['聚合 SKU×2', 'v1（试）', 'GMV−退款−平台费＋冲回',
              '按同口径重述', '旧键映射', '≤0.5%', '零填充', '口径漂移', '待核'],
             errs, '契约规则')
    _require(root, 'references/examples/worked-example.md',
             ['F-2609-01', 'F-2609-02', '2026-10-01 起',
              '历史 8 月报表按同口径重述', '待核'],
             errs, '算例')
    _require(root, 'SKILL.md', ['六类对象', '五要素', '三件套', '不执行数据变更'],
             errs, 'SKILL')
    if not (root / 'tests' / 'test_contract_rules.py').is_file():
        errs.append('缺 tests/test_contract_rules.py')
    return errs


def v_g10(root: Path) -> list:
    errs = check_common(root, 'experiment-adoption-gate')
    _require(root, 'references/adoption-rules.md',
             ['E-2609-01', 'E-2609-02', 'E-2609-03', 'E-2609-04', 'E-2609-05',
              '置信区间含 0', '不作增量成立结论', '非随机', '方向参考',
              '采用（范围化）', '继续观察', 'DE 站新客券门槛 49',
              '毛利护栏持续监控', '平台口径归因偏满', '无效；不进采用通道'],
             errs, '采用规则')
    _require(root, 'references/examples/worked-example.md',
             ['E-2609-01', 'E-2609-02', 'E-2609-03', 'E-2609-04', 'E-2609-05',
              'DE 站新客券门槛 49', 'US 西岸仓分流', '不在采用决定表',
              '3.1%→3.4%', '净贡献 +3.1%', '-0.42 USD/单'],
             errs, '算例')
    _require(root, 'SKILL.md', ['置信区间含 0', '方向参考', '护栏', '不代经营取舍'],
             errs, 'SKILL')
    return errs


def v_g11(root: Path) -> list:
    errs = check_common(root, 'tool-contract-governance')
    _require(root, 'references/contract-semantics-rules.md',
             ['T-101', 'T-102', 'T-201', 'T-301', 'T-302', 'T-401',
              'plan-id', 'case-id', 'dispute-id',
              '先只读核验再决定重试', '取消中', '重复提交', '重试',
              '分片 hash 对齐后去重', '旧键作废留痕',
              '季审撤销', '月度重签', '事件触发回收', '需合规会签'],
             errs, '契约语义规则')
    _require(root, 'references/examples/worked-example.md',
             ['T-101', 'T-301', 'T-401', '前后价回执比对', '旧键作废留痕'],
             errs, '算例')
    _require(root, 'SKILL.md',
             ['先只读核验', '不自动重试', '写类不得为「无需审批」', '取消是请求语义', '不接真机'],
             errs, 'SKILL')
    # 写类审批硬检查：| 写 | 行不得含「无需审批」
    rules = (root / 'references' / 'contract-semantics-rules.md').read_text(encoding='utf-8')
    for line in rules.splitlines():
        if '| 写 |' in line and '无需审批' in line:
            errs.append(f'写类条目不得为无需审批：{line.strip()[:60]}')
    if not (root / 'tests' / 'test_contract_semantics_rules.py').is_file():
        errs.append('缺 tests/test_contract_semantics_rules.py')
    return errs


VALIDATORS = {
    'management-decision-package': v_g01,
    'scenario-governance-review': v_g02,
    'storefront-sellability-check': v_g05a,
    'account-health-appeal': v_g05b,
    'metric-contract-governance': v_g09,
    'experiment-adoption-gate': v_g10,
    'tool-contract-governance': v_g11,
}

MUTATIONS = {
    'management-decision-package': [
        ('m1 清单双向性破坏', 'references/decision-package-rules.md', '双向集合相等', '单向集合包含', '双向集合相等'),
        ('m2 只读边界破坏', 'SKILL.md', '不代决', '可代决', '不代决'),
        ('m3 停止触发破坏', 'references/examples/worked-example.md', '连续两窗口 CAC 超上限', '单窗口 CAC 超上限', '连续两窗口'),
    ],
    'scenario-governance-review': [
        ('m1 抽样阈值破坏', 'references/scenario-governance-rules.md', '≥8/周', '≥4/周', '≥8/周'),
        ('m2 独立性破坏', 'SKILL.md', '不得同人', '可同人', '不得同人'),
        ('m3 待补证样例破坏', 'references/examples/worked-example.md', '缺优惠叠加边界样例', '样例待补', '优惠叠加边界样例'),
    ],
    'storefront-sellability-check': [
        ('m1 先上后补破坏', 'SKILL.md', '不得先上后补', '可先上后补', '不得先上后补'),
        ('m2 优惠封顶破坏', 'references/sellability-rules.md', '合计优惠 **≤30%**', '合计优惠 **≤50%**', '≤30%'),
        ('m3 算例算式破坏', 'references/examples/worked-example.md', '62×0.9', '62×0.85', '62×0.9'),
    ],
    'account-health-appeal': [
        ('m1 纠正证据硬线破坏', 'references/account-health-rules.md', '纠正证据必须非空', '纠正证据可后补', '纠正证据必须非空'),
        ('m2 不代提交破坏', 'SKILL.md', '不代提交', '可代提交', '不代提交'),
        ('m3 状态两态破坏', 'references/examples/worked-example.md', '进行中（等待平台审核）', '申诉处理中', '进行中'),
    ],
    'metric-contract-governance': [
        ('m1 历史修正破坏', 'references/contract-rules.md', '按同口径重述', '不再重述', '按同口径重述'),
        ('m2 SLA 阈值破坏', 'references/contract-rules.md', '≤0.5%', '≤5%', '≤0.5%'),
        ('m3 边界声明破坏', 'SKILL.md', '不执行数据变更', '可执行数据变更', '不执行数据变更'),
    ],
    'experiment-adoption-gate': [
        ('m1 置信区间口径破坏', 'references/adoption-rules.md', '不作增量成立结论', '可作增量成立结论', '不作增量成立结论'),
        ('m2 非随机口径破坏', 'references/adoption-rules.md', '仅作方向参考', '可作执行结论', '方向参考'),
        ('m3 范围化范围破坏', 'references/examples/worked-example.md', 'DE 站新客券门槛 49', '全站券门槛', 'DE 站新客券门槛 49'),
    ],
    'tool-contract-governance': [
        ('m1 未知结果处置破坏', 'references/contract-semantics-rules.md', '先只读核验再决定重试', '直接自动重试', '先只读核验'),
        ('m2 写类审批破坏', 'references/contract-semantics-rules.md', '需 MGT-002 授权', '无需审批', '写类'),
        ('m3 不自动重试破坏', 'SKILL.md', '不自动重试', '自动重试', '不自动重试'),
    ],
}


def run_mutation(name: str, root: Path, label, rel, old, new, expect) -> tuple:
    tmp = Path(tempfile.mkdtemp(prefix=f'gsd2m-{name[:8]}-'))
    try:
        dst = tmp / f'{name}-gen1'
        shutil.copytree(root, dst)
        tgt = dst / rel
        if not tgt.is_file():
            return False, f'突变目标文件不存在（{rel}）'
        text = tgt.read_text(encoding='utf-8')
        cnt = text.count(old)
        if cnt == 0:
            return False, f'突变目标不存在（{old[:40]}）'
        tgt.write_text(text.replace(old, new), encoding='utf-8')  # 全替（str.replace 全量）
        errs = VALIDATORS[name](dst)
        if not errs:
            return False, '突变后未判红（假绿）'
        if not any(expect in e for e in errs):
            return False, f'判红但未命中预期「{expect}」：{errs[:2]}'
        return True, f'红 ✓（{errs[0][:64]}…）'
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--name')
    args = ap.parse_args()
    names = [args.name] if args.name else ITEMS
    overall = True
    for name in names:
        root = CAND / f'{name}-gen1'
        print(f'=== {name}-gen1 ===')
        if not root.is_dir():
            print('  FAIL 候选目录不存在')
            overall = False
            continue
        errs = VALIDATORS[name](root)
        print(f"  [候选] {'PASS' if not errs else 'FAIL'}")
        for e in errs:
            print('    -', e)
        if errs:
            overall = False
        passed = 0
        for (label, rel, old, new, expect) in MUTATIONS.get(name, []):
            ok, detail = run_mutation(name, root, label, rel, old, new, expect)
            print(f"  [负控] {label}: {'红 ✓' if ok else 'FAIL'} — {detail}")
            passed += 1 if ok else 0
        total = len(MUTATIONS.get(name, []))
        print(f'  [负控汇总] {passed}/{total}')
        if passed != total:
            overall = False
    print()
    print('RESULT:', 'PASS' if overall else 'FAIL')
    sys.exit(0 if overall else 1)


if __name__ == '__main__':
    main()
