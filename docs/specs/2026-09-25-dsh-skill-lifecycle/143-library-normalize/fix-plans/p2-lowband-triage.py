#!/usr/bin/env python3
"""低级分带选择性修复·分诊（零请求）：从 wave-2 证据抽取判者问题区＋机械化可修复性粗分类。

输入：fix-plans/p2-wave2-closeout.json（456 行读数）＋ opt-run/evidence-r{r}/armed-*.json
输出：143-library-normalize/lowband-triage/{extracts/<name>.md, triage.json}
用法：python3 -B p2-lowband-triage.py [--band LO HI] [--out 目录名]（默认 70 80 → lowband-triage）
"""
import argparse
import json
import re
from pathlib import Path

BASE = Path(__file__).resolve().parent          # fix-plans/
ROOT = BASE.parents[0]                          # 143-library-normalize/
OPT = Path('/Users/lute/project/AgentTools/思维库/skill管理/skill-lifecycle/trial-home/opt-run')
OUT = ROOT / 'lowband-triage'
EXTRACTS = OUT / 'extracts'

MECH = ('schema', 'complexity', 'compatibility', 'version', 'license', 'author',
        'metadata', 'frontmatter', 'negative loading', 'negative loading', '负向',
        '负例', '元数据', '字段', '渐进式披露', '拆分', '目录结构', '死链', '悬空',
        '触发词', 'description', '边界', 'boundary', 'eval', '测试用例', '验证用例',
        '示例缺失', '缺少示例', '示例', 'references', '脚本', '结构化')
CONTENT = ('方法论', '差异化', '空洞', '泛化', '模板化', '深度', '创新', '同质',
           '空泛', '平淡', '说服力', '专业性', '洞察', '竞争壁垒', '替代', '护城河',
           '独特性', '实战', '质量不足', '内容薄弱', '浅', '堆砌')


def problem_blocks(rep: str):
    lines = rep.splitlines()
    keep = []
    buf = 0
    in_prob = False
    for ln in lines:
        t = ln.strip()
        hit = bool(re.search(r'^#{1,4}\s*[一二三四五六]?[、.]?\s*问题|^#{1,4}\s*.{0,12}(修复建议|问题清单|缺陷|阻断)', t)) \
            or ('严重度' in t and ('error' in t.lower() or 'warning' in t.lower() or '信息' in t or '建议' in t)) \
            or bool(re.match(r'^\*\*问题\s*\d+', t)) or bool(re.match(r'^###\s*问题', t)) \
            or bool(re.match(r'^\d+\.\s*\*\*(必需|推荐|修复|Schema|Missing|缺)', t))
        if hit:
            in_prob = True
        if in_prob:
            keep.append(ln)
            buf += len(ln)
            if buf > 6000:
                in_prob = False
    if not keep:
        keep = lines[-120:]
    return '\n'.join(keep)


def count_issues(txt: str) -> int:
    n = len(re.findall(r'^#{3,4}\s*(?:问题|[0-9]+[.、])', txt, re.M))
    n += len(re.findall(r'^\*\*问题\s*\d+', txt, re.M))
    n += len(re.findall(r'^\|\s*[0-9]+\s*\|', txt, re.M))
    return max(n, 1 if txt.strip() else 0)


def main():
    global OUT, EXTRACTS
    ap = argparse.ArgumentParser()
    ap.add_argument('--band', nargs=2, type=float, default=[70, 80])
    ap.add_argument('--out', default='lowband-triage')
    args = ap.parse_args()
    lo, hi = args.band
    if args.out != 'lowband-triage':
        OUT = ROOT / args.out
        EXTRACTS = OUT / 'extracts'

    close = json.loads((BASE / 'p2-wave2-closeout.json').read_text(encoding='utf-8'))
    wave2_sel = json.loads((BASE / 'p2-wave2-selection.json').read_text(encoding='utf-8'))
    w2 = wave2_sel['items'] if isinstance(wave2_sel, dict) else wave2_sel
    path_by_name = {it['name']: it.get('relPath') for it in w2}

    rows = [e for e in close['rows'] if e.get('score') and lo <= float(e['score']) < hi]
    rows.sort(key=lambda e: float(e['score']))

    EXTRACTS.mkdir(parents=True, exist_ok=True)
    out = []
    for e in rows:
        r = e['round']
        ev = OPT / f'evidence-r{r}'
        files = sorted(ev.glob('armed-*.json'))
        rep = ''
        mat_bytes = 0
        if files:
            rec = json.loads(files[0].read_text(encoding='utf-8'))
            rep = rec.get('report') or ''
            mat_bytes = sum(m.get('bytes', 0) for m in rec.get('materials', []))
        txt = problem_blocks(rep)
        header = (f'# {e["name"]}（r{r}；{e.get("score")} {e.get("verdict")}；'
                  f'材料 {mat_bytes}B；报告 {len(rep)} 字符）\n\n')
        (EXTRACTS / f'{e["name"]}.md').write_text(header + txt + '\n', encoding='utf-8')

        low = txt.lower()
        mech = sum(low.count(k.lower()) for k in MECH)
        cont = sum(low.count(k.lower()) for k in CONTENT)
        issues = count_issues(txt)
        out.append({
            'round': r, 'name': e['name'], 'score': float(e['score']),
            'verdict': e.get('verdict'), 'kind': e.get('kind'),
            'relPath': path_by_name.get(e['name']), 'materialBytes': mat_bytes,
            'issues': issues, 'mechHits': mech, 'contentHits': cont,
            'mechRatio': round(mech / (mech + cont), 3) if (mech + cont) else None,
            'reportChars': len(rep),
        })

    (OUT / 'triage.json').write_text(json.dumps({
        'record_type': 'p2_lowband_triage',
        'band': [lo, hi],
        'count': len(out),
        'items': out,
    }, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')

    # 汇总
    mech_dom = [x for x in out if (x['mechRatio'] or 0) >= 0.7]
    mid = [x for x in out if 0.4 <= (x['mechRatio'] or 0) < 0.7]
    cont_dom = [x for x in out if (x['mechRatio'] or 0) < 0.4]
    print(json.dumps({
        'band': [lo, hi], 'items': len(out),
        'mechDominant(>=0.7)': len(mech_dom),
        'mixed(0.4-0.7)': len(mid),
        'contentDominant(<0.4)': len(cont_dom),
        'noReport': len([x for x in out if x['reportChars'] == 0]),
    }, ensure_ascii=False))
    print('extracts:', EXTRACTS)


if __name__ == '__main__':
    main()
