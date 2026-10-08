#!/usr/bin/env python3
"""G 续补去向①·六域夹具增强 —— 候选校验器（零请求、静态/脚本级、带负控矩阵）

对十件候选（candidates/<name>-genN，N=含本批资产的最新代）做三类检查：
  A. 资产结构：新增夹具文件齐备、格式可解析
  B. 内容一致性：夹具数字/枚举/映射规则可复算或可校验
     （split-test / dataset-health-audit 直接运行候选内脚本核对读数）
  C. 负控矩阵：每件 ≥2 突变 → 必须判红（含预期错误类别关键词）

用法：python3 -B gx2-check.py [--name <name>]
"""
import argparse
import csv
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

HERE = Path(__file__).resolve()
ROOT = HERE.parents[5]
CAND = ROOT / 'skill-lifecycle' / 'trial-home' / 'opt-run' / 'candidates'
ASSETS = HERE.parents[1] / 'assets'

ITEMS = ['leadership-strategy-playbook', 'compliance-review-planner', 'skill-evaluator',
         'pricing-strategy', 'ecommerce-ops', 'validate-data', 'dataset-health-audit',
         'split-test-evaluator', 'statistical-analysis', 'compliance-audit']

REV = {'reversible', 'irreversible'}
CONCL = {'通过', '不通过', '待补证'}
RISK = {'高', '中', '低'}
PRIO = {'P0', 'P1', 'P2', 'P3'}
STATUS_MAP = {'通过': '合规', '不通过': '不合规', '待补证': '待确认'}
EVAL_STATUS_BAND = {'excellent': (95, 100), 'good': (85, 94),
                    'needs_optimization': (70, 84), 'needs_refactor': (0, 69)}
SEV = {'error', 'warning', 'info'}
VERDICTS = {'supported', 'uncertain', 'unsupported'}
CAUTIONS = {'confounding', 'ci_covers_zero', 'insufficient_sample',
            'alternative_explanations', 'seasonal_confound'}


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


# ---------------- validators ----------------

def v_leadership(root: Path) -> list:
    errs = []
    f = root / 'tests' / 'fixtures' / 'decision-cases.yaml'
    if not f.is_file():
        return ['缺 decision-cases.yaml']
    d = yaml.safe_load(f.read_text(encoding='utf-8'))
    cases = d.get('decisions', [])
    if len(cases) < 6:
        errs.append(f'决策案数 {len(cases)} < 6')
    for c in cases:
        rid = c.get('id', '?')
        if c.get('reversibility') not in REV:
            errs.append(f'{rid} 可逆性非法：{c.get("reversibility")}')
        if not str(c.get('decided_by') or '').strip():
            errs.append(f'{rid} 缺决策权归属（decided_by）')
        if not (c.get('preconditions') or []):
            errs.append(f'{rid} 缺前提（preconditions）')
        if c.get('reversibility') == 'irreversible' and not str(c.get('failure_mode') or '').strip():
            errs.append(f'{rid} 不可逆但缺失败模式（premortem）')
        if c.get('reversibility') == 'reversible' and str(c.get('failure_mode') or '').strip():
            errs.append(f'{rid} 可逆案不应强填失败模式')
    d302 = [c for c in cases if c.get('id') == 'D-302']
    if len(d302) != 1 or '回避' not in str(d302[0].get('decided_by', '')):
        errs.append('D-302 缺自涉回避后的决策权归属')
    stops = d.get('stops', [])
    if len(stops) < 2:
        errs.append(f'停止/移交案 {len(stops)} < 2')
    for s in stops:
        for k in ('trigger', 'handoff'):
            if not s.get(k):
                errs.append(f"{s.get('id', '?')} 缺 {k}")
    return errs


