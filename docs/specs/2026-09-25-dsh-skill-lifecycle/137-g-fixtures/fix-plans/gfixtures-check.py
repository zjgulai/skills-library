#!/usr/bin/env python3
"""G 收官批·三族夹具增强 —— 候选校验器（零请求、静态、带负控矩阵）

对五件候选（candidates/<name>-genN，N=最高代）做三类检查：
  A. 资产结构：新增夹具文件齐备、格式可解析
  B. 内容一致性：夹具数字/枚举/红线可复算或可校验
  C. 负控矩阵：每件 ≥2 突变 → 必须判红（含预期错误类别关键词）

用法：python3 -B gfixtures-check.py [--name <name>]
"""
import argparse
import csv
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve()
ROOT = HERE.parents[5]
CAND = ROOT / 'skill-lifecycle' / 'trial-home' / 'opt-run' / 'candidates'

ITEMS = ['tech-pack-generator', 'customer-reply-craft', 'customer-escalation',
         'contract-review', 'compliance-check']

TIER_WHITELIST = {'l2', 'engineering', 'product', 'security', 'leadership'}
SEV_WHITELIST = {'critical', 'high', 'medium'}


ASSETS = HERE.parents[1] / 'assets'


def latest_cand(name: str) -> Path:
    """本批目标候选：含本批资产签名的最新一代（与 build 同口径）；否则最新一代。"""
    sig = [str(p.relative_to(ASSETS / name)) for p in (ASSETS / name).rglob('*') if p.is_file()]
    pat = re.compile(rf'^{re.escape(name)}-gen(\d+)$')
    gens = sorted((int(m.group(1)), p) for p in CAND.iterdir()
                  if p.is_dir() and (m := pat.match(p.name)))
    for g, p in reversed(gens):
        if any((p / s).exists() for s in sig):
            return p
    return gens[-1][1]


def v_techpack(root: Path) -> list:
    errs = []
    fx = root / 'tests' / 'fixtures' / 'bom-tolerance-hm-pump.json'
    tp = root / 'tests' / 'test_bom_tolerance.py'
    if not fx.is_file():
        return ['缺 bom-tolerance-hm-pump.json']
    if not tp.is_file():
        errs.append('缺 test_bom_tolerance.py')
    d = json.loads(fx.read_text(encoding='utf-8'))
    total = 0.0
    for line in d['bom']:
        total += round(line['qty'] * line['unit_price'] * (1 + line['loss_rate']) + 1e-9, 2)
    total = round(total + 1e-9, 2)
    if total != d['expected_material_cost']:
        errs.append(f'材料成本复算 {total} != 期望 {d["expected_material_cost"]}')
    for s in d['specs']:
        if not (s['tol_minus'] <= 0 <= s['tol_plus']):
            errs.append(f"{s['id']} 公差方向非法")
    kc06 = [s for s in d['specs'] if s['id'] == 'KC-06']
    if len(kc06) != 1 or kc06[0]['nominal'] != 2.6:
        errs.append('KC-06 缺失或标称非 2.6')
    c = d['dvpr_chain']
    if not c['closure_result'].startswith('12/12 通过'):
        errs.append('DVP&R 链路复测结果非 12/12 通过')
    return errs


def v_reply(root: Path) -> list:
    errs = []
    f = root / 'evals' / 'eval-cases.yaml'
    if not f.is_file():
        return ['缺 evals/eval-cases.yaml']
    t = f.read_text(encoding='utf-8')
    n_case = len(re.findall(r'^- id: case-0\d', t, re.M))
    if n_case != 5:
        errs.append(f'用例数 {n_case} != 5')
    if t.count('must_not:') < 4:
        errs.append(f'must_not 段落不足：{t.count("must_not:")}')
    for kw in ('卫生原因不支持无理由退货', '建议尽快就医咨询', '不承诺医疗费赔付'):
        if kw not in t:
            errs.append(f'缺红线/政策关键词：{kw}')
    return errs


def v_escalation(root: Path) -> list:
    errs = []
    f = root / 'evals' / 'policy-escalation-cases.yaml'
    if not f.is_file():
        return ['缺 evals/policy-escalation-cases.yaml']
    t = f.read_text(encoding='utf-8')
    n_case = len(re.findall(r'^- id: policy-0\d', t, re.M))
    if n_case != 5:
        errs.append(f'用例数 {n_case} != 5')
    for m in re.finditer(r'target_tier:\s*(\w+)', t):
        if m.group(1) not in TIER_WHITELIST:
            errs.append(f'非法 target_tier: {m.group(1)}（枚举白名单 {sorted(TIER_WHITELIST)}）')
    for m in re.finditer(r'severity:\s*(\w+)', t):
        if m.group(1) not in SEV_WHITELIST:
            errs.append(f'非法 severity: {m.group(1)}（枚举白名单 {sorted(SEV_WHITELIST)}）')
    if 'escalate: false' not in t:
        errs.append('缺 escalate: false 反例')
    if 'target_tier: leadership' not in t:
        errs.append('缺 leadership 升级用例')
    return errs


