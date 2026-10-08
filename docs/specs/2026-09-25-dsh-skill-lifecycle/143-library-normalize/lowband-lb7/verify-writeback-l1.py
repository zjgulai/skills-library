#!/usr/bin/env python3
"""LB-7 写回后 L1 全量逐字节核验（零请求）：462 put ＋ 8 remove 一条不落。

判据：
  P1 put 件在库内的 sha256 == 计划里的 sourceSha256
  P2 每个 slug 的备份根存在，且备份根里能看到该件的写回前版本（覆盖即备份）
  R1 remove 件在库内确已消失
  R2 remove 件在对应备份根里仍在（内容没丢，只是不再随包发布）
用法：python3 -B verify-writeback-l1.py
"""
import hashlib
import json
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parents[5]
CAND = REPO / 'skill-lifecycle/trial-home/opt-run/candidates'
LIB = pathlib.Path('/Users/lute/project/AgentTools/技能库')
TAG = 'lb7-2026-10-03'


def sha(p):
    return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()


def main():
    bad = []
    n_put = n_rm = n_backup = n_new = n_over = 0
    for pf in sorted(CAND.glob('*.writeback-plan.json')):
        plan = json.loads(pf.read_text(encoding='utf-8'))
        if not plan.get('policy', '').startswith('lb7 写回·'):
            continue
        slug = pf.name.replace('.writeback-plan.json', '')
        # 备份根在 trial-home/ 下（与 p2-writeback-apply.py 的拼法一致），不在 opt-run/ 里
        backup = REPO / 'skill-lifecycle/trial-home' / f'library-backup-writeback-{slug}-{TAG}'
        if not backup.is_dir():
            bad.append(f'BACKUP-MISSING {slug}')
            continue
        n_backup += 1
        for op in plan.get('ops', []):
            if op['kind'] == 'prune-empty-dirs':
                root = LIB / op['root']
                empt = [str(d.relative_to(LIB)) for d in root.rglob('*') if d.is_dir() and not any(d.iterdir())]
                if root.is_dir() and empt:
                    bad.append(f"PRUNE 残留空目录 {slug}: {','.join(sorted(empt)[:3])}")
                continue
            rel = op['relPath']
            libp = LIB / rel
            bk = backup / rel
            if op['kind'] == 'put':
                n_put += 1
                if op.get('expectSha256'):
                    n_over += 1
                if not libp.is_file():
                    bad.append(f'P1 MISSING {slug} {rel}')
                elif sha(libp) != op.get('sourceSha256'):
                    bad.append(f"P1 DIGEST {slug} {rel} 库内={sha(libp)[:12]} 计划={str(op.get('sourceSha256'))[:12]}")
                # 只有覆盖写（计划里带 expectSha256）才必须有前像；新增件 expectAbsent 本就无旧版可备份
                if op.get('expectSha256') and not bk.is_file():
                    bad.append(f'P2 NO-BACKUP {slug} {rel}')
                if op.get('expectSha256') and bk.is_file() and sha(bk) != op['expectSha256']:
                    bad.append(f"P2 前像哈希不符 {slug} {rel} 备份={sha(bk)[:12]} 计划={op['expectSha256'][:12]}")
                if op.get('expectAbsent'):
                    n_new += 1
            elif op['kind'] == 'remove':
                n_rm += 1
                if libp.exists():
                    bad.append(f'R1 STILL-THERE {slug} {rel}')
                if not bk.is_file():
                    bad.append(f'R2 BACKUP-LOST {slug} {rel}')
    print(f'备份根 = {n_backup} 个 | put = {n_put}（覆盖 {n_over}／新增 {n_new}）| remove = {n_rm} | 违例 = {len(bad)}')
    for b in bad[:25]:
        print('  !', b)
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
