#!/usr/bin/env python3
"""W1 首批装配投影计划生成器（只读：治理账本 + 源目录；不写目标）。

选择规则（105 号方案 P2 已批准）：
  A 组：81-Skills 全部（跳过对象状态阻断件）
  B 组：标准入口中 route=role-candidate 且不在 81-Skills 的达标件
  C 组：1 个 Qoder 试点（op 形态由账本入口形状决定——目录入口出 dir op，平铺入口出 flat op；
        2026-10-08 用户拍板，此前写死 flat，142 号把该件转目录后每次重算都会退回旧形制）
  D 组：去向②首入件（成员名单取闭环台账 assemblyStatus=appended-projected；
        它们晚于 104 扫描、索引里一行都没有，所以 A/B 结构上看不见——不是选错，是没有来源可读。
        清单与字节按库面现算；来源缺失或兜不住成员都判红，不再留成"装配里有、计划推不出"）
摘要口径与 assembly-project.mjs 完全一致（行式清单 sha256 / 计划摘要）。

用法：python3 -B assembly-plan-make.py [--library <技能库根>] [--out <plan.json>]
      python3 -B assembly-plan-make.py --self-test   # D 组成员判定与覆盖门的双向证明
"""
import argparse
import csv
import hashlib
import json
import os
import re
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent
KEBAB = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')


def find_repo(start):
    cur = start
    for _ in range(8):
        if (cur / 'skill-lifecycle').is_dir() and (cur / 'docs').is_dir():
            return cur
        cur = cur.parent
    raise SystemExit(f'仓库根推断失败: {start}')


REPO = find_repo(BASE)
DEFAULT_LIB = Path('/Users/lute/project/AgentTools/技能库')
DEFAULT_LEDGER = REPO / 'docs/specs/2026-09-25-dsh-skill-lifecycle/106-w0-governance/governance-ledger-v1.csv'
DEFAULT_OUT = REPO / 'docs/specs/2026-09-25-dsh-skill-lifecycle/107-w1-assembly/assembly-plan-v1-batch1.json'
PILOT_NAME = 'leadership-strategy-playbook'
SPEC_DIR = REPO / 'docs/specs/2026-09-25-dsh-skill-lifecycle'

JUNK_DIRS = {'__pycache__', 'node_modules', '.git'}


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def select_appended(appended, chosen, library):
    """D 组成员判定：跳过已被 A/B/C 选中的；库面没入口就报，不静默跳过。

    单独成函数是为了能双向证（`--self-test`）——这段判错的话，症状正是本批要消灭的
    "装配根里有、计划推不出"，靠真实数据不容易制造出来。
    """
    rows, missing, excluded = [], [], []
    for a in appended:
        if a['name'] in chosen:
            continue          # ZIP 族那 41 件已补进行索引，走 B 组，不在这里重复
        entry = library / a['sourcePath'] / 'SKILL.md'
        if not entry.is_file():
            missing.append(f"{a['name']} ← {a['sourcePath']}（台账说已投影，库面却没有入口文件）")
            continue
        if not KEBAB.match(a['name']):
            excluded.append({'group': 'D', 'path': a['sourcePath'], 'reason': 'non-kebab-name'})
            continue
        rows.append({'entryPath': str(entry), 'name': a['name'], 'entrySha256': sha256_file(entry),
                     'route': 'appended-registration', 'statusSignals': '', 'sourceKind': 'standard',
                     'provenanceRoot': a['file'], 'ledgerId': a['ledgerId']})
    return rows, missing, excluded


def uncovered_members(appended, chosen, d_rows):
    """台账说已投影、计划里却没有对应 op 的成员——§22/§23 那类"装配里有、计划推不出"的形态。

    单独成函数是为了能在 `--self-test` 里把它逼红：真实数据下它恒为空，
    只有构造一个被排除的成员才能证明"它会挡"，而不是"它现在没挡东西"。
    """
    return sorted({a['name'] for a in appended} - chosen - {r['name'] for r in d_rows})


def loop_appended_rows(spec_dir):
    """闭环台账（取最新 v*）里 assemblyStatus=appended-projected 的行＝去向②首入件名单。

    版本文件名不写死：写死就等于让这份名单停在旧版（145 号 §21.5 同一条教训）。
    """
    cands = [p for p in (spec_dir / '109-loop-ledger').glob('loop-ledger-v*.csv')]
    if not cands:
        raise SystemExit(f'找不到闭环台账（{spec_dir}/109-loop-ledger/loop-ledger-v*.csv）')
    newest = sorted(cands, key=lambda p: int(re.search(r'v(\d+)', p.name).group(1)))[-1]
    with newest.open(encoding='utf-8-sig', newline='') as f:
        rows = list(csv.DictReader(f))
    return [{'name': r['name'], 'sourcePath': (r.get('sourcePath') or '').replace('\\', '/').rstrip('/'),
             'ledgerId': r.get('ledgerId', ''), 'file': newest.name}
            for r in rows if r.get('assemblyStatus') == 'appended-projected']


