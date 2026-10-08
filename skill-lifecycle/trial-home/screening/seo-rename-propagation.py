#!/usr/bin/env python3
"""把 140 号的目录改名（skill-zyx → seo-orchestrator）传播到 104 的三份**活体指针**产物。

为什么需要这一步：140 号改了库内目录、batch1 计划、进度源、闭环台账与装配，
但 104 的研究产物（无生成器）没跟上 ⇒ 治理账本里留下一行**指向不存在路径**的 role-candidate，
而真实件在索引里没有自己的行。后果是可复算链断一格：B 组规则选中幽灵行、
`dir_op` 在「源目录要有 SKILL.md」处把它排除（no-skill-md），`_assembly-v1/seo-orchestrator` 从此推不出计划。

**字段只按标定过的配方重算**（`--self-test` 拿改名前备份字节逐字段复现 104 的原始读数，全等才允许落盘）；
目录派生字段（ownedFiles／ownedBytes／topLevelLayout／scriptFiles／testFiles／referenceFiles／
playbookFiles／hasLicense／hasManifest／nestedRole／ownedOpaqueFiles）的配方**复现不了**（8 件里只有 1 件全等），
所以一律**保留 104 时点读数并显式标注**，不猜。

只动三份「活体指针」：`library-entry-index.json`、`asset-inventory-and-routing.csv`、
`role-coverage-matrix.json`（＋其 `.csv` 同形件）。
`library-census.json`／`library-file-manifest.json`／`library-source-groups.json`／`library-links-and-empty.json`／
`library-static-screen.json`／`standard-career-crosswalk.json`／`role-candidate-selections.json` 与两份 104 报告
是**带时点的研究快照**（census 有 timestamp 字段），改它们等于把历史观测改写成当下值——不动，只在记录里登记。

用法：python3 -B seo-rename-propagation.py --self-test
      python3 -B seo-rename-propagation.py [--apply]
"""
import argparse
import csv
import hashlib
import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[3]
R104 = REPO / 'docs/specs/2026-09-25-dsh-skill-lifecycle/104-skills-asset-research'
LIB = Path('/Users/lute/project/AgentTools/技能库')
OLD_DIR = 'skill-zyx'
NEW_DIR = 'seo-orchestrator'
OLD_NAME = 'seo-skill-v1-5-candidate'
ASSET_ID = 'A0448'
STAMP = '2026-10-08'
KEBAB = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')

# 标定过的字段（--self-test 逐字段复现 104 原始读数）
DERIVED_FIELDS = ['sha256', 'bytes', 'opaque', 'utf8', 'frontmatterPresent', 'yamlError', 'name',
                  'description', 'version', 'metadataKeys', 'tags', 'disableModelInvocation',
                  'userInvocable', 'bodyChars', 'bodyLines', 'headings', 'replacementChars', 'hasKebabName']
# 配方复现不了 ⇒ 保留 104 读数并标注
RETAINED_FIELDS = ['ownedFiles', 'ownedBytes', 'ownedOpaqueFiles', 'topLevelLayout', 'scriptFiles',
                   'testFiles', 'referenceFiles', 'playbookFiles', 'hasLicense', 'hasManifest', 'nestedRole']


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def derive(entry_path: Path):
    """按标定过的口径从入口文件重算字段（bodyChars=len(body.strip())，metadataKeys=顶层 fm 键原序…）。"""
    raw = entry_path.read_bytes()
    text = raw.decode('utf-8', errors='strict') if _is_utf8(raw) else raw.decode('utf-8', errors='replace')
    m = re.match(r'^---[ \t]*\n(.*?)\n---[ \t]*\n?', text, re.S)
    fm = yaml.safe_load(m.group(1)) if m else {}
    body = text[m.end():] if m else text
    name = fm.get('name') if isinstance(fm, dict) else None
    return {
        'sha256': hashlib.sha256(raw).hexdigest(),
        'bytes': len(raw),
        'opaque': b'\x00' in raw,
        'utf8': _is_utf8(raw),
        'frontmatterPresent': m is not None,
        'yamlError': None if m is not None and isinstance(fm, dict) else ('NO_FRONTMATTER' if m is None else 'NOT_A_MAP'),
        'name': name,
        'description': fm.get('description') if isinstance(fm, dict) else None,
        'version': fm.get('version', '') if isinstance(fm, dict) else '',
        'metadataKeys': list(fm.keys()) if isinstance(fm, dict) else [],
        'tags': fm.get('tags') if isinstance(fm, dict) else None,
        'disableModelInvocation': fm.get('disable-model-invocation') if isinstance(fm, dict) else None,
        'userInvocable': fm.get('user-invocable') if isinstance(fm, dict) else None,
        'bodyChars': len(body.strip()),
        'bodyLines': len(body.splitlines()),
        'headings': [t for _, t in re.findall(r'^(#{1,6})\s+(.+?)\s*$', body, re.M)],
        'replacementChars': text.count('\ufffd'),
        'hasKebabName': bool(KEBAB.match(str(name or ''))),
    }


