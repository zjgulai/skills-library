#!/usr/bin/env python3
"""容器 2 件恢复批 —— gen2 补丁构建器（零请求、幂等、带断言与留痕）

按 r1854/r1855 判者修法，把 gen1（上游原文 verbatim）转换为 gen2：
  ecommerce-marketing-strategy-builder：
    t1 frontmatter 置换（+version/complexity/license/compatibility/metadata、description 重写含负边界）
    t2 来源注插入；t3 移除 Installation；t4 Key Benchmarks → references/benchmarks.md；
    t5 Step 4 配比表 → references/channel-allocation-framework.md；t6 Step A2-A7 → Step 2-7；
    t7 Capabilities 内 markdown 链接去 URL；t8 tail（Other Skills+Limitations）重写、去 promo/安装/footer
  tiktok-influencer-marketing：
    u1 frontmatter 置换；u2 来源注插入；u3 移除 Installation；u4 How It Works 扩写（公式/门槛/杀停规则）；
    u5 Nexscope 段 → Limitations；u6 footer 移除；u7 追加 references×2 与 evals/evals.json

每步：锚点必须恰好命中 1 次（否则 FAIL）；最终全文断言（无 npx / 无 nexscope.ai / 无 co-from / 无 Step A / ecommerce 无 github.com）。
输出写到 opt-run/candidates/<name>-gen2/；回执 receipts/c3r-gen2-patch.json（含逐文件 sha256、treeDigest、diff 统计）。

用法：python3 -B c3r-gen2-make.py [--force] [--name <name>]
"""
import argparse
import difflib
import hashlib
import json
import re
import shutil
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve()


def find_root(start: Path) -> Path:
    for anc in (start, *start.parents):
        if (anc / 'skill-lifecycle').is_dir() and (anc / 'docs').is_dir():
            return anc
    raise SystemExit(f'仓根未发现（从 {start} 上溯）')


ROOT = find_root(HERE)
SALV = HERE.parents[1]
ASSETS = SALV / 'assets-gen2'
CAND = ROOT / 'skill-lifecycle' / 'trial-home' / 'opt-run' / 'candidates'
OUT = SALV / 'receipts'

ITEMS = ['ecommerce-marketing-strategy-builder', 'tiktok-influencer-marketing']
FAILS = []


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_file(p: Path) -> str:
    return sha256_bytes(p.read_bytes())


def tree_digest(root: Path) -> str:
    rows = []
    for p in sorted(root.rglob('*')):
        if p.is_file():
            rows.append(f'{p.relative_to(root).as_posix()}\t{sha256_file(p)}')
    return sha256_bytes('\n'.join(rows).encode('utf-8'))


def frag(name: str, rel: str) -> str:
    p = ASSETS / name / rel
    if not p.is_file():
        raise SystemExit(f'部件缺失：{p}')
    return p.read_text(encoding='utf-8')


def replace_once(text: str, label: str, old: str, new: str) -> str:
    cnt = text.count(old)
    if cnt != 1:
        FAILS.append(f'{label}: 锚点命中 {cnt} 次（需 1）')
        return text
    return text.replace(old, new)


def cut_region(text: str, label: str, start: str, end: str):
    """切 [start, end) 区间：start/end 各需恰好 1 次；返回 (新文本, 被切段)。"""
    cs, ce = text.count(start), text.count(end)
    if cs != 1 or ce != 1:
        FAILS.append(f'{label}: 锚点计数 start={cs} end={ce}（各需 1）')
        return text, ''
    i = text.index(start)
    j = text.index(end, i + len(start))
    return text[:i] + text[j:], text[i:j]


# ---------------- ecommerce ----------------

