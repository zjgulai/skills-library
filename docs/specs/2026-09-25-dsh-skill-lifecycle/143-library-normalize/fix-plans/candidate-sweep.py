#!/usr/bin/env python3
"""候选制作·主线独立复检（零请求）：不采信制作代理的自检报告，逐件对着库内原件重跑。

检查项（E = 编辑面，S = 结构面）：
  E1 frontmatter 可解析且 name 与库内原件一致
  E2 上游自带 license/author 值不得被删改（缺正文只登记）
  E3 候选新增的 license/author 必须有包内/祖先出处（license-provenance.pkg_evidence）
  E4 相对库内原件的删除清单（供写回前逐件人工过目）
  S1 NUL/非文本字节
  S2 本机绝对路径 /Users/
  S3 __pycache__ / *.pyc 残留
  S4 引用完整性：正文引用的包内路径必须存在；包内文件必须被引用或有文档契约

用法：python3 -B candidate-sweep.py --lb7 [--names a,b,c] [--self-test]
      （--self-test＝负控电池，只在仓内临时副本上注入缺陷，跑完删除，不碰 candidates 真身）
输出：lowband-lb7/sweep-report.json ＋ stdout 汇总
"""
import importlib.util
import json
import os
import pathlib
import re
import sys

import yaml

_here = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('license_provenance', _here / 'license-provenance.py')
_lp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_lp)
LIB, pkg_evidence = _lp.LIB, _lp.pkg_evidence

norm = pathlib.Path('docs/specs/2026-09-25-dsh-skill-lifecycle/143-library-normalize')
CAND = pathlib.Path('skill-lifecycle/trial-home/opt-run/candidates')
FIELDS = ('license', 'author')
DOC_EXT = {'.md', '.txt', '.rst', '.json', '.yaml', '.yml', '.py', '.js', '.mjs', '.ts',
           '.sh', '.csv', '.html', '.css', '.tex'}


def parse_fm(text):
    """返回 (frontmatter dict | 'ERR' | None, 正文起始偏移)。"""
    m = re.match(r'^---\n(.*?)\n---', text, re.S)
    if not m:
        return None, 0
    try:
        return yaml.safe_load(m.group(1)), m.end()
    except yaml.YAMLError:
        return 'ERR', m.end()


def files_under(d):
    return sorted(p.relative_to(d).as_posix() for p in d.rglob('*') if p.is_file())


