#!/usr/bin/env python3
"""跨批无据字段剥除·写回后核验（零请求）。

四判据：
  V1 库内该件 SKILL.md 与工作副本逐字节等值（＝剥除按计划落地，且没夹带别的改动）
  V2 39 个目标字段在库内确实消失，且该件其余字段一个不少（与备份前像比集合）
  V3 非目标文件逐字节未变（库内 vs 备份根前像）
  V4 备份根存在且含写回前像（可回退）
用法：python3 -B verify-strip39.py
"""
import hashlib
import json
import pathlib
import re
import sys

import yaml

REPO = pathlib.Path(__file__).resolve().parents[5]
LIB = pathlib.Path('/Users/lute/project/AgentTools/技能库')
TRIAL = REPO / 'skill-lifecycle/trial-home'
OPT = TRIAL / 'opt-run'
NORM = REPO / 'docs/specs/2026-09-25-dsh-skill-lifecycle/143-library-normalize'
BAND = NORM / 'lowband-strip39'
TAG = 'strip39-2026-10-03'


def sha(p):
    return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()


def keys_of(text):
    m = re.match(r'^---\n(.*?)\n---', text, re.S)
    d = yaml.safe_load(m.group(1)) if m else None
    return d if isinstance(d, dict) else None


def main():
    idx = json.loads((BAND / 'strip-plan-index.json').read_text(encoding='utf-8'))
    bad = []
    n1 = n2 = n3 = 0
    for it in idx['work']:
        name, work = it['name'], REPO / it['workDir']
        pkg = pathlib.Path(it['targetDir'])
        # slug 本身已含 -strip39，故目录名是 <name>-strip39-<tag>
        # 备份根在 trial-home/ 下（与 p2-writeback-apply.py 的拼法一致），不在 opt-run/ 里
        bak = TRIAL / f'library-backup-writeback-{name}-strip39-{TAG}'
        if not bak.is_dir():
            bad.append(('V4 NO-BACKUP', name))
            continue
        # V1 全包逐字节
        wf = {str(p.relative_to(work)) for p in work.rglob('*') if p.is_file()}
        lf = {str(p.relative_to(pkg)) for p in pkg.rglob('*') if p.is_file()}
        if wf != lf:
            bad.append(('V1 FILE-SET', name, sorted(lf ^ wf)[:3]))
        for f in sorted(wf & lf):
            if sha(work / f) != sha(pkg / f):
                bad.append(('V1 DIGEST', name, f))
            n1 += 1
        # V2 字段集合
        cur = keys_of((pkg / 'SKILL.md').read_text(encoding='utf-8'))
        old_raw = bak / it['relPath']   # 备份根镜像完整 relPath，不按 basename 找
        old = keys_of(old_raw.read_text(encoding='utf-8')) if old_raw.is_file() else None
        if cur is None:
            bad.append(('V2 UNPARSEABLE', name))
        else:
            for r in it['removed']:
                if r['field'] in cur:
                    bad.append(('V2 STILL-PRESENT', name, r['field']))
                else:
                    n2 += 1
            if old:
                lost = [k for k in old if k not in cur and k not in {r['field'] for r in it['removed']}]
                extra = [k for k in cur if k not in old]
                if lost or extra:
                    bad.append(('V2 KEY-SET', name, lost[:3], extra[:3]))
        # V3 备份只在「目标位置原本已有文件」时产生：未变件走的是 no-op put，不留前像。
        # 因此这里判据＝凡有前像的旁文件必须仍与库内等值；旁文件的完整性由 V1（＝工作副本）
        # ＋strip-unevidenced.py --check（工作副本＝库内旧字节仅少被剥的那几行）两端夹住。
        for f in sorted(lf - {'SKILL.md'}):
            bp = bak / f
            if bp.is_file() and sha(bp) != sha(pkg / f):
                bad.append(('V3 CHANGED-BUT-BACKED-UP', name, f))
                n3 += 1
            elif bp.is_file():
                n3 += 1
    print(f'V1 逐字节比对文件 = {n1} | V2 已消失字段 = {n2} | V3 有前像且未变 = {n3} | 违例 = {len(bad)}')
    for b in bad[:12]:
        print('  !', b)
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
