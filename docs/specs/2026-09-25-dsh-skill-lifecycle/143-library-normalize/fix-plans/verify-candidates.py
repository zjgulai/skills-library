#!/usr/bin/env python3
"""pilot2 候选修复·系统核验（零请求）：逐件对照靶单要求与候选实际 frontmatter/文件。

检查项：
  F1 frontmatter YAML 可解析且 name 不变
  F2 基础三件套 version/complexity/compatibility 在场（按靶单点名要求为准）
  F3 靶单点名的 license/author/metadata 等附加字段在场
  F4 description 含负向/边界声明（多语言词面）
  F5 靶单提到的新建文件在场（references/xxx 等，模式抓取）

输出：nearmiss-pilot2/verify-report.json ＋ stdout 汇总（缺项逐件列出）。
用法：python3 -B verify-candidates.py [--lb1|--lb2|--lb3|--lb4|--lb5|--lb6|--lb7]（缺省 nearmiss-pilot2 选单）
"""
import json
import re
import sys
from pathlib import Path

import yaml

norm = Path('docs/specs/2026-09-25-dsh-skill-lifecycle/143-library-normalize')
CAND = Path('skill-lifecycle/trial-home/opt-run/candidates')

NEG_MARKERS = ('DO NOT', 'Do NOT', 'Do not', 'do not', 'NOT for', 'When NOT', 'when not', 'Not for',
               'not for', '不要在', '不要用于', '不适用', '何时不用', 'When not to',
               'when not to', '不触发', '排除', '勿用于', '请勿', 'not intended for',
               'avoid using', 'not appropriate', '何时不该', '不该使用', '不要用',
               'does not write', 'does not start', 'Yield when', 'yield when',
               '不写入', '不下沉', 'not write', '不应使用', '何时不使用', '何时不用：', '别用它', '不适用场景')

# 已人工复核为误报/已按靶单反向执行的 (name, 模式) 对（模式可为目标字段名或 references/... 文件）
KNOWN_FALSE = {('smb-router', 'references/routing-matrix.md'),
               ('web-typography', 'references/xxx.md'),  # 靶单方案 B 字面占位符；候选按方案 A 已建 5 真实文件
               ('google-docs', 'references/error-handling.md'),  # 靶单「或」式二选一；候选已按正文章节路实现
               ('instagram', 'references/publishing.md'),  # 靶单双名变体（问题 4 修法＝publishing-guide.md 已建）；roadmap 行旧名不追
               ('influence-psychology', 'references/xxx.md'),  # 靶单方案 B 字面占位符；候选按方案 A 已建 10 真实文件
               ('k8s-cluster-ops', 'license'),  # 靶单 error 级要求「移除顶层 license/metadata」；候选已按靶单执行（MIT 移入正文/README）
               ('crossing-the-chasm', 'version'),  # 靶单点名「顶层与 metadata 重复定义」→ 要求移除顶层三件套（保留 metadata 副本）+补 dependencies；已按靶单执行
               ('crossing-the-chasm', 'complexity'),
               ('crossing-the-chasm', 'compatibility'),
               # ---- LB-7 复核（2026-10-03）----
               ('notion', 'references/auth-quota.md'),  # 靶单示意名；候选建的是 references/auth-and-quota.md（同义拆分，正文已按新名引用）
               ('linkedin-automation', 'references/lead-scoring.md'),  # 靶单原文「考虑…如拆分为」＝建议式；候选落 references/outreach-and-scouting 同族件
               ('inspired-product', 'references/case-studies.md'),  # 靶单点的是上游 6 件全缺；候选合并为 4 件实文件，正文不再引用未交付名
               ('inspired-product', 'references/stakeholder-management.md'),  # 同上（与 product-vision 合成 product-vision-and-stakeholders.md）
               ('lean-startup', 'references/assumptions.md'),  # 靶单点 11 处死链；候选保留 3 个实件并把其余内容收回正文，正文零悬空引用
               ('hooked-ux', 'references/neuroscience-foundations.md'),  # 修法取「删引用并把内容收回正文」（351 行正文），非拆文件
               # personal-productivity：同上一条修法（死链消除，正文 143 行内自足）
               # sheets-automation：靶单点名 references/templates.md，候选按「报表模板」语义建 references/report-templates.md，
               # formulas.md 已建；正文无悬空引用（sweep S4 独立确认）⇒ 双名变体豁免，沿 instagram 先例
               ('sheets-automation', 'references/templates.md')}