# 复核后的 S4 豁免：(件名, 词面) → 为什么不是包内资产引用
S4_EXEMPT = {
 ('brand-mood-board-maker', 'spec.md'): '交付物文件名（产出到工作目录），模板在 examples/moodboard-spec.md',
 ('brand-mood-board-maker', 'tile_prompts.md'): '交付物文件名，样例在 examples/tile_prompts.md',
 ('research-brief-blueprint', 'intake.md'): '交付物文件名（受理单填写结果），模板是 templates/intake-form.md',
 ('research-brief-blueprint', 'summary.md'): '交付物文件名，模板是 templates/executive-summary.md',
 ('directory-submissions', 'product-marketing.md'): '宿主项目输入件（正文明说"host project 的 .agents 目录内"）',
 ('directory-submissions', 'product-marketing-context.md'): '宿主项目输入件的历史别名',
 ('glab-attestation', 'filename.txt'): '示例命令行占位符',
 ('glab-release', 'secret-detection.yml'): '被描述的 GitLab 上游 CI 件，非本包资产',
 ('glab-release', 'template.yml'): '被描述的 GitLab 上游 CI 入口件，非本包资产',
 ('brandkit', 'prompt.txt'): '脚本产出物文件名（--out 参数示例）',
 ('glab-changelog', '.gitlab/changelog_config.yml'): '被描述的 GitLab 上游项目 CI 配置，非本包资产',
 ('glab-cluster', 'config.yml'): '用户侧配置文件名',
 ('glab-config', '.git/glab-cli/config.yml'): 'glab 运行时配置路径（用户机器上的真源，不是包内件）',
 ('glab-deploy-key', 'SECURITY.md'): '祖先规范件出处引用；已实查 技能库/skills/kimi/skills/gitlab-cli-guide/SECURITY.md 存在',
 ('glab-help', 'SECURITY.md'): '同上（祖先规范件，不随包发布）',
 ('glab-release', 'templates/secret-detection.yml'): 'glab --help 原文捕获里的上游示例路径',
 ('glab-release', 'templates/secret-detection/template.yml'): '同上',
 ('grill-with-docs', 'CONTEXT.md'): '宿主项目产物（本技能负责创建它）',
 ('grill-with-docs', 'CONTEXT-MAP.md'): '宿主项目产物',
 ('grill-with-docs', '0001-slug.md'): 'ADR 命名模板（占位 slug）',
 ('grill-with-docs', '0002-slug.md'): 'ADR 命名模板（占位 slug）',
 ('handoff', 'handoff.md'): '交付物文件名（写到工作目录）',
 ('huashu-prompt-save', 'prompt-011-a.md'): '库存文件命名规则示例',
 ('huashu-prompt-save', 'prompt-011-ab.md'): '库存文件命名规则示例',
 ('huashu-prompt-save', 'prompt-10-x.md'): '库存文件命名规则示例',
 ('paper-sync', 'changes.md'): 'evolve/ 轮次工作产物',
 ('paper-sync', 'observations.md'): 'evolve/ 轮次工作产物',
 ('paper-sync', 'patterns.md'): 'evolve/ 轮次工作产物',
 ('paper-sync', 'prompt-1.md'): 'evolve/ 轮次工作产物',
 ('paper-sync', 'prompt-2.md'): 'evolve/ 轮次工作产物',
 ('paper-sync', 'prompt-3.md'): 'evolve/ 轮次工作产物',
 ('speech-synthesis', 'output.json'): 'node-edge-tts 字幕产出文件名',
 ('standard-skill', 'references/x.md'): '规范条文里的泛指占位符（同行即举「文件不存在」反例）',
 ('ticketmaster', 'references/flights.md'): '上游 booking 包的姊妹件；正文两处已加 [not bundled] 回退注记',
 ('transcribe', 'src/openai/types/audio/transcription_create_params.py'): '上游 openai-python 源文件出处引用',
 ('transcribe', 'src/openai/types/audio_response_format.py'): '同上',
 ('wait-what', 'CLAUDE.md'): '宿主项目文件',
 ('resolving-merge-conflicts', 'package-lock.json'): '锁文件类型名（表格一行讲「不要手工合并锁文件」），不是包内资产',
 ('resolving-merge-conflicts', 'pnpm-lock.yaml'): '同上',
 ('grill-with-docs', './src/billing/CONTEXT.md'): 'CONTEXT-MAP.md 示例块里的示意路径（讲解宿主项目该怎么写），非包内资产',
 ('grill-with-docs', './src/ordering/CONTEXT.md'): '同上',
 ('resolving-merge-conflicts', 'package.json'): '宿主项目清单文件的举例（讲锁文件该由谁重新生成），非包内资产',
}

# 复核后的 S2 豁免：脚本把机器路径当「检测规则样本/合成夹具」，不是真实依赖
S2_EXEMPT = {('glab-mcp', 'scripts/validate_mcp_config.py'):
             '判定规则样本（第 59 行告警绝对路径 command）＋/Users/demo 合成夹具（第 106 行）',
             ('handoff', 'scripts/handoff_target.py'):
             '自测里的合成环境变量夹具（/Users/me/tmp）'}


