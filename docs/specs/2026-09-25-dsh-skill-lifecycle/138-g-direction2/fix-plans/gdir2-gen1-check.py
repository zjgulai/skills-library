#!/usr/bin/env python3
"""G 去向②新技能制作 —— gen1 候选校验器（零请求、静态、带负控矩阵）

对四件新制作候选（candidates/<name>-gen1）做三类检查：
  A. 结构：SKILL.md frontmatter（name/version/complexity/license/compatibility/description
     长度与负向边界）、References 引用存在性（死链）与完备性、正文长度、evals schema
  B. 内容一致性：从产物文件解析数字/规则并复算
     - hardware-quality-closure：闭环链编号、复测口径、批次守恒、D6 硬线
     - warranty-claim-adjudication：时限矩阵、卫生红线、转交硬线、难例工单
     - tax-position-review：双链路口径、低值闸门、期间与边界声明
     - market-access-gate：证据引用、过渡期降档、待补证降级、宣称绑定
  C. 负控矩阵：每件 3 突变 → 必须判红（含预期错误类别关键词）

用法：python3 -B gdir2-gen1-check.py [--name <name>]
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

ITEMS = ['hardware-quality-closure', 'warranty-claim-adjudication',
         'tax-position-review', 'market-access-gate']


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


def v_hardware(root: Path) -> list:
    errs = check_common(root, 'hardware-quality-closure')
    for r in ['references/validation-chain.md', 'references/8d-capa-rules.md',
              'references/batch-traceability.md', 'references/examples/worked-example.md']:
        if not (root / r).is_file():
            errs.append(f'缺 {r}')
    ex = root / 'references' / 'examples' / 'worked-example.md'
    if ex.is_file():
        t = ex.read_text(encoding='utf-8')
        for token in ('TR-2608-02', 'DEF-001', 'ECO-2604', 'TR-2609-05', 'CAPA-2609-01',
                      '2/12', '12/12', 'KC-06', '2.58–2.62', '3200'):
            if token not in t:
                errs.append(f'关键数字/编号缺失：{token}')
        if not ('1050' in t and '1100' in t and 'FBA-2608-A' in t):
            errs.append('守恒数字/去向缺失：1050/1100/FBA-2608-A')
    skill_text = (root / 'SKILL.md').read_text(encoding='utf-8')
    if '无 D6 复测数据不得关闭' not in skill_text:
        errs.append('SKILL.md 缺「无 D6 复测数据不得关闭」硬线')
    bt = root / 'references' / 'batch-traceability.md'
    if bt.is_file() and '投产＝良品＋不良' not in bt.read_text(encoding='utf-8'):
        errs.append('追溯守恒口径缺失（投产＝良品＋不良）')
    if not (root / 'tests' / 'test_quality_closure_rules.py').is_file():
        errs.append('缺 tests/test_quality_closure_rules.py')
    return errs


def v_warranty(root: Path) -> list:
    errs = check_common(root, 'warranty-claim-adjudication')
    for r in ['references/policy-matrix.md', 'references/adjudication-rules.md',
              'references/examples/worked-example.md']:
        if not (root / r).is_file():
            errs.append(f'缺 {r}')
    pm = root / 'references' / 'policy-matrix.md'
    if pm.is_file():
        t = pm.read_text(encoding='utf-8')
        for token in ('30 天', '31–90 天', '7 天', '14 天', '卫生', '赔付上限', '实付金额'):
            if token not in t:
                errs.append(f'时限/红线缺失：{token}')
    ar = root / 'references' / 'adjudication-rules.md'
    if ar.is_file():
        t = ar.read_text(encoding='utf-8')
        if '不得自行判断' not in t:
            errs.append('健康类转交硬线缺失（不得自行判断）')
        if '超保' not in t:
            errs.append('超保通道缺失')
    ex = root / 'references' / 'examples' / 'worked-example.md'
    if ex.is_file():
        t = ex.read_text(encoding='utf-8')
        for token in ('TK-6001', 'TK-6002', 'TK-6003', 'TK-6004', 'TK-6005'):
            if token not in t:
                errs.append(f'难例工单缺失：{token}')
    return errs


def v_tax(root: Path) -> list:
    errs = check_common(root, 'tax-position-review')
    for r in ['references/position-rules.md', 'references/examples/worked-example.md']:
        if not (root / r).is_file():
            errs.append(f'缺 {r}')
    pr = root / 'references' / 'position-rules.md'
    if pr.is_file():
        t = pr.read_text(encoding='utf-8')
        for token in ('分开建账', '≤ €150', 'nexus'):
            if token not in t:
                errs.append(f'口径规则缺失：{token}')
    ex = root / 'references' / 'examples' / 'worked-example.md'
    if ex.is_file():
        t = ex.read_text(encoding='utf-8')
        for token in ('19%', '20%', 'IOSS', '€150', 'ELSTER', 'MTD', '待确认'):
            if token not in t:
                errs.append(f'算例口径缺失：{token}')
    skill_text = (root / 'SKILL.md').read_text(encoding='utf-8')
    if '不构成税务意见' not in skill_text:
        errs.append('边界声明缺失（不构成税务意见）')
    return errs


def v_access(root: Path) -> list:
    errs = check_common(root, 'market-access-gate')
    for r in ['references/evidence-chain.md', 'references/examples/worked-example.md']:
        if not (root / r).is_file():
            errs.append(f'缺 {r}')
    ec = root / 'references' / 'evidence-chain.md'
    if ec.is_file():
        t = ec.read_text(encoding='utf-8')
        for token in ('宣称与证据绑定', '三性', '临期'):
            if token not in t:
                errs.append(f'证据规则缺失：{token}')
    ex = root / 'references' / 'examples' / 'worked-example.md'
    if ex.is_file():
        t = ex.read_text(encoding='utf-8')
        for token in ('MOCK-CE-24071', 'MOCK-CE-24072', 'MOCK-EN71-2405', 'MOCK-CPC-2413', 'MOCK-REACH-2408'):
            if token not in t:
                errs.append(f'证据引用缺失：{token}')
        if '可准入（过渡期条款待确认）' not in t:
            errs.append('过渡期降档结论缺失')
        lines = [l for l in t.splitlines() if '湿巾' in l]
        if not lines or '待补证' not in lines[0]:
            errs.append('缺待补证降级（湿巾行）')
    if not (root / 'tests' / 'test_access_rules.py').is_file():
        errs.append('缺 tests/test_access_rules.py')
    return errs


VALIDATORS = {
    'hardware-quality-closure': v_hardware,
    'warranty-claim-adjudication': v_warranty,
    'tax-position-review': v_tax,
    'market-access-gate': v_access,
}

MUTATIONS = {
    'hardware-quality-closure': [
        ('m1 复测通过数破坏', 'references/examples/worked-example.md', '12/12', '11/12', '关键数字'),
        ('m2 关闭硬线破坏', 'SKILL.md', '无 D6 复测数据不得关闭', '整改后即可关闭', '硬线'),
        ('m3 追溯守恒破坏', 'references/batch-traceability.md', '投产＝良品＋不良', '投产≈良品＋不良', '守恒'),
    ],
    'warranty-claim-adjudication': [
        ('m1 时限矩阵破坏', 'references/policy-matrix.md', '30 天', '60 天', '时限'),
        ('m2 转交硬线破坏', 'references/adjudication-rules.md', '不得自行判断', '可酌情判断', '转交'),
        ('m3 难例工单破坏', 'references/examples/worked-example.md', 'TK-6002', 'TK-6009', '工单'),
    ],
    'tax-position-review': [
        ('m1 低值闸门破坏', 'references/position-rules.md', '≤ €150', '≤ €500', '口径规则'),
        ('m2 双链路破坏', 'references/position-rules.md', '分开建账', '合并建账', '分开建账'),
        ('m3 边界声明破坏', 'SKILL.md', '不构成税务意见', '构成税务意见', '边界'),
    ],
    'market-access-gate': [
        ('m1 证据引用破坏', 'references/examples/worked-example.md', 'MOCK-REACH-2408', 'MOCK-REACH-2409', '证据引用'),
        ('m2 宣称绑定破坏', 'references/evidence-chain.md', '宣称与证据绑定', '宣称可先上', '证据规则'),
        ('m3 待补证降级破坏', 'references/examples/worked-example.md', '待补证', '可准入', '待补证'),
    ],
}


def run_mutation(name: str, root: Path, label, rel, old, new, expect) -> tuple:
    tmp = Path(tempfile.mkdtemp(prefix=f'gdir2m-{name[:8]}-'))
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
