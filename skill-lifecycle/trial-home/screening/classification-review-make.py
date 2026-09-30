#!/usr/bin/env python3
"""W2 分类复核与台账生成器（只读：账本/104 基线/107 计划；零写入源库）。

产出（108-w2-classification/）：
  role-candidates-review.json / .md  53 岗候选复核清单（供拍板冻结 v1）
  classification-sample-review.json  不变量检查＋路径存在性＋四类各 30 抽样＋旗标
  classification-projection-v1.csv   34,468 行投影台账（含 assemblyStatus/topicCandidate/basis）

用法：python3 -B classification-review-make.py
"""
import argparse
import csv
import hashlib
import json
import re
import zipfile
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent


def find_repo(start):
    cur = start
    for _ in range(8):
        if (cur / 'skill-lifecycle').is_dir() and (cur / 'docs').is_dir():
            return cur
        cur = cur.parent
    raise SystemExit(f'仓库根推断失败: {start}')


REPO = find_repo(BASE)
SPEC = REPO / 'docs/specs/2026-09-25-dsh-skill-lifecycle'
OUT = SPEC / '108-w2-classification'
LEDGER = SPEC / '106-w0-governance/governance-ledger-v1.csv'
ROUTING = SPEC / '104-skills-asset-research/asset-inventory-and-routing.csv'
ROLE_MATRIX = SPEC / '104-skills-asset-research/role-coverage-matrix.json'
CROSSWALK = SPEC / '104-skills-asset-research/career-role-label-crosswalk.json'
PLAN = SPEC / '107-w1-assembly/assembly-plan-v1-batch1.json'

SHARED_TOPICS = {
    '工程', '数据', '创意文档', '通用研究', '研发与代码', '文档与知识', '产品设计与UIUX',
    '数据分析与BI', '数据库与后端服务', '协作与外部工具', '演示与内容', '图像/视频/创意生产',
    '本地诊断与运维', '通用规划与咨询', '网站与部署',
}
OTHER_TOPICS = {'个人娱乐', 'personal', 'game-development'}
BLOCK_TOKENS = ('opaque-entry', 'wrapper-not-skill-body', 'example-or-template')
FLAG_OTHER_IN_SHARED = re.compile(
    r'personal|persona|diary|journal|pet\b|宠物|日记|旅行|travel|fitness|adhd|育儿|游戏|game|anime|漫画|comic|风水|bazi|星座|解梦', re.I)
FLAG_BUSINESS_IN_OTHER = re.compile(
    r'market|crm|finance|seo|ads?[-_]|amazon|shop|sales|营销|经营|财务|客户|listing|品牌', re.I)


def corrected_basis(row):
    """v1 台账口径修正：104 路由脚本对"无信号待核"行残留了默认 basis
    （`curated-candidate-not-runtime`），会与真正的策展候选混淆。路由不变，只修口径。"""
    route = row['route']
    if route == 'role-candidate':
        return row['basis']
    if route in ('shared-topic-candidate', 'other-topic-candidate'):
        return 'heuristic-topic-not-verified'
    if row['qualityBlocked'] == 'True':
        return 'object-kind-blocks-capability-claim'
    return 'unknown-topic-no-route' if row['topicCandidate'] else 'no-class-signal'


def load_rows():
    ledger = list(csv.DictReader(LEDGER.open(encoding='utf-8-sig')))
    routing = {r['path']: r for r in csv.DictReader(ROUTING.open(encoding='utf-8-sig'))}
    for row in ledger:
        extra = routing.get(row['entryPath'], {})
        row['topicCandidate'] = extra.get('topicCandidate', '')
        row['basis'] = extra.get('basis', '')
    return ledger


def existence_check(rows):
    missing = []
    zip_cache = {}
    for row in rows:
        path = row['entryPath']
        try:
            if row['sourceKind'] == 'zip':
                archive, member = path.split('!', 1)
                if archive not in zip_cache:
                    names = None
                    try:
                        with zipfile.ZipFile(archive) as z:
                            names = set(z.namelist())
                    except Exception:  # noqa: BLE001 - 坏 ZIP 在登记册里单独记账
                        names = set()
                    zip_cache[archive] = names
                if member not in zip_cache[archive]:
                    missing.append({'kind': 'zip', 'path': path})
            elif not Path(path).is_file():
                missing.append({'kind': row['sourceKind'], 'path': path})
        except Exception:  # noqa: BLE001
            missing.append({'kind': row['sourceKind'], 'path': path})
    return missing


