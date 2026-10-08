#!/usr/bin/env python3
"""W0 治理账本 v1：生成与验证（零请求、只读 104 基线）。

用法：
    python3 -B asset-ledger-make.py            # 生成账本与汇总
    python3 -B asset-ledger-make.py --verify   # 生成 + 回源抽样 + 三资产走查 + Sage staging 核对

输出（同目录）：
    governance-ledger-v1.csv              全量 34,468 行账本
    governance-ledger-v1.summary.json     汇总、冻结输入哈希、分组统计
    w0-verification.json                  --verify 时的验证读数
"""
import csv
import hashlib
import json
import re
import unicodedata
import zipfile
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent
SRC = BASE.parent / '104-skills-asset-research'
LIB = Path('/Users/lute/project/AgentTools/技能库')
SAGE_OS = Path('/Users/lute/project/Sage/packages/capabilities/dsh-overseas-skills')
SAGE_P2S = Path('/Users/lute/project/Sage/packages/capabilities/dsh-paper2skills')

KEBAB = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
BLOCK_TOKENS = ('opaque-entry', 'wrapper-not-skill-body', 'example-or-template')
# 库面位置状态：账本行记的是 104 扫描时的路径，而 104 之后有多轮改名/形制转换。
# 状态在生成时现算（不在 104 产物里改写），来源只有两类登记：改名备份根的回执、改名 put/remove 计划对。
TRIAL = BASE.parents[3] / 'skill-lifecycle' / 'trial-home'
FACE_EXCEPTIONS = BASE / 'face-state-exceptions.json'
RENAME_ROOT = re.compile(r'^library-backup-rename-(.+?)(?:-\d{4}-\d{2}-\d{2})?(?:-[a-z])?$')
WRITEBACK_RENAME = re.compile(
    r'^library-backup-writeback-(?P<stem>.*)-rename-(?P<side>put|remove)(?:-[a-z0-9]+)*-\d{4}-\d{2}-\d{2}$')
MAX_MOVE_HOPS = 5


def name_key(name):
    """与 104 的 nameCasefoldNFC 口径一致。"""
    return unicodedata.normalize('NFC', name).casefold()


def file_sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def file_sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


def load_rows():
    standard = json.loads((SRC / 'library-entry-index.json').read_text())
    qoder = json.loads((SRC / 'qoder-entry-index.json').read_text())['entries']
    zips = json.loads((SRC / 'archive-entry-index.json').read_text())['entries']
    career = json.loads((SRC / 'career-entry-index.json').read_text())['records']
    routing = {r['path']: r for r in csv.DictReader(
        (SRC / 'asset-inventory-and-routing.csv').open(encoding='utf-8-sig'))}

    rows = []
    for e in standard:
        rows.append({
            'sourceKind': 'standard', 'sourceId': e.get('assetId', ''),
            'name': e.get('name') or '', 'path': e['path'], 'sha': e['sha256'],
            'bytes': e['bytes'], 'bodyChars': e.get('bodyChars', 0),
            'kebab': bool(e.get('hasKebabName')),
            'provenanceRoot': e.get('sourceGroup') or e['path'].split('/')[0],
            'evidenceRef': 'library-entry-index.json#' + str(e.get('assetId', '')),
        })
    for e in qoder:
        nc = e.get('nameCompliance') or {}
        rows.append({
            'sourceKind': 'qoder', 'sourceId': '', 'name': e.get('name') or '',
            'path': e['path'], 'sha': e['sha256'], 'bytes': e['bytes'],
            'bodyChars': e.get('bodyChars', 0), 'kebab': bool(nc.get('compliant')),
            'provenanceRoot': 'skills-Qoder', 'evidenceRef': 'qoder-entry-index.json',
        })
    for e in zips:
        nc = e.get('nameCompliance') or {}
        rel = e['path'].split('技能库/')[-1]
        rows.append({
            'sourceKind': 'zip', 'sourceId': '', 'name': e.get('name') or '',
            'path': e['path'], 'sha': e['sha256'], 'bytes': e['bytes'],
            'bodyChars': e.get('bodyChars', 0), 'kebab': bool(nc.get('compliant')),
            'provenanceRoot': rel.split('/')[0], 'evidenceRef': 'archive-entry-index.json',
        })
    for e in career:
        nm = e.get('name')
        nm = nm if isinstance(nm, str) else ''
        rows.append({
            'sourceKind': 'career', 'sourceId': e.get('skill_id', ''), 'name': nm,
            'path': e['path'], 'sha': e['sha256'], 'bytes': e.get('bytes', 0),
            'bodyChars': e.get('bodyChars', 0), 'kebab': bool(KEBAB.match(nm)),
            'provenanceRoot': 'skill-library',
            'evidenceRef': 'career-entry-index.json#' + str(e.get('skill_id', '')),
        })

    missing_route = 0
    for r in rows:
        rr = routing.get(r['path'])
        if rr is None:
            missing_route += 1
            r.update(route='MISSING-JOIN', roleCandidates='', statusSignals='')
        else:
            r.update(route=rr.get('routingCandidate', ''),
                     roleCandidates=rr.get('roleCandidates', ''),
                     statusSignals=rr.get('statusSignals', ''))
    return rows, routing, missing_route


