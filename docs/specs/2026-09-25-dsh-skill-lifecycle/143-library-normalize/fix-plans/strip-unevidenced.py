#!/usr/bin/env python3
"""跨批无据 license/author 字段剥除·工作副本生成（零请求、绝不写库）。

用户口径（2026-10-03）＝「一起剥」：只处理 recheck.json 里 state=present-unevidenced 的条目，
即「相对库内原件由我们新增、且包内/祖先查不出处」的字段。上游自带的值不在射程内。

产物：opt-run/strip39/<name>/  ＝ 库内该包目录的逐字节复制 ＋ 仅 SKILL.md 去掉目标字段行；
      lowband-strip39/strip-plan-index.json ＝ 每件（work 目录／目标包目录／被剥的字段与旧行原文）。

用法：python3 -B strip-unevidenced.py            # 生成工作副本并打印统计
      python3 -B strip-unevidenced.py --check    # 只校验既有工作副本与库内的差集是否恰为被剥字段
"""
import json
import pathlib
import re
import shutil
import sys

import yaml

REPO = pathlib.Path(__file__).resolve().parents[5]   # fix-plans → 143 → 日期目录 → specs → docs → 仓根
NORM = REPO / 'docs/specs/2026-09-25-dsh-skill-lifecycle/143-library-normalize'
BAND = NORM / 'lowband-strip39'
OPT = REPO / 'skill-lifecycle/trial-home/opt-run'
WORK = OPT / 'strip39'
LIB = pathlib.Path('/Users/lute/project/AgentTools/技能库')


def fm_block(text):
    m = re.match(r'^---\n(.*?)\n---', text, re.S)
    return (m.group(1), m.start(1), m.end(1)) if m else (None, 0, 0)


def strip_line(text, field, value):
    """精确删除一条顶层标量字段行（整行锚定，不做子串匹配，防误删正文或嵌套同名字段）。"""
    m = re.match(r'^---\n(.*?)\n---', text, re.S)
    if not m:
        return None, 'NO_FRONTMATTER'
    lines = m.group(1).split('\n')
    pat = re.compile(rf'^{field}:[ \t]*(["\']?)(.*)\1[ \t]*$')
    idx = [i for i, l in enumerate(lines)
           if pat.match(l) and pat.match(l).group(2).strip() == str(value).strip()]
    if len(idx) != 1:
        return None, f'ANCHOR_COUNT_{len(idx)}'
    old = lines.pop(idx[0])
    new = text[:m.start(1)] + '\n'.join(lines) + text[m.end(1):]
    try:
        d = yaml.safe_load(fm_block(new)[0])
    except yaml.YAMLError:
        return None, 'YAML_BROKEN'
    if fm_block(new)[0] is None:
        return None, 'NO_FRONTMATTER_AFTER'
    if field in (d or {}):
        return None, 'STILL_PRESENT'
    return new, old


def build():
    rec = json.loads((BAND / 'recheck.json').read_text(encoding='utf-8'))
    targets = [r for r in rec['rows'] if r['state'] == 'present-unevidenced']
    by_item = {}
    for r in targets:
        by_item.setdefault((r['band'], r['name'], r['relPath']), []).append(r)
    index, problems = [], []
    if WORK.is_dir():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True)
    for (band, name, rel), rows in sorted(by_item.items()):
        src_dir = (LIB / rel).parent
        dst = WORK / name
        shutil.copytree(src_dir, dst)
        sk = dst / 'SKILL.md'
        text = sk.read_text(encoding='utf-8')
        stripped = []
        for r in rows:
            new, old = strip_line(text, r['field'], r['value'])
            if new is None:
                problems.append((band, name, r['field'], old))
                break
            stripped.append({'field': r['field'], 'removed_line': old})
            text = new
        else:
            sk.write_text(text, encoding='utf-8')
            index.append({'band': band, 'name': name, 'relPath': rel,
                          'workDir': str(dst.relative_to(REPO)),
                          'targetDir': str(src_dir),
                          'removed': stripped})
    out = {'record_type': 'p2_strip39_index', 'at': '2026-10-03',
           'caliber': '只剥 recheck 判为 present-unevidenced 的字段；工作副本＝库内整包复制＋仅 SKILL.md 去掉目标行；库内容此步不动',
           'items': len(index), 'fields': sum(len(i['removed']) for i in index),
           'problems': problems, 'work': index}
    (BAND / 'strip-plan-index.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n',
                                                encoding='utf-8')
    print(f'工作副本 = {len(index)} 件／{out["fields"]} 字段 | 异常 = {len(problems)}')
    for p in problems[:10]:
        print('  !', p)
    return 1 if problems or out['fields'] != len(targets) else 0


def check():
    """校验工作副本＝库内原件「只删掉被记录的那几行」，别的一个字节都不许多。

    注意：不能只比对 license/author 行是否少了——那样「顺手改了正文」或「多删一行 version」
    都会被判干净（本函数第一版就是这样，注入两类篡改都不红）。必须重建期望字节再逐字节比。
    """
    idx = json.loads((BAND / 'strip-plan-index.json').read_text(encoding='utf-8'))
    bad = []
    for it in idx['work']:
        dst = REPO / it['workDir']
        src = pathlib.Path(it['targetDir'])
        if not dst.is_dir():
            bad.append(('WORK-MISSING', it['name']))
            continue
        lf = {str(p.relative_to(src)) for p in src.rglob('*') if p.is_file()}
        wf = {str(p.relative_to(dst)) for p in dst.rglob('*') if p.is_file()}
        if lf != wf:
            bad.append(('FILE-SET-DIFF', it['name'], sorted(lf ^ wf)[:3]))
            continue
        for f in sorted(lf - {'SKILL.md'}):
            if (src / f).read_bytes() != (dst / f).read_bytes():
                bad.append(('UNEXPECTED-EDIT', it['name'], f))
        lines = (src / 'SKILL.md').read_text(encoding='utf-8').split('\n')
        for rr in it['removed']:
            ln = rr['removed_line']
            if lines.count(ln) != 1:
                bad.append(('ANCHOR-NOT-UNIQUE', it['name'], ln[:40], lines.count(ln)))
                break
            lines.remove(ln)
        expected = '\n'.join(lines)
        actual = (dst / 'SKILL.md').read_text(encoding='utf-8')
        if actual != expected:
            i = next((j for j, (a, b) in enumerate(zip(expected.split('\n'), actual.split('\n'))) if a != b), None)
            bad.append(('WORK-DIFFERS', it['name'], f'首个差异行 {i}',
                        (expected.split('\n')[i] if i is not None else '(长度不同)')[:60]))
    print(f'校验 {len(idx["work"])} 件 | 期望字节重建后违例 = {len(bad)}')
    for b in bad[:10]:
        print('  !', b)
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(check() if '--check' in sys.argv else build())