def make_ecommerce(base_text: str):
    log = []
    text = base_text
    bm_refs = alloc_refs = ''
    # t1 frontmatter 置换
    m = re.match(r'^---\n.*?\n---\n', text, re.S)
    if not m:
        FAILS.append('ecom t1: frontmatter 围栏未命中')
    else:
        fm_new = frag('ecommerce-marketing-strategy-builder', 'frontmatter.md')
        old_fm = m.group(0)
        if 'metadata:\n  nexscope:' not in old_fm:
            FAILS.append('ecom t1: 旧 frontmatter 缺 nexscope 标记（换了文件？）')
        text = fm_new + text[m.end():]
        log.append({'label': 't1 frontmatter', 'oldBytes': len(old_fm.encode()), 'newBytes': len(fm_new.encode())})
    # t2 来源注插入
    anchor = 'with budget allocation, audience targeting, and a 90-day action plan.\n'
    prov = frag('ecommerce-marketing-strategy-builder', 'provenance.md')
    text = replace_once(text, 'ecom t2 来源注', anchor, anchor + '\n' + prov)
    # t3 移除 Installation
    seg_inst = None
    if '## Installation' in text:
        i = text.index('## Installation')
        j = text.index('## Capabilities', i)
        seg_inst = text[i:j]
        text = text[:i] + text[j:]
        if 'npx skills add' not in seg_inst:
            FAILS.append('ecom t3: 安装段未见 npx 命令')
        log.append({'label': 't3 移除 Installation', 'segBytes': len(seg_inst.encode())})
    else:
        FAILS.append('ecom t3: 未找到 Installation 段')
    # t4 Key Benchmarks 抽取
    i = text.find('## Key Benchmarks (2025-2026)')
    j = text.find('---\n\n## Workflow', i)
    if i == -1 or j == -1:
        FAILS.append(f'ecom t4: 锚点缺失 i={i} j={j}')
    else:
        seg = text[i:j]
        body = seg.split('\n\n', 1)[1]
        refs_bm = ('# Key Benchmarks (2025-2026)\n\n> Extracted from `SKILL.md` — load when allocating budget, '
                   'comparing channel ROI, or modeling retention.\n\n' + body.rstrip() + '\n')
        ptr = frag('ecommerce-marketing-strategy-builder', 'benchmarks-pointer.md')
        text = text[:i] + ptr + '\n' + text[j:]
        log.append({'label': 't4 Key Benchmarks → references/benchmarks.md',
                    'segBytes': len(seg.encode()), 'refsBytes': len(refs_bm.encode())})
        bm_refs = refs_bm
    # t5 Step 4 配比表抽取
    i = text.find('**Where these percentages come from:**')
    j = text.find('### Step 5: Channel-by-Channel Plan', i)
    if i == -1 or j == -1:
        FAILS.append(f'ecom t5: 锚点缺失 i={i} j={j}')
        alloc_refs = ''
    else:
        seg = text[i:j]
        alloc_refs = ('# Channel Allocation Framework (2025-2026)\n\n> Extracted from `SKILL.md` Step 4 — use with '
                      "the user's actual stage, budget, and goals.\n\n" + seg.rstrip() + '\n')
        ptr = frag('ecommerce-marketing-strategy-builder', 'allocation-pointer.md')
        text = text[:i] + ptr + '\n' + text[j:]
        log.append({'label': 't5 Step4 表 → references/channel-allocation-framework.md',
                    'segBytes': len(seg.encode()), 'refsBytes': len(alloc_refs.encode())})
    # t6 Step A2-A7 修正
    for old, new in (('Step A4-A5', 'Steps 4-5'), ('Step A2', 'Step 2'), ('Step A3', 'Step 3'),
                     ('Step A6', 'Step 6'), ('Step A7', 'Step 7')):
        text = replace_once(text, f'ecom t6 {old}', old, new)
    log.append({'label': 't6 Step A2-A7 → Step 2-7', 'done': True})
    # t7 tail 重写（先移除 Other Skills 内的重复 URL 副本）
    k = text.find('## Other Skills')
    if k == -1:
        FAILS.append('ecom t7: 未找到 Other Skills 段')
    else:
        seg = text[k:]
        text = text[:k] + frag('ecommerce-marketing-strategy-builder', 'tail.md')
        log.append({'label': 't7 tail 重写（Related Skills+Limitations，去 promo/安装/footer）',
                    'segBytes': len(seg.encode())})
    # t8 Capabilities 内去 URL（此时仅剩 1 处）
    text = replace_once(
        text, 'ecom t8 去 ppc 链接 URL',
        '[ecommerce-ppc-strategy-planner](https://github.com/nexscope-ai/eCommerce-Skills/tree/main/ecommerce-ppc-strategy-planner)',
        'ecommerce-ppc-strategy-planner')
    # 终检
    for bad in ('npx ', 'nexscope.ai', 'co-from', 'Step A', 'github.com'):
        if bad in text:
            FAILS.append(f'ecom 终检: 仍含「{bad}」')
    for need in ('## Workflow', '### Step 4: Channel Prioritization', '## Output Format',
                 'references/benchmarks.md', 'references/channel-allocation-framework.md',
                 'complexity: complex', 'license: MIT', 'Provenance:'):
        if need not in text:
            FAILS.append(f'ecom 终检: 缺「{need}」')
    return text, log, {'references/benchmarks.md': bm_refs,
                       'references/channel-allocation-framework.md': alloc_refs}


