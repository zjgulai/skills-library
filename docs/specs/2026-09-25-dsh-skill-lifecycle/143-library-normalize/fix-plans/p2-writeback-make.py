#!/usr/bin/env python3
"""写回计划批生成（零请求）：按批（pilot1 / pilot2 / lb1）为收口件生成 writeback-plan。

每件：
  1) 从 closeout/results 找到「同名最后一条收口腿」→ 候选后缀（main→gen1, v2→gen2, v3→gen3）
  2) 计算库内→候选的文件删除集（--remove）＋必要时 --prune-empty
  3) 生成 policy.txt（基线分/复评分/证据轮号）
  4) 调 writeback-plan-make.mjs 产出 candidates/<name>-<suffix>.writeback-plan.json

用法：python3 -B p2-writeback-make.py <pilot1|pilot2|lb1>
"""
import json
import subprocess
import sys
from pathlib import Path

REPO = Path('/Users/lute/project/AgentTools/思维库/skill管理')
LIB = Path('/Users/lute/project/AgentTools/技能库')
OPT = REPO / 'skill-lifecycle/trial-home/opt-run'
CAND = REPO / 'skill-lifecycle/trial-home/opt-run/candidates'
MAKER = REPO / 'skill-lifecycle/trial-home/screening/writeback-plan-make.mjs'
NORM = REPO / 'docs/specs/2026-09-25-dsh-skill-lifecycle/143-library-normalize'
OUTDIR = NORM / 'p2-writeback'

LEG_SUFFIX = {'main': 'gen1', 'v1': 'gen1', 'v2': 'gen2', 'v3': 'gen3'}

# 改名件：库内目录已在写回前经 skill-repair-rename.mjs 改名（p2-writeback/rename-fashion-sketch-cn.json），
# 目标目录按新名解析（判者两轮 error 级命名修复；复评收口 96.0）。
RENAME_MAP = {'fashion-sketch-cn': 'apparel-tech-pack',
              'equity-research-report-cn': 'equity-research-report',
              'astro-observation-report-cn': 'astro-observation-report'}

# 库内保留名单：未被任何文本引用的二进制资产（推广二维码/配图）不随修复删除。
# 依据 2026-10-02 复核：karpathy/feynman/taleb/paul-graham 包内 wechat-qrcode.jpg 与
# huashu-flash assets/*.png 在库内与候选内均无任何 markdown 引用；删除超出修复射程，保留。
# 键为「件名 + 目标目录内相对路径」（与 walk_files(target) 口径一致）。
KEEP_IN_LIBRARY = {
    ('andrej-karpathy-perspective', 'wechat-qrcode.jpg'),
    ('feynman-perspective', 'wechat-qrcode.jpg'),
    ('taleb-perspective', 'wechat-qrcode.jpg'),
    ('paul-graham-perspective', 'wechat-qrcode.jpg'),
    ('huashu-flash', 'assets/flash-mascot.png'),
    ('huashu-flash', 'assets/steps/01-handoff.png'),
    ('huashu-flash', 'assets/steps/02-measure.png'),
    ('huashu-flash', 'assets/steps/03-climb.png'),
    ('huashu-flash', 'assets/steps/04-ratchet.png'),
    ('huashu-flash', 'assets/steps/05-guardrails.png'),
    ('huashu-flash', 'assets/steps/06-ship.png'),
}


BAND_DIRS = {'pilot1': 'nearmiss-pilot', 'pilot2': 'nearmiss-pilot2',
             'lb1': 'lowband-lb1', 'lb2': 'lowband-lb2', 'lb3': 'lowband-lb3',
             'lb4': 'lowband-lb4', 'lb5': 'lowband-lb5', 'lb6': 'lowband-lb6',
             'lb7': 'lowband-lb7'}


def load_closeout(batch):
    d = BAND_DIRS.get(batch)
    if d is None:
        raise SystemExit('batch? ' + '|'.join(BAND_DIRS))
    c = json.loads((NORM / d / 'closeout.json').read_text(encoding='utf-8'))
    sel = json.loads((NORM / d / 'selection.json').read_text(encoding='utf-8'))
    return c, sel, NORM / d


