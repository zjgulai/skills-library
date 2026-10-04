#!/usr/bin/env python3
"""闭环台账生成器（loop-ledger v1）：为已投影的指定集逐一落「补全/优化/分类/装配」四态与缺口。

口径（与 105 号方案、108 号台账、Q1—Q7 拍板一致）：
- 指定集 = `_assembly-v1` 首批 173 件（A 81-Skills 81 ＋ B 角色候选达标件 91 ＋ C 平铺试点 1）；
- 分类态：机器路由 v1（routeV1）＋ Sage 既有归位表（role-assignments.json，293 条）交叉核对，
  两者不一致只登记不一致（不合并真相源、不覆盖 v1 路由）；
- 补全态：缺陷登记册命中（repair-pending → 未闭环；registered/blocked → 已登记闭环）＋四层验证 L3 缺失引用；
- 优化态：A 组以历史读数认账（Q2：不重跑）；读数与批次记录逐件挂钩；B/C 组无优化证据 → missing；
- 装配态：batch1-projected（回执 w1-batch1-2026-09-30）；受控更新（Q3）后由回填脚本改状态。

用法：python3 loop-ledger-make.py [--out-dir <dir>] [--append] [--tag v1|v2]
      （默认写入 109-loop-ledger/；--append 并入追加集登记册＝v2 修订草案新增，
       未加 --append 时行为与现行逐字节一致——回归由收据验证）
"""
import argparse
import csv
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

SPEC = Path(__file__).resolve().parents[3] / 'docs/specs/2026-09-25-dsh-skill-lifecycle'
DEFAULT_OUT = SPEC / '109-loop-ledger'
PLAN = SPEC / '107-w1-assembly/assembly-plan-v1-batch1.json'
CLASS_CSV = SPEC / '108-w2-classification/classification-projection-v1.csv'
DEFECTS = SPEC / '106-w0-governance/defect-sensitivity-registry-v1.json'
VERIFY = SPEC / '107-w1-assembly/assembly-batch1-verify.json'
SCREEN = SPEC / '107-w1-assembly/assembly-screen.json'
W4_FIX_STATE = SPEC / '111-w4-fixes/w4-fix-state.json'
# 优化进度源集：progress 文件 → 对应记录文档。先按此清单并入；同件多源时后者覆盖（新批次在读）。
OPT_PROGRESS = [
    (SPEC / '112-q5-batch1/q5-progress.json', '112-Q5首批执行记录.md'),
    (SPEC / '122-r2-prep/progress.json', '122-R2校准批准备与全量批次表预案.md'),
    (SPEC / '122-r2-prep/b1-progress.json', '124-B1批次执行记录.md'),
    (SPEC / '122-r2-prep/sp-huashu-progress.json', '125-SP-huashu小批执行记录.md'),
    (SPEC / '122-r2-prep/b2-progress.json', '127-B2批次执行记录.md'),
    (SPEC / '122-r2-prep/b3-progress.json', '128-B3批次执行记录.md'),
    (SPEC / '122-r2-prep/b4-progress.json', '129-B4批次执行记录.md'),
    (SPEC / '122-r2-prep/b5-progress.json', '130-B5批次执行记录.md'),
    (SPEC / '122-r2-prep/seo-progress.json', '132-seo收尾修复记录（gen1）.md'),
]
BATCH_STATE = Path(__file__).resolve().parents[1] / 'opt-run/batch-state.json'
SAGE_ROLES = Path('/Users/lute/project/Sage/packages/capabilities/dsh-overseas-skills/manifest/role-assignments.json')
KIMI = Path('/Users/lute/project/Sage/packages/capabilities/overseas-skills')

# 批次 → 记录文档（批量优化弧线：批一=69 号，批二=70 号，批三起步进 72 号……批二十五起跳号）
CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四',
      '十五', '十六', '十七', '十八', '十九', '二十', '二十一', '二十二', '二十三', '二十四']
BATCH_DOC = {'top': '69-批量优化方案与批一记录.md'}
for b in range(3, 25):
    BATCH_DOC[f'batch{b}'] = f'{b + 69}-批{CN[b - 1]}记录.md'
BATCH_DOC.update({'batch25': '97-批二十五记录.md', 'batch26': '99-批二十六记录.md',
                  'batch27': '100-批二十七记录.md', 'batch28': '101-批二十八记录.md'})
