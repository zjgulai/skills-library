#!/usr/bin/env python3
"""license/author 来源归属审计（零请求）：判定库里这两个字段是上游原有还是我们制作期新增。

两条独立归属通道：
  A. wave-2 认证快照 —— opt-run/r{wave2Round}/material/SKILL.md 是修复前库内原文的暂存副本；
     lb1–lb6 从各自 selection.json 的 wave2Round 取轮次，pilot1/pilot2 从 p2-wave2-closeout.json 的 name→round 取。
  B. 写回备份根 —— trial-home/library-backup-writeback-<slug>-<tag>-<date>/<relPath> 是写回前库内文件（仅 nm2/nm3/lb4/lb5 有）。

对「我们新增」的字段再查包树出处（同包或祖先的 LICENSE/COPYING/THIRD-PARTY 文件，或 README/正文里的许可声明）。
输出：143-library-normalize/license-provenance.json
用法：python3 -B fix-plans/license-provenance.py
"""
import json
import re
import pathlib
import collections

REPO = pathlib.Path(__file__).resolve().parents[5]
NORM = REPO / 'docs/specs/2026-09-25-dsh-skill-lifecycle/143-library-normalize'
OPT = REPO / 'skill-lifecycle/trial-home/opt-run'
LIB = pathlib.Path('/Users/lute/project/AgentTools/技能库')
FIELDS = ('license', 'author')

BAND_TAGS = {'lowband-lb1': 'lb1', 'lowband-lb2': 'lb2', 'lowband-lb3': 'lb3',
             'lowband-lb4': 'lb4', 'lowband-lb5': 'lb5', 'lowband-lb6': 'lb6',
             'nearmiss-pilot': 'nm2', 'nearmiss-pilot2': 'nm2'}


def frontmatter(text):
    if not text.startswith('---'):
        return ''
    parts = text.split('---', 2)
    return parts[1] if len(parts) > 2 else ''


def field_of(text, key):
    m = re.search(rf'^{key}:\s*(.+)$', frontmatter(text), re.M)
    return m.group(1).strip().strip('"\'') if m else ''


def body_of(text):
    parts = text.split('---', 2)
    return parts[2] if len(parts) > 2 else ''


def rel_lib(p):
    """证据标签：库内路径按 LIB 相对，候选树外的路径按原样（供主线复检直接喂候选目录）。"""
    try:
        return str(p.relative_to(LIB))
    except ValueError:
        return str(p)


LIC_TWIN = r'%s[^\n]{0,60}(?:许可证|License|Licensed under|SPDX)|' \
           r'(?:许可证|License|Licensed under|SPDX)[^\n]{0,80}%s'

NEG_LIC = re.compile(r'(?i)(no\s+repository[-\s]?wide|does\s+not\s+establish|not\s+established|'
                     r'no\s+uniform|not\s+assigned|no\s+additional\s+rights|grants\s+no|'
                     r'no\s+license|without\s+a\s+license|'
                     r'未获得授权|不代表|无统一|不适用|未为[^\n]{0,20}添加|不等于[^\n]{0,30}授权)')


def line_of(text, pos):
    s = text.rfind('\n', 0, pos) + 1
    e = text.find('\n', pos)
    return text[s: len(text) if e < 0 else e]


def affirmed(text, m):
    """命中行本身不能是否定句（MuseAI README.en.md:516 就在同一条里写「No repository-wide MIT…has been assigned」）。"""
    return not NEG_LIC.search(line_of(text, m.start()))


def affirmed_window(text, value, span=240):
    """值出现的上下文窗口里要有许可措辞、且没有否定句（Markdown 标题与正文常分行，不能只按单行判）。"""
    for m in re.finditer(re.escape(value), text, re.I):
        w = text[max(0, m.start() - span): m.end() + span]
        if re.search(r'许可证|许可协议|License|Licensed under|SPDX', w, re.I) and not NEG_LIC.search(w):
            return True
    return False