def absent_field_evidence(cand, orig, field):
    """字段缺失时反查包内/祖先是否本就有可填的出处（判「有据未填」还是「登记无据」）。

    只在同一行里出现许可/署名措辞才算；候选值取自那行，不是从兄弟件抄。"""
    files = []
    for f in sorted(cand.iterdir()):
        if f.is_file() and f.name != 'SKILL.md' and (
                f.suffix.lower() in ('.md', '.txt', '.rst')
                or re.match(r'(?i)^(license|licence|copying|notice)', f.name)):
            files.append(f)
    cur = orig.parent.parent
    while str(cur).startswith(str(LIB)) and cur not in (LIB.parent, LIB):
        for f in sorted(cur.iterdir()):
            if f.is_file() and re.match(r'(?i)^(license|licence|copying|notice|readme)', f.name):
                files.append(f)
        cur = cur.parent
    LIC = r'\b(?P<val>MIT|Apache-?2\.0|BSD-?3-?Clause|GPL-?3|ISC|MPL-?2\.0|Unlicense)\b'
    LICW = r'(?:许可证|许可协议|License|Licensed under|SPDX)'
    # 署名只认明示措辞（作者:/Author:/Maintainer:/Written by/© 年 名），值须像名字（≤4 词、不含套话）
    NAME = r'(?P<val>[^\n，,;。（）|]{2,40})'
    AUTHW = r'(?:作者|署名|\bAuthors?\b|\bMaintainers?\b|Maintained by|Written by)'
    pats = ([(re.compile(rf'{LICW}[^\n]{{0,80}}{LIC}', re.I), 'val'),
             (re.compile(rf'{LIC}[^\n]{{0,60}}{LICW}', re.I), 'val')]
            if field == 'license' else
            [(re.compile(rf'{AUTHW}\s*[:：]\s*{NAME}'), 'val'),
             (re.compile(rf'©\s*\d{{4}}\s*{NAME}'), 'val')])
    BOILER = re.compile(r'(?i)permission|hereby|grant|warrant|liabilit|copyright|notice|'
                        r'term|condition|softwar|modify|redistribut|inspected|download|'
                        r'develop|account|section|this|these|\bthe\b|\ba\b')
    for f in files:
        text = f.read_text(errors='replace')
        for pat, gi in pats:
            for m in pat.finditer(text):
                val = re.sub(r'\s+', ' ', m.group(gi)).strip(' .,;:()-—')
                if not val or BOILER.search(val) or len(val.split()) > 4:
                    continue
                # 提取到的只是「候选值」，是否成立仍交 pkg_evidence 统一裁（含否定句防线）
                if not pkg_evidence(cand / 'SKILL.md', val, package_level=True, lineage=orig):
                    continue
                try:
                    label = str(f.relative_to(cand.parent))
                except ValueError:
                    label = '~/' + str(f.relative_to(LIB))
                return f'{label}#{val}'
    return None