def v_crp(root: Path) -> list:
    errs = []
    f = root / 'tests' / 'fixtures' / 'scenario-review-conclusions.csv'
    if not f.is_file():
        return ['缺 scenario-review-conclusions.csv']
    with open(f, encoding='utf-8-sig') as fh:
        rows = list(csv.DictReader(fh))
    if len(rows) < 5:
        errs.append(f'结论行数 {len(rows)} < 5')
    seen = set()
    for r in rows:
        rid = r['记录号']
        concl, risk, prio = r['结论'], r['风险等级'], r['整改优先']
        seen.add(concl)
        if concl not in CONCL:
            errs.append(f'{rid} 结论非法：{concl}')
            continue
        if risk not in RISK:
            errs.append(f'{rid} 风险等级非法：{risk}')
            continue
        if prio not in PRIO:
            errs.append(f'{rid} 整改优先非法：{prio}')
            continue
        st = STATUS_MAP[concl]
        if risk == '高' and st == '不合规':
            want = 'P0'
        elif (risk == '高' and st == '待确认') or (risk == '中' and st == '不合规'):
            want = 'P1'
        elif risk == '中' and st == '待确认':
            want = 'P2'
        elif risk == '低':
            want = 'P3'
        else:
            errs.append(f'{rid} 组合未定义（{risk}/{st}）')
            continue
        if prio != want:
            errs.append(f'{rid} 优先映射错误：{risk}+{st} 应为 {want}，实为 {prio}')
        if not str(r.get('整改/补证要求') or '').strip():
            errs.append(f'{rid} 缺整改/补证要求')
    if seen != CONCL:
        errs.append(f'三态不齐：{sorted(seen)}')
    return errs


def v_skill_eval(root: Path) -> list:
    errs = []
    f = root / 'tests' / 'fixtures' / 'evaluation-golden-cases.json'
    if not f.is_file():
        return ['缺 evaluation-golden-cases.json']
    d = json.loads(f.read_text(encoding='utf-8'))
    cases = d.get('cases', [])
    if len(cases) < 5:
        errs.append(f'案例数 {len(cases)} < 5')
    for c in cases:
        rid = c.get('id', '?')
        e = c.get('expected', {})
        st = e.get('status')
        sr = e.get('score_range') or [None, None]
        if st not in EVAL_STATUS_BAND:
            errs.append(f'{rid} 状态非法：{st}')
            continue
        lo, hi = EVAL_STATUS_BAND[st]
        if not (lo <= sr[0] <= sr[1] <= hi):
            errs.append(f'{rid} 分数区间 {sr} 不在 {st} 档位 [{lo},{hi}]')
        rel = e.get('releasable')
        if rel != (sr[0] >= 85):
            errs.append(f'{rid} 发布裁定与门槛不一致：releasable={rel}, 分数下界 {sr[0]}')
        for i in e.get('issues', []):
            if i.get('severity') not in SEV:
                errs.append(f'{rid} severity 非法：{i.get("severity")}')
            if not str(i.get('field') or '').strip():
                errs.append(f'{rid} issue 缺 field')
        if e.get('routing_gaps') and not (sr[1] < 100):
            errs.append(f'{rid} 缺 routing cases 但分数上界未受限（不得给满分）')
        if any(i.get('severity') == 'error' for i in e.get('issues', [])) and rel:
            errs.append(f'{rid} 含 error 却标可发布')
    return errs


def v_pricing(root: Path) -> list:
    errs = []
    f = root / 'tests' / 'fixtures' / 'promo-stacking-cases.csv'
    if not f.is_file():
        return ['缺 promo-stacking-cases.csv']
    with open(f, encoding='utf-8-sig') as fh:
        rows = list(csv.DictReader(fh))
    if len(rows) < 6:
        errs.append(f'案例数 {len(rows)} < 6')
    for r in rows:
        rid = r['案例']
        amount = float(r['购物车金额'])
        choice = r['选用优惠']
        verdict = r['判定']
        if verdict == '允许':
            if choice == '券（满59减5）':
                if amount < 59:
                    errs.append(f'{rid} 未达券门槛 59 却允许')
                    continue
                disc = 5.00
            elif choice == '折扣（9折）':
                disc = round(amount * 0.10 + 1e-9, 2)
            else:
                errs.append(f'{rid} 允许但选用优惠无法识别：{choice}')
                continue
            freight = 0.00 if round(amount - disc, 2) >= 79 else 6.00
            payable = round(amount - disc + freight + 1e-9, 2)
            if abs(float(r['期望优惠额']) - disc) > 0.005:
                errs.append(f'{rid} 优惠额复算 {disc} != {r["期望优惠额"]}')
            if abs(float(r['期望运费']) - freight) > 0.005:
                errs.append(f'{rid} 运费复算 {freight} != {r["期望运费"]}')
            if abs(float(r['期望应付']) - payable) > 0.005:
                errs.append(f'{rid} 应付复算 {payable} != {r["期望应付"]}')
            if disc / amount > 0.30 + 1e-9:
                errs.append(f'{rid} 优惠超过封顶 30%')
        elif verdict == '拒绝':
            note = r['说明']
            if not any(k in note for k in ('互斥', '门槛')):
                errs.append(f'{rid} 拒绝但未写明依据（互斥/门槛）')
        else:
            errs.append(f'{rid} 判定非法：{verdict}')
    return errs