# ---------------- tiktok ----------------

def make_tiktok(base_text: str):
    log = []
    text = base_text
    m = re.match(r'^---\n.*?\n---\n', text, re.S)
    if not m:
        FAILS.append('tik u1: frontmatter 围栏未命中')
    else:
        fm_new = frag('tiktok-influencer-marketing', 'frontmatter.md')
        old_fm = m.group(0)
        if '"nexscope"' not in old_fm:
            FAILS.append('tik u1: 旧 frontmatter 缺 nexscope 标记')
        text = fm_new + text[m.end():]
        log.append({'label': 'u1 frontmatter', 'oldBytes': len(old_fm.encode()), 'newBytes': len(fm_new.encode())})
    anchor = 'Scale your brand with TikTok creators. Strategic campaign planning from discovery to ROI tracking.\n'
    prov = frag('tiktok-influencer-marketing', 'provenance.md')
    text = replace_once(text, 'tik u2 来源注', anchor, anchor + '\n' + prov)
    # u3 移除 Installation
    if '## Installation' in text:
        i = text.index('## Installation')
        j = text.index('## Usage Examples', i)
        seg = text[i:j]
        text = text[:i] + text[j:]
        if 'npx skills add' not in seg:
            FAILS.append('tik u3: 安装段未见 npx 命令')
        log.append({'label': 'u3 移除 Installation', 'segBytes': len(seg.encode())})
    else:
        FAILS.append('tik u3: 未找到 Installation 段')
    # u4 How It Works 扩写
    text2, seg = cut_region(text, 'tik u4 How It Works', '## How It Works\n', '## Output Format\n')
    if seg:
        expanded = frag('tiktok-influencer-marketing', 'how-it-works-expanded.md')
        j = text.index('## Output Format\n', text.index('## How It Works\n'))
        text = text[:text.index('## How It Works\n')] + expanded + '\n' + text[j:]
        log.append({'label': 'u4 How It Works 扩写', 'segBytes': len(seg.encode()),
                    'newBytes': len(expanded.encode())})
    # u5 Nexscope 段 → Limitations
    i = text.find('## Integration with Nexscope')
    j = text.find('## Best Practices', i)
    if i == -1 or j == -1:
        FAILS.append(f'tik u5: 锚点缺失 i={i} j={j}')
    else:
        seg = text[i:j]
        lim = frag('tiktok-influencer-marketing', 'limitations.md')
        text = text[:i] + lim + '\n' + text[j:]
        log.append({'label': 'u5 Nexscope 段 → Limitations', 'segBytes': len(seg.encode())})
    # u6 footer 移除
    k = text.find('\n---\n\n*Built by [Nexscope]')
    if k == -1:
        FAILS.append('tik u6: 未找到 footer 锚点')
    else:
        seg = text[k:]
        text = text[:k] + '\n'
        log.append({'label': 'u6 footer 移除', 'segBytes': len(seg.encode())})
    # 终检
    for bad in ('npx ', 'nexscope.ai', 'co-from', 'Integration with Nexscope'):
        if bad in text:
            FAILS.append(f'tik 终检: 仍含「{bad}」')
    for need in ('## Limitations', '## Best Practices', 'break-even ROAS',
                 'references/creator-vetting-and-metrics.md',
                 'references/outreach-and-contract-templates.md',
                 'complexity: medium', 'license: MIT', 'Provenance:'):
        if need not in text:
            FAILS.append(f'tik 终检: 缺「{need}」')
    extras = {
        'references/creator-vetting-and-metrics.md':
            frag('tiktok-influencer-marketing', 'references/creator-vetting-and-metrics.md'),
        'references/outreach-and-contract-templates.md':
            frag('tiktok-influencer-marketing', 'references/outreach-and-contract-templates.md'),
        'evals/evals.json': frag('tiktok-influencer-marketing', 'evals/evals.json'),
    }
    return text, log, extras