def invariants(rows):
    results = {'I1_blocked_is_unassigned': [], 'I2_role_has_ids': [], 'I3_shared_other_clean': [],
               'I4_unassigned_explained': [], 'I5_role_basis': []}
    for row in rows:
        blocked = row['qualityBlocked'] == 'True'
        topic = row['topicCandidate']
        route = row['route']
        if blocked and route != 'unassigned-needs-review':
            results['I1_blocked_is_unassigned'].append(row['ledgerId'])
        if route == 'role-candidate' and not row['roleCandidates']:
            results['I2_role_has_ids'].append(row['ledgerId'])
        if route in ('shared-topic-candidate', 'other-topic-candidate'):
            if blocked or not topic:
                results['I3_shared_other_clean'].append(row['ledgerId'])
        if route == 'unassigned-needs-review':
            explained = blocked or topic not in (SHARED_TOPICS | OTHER_TOPICS)
            if not explained:
                results['I4_unassigned_explained'].append(row['ledgerId'])
        if route == 'role-candidate' and not (row['basis'].startswith('curated-candidate')
                                              or row['basis'].startswith('source-l3')):
            results['I5_role_basis'].append({'ledgerId': row['ledgerId'], 'basis': row['basis']})
    return {key: {'count': len(value), 'examples': value[:5]} for key, value in results.items()}


def role_review(rows, matrix, crosswalk):
    by_role = defaultdict(list)
    for row in rows:
        for role_id in filter(None, row['roleCandidates'].split(';')):
            by_role[role_id].append(row)
    # 预期口径 = L3 标签命中（crosswalk 行）∪ 策展定向深读（matrix additionalCareerCandidates）
    career_hash_by_path = {r['entryPath']: r['entrySha256'] for r in rows if r['sourceKind'] == 'career'}
    crosswalk_hashes = defaultdict(set)
    for x in crosswalk.get('rows', []):
        for role_id in x['roleCandidateIds']:
            crosswalk_hashes[role_id].add(x['sha256'])
    curated_career_hashes = defaultdict(set)
    for role in matrix['roles']:
        for item in role.get('additionalCareerCandidates') or []:
            row_hash = career_hash_by_path.get(item.get('path'))
            if row_hash:
                curated_career_hashes[role['roleId']].add(row_hash)
    career_derived = defaultdict(set)
    for role_id, members in by_role.items():
        for row in members:
            if row['sourceKind'] == 'career':
                career_derived[role_id].add(row['entrySha256'])
    residual = {}
    for role_id in set(career_derived) | set(crosswalk_hashes) | set(curated_career_hashes):
        expected = crosswalk_hashes.get(role_id, set()) | curated_career_hashes.get(role_id, set())
        derived = career_derived.get(role_id, set())
        if derived != expected:
            residual[role_id] = {'derived': len(derived), 'expected': len(expected),
                                 'derivedOnly': len(derived - expected), 'expectedOnly': len(expected - derived)}
    roles_out = []
    for role in matrix['roles']:
        role_id = role['roleId']
        members = by_role.get(role_id, [])
        source_counts = Counter(row['sourceKind'] for row in members)
        distinct = len({row['entrySha256'] for row in members})
        names = sorted({row['name'] for row in members if row['name']})
        curation = role.get('candidatePaths') or []
        curation_exist = [p for p in curation if Path(p).is_file()]
        roles_out.append({
            'roleId': role_id, 'name': role['name'], 'title': role['title'], 'plane': role['plane'],
            'machineCandidates': {'rows': len(members), 'distinctEntryBytes': distinct,
                                  'bySource': dict(source_counts),
                                  'names': names[:400], 'truncated': len(names) > 400},
            'curatedCandidates': {'names': role.get('candidateNames') or [], 'paths': curation,
                                  'pathsExist': f'{len(curation_exist)}/{len(curation)}'},
            'careerDeepRead': [x['name'] for x in role.get('additionalCareerCandidates') or []],
            'exportDeepRead': [x['name'] for x in role.get('additionalExportCandidates') or []],
            'gap': role.get('gap', ''), 'supplement': role.get('supplement', ''),
            'priority': role.get('priority', ''),
            'reviewStatus': 'frozen-v1（2026-09-30 拍板；candidate-not-validated，增量修改走批次）',
            'careerCrosswalk': {
                'l3Matched': len(crosswalk_hashes.get(role_id, set())),
                'curatedDeepRead': len(curated_career_hashes.get(role_id, set())),
                'consistentWithExpected': role_id not in residual,
            },
        })
    return roles_out, residual