# 未进 batch-state 的四件（早期两例 + 批二两件）：读数与记录文档从各自记录文档取
OPT_EXCEPTIONS = {
    'amz-product-optimizer': {'doc': '64-真实优化第一例记录.md',
        'readings': '93.5（R3 终评；弧线 88.5/91 → 91/91.5 → 93.5，见 64 号）'},
    'skill-family-manager': {'doc': '66/67/68 号（第二例族）',
        'readings': '98.0（gen-2 终评，零 error；n=1 不作稳定值，见 68 号）'},
    'ecommerce-analytics-controller': {'doc': '70-批二记录.md',
        'readings': '85/91.5（gen-1 两跑；gen-3 增量无 live 读数，如实登记）'},
    'optimize-ecommerce-page-conversion': {'doc': '70-批二记录.md',
        'readings': '91.5/92.5（gen-1 两跑）'},
}
Q5_BATCH1 = ['cash-flow-snapshot', 'runway-calculator', 'margin-analyzer', 'financial-modeling', 'unit-economics',
             'close-month', 'financial-statements', 'journal-entry-prep', 'reconciliation',
             'compliance-check', 'compliance-tracking', 'compliance-audit', 'tos-risk-checker']
REPAIR_FIRST = ['cash-flow-snapshot', 'variance-analysis', 'paid-advertising']
# 对齐项 (a) 拍板（2026-09-30）：低尾 7 件列观察名单，不阻塞闭环
LOW_TAIL_WATCH = ['multi-platform-listing-generator', 'product-research-matrix', 'scenario-driven-product-scout',
                  'semantic-doc-chunker', 'seo-competitor-analysis', 'skill-optimizer', 'skill-structure-doctor']
# Q7 交叉核对（sage 归位表）逐件核过；1 件角色待商榷如实登记
SAGE_CROSSCHECK_NOTE = {'semantic-bucketer': 'sage-cross-check（Q7 逐件核过；1 件角色待商榷——AGT-048·技能版本）'}
SAGE_CROSSCHECK_DEFAULT = 'sage-cross-check（Q7 逐件核过；candidate-not-validated）'

# 追加集来源（去向②新制作件登记册；v2 修订草案；144 号并入 gsd2 七件——v3）
APPEND_SOURCES = [
    SPEC / '136-r3-direction2/receipts/dir2-ledger-registration.json',
    SPEC / '138-g-direction2/receipts/gdir2-ledger-registration.json',
    SPEC / '144-g-supplement-direction2/receipts/gsd2-ledger-registration.json',
]
APPEND_DOCS = {
    'dir2-ledger-registration.json': '136-R3去向二候选制作记录.md',
    'gdir2-ledger-registration.json': '138-G去向二候选制作记录.md',
    'gsd2-ledger-registration.json': '144-G续补去向二候选制作记录.md',
}

# 路径别名（改名件；140 号）：计划 op 已用新路径，分类 CSV 为冻结件（110 号「逐字节不变」证过）；
# 只做查找别名，不改任何冻结输入。
RENAME_ALIASES = {
    '/Users/lute/project/AgentTools/技能库/seo-orchestrator/SKILL.md':
        '/Users/lute/project/AgentTools/技能库/skill-zyx/SKILL.md',
    # 142 写回段：leadership 计划 op-173 平铺→目录（entryRelPath 由平铺 .md 变为目录 SKILL.md）；
    # 分类 CSV 为冻结件不动，别名把新路径映射回 CSV 内的旧平铺路径。
    '/Users/lute/project/AgentTools/技能库/skills-Qoder/leadership-strategy-playbook/SKILL.md':
        '/Users/lute/project/AgentTools/技能库/skills-Qoder/leadership-strategy-playbook--official_38aAvjmS.md',
}

SEV_ORDER = ('high', 'medium', 'low')


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_batch_readings():
    bs = json.loads(BATCH_STATE.read_text(encoding='utf-8'))
    out = {}
    for s in bs['skills']:
        out[s['id']] = {'where': 'top', 'reeval': ' / '.join(s.get('rounds', {}).get('reeval', {}).get('readings', []))
                        or '(无终评读数字段)', 'verdict': s.get('verdict', '')}
    for b in range(3, 30):
        for s in bs.get(f'batch{b}', {}).get('skills', []):
            if str(s.get('id', '')).startswith('(zero-request)'):
                continue
            out.setdefault(s['id'], {'where': f'batch{b}', 'reeval': s.get('reeval', ''),
                                     'verdict': s.get('notes', '')})
    return out