def check(name, rel_path, cand_root, lib_root):
    rep = {'name': name, 'flags': []}
    cand = cand_root / f'{name}-gen1'
    orig = lib_root / rel_path
    if not cand.is_dir():
        rep['flags'].append('E0 candidate dir missing')
        return rep
    if not orig.is_file():
        rep['flags'].append(f'E0 library original missing: {rel_path}')
        return rep
    ctext = (cand / 'SKILL.md').read_text(encoding='utf-8', errors='replace')
    otext = orig.read_text(encoding='utf-8', errors='replace')
    cd, body_at = parse_fm(ctext)
    od, _ = parse_fm(otext)
    if cd is None:
        rep['flags'].append('E1 no/invalid frontmatter block')
        return rep
    if cd == 'ERR':
        rep['flags'].append('E1 YAML parse error in candidate frontmatter')
        return rep
    if not isinstance(cd, dict):
        rep['flags'].append('E1 frontmatter not a mapping')
        return rep
    if not isinstance(od, dict):
        rep['flags'].append('E1 library original frontmatter unparseable')
        return rep
    if cd.get('name') != od.get('name'):
        rep['flags'].append(f"E1 name changed: {od.get('name')!r} -> {cd.get('name')!r}")
    # E2 upstream values preserved
    for k in FIELDS:
        ov = od.get(k)
        cv = cd.get(k)
        if ov is not None:
            if cv is None:
                rep['flags'].append(f'E2 upstream {k} deleted')
            elif str(cv) != str(ov):
                rep['flags'].append(f'E2 upstream {k} rewritten: {str(ov)[:40]!r} -> {str(cv)[:40]!r}')
        elif cv is not None:
            # E3 new value must have provenance：包内看候选自己那一层，祖先看库内来路链
            ev = pkg_evidence(cand / 'SKILL.md', str(cv), package_level=True, lineage=orig)
            if not ev:
                rep['flags'].append(f'E3 new {k} without evidence: {str(cv)[:40]!r}')
        else:
            # E5 上游与本批都没有该字段：反查是否「有据未填」，无据则登记（写回时不落字段）
            ev = absent_field_evidence(cand, orig, k)
            if ev:
                rep['flags'].append(f'E5 有据未填 {k}: {ev}')
            else:
                rep.setdefault('no_evidence', []).append(k)
    # E6 顶层与 metadata 的同名字段不得互相矛盾（判者按 error 计过：顶层 version 1.0.0 vs metadata.version 1.2.0）
    md = cd.get('metadata')
    if isinstance(md, dict):
        for k in ('version', 'name', 'license'):
            if md.get(k) is not None and cd.get(k) is not None and str(md[k]) != str(cd[k]):
                rep['flags'].append(f'E6 {k} 冲突: 顶层={str(cd[k])!r} metadata={str(md[k])!r}')

    # E4 removal list vs library
    cfiles = set(files_under(cand))
    ofiles = set(files_under(orig.parent))
    removed = sorted(p for p in ofiles if p not in cfiles)
    if removed:
        rep['removed'] = removed
    # S1..S3
    nul = [f for f in cfiles if (cand / f).read_bytes().count(b'\x00')]
    if nul:
        rep['flags'].append('S1 NUL bytes: ' + ','.join(nul[:4]))
    abs_hits = []
    py = []
    for f in cfiles:
        if f.endswith('.pyc') or '__pycache__/' in f:
            py.append(f)
            continue
        if os.path.splitext(f)[1] in DOC_EXT or f.endswith('.md'):
            t = (cand / f).read_text(encoding='utf-8', errors='replace')
            op = orig.parent / f
            if '/Users/' in t and (name, f) not in S2_EXEMPT and not (
                    op.is_file() and '/Users/' in
                    op.read_text(encoding='utf-8', errors='replace')):
                abs_hits.append(f)
    if py:
        rep['flags'].append('S3 build artifacts: ' + ','.join(py[:4]))
    if abs_hits:
        rep['flags'].append('S2 machine paths: ' + ','.join(abs_hits[:4]))
    # S4 引用完整性：扫全包文本件（不只 SKILL.md），按「同目录 → 包根 → scripts/ → references/」解析
    TOK = re.compile(r'`([\w./-]+\.(?:md|json|py|js|ts|sh|txt|yaml|yml|csv))`')
    # Markdown 链接目标也要扫：判者在 r1585 报的 error 级断链正是 [x](references/y.md) 形制，只扫反引号会漏
    LINK = re.compile(r'\]\(([^)\s#]+)\)')
    miss = []
    for f in (x for x in cfiles if os.path.splitext(x)[1] in DOC_EXT or x.endswith('.md')):
        txt = (cand / f).read_text(encoding='utf-8', errors='replace')
        holder = (cand / f).parent
        toks = set(TOK.findall(txt)) | {m for m in LINK.findall(txt)
                                       if os.path.splitext(m)[1].lstrip('.') in
                                       {e[1:] for e in DOC_EXT}}
        for tok in toks:
            if tok.startswith(('http', '/')):
                continue
            if (name, tok) in S4_EXEMPT:
                continue
            dotted = tok.replace('.', '/', 1) if tok.endswith('.py') else None
            paths = [holder / tok, cand / tok, cand / 'scripts' / tok, cand / 'references' / tok]
            if dotted:
                paths.append(cand / dotted)
            if any(p.exists() for p in paths):
                continue
            # 裸文件名允许在包内任意子目录落地（正文常写「X/ 下的 a.md、b.md」）
            if '/' not in tok and any(True for _ in cand.rglob(tok)):
                continue
            if tok in otext:
                rep.setdefault('s4_upstream', []).append(f'{f}→{tok}')  # 上游既存，单独记账不混进本批缺陷
                continue
            if tok in removed or os.path.basename(tok) in removed:
                # 被判者点名移除的件在「未做的事/登记」散文里被提及，不是活引用
                rep.setdefault('s4_removal_prose', []).append(f'{f}→{tok}')
                continue
            miss.append(f'{f}→{tok}')
    if miss:
        rep['flags'].append('S4 referenced-but-missing: ' + ','.join(sorted(miss)[:6]))
    rep['files'] = len(cfiles)
    return rep