def check_item(name, target_text, cand_dir):
    rep = {'name': name, 'gaps': [], 'fields': {}, 'files_created': []}
    sk = cand_dir / 'SKILL.md'
    if not sk.exists():
        rep['gaps'].append('SKILL.md missing')
        return rep
    t = sk.read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---', t, re.S)
    if not m:
        rep['gaps'].append('no frontmatter block')
        return rep
    try:
        d = yaml.safe_load(m.group(1))
    except yaml.YAMLError as e:
        rep['gaps'].append(f'YAML parse error: {e}')
        return rep
    if not isinstance(d, dict):
        rep['gaps'].append('frontmatter not a mapping')
        return rep
    for k in ('name', 'version', 'complexity', 'compatibility', 'license', 'author'):
        if k in d:
            rep['fields'][k] = str(d[k])[:80]
    low = target_text
    # 靶单点名的字段（宽松词面）
    wants = set()
    if re.search(r'`complexity`|complexity 字段|complexity 缺失|缺少.*complexity', low):
        wants.add('complexity')
    if re.search(r'`compatibility`|compatibility 字段|缺失.*compatibility|compatibility 与', low):
        wants.add('compatibility')
    if re.search(r'`version`|version 字段|缺失.*version|version 缺失', low):
        wants.add('version')
    if re.search(r'`license`|license 字段|license 缺失|许可', low):
        wants.add('license')
    if re.search(r'`author`|author 字段|作者字段|作者[:：]', low):
        wants.add('author')
    wants |= {'version', 'complexity', 'compatibility'}  # schema 三件套恒查
    for w in sorted(wants):
        if (name, w) in KNOWN_FALSE:  # 复核豁免（沿靶单反向执行等）
            continue
        if w not in d:
            rep['gaps'].append(f'missing field: {w}')
    desc = str(d.get('description', ''))
    if not any(mk in desc for mk in NEG_MARKERS):
        rep['gaps'].append('description lacks negative/boundary clause')
    # 新建文件：仅当靶单在 mention 附近有创建动作词时才要求其存在（否则可能是"删除悬空引用"类指令）
    CREATE_KW = ('创建', '新建', '拆分', '抽离', '移至', '迁移至', '增加', '补充', '追加',
                 'create', 'split', 'move ', 'add ')
    for mm in set(re.findall(r'references/([\w.-]+\.md)', target_text)):
        if (name, f'references/{mm}') in KNOWN_FALSE:
            continue
        contexts = [target_text[max(0, m0.start() - 90): m0.end() + 90]
                    for m0 in re.finditer(re.escape('references/' + mm), target_text)]
        if not any(any(kw in c for kw in CREATE_KW) for c in contexts):
            continue
        if not (cand_dir / 'references' / mm).exists():
            rep['gaps'].append(f'victim file missing?: references/{mm}')
    return rep


def main():
    BANDS = [('--lb7', 'lb7'), ('--lb6', 'lb6'), ('--lb5', 'lb5'), ('--lb4', 'lb4'),
             ('--lb3', 'lb3'), ('--lb2', 'lb2'), ('--lb1', 'lb1')]
    scope = next((code for flag, code in BANDS if flag in sys.argv), 'nearmiss2')
    base = norm / ('nearmiss-pilot2' if scope == 'nearmiss2' else f'lowband-{scope}')
    sel = json.loads((base / 'selection.json').read_text(encoding='utf-8'))
    reps = []
    for it in sel['items']:
        name = it['name']
        tf = it['targetFile']
        # 兼容两种冻结写法：相对带目录（lb1–lb6）与相对 143-library-normalize（lb7 起）
        tt = (norm / tf if tf.startswith('lowband-') else base / tf).read_text(encoding='utf-8')
        reps.append(check_item(name, tt, CAND / f'{name}-gen1'))
    out = {'record_type': 'p2_candidate_verify',
           'scope': scope,
           'at': '2026-10-03', 'items': reps}
    (base / 'verify-report.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    clean = [r for r in reps if not r['gaps']]
    dirty = [r for r in reps if r['gaps']]
    print(f"items={len(reps)} clean={len(clean)} gaps={len(dirty)}")
    for r in dirty:
        print(f"- {r['name']}: {'; '.join(r['gaps'])}")


if __name__ == '__main__':
    main()