def defect_hits(registry, ops):
    """把登记册条目落到 173 件上：D-07/D-09 的 `路径：说明` 取冒号前；D-08 用 scope；其余用具名条目。"""
    hits = {o['name']: [] for o in ops}
    by_path = {}
    for o in ops:
        rel = (o['sourceDir'] + '/' + o['entryRelPath'].split('/')[-1]) if o['mode'] == 'dir' else o['sourceFile']
        by_path[o['name']] = rel.split('/Users/lute/project/AgentTools/技能库/', 1)[-1]
    for e in registry['entries']:
        items = e.get('items', [])
        if e['id'] == 'D-16' or not items:
            continue
        for item in items:
            key = re.split(r'[：:（(]', item, maxsplit=1)[0].strip()
            key = key.rsplit('/', 1)[0] if key.endswith(('.md', '.json', '.py', '.pem')) else key
            for name, rel in by_path.items():
                rel_dir = rel.rsplit('/', 1)[0] if '/' in rel else rel
                if (rel_dir == key or rel_dir.startswith(key + '/') or key.startswith(rel_dir + '/')
                        or rel.split('/')[-1] == key):
                    hits[name].append(e['id'])
    for e in registry['entries']:
        if e['id'] == 'D-08':
            for o in ops:
                if o['name'] == 'skill-evaluator':
                    hits['skill-evaluator'].append('D-08')
    return {k: sorted(set(v)) for k, v in hits.items()}