def decl_lines(text, decl):
    """返回所有「值＋许可/署名措辞同现」且未被否定的行。"""
    out = []
    for m in decl.finditer(text):
        ln = line_of(text, m.start())
        if affirmed(text, m):
            out.append(ln)
    return out


def pkg_evidence(skill_file, value, package_level=True, lineage=None):
    """包树里是否有支撑该值的出处。

    两级口径（2026-10-03 修正）：包自己那一层任何文本文件里的明文许可声明都算据
    （例：speech-synthesis/DISTRIBUTION.md「## 许可协议 / MIT 许可协议」，文件名不限于
    LICENSE/README）；再往上的祖先仍只认 LICENSE／COPYING／README 类文件——
    否则一份随手写的祖先文档就能替他人作品授权。"""
    hits = []
    if value:
        # 出处必须是「值＋许可/署名措辞同现」，两个方向都收；但值本身孤立出现不算证据
        # （否则任何提到该词的句子都能替授权/署名作证）
        WORD = r'(?:许可证?|License|Licensed under|SPDX|作者|署名|[Aa]uthor|[Mm]aintainer|maintained by|written by|©|Copyright|团队|[Tt]eam)'
        decl = re.compile(rf'{WORD}[^\n]{{0,80}}{re.escape(value)}|{re.escape(value)}[^\n]{{0,60}}{WORD}', re.I)
        if package_level:
            for f in sorted(skill_file.parent.iterdir()):
                if not f.is_file() or f.name == 'SKILL.md':
                    continue
                if f.suffix.lower() not in ('.md', '.txt', '.rst') and not re.match(r'(?i)^(license|licence|copying|notice)', f.name):
                    continue
                if decl_lines(f.read_text(errors='replace'), decl):
                    hits.append(rel_lib(f) + '#' + f.name)
    cur = (lineage or skill_file).parent.parent
    while cur not in (LIB.parent, LIB) and str(cur).startswith(str(LIB)):
        for f in sorted(cur.iterdir()):
            if not f.is_file():
                continue
            if re.match(r'(?i)^(license|licence|copying|notice|third[-_]party)', f.name):
                t = f.read_text(errors='replace')
                if affirmed_window(t, value, span=160):
                    hits.append(rel_lib(f) + '#' + f.name)
            elif re.match(r'(?i)^readme', f.name):
                t = f.read_text(errors='replace')
                if value and affirmed_window(t, value):
                    hits.append(rel_lib(f) + ':' + f.name)
        cur = cur.parent
    return hits


