#!/usr/bin/env python3
"""把 ZIP 族 42 件接进 104 研究产物（入口索引＋路由表），供治理账本与装配投影复算。

为什么要有这个脚本而不是手改：`library-entry-index.json` 与 `asset-inventory-and-routing.csv`
都是 104 的研究输出，仓内**没有生成器**；手改产物正是本会话一路在修的反模式（§17.3、§20.3）。
本脚本把追加变成可重跑、可核验、带备份与回执的一步。

字段口径如实声明：104 生成器算了 32 个字段，本脚本只算**治理账本实际消费的 8 个**
（assetId/name/path/sha256/bytes/bodyChars/hasKebabName/sourceGroup）＋透明标记字段
（appendedBy/appendedAt/frontmatterPresent/yamlError）。其余 22 个字段留空并注明，
不冒充 104 的原始读数（headings/ownedFiles/replacementChars/nestedRole 等一概不猜）。

用法：python3 -B zip42-index-append.py [--apply]     缺省 dry-run（只报将要追加什么）
"""
import argparse
import csv
import hashlib
import json
import re
import shutil
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
R104 = REPO / 'docs/specs/2026-09-25-dsh-skill-lifecycle/104-skills-asset-research'
B145 = REPO / 'docs/specs/2026-09-25-dsh-skill-lifecycle/145-standardization-baseline'
LIB = Path('/Users/lute/project/AgentTools/技能库')
INDEX = R104 / 'library-entry-index.json'
ROUTING = R104 / 'asset-inventory-and-routing.csv'
KEBAB = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
DASH = 'zip42-2026-10-08'


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def frontmatter(text: str):
    m = re.match(r'^---\s*\n(.*?)\n---', text, re.S)
    return m.group(1) if m else None


def fm_scalar(block: str, key: str):
    m = re.search(r'^' + key + r':\s*(?:>-|\|)?\s*(.*)$', block, re.M)
    if not m:
        return None
    val = m.group(1).strip().strip('"').strip("'")
    if val == '':                      # 块标量：取后续缩进行拼回
        lines = block.split('\n')
        for i, line in enumerate(lines):
            if line.startswith(key + ':'):
                body = [l.strip() for l in lines[i + 1:] if l.startswith(' ') or l == '']
                return ' '.join([b for b in body if b])[:400]
        return ''
    return val[:400]


