#!/usr/bin/env python3
"""R-3 去向②新技能制作 —— gen1 候选校验器（零请求、静态、带负控矩阵）

对两件新制作候选（candidates/<name>-gen1）做三类检查：
  A. 结构：SKILL.md frontmatter（name/version/complexity/license/compatibility/description
     长度与负向边界）、References 引用存在性（死链）、正文长度、evals schema
  B. 内容一致性：从产物文件解析数字/规则并复算
     - channel-settlement-reconciliation：批次行内恒等式、渠道合计、现金桥、VAT memo
     - returns-disposition：闭合 6=3+3、红线清单完整性、状态机终态
  C. 负控矩阵：每件 ≥2 突变 → 必须判红（含预期错误类别关键词）

用法：python3 -B dir2-gen1-check.py [--name <name>]
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

import importlib.util
_spec = importlib.util.spec_from_file_location('dir2build', HERE / 'dir2-build.py')
ITEMS = ['channel-settlement-reconciliation', 'returns-disposition']


def num(s: str) -> float:
    s = s.strip().replace(',', '').replace('\u2212', '-').replace('\u2013', '-')
    return float(s.lstrip('+'))


def parse_table_rows(text: str, prefix: str):
    rows = []
    for line in text.splitlines():
        if line.startswith('|') and prefix in line:
            rows.append([c.strip() for c in line.strip('|').split('|')])
    return rows


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


def v_channel(root: Path) -> list:
    errs = check_common(root, 'channel-settlement-reconciliation')
    ex = root / 'references' / 'examples' / 'worked-example.md'
    if not ex.is_file():
        errs.append('缺 worked-example.md')
        return errs
    text = ex.read_text(encoding='utf-8')
    rows = parse_table_rows(text, 'A-2026-') + parse_table_rows(text, 'B-2026-')
    if len(rows) != 6:
        errs.append(f'算例批次表行数 {len(rows)} != 6')
    totals = {'A': 0.0, 'B': 0.0}
    for r in rows:
        batch, orders, refunds, fees, claw, adj, net = r[0], num(r[1]), num(r[2]), num(r[3]), num(r[4]), num(r[5]), num(r[6])
        calc = orders + refunds - fees - claw + adj
        if abs(calc - net) > 0.005:
            errs.append(f'{batch} 行内恒等式不符：{calc:.2f} != {net:.2f}')
        totals[batch[0]] += net
    if abs(totals['A'] - 1987.78) > 0.005 or abs(totals['B'] - 945.79) > 0.005:
        errs.append(f"渠道合计不符：A {totals['A']:.2f} / B {totals['B']:.2f}")
    for token in ('2,107.02', '15,817.57', '5,196.66', '911.67', '191.03'):
        if token not in text:
            errs.append(f'算例缺关键数字 {token}')
    skill_text = (root / 'SKILL.md').read_text(encoding='utf-8')
    if '不做过账' not in skill_text and '不执行调整、不过账' not in skill_text:
        errs.append('SKILL.md 缺「不过账」边界')
    return errs


def v_returns(root: Path) -> list:
    errs = check_common(root, 'returns-disposition')
    ex = root / 'references' / 'examples' / 'worked-example.md'
    sm = root / 'references' / 'state-machine.md'
    hp = root / 'references' / 'hygiene-policy.md'
    for f, label in [(ex, 'worked-example.md'), (sm, 'state-machine.md'), (hp, 'hygiene-policy.md')]:
        if not f.is_file():
            errs.append(f'缺 {label}')
    if not (root / 'tests' / 'test_disposition_rules.py').is_file():
        errs.append('缺 tests/test_disposition_rules.py')
    if errs:
        return errs
    ex_text = ex.read_text(encoding='utf-8')
    for token in ('6 = 复售 3 + 报废 3', 'QUARANTINE', 'DISPOSED'):
        if token not in ex_text:
            errs.append(f'闭合核验/状态标注缺 {token}')
    hp_text = hp.read_text(encoding='utf-8')
    for red in ('已开封', '封口破损', '批次不可追溯', '召回'):
        if red not in hp_text:
            errs.append(f'卫生红线缺 {red}')
    sm_text = sm.read_text(encoding='utf-8')
    for st in ('QUARANTINE', 'RESELL_READY', 'DISPOSED', 'QC_HOLD', 'DAMAGED_CLAIM'):
        if st not in sm_text:
            errs.append(f'状态机缺 {st}')
    if '（终态）' not in sm_text:
        errs.append('状态机缺 DISPOSED 终态标注')
    return errs


VALIDATORS = {
    'channel-settlement-reconciliation': v_channel,
    'returns-disposition': v_returns,
}

MUTATIONS = {
    'channel-settlement-reconciliation': [
        ('m1 批次净额改错', 'references/examples/worked-example.md', '1,076.11', '1,076.12', '恒等式'),
        ('m2 删引用行引用', 'SKILL.md', '`references/settlement-checks.md`', '`references/removed.md`', '死链'),
        ('m3 evals 字段缺失', 'evals/evals.json', '"assertions"', '"assertions_x"', 'evals'),
    ],
    'returns-disposition': [
        ('m1 闭合破坏', 'references/examples/worked-example.md', '6 = 复售 3 + 报废 3', '6 = 复售 4 + 报废 2', '闭合'),
        ('m2 红线缺失', 'references/hygiene-policy.md', '批次不可追溯', '批次信息', '红线'),
        ('m3 终态破坏', 'references/state-machine.md', '（终态）', '→ AVAILABLE', '终态'),
    ],
}


def run_mutation(name: str, root: Path, label, rel, old, new, expect) -> tuple:
    tmp = Path(tempfile.mkdtemp(prefix=f'dir2m-{name[:8]}-'))
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