def load_append_rows(reg_paths):
    """追加集行（组 X；新制作弧线＝done-full-loop；同 28 列）。"""
    out = []
    idx = 0
    for p in reg_paths:
        reg = json.loads(Path(p).read_text(encoding='utf-8'))
        doc = APPEND_DOCS.get(Path(p).name, Path(p).name)
        for it in reg.get('items', []):
            idx += 1
            review = it.get('review', '')
            m = re.search(r'两跑\s*([\d.]+/[\d.]+)', review)
            readings = f'{m.group(1)}（两跑）' if m else review
            nums = [n for n in (float(x) for x in re.findall(r'\d+\.?\d*', readings)) if 40 <= n <= 100]
            out.append({
                'ledgerId': f'LAP{idx:02d}', 'opId': f'ap-{idx:03d}', 'group': 'X',
                'name': it['name'], 'sourceKind': 'standard', 'sourcePath': it['home'],
                'routeV1': '', 'roleCandidates': '', 'sageRoles': '',
                'basisV1': 'new-draft（去向②新制作；非 v1 路由件）',
                'classificationState': 'closed',
                'classificationNote': f'新制作（域归属见 sourcePath；{doc}）',
                'defectIds': '', 'defectDispositions': '', 'missingRefs': '',
                'screenFindings': '', 'screenHigh': 0,
                'completenessState': 'closed',
                'optState': 'done-full-loop', 'optEvidence': doc,
                'optReadings': readings,
                'optMin': min(nums) if nums else '', 'optMax': max(nums) if nums else '',
                'optBand': ('ge96' if nums and max(nums) >= 96 else
                            'band-90-96' if nums and max(nums) >= 90 else 'lt90' if nums else 'none'),
                'optObs': '', 'assemblyStatus': 'appended-projected', 'updateState': 'none',
                'nextAction': 'closed',
            })
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--plan', default=str(PLAN))
    parser.add_argument('--ledger', default=str(CLASS_CSV))
    parser.add_argument('--defects', default=str(DEFECTS))
    parser.add_argument('--verify', default=str(VERIFY))
    parser.add_argument('--screen', default=str(SCREEN))
    parser.add_argument('--out-dir', default=str(DEFAULT_OUT))
    parser.add_argument('--append', action='store_true')
    parser.add_argument('--tag', default='v1')
    # 摘要 at 字段：默认保持 2026-10-01（v1/v2 纪元，旧行为逐字节不变）；新 tag 生成时显式传入当日
    parser.add_argument('--at', default='2026-10-01')
    args = parser.parse_args()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    plan = json.loads(Path(args.plan).read_text(encoding='utf-8'))
    ops = plan['operations']
    with Path(args.ledger).open(encoding='utf-8-sig') as f:
        class_by_path = {r['entryPath']: r for r in csv.DictReader(f)}
    registry = json.loads(Path(args.defects).read_text(encoding='utf-8'))
    disposition = {e['id']: e['disposition'] for e in registry['entries']}
    fixed_state = json.loads(W4_FIX_STATE.read_text(encoding='utf-8'))['fixed'] if W4_FIX_STATE.exists() else {}
    progress = {}
    for p_path, p_doc in OPT_PROGRESS:
        if not p_path.exists():
            continue
        for k, v in json.loads(p_path.read_text(encoding='utf-8')).get('items', {}).items():
            entry = progress.setdefault(k, {'reeval': '', 'doc': '', 'assemblyUpdate': False})
            if v.get('reeval'):
                entry['reeval'] = v['reeval']
                entry['doc'] = p_doc
            if v.get('assemblyUpdate'):
                entry['assemblyUpdate'] = True
    verify = json.loads(Path(args.verify).read_text(encoding='utf-8'))
    missing_refs = {m['name']: m['missing'] for m in verify['layers']['L3']['missingExamples']}
    screen = json.loads(Path(args.screen).read_text(encoding='utf-8'))
    readings = load_batch_readings()
    if SAGE_ROLES.exists():
        sage_roles = {k: [r['id'] for r in v.get('roles', [])]
                      for k, v in json.loads(SAGE_ROLES.read_text(encoding='utf-8'))['skills'].items()}
    else:
        sage_roles = {}
    hits = defect_hits(registry, ops)

    screen_by_name = {}
    for s in screen['skills']:
        key = s['relPath'].split('/', 1)[0]
        bucket = screen_by_name.setdefault(key, Counter())
        for fd in s.get('findings', []):
            bucket[fd['code']] += 1
    sev_by_name = {}
    for s in screen['skills']:
        key = s['relPath'].split('/', 1)[0]
        sbt = sev_by_name.setdefault(key, Counter())
        for fd in s.get('findings', []):
            sbt[fd.get('severity', 'unknown')] += 1

    rows = []
    for o in ops:
        name = o['name']
        if o['mode'] == 'dir':
            entry = o['sourceDir'] + '/' + o['entryRelPath'].split('/')[-1]
            rel = entry.split('/Users/lute/project/AgentTools/技能库/', 1)[-1]
        else:
            entry = o['sourceFile']
            rel = o['entryRelPath']
        c = class_by_path[RENAME_ALIASES.get(entry, entry)]
        sroles = sage_roles.get(name, [])
        class_note = ''
        if c['routeV1'] == 'role-candidate' and c['roleCandidates']:
            class_state = 'closed'
        elif sroles:
            # 机器路由 no-class-signal × Sage 归位表有角色：Q7 已逐件交叉核对 ⇒ 收口（不合并真相源，仅记来源）
            class_state = 'closed-sage-cross-check'
            class_note = SAGE_CROSSCHECK_NOTE.get(name, SAGE_CROSSCHECK_DEFAULT)
        else:
            class_state = 'gap'

        defect_ids = hits.get(name, [])
        pending = [d for d in defect_ids if disposition.get(d) == 'repair-pending']
        repaired = name in fixed_state
        if pending and not repaired:
            comp_state = 'pending-repair'
        elif repaired:
            comp_state = 'closed-repaired'
        elif defect_ids or missing_refs.get(name):
            comp_state = 'closed-with-registered'
        else:
            comp_state = 'closed'

        opt = readings.get(name)
        if opt is None and name in OPT_EXCEPTIONS:
            opt = {'where': 'exception', 'reeval': OPT_EXCEPTIONS[name]['readings'], 'verdict': ''}
        if opt is not None:
            opt_state = 'done-historical'
            opt_doc = OPT_EXCEPTIONS[name]['doc'] if name in OPT_EXCEPTIONS else BATCH_DOC.get(opt['where'], opt['where'])
            opt_readings = opt['reeval']
        else:
            opt_state = 'missing'
            opt_doc = ''
            opt_readings = ''
        if progress.get(name, {}).get('reeval'):
            # 优化进度源（Q5 首批/R-2 校准批……）的完整回路读数覆盖历史态
            opt_state = 'done-full-loop'
            opt_doc = progress[name]['doc']
            opt_readings = progress[name]['reeval']
        # 近似读数：取串内 ≥40 的数（低于 40 的通常是次数/百分比等非分数），供筛查不作裁决
        nums = [float(x) for x in re.findall(r'\d+\.?\d*', opt_readings)]
        nums = [n for n in nums if 40 <= n <= 100]

        actions = []
        if name in REPAIR_FIRST and not repaired:
            actions.append('repair-first-batch')
        elif pending and not repaired:
            actions.append('repair-queue')
        if name in Q5_BATCH1 and opt_state != 'done-full-loop':
            actions.append('opt-batch-1')
        elif opt_state == 'missing':
            actions.append('opt-queue')
        if class_state == 'cross-check-pending':
            actions.append('classify-reconcile')
        if not actions:
            actions.append('closed')

        rows.append({
            'ledgerId': c['ledgerId'], 'opId': o['opId'], 'group': o['group'], 'name': name,
            'sourceKind': o['sourceKind'], 'sourcePath': rel,
            'routeV1': c['routeV1'], 'roleCandidates': c['roleCandidates'], 'sageRoles': ';'.join(sroles),
            'basisV1': c['basisV1'], 'classificationState': class_state, 'classificationNote': class_note,
            'defectIds': ';'.join(defect_ids),
            'defectDispositions': ';'.join(sorted({disposition.get(d, '?') for d in defect_ids})),
            'missingRefs': len(missing_refs.get(name, [])),
            'screenFindings': ';'.join(f'{k}:{v}' for k, v in sorted(screen_by_name.get(name, {}).items())),
            'screenHigh': (sev_by_name.get(name, Counter()).get('high', 0)),
            'completenessState': comp_state,
            'optState': opt_state, 'optEvidence': opt_doc, 'optReadings': opt_readings,
            'optMin': min(nums) if nums else '', 'optMax': max(nums) if nums else '',
            'optBand': ('ge96' if nums and max(nums) >= 96 else 'band-90-96' if nums and max(nums) >= 90
                        else 'lt90' if nums else 'none'),
            'optObs': 'low-tail-watch' if name in LOW_TAIL_WATCH else '',
            'assemblyStatus': c['assemblyStatus'],
            'updateState': 'updated' if progress.get(name, {}).get('assemblyUpdate') else 'none',
            'nextAction': ';'.join(actions),
        })

    if args.append:
        rows.extend(load_append_rows(APPEND_SOURCES))
    cols = list(rows[0])
    ledger_path = out_dir / f'loop-ledger-{args.tag}.csv'
    with ledger_path.open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)

    loop_closed = sum(1 for r in rows
                      if r['classificationState'] in ('closed', 'closed-sage-cross-check')
                      and r['completenessState'] in ('closed', 'closed-with-registered', 'closed-repaired')
                      and r['optState'] in ('done-historical', 'done-full-loop')
                      and r['assemblyStatus'] in ('batch1-projected', 'appended-projected'))
    opt_rows = [r for r in rows if r['optState'] == 'done-historical' and r['optMin'] != '']
    fnum = lambda v: float(v) if v != '' else None
    summary = {
        'record_type': f'loop-ledger-{args.tag}',
        'at': args.at, 'total': len(rows),
        'byGroup': dict(Counter(r['group'] for r in rows)),
        'classification': dict(Counter(r['classificationState'] for r in rows)),
        'completeness': dict(Counter(r['completenessState'] for r in rows)),
        'optimization': dict(Counter(r['optState'] for r in rows)),
        'assembly': dict(Counter(r['assemblyStatus'] for r in rows)),
        'loopClosed': loop_closed, 'loopOpen': len(rows) - loop_closed,
        'observation': LOW_TAIL_WATCH,
        'queue': dict(Counter(a for r in rows for a in r['nextAction'].split(';'))),
        'optReadingStats': {
            'note': '读数串中 ≥40 的数为近似分数；min/max 供筛查不作裁决',
            'n': len(opt_rows),
            'maxGE96': sum(1 for r in opt_rows if fnum(r['optMax']) >= 96),
            'minGE96': sum(1 for r in opt_rows if fnum(r['optMin']) >= 96),
            'maxLT90': [r['name'] for r in opt_rows if fnum(r['optMax']) < 90],
            'maxGE96minLT96': [r['name'] for r in opt_rows
                               if fnum(r['optMax']) >= 96 and fnum(r['optMin']) < 96],
        },
        'attention': {
            'classificationCrossCheckPending': [r['name'] for r in rows if r['classificationState'] == 'cross-check-pending'],
            'pendingRepair': [r['name'] for r in rows if r['completenessState'] == 'pending-repair'],
            'optMissingNonBatch1': [r['name'] for r in rows if r['optState'] == 'missing' and r['name'] not in Q5_BATCH1],
            'missingRefsItems': {r['name']: r['missingRefs'] for r in rows if r['missingRefs']},
        },
        'frozenInputs': {str(p): sha256_file(p) for p in
                         [args.plan, args.ledger, args.defects, args.verify, args.screen, BATCH_STATE]
                         + [pp for pp, _ in OPT_PROGRESS]
                         + (APPEND_SOURCES if args.append else [])
                         if Path(p).exists()},
    }
    if args.append:
        summary['sets'] = {'batch1': sum(1 for r in rows if r['group'] != 'X'),
                           'append': sum(1 for r in rows if r['group'] == 'X')}
    (out_dir / f'loop-ledger-{args.tag}.summary.json').write_text(
        json.dumps(summary, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(json.dumps({k: summary[k] for k in
                      ['total', 'byGroup', 'classification', 'completeness', 'optimization', 'assembly',
                       'loopClosed', 'loopOpen', 'queue']}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