def _is_utf8(raw: bytes) -> bool:
    try:
        raw.decode('utf-8')
        return True
    except UnicodeDecodeError:
        return False


def load_index(pre_repair=False):
    # 标定必须在修复后仍可跑：修复后活体行已是新值，与备份字节的摘要不再相等，
    # 所以要读修复前的那一份记录（`.bak-seo-rename-*`）；没有备份时才退回活体索引（＝首次修复前）。
    if pre_repair:
        backups = sorted(R104.glob('library-entry-index.json.bak-seo-rename-*'))
        if backups:
            return json.loads(backups[-1].read_text(encoding='utf-8')), backups[-1].name
    return load_index_raw(), 'library-entry-index.json'


def load_index_raw():
    return json.loads((R104 / 'library-entry-index.json').read_text(encoding='utf-8'))


def ghost_row(index):
    rows = [e for e in index if e.get('assetId') == ASSET_ID]
    if len(rows) != 1:
        raise SystemExit(f'索引里 assetId={ASSET_ID} 应恰好 1 行，实得 {len(rows)}')
    return rows[0]


def self_test():
    """拿改名前的备份字节逐字段复现 104 的原始读数：全等才允许重算。

    标定对象取**修复前那份记录**：`--apply` 之后活体行已是新值，再拿它标定就会永远「对不上」。
    """
    index, source = load_index(pre_repair=True)
    row = ghost_row(index)
    backup = REPO / 'skill-lifecycle/trial-home/library-backup-writeback-seo-2026-10-01' / OLD_DIR / 'SKILL.md'
    if not backup.exists():
        raise SystemExit(f'标定用的改名前字节不在位：{backup}')
    if sha(backup) != row['sha256']:
        raise SystemExit(f'备份字节与索引行摘要不符（{source}）——标定对象选错了，不是同一次读数')
    got = derive(backup)
    mismatches = []
    for field in DERIVED_FIELDS:
        want, have = row.get(field), got[field]
        if isinstance(want, str) and want == '':
            want = ''
        if str(want) != str(have) and want != have:
            mismatches.append({'field': field, 'recorded': want, 'reproduced': have})
    print(json.dumps({'mode': 'self-test', 'calibrationRecord': source,
                      'calibrationBytes': str(backup.relative_to(REPO)),
                      'fieldsCompared': len(DERIVED_FIELDS), 'mismatched': len(mismatches),
                      'mismatches': mismatches,
                      'retainedUnverifiableFields': RETAINED_FIELDS}, ensure_ascii=False, indent=1))
    return 1 if mismatches else 0