def self_test(sel):
    """负控电池：把每类缺陷注入临时副本，确认对应判据会红；未突变副本必须不红。

    副本落在仓内 scratch（跑完删除），绝不触碰 candidates/ 真身。"""
    import shutil

    by_name = {it['name']: it for it in sel['items']}
    e2_name = e3_name = None
    for it in sel['items']:
        n = it['name']
        cand = CAND / f'{n}-gen1' / 'SKILL.md'
        orig = LIB / it['relPath']
        if not (cand.is_file() and orig.is_file()):
            continue
        cd, _ = parse_fm(cand.read_text(encoding='utf-8', errors='replace'))
        od, _ = parse_fm(orig.read_text(encoding='utf-8', errors='replace'))
        if not (isinstance(cd, dict) and isinstance(od, dict)):
            continue
        if e2_name is None and od.get('license') is not None:
            e2_name = n
        if e3_name is None and od.get('license') is None and cd.get('license') is not None:
            e3_name = n
        if e2_name and e3_name:
            break
    if not (e2_name and e3_name):
        print(f'SELF-TEST SKIP: 找不到样本件 e2={e2_name} e3={e3_name}')
        return 2

    scratch = _here / f'.sweep-selftest-scratch'
    base_rep = {}

    def fresh(name):
        d = scratch / name
        if d.exists():
            shutil.rmtree(d)
        d.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(CAND / f'{name}-gen1', d / f'{name}-gen1')
        return d

    def run(name, root):
        return check(name, by_name[name]['relPath'], root, LIB)

    def sk(root, name):
        return root / f'{name}-gen1' / 'SKILL.md'

    cases = []

    root = fresh(e2_name)
    base_rep[e2_name] = run(e2_name, root)
    t = sk(root, e2_name).read_text(encoding='utf-8')
    line = next(l for l in t.split('\n') if re.match(r'^license:', l))
    sk(root, e2_name).write_text(t.replace(line + '\n', '', 1), encoding='utf-8')
    cases.append(('E2a 删上游 license', e2_name, run(e2_name, root), 'E2 upstream license deleted'))

    root = fresh(e2_name)
    t = sk(root, e2_name).read_text(encoding='utf-8')
    line = next(l for l in t.split('\n') if re.match(r'^license:', l))
    sk(root, e2_name).write_text(t.replace(line, 'license: BSD-3-Clause', 1), encoding='utf-8')
    cases.append(('E2b 改上游 license 值', e2_name, run(e2_name, root), 'E2 upstream license rewritten'))

    root = fresh(e3_name)
    t = sk(root, e3_name).read_text(encoding='utf-8')
    line = next(l for l in t.split('\n') if re.match(r'^license:', l))
    # 整行替换而不是插入重键：YAML 后键胜出，插入会让突变静默失效
    sk(root, e3_name).write_text(t.replace(line, 'license: Apache-2.0', 1), encoding='utf-8')
    cases.append(('E3 无据新增 license', e3_name, run(e3_name, root), 'E3 new license without evidence'))

    root = fresh(e2_name)
    t = sk(root, e2_name).read_text(encoding='utf-8')
    line = next(l for l in t.split('\n') if re.match(r'^name:', l))
    sk(root, e2_name).write_text(t.replace(line, 'name: totally-other', 1), encoding='utf-8')
    cases.append(('E1b name 被改', e2_name, run(e2_name, root), 'E1 name changed'))

    root = fresh(e2_name)
    t = sk(root, e2_name).read_text(encoding='utf-8')
    sk(root, e2_name).write_text(t.replace('---\n', '---\nbroken: [unclosed\n', 1), encoding='utf-8')
    cases.append(('E1a frontmatter YAML 崩坏', e2_name, run(e2_name, root), 'E1 YAML parse error'))

    root = fresh(e2_name)
    (root / f'{e2_name}-gen1' / 'scripts').mkdir(exist_ok=True)
    (root / f'{e2_name}-gen1' / 'scripts' / 'nulfile.py').write_bytes(b'x = 1\x00\x00\n')
    cases.append(('S1 NUL 字节', e2_name, run(e2_name, root), 'S1 NUL bytes'))

    root = fresh(e2_name)
    d = root / f'{e2_name}-gen1' / 'scripts' / '__pycache__'
    d.mkdir(parents=True, exist_ok=True)
    (d / 'sync.cpython-314.pyc').write_bytes(b'\x00\x0d\x0d\n')
    cases.append(('S3 构建产物残留', e2_name, run(e2_name, root), 'S3 build artifacts'))

    root = fresh(e2_name)
    (root / f'{e2_name}-gen1' / 'notes.md').write_text('见 `references/not-there-at-all.md`\n',
                                                       encoding='utf-8')
    cases.append(('S4 引用缺件（反引号形制）', e2_name, run(e2_name, root), 'S4 referenced-but-missing'))

    # Markdown 链接形制的断链（r1585 判者报的 error 就是这一形制）＋同文件里的合法链接不得误报
    root = fresh(e2_name)
    real = next((f for f in files_under(root / f'{e2_name}-gen1') if f != 'SKILL.md'
                 and os.path.splitext(f)[1] in DOC_EXT), 'SKILL.md')
    (root / f'{e2_name}-gen1' / 'zz-links.md').write_text(
        f'[断链](references/no-such-link.md)\n[合法链接]({real})\n', encoding='utf-8')
    rep = run(e2_name, root)
    s4 = [f for f in rep['flags'] if f.startswith('S4')]
    good = bool(s4) and 'references/no-such-link.md' in s4[0] and real not in s4[0]
    md_good = good
    md_msg = f"  {'CAUGHT ' if good else 'SURVIVED'} S4 断链（Markdown 链接形制，且合法链接不误报）→ {s4}"

    root = fresh(e2_name)
    (root / f'{e2_name}-gen1' / 'paths.md').write_text('/Users/somebody/else/thing\n', encoding='utf-8')
    cases.append(('S2 本机绝对路径', e2_name, run(e2_name, root), 'S2 machine paths'))

    # E6 样本必须同时具备顶层 version 与 metadata.version，否则突变碰不到判据（上一版就是这样假绿）
    e6_name = None
    for it in sel['items']:
        nn = it['name']
        pp = CAND / f'{nn}-gen1/SKILL.md'
        if not pp.is_file():
            continue
        dd, _ = parse_fm(pp.read_text(encoding='utf-8', errors='replace'))
        if isinstance(dd, dict) and isinstance(dd.get('metadata'), dict) \
           and dd['metadata'].get('version') is not None and dd.get('version') is not None:
            e6_name = nn
            break
    if e6_name is None:
        e6_msg = '  FAIL     E6 无样本（没有同时带顶层 version 与 metadata.version 的候选）'
        e6_good = False
    else:
        root = fresh(e6_name)
        t = sk(root, e6_name).read_text(encoding='utf-8')
        line = next(l for l in t.split('\n') if re.match(r'^version:', l))
        sk(root, e6_name).write_text(t.replace(line, 'version: 9.9.9', 1), encoding='utf-8')
        rep = run(e6_name, root)
        hit = any('E6 version 冲突' in f for f in rep['flags'])
        e6_good = hit
        e6_msg = (f"  {'CAUGHT ' if hit else 'SURVIVED'} E6 顶层 version 与 metadata.version 冲突"
                  f" [{e6_name}] → {[f for f in rep['flags'] if f.startswith('E6')]}")

    ok = True
    print(f'负控样本：E2/S 用 {e2_name}，E3 用 {e3_name}')
    for label, name, rep, expect in cases:
        hit = any(expect in f for f in rep['flags'])
        print(f"  {'CAUGHT ' if hit else 'SURVIVED'} {label} → {rep['flags'][:2]}")
        ok = ok and hit
    ok = ok and md_good and e6_good
    print(md_msg)
    print(e6_msg)

    # E5：字段缺失时，有出处就该填（注入包内 LICENSE），没出处就该登记（不判红）
    root = fresh(e3_name)
    t = sk(root, e3_name).read_text(encoding='utf-8')
    line = next(l for l in t.split('\n') if re.match(r'^license:', l))
    t2 = t.replace(line + '\n', '', 1)
    sk(root, e3_name).write_text(t2, encoding='utf-8')
    (root / f'{e3_name}-gen1' / 'LICENSE').write_text(
        'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n'
        '\n作者: Someone Elsename\n', encoding='utf-8')
    rep = run(e3_name, root)
    hits = [f for f in rep['flags'] if f.startswith('E5')]
    good = any('license' in h for h in hits) and any('author' in h for h in hits)
    print(f"  {'CAUGHT ' if good else 'SURVIVED'} E5 有据未填 license＋author（注入包内 LICENSE）→ {hits}")
    ok = ok and good

    root = fresh(e3_name)
    sk(root, e3_name).write_text(t2, encoding='utf-8')
    (root / f'{e3_name}-gen1' / 'LICENSE').write_text(
        'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n'
        'of this software... THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY.\n', encoding='utf-8')
    rep = run(e3_name, root)
    bad_author = [f for f in rep['flags'] if f.startswith('E5') and 'author' in f]
    good = not bad_author and 'author' in rep.get('no_evidence', [])
    print(f"  {'OK       ' if good else 'MISCLASS '} E5 署名不认许可套话 → {bad_author} "
          f"no_evidence={rep.get('no_evidence')}")
    ok = ok and good

    root = fresh(e3_name)
    sk(root, e3_name).write_text(t2, encoding='utf-8')
    rep = run(e3_name, root)
    good = (not [f for f in rep['flags'] if f.startswith('E5')]) and \
        set(['license', 'author']) <= set(rep.get('no_evidence', []))
    print(f"  {'OK       ' if good else 'MISCLASS '} E5 无据登记不判红 → flags={rep['flags'][:2]} "
          f"no_evidence={rep.get('no_evidence')}")
    ok = ok and good

    # 反向负控：被判者点名移除的件在散文里被提及，必须走「登记」而不是判红
    rev_name = None
    for it in sel['items']:
        n, cd = it['name'], CAND / f'{it["name"]}-gen1'
        if not cd.is_dir():
            continue
        shared = set(files_under(cd)) & set(files_under((LIB / it['relPath']).parent))
        if any(f != 'SKILL.md' and os.path.splitext(f)[1] in DOC_EXT for f in shared):
            rev_name = n
            break
    if rev_name is None:
        print('  FAIL     反向负控没有样本件（库内原件除 SKILL.md 外无可删的文本件）')
        ok = False
    else:
        root = fresh(rev_name)
        d = root / f'{rev_name}-gen1'
        shared = set(files_under(d)) & set(files_under((LIB / by_name[rev_name]['relPath']).parent))
        victim = next(f for f in sorted(shared) if f != 'SKILL.md'
                      and os.path.splitext(f)[1] in DOC_EXT)
        (d / victim).unlink()
        (d / 'zz-selftest-notes.md').write_text('按判者要求移除 `%s`，此处仅登记。\n' % victim,
                                                encoding='utf-8')
        rep = run(rev_name, root)
        s4 = [f for f in rep['flags'] if f.startswith('S4')]
        info = rep.get('s4_removal_prose', []) + rep.get('s4_upstream', [])
        good = not s4 and any(victim in i for i in info)
        print(f"  {'OK       ' if good else 'MISCLASS '} 移除件散文登记不判红 [{rev_name}] → {victim} "
              f"flags={s4} info={info}")
        ok = ok and good
    for name, rep in base_rep.items():
        clean = not rep['flags']
        print(f"  {'CONTROL-OK' if clean else 'CONTROL-NOISE'} 未突变副本 {name} → {rep['flags']}")
        ok = ok and clean
    shutil.rmtree(scratch, ignore_errors=True)
    print('SELF-TEST', 'PASS' if ok else 'FAIL')
    return 0 if ok else 1