def v_ecom(root: Path) -> list:
    errs = []
    f = root / 'tests' / 'fixtures' / 'storefront-verification-cases.csv'
    if not f.is_file():
        return ['缺 storefront-verification-cases.csv']
    with open(f, encoding='utf-8-sig') as fh:
        rows = list(csv.DictReader(fh))
    if len(rows) < 4:
        errs.append(f'案例数 {len(rows)} < 4')
    kinds = set()
    joined_red = ''
    for r in rows:
        rid = r['案例']
        kinds.add(r['情形'])
        for k in ('期望处置', '红线', '依据'):
            if not str(r.get(k) or '').strip():
                errs.append(f'{rid} 缺 {k}')
        joined_red += r['红线'] + r['期望处置']
    for k in ('可售核验', '支付失败', '退款异常', '库存不同步'):
        if k not in kinds:
            errs.append(f'缺情形：{k}')
    for kw in ('不得先上后补', '不重复扣款', '二次校验'):
        if kw not in joined_red:
            errs.append(f'缺红线关键词：{kw}')
    return errs


def v_validate(root: Path) -> list:
    errs = []
    f = root / 'tests' / 'fixtures' / 'metric-drift-cases.json'
    if not f.is_file():
        return ['缺 metric-drift-cases.json']
    d = json.loads(f.read_text(encoding='utf-8'))
    scale = set(d.get('assessment_scale', []))
    cases = d.get('cases', [])
    if len(cases) < 5:
        errs.append(f'案例数 {len(cases)} < 5')
    by_id = {c.get('id'): c for c in cases}
    for c in cases:
        rid = c.get('id', '?')
        e = c.get('expected', {})
        a = e.get('assessment')
        finds = e.get('required_findings') or []
        if a not in scale:
            errs.append(f'{rid} 评估档非法：{a}')
            continue
        if a in ('needs_revision', 'share_with_caveats') and not finds:
            errs.append(f'{rid} {a} 必须给出必备发现项')
        if a == 'ready_to_share' and finds:
            errs.append(f'{rid} ready_to_share 不应带发现项')
    if 'MD-01' in by_id:
        fs = set(by_id['MD-01']['expected'].get('required_findings', []))
        if not {'含税', '口径'} <= fs:
            errs.append(f'MD-01 发现项不足：{sorted(fs)}')
    if 'MD-05' in by_id:
        if '平台费' not in by_id['MD-05']['expected'].get('required_findings', []):
            errs.append('MD-05 缺「平台费」发现项')
    if 'MD-02' in by_id:
        if '重述' not in by_id['MD-02']['expected'].get('required_findings', []):
            errs.append('MD-02 缺「重述」发现项')
    return errs