def walk_files(root):
    files, skipped = [], []
    for dirpath, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in JUNK_DIRS)
        for name in sorted(names):
            path = Path(dirpath) / name
            if path.is_symlink():
                skipped.append(str(path.relative_to(root)))
                continue
            if name == '.DS_Store' or name.endswith('.pyc'):
                continue
            payload = path.read_bytes()
            files.append({
                'relPath': str(path.relative_to(root)).replace(os.sep, '/'),
                'sha256': hashlib.sha256(payload).hexdigest(),
                'bytes': len(payload),
            })
    files.sort(key=lambda item: item['relPath'])
    return files, skipped


def manifest_digest(files):
    text = '\n'.join(f"{f['relPath']}\t{f['sha256']}\t{f['bytes']}" for f in files)
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def plan_digest(plan):
    lines = [plan['planVersion'], plan['planId'], plan['targetRoot']]
    for op in plan['operations']:
        if op['mode'] == 'dir':
            fields = [op['opId'], op['mode'], op['name'], op['sourceDir'], op['sourceDigest']]
            if isinstance(op.get('expectTargetDigest'), str):
                fields.append(op['expectTargetDigest'])
            lines.append('\t'.join(fields))
        else:
            lines.append('\t'.join([op['opId'], op['mode'], op['name'], op['sourceFile'], op['sourceSha256']]))
    return hashlib.sha256('\n'.join(lines).encode('utf-8')).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--library', default=str(DEFAULT_LIB))
    parser.add_argument('--ledger', default=str(DEFAULT_LEDGER))
    parser.add_argument('--out', default=str(DEFAULT_OUT))
    args = parser.parse_args()
    library = Path(args.library)
    rows = list(csv.DictReader(Path(args.ledger).open(encoding='utf-8-sig')))

    def rel_path(row):
        return row['entryPath'].split('技能库/', 1)[-1]

    operations, excluded, total_bytes, total_symlinks = [], [], 0, 0

    def gate(row, group):
        if row['qualityBlocked'] == 'True':
            excluded.append({'group': group, 'path': rel_path(row), 'reason': 'quality-blocked'})
            return False
        if row['nameKebabValid'] != 'True':
            excluded.append({'group': group, 'path': rel_path(row), 'reason': 'non-kebab-name'})
            return False
        return True

    def dir_op(row, group, kind=None, extra=None):
        nonlocal total_bytes, total_symlinks
        source_dir = os.path.dirname(row['entryPath'])
        files, symlinks = walk_files(source_dir)
        total_symlinks += len(symlinks)
        if not any(f['relPath'] == 'SKILL.md' for f in files):
            excluded.append({'group': group, 'path': rel_path(row), 'reason': 'no-skill-md'})
            return
        total_bytes += sum(f['bytes'] for f in files)
        operations.append({
            'opId': f'op-{len(operations) + 1:03d}', 'mode': 'dir', 'group': group,
            'name': row['name'], 'route': row['route'], 'sourceKind': kind or row['sourceKind'],
            'entryRelPath': rel_path(row), 'entrySha256': row['entrySha256'],
            'sourceDir': source_dir, 'sourceFiles': files,
            'sourceBytes': sum(f['bytes'] for f in files), 'sourceDigest': manifest_digest(files),
            **(extra or {}),
            **({'skippedSymlinks': symlinks} if symlinks else {}),
        })

    for row in rows:
        if row['sourceKind'] == 'standard' and rel_path(row).startswith('81-Skills/') and gate(row, 'A'):
            dir_op(row, 'A')
    for row in rows:
        if row['sourceKind'] == 'standard' and row['route'] == 'role-candidate' \
                and not rel_path(row).startswith('81-Skills/') and gate(row, 'B'):
            dir_op(row, 'B')

    pilot = next((r for r in rows if r['sourceKind'] == 'qoder' and r['name'] == PILOT_NAME), None)
    if pilot is None:
        excluded.append({'group': 'C', 'path': PILOT_NAME, 'reason': 'pilot-not-found'})
    elif os.path.basename(pilot['entryPath']) == 'SKILL.md':
        # 试点 op 的形态**由账本入口形状决定**（用户 2026-10-08 拍板）：142 号已把这件从平铺转成目录，
        # 写死 flat 会让每次重算计划都退回旧形制并以 SOURCE_MISSING 被拒。
        dir_op(pilot, 'C')
    else:
        operations.append({
            'opId': f'op-{len(operations) + 1:03d}', 'mode': 'flat', 'group': 'C',
            'name': pilot['name'], 'route': pilot['route'], 'sourceKind': 'qoder',
            'entryRelPath': rel_path(pilot), 'entrySha256': pilot['entrySha256'],
            'sourceFile': pilot['entryPath'], 'sourceSha256': pilot['entrySha256'],
            'statusSignals': pilot['statusSignals'],
        })

    # --- D 组：去向②首入件（登记册为真值，2026-10-09 用户「先做那 13 件追加登记」）---
    # 为什么 A/B 看不见它们：这批件晚于 104 那次扫描，**索引里一行都没有**（13/13 实测无行），
    # 所以不是选错，是没有来源可读。成员名单取闭环台账的 `assemblyStatus=appended-projected`，
    # 字节与清单则一律按库面现算——名单是自指的一点（台账说它们是首入件），内容不是。
    chosen = {op['name'] for op in operations}
    appended = loop_appended_rows(SPEC_DIR)
    d_rows, missing_source, d_excluded = select_appended(appended, chosen, library)
    excluded.extend(d_excluded)
    for row in d_rows:
        # 出处（哪份登记册、台账里哪一行）跟着 op 走：读到一条 D op 就该能回答"它凭什么在计划里"
        dir_op(row, 'D', extra={'provenanceRoot': row['provenanceRoot'], 'ledgerId': row['ledgerId']})
    if missing_source:
        # 台账说"已投影"而库面没有源＝账实不符，不能像 §22 那样让它静默变成一个缺席 op
        raise SystemExit('D 组来源缺失，计划不落盘：\n  - ' + '\n  - '.join(missing_source))
    uncovered = uncovered_members(appended, chosen, d_rows)
    if uncovered:
        raise SystemExit('D 组没兜住的首入件（台账说已投影，计划里却没有对应 op）：\n  - '
                         + '\n  - '.join(uncovered))

    names = {}
    for op in operations:
        names.setdefault(op['name'], []).append(op['opId'])
    duplicates = {name: ids for name, ids in names.items() if len(ids) > 1}

    plan = {
        'planKind': 'assembly-projection',
        'planVersion': 'assembly-v1',
        'planId': 'w1-batch1-2026-09-30',
        'targetRoot': str(library / '_assembly-v1'),
        'createdAt': datetime.now().astimezone().isoformat(),
        'selection': {
            'groupA': sum(1 for op in operations if op['group'] == 'A'),
            'groupB': sum(1 for op in operations if op['group'] == 'B'),
            'groupD': sum(1 for op in operations if op['group'] == 'D'),
            'appendedRegistration': {
                'file': (appended[0]['file'] if appended else ''),
                'members': len(appended),
                'coveredByABorD': len({a['name'] for a in appended} - set(uncovered)),
                'uncovered': uncovered,
                'note': 'D 组只为把首入件纳入可复算面；成员名单来自闭环台账（自指的一点），'
                        'op 的清单与摘要一律按库面现算（非自指）。'},
            'pilotFlat': sum(1 for op in operations if op['group'] == 'C'),
            'totalSourceBytes': total_bytes,
            'skippedSymlinks': total_symlinks,
            'excluded': excluded,
            'duplicateNames': duplicates,
            'basis': 'governance-ledger-v1（route/kebab/qualityBlocked 为账本口径）',
        },
        'operations': operations,
    }
    plan['planDigest'] = plan_digest(plan)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json_dump(plan) + '\n')
    print(json_dump({k: v for k, v in plan.items() if k != 'operations'}))
    print(f'operations={len(operations)} bytes={total_bytes} '
          f'symlinks={total_symlinks} targetExists={(library / "_assembly-v1").exists()}')
    return 0


