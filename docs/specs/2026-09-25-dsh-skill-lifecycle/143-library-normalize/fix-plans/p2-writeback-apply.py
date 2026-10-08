#!/usr/bin/env python3
"""P2 修复写回·受控执行驱动（pilot1＋pilot2＋LB-1 三组收口件）。

- 计划识别：candidates/*.writeback-plan.json 中 policy 以本批三组前缀开头的才算（防旧批计划误入）。
- 每件：执行器（默认 dry-run；--apply 才写库）＋逐件备份根 library-backup-writeback-<slug>-nm2-2026-10-02。
- fashion-sketch-cn：改名后单独生成计划，不在本驱动自动范围（见 p2-writeback/rename-fashion-sketch-cn.json）。

用法：python3 -B p2-writeback-apply.py [--apply]
备份根后缀：环境变量 WB_BACKUP_TAG（默认 nm2-2026-10-02；LB-4 批次用如 WB_BACKUP_TAG=lb4-2026-10-02）
"""
import json
import os
import subprocess
import sys
from pathlib import Path

REPO = Path('/Users/lute/project/AgentTools/思维库/skill管理')
LIB = '/Users/lute/project/AgentTools/技能库'
CAND = REPO / 'skill-lifecycle/trial-home/opt-run/candidates'
WB = REPO / 'skill-lifecycle/trial-home/screening/skill-repair-writeback.mjs'
PREFIXES = ('pilot1 写回·', 'pilot2 写回·', 'lb1 写回·', 'lb2 写回·', 'lb3 写回·', 'lb4 写回·', 'lb5 写回·', 'lb6 写回·')


def main():
    apply = '--apply' in sys.argv
    batch = next((a for a in sys.argv[1:] if not a.startswith('-')), None)
    tag = os.environ.get('WB_BACKUP_TAG', 'nm2-2026-10-02')
    prefixes = (f'{batch} 写回·',) if batch else PREFIXES
    plans = []
    for p in sorted(CAND.glob('*.writeback-plan.json')):
        try:
            policy = json.loads(p.read_text(encoding='utf-8')).get('policy', '')
        except json.JSONDecodeError:
            continue
        if any(policy.startswith(pre) for pre in prefixes):
            plans.append(p)
    print(f'{"APPLY" if apply else "DRY-RUN"}: {len(plans)} plans (batch: {batch or "ALL"}, backup tag: {tag})')
    ok = refused = failed = 0
    for p in plans:
        slug = p.name.replace('.writeback-plan.json', '')
        backup = str(REPO / f'skill-lifecycle/trial-home/library-backup-writeback-{slug}-{tag}')
        cmd = ['node', str(WB), '--plan', str(p), '--library', LIB, '--backup', backup]
        if apply:
            cmd.append('--apply')
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=str(REPO))
        try:
            rec = json.loads(r.stdout)
        except json.JSONDecodeError:
            print(f'  FAIL {slug}: rc={r.returncode} {r.stderr.strip()[:120]}')
            failed += 1
            continue
        nref = len(rec.get('refusals', []))
        nchg = len(rec.get('changes', []))
        status = 'OK' if nref == 0 and r.returncode == 0 else 'REFUSE'
        if status == 'OK':
            ok += 1
        else:
            refused += 1
        print(f'  {status} {slug}: {nchg} changes, {nref} refusals')
        for x in rec.get('refusals', []):
            print(f'     refusal: {x.get("relPath")} {x.get("reason")}')
    print(f'summary: ok={ok} refused={refused} failed={failed}')


if __name__ == '__main__':
    main()
