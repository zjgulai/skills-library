#!/usr/bin/env python3
"""把 142 号的「平铺 → 目录」形制转换传播到 104 的两份活体指针（qoder 入口索引＋路由表）。

背景与定性（145 号 §22.4、142 号 §36 已点名）：142 号把 `skills-Qoder/leadership-strategy-playbook--official_38aAvjmS.md`
转成目录 `skills-Qoder/leadership-strategy-playbook/`，并**就地**把 batch1 冻结计划的 op-173 改成目录形态；
但 104 的 `qoder-entry-index.json` 仍指向那个**已不存在的平铺路径** ⇒ 由账本重算投影计划时，
C 组试点又退回平铺、以 `SOURCE_MISSING` 被拒。生成器不复现 142 的手工就地更名，就会每次重算都退回旧形制。

**这次只传播「指针与字节读数」**，字段一律先标定再用：
用转换前的备份字节（sha 与记录行相等＝就是 104 读的那份）逐字段复现记录值，全等才允许对新入口重算；
104 的**研究判断字段**（title／resourceReferences／resourceSummary／duplicateGroupSizes／
readStatus／semanticReview／primaryDomainCandidate／domainCandidates／packagingStatus／sourceKind）
不重算也不改写——它们描述的是当年那份平铺导出，改写等于把观测改成当下结论；
行内 `shapeRepair` 把「已重算」与「仍属 104 时点读数」两份清单分列。

用法：python3 -B leadership-shape-propagation.py --self-test
      python3 -B leadership-shape-propagation.py [--apply]
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
ITEM = 'leadership-strategy-playbook'
OLD_REL = f'skills-Qoder/{ITEM}--official_38aAvjmS.md'
NEW_REL = f'skills-Qoder/{ITEM}/SKILL.md'
STAMP = '2026-10-08'
CALIB_BYTES = (REPO / 'skill-lifecycle/trial-home/library-backup-writeback-leadership-strategy-playbook-2026-10-01'
               / 'skills-Qoder' / f'{ITEM}--official_38aAvjmS.md')

# 标定过、允许对新入口重算的字段
REDERIVED = ['path', 'sha256', 'bodySha256', 'bytes', 'bodyChars', 'bodyBytes', 'lines',
             'bodyStartLine', 'encoding', 'utf8Bom', 'frontmatterPresent', 'frontmatterParseProblems',
             'duplicateYamlKeys', 'frontmatterKeys', 'metadataKeys', 'metadataType', 'name',
             'description', 'descriptionChars']
# 104 的研究判断：保留、不改写
RETAINED = ['title', 'resourceReferences', 'resourceSummary', 'securityTextSignals',
            'credentialPatternSignals', 'primaryDomainCandidate', 'domainCandidates', 'readStatus',
            'semanticReview', 'semanticReviewId', 'semanticReviewReport', 'duplicateGroupSizes',
            'packagingStatus', 'sourceKind', 'nameCompliance']


def entry_fields(path: Path):
    raw = path.read_bytes()
    text = raw.decode('utf-8')
    # 捕获组保留闭合换行：折叠块（`description: >`）的 clip chomping 会留一个收尾换行，
    # 早先把分隔符前的那个 \n 吃掉会让 description 少一个字符（标定当场抓到）。
    m = re.match(r'^---[ \t]*\n(.*?)^---[ \t]*\n?', text, re.S | re.M)
    fm = yaml.safe_load(m.group(1))
    body = text[m.end():]
    desc = str(fm.get('description') or '')
    desc_chars = len(desc)
    problems, dup = [], []
    keys = list(fm.keys())
    if len(set(keys)) != len(keys):
        dup = sorted({k for k in keys if keys.count(k) > 1})
    return {
        'sha256': hashlib.sha256(raw).hexdigest(),
        'bodySha256': hashlib.sha256(body.encode('utf-8')).hexdigest(),
        'bytes': len(raw),
        'bodyChars': len(body),
        'bodyBytes': len(body.encode('utf-8')),
        'lines': text.count('\n'),
        'bodyStartLine': text[:m.end()].count('\n') + 1,
        'encoding': 'utf-8',
        'utf8Bom': raw.startswith(b'\xef\xbb\xbf'),
        'frontmatterPresent': True,
        'frontmatterParseProblems': problems,
        'duplicateYamlKeys': dup,
        'frontmatterKeys': sorted(keys),
        'metadataKeys': sorted((fm.get('metadata') or {}).keys()) if isinstance(fm.get('metadata'), dict) else [],
        'metadataType': type(fm.get('metadata')).__name__,
        'name': fm.get('name'),
        'description': desc,
        'descriptionChars': desc_chars,
    }


def load_qoder(pre_repair=False):
    if pre_repair:
        backups = sorted(R104.glob('qoder-entry-index.json.bak-shape-*'))
        if backups:
            return json.loads(backups[-1].read_text(encoding='utf-8')), backups[-1].name
    return json.loads((R104 / 'qoder-entry-index.json').read_text(encoding='utf-8')), 'qoder-entry-index.json'


def find_entry(doc, source):
    hits = [e for e in doc['entries'] if e.get('path', '').endswith(OLD_REL) or e.get('path', '').endswith(NEW_REL)]
    if len(hits) != 1:
        raise SystemExit(f'{source} 里该件入口应恰好 1 行（旧或新路径），实得 {len(hits)}')
    return hits[0]


def self_test():
    doc, source = load_qoder(pre_repair=True)
    row = find_entry(doc, source)
    if not CALIB_BYTES.exists():
        raise SystemExit(f'标定字节不在位：{CALIB_BYTES}')
    if hashlib.sha256(CALIB_BYTES.read_bytes()).hexdigest() != row['sha256']:
        raise SystemExit(f'标定字节与记录行摘要不等（{source}）——不是同一次读数，不能拿来标定')
    got = entry_fields(CALIB_BYTES)
    mismatches = [{'field': f, 'recorded': row.get(f), 'reproduced': got[f]}
                  for f in REDERIVED if f != 'path' and str(row.get(f)) != str(got[f])]
    print(json.dumps({'mode': 'self-test', 'calibrationRecord': source,
                      'calibrationBytes': str(CALIB_BYTES.relative_to(REPO)),
                      'fieldsCompared': len(REDERIVED) - 1, 'mismatched': len(mismatches),
                      'mismatches': mismatches, 'retainedResearchFields': RETAINED}, ensure_ascii=False, indent=1))
    return 1 if mismatches else 0


def apply_repair():
    now = datetime.now().astimezone().isoformat()
    entry = LIB / NEW_REL
    if not entry.exists():
        raise SystemExit(f'目录入口不在位：{entry}')
    doc, source = load_qoder()
    row = find_entry(doc, source)
    if not row['path'].endswith(OLD_REL):
        raise SystemExit(f'入口行已是新路径，本脚本不可重复跑：{row["path"]}')
    before = {'path': row['path'], 'sha256': row['sha256'], 'bytes': row['bytes'],
              'bodyChars': row['bodyChars'], 'lines': row['lines']}
    got = entry_fields(entry)
    if got['name'] != ITEM:
        raise SystemExit(f'新入口 frontmatter name（{got["name"]}）与件名不等，先核对再落')
    row.update({'path': str(entry), **got})
    row['shapeRepair'] = {'at': now, 'by': 'leadership-shape-propagation.py',
                          'convertedFrom': dict(before, relativePath=OLD_REL),
                          'relativePath': NEW_REL,
                          'decisionRef': '142-G续补去向一夹具增强批记录.md（op-173 就地更名为目录形态）',
                          'rederivedFields': REDERIVED, 'retainedResearchFields': RETAINED,
                          'retainedNote': '这些字段描述的是 104 当年读的那份平铺导出（含 packagingStatus／sourceKind），'
                                         '保留为时点读数；形制现状以 path 与字节读数为准'}
    out = R104 / 'qoder-entry-index.json'
    shutil.copy2(out, out.with_suffix(f'.json.bak-shape-{STAMP}'))
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding='utf-8')

    routing_path = R104 / 'asset-inventory-and-routing.csv'
    with routing_path.open(encoding='utf-8-sig', newline='') as f:
        rd = csv.DictReader(f)
        cols, rrows = rd.fieldnames, list(rd)
    hits = [r for r in rrows if r['path'].endswith(OLD_REL)]
    if len(hits) != 1:
        raise SystemExit(f'路由表里旧平铺路径应恰好 1 行（与索引锁步，否则制造 MISSING-JOIN），实得 {len(hits)}')
    r = hits[0]
    r.update({'path': str(entry), 'entrySha256': got['sha256'], 'bytes': str(got['bytes']),
              'bodyChars': str(got['bodyChars'])})
    shutil.copy2(routing_path, routing_path.with_suffix(f'.csv.bak-shape-{STAMP}'))
    with routing_path.open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols, lineterminator='\n')
        w.writeheader()
        w.writerows(rrows)

    receipt = {'at': now, 'item': ITEM, 'before': before,
               'after': {'path': str(entry), 'sha256': got['sha256'], 'bytes': got['bytes'],
                         'bodyChars': got['bodyChars'], 'lines': got['lines']},
               'routeKept': r.get('routingCandidate', ''), 'roleCandidatesKept': r.get('roleCandidates', ''),
               'rederivedFields': REDERIVED, 'retainedResearchFields': RETAINED,
               'backups': [str(out.with_suffix(f'.json.bak-shape-{STAMP}').relative_to(REPO)),
                           str(routing_path.with_suffix(f'.csv.bak-shape-{STAMP}').relative_to(REPO))]}
    (R104 / f'leadership-shape-propagation-receipt-{STAMP}.json').write_text(
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
    doc, source = load_qoder()
    row = find_entry(doc, source)
    print('缺省＝dry-run；先 --self-test 标定，再 --apply')
    print(json.dumps({'from': {'path': row['path'][-58:], 'sha256': row['sha256'][:12], 'bytes': row['bytes']},
                      'to': {'path': NEW_REL, 'sha256': hashlib.sha256((LIB / NEW_REL).read_bytes()).hexdigest()[:12],
                             'bytes': (LIB / NEW_REL).stat().st_size},
                      'rederived': len(REDERIVED), 'retained': len(RETAINED)}, ensure_ascii=False, indent=1))