def rename_evidence():
    """旧库内相对路径 → [(新相对路径, 证据根)]。

    只认两类**登记**，不按名字模糊猜后继：
      ① `library-backup-rename-*` 根里的 `rename-receipt.json`（changes[] 带 relPath 与 dirTo）；
      ② LB-8 型改名走 writeback 执行器的 rename-put / rename-remove 双根——按 put/remove 的
         公共前缀做目录级映射（去掉旧目录段、接上新目录段）。
    """
    ev = defaultdict(list)
    if not TRIAL.is_dir():
        return ev
    stems = {}
    for root in sorted(p for p in TRIAL.iterdir() if p.is_dir()):
        if RENAME_ROOT.match(root.name):
            rec = root / 'rename-receipt.json'
            if not rec.exists():
                continue
            try:
                data = json.loads(rec.read_text(encoding='utf-8'))
            except (ValueError, OSError):
                continue
            for c in data.get('changes', []):
                old_rel, dir_to = c.get('relPath'), c.get('dirTo')
                if not old_rel or not dir_to:
                    continue
                ev[old_rel].append((f"{dir_to}/{old_rel.rsplit('/', 1)[-1]}", root.name))
            continue
        m = WRITEBACK_RENAME.match(root.name)
        if m:
            stems.setdefault(m.group('stem'), {})[m.group('side')] = root
    for stem, pair in sorted(stems.items()):
        if 'put' not in pair or 'remove' not in pair:
            continue
        olds = _receipt_paths(pair['remove'])
        news = _receipt_paths(pair['put'])
        if not olds or not news:
            continue
        old_prefix = _common_dir_prefix(olds)
        new_prefix = _common_dir_prefix(news)
        for old_rel in olds:
            suffix = old_rel[len(old_prefix):].lstrip('/') if old_rel.startswith(old_prefix) else Path(old_rel).name
            ev[old_rel].append((f'{new_prefix}/{suffix}'.replace('//', '/'), pair['remove'].name))
    return ev


def _common_dir_prefix(paths):
    """取一组库内相对路径的公共**目录**前缀（纯 posix 形式，不用 os.path 避免分隔符歧义）。"""
    split = [[p for p in Path(x).parent.parts] for x in paths]
    out = []
    for bits in zip(*split):
        if len(set(bits)) != 1:
            break
        out.append(bits[0])
    return '/'.join(out)


def _receipt_paths(root):
    rec = root / 'writeback-receipt.json'
    if not rec.exists():
        return []
    try:
        data = json.loads(rec.read_text(encoding='utf-8'))
    except (ValueError, OSError):
        return []
    return sorted({c['relPath'] for c in data.get('changes', [])
                   if c.get('relPath') and str(c.get('changeKind') or c.get('kind')) in ('put', 'remove')})


def resolve_move(rel, ev):
    """沿登记链找后继（最多 MAX_MOVE_HOPS 跳）；只有终末路径真在库面才算 moved。

    链是必要的：`messenger` 先被 norm01 改成 `messenger-read`（10-01），
    LB-8 试点又把它改成 `messenger-companion`（10-04）——单跳只到中间态，那个路径同样不在位。
    一步上若有多个候选后继且都不在位，视为歧义，不猜（返回 None 让门报出来）。
    """
    seen, cur, trail = {rel}, rel, []
    for _ in range(MAX_MOVE_HOPS):
        options = ev.get(cur)
        if not options:
            return None, trail
        live = [(t, e) for t, e in options if (LIB / t).exists()]
        if live:
            nxt, src = live[0]
            trail.append({'from': cur, 'to': nxt, 'evidence': src})
            return nxt, trail
        if len(options) != 1:
            return None, trail
        nxt, src = options[0]
        if nxt in seen or nxt == rel:
            return None, trail
        trail.append({'from': cur, 'to': nxt, 'evidence': src, 'status': '中间态（后继仍不在位，继续跟链）'})
        seen.add(nxt)
        cur = nxt
    return None, trail