def v_contract(root: Path) -> list:
    errs = []
    f = root / 'tests' / 'fixtures' / 'clause-baselines.csv'
    if not f.is_file():
        return ['缺 tests/fixtures/clause-baselines.csv']
    with open(f, encoding='utf-8-sig') as fh:
        rows = list(csv.DictReader(fh))
    if len(rows) != 6:
        errs.append(f'条款行数 {len(rows)} != 6')
    kinds = {r['条款类型'] for r in rows}
    for k in ('责任上限', '管辖', 'IP 归属', '质量索赔期', '保密期限', '数据条款'):
        if k not in kinds:
            errs.append(f'缺条款类型：{k}')
    hard = 0
    for r in rows:
        if not r['底线要求'].strip():
            errs.append(f"{r['条款类型']} 底线为空")
        if not r['可让步区间'].strip():
            errs.append(f"{r['条款类型']} 让步区间为空")
        if '不得' in r['底线要求'] or '归我方' in r['底线要求']:
            hard += 1
    if hard < 2:
        errs.append(f'硬约束条款不足：{hard} < 2')
    return errs


def v_compliance(root: Path) -> list:
    errs = []
    f = root / 'tests' / 'data-retention-cases.json'
    if not f.is_file():
        return ['缺 tests/data-retention-cases.json']
    d = json.loads(f.read_text(encoding='utf-8'))
    cases = d.get('cases', [])
    if len(cases) != 5:
        errs.append(f'用例数 {len(cases)} != 5')
    for c in cases:
        for k in ('retention', 'deletion_trigger', 'notes'):
            if k not in c.get('expected', {}):
                errs.append(f"{c.get('id')} 缺 expected.{k}")
    joined = json.dumps(cases, ensure_ascii=False)
    for kw in ('撤回即删', '7 年'):
        if kw not in joined:
            errs.append(f'缺关键判定：{kw}')
    return errs


VALIDATORS = {
    'tech-pack-generator': v_techpack,
    'customer-reply-craft': v_reply,
    'customer-escalation': v_escalation,
    'contract-review': v_contract,
    'compliance-check': v_compliance,
}

MUTATIONS = {
    'tech-pack-generator': [
        ('m1 期望成本改错', 'tests/fixtures/bom-tolerance-hm-pump.json', '"expected_material_cost": 31.63', '"expected_material_cost": 31.64', '材料成本'),
        ('m2 公差方向破坏', 'tests/fixtures/bom-tolerance-hm-pump.json', '"tol_plus": 0.1, "unit": "mm"', '"tol_plus": -0.1, "unit": "mm"', '公差方向'),
    ],
    'customer-reply-craft': [
        ('m1 卫生红线改写', 'evals/eval-cases.yaml', '卫生原因不支持无理由退货', '卫生原因可以退货', '卫生'),
        ('m2 健康转交改写', 'evals/eval-cases.yaml', '建议尽快就医咨询', '建议自行判断即可', '就医'),
    ],
    'customer-escalation': [
        ('m1 tier 越枚举', 'evals/policy-escalation-cases.yaml', 'target_tier: leadership', 'target_tier: boss', 'target_tier'),
        ('m2 severity 越枚举', 'evals/policy-escalation-cases.yaml', 'severity: critical', 'severity: urgent', 'severity'),
    ],
    'contract-review': [
        ('m1 底线置空', 'tests/fixtures/clause-baselines.csv', '数据条款,不得转售/转移客户数据,', '数据条款,,', '底线为空'),
        ('m2 删一行', 'tests/fixtures/clause-baselines.csv', '保密期限,合作期 + 3 年,2–3 年,技术资料单独加密层级\n', '', '行数'),
    ],
    'compliance-check': [
        ('m1 撤回判定改写', 'tests/data-retention-cases.json', '撤回即删', '撤回后暂缓', '撤回即删'),
        ('m2 字段缺失', 'tests/data-retention-cases.json', '"deletion_trigger":', '"deletion_remove":', 'deletion_trigger'),
    ],
}


def run_mutation(name: str, root: Path, label, rel, old, new, expect) -> tuple:
    tmp = Path(tempfile.mkdtemp(prefix=f'gfx-{name[:8]}-'))
    try:
        dst = tmp / root.name
        shutil.copytree(root, dst)
        tgt = dst / rel
        if not tgt.is_file():
            return False, f'突变目标文件不存在（{rel}）'
        text = tgt.read_text(encoding='utf-8')
        if text.count(old) == 0:
            return False, f'突变目标不存在（{old[:40]}）'
        tgt.write_text(text.replace(old, new), encoding='utf-8')
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
        root = latest_cand(name)
        print(f'=== {root.name} ===')
        errs = VALIDATORS[name](root)
        print(f"  [候选] {'PASS' if not errs else 'FAIL'}")
        for e in errs:
            print('    -', e)
        if errs:
            overall = False
        passed = 0
        muts = MUTATIONS.get(name, [])
        for (label, rel, old, new, expect) in muts:
            ok, detail = run_mutation(name, root, label, rel, old, new, expect)
            print(f"  [负控] {label}: {'红 ✓' if ok else 'FAIL'} — {detail}")
            passed += 1 if ok else 0
        print(f'  [负控汇总] {passed}/{len(muts)}')
        if passed != len(muts):
            overall = False
    print()
    print('RESULT:', 'PASS' if overall else 'FAIL')
    sys.exit(0 if overall else 1)


if __name__ == '__main__':
    main()
