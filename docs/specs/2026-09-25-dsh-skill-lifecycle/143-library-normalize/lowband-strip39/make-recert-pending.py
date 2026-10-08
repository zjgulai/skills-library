#!/usr/bin/env python3
"""生成 strip39 重认的「待跑清单」：从 recert-fire.tsv 里排除已有终态证据的轮次。

跳过判定与产物同形，但**目录存在不等于读数成立**：evidence-r{R}/armed-*.json 是增量写的，
腿还在跑时读它就是半成品（本批探针因此两次被误读成 reportChars=0 的 void）。
终态判据＝报告可取（reportChars>0 且 report 非空）。-capture/-wake-check/-voidN 后缀档不算。

用法：python3 -B make-recert-pending.py [--peek] [--allow-inflight]
      --peek            只打印清单不写盘（发射前核对用）
      --allow-inflight  跳过「有腿在跑」守卫（仅在确认对端已停后用）
"""
import glob
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent          # .../143-library-normalize/lowband-strip39
NORM = HERE.parent                               # .../143-library-normalize
REPO = NORM.parent.parent.parent.parent          # 仓根（思维库/skill管理）
OPT = REPO / 'skill-lifecycle/trial-home/opt-run'
FULL = HERE / 'recert-fire.tsv'
OUT = HERE / 'recert-pending.tsv'


def inflight():
    """在跑的腿：evidence-r{R} 的记录 mtime 落在最近 3 分钟内。"""
    hits = []
    for f in glob.glob(str(OPT / 'evidence-r17[0-3][0-9]' / 'armed-*.json')):
        if re.fullmatch(r'evidence-r\d{4}', Path(f).parent.name) and time.time() - os.path.getmtime(f) < 180:
            hits.append(Path(f).parent.name)
    return sorted(hits)


def good_rounds():
    """终态读数＝4 位轮号目录里 armed-*.json 的 report 可取。"""
    done = set()
    for f in sorted(glob.glob(str(OPT / 'evidence-r*' / 'armed-*.json'))):
        d = Path(f).parent
        if not re.fullmatch(r'evidence-r(\d{4})', d.name):
            continue
        try:
            rec = json.loads(Path(f).read_text(encoding='utf-8'))
        except (json.JSONDecodeError, OSError):
            continue
        if (rec.get('reportChars') or 0) > 0 and rec.get('report'):
            done.add(int(d.name[-4:]))
    return done


def self_test():
    """证明这条判据会红：空报告/坏 JSON/后缀档都不算完成，有报告才算。

    用 999x 保留轮号造夹具，跑完即删——不碰真实证据。
    """
    ok = True
    fixes = []
    try:
        cases = [
            ('evidence-r9990', {'reportChars': 0, 'report': None}, False),        # 空报告＝未完成
            ('evidence-r9991', {'reportChars': 2881, 'report': '# ok'}, True),     # 有报告＝完成
            ('evidence-r9992-capture', {'reportChars': 500, 'report': 'x'}, False),  # 预检档不算
            ('evidence-r9993', None, False),                                        # 坏 JSON 不算
        ]
        for dname, payload, _ in cases:
            p = OPT / dname
            p.mkdir(parents=True, exist_ok=True)
            fixes.append(p)
            f = p / 'armed-o9999-evaluate-target-r1.json'
            f.write_text(json.dumps(payload) if payload is not None else '{truncated', encoding='utf-8')
        got = good_rounds() & {9990, 9991, 9992, 9993}
        if got != {9991}:
            ok = False
            print(f'SELFTEST FAIL: 判据收了 {sorted(got)}，期望 [9991]')
        else:
            print('SELFTEST PASS: 空报告/坏 JSON/后缀档均未误判为完成')
    finally:
        for p in fixes:
            shutil.rmtree(p, ignore_errors=True)
    return 0 if ok else 1


def main():
    if '--selftest' in sys.argv:
        return self_test()
    if inflight() and '--allow-inflight' not in sys.argv:
        print(f'REFUSE: 疑似有腿在跑 {inflight()}——记录是增量写的，此时读数会假报 void。等波次结束再跑。', file=sys.stderr)
        return 2
    rows = [ln.rstrip('\n') for ln in FULL.read_text(encoding='utf-8').splitlines() if ln.strip()]
    done = good_rounds()
    pending, skipped = [], []
    for ln in rows:
        r = int(ln.split('\t')[0])
        (skipped if r in done else pending).append(ln)
    print(f'清单 {len(rows)} 轮；读数可取 {len(skipped)} 轮；待跑 {len(pending)} 轮')

    for ln in skipped:
        print(f'  已完成 {ln.split(chr(9))[0]} {ln.split(chr(9))[1]}')
    if '--peek' in sys.argv:
        for ln in pending:
            print('  待跑 ' + ln.replace('\t', ' '))
        return 0
    OUT.write_text('\n'.join(pending) + '\n' if pending else '', encoding='utf-8')
    print(f'写入 {OUT.relative_to(REPO)}' if pending else f'{OUT.name} 置空（无待跑）')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