def final_legs(closeout):
    """同名最后一条 reading 腿（含 closed 标记）"""
    final = {}
    for e in closeout['rows']:
        if e.get('status') != 'reading':
            continue
        prev = final.get(e['name'])
        if prev is None or e['round'] >= prev['round']:
            final[e['name']] = e
    return final


def walk_files(d):
    out = []
    for p in sorted(Path(d).rglob('*')):
        if p.is_file():
            out.append(p.relative_to(d).as_posix())
    return out


def main():
    batch = sys.argv[1]
    closeout, sel, base = load_closeout(batch)
    items = {it['name']: it for it in sel['items']}
    legs = final_legs(closeout)
    OUTDIR.mkdir(parents=True, exist_ok=True)
    pol = OUTDIR / 'policies'
    pol.mkdir(parents=True, exist_ok=True)

    made, skipped = [], []
    for name, it in items.items():
        leg = legs.get(name)
        if not leg or not leg.get('closed'):
            skipped.append((name, 'not-closed/no-leg'))
            continue
        # 候选解析以 stage.json 为准（腿标签可能误导：taleb v3 实际 staged gen2）
        cand = None
        suffix = None
        stage = OPT / f"r{leg['round']}" / 'stage.json'
        if stage.exists():
            sp = json.loads(stage.read_text(encoding='utf-8')).get('skill')
            if sp:
                cand = Path(sp)
                if not cand.is_absolute():
                    cand = REPO / sp
                suffix = cand.name.rsplit('-', 1)[-1] if '-' in cand.name else 'gen1'
        if cand is None or not cand.is_dir():
            suffix = LEG_SUFFIX.get(leg.get('leg', 'main'), 'gen1')
            cand = CAND / f'{name}-{suffix}'
        if not cand.is_dir():
            skipped.append((name, f'candidate missing: {cand.name}'))
            continue
        target = LIB / Path(it['relPath']).parent
        if name in RENAME_MAP:
            target = target.parent / RENAME_MAP[name]
        if not target.is_dir():
            skipped.append((name, f'target missing: {target}'))
            continue
        # removals = 库内有而候选无（排除 KEEP_IN_LIBRARY 保留名单与 .DS_Store）
        lib_files = set(walk_files(target))
        cand_files = set(walk_files(cand))
        removes = sorted(r for r in (lib_files - cand_files)
                         if (name, r) not in KEEP_IN_LIBRARY and not r.endswith('.DS_Store'))
        # 防误删：opaque/二进制文件不应出现在候选里也属正常（stage 排除），必要时人工审
        evidence = f"evidence-r{leg['round']}"
        policy = (f'{batch} 写回·{name}（基线 {it.get("score")} 需优化@{it.get("round") or it.get("wave2Round")}；'
                  f'复评 r{leg["round"]} = {leg.get("score")} {leg.get("verdict") or ""}）。'
                  f'修复按判者靶单完成字段/描述/正文修订；候选=opt-run/candidates/{name}-{suffix}；'
                  f'证据={evidence}。')
        (pol / f'{name}.txt').write_text(policy + '\n', encoding='utf-8')
        out = CAND / f'{name}-{suffix}.writeback-plan.json'
        cmd = ['node', str(MAKER), '--library-root', str(LIB), '--target', str(target),
               '--candidate', str(cand), '--slug', f'{name}-{suffix}',
               '--policy-file', str(pol / f'{name}.txt'), '--out', str(out),
               '--evidence', evidence]
        for r in removes:
            cmd += ['--remove', r]
        if removes:
            cmd += ['--prune-empty']
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=str(REPO))
        if r.returncode != 0:
            skipped.append((name, f'make failed: {r.stderr.strip()[:120]}'))
            continue
        made.append((name, suffix, len(removes), r.stdout.strip()))

    print(f'batch={batch} made={len(made)} skipped={len(skipped)}')
    for m in made:
        print(' MADE', *m)
    for s in skipped:
        print(' SKIP', *s)


if __name__ == '__main__':
    main()