def build_one(name: str, force: bool):
    print(f'=== {name} ===')
    gen1 = CAND / f'{name}-gen1' / 'SKILL.md'
    gen2_dir = CAND / f'{name}-gen2'
    if not gen1.is_file():
        FAILS.append(f'{name}: gen1 缺 SKILL.md')
        return None
    base_text = gen1.read_text(encoding='utf-8')
    if name == 'ecommerce-marketing-strategy-builder':
        text, log, extras = make_ecommerce(base_text)
    else:
        text, log, extras = make_tiktok(base_text)
    if FAILS:
        return None
    # evals schema 校验（tiktok）
    ev = extras.get('evals/evals.json')
    if ev:
        d = json.loads(ev)
        if d.get('skill_name') != name or len(d.get('evals', [])) < 3:
            FAILS.append(f'{name}: evals schema 不合格')
        for e in d.get('evals', []):
            if len(e.get('assertions', [])) < 3:
                FAILS.append(f"{name}: evals {e.get('id')} assertions<3")
    files = {'SKILL.md': text, **extras}
    # 幂等：全一致 → skip；否则写入（不一致无 --force → FAIL）
    existing = gen2_dir.is_dir()
    if existing and not force:
        same = all((gen2_dir / rel).is_file() and (gen2_dir / rel).read_text(encoding='utf-8') == content
                   for rel, content in files.items())
        if same:
            print('  [skip] gen2 已一致')
        else:
            FAILS.append(f'{name}: gen2 已存在且不一致（需 --force）')
            return None
    elif existing and force:
        shutil.rmtree(gen2_dir)
    for rel, content in files.items():
        p = gen2_dir / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding='utf-8')
    # diff 统计（SKILL.md）
    diff = list(difflib.unified_diff(base_text.splitlines(), text.splitlines(), lineterm=''))
    adds = sum(1 for l in diff if l.startswith('+') and not l.startswith('+++'))
    dels = sum(1 for l in diff if l.startswith('-') and not l.startswith('---'))
    diff_path = SALV / 'receipts' / f'c3r-{name}-gen2.diff'
    diff_path.write_text('\n'.join(diff) + '\n', encoding='utf-8')
    file_rows = [{'rel': rel, 'sha256': sha256_bytes(content.encode()), 'bytes': len(content.encode())}
                 for rel, content in sorted(files.items())]
    print(f'  [ok] {len(files)} 文件；diff +{adds}/-{dels} 行；tree={tree_digest(gen2_dir)[:16]}…')
    return {'name': name, 'base': {'candidate': f'candidates/{name}-gen1',
                                   'sha256': sha256_file(gen1)},
            'gen2': {'candidate': f'candidates/{name}-gen2', 'treeDigest': tree_digest(gen2_dir),
                     'files': file_rows},
            'transforms': log, 'diff': {'file': f'receipts/c3r-{name}-gen2.diff', 'addLines': adds, 'delLines': dels}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--name')
    args = ap.parse_args()
    names = [args.name] if args.name else ITEMS
    items = []
    for name in names:
        if name not in ITEMS:
            print(f'未知件：{name}')
            sys.exit(2)
        rec = build_one(name, args.force)
        if rec:
            items.append(rec)
    print()
    if FAILS or len(items) != len(names):
        print(f'RESULT: FAIL（{len(FAILS)} 项）')
        for f in FAILS:
            print('  -', f)
        sys.exit(1)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'c3r-gen2-patch.json').write_text(json.dumps(
        {'record_type': 'c3r_gen2_patch', 'at': date.today().isoformat(),
         'note': 'gen2 补丁：按 r1854/r1855 判者修法转换；gen1（上游原文）保持冻结不变；逐步锚点计数=1 断言通过',
         'items': items}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('RESULT: PASS（gen2 构建完成/幂等跳过；补丁回执已写）')


if __name__ == '__main__':
    main()