def apply_repair():
    now = datetime.now().astimezone().isoformat()
    index = load_index()
    row = ghost_row(index)
    entry = LIB / NEW_DIR / 'SKILL.md'
    if not entry.exists():
        raise SystemExit(f'真实入口不在位：{entry}')
    if row['path'] != str(LIB / OLD_DIR / 'SKILL.md'):
        raise SystemExit(f'索引行路径不是预期的幽灵路径：{row["path"]}')
    derived = derive(entry)
    if derived['name'] != NEW_DIR:
        raise SystemExit(f'当前 frontmatter name（{derived["name"]}）与目录名不等——改名传播要另案核对，不自动落')

    before = dict(row)
    row.update({'relativePath': f'{NEW_DIR}/SKILL.md', 'path': str(entry), 'sourceGroup': NEW_DIR, **derived})
    row['renameRepair'] = {'at': now, 'by': 'seo-rename-propagation.py',
                           'renamedFrom': {'path': str(LIB / OLD_DIR / 'SKILL.md'), 'name': OLD_NAME,
                                           'sha256': before['sha256'], 'bytes': before['bytes']},
                           'decisionRef': '140-seo一致性收尾批记录.md（目标名＝seo-orchestrator，台账行名同改）',
                           'rederivedFields': DERIVED_FIELDS,
                           'retainedFieldsFrom104': RETAINED_FIELDS,
                           'retainedNote': '目录派生字段配方在 8 件未动样本上只有 1 件全等，不可信重算 ⇒ 保留 104 时点读数'}
    out = R104 / 'library-entry-index.json'
    shutil.copy2(out, out.with_suffix(f'.json.bak-seo-rename-{STAMP}'))
    out.write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding='utf-8')

    routing_path = R104 / 'asset-inventory-and-routing.csv'
    with routing_path.open(encoding='utf-8-sig', newline='') as f:
        rd = csv.DictReader(f)
        rcols = rd.fieldnames
        rrows = list(rd)
    hits = [r for r in rrows if r['sourceId'] == ASSET_ID]
    if len(hits) != 1:
        raise SystemExit(f'路由表里 {ASSET_ID} 应恰好 1 行，实得 {len(hits)}（索引已改，路由未改＝制造断链）')
    r = hits[0]
    r.update({'name': derived['name'], 'path': str(entry), 'entrySha256': derived['sha256'],
              'bytes': str(derived['bytes']), 'bodyChars': str(derived['bodyChars'])})
    shutil.copy2(routing_path, routing_path.with_suffix(f'.csv.bak-seo-rename-{STAMP}'))
    with routing_path.open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=rcols, lineterminator='\n')
        w.writeheader()
        w.writerows(rrows)

    matrix_path = R104 / 'role-coverage-matrix.json'
    matrix = json.loads(matrix_path.read_text(encoding='utf-8'))
    touched = 0
    for role in matrix['roles']:
        names = role.get('candidateNames') or []
        if OLD_NAME in names:
            role['candidateNames'] = [NEW_DIR if n == OLD_NAME else n for n in names]
            touched += 1
        paths = role.get('candidatePaths') or []
        if any(OLD_DIR in p for p in paths):
            role['candidatePaths'] = [p.replace(f'/{OLD_DIR}/', f'/{NEW_DIR}/') for p in paths]
    if touched == 0:
        raise SystemExit('角色矩阵里没有旧名条目——要么已被改过，要么我的前提错了')
    matrix['renameRepairs'] = (matrix.get('renameRepairs') or []) + [
        {'at': now, 'from': OLD_NAME, 'to': NEW_DIR, 'decisionRef': '140 号', 'by': 'seo-rename-propagation.py'}]
    shutil.copy2(matrix_path, matrix_path.with_suffix(f'.json.bak-seo-rename-{STAMP}'))
    matrix_path.write_text(json.dumps(matrix, ensure_ascii=False, indent=1), encoding='utf-8')

    csv_path = R104 / 'role-coverage-matrix.csv'
    text = csv_path.read_text(encoding='utf-8')
    old_occurrences = text.count(OLD_NAME) + text.count(f'/{OLD_DIR}/')
    text = text.replace(OLD_NAME, NEW_DIR).replace(f'/{OLD_DIR}/', f'/{NEW_DIR}/')
    shutil.copy2(csv_path, csv_path.with_suffix(f'.csv.bak-seo-rename-{STAMP}'))
    csv_path.write_text(text, encoding='utf-8')

    receipt = {'at': now, 'assetId': ASSET_ID, 'renamedFrom': before['path'], 'renamedTo': str(entry),
               'shaBefore': before['sha256'], 'shaAfter': derived['sha256'],
               'bytesBefore': before['bytes'], 'bytesAfter': derived['bytes'],
               'nameBefore': before['name'], 'nameAfter': derived['name'],
               'roleCandidatesKept': r.get('roleCandidates', ''),
               'matrixRolesTouched': touched, 'matrixCsvOccurrencesReplaced': old_occurrences,
               'rederivedFields': DERIVED_FIELDS, 'retainedFieldsFrom104': RETAINED_FIELDS,
               'backups': [str(p.relative_to(REPO)) for p in [
                   out.with_suffix(f'.json.bak-seo-rename-{STAMP}'),
                   routing_path.with_suffix(f'.csv.bak-seo-rename-{STAMP}'),
                   matrix_path.with_suffix(f'.json.bak-seo-rename-{STAMP}'),
                   csv_path.with_suffix(f'.csv.bak-seo-rename-{STAMP}')]],
               'untouchedSnapshots': ['library-census.json', 'library-file-manifest.json',
                                      'library-source-groups.json', 'library-links-and-empty.json',
                                      'library-static-screen.json', 'standard-career-crosswalk.json',
                                      'role-candidate-selections.json', '01-Skills数据资产整体分析报告.md',
                                      '02-3加50角色覆盖与缺口洞察.md', 'supplementary-assets-research.md',
                                      '107-w1-assembly/assembly-screen.json（装配根 104 期屏检）']}
    (R104 / f'seo-rename-propagation-receipt-{STAMP}.json').write_text(
        json.dumps(receipt, ensure_ascii=False, indent=1), encoding='utf-8')
    print(json.dumps(receipt, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--self-test', action='store_true')
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()
    if args.self_test:
        sys.exit(self_test())
    if args.apply:
        sys.exit(apply_repair())
    print('缺省＝只报将要改什么（dry-run）；写盘要 --apply，先跑 --self-test')
    row = ghost_row(load_index_raw())
    entry = LIB / NEW_DIR / 'SKILL.md'
    print(json.dumps({'willRewrite': {'assetId': ASSET_ID, 'path': row['path'], 'name': row['name'],
                                      'sha256': row['sha256'][:12], 'bytes': row['bytes']},
                      'to': {'path': str(entry), 'name': row['name'] and NEW_DIR,
                             'sha256': sha(entry)[:12], 'bytes': entry.stat().st_size},
                      'derivedFieldsProven': len(DERIVED_FIELDS),
                      'retainedFrom104': len(RETAINED_FIELDS)}, ensure_ascii=False, indent=1))