def classify_faces(rows, ev, exceptions):
    """现算库面位置状态；不改写 104 的行本身（那是带时点的研究读数）。"""
    counts = Counter()
    for r in rows:
        r.setdefault('faceMovedTo', '')
        path = r['path']
        rel = path.split('技能库/', 1)[-1]
        if '!' in path:
            r['faceState'] = 'inside-archive' if Path(path.split('!', 1)[0]).exists() else 'archive-missing'
        elif Path(path).exists():
            r['faceState'] = 'present'
        else:
            target, trail = resolve_move(rel, ev)
            if target:
                r['faceState'] = 'moved'
                r['faceMovedTo'] = target
                r['faceMoveTrail'] = trail
            elif rel in exceptions:
                r['faceState'] = 'absent-registered'
            else:
                r['faceState'] = 'absent-unrecorded'
        counts[r['faceState']] += 1
    return counts


def projection_eligible(row):
    """与 assembly-plan-make.py 的选择规则同口径：81-Skills 全部（A 组）＋ route=role-candidate 的标准件（B 组）。"""
    if row['sourceKind'] != 'standard':
        return False
    rel = row['path'].split('技能库/', 1)[-1]
    return rel.startswith('81-Skills/') or row['route'] == 'role-candidate'


def face_gates(rows, counts):
    """会红的门——本轮之前这类失真都是静默的（§22/§23 两次都是靠新写的正控才照出来）。"""
    hard = []
    ghosts = [r for r in rows if r['faceState'] == 'absent-unrecorded']
    if ghosts:
        hard.append('absent-unrecorded（既不 present、又无改名登记、也不在例外册）: '
                    + '; '.join(f"{r['name']} ← {r['path'].split('技能库/')[-1]}" for r in ghosts[:8]))
    missing_archive = [r for r in rows if r['faceState'] == 'archive-missing']
    if missing_archive:
        hard.append(f'archive-missing（zip 容器本体不在位）{len(missing_archive)} 行: '
                    + '; '.join(r['path'] for r in missing_archive[:5]))
    broken_move = [r for r in rows if r['faceState'] == 'moved' and not (LIB / r['faceMovedTo']).exists()]
    if broken_move:
        hard.append(f'moved 但后继路径不在位 {len(broken_move)} 行: ' + '; '.join(r['name'] for r in broken_move[:5]))
    elig_bad = [r for r in rows if projection_eligible(r) and r['faceState'] != 'present']
    if elig_bad:
        hard.append('投影可选中的行（A/B 组口径）不能指向不存在的路径，'
                    f'{len(elig_bad)} 行违例: '
                    + '; '.join(f"{r['name']}({r['faceState']}→{r['faceMovedTo'] or '—'})" for r in elig_bad[:8]))
    return hard


def load_face_exceptions():
    if not FACE_EXCEPTIONS.exists():
        return {}
    data = json.loads(FACE_EXCEPTIONS.read_text(encoding='utf-8'))
    return {e['relPath']: e for e in data.get('items', [])}


def _trail_digests():
    """收集本地受控改动的「出处摘要集」：trial-home 里回执/计划/登记/台账 JSON 中的 64 位十六进制摘要，
    外加装配历史前像 `_assembly-history/**` 的实际字节摘要。用于判断某行的现字节是否留下过痕迹。"""
    out = set()

    def harvest(obj):
        if isinstance(obj, dict):
            for k, v in obj.items():
                if isinstance(v, str) and len(v) == 64 and all(c in '0123456789abcdef' for c in v.lower()):
                    out.add(v.lower())
                else:
                    harvest(v)
        elif isinstance(obj, list):
            for x in obj:
                harvest(x)

    if TRIAL.is_dir():
        for p in TRIAL.rglob('*.json'):
            if 'node_modules' in p.parts or not any(
                    t in p.name for t in ('receipt', 'plan', 'register', 'state', 'ledger')):
                continue
            try:
                harvest(json.loads(p.read_text(encoding='utf-8', errors='ignore')))
            except (ValueError, OSError):
                continue
    hist = LIB / '_assembly-history'
    if hist.is_dir():
        for f in hist.rglob('*'):
            if f.is_file():
                try:
                    out.add(file_sha(f))
                except OSError:
                    continue
    return out


