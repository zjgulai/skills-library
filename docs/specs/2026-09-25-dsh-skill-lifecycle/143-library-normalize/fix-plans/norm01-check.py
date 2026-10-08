#!/usr/bin/env python3
"""P1 归一化（143）· 候选校验器（零请求）：
A. 跨技能去路径：26 件中全部 finding 路径不得残留（全目录扫描）；
B. 短描述：2 件 desc 长度 ≥40；
C. 改名：9 件新目录存在、旧目录不存在；
D. 负控：m1 复注跨技能路径→A 必红；m2 回写短描述→B 必红。"""
import json, re, shutil, sys, tempfile
from pathlib import Path

LIB = Path('/Users/lute/project/AgentTools/技能库')
BASE = Path('docs/specs/2026-09-25-dsh-skill-lifecycle/143-library-normalize')
T = json.loads((BASE / 'fix-plans' / 'normalize-targets.json').read_text(encoding='utf-8'))
REN = json.loads((BASE / 'fix-plans' / 'norm01-rename-plan.json').read_text(encoding='utf-8'))
SHORT = ['skills-mactt/skills/in-progress/implement-spec/SKILL.md', 'skills-mactt/skills/in-progress/pr/SKILL.md']

def v_cross(lib, item):
    errs = []
    paths = {f['detail'].split('：')[0].strip() for f in item['findings'] if f['code'] == 'CROSS_SKILL_RELATIVE_PATH'}
    d = (lib / item['relPath']).parent
    if not d.exists(): return [f"目录缺: {d}"]
    for p in sorted(d.rglob('*')):
        if p.is_file():
            try: t = p.read_text(encoding='utf-8')
            except UnicodeDecodeError: continue
            for q in paths:
                if q in t: errs.append(f"{item['name']}: {p.relative_to(d)} 残留 {q}")
    return errs

def v_short(lib, relf):
    f = lib / relf
    if not f.exists(): return [f'缺文件 {relf}']
    m = re.search(r'^description:\s*"?(.+?)"?\s*$', f.read_text(encoding='utf-8'), re.M)
    if not m: return [f'{relf} 无 description']
    if len(m.group(1).strip()) < 40: return [f'{relf} desc 过短 {len(m.group(1))}']
    return []

def v_renames(lib, ren):
    errs = []
    for r in ren['renames']:
        old = lib / r['relPath']; newd = old.parent.parent / r['nextDir']
        if not (newd / 'SKILL.md').exists(): errs.append(f"{r['nextDir']}: 新目录缺 SKILL.md")
        if old.parent.exists() and old.parent.name != r['nextDir']: errs.append(f"{r['nextDir']}: 旧目录仍在 {old.parent}")
    return errs

fail = 0
cross_items = [i for i in T['items'] if any(f['code'] == 'CROSS_SKILL_RELATIVE_PATH' for f in i['findings'])]
e1 = [e for i in cross_items for e in v_cross(LIB, i)]
e2 = [e for relf in SHORT for e in v_short(LIB, relf)]
e3 = v_renames(LIB, REN)
print(f'A 跨技能残留: {"PASS" if not e1 else "FAIL " + str(e1[:3])}（{len(cross_items)} 件）')
print(f'B 短描述: {"PASS" if not e2 else "FAIL " + str(e2)}')
print(f'C 改名: {"PASS" if not e3 else "FAIL " + str(e3[:3])}（{len(REN["renames"])} 件）')
fail += len(e1) + len(e2) + len(e3)

# 负控
def mut_cross():
    tmp = Path(tempfile.mkdtemp(prefix='n01a-'))
    try:
        item = cross_items[0]; src = (LIB / item['relPath']).parent
        dst = tmp / item['relPath']; dst.parent.mkdir(parents=True); shutil.copytree(src, dst.parent, dirs_exist_ok=True)
        f = dst
        p = item['findings'][0]['detail'].split('：')[0].strip()
        f.write_text(f.read_text(encoding='utf-8') + f"\n\nSee [x]({p}).\n", encoding='utf-8')
        errs = v_cross(tmp, item)
        return (True, errs[0][:70]) if errs and p in ' '.join(errs) else (False, f'未红 {errs[:1]}')
    finally: shutil.rmtree(tmp, ignore_errors=True)

def mut_short():
    tmp = Path(tempfile.mkdtemp(prefix='n01b-'))
    try:
        relf = SHORT[0]; dst = tmp / relf; dst.parent.mkdir(parents=True)
        t = (LIB / relf).read_text(encoding='utf-8')
        t = re.sub(r'^description:.*$', 'description: "Implement a spec."', t, count=1, flags=re.M)
        dst.write_text(t, encoding='utf-8')
        errs = v_short(tmp, relf)
        return (True, errs[0][:70]) if errs else (False, '未红')
    finally: shutil.rmtree(tmp, ignore_errors=True)

for name, fn in (('m1 复注跨技能路径', mut_cross), ('m2 回写短描述', mut_short)):
    ok, detail = fn()
    print(f'[负控] {name}: {"红 ✓" if ok else "FAIL"} — {detail}')
    if not ok: fail += 1
print('RESULT:', 'PASS' if fail == 0 else f'FAIL({fail})')
sys.exit(0 if fail == 0 else 1)