def main():
    band = next((a[2:] for a in sys.argv if a.startswith('--lb')), None)
    if not band:
        print('usage: candidate-sweep.py --lbN [--names a,b]')
        return 2
    base = norm / f'lowband-{band}'
    sel = json.loads((base / 'selection.json').read_text(encoding='utf-8'))
    if '--self-test' in sys.argv:
        return self_test(sel)
    want = None
    if '--names' in sys.argv:
        want = set(sys.argv[sys.argv.index('--names') + 1].split(','))
    lib_root = LIB
    if '--lib-root' in sys.argv:
        lib_root = pathlib.Path(sys.argv[sys.argv.index('--lib-root') + 1])
    reps = [check(it['name'], it['relPath'], CAND, lib_root)
            for it in sel['items'] if not want or it['name'] in want]
    out = {'record_type': 'p2_candidate_sweep', 'scope': band, 'at': '2026-10-03',
           'caliber': 'E2/E3 用 license-provenance.pkg_evidence 两级取证（包内文件不含被写回的 SKILL.md 自身＋祖先 LICENSE/README，值须与许可/署名措辞同现）；'
                      '原件按 selection.relPath 定位，删除清单只列不改',
           'items': reps}
    # 带范围跑才覆盖带级报告；--names 子集跑另存，避免把局部读数当成全带终态（本带踩过一次）
    fname = 'sweep-report.json' if want is None else 'sweep-scoped.json'
    (base / fname).write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    out_path = base / fname
    dirty = [r for r in reps if r['flags']]
    print(f"items={len(reps)} clean={len(reps)-len(dirty)} flagged={len(dirty)} → {out_path.name}")
    for r in dirty:
        print(f"- {r['name']}: {'; '.join(r['flags'])}")
    return 1 if dirty else 0


if __name__ == '__main__':
    sys.exit(main())