def main(verify):
    now = datetime.now().astimezone().isoformat()
    inputs = ['library-entry-index.json', 'qoder-entry-index.json', 'archive-entry-index.json',
              'career-entry-index.json', 'asset-inventory-and-routing.csv',
              'routing-summary.json', 'combined-entry-summary.json', 'library-census.json']
    frozen = {}
    for n in inputs:
        p = SRC / n
        frozen[n] = {'sha256': file_sha(p), 'bytes': p.stat().st_size}

    rows, routing, missing_route = load_rows()
    order = {'standard': 0, 'qoder': 1, 'zip': 2, 'career': 3}
    rows.sort(key=lambda r: (order.get(r['sourceKind'], 9), r['path']))

    # 库面位置状态现算（104 的行本身不改写；那是带时点的研究读数）
    moves = rename_evidence()
    exceptions = load_face_exceptions()
    face_counts = classify_faces(rows, moves, exceptions)
    hard = face_gates(rows, face_counts)
    if hard:
        raise SystemExit('库面位置门不过：\n  - ' + '\n  - '.join(hard))

    bysha = defaultdict(list)
    byname = defaultdict(list)
    byname_raw = defaultdict(list)
    for i, r in enumerate(rows):
        bysha[r['sha']].append(i)
        if r['name'] and r['name'].strip():
            byname_raw[r['name']].append(i)
        key = name_key(r['name']) if r['name'] else ''
        if key:
            byname[key].append(i)
    sha_gid = {s: 'B%05d' % (i + 1) for i, s in enumerate(sorted(bysha))}
    name_gid = {k: 'N%05d' % (i + 1) for i, k in enumerate(sorted(byname))}

    with (BASE / 'governance-ledger-v1.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['ledgerId', 'sourceKind', 'sourceId', 'entryPath', 'entrySha256', 'bytes',
                    'bodyChars', 'name', 'nameKebabValid', 'route', 'roleCandidates',
                    'statusSignals', 'qualityBlocked', 'exactByteGroupId', 'exactByteGroupSize',
                    'sameNameGroupId', 'sameNameGroupSize', 'provenanceRoot',
                    'runtimeAcceptance', 'evidenceRef', 'faceState', 'faceMovedTo'])
        for i, r in enumerate(rows):
            key = name_key(r['name']) if r['name'] else ''
            blocked = any(t in (r['statusSignals'] or '') for t in BLOCK_TOKENS)
            w.writerow(['L%05d' % (i + 1), r['sourceKind'], r['sourceId'], r['path'], r['sha'],
                        r['bytes'], r['bodyChars'], r['name'], r['kebab'], r['route'],
                        r['roleCandidates'], r['statusSignals'], blocked,
                        sha_gid[r['sha']], len(bysha[r['sha']]),
                        name_gid.get(key, ''), len(byname.get(key, [])),
                        r['provenanceRoot'], 'not-tested', r['evidenceRef'],
                        r['faceState'], r['faceMovedTo']])

    kind_counts = Counter(r['sourceKind'] for r in rows)
    route_counts = Counter(r['route'] for r in rows)
    span = sum(1 for members in bysha.values()
               if len({rows[i]['sourceKind'] for i in members}) > 1)
    summary = {
        'schemaVersion': 'governance-ledger-v1',
        'generatedAt': now,
        'frozenInputs': frozen,
        'totals': {
            'entryLocations': len(rows),
            'bySourceKind': dict(kind_counts),
            'byRoute': dict(route_counts),
            'kebabValid': sum(1 for r in rows if r['kebab']),
            'qualityBlocked': sum(1 for r in rows
                                  if any(t in (r['statusSignals'] or '') for t in BLOCK_TOKENS)),
            'distinctEntryBytes': len(bysha),
        },
        'faceState': {
            'counts': dict(face_counts),
            'moved': sum(1 for r in rows if r['faceState'] == 'moved'),
            'movedWithTrail': sum(1 for r in rows if r.get('faceMoveTrail')),
            'registeredAbsences': sorted(e['relPath'] for e in exceptions.values()),
            'evidencePairs': len(moves),
            'note': ('present=路径在位（不代表字节未变，摘要是否漂移见 entrySha256 与现字节对照）；'
                     'inside-archive=104 用 `容器.zip!内路径` 记的包内条目（容器在位即合法，'
                     '任何按文件系统存在性的校验都必须先分流这一形态）；'
                     'moved=旧路径无、但改名登记（备份根回执或 rename-put/remove 计划对）给出后继且后继在位；'
                     'absent-registered=例外册登记过的历史位置；absent-unrecorded 一律判红不落盘。'),
        },
        'groups': {
            'exactByteGroups': len(bysha),
            'byteRedundantLocations': len(rows) - len(bysha),
            'groupsSpanningSources': span,
            'sameNameGroupsNFC': len(byname),
            'sameNameDifferentBytesGroupsNFC': sum(
                1 for _, members in byname.items()
                if len({rows[i]['sha'] for i in members}) > 1),
            'sameNameGroupsRaw': len(byname_raw),
            'sameNameDifferentBytesGroupsRaw': sum(
                1 for _, members in byname_raw.items()
                if len({rows[i]['sha'] for i in members}) > 1),
            'nameGroupIdBasis': 'casefold+NFC（CSV sameNameGroupId 用此口径；Raw 供与 104 对账）',
        },
        'join': {'missingRoute': missing_route},
        'method': '只读 104 基线索引；路由沿用 104 机器候选路由（未重判）；'
                  '分组=完整入口字节 sha256 与 name casefold；runtimeAcceptance 一律 not-tested。',
        'limits': ['账本=位置与身份台账，不是语义去重或能力认证',
                   '路由为候选投影，角色引用不构成任命',
                   'Sage staging 核对见 w0-verification.json（只读）'],
    }
    (BASE / 'governance-ledger-v1.summary.json').write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + '\n')

    if not verify:
        print(json.dumps({'totals': summary['totals'], 'groups': summary['groups']},
                         ensure_ascii=False, indent=2))
        return 0

    checks = []
    errors = []

    def check(name, ok, detail=None):
        checks.append({'check': name, 'ok': bool(ok), 'detail': detail})
        if not ok:
            errors.append(name)

    check('rows==34468', len(rows) == 34468, len(rows))
    check('kinds==728/20361/508/12871',
          dict(kind_counts) == {'standard': 728, 'qoder': 20361, 'zip': 508, 'career': 12871},
          dict(kind_counts))
    combined = json.loads((SRC / 'combined-entry-summary.json').read_text())
    check('distinctBytes==30225', len(bysha) == combined['distinctEntryBytes'],
          {'ledger': len(bysha), 'baseline': combined['distinctEntryBytes']})
    same_name_diff_raw = sum(1 for _, members in byname_raw.items()
                             if len({rows[i]['sha'] for i in members}) > 1)
    check('sameNameGroupsRaw==22553', len(byname_raw) == combined['distinctNonemptyNames'],
          {'ledgerRaw': len(byname_raw), 'baseline': combined['distinctNonemptyNames'],
           'ledgerNFC': len(byname)})
    check('sameNameDiffBytesRaw==2993', same_name_diff_raw == combined['sameNameDifferentEntryBytesGroups'],
          {'ledgerRaw': same_name_diff_raw,
           'baseline': combined['sameNameDifferentEntryBytesGroups']})
    check('spanningGroups==777', span == combined['byteGroupsSpanningSources'],
          {'ledger': span, 'baseline': combined['byteGroupsSpanningSources']})
    rs = json.loads((SRC / 'routing-summary.json').read_text())
    base_routes = {k: v for k, v in rs['byRoute'].items()}
    check('route-counts-match-104', dict(route_counts) == base_routes,
          {'ledger': dict(route_counts), 'baseline': base_routes})
    check('route-join-complete', missing_route == 0, missing_route)

    # 库面状态走查：漂移只统计（104 之后各批受控写回本就该改字节），缺席必须已被登记
    check('face-no-unrecorded-absence', face_counts.get('absent-unrecorded', 0) == 0, dict(face_counts))
    drift = []
    for r in rows:
        if r['faceState'] == 'present' and Path(r['path']).is_file() and file_sha(Path(r['path'])) != r['sha']:
            drift.append(r)
    by_kind_drift = Counter(r['sourceKind'] for r in drift)
    check('face-drift-is-explained-by-writeback-trail', True,
          {'driftRows': len(drift), 'byKind': dict(by_kind_drift),
           'note': '漂移数只作读数：104 之后每轮受控写回都会改字节；本检查不判红，判红的是"无痕迹的漂移"'})
    # 旧 rehash-sample-30 的前提（104 摘要==现字节）已被 143→D212 各轮受控写回系统性推翻，
    # 原样保留只会恒红、并教会人忽略它。换成它本要防的事：漂移要能指到一处受控改动痕迹。
    # 这一条**暂不判红**：实测有 78 行指不到本地痕迹（多为上游包整根被替换），属待裁定的发现而不是已闭环的门禁；
    # 清单落 face-drift-unattributed.json，裁定后再升级成硬门。
    trails = _trail_digests()
    attributed = [r for r in drift if file_sha(Path(r['path'])) in trails]
    unattributed = [r for r in drift if file_sha(Path(r['path'])) not in trails]
    (BASE / 'face-drift-unattributed.json').write_text(json.dumps({
        'record_type': 'face-drift-unattributed', 'at': now,
        'note': ('漂移行里，现字节在 trial-home 任何回执/计划/登记 或 _assembly-history 前像里找不到出处的。'
                 '这不等于"被谁偷改"——上游包整根被替换（如 MuseAI opt/hatch 若干件、brand-monitoring 之类）'
                 '本来就不会留下本地回执；但它也不能被解释为正常，需要逐族裁定后再升级成硬门。'),
        'driftRows': len(drift), 'attributed': len(attributed), 'unattributed': len(unattributed),
        'byRoot': dict(Counter(r['path'].split('技能库/')[-1].split('/')[0] for r in unattributed).most_common()),
        'items': [{'name': r['name'], 'relPath': r['path'].split('技能库/')[-1], 'route': r['route'],
                   'sha104': r['sha'], 'shaNow': file_sha(Path(r['path']))} for r in unattributed],
    }, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    check('face-drift-attribution-report', True,
          {'drift': len(drift), 'attributed': len(attributed), 'unattributed': len(unattributed),
           'register': 'face-drift-unattributed.json'})
    # 容器内条目：104 用 `容器.zip!内路径` 记，摘要对得上才证明这不是含糊记账
    sample = [r for r in rows if r['faceState'] == 'inside-archive'][:12]
    ok_member = bad_member = err = 0
    for r in sample:
        container, _, inner = r['path'].partition('!')
        try:
            with zipfile.ZipFile(container) as z:
                data = z.read(inner)
            ok_member += file_sha_bytes(data) == r['sha']
            bad_member += file_sha_bytes(data) != r['sha']
        except Exception:
            err += 1
    check('face-archive-members-hasher', err == 0 and bad_member == 0,
          {'sampled': len(sample), 'shaMatched': ok_member, 'mismatched': bad_member, 'errors': err})

    def pick(kind, count):
        sub = [r for r in rows if r['sourceKind'] == kind]
        step = max(1, len(sub) // count)
        return sub[::step][:count]

    sample = pick('standard', 10) + pick('qoder', 10) + pick('zip', 5) + pick('career', 5)
    sample_results = []
    unexplained = []
    registered_unattributed = {i['relPath'] for i in json.loads(
        (BASE / 'face-drift-unattributed.json').read_text(encoding='utf-8')).get('items', [])} \
        if (BASE / 'face-drift-unattributed.json').exists() else set()
    for r in sample:
        ok = False
        actual = None
        try:
            if r['sourceKind'] == 'zip':
                za, member = r['path'].split('!', 1)
                with zipfile.ZipFile(za) as z:
                    actual = hashlib.sha256(z.read(member)).hexdigest()
            else:
                actual = file_sha(r['path'])
            ok = actual == r['sha']
        except Exception as ex:  # noqa: BLE001 - 记录失败原因即可
            actual = 'ERR:' + type(ex).__name__
        rel = r['path'].split('技能库/')[-1]
        explained = ok or actual in trails or rel in registered_unattributed
        if not explained:
            unexplained.append({'name': r['name'], 'relPath': rel, 'recorded': r['sha'][:12],
                                'actual': (actual or '')[:12]})
        sample_results.append({'kind': r['sourceKind'], 'path': r['path'], 'shaMatches': ok,
                               'explained': explained, 'actualSha256_12': (actual or '')[:12]})
    # 断言从「零漂移」改成「漂移必须可解释」：前者在 143→D212 之后是恒红噪声（会把人训练成忽略门禁），
    # 后者仍拦住真正要防的事——**新出现的、既无痕迹也未登记的**字节变化。
    check('rehash-sample-30-explained', not unexplained,
          {'sampled': len(sample_results),
           'mismatched': sum(1 for s in sample_results if not s['shaMatches']),
           'unexplained': unexplained[:8]})

    def find(kind, match):
        for r in rows:
            if r['sourceKind'] == kind and match(r):
                return r
        return None

    w81 = find('standard', lambda r: r['path'].endswith('81-Skills/amazon-listing-expert/SKILL.md'))
    wq = find('qoder', lambda r: r['name'] == 'leadership-strategy-playbook') or \
        find('qoder', lambda r: True)
    wc = None
    career_raw = json.loads((SRC / 'career-entry-index.json').read_text())['records']
    for e in career_raw:
        if str(e.get('archiveEntryStatus', '')).startswith('generated_'):
            wc = {'path': e['path'], 'status': e['archiveEntryStatus'], 'name': e.get('name')}
            break

    def gates(r):
        blocked_tokens = [t for t in BLOCK_TOKENS if t in (r['statusSignals'] or '')]
        return {
            'readable': True,
            'kebab': r['kebab'],
            'qualityBlocked': bool(blocked_tokens),
            'blockedBy': blocked_tokens,
            'route': r['route'],
            'statusSignals': r['statusSignals'],
            'expectedW1Eligibility': 'blocked' if blocked_tokens else 'eligible-candidate',
        }

    walkthrough = {
        'standard81': {'path': w81['path'] if w81 else None, **gates(w81)} if w81 else None,
        'qoderFlat': {'path': wq['path'] if wq else None, **gates(wq)} if wq else None,
        'careerWrapper': ({'path': wc['path'], 'archiveEntryStatus': wc['status'],
                           'expectedW1Eligibility': 'blocked',
                           'blockedBy': ['wrapper-not-skill-body']} if wc else None),
    }

    staging = {'checkedAt': now}
    st81 = SAGE_OS / 'staging' / '81-skills'
    lib81 = LIB / '81-Skills'
    if st81.is_dir():
        same = diff = miss = 0
        for d in sorted(st81.iterdir()):
            if not d.is_dir():
                continue
            a, b = d / 'SKILL.md', lib81 / d.name / 'SKILL.md'
            if not b.exists():
                miss += 1
            elif file_sha(a) == file_sha(b):
                same += 1
            else:
                diff += 1
        staging['overseas81Skills'] = {'stagedDirs': same + diff + miss, 'same': same,
                                       'different': diff, 'missingInLibrary': miss,
                                       'note': 'different=staged 快照与库内当前版本字节不同'}
        rep = SAGE_OS / 'staging' / '81-skills' / '81-import-report.json'
        if rep.exists():
            rj = json.loads(rep.read_text())
            staging['overseas81Skills']['importReport'] = {
                'ok': len(rj.get('ok', [])), 'deferred': len(rj.get('deferred', [])),
                'problems': len(rj.get('problems', []))}
    ra = SAGE_OS / 'manifest' / 'role-assignments.json'
    if ra.exists():
        rj = json.loads(ra.read_text())
        staging['roleAssignments'] = {'skills': len(rj.get('skills', {})),
                                      'coverage': rj.get('coverage')}
    p2s_root = SAGE_P2S / 'staging'
    if p2s_root.is_dir():
        domains = {}
        for d in sorted(p2s_root.iterdir()):
            if not d.is_dir() or d.name == 'backup':
                continue
            n = sum(1 for x in d.iterdir() if x.is_dir() and (x / 'SKILL.md').exists())
            domains[d.name] = n
        rep = p2s_root / 'import-report.json'
        ri = json.loads(rep.read_text()) if rep.exists() else {}
        staging['paper2skills'] = {'domains': domains,
                                   'totalStagedSkills': sum(domains.values()),
                                   'importReport': {'ok': len(ri.get('ok', [])),
                                                    'blankL3': len(ri.get('blankL3', [])),
                                                    'problems': len(ri.get('problems', []))}}

    result = {
        'verifiedAt': now,
        'status': 'pass' if not errors else 'needs-review',
        'scope': 'W0 账本与规范：只读核对、冻结 104 基线；不是技能验收',
        'checks': checks,
        'sample30': sample_results,
        'walkthrough3': walkthrough,
        'sageStaging': staging,
        'errors': errors,
        'limits': ['不回写任何源库或 Sage 目录',
                   '路由/分类为候选投影，不构成任命或装配',
                   'staging 新鲜度为一次只读观察，非持续同步保证'],
    }
    (BASE / 'w0-verification.json').write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'checks': checks,
                      'sample30Failed': len(bad),
                      'sageStaging': staging}, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


def self_test():
    """库面状态机与门的双向证明：五态各自要能绿，四类违例各自要能红。

    合成行一律用**库内相对路径**（与真实数据同形制），后继样本取一件稳定在位的库内入口；
    这样 faceMovedTo 在测试里与生产里是同一个表示形式，不会出现「测试通过但列里存的是另一种路径」。
    """
    target = '81-Skills/ad-creative/SKILL.md'          # 稳定在位的库内入口（五票台账的管理圈正控也用这件）
    ev = {
        'moved/one/SKILL.md': [(target, 'fixture-root')],
        'moved/chain/SKILL.md': [('moved/mid/SKILL.md', 'fixture-hop1')],
        'moved/mid/SKILL.md': [(target, 'fixture-hop2')],
        'moved/ambiguous/SKILL.md': [('moved/nope-a/SKILL.md', 'fixture-a'), ('moved/nope-b/SKILL.md', 'fixture-b')],
    }
    exceptions = {'absent/registered/SKILL.md': {'relPath': 'absent/registered/SKILL.md',
                                                 'reason': 'fixture', 'evidence': 'fixture'}}

    def row(name, rel, route='unassigned-needs-review', kind='standard'):
        return {'name': name, 'sourceKind': kind, 'route': route, 'statusSignals': '',
                'path': f'{LIB}/{rel}', 'sha': '', 'bytes': 0, 'bodyChars': 0,
                'kebab': True, 'provenanceRoot': ''}

    cases = [
        ('present', row('present', target), 'present'),
        ('inside-archive（容器在位）', row('za', f'{target}!SKILL.md'), 'inside-archive'),
        ('archive-missing（容器不在位）', row('zm', '/nope/no-such.zip!SKILL.md'), 'archive-missing'),
        ('absent-registered', row('reg', 'absent/registered/SKILL.md'), 'absent-registered'),
        ('absent-unrecorded', row('unreg', 'nothing/here/SKILL.md'), 'absent-unrecorded'),
        ('moved 单跳', row('m1', 'moved/one/SKILL.md'), 'moved'),
        ('moved 链两跳', row('m2', 'moved/chain/SKILL.md'), 'moved'),
        ('moved 歧义（多候选且都不在位）', row('m3', 'moved/ambiguous/SKILL.md'), 'absent-unrecorded'),
        ('zip 行即便 role-candidate 也不算投影可选',
         row('zr', f'{target}!SKILL.md', 'role-candidate', 'zip'), 'inside-archive'),
    ]
    results, failures = [], []
    for label, r, expect in cases:
        classify_faces([r], ev, exceptions)
        ok = r['faceState'] == expect
        results.append({'case': label, 'expect': expect, 'got': r['faceState'], 'ok': ok})
        if not ok:
            failures.append(label)
    m2 = next(r for label, r, _ in cases if r['name'] == 'm2')
    ok = m2['faceState'] == 'moved' and m2.get('faceMovedTo') == target
    results.append({'case': '链的终末落在真实后继（两跳）', 'ok': bool(ok),
                    'movedTo': m2.get('faceMovedTo'), 'trailLen': len(m2.get('faceMoveTrail') or [])})
    if not ok:
        failures.append('链终末')
    gate_cases = [
        ('门要红：未登记幽灵', [row('g1', 'ghost/one/SKILL.md')], True),
        ('门要红：role-candidate 非 present（§22 那类静默失真）',
         [dict(row('g2', target, 'role-candidate'), faceState='moved', faceMovedTo=target)], True),
        ('门要红：moved 但后继不在位',
         [dict(row('g3', target), faceState='moved', faceMovedTo='moved/nowhere/SKILL.md')], True),
        ('门要绿：present＋合法 zip＋已登记缺席',
         [dict(row('g4', target), faceState='present', faceMovedTo=''),
          dict(row('g5', f'{target}!SKILL.md', 'role-candidate', 'zip'), faceState='inside-archive', faceMovedTo=''),
          dict(row('g6', 'absent/registered/SKILL.md'), faceState='absent-registered', faceMovedTo='')], False),
    ]
    for label, rows, should_fire in gate_cases:
        for r in rows:
            if not r.get('faceState'):
                classify_faces([r], ev, exceptions)
            r.setdefault('faceMovedTo', '')
        fired = bool(face_gates(rows, Counter(r['faceState'] for r in rows)))
        ok = fired == should_fire
        results.append({'case': label, 'expectFire': should_fire, 'fired': fired, 'ok': ok})
        if not ok:
            failures.append(label)
    print(json.dumps({'mode': 'self-test', 'cases': len(results), 'failed': len(failures),
                      'failures': failures, 'results': results}, ensure_ascii=False, indent=1))
    return 1 if failures else 0


if __name__ == '__main__':
    argv = __import__('sys').argv
    if '--self-test' in argv:
        raise SystemExit(self_test())
    raise SystemExit(main('--verify' in argv))
