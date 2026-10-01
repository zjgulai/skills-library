#!/usr/bin/env python3
"""R-5 执行驱动：池选择 → 调 node 路由器 → 合并 v1.1 CSV → 统计与抽样（零请求）。
用法：python3 r5-run.py --dry-run|--apply
- --dry-run：只出池选择计数与样本准备（不写 v1.1 CSV）
- --apply：写 classification-projection-v1.1.csv ＋ r5-report.json ＋ r5-sample-review.json
"""
import argparse, csv, json, subprocess, sys
from pathlib import Path

ROOT = Path('/Users/lute/project/AgentTools/思维库/skill管理')
SPEC = ROOT / 'docs/specs/2026-09-25-dsh-skill-lifecycle'
V1 = SPEC / '108-w2-classification/classification-projection-v1.csv'
V11 = SPEC / '108-w2-classification/classification-projection-v1.1.csv'
OUTDIR = SPEC / '131-r5-execution'
WORK = ROOT / 'skill-lifecycle/trial-home/r5/run'
import sys as _sys
WORDTABLE = Path(_sys.argv[_sys.argv.index('--wordtable')+1]) if '--wordtable' in _sys.argv else OUTDIR / 'wordtable-v2.json'
ROUTER = ROOT / 'skill-lifecycle/trial-home/r5/routing-v2.mjs'

def load_rows():
    with open(V1, encoding='utf-8-sig', newline='') as f:
        r = csv.DictReader(f)
        return r.fieldnames, list(r)

def in_pool1(row):
    return row['sourceKind'] == 'qoder' and row['routeV1'] == 'unassigned-needs-review' and row.get('topicCandidate') == '未归类'

def in_pool2(row):
    return row['basisV1'] == 'no-class-signal'

def main():
    argv = [a for i, a in enumerate(_sys.argv[1:]) if not (i > 0 and _sys.argv[1:][i-1] == '--wordtable') and a != '--wordtable']
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--dry-run', action='store_true')
    g.add_argument('--apply', action='store_true')
    args = ap.parse_args(argv)

    fields, rows = load_rows()
    pool1 = [r for r in rows if in_pool1(r)]
    pool2 = [r for r in rows if in_pool2(r)]
    pool_ids = {r['ledgerId'] for r in pool1} | {r['ledgerId'] for r in pool2}
    print(f'rows={len(rows)} pool1={len(pool1)} pool2={len(pool2)} union={len(pool_ids)}')

    pool_rows = [r for r in rows if r['ledgerId'] in pool_ids]
    WORK.mkdir(parents=True, exist_ok=True)
    inp = WORK / 'pool-input.json'
    outp = WORK / 'pool-output.json'
    inp.write_text(json.dumps({'rows': [{'ledgerId': r['ledgerId'], 'name': r['name'], 'entryPath': r['entryPath']} for r in pool_rows]}, ensure_ascii=False))
    if args.dry_run:
        print(f'dry-run: pool-input written ({len(pool_rows)} rows) → {inp}')
        return 0
    subprocess.run(['node', str(ROUTER), '--wordtable', str(WORDTABLE), '--input', str(inp), '--out', str(outp)], check=True)
    res = json.loads(outp.read_text())
    by_id = {r['ledgerId']: r for r in res['results']}

    # 合并 v1.1
    new_fields = fields + ['routeV2', 'topicV2', 'basisV2']
    stats = {'routed': 0, 'still': 0, 'byBucket': {}, 'byWhy': {}, 'byKind': {'shared': 0, 'other': 0}}
    sample_pool = {}
    for r in rows:
        lid = r['ledgerId']
        r['routeV2'] = r['topicV2'] = r['basisV2'] = ''
        if lid not in by_id:
            continue
        x = by_id[lid]
        if x['bucket']:
            kind, label = x['bucket'].split(':', 1)
            r['routeV2'] = 'shared-topic-candidate' if kind == 'shared' else 'other-topic-candidate'
            r['topicV2'] = label
            r['basisV2'] = f"router-v2-{x['why']}"
            stats['routed'] += 1
            stats['byKind'][kind] += 1
            stats['byBucket'][x['bucket']] = stats['byBucket'].get(x['bucket'], 0) + 1
            sample_pool.setdefault(x['bucket'], []).append({'ledgerId': lid, 'name': r['name'], 'why': x['why'], 'via': x['via'], 'descLen': x['descLen']})
        else:
            r['routeV2'] = 'unassigned-needs-review'
            r['topicV2'] = r.get('topicCandidate') or ''
            r['basisV2'] = 'router-v2-still-unassigned'
            stats['still'] += 1
        if x['why'] == 'ambiguous-resolved-by-name':
            key = 'ambiguous-resolved-by-name'
        elif x['why'].startswith('ambiguous'):
            key = 'ambiguous-unresolved'
        else:
            key = x['why']
        stats['byWhy'][key] = stats['byWhy'].get(key, 0) + 1

    with open(V11, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=new_fields)
        w.writeheader()
        w.writerows(rows)

    # 抽样：每桶 ≤30，确定性均布（按 ledgerId 排序后等距取）
    samples = {}
    for bucket, arr in sorted(sample_pool.items()):
        arr.sort(key=lambda a: a['ledgerId'])
        n = min(30, len(arr))
        if len(arr) <= n:
            take = arr
        else:
            stepf = len(arr) / n
            take = [arr[int(i * stepf)] for i in range(n)]
        samples[bucket] = take
    report = {'record_type': 'r5-execution-report', 'at': '2026-10-01', 'scope': 'qoder未归类池7596＋no-class-signal池555（v1 已标行冻结）',
              'pools': {'pool1': len(pool1), 'pool2': len(pool2), 'union': len(pool_ids)},
              'stats': {**stats, 'rate': f"{stats['routed'] / len(pool_ids) * 100:.1f}%"},
              'wordtableDigest': json.loads(WORDTABLE.read_text())['tableDigest'],
              'note': '契约收紧：desc 不可用 ⇒ 弱词≥2 不判（仅 name 强命中）；自检 7/7＋与原型 200/200 等价'}
    (OUTDIR / 'r5-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=1) + '\n')
    (OUTDIR / 'r5-sample-review.json').write_text(json.dumps({'record_type': 'r5-sample-review', 'perBucket': 30, 'samples': samples}, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=1))
    print(f'v1.1 → {V11}')
    return 0

sys.exit(main())