SELF_TEST_ANCHOR = '81-Skills/ad-creative'   # 稳定在位的库内入口（五票台账的管理圈正控同一锚点）


def self_test():
    """D 组成员判定与覆盖门的双向证明：正常形态要能绿，四类违例各自要能红。

    合成行一律用**库内相对路径**且锚点是真实存在的入口，这样"来源在位"在测试里和生产里
    是同一条判定——不会因为 fixture 自造目录而把红做成绿。
    """
    library = DEFAULT_LIB
    if not (library / SELF_TEST_ANCHOR / 'SKILL.md').is_file():
        print(f'锚点不在位（{library / SELF_TEST_ANCHOR / "SKILL.md"}）：外部技能库未挂载，无从判定')
        return 2

    def item(name, source_path=SELF_TEST_ANCHOR):
        return {'name': name, 'sourcePath': source_path, 'ledgerId': 'LAP-T', 'file': 'loop-ledger-vT.csv'}

    results, failures = [], []

    def check(label, ok, detail=''):
        results.append({'case': label, 'ok': bool(ok), 'detail': detail})
        if not ok:
            failures.append(label)

    # 要能绿：在位来源出一个 D 行，字节按库面现算
    rows, missing, excluded = select_appended([item('fixture-d-one')], set(), library)
    expect_sha = sha256_file(library / SELF_TEST_ANCHOR / 'SKILL.md')
    check('绿-D 成员成行', len(rows) == 1 and not missing and not excluded,
          f'rows={len(rows)} missing={len(missing)} excluded={len(excluded)}')
    check('绿-D 行字节按库面现算且带出处',
          bool(rows) and rows[0]['entrySha256'] == expect_sha
          and rows[0]['route'] == 'appended-registration' and rows[0]['provenanceRoot'] == 'loop-ledger-vT.csv',
          (rows[0].get('entrySha256') or '')[:12] if rows else '无行')

    # 要能红：台账说已投影、库面没入口 → 只能出现在 missing，不许静默消失
    rows2, missing2, excluded2 = select_appended([item('fixture-d-two', 'no-such-family/no-such-skill')],
                                                 set(), library)
    check('红-来源缺席进 missing', len(rows2) == 0 and len(missing2) == 1 and not excluded2,
          f'missing={missing2}')

    # 要能红：非 kebab 名 → 显式进 excluded（带 reason），不是被丢掉
    rows3, missing3, excluded3 = select_appended([item('Bad_Name')], set(), library)
    check('红-非 kebab 进 excluded', len(rows3) == 0 and len(excluded3) == 1
          and excluded3[0]['reason'] == 'non-kebab-name', f'excluded={excluded3}')

    # 要能绿：已被 A/B/C 选中的同名成员跳过，不重复成 op（ZIP 族 41 件补了索引后走 B 组）
    rows4, missing4, excluded4 = select_appended([item('fixture-d-one')], {'fixture-d-one'}, library)
    check('绿-已选中者跳过不重复', not rows4 and not missing4 and not excluded4,
          f'rows={len(rows4)} missing={len(missing4)} excluded={len(excluded4)}')

    # 覆盖门：满兜要绿，漏一个要红——被排除的成员必须显式成为 uncovered，而不是计划里少一件
    check('绿-覆盖门满兜为空', uncovered_members([item('fixture-d-one')], set(), rows) == [])
    leaked = uncovered_members([item('Bad_Name')], set(), rows3)
    check('红-被排除成员漏网要判红', leaked == ['Bad_Name'], f'uncovered={leaked}')
    check('绿-走 A/B 的成员不算漏网', uncovered_members([item('dup')], {'dup'}, []) == [])

    # 版本挑选：数字序（v10 比 v2 新）。字典序会挑到 v2 —— 名单就会停在旧版（§21.5 同一条教训）
    import csv as _csv
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        ledger_dir = Path(td) / '109-loop-ledger'
        ledger_dir.mkdir()
        for version, marker in (('v2', 'from-v2'), ('v10', 'from-v10')):
            with (ledger_dir / f'loop-ledger-{version}.csv').open('w', encoding='utf-8', newline='') as f:
                w = _csv.DictWriter(f, fieldnames=['ledgerId', 'name', 'assemblyStatus', 'sourcePath'])
                w.writeheader()
                w.writerow({'ledgerId': f'L{version}', 'name': marker,
                            'assemblyStatus': 'appended-projected', 'sourcePath': SELF_TEST_ANCHOR})
        picked = loop_appended_rows(Path(td))
        check('绿-台账取最新版本（数字序非字典序）',
              len(picked) == 1 and picked[0]['name'] == 'from-v10'
              and picked[0]['file'] == 'loop-ledger-v10.csv',
              f'{picked[0]["file"]}/{picked[0]["name"]}' if picked else '空')
        empty = Path(td) / 'empty'
        empty.mkdir()
        try:
            loop_appended_rows(empty)
            check('红-没有台账要出声', False, '未报错')
        except SystemExit as ex:
            check('红-没有台账要出声', True, str(ex)[:40])

    print(json.dumps({'mode': 'self-test', 'cases': len(results), 'failed': len(failures),
                      'failures': failures, 'results': results}, ensure_ascii=False, indent=1))
    return 1 if failures else 0


def json_dump(value):
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)


if __name__ == '__main__':
    if '--self-test' in __import__('sys').argv:
        raise SystemExit(self_test())
    raise SystemExit(main())