def sample(rows, count=30):
    ordered = sorted(rows, key=lambda r: (r['sourceKind'], r['entryPath']))
    if not ordered:
        return []
    step = max(1, len(ordered) // count)
    return ordered[::step][:count]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', default=str(OUT))
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    now = datetime.now().astimezone().isoformat()

    rows = load_rows()
    matrix = json.loads(ROLE_MATRIX.read_text())
    crosswalk = json.loads(CROSSWALK.read_text())
    plan = json.loads(PLAN.read_text())
    projected = set()
    for op in plan['operations']:
        projected.add(op['sourceFile'] if op['mode'] == 'flat' else f"{op['sourceDir']}/SKILL.md")

    # 防重断言：账本中不得出现装配根/回执目录
    assembly_leak = [r['entryPath'] for r in rows
                     if '/技能库/_assembly-v1' in r['entryPath'] or '/技能库/_assembly-receipts' in r['entryPath']]

    missing = existence_check(rows)
    inv = invariants(rows)
    roles_out, crosswalk_residual = role_review(rows, matrix, crosswalk)

    role_rows = [r for r in rows if r['route'] == 'role-candidate']
    shared_rows = [r for r in rows if r['route'] == 'shared-topic-candidate']
    other_rows = [r for r in rows if r['route'] == 'other-topic-candidate']
    unassigned_rows = [r for r in rows if r['route'] == 'unassigned-needs-review']

    def sample_record(row, cls):
        blocked = row['qualityBlocked'] == 'True'
        tokens = [t for t in BLOCK_TOKENS if t in row['statusSignals']]
        record = {'ledgerId': row['ledgerId'], 'class': cls, 'sourceKind': row['sourceKind'],
                  'name': row['name'], 'entryPath': row['entryPath'],
                  'topicCandidate': row['topicCandidate'], 'basisRaw': row['basis'],
                  'basisV1': corrected_basis(row),
                  'statusSignals': row['statusSignals'], 'roleCandidates': row['roleCandidates'],
                  'blockedTokens': tokens}
        if cls == 'role':
            record['consistent'] = bool(row['roleCandidates']) and not blocked
        elif cls in ('shared', 'other'):
            record['consistent'] = (not blocked and bool(row['topicCandidate'])
                                    and row['topicCandidate'] in (SHARED_TOPICS if cls == 'shared' else OTHER_TOPICS))
        else:
            record['consistent'] = blocked or row['topicCandidate'] not in (SHARED_TOPICS | OTHER_TOPICS)
        if cls == 'shared' and FLAG_OTHER_IN_SHARED.search(row['name'] or ''):
            record['flag'] = 'possible-other-topic'
        if cls == 'other' and FLAG_BUSINESS_IN_OTHER.search(row['name'] or ''):
            record['flag'] = 'possible-shared-or-role-topic'
        return record

    samples = {
        'role': [sample_record(r, 'role') for r in sample(role_rows)],
        'shared': [sample_record(r, 'shared') for r in sample(shared_rows)],
        'other': [sample_record(r, 'other') for r in sample(other_rows)],
        'unassigned': [sample_record(r, 'unassigned') for r in sample(unassigned_rows)],
    }
    sample_consistency = {cls: f"{sum(1 for s in items if s['consistent'])}/{len(items)}"
                          for cls, items in samples.items()}
    basis_corrected = Counter()
    for row in rows:
        if row['basis'] != corrected_basis(row):
            basis_corrected[f"{row['route']} :: {row['basis']} → {corrected_basis(row)}"] += 1

    unassigned_breakdown = Counter()
    unknown_topic_top = Counter()
    unknown_topic_by_source = Counter()
    for row in unassigned_rows:
        tokens = [t for t in BLOCK_TOKENS if t in row['statusSignals']]
        if tokens:
            unassigned_breakdown['quality-blocked:' + ','.join(tokens)] += 1
        elif row['topicCandidate'] in (SHARED_TOPICS | OTHER_TOPICS):
            unassigned_breakdown['unexplained-topic'] += 1
        elif row['topicCandidate']:
            unassigned_breakdown['unknown-topic'] += 1
            unknown_topic_top[row['topicCandidate']] += 1
            unknown_topic_by_source[row['sourceKind']] += 1
        else:
            unassigned_breakdown['no-signal'] += 1

    review = {
        'reviewKind': 'role-candidates-review-v1', 'generatedAt': now,
        'basis': 'governance-ledger-v1 ＋ role-coverage-matrix.json ＋ career-role-label-crosswalk.json',
        'totals': {
            'roles': len(roles_out),
            'machineRoleCandidateRows': len(role_rows),
            'roleAssignments': sum(r['machineCandidates']['rows'] for r in roles_out),
            'rolesWithMachineCandidates': sum(1 for r in roles_out if r['machineCandidates']['rows'] > 0),
        },
        'crosswalkResidual': crosswalk_residual,
        'roles': roles_out,
    }
    (out / 'role-candidates-review.json').write_text(json.dumps(review, ensure_ascii=False, indent=2) + '\n')

    lines = ['# W2 角色候选复核清单（53 岗，frozen-v1，2026-09-30 拍板冻结）', '',
             f"生成：{now}；依据：账本 v1（机器投影）＋104 角色矩阵（策展）＋Career L3 交叉表。",
             "机器候选＝按标签/候选路径的投影（candidate-not-validated）；策展＝104 已列路径；深读＝104 定向深读件。", '',
             '| 角色 | 分身 | 岗位 | 平面 | 机器候选（行/字节去重/源） | 策展路径 | Career深读 | 缺口摘要 |',
             '|---|---|---|---|---|---|---|---|']
    for role in roles_out:
        m = role['machineCandidates']
        src = '/'.join(f'{k}:{v}' for k, v in sorted(m['bySource'].items())) or '—'
        gap = (role['gap'] or '').replace('\n', ' ')
        gap = gap[:72] + ('…' if len(gap) > 72 else '')
        lines.append('| {roleId} {name} | {name} | {title} | {plane} | {rows} 行 / {distinct} 字节身份 / {src} '
                     '| {curated}（{exist} 存在） | {deep} | {gap} |'.format(
                         roleId=role['roleId'], name=role['name'], title=role['title'], plane=role['plane'],
                         rows=m['rows'], distinct=m['distinctEntryBytes'], src=src,
                         curated=len(role['curatedCandidates']['names']),
                         exist=role['curatedCandidates']['pathsExist'],
                         deep=len(role['careerDeepRead']) + len(role['exportDeepRead']), gap=gap))
    (out / 'role-candidates-review.md').write_text('\n'.join(lines) + '\n')

    sample_review = {
        'reviewKind': 'classification-sample-review-v1', 'generatedAt': now,
        'totals': {'rows': len(rows), 'byRoute': dict(Counter(r['route'] for r in rows))},
        'assemblyLeakCheck': {'leak': assembly_leak, 'count': len(assembly_leak)},
        'pathExistence': {'missing': missing, 'count': len(missing)},
        'invariants': inv,
        'sampleConsistency': sample_consistency,
        'basisCorrection': {'corrected': sum(basis_corrected.values()), 'byPattern': dict(basis_corrected),
                            'note': '104 路由脚本默认 basis 残留误标，仅修 v1 台账口径；路由不变，104 历史件不追改'},
        'unassignedBreakdown': dict(unassigned_breakdown),
        'unknownTopicTop': unknown_topic_top.most_common(20),
        'unknownTopicBySource': dict(unknown_topic_by_source),
        'samples': samples,
        'notes': ['抽样为确定性步长抽取（非随机）；判"一致"＝按分类规范 v1 §2 管道重放规则通过。',
                  '旗标仅提示人工复核方向（名字启发式），不等于错分结论。'],
    }
    (out / 'classification-sample-review.json').write_text(
        json.dumps(sample_review, ensure_ascii=False, indent=2) + '\n')

    with (out / 'classification-projection-v1.csv').open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['ledgerId', 'sourceKind', 'name', 'entryPath', 'entrySha256', 'bytes', 'routeV1',
                         'roleCandidates', 'topicCandidate', 'basisRaw', 'basisV1', 'qualityBlocked',
                         'statusSignals', 'exactByteGroupId', 'assemblyStatus', 'runtimeAcceptance'])
        for row in rows:
            writer.writerow([row['ledgerId'], row['sourceKind'], row['name'], row['entryPath'],
                             row['entrySha256'], row['bytes'], row['route'], row['roleCandidates'],
                             row['topicCandidate'], row['basis'], corrected_basis(row),
                             row['qualityBlocked'], row['statusSignals'],
                             row['exactByteGroupId'],
                             'batch1-projected' if row['entryPath'] in projected else 'not-selected',
                             'not-tested'])

    flags = [s for items in samples.values() for s in items if s.get('flag')]
    print(json.dumps({
        'totals': sample_review['totals'],
        'assemblyLeak': len(assembly_leak),
        'pathMissing': len(missing),
        'invariants': {k: v['count'] for k, v in inv.items()},
        'sampleConsistency': sample_consistency,
        'basisCorrection': {'corrected': sum(basis_corrected.values()), 'byPattern': dict(basis_corrected)},
        'unassignedBreakdown': dict(unassigned_breakdown),
        'unknownTopicTop': unknown_topic_top.most_common(10),
        'crosswalkResidual': crosswalk_residual,
        'flags': flags,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