def v_dha(root: Path) -> list:
    errs = []
    fx = root / 'tests' / 'fixtures' / 'metric-table-sample.csv'
    exp_f = root / 'tests' / 'fixtures' / 'expected-findings.json'
    script = root / 'scripts' / 'data_quality_checker.py'
    if not fx.is_file():
        return ['缺 metric-table-sample.csv']
    if not exp_f.is_file():
        return ['缺 expected-findings.json']
    if not script.is_file():
        return ['缺 scripts/data_quality_checker.py']
    exp = json.loads(exp_f.read_text(encoding='utf-8'))['expectations']
    proc = subprocess.run([sys.executable, '-B', str(script), str(fx)],
                          capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        return [f'检查器运行失败：{proc.stderr[-200:]}']
    out = json.loads(proc.stdout[proc.stdout.index('{'):])
    if out.get('rows') != exp['rows']:
        errs.append(f"行数 {out.get('rows')} != {exp['rows']}")
    dims = out.get('dimensions', {})
    mv = {i['column']: i['missing_count'] for i in dims.get('missing_values', {}).get('issues', [])}
    for col, n in exp['missing_values']['columns'].items():
        if mv.get(col) != n:
            errs.append(f'missing_values[{col}] = {mv.get(col)} != {n}')
    dups = dims.get('duplicates', {}).get('issues', [])
    dup_n = dups[0]['duplicate_rows'] if dups else 0
    if dup_n != exp['duplicates']['duplicate_rows']:
        errs.append(f'duplicates = {dup_n} != {exp["duplicates"]["duplicate_rows"]}')
    fc = dims.get('format_compliance', {}).get('issues', [])
    fc_hit = [i for i in fc if i.get('column') == exp['format_compliance']['column']]
    inv = fc_hit[0].get('invalid_count') if fc_hit else 0
    if inv != exp['format_compliance']['invalid_count']:
        errs.append(f'format[{exp["format_compliance"]["column"]}] invalid = {inv} != {exp["format_compliance"]["invalid_count"]}')
    ws = dims.get('whitespace', {}).get('issues', [])
    ws_hit = [i for i in ws if i.get('column') == exp['whitespace']['column']]
    lt = ws_hit[0].get('leading_trailing_spaces') if ws_hit else 0
    if lt < exp['whitespace']['leading_trailing_spaces']:
        errs.append(f'whitespace[{exp["whitespace"]["column"]}] = {lt} < {exp["whitespace"]["leading_trailing_spaces"]}')
    cc = dims.get('constant_columns', {}).get('issues', [])
    cc_hit = [i for i in cc if i.get('column') == exp['constant_columns']['column']]
    if not cc_hit:
        errs.append(f'constant_columns 缺 {exp["constant_columns"]["column"]}')
    elif str(cc_hit[0].get('constant_value')) != exp['constant_columns']['constant_value']:
        errs.append(f'constant_value = {cc_hit[0].get("constant_value")} != {exp["constant_columns"]["constant_value"]}')
    return errs


def v_splittest(root: Path) -> list:
    errs = []
    f = root / 'tests' / 'fixtures' / 'experiment-cases.json'
    script = root / 'scripts' / 'ab_test_analyze.py'
    if not f.is_file():
        return ['缺 experiment-cases.json']
    if not script.is_file():
        return ['缺 scripts/ab_test_analyze.py']
    d = json.loads(f.read_text(encoding='utf-8'))
    cases = d.get('cases', [])
    if len(cases) < 4:
        errs.append(f'案例数 {len(cases)} < 4')
    for c in cases:
        rid = c.get('id', '?')
        proc = subprocess.run([sys.executable, '-B', str(script), json.dumps(c['input'])],
                              capture_output=True, text=True, timeout=60)
        if proc.returncode != 0:
            errs.append(f'{rid} 脚本运行失败：{proc.stderr[-160:]}')
            continue
        out = json.loads(proc.stdout[proc.stdout.index('{'):])
        e = c.get('expected', {})
        if 'significant' in e and out['z_test']['significant'] != e['significant']:
            errs.append(f"{rid} significant={out['z_test']['significant']} != {e['significant']}")
        if 'srm_mismatch' in e and out['srm_check']['mismatch'] != e['srm_mismatch']:
            errs.append(f"{rid} srm.mismatch={out['srm_check']['mismatch']} != {e['srm_mismatch']}")
        ci = out['confidence_interval']
        if e.get('ci_contains_zero') and not (ci['lower'] < 0 < ci['upper']):
            errs.append(f"{rid} 置信区间未覆盖 0：[{ci['lower']}, {ci['upper']}]")
        if e.get('ci_upper_negative') and not ci['upper'] < 0:
            errs.append(f"{rid} 区间上界非负：{ci['upper']}")
        if 'warnings_count' in e and len(out.get('warnings', [])) != e['warnings_count']:
            errs.append(f"{rid} warnings={len(out.get('warnings', []))} != {e['warnings_count']}")
        if 'warning_keyword' in e:
            joined = ' '.join(out.get('warnings', [])) + out.get('recommendation', '')
            if e['warning_keyword'] not in joined:
                errs.append(f"{rid} 告警缺关键词：{e['warning_keyword']}")
        if e.get('direction') == 'decrease':
            if not out['conversion_rates']['treatment'] < out['conversion_rates']['control']:
                errs.append(f'{rid} direction 非 decrease')
    return errs


def v_stat(root: Path) -> list:
    errs = []
    f = root / 'tests' / 'fixtures' / 'caution-cases.json'
    if not f.is_file():
        return ['缺 caution-cases.json']
    d = json.loads(f.read_text(encoding='utf-8'))
    cases = d.get('cases', [])
    if len(cases) < 5:
        errs.append(f'案例数 {len(cases)} < 5')
    verdicts = set()
    for c in cases:
        rid = c.get('id', '?')
        e = c.get('expected', {})
        verdicts.add(e.get('verdict'))
        if e.get('verdict') not in VERDICTS:
            errs.append(f'{rid} verdict 非法：{e.get("verdict")}')
        if e.get('caution') not in CAUTIONS:
            errs.append(f'{rid} caution 非法：{e.get("caution")}')
        if not (e.get('must_flag') or []):
            errs.append(f'{rid} 缺 must_flag')
    if 'uncertain' not in verdicts or 'unsupported' not in verdicts:
        errs.append(f'结论档覆盖不足：{sorted(verdicts)}')
    return errs


def v_ca(root: Path) -> list:
    errs = []
    f = root / 'evals' / 'access-authorization-cases.json'
    if not f.is_file():
        return ['缺 access-authorization-cases.json']
    d = json.loads(f.read_text(encoding='utf-8'))
    evals = d.get('evals', [])
    if len(evals) < 3:
        errs.append(f'用例数 {len(evals)} < 3')
    ids = [e.get('id') for e in evals]
    if len(set(ids)) != len(ids):
        errs.append('用例 id 重复')
    joined = ''
    for e in evals:
        rid = e.get('id', '?')
        if not str(e.get('prompt') or '').strip():
            errs.append(f'{rid} 缺 prompt')
        if not str(e.get('expected_output') or '').strip():
            errs.append(f'{rid} 缺 expected_output')
        asr = e.get('assertions') or []
        if len(asr) < 4:
            errs.append(f'{rid} assertions {len(asr)} < 4')
        joined += ' '.join(asr)
    for kw in ('审批', '撤销', '脱敏', '最小权限', '回收'):
        if kw not in joined:
            errs.append(f'断言缺关键词：{kw}')
    return errs


VALIDATORS = {
    'leadership-strategy-playbook': v_leadership,
    'compliance-review-planner': v_crp,
    'skill-evaluator': v_skill_eval,
    'pricing-strategy': v_pricing,
    'ecommerce-ops': v_ecom,
    'validate-data': v_validate,
    'dataset-health-audit': v_dha,
    'split-test-evaluator': v_splittest,
    'statistical-analysis': v_stat,
    'compliance-audit': v_ca,
}

MUTATIONS = {
    'leadership-strategy-playbook': [
        ('m1 可逆性越枚举', 'tests/fixtures/decision-cases.yaml', 'reversibility: irreversible',
         'reversibility: permanent', '可逆性非法'),
        ('m2 自涉回避改写', 'tests/fixtures/decision-cases.yaml', '自涉者回避后由替补决定',
         '自涉者自行决定', '回避'),
    ],
    'compliance-review-planner': [
        ('m1 优先映射破坏', 'tests/fixtures/scenario-review-conclusions.csv', '不通过,高,P0',
         '不通过,高,P3', '优先映射错误'),
        ('m2 结论态越出', 'tests/fixtures/scenario-review-conclusions.csv', '待补证',
         '待核实', '结论非法'),
    ],
    'skill-evaluator': [
        ('m1 发布裁定破坏', 'tests/fixtures/evaluation-golden-cases.json', '"releasable": true',
         '"releasable": false', '发布裁定'),
        ('m2 severity 越枚举', 'tests/fixtures/evaluation-golden-cases.json', '"severity": "error"',
         '"severity": "fatal"', 'severity 非法'),
    ],
    'pricing-strategy': [
        ('m1 应付复算破坏', 'tests/fixtures/promo-stacking-cases.csv', '5.00,6.00,61.00',
         '5.00,6.00,55.00', '应付复算'),
        ('m2 拒绝判为允许', 'tests/fixtures/promo-stacking-cases.csv',
         'PS-03,100.00,券＋折扣,-,-,-,拒绝,券与折扣互斥（二选一）',
         'PS-03,100.00,券＋折扣,-,-,-,允许,券与折扣互斥（二选一）', '无法识别'),
    ],
    'ecommerce-ops': [
        ('m1 红线改写', 'tests/fixtures/storefront-verification-cases.csv', '不得先上后补',
         '允许先上后补', '不得先上后补'),
        ('m2 依据置空', 'tests/fixtures/storefront-verification-cases.csv', '不重复扣款,支付日志',
         '不重复扣款,', '缺 依据'),
    ],
    'validate-data': [
        ('m1 档位-发现项矛盾', 'tests/fixtures/metric-drift-cases.json',
         '"assessment": "ready_to_share"', '"assessment": "needs_revision"', '必备发现项'),
        ('m2 发现项删除', 'tests/fixtures/metric-drift-cases.json',
         '"required_findings": ["平台费"]', '"required_findings": []', '平台费'),
    ],
    'dataset-health-audit': [
        ('m1 缺值补齐', 'tests/fixtures/metric-table-sample.csv',
         '2026-09-02,DE,1150,44,9020.00,,7130.00,0',
         '2026-09-02,DE,1150,44,9020.00,0.00,7130.00,0', 'missing_values[refunds]'),
        ('m2 零填充破坏', 'tests/fixtures/metric-table-sample.csv',
         '2026-09-01,DE,1200,48,9600.00,120.00,7644.00,0',
         '2026-09-01,DE,1200,48,9600.00,120.00,7644.00,1', 'constant_columns'),
    ],
    'split-test-evaluator': [
        ('m1 读数-期望破坏', 'tests/fixtures/experiment-cases.json',
         '"treatment_conversions": 4}', '"treatment_conversions": 404}', 'warnings'),
        ('m2 期望方向破坏', 'tests/fixtures/experiment-cases.json',
         '"significant": false, "srm_mismatch": false, "ci_contains_zero": true',
         '"significant": true, "srm_mismatch": false, "ci_contains_zero": true', 'significant'),
    ],
    'statistical-analysis': [
        ('m1 caution 越枚举', 'tests/fixtures/caution-cases.json', '"caution": "confounding"',
         '"caution": "correlation"', 'caution 非法'),
        ('m2 结论档破坏', 'tests/fixtures/caution-cases.json',
         '"verdict": "unsupported"', '"verdict": "supported"', '结论档覆盖不足'),
    ],
    'compliance-audit': [
        ('m1 审批关键词改写', 'evals/access-authorization-cases.json', '审批', '处理', '审批'),
        ('m2 撤销关键词改写', 'evals/access-authorization-cases.json', '撤销', '续期', '撤销'),
    ],
}


def run_mutation(name: str, root: Path, label, rel, old, new, expect) -> tuple:
    tmp = Path(tempfile.mkdtemp(prefix=f'gx2-{name[:8]}-'))
    try:
        dst = tmp / root.name
        shutil.copytree(root, dst)
        tgt = dst / rel
        if not tgt.is_file():
            return False, f'突变目标文件不存在（{rel}）'
        text = tgt.read_text(encoding='utf-8')
        n = text.count(old)
        if n == 0:
            return False, f'突变目标不存在（{old[:40]}）'
        tgt.write_text(text.replace(old, new), encoding='utf-8')
        errs = VALIDATORS[name](dst)
        if not errs:
            return False, '突变后未判红（假绿）'
        if not any(expect in e for e in errs):
            return False, f'判红但未命中预期「{expect}」：{errs[:2]}'
        return True, f'红 ✓（{errs[0][:64]}…；全替 {n} 处）'
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
