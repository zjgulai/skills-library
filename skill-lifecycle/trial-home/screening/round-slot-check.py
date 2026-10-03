#!/usr/bin/env python3
"""轮号号位预检：发射前扫「evidence-r{R} 是否已被占用」。

背景（2026-10-04 教训）：probe-b 的 skip 判定是「recordPath（evidence-r{R}/armed-*.json）
已存在即跳过」——当号位被**其它来源**的既有产物占用（例：并行操作者的复核腿、上一批的
同号残留）时，新发射对该轮的 live 腿会**静默空转**（rc=0、日志照打 LIVE），产出假读数
（读到的其实是占用者的报告）。发射前用本工具确认号位空闲，或据此跳号。

用法：
  python3 -B round-slot-check.py --from 1741 --count 8          # 扫 8 个号位
  python3 -B round-slot-check.py --from 1741 --count 8 --pick 3 # 顺次取 3 个空闲号

退出码：0 = 全部空闲（或 --pick 成功给出空闲号）；1 = 存在占位号（未 --pick 时）。
"""
import argparse
import glob
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent          # .../trial-home/screening
OPT = HERE.parent / 'opt-run'


def slot_state(r: int) -> tuple[str, str]:
    """返回 (state, note)：free | taken | empty-dir | runs-only"""
    d = OPT / f'evidence-r{r}'
    runs = OPT / f'runs-r{r}'
    if d.is_dir():
        files = sorted(d.glob('*.json'))
        if files:
            try:
                rec = json.loads(files[0].read_text(encoding='utf-8'))
                at = (rec.get('at') or '')[:19]
                chars = rec.get('reportChars') or 0
                return 'taken', f'at={at} chars={chars}'
            except Exception as exc:
                return 'taken', f'（记录读取失败：{exc}）'
        return 'empty-dir', '（空目录：不触发 skip，但建议换号保持干净）'
    if runs.is_dir():
        return 'runs-only', '（仅 runs 残留）'
    return 'free', ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--from', dest='start', type=int, required=True)
    ap.add_argument('--count', type=int, required=True)
    ap.add_argument('--pick', type=int, default=None, help='顺次取 N 个空闲号并打印')
    args = ap.parse_args()

    states = {r: slot_state(r) for r in range(args.start, args.start + args.count)}
    for r, (st, note) in states.items():
        print(f'r{r}: {st} {note}')
    if args.pick is not None:
        free = [r for r, (st, _) in states.items() if st == 'free']
        if len(free) < args.pick:
            print(f'REFUSE: 空闲 {len(free)} 个，不足 {args.pick}', file=sys.stderr)
            return 1
        print('PICK ' + ','.join(str(r) for r in free[:args.pick]))
        return 0
    return 0 if all(st == 'free' for st, _ in states.values()) else 1


if __name__ == '__main__':
    raise SystemExit(main())
