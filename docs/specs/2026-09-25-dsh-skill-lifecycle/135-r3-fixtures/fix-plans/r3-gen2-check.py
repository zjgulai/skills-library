#!/usr/bin/env python3
"""R-3 去向①夹具增强批 —— gen2 候选校验器（零请求、静态、带负控矩阵）

对五件候选（candidates/<name>-gen2）做三类检查：
  A. 结构：SKILL.md 引用行（对账族三件）、evals.json schema、新文件齐全、正文 <8000
  B. 数字一致性：从产物文件解析数字并复算恒等式
     - reconciliation：批次行内恒等式、渠道合计、FX 折算、现金桥
     - journal-entry-prep：Batch summary 借贷合计、关键金额出现
     - cash-flow-snapshot：现金桥与窗口数字出现
     - supplier-evaluation：PO 金额、差异归因、收货闭合
     - inventory-demand-forecaster：库龄规则复算、退货闭合、状态机
  C. 负控矩阵：每件 ≥2 个突变 → 必须判红（含预期错误类别关键词）

用法：python3 -B r3-gen2-check.py [--name <name>]
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

NUM = re.compile(r'^[+\u2212\u2013-]?[\d,]+(?:\.\d+)?$')


def num(s: str) -> float:
    s = s.strip().replace(',', '').replace('\u2212', '-').replace('\u2013', '-')
    s = s.lstrip('+')
    return float(s)


def parse_table_rows(text: str, prefix: str):
    """解析形如 '| A-2026-… | … |' 的 md 表格行 → list[list[str]]。"""
    rows = []
    for line in text.splitlines():
        if line.startswith('|') and prefix in line:
            cells = [c.strip() for c in line.strip('|').split('|')]
            rows.append(cells)
    return rows


def load_csv(path: Path):
    with open(path, encoding='utf-8') as f:
        return list(csv.DictReader(f))


def load_evals(root: Path, skill_name: str) -> list:
    errs = []
    p = root / 'evals' / 'evals.json'
    if not p.is_file():
        return ['缺 evals/evals.json']
    try:
        d = json.loads(p.read_text(encoding='utf-8'))
    except Exception as e:
        return [f'evals.json 解析失败：{e}']
    if d.get('skill_name') != skill_name:
        errs.append(f"evals skill_name 不匹配：{d.get('skill_name')}")
    evs = d.get('evals')
    if not isinstance(evs, list) or len(evs) < 3:
        errs.append(f'evals 题数不足：{len(evs) if isinstance(evs, list) else evs}')
        return errs
    for e in evs:
        for k in ('id', 'prompt', 'expected_output', 'assertions'):
            if k not in e:
                errs.append(f"evals id={e.get('id')} 缺字段 {k}")
        if len(e.get('assertions', [])) < 3:
            errs.append(f"evals id={e.get('id')} assertions 少于 3")
    return errs


def body_len(skill_md: Path):
    text = skill_md.read_text(encoding='utf-8')
    m = re.match(r'^---\n.*?\n---\n(.*)$', text, re.S)
    return len(m.group(1).encode('utf-8')) if m else None


# ---------- 逐件 validate ----------

def v_reconciliation(root: Path) -> list:
    errs = []
    ex = root / 'references' / 'examples' / 'channel-settlement-example.md'
    if not ex.is_file():
        return ['缺 channel-settlement-example.md']
    text = ex.read_text(encoding='utf-8')
    rows = [r for r in parse_table_rows(text, 'A-2026-') + parse_table_rows(text, 'B-2026-')]
    if len(rows) != 6:
        errs.append(f'批次表行数 {len(rows)} != 6')
    totals = {'A': 0.0, 'B': 0.0}
    for r in rows:
        batch, orders, refunds, fees, claw, adj, net = r[0], num(r[2]), num(r[3]), num(r[4]), num(r[5]), num(r[6]), num(r[7])
        calc = orders + refunds - fees - claw + adj
        if abs(calc - net) > 0.005:
            errs.append(f'{batch} 行内恒等式不符：calc {calc:.2f} != net {net:.2f}')
        totals[batch[0]] += net
    if abs(totals['A'] - 1987.78) > 0.005:
        errs.append(f"A 渠道合计 {totals['A']:.2f} != 1,987.78")
    if abs(totals['B'] - 945.79) > 0.005:
        errs.append(f"B 渠道合计 {totals['B']:.2f} != 945.79")
    # FX 与现金桥（文档内数字必须出现；内嵌复算）
    for token in ('2,107.02', '15,817.57', '5,196.66', '911.67', '191.03'):
        if token not in text:
            errs.append(f'算例缺关键数字 {token}')
    b_usd = round(945.79 * 1.09, 2)
    if abs(1076.11 + b_usd - 2107.02) > 0.005:
        errs.append('净现金流入复算不符')
    if abs(8500 + 1000 * 1.09 + 5196.66 + b_usd - 15817.57) > 0.005:
        errs.append('期末银行复算不符')
    skill = root / 'SKILL.md'
    want = 'channel-settlement-example.md'
    if want not in skill.read_text(encoding='utf-8'):
        errs.append('SKILL.md 缺引用行（channel-settlement-example.md）')
    bl = body_len(skill)
    if bl is None or bl >= 8000:
        errs.append(f'SKILL.md body 越界：{bl}')
    errs += load_evals(root, 'reconciliation')
    return errs


def v_journal(root: Path) -> list:
    errs = []
    ex = root / 'references' / 'examples' / 'settlement-journal-example.md'
    if not ex.is_file():
        return ['缺 settlement-journal-example.md']
    text = ex.read_text(encoding='utf-8')
    total_lines = [l for l in text.splitlines() if '**Total**' in l]
    if len(total_lines) != 1:
        errs.append(f'Batch summary Total 行数 {len(total_lines)} != 1')
    else:
        cells = [c.strip(' *') for c in total_lines[0].strip('|').split('|')]
        d, c = num(cells[1]), num(cells[2])
        if abs(d - c) > 0.005:
            errs.append(f'借贷合计不相等：{d} vs {c}')
        if abs(d - 4955.47) > 0.005:
            errs.append(f'汇总 {d:.2f} != 4,955.47')
    inner = round(1076.11 * 2 + 945.79 * 2 + 911.67, 2)
    if abs(inner - 4955.47) > 0.005:
        errs.append('内嵌复算不符')
    for token in ('A-2026-08-15', 'A-2026-09-02', '945.79', '4,955.47', '191.03'):
        if token not in text:
            errs.append(f'算例缺关键数字/批次 {token}')
    skill = root / 'SKILL.md'
    if 'settlement-journal-example.md' not in skill.read_text(encoding='utf-8'):
        errs.append('SKILL.md 缺引用行（settlement-journal-example.md）')
    bl = body_len(skill)
    if bl is None or bl >= 8000:
        errs.append(f'SKILL.md body 越界：{bl}')
    errs += load_evals(root, 'journal-entry-prep')
    return errs


def v_cashflow(root: Path) -> list:
    errs = []
    ex = root / 'references' / 'examples' / 'settlement-cash-timing-example.md'
    if not ex.is_file():
        return ['缺 settlement-cash-timing-example.md']
    text = ex.read_text(encoding='utf-8')
    for token in ('15,817.57', '16,729.24', '11,009.24', '5,720.00', '13,309.24', '911.67'):
        if token not in text:
            errs.append(f'算例缺关键数字 {token}')
    if abs(round(3000 + 420 + 800 + 1500, 2) - 5720.00) > 0.005:
        errs.append('承诺支出复算不符')
    if abs(round(15817.57 + 911.67, 2) - 16729.24) > 0.005:
        errs.append('30 天窗复算不符')
    if abs(round(16729.24 - 5720.00, 2) - 11009.24) > 0.005:
        errs.append('60 天窗复算不符')
    skill = root / 'SKILL.md'
    if 'settlement-cash-timing-example.md' not in skill.read_text(encoding='utf-8'):
        errs.append('SKILL.md 缺引用行（settlement-cash-timing-example.md）')
    bl = body_len(skill)
    if bl is None or bl >= 8000:
        errs.append(f'SKILL.md body 越界：{bl}')
    errs += load_evals(root, 'cash-flow-snapshot')
    return errs


def v_supplier(root: Path) -> list:
    errs = []
    fx = root / 'tests' / 'fixtures' / 'po-three-way'
    need = ['po.csv', 'receipts.csv', 'invoices.csv', 'README.md']
    for f in need:
        if not (fx / f).is_file():
            errs.append(f'缺夹具 {f}')
    if errs:
        return errs
    po = load_csv(fx / 'po.csv')
    totals = {}
    for r in po:
        amt = round(int(r['订购数量']) * float(r['单价USD']), 2)
        if abs(amt - float(r['金额USD'])) > 0.005:
            errs.append(f"{r['采购单']}/{r['SKU']} 金额≠数量×单价")
        totals[r['采购单']] = totals.get(r['采购单'], 0.0) + float(r['金额USD'])
    if abs(totals['PO-1101'] - 4300.00) > 0.005 or abs(totals['PO-1102'] - 3438.00) > 0.005:
        errs.append(f'PO 合计不符：{totals}')
    rec = load_csv(fx / 'receipts.csv')
    agg = {}
    for r in rec:
        k = (r['采购单'], r['SKU'])
        agg.setdefault(k, {'o': int(r['订购数量']), 'r': 0, 'out': 0})
        agg[k]['r'] += int(r['实收数量'])
        agg[k]['out'] = int(r['未交数量'])
    for k, v in agg.items():
        if v['r'] + v['out'] != v['o']:
            errs.append(f'{k} 收货不闭合：{v}')
    inv = load_csv(fx / 'invoices.csv')
    by = {r['发票号']: r for r in inv}
    a, b = by.get('INV-A-2601'), by.get('INV-B-2602')
    if not a or not b:
        errs.append('发票行缺失')
    else:
        if abs(num(a['差异USD']) - round(10 * 1.45, 2)) > 0.005:
            errs.append('INV-A 差异归因不符')
        if abs(num(b['差异USD']) - round(20 * 0.62, 2)) > 0.005:
            errs.append('INV-B 差异归因不符')
        if a['状态'] != '索赔中' or 'CN-B-2601' not in b['处置'] or b['状态'] != '已结':
            errs.append('发票处置状态不符')
    if not (root / 'tests' / 'test_po_three_way.py').is_file():
        errs.append('缺 tests/test_po_three_way.py')
    errs += load_evals(root, 'supplier-evaluation')
    return errs


def v_inventory(root: Path) -> list:
    errs = []
    fx = root / 'tests' / 'fixtures' / 'aging-disposal'
    for f in ['aging.csv', 'states.csv', 'returns.csv', 'README.md']:
        if not (fx / f).is_file():
            errs.append(f'缺夹具 {f}')
    if errs:
        return errs
    aging = load_csv(fx / 'aging.csv')
    for r in aging:
        age, wk, shelf = int(r['库龄天数']), int(r['近90天周均']), r['保质期状态']
        if age > 180 and wk < 15:
            exp = '清货'
        elif 90 <= age <= 180 and wk < 15:
            exp = '监控'
        elif shelf.startswith('保质期至'):
            exp = '正常销售 + 临期预警' if '临期' in shelf else '正常销售'
        else:
            exp = '正常销售'
        if not r['建议处置'].startswith(exp.split('（')[0]):
            errs.append(f"{r['SKU']} 处置 {r['建议处置']} 与规则复算 {exp} 不符")
    ret = load_csv(fx / 'returns.csv')
    total = sum(int(r['数量']) for r in ret)
    resell = sum(int(r['数量']) for r in ret if '复售' in r['处置'])
    scrap = sum(int(r['数量']) for r in ret if r['处置'] == '报废')
    if not (total == 6 and resell == 3 and scrap == 3 and total == resell + scrap):
        errs.append(f'退货闭合不符：总 {total} 复售 {resell} 报废 {scrap}')
    for r in ret:
        if r['卫生检查'] != '通过' and '复售' in r['处置']:
            errs.append(f"{r['RMA单号']} 未过卫生检查却复售")
    states = {r['状态码']: r for r in load_csv(fx / 'states.csv')}
    if states.get('DISPOSED', {}).get('允许流转') != '（终态）':
        errs.append('DISPOSED 非终态')
    q = states.get('QUARANTINE', {}).get('允许流转', '')
    if 'RESELL_READY' not in q or 'DISPOSED' not in q:
        errs.append('QUARANTINE 流转缺项')
    if not (root / 'tests' / 'test_aging_disposal.py').is_file():
        errs.append('缺 tests/test_aging_disposal.py')
    errs += load_evals(root, 'inventory-demand-forecaster')
    return errs


VALIDATORS = {
    'reconciliation': v_reconciliation,
    'journal-entry-prep': v_journal,
    'cash-flow-snapshot': v_cashflow,
    'supplier-evaluation': v_supplier,
    'inventory-demand-forecaster': v_inventory,
}

# 负控突变：name → [(label, rel_path, old, new, expect_keyword)]
MUTATIONS = {
    'reconciliation': [
        ('m1 批次净额改错', 'references/examples/channel-settlement-example.md', '1,076.11', '1,076.12', '恒等式'),
        ('m2 删 SKILL.md 引用行', 'SKILL.md', '| `references/examples/channel-settlement-example.md` |', '', '引用行'),
        ('m3 evals 字段缺失', 'evals/evals.json', '"assertions"', '"assertions_x"', 'evals'),
    ],
    'journal-entry-prep': [
        ('m1 汇总改错', 'references/examples/settlement-journal-example.md', '4,955.47', '4,955.48', '汇总'),
        ('m2 删 SKILL.md 引用行', 'SKILL.md', '| `references/examples/settlement-journal-example.md` |', '', '引用行'),
    ],
    'cash-flow-snapshot': [
        ('m1 30 天窗数字改错', 'references/examples/settlement-cash-timing-example.md', '16,729.24', '16,730.24', '16,729.24'),
        ('m2 删 SKILL.md 引用行', 'SKILL.md', '| `references/examples/settlement-cash-timing-example.md` |', '', '引用行'),
    ],
    'supplier-evaluation': [
        ('m1 PO 单价改错', 'tests/fixtures/po-three-way/po.csv', '1200,1.45,1740.0', '1200,1.46,1740.0', '金额'),
        ('m2 发票差异改错', 'tests/fixtures/po-three-way/invoices.csv', '14.5,', '14.6,', '差异'),
        ('m3 收货闭合破坏', 'tests/fixtures/po-three-way/receipts.csv', '600,600,0,0', '600,590,0,0', '闭合'),
    ],
    'inventory-demand-forecaster': [
        ('m1 库龄规则失配', 'tests/fixtures/aging-disposal/aging.csv', '189,1190,12,', '189,1190,16,', '不符'),
        ('m2 退货闭合破坏', 'tests/fixtures/aging-disposal/returns.csv', '报废', '复售', '闭合'),
        ('m3 终态破坏', 'tests/fixtures/aging-disposal/states.csv', '（终态）', '→ AVAILABLE', '终态'),
    ],
}


def run_mutation(name: str, root: Path, label, rel, old, new, expect) -> tuple:
    tmp = Path(tempfile.mkdtemp(prefix=f'r3m-{name}-'))
    try:
        dst = tmp / f'{name}-gen2'
        shutil.copytree(root, dst)
        tgt = dst / rel
        text = tgt.read_text(encoding='utf-8')
        cnt = text.count(old)
        if cnt == 0:
            return False, f'突变目标不存在（{old[:40]}）'
        tgt.write_text(text.replace(old, new), encoding='utf-8')
        errs = VALIDATORS[name](dst)
        if not errs:
            return False, '突变后未判红（假绿）'
        if not any(expect in e for e in errs):
            return False, f'判红但未命中预期类别「{expect}」：{errs[:2]}'
        return True, f'红 ✓（{errs[0][:60]}…）'
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--name')
    args = ap.parse_args()
    names = [args.name] if args.name else list(VALIDATORS)
    overall = True
    for name in names:
        root = CAND / f'{name}-gen2'
        print(f'=== {name}-gen2 ===')
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
        muts = MUTATIONS.get(name, [])
        for (label, rel, old, new, expect) in muts:
            ok, detail = run_mutation(name, root, label, rel, old, new, expect)
            print(f"  [负控] {label}: {'红 ✓' if ok else 'FAIL'} — {detail}")
            passed += 1 if ok else 0
        print(f"  [负控汇总] {passed}/{len(muts)}")
        if passed != len(muts):
            overall = False
    print()
    print('RESULT:', 'PASS' if overall else 'FAIL')
    sys.exit(0 if overall else 1)


if __name__ == '__main__':
    main()