def main():
    wave2_round = {r['name']: r['round'] for r in json.load(open(NORM / 'fix-plans/p2-wave2-closeout.json'))['rows']}
    backups = {}
    idx = re.compile(r'^library-backup-writeback-(.+?)-(gen\d+)?-?(nm2|nm3|lb[1-6])-\d{4}-\d{2}-\d{2}$')
    for b in OPT.parent.glob('library-backup-writeback-*'):
        m = idx.match(b.name)
        if m:
            backups.setdefault(m.group(3), {})[m.group(1)] = b

    rows = []
    for band, tag in BAND_TAGS.items():
        sel = json.load(open(NORM / band / 'selection.json'))
        for it in (sel['items'] if isinstance(sel, dict) else sel):
            name, rp = it.get('name'), it.get('relPath')
            if not name or not rp:
                continue
            cur_file = LIB / rp
            if not cur_file.exists():
                rows.append({'band': band, 'name': name, 'status': '库内文件缺'})
                continue
            now_text = cur_file.read_text(errors='replace')
            w2r = it.get('wave2Round') or wave2_round.get(name)
            snap_file = OPT / f'r{w2r}' / 'material' / 'SKILL.md' if w2r else None
            snap_text = snap_file.read_text(errors='replace') if snap_file and snap_file.exists() else None
            bk = backups.get(tag, {}).get(name)
            bk_file = bk / rp if bk else None
            bk_text = bk_file.read_text(errors='replace') if bk_file and bk_file.exists() else None
            entry = {'band': band, 'name': name, 'relPath': rp, 'wave2Round': w2r,
                     'has_wave2': snap_text is not None, 'has_backup': bk_text is not None}
            for key in FIELDS:
                nowv = field_of(now_text, key)
                snapv = field_of(snap_text, key) if snap_text else None
                bkpv = field_of(bk_text, key) if bk_text else None
                if not nowv:
                    verdict = 'absent'
                elif snap_text is None and bk_text is None:
                    verdict = 'unknown'
                else:
                    ref = snapv if snap_text is not None else bkpv
                    other = bkpv if (snap_text is not None and bk_text is not None) else None
                    if ref and nowv.lower() == str(ref).lower():
                        verdict = 'upstream'
                    elif ref and nowv:
                        verdict = 'upstream_differs'
                    else:
                        verdict = 'added_by_us'
                    if snap_text is not None and bk_text is not None and bool(bkpv) != bool(snapv):
                        verdict += '|channels_disagree'
                # 证据按「写回前的那一版」判：库内现在的内容可能已被我们写回过（SKILL.md
                # 里出现该值不构成出处），有备份根时一律改用备份树取证
                ev_src = (b / rp) if (b and (b / rp).exists()) else cur_file
                ev = pkg_evidence(ev_src, nowv, package_level=b is not None, lineage=cur_file) if nowv and verdict.startswith('added_by_us') else []
                entry[key] = {'now': nowv, 'wave2': snapv, 'backup': bkpv, 'verdict': verdict,
                              'evidence': ev[:3], 'evidenced': bool(ev)}
            rows.append(entry)

    uniq_rows = list({tuple(sorted((r['band'], r['name'], r.get('relPath', '')))): r for r in rows}.values())
    stats = collections.Counter()
    for e in uniq_rows:
        for key in FIELDS:
            d = e.get(key)
            if not d:
                continue
            v = d['verdict']
            if v.startswith('added_by_us'):
                label = 'evidenced' if d['evidenced'] else 'UNEVIDENCED'
                stats[f'{key}:{v}:{label}'] += 1
            else:
                stats[f'{key}:{v}'] += 1
    unevid = [{'band': e['band'], 'name': e['name'], 'relPath': e['relPath'],
               'wave2Round': e.get('wave2Round'), 'field': k, 'value': e[k]['now'],
               'wave2': e[k]['wave2'], 'backup': e[k]['backup']}
              for e in uniq_rows
              for k in FIELDS
              if e.get(k) and e[k]['verdict'].startswith('added_by_us') and not e[k]['evidenced']]
    out = {'record_type': 'p2_license_provenance', 'at': '2026-10-03',
           'caliber': '归属＝wave-2 认证快照（优先）＋写回备份根（互证），两通道冲突数须报出；'
           '出处取证两级：包内文件（LICENSE/COPYING/README/DISTRIBUTION 等，不含被我们写回的 SKILL.md 自身）＋祖先链 LICENSE/README；'
           '有写回备份的件按备份树取证（防自证循环），无备份的早期带只认祖先出处（包内文件已被我们覆写，不作据）；'
           '值必须与许可/署名措辞同现，孤立出现不算证据',
           'unique_items': len(uniq_rows),
           'stats': dict(sorted(stats.items())),
           'unevidenced_added': unevid,
           'rows': rows}
    (NORM / 'license-provenance.json').write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(json.dumps(out['stats'], ensure_ascii=False, indent=1))
    print(f'\n唯一件数 = {out["unique_items"]}；无出处且为我们新增的字段数 = {len(out["unevidenced_added"])}')
    for x in out['unevidenced_added']:
        print(f'  {x["band"]:16s} {x["name"]:38s} {x["field"]:8s} {x["value"]}')


if __name__ == '__main__':
    main()