def build_rows():
    proposal = json.loads((B145 / 'zip42-role-proposal.json').read_text())
    l5 = {r['name']: r for r in csv.DictReader(
        (B145 / 'zip42-writeback/l5-ledger.csv').open(encoding='utf-8'))}
    out = []
    for item in proposal['rows']:
        entry = LIB / item['root'] / 'skills' / item['slug'] / 'SKILL.md'
        if not entry.exists():
            raise SystemExit(f'库内实物缺失：{entry}')
        text = entry.read_text(encoding='utf-8', errors='replace')
        fm = frontmatter(text)
        body = text[len(fm) + 8:] if fm else text           # 粗算正文：正文 = 全文去 frontmatter 块
        out.append({
            'slug': item['slug'],
            'path': str(entry),
            'relativePath': str(entry.relative_to(LIB)),
            'assetId': 'Z42-' + item['slug'],
            'sourceGroup': item['root'],
            'name': (fm_scalar(fm, 'name') if fm else None) or item['slug'],
            'sha256': sha(entry),
            'bytes': entry.stat().st_size,
            'bodyChars': len(body),
            'hasKebabName': bool(KEBAB.match(item['slug'])),
            'frontmatterPresent': fm is not None,
            'yamlError': '',
            'roles': item['roles'],
            'l5': l5.get(item['slug'], {}).get('status', ''),
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()
    rows = build_rows()
    index = json.loads(INDEX.read_text())
    have = {e['path'] for e in index}
    new = [r for r in rows if r['path'] not in have]
    stale = [r['slug'] for r in rows if r['path'] in have
             and next(e for e in index if e['path'] == r['path'])['sha256'] != r['sha256']]
    routing = list(csv.DictReader(ROUTING.open(encoding='utf-8-sig')))
    routed = {r['path'] for r in routing}

    print(f'账本条目 {len(index)}；待追加索引行 {len(new)}；已存在但摘要变了 {len(stale)} 件 {stale[:3]}')
    print(f'路由表条目 {len(routing)}；待追加路由行 {len([r for r in rows if r["path"] not in routed])}')
    if stale:
        raise SystemExit('库内字节与索引记录不符：先弄清是谁改的，不自动覆盖')
    if not args.apply:
        for r in new[:3]:
            print('  例：', r['relativePath'], r['assetId'], r['sha256'][:12], 'roles=', r['roles'] or '不指派')
        print('（dry-run：未写盘）')
        return 0
    stamp = datetime.now().astimezone().isoformat()
    for src in (INDEX, ROUTING):
        bak = src.with_suffix(src.suffix + f'.bak-{DASH}')
        if not bak.exists():
            shutil.copy2(src, bak)
    for r in new:
        index.append({
            'assetId': r['assetId'], 'relativePath': r['relativePath'], 'path': r['path'],
            'sourceGroup': r['sourceGroup'], 'sha256': r['sha256'], 'bytes': r['bytes'],
            'opaque': False, 'utf8': True,
            'frontmatterPresent': r['frontmatterPresent'], 'yamlError': r['yamlError'],
            'name': r['name'], 'description': None, 'version': None,
            'metadataKeys': [], 'tags': [], 'disableModelInvocation': None, 'userInvocable': None,
            'bodyChars': r['bodyChars'], 'bodyLines': 0, 'headings': [], 'replacementChars': None,
            'hasKebabName': r['hasKebabName'], 'ownedFiles': None, 'ownedBytes': None,
            'ownedOpaqueFiles': None, 'topLevelLayout': None, 'scriptFiles': None,
            'testFiles': None, 'referenceFiles': None, 'playbookFiles': None,
            'hasLicense': None, 'hasManifest': None, 'nestedRole': None,
            'appendedBy': 'zip42-index-append.py', 'appendedAt': stamp,
            'appendedNote': '104 生成器的 22 个未消费字段未重算，留空并注明；账本只用 8 个字段',
        })
    with ROUTING.open('a', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=list(routing[0].keys()))
        for r in rows:
            if r['path'] in routed:
                continue
            writer.writerow({
                'sourceKind': 'standard', 'sourceId': r['assetId'], 'name': r['slug'],
                'path': r['path'], 'entrySha256': r['sha256'], 'bytes': r['bytes'],
                'bodyChars': r['bodyChars'], 'topicCandidate': '',
                'routingCandidate': 'role-candidate' if r['roles'] else 'unassigned-needs-review',
                'roleCandidates': ';'.join(r['roles']),
                'basis': 'zip42-role-proposal-2026-10-08（人工逐件读自述对象；两版机械匹配证伪不用）',
                'statusSignals': f'zip42-appended;l5={r["l5"]}',
                'runtimeAcceptance': 'loaded-natively' if r['l5'] == 'pass' else
                                     ('model-path-disabled' if r['l5'] else 'not-tested'),
            })
    INDEX.write_text(json.dumps(index, ensure_ascii=False, indent=1))
    receipt = {'at': stamp, 'indexBefore': len(index) - len(new), 'indexAfter': len(index),
               'appended': [r['slug'] for r in new],
               'roleRows': sum(1 for r in rows if r['roles']), 'unassigned': [r['slug'] for r in rows if not r['roles']],
               'backups': [str(INDEX.with_suffix('.json.bak-' + DASH)), str(ROUTING.with_suffix('.csv.bak-' + DASH))]}
    (B145 / 'zip42-index-append-receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=1))
    print('已追加：', receipt['indexBefore'], '→', receipt['indexAfter'], '｜回执落 zip42-index-append-receipt.json')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
