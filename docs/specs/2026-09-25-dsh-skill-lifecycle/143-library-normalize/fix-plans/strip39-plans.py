#!/usr/bin/env python3
"""跨批无据字段剥除·写回计划生成（零请求；只写计划与政策文件，不动库）。

前置：strip-unevidenced.py 已生成 opt-run/strip39/<name>/ 工作副本且 --check 违例 0。
每件调 `writeback-plan-make.mjs`：target＝库内该包目录，candidate＝工作副本 ⇒ 计划里应只有 SKILL.md 一个 put、0 remove。
用法：python3 -B strip39-plans.py
"""
import hashlib
import json
import pathlib
import subprocess

REPO = pathlib.Path(__file__).resolve().parents[5]
LIB = pathlib.Path('/Users/lute/project/AgentTools/技能库')
NORM = REPO / 'docs/specs/2026-09-25-dsh-skill-lifecycle/143-library-normalize'
CAND = REPO / 'skill-lifecycle/trial-home/opt-run/candidates'
MAKER = REPO / 'skill-lifecycle/trial-home/screening/writeback-plan-make.mjs'
POL = NORM / 'p2-writeback/policies-strip39'
BAND = NORM / 'lowband-strip39'

idx = json.loads((BAND / 'strip-plan-index.json').read_text(encoding='utf-8'))
if idx.get('problems'):
    raise SystemExit(f'工作副本生成阶段仍有异常未处置：{idx["problems"][:3]}')
POL.mkdir(parents=True, exist_ok=True)

made, odd = [], []
for it in idx['work']:
    name = it['name']
    fields = '＋'.join(f"{r['field']}（{r['removed_line'][:40]}）" for r in it['removed'])
    policy = (f'strip39 写回·{name}（剥除我们相对库内原件新增、且包内/祖先查无出处的字段：{fields}。'
              f'现证复核＝lowband-strip39/recheck.json（含否定句防线的 pkg_evidence 重跑）；'
              f'工作副本＝opt-run/strip39/{name}，与库内整包逐字节等值、仅 SKILL.md 少这几行，'
              f'校验＝strip-unevidenced.py --check 期望字节重建违例 0。）')
    pf = POL / f'{name}.txt'
    pf.write_text(policy + '\n', encoding='utf-8')
    out = CAND / f'{name}-strip39.writeback-plan.json'
    cmd = ['node', str(MAKER), '--library-root', str(LIB), '--target', it['targetDir'],
           '--candidate', str(REPO / it['workDir']), '--slug', f'{name}-strip39',
           '--policy-file', str(pf), '--out', str(out),
           '--evidence', 'lowband-strip39/recheck.json']
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=str(REPO))
    if r.returncode != 0:
        odd.append((name, 'maker-rc', r.returncode, r.stderr.strip()[:120]))
        continue
    plan = json.loads(out.read_text(encoding='utf-8'))
    ops = plan.get('ops', [])
    kinds = {o['kind'] for o in ops}
    # 计划生成器按整包 put（与 lb1–lb7 同形制）：因此判据不是「只有 1 个 put」，而是
    # ① 除 SKILL.md 外没有任何 remove/prune；② 非 SKILL.md 的每条 put 的 sourceSha256
    #    ＝库内当前文件哈希（＝逐字节重写，不是夹带改动）；③ SKILL.md 恰有一条 put。
    sk_rel = it['relPath']
    problems = []
    if kinds - {'put'}:
        problems.append(('non-put-ops', sorted(kinds - {'put'})))
    if sum(1 for o in ops if o['relPath'] == sk_rel) != 1:
        problems.append(('skill-put-count', sum(1 for o in ops if o['relPath'] == sk_rel)))
    for o in ops:
        if o['relPath'] == sk_rel:
            continue
        lp = LIB / o['relPath']
        if not lp.is_file():
            problems.append(('missing-library-file', o['relPath']))
        elif hashlib.sha256(lp.read_bytes()).hexdigest() != o.get('sourceSha256'):
            problems.append(('would-change-untouched-file', o['relPath']))
    if problems:
        odd.append((name, problems[:3]))
    made.append((name, len(ops)))

summary = {'record_type': 'p2_strip39_plans', 'at': '2026-10-03',
           'items': len(made), 'expected_ops_per_plan': '恰 1 个 put（该件 SKILL.md），0 remove',
           'odd': odd}
(BAND / 'plans-summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=1) + '\n',
                                         encoding='utf-8')
print(f'计划 = {len(made)} 件 | 形制异常 = {len(odd)}')
for o in odd[:8]:
    print('  !', o)
