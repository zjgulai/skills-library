#!/usr/bin/env python3
"""contract-review-gen1 静态校验（零请求）：genspark 族——frontmatter 标准化（去 office-skill 私标）/
desc 负向/无悬空 knowledge 路径/工作流；v2（r374）：去人称化（禁 I'll/Tell me/Use me 等）/
metadata.author/desc 边界案例/references 拆分（risk-catalog＋四法域）并被引用/准据法守卫/tests 回归集；
带负控（13 突变各自判红，含文件删除突变）。"""
import re, shutil, sys, tempfile
from pathlib import Path
import yaml

BANNED_PHRASES = ["I'll ", "Tell me your role", "Use me iteratively", "Share Your Contract",
                  "How to Use Me", "**Me**"]


def validate(root: Path) -> list:
    errs = []
    sk = root / 'SKILL.md'
    if not sk.is_file():
        return ['SKILL.md 缺失']
    text = sk.read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1)); body = m.group(2)
    if fm.get('name') != 'contract-review':
        errs.append('name != contract-review')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r361）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r361 error）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r361 error）')
    # v2：metadata.author
    meta = fm.get('metadata')
    if not (isinstance(meta, dict) and str(meta.get('author', '')).strip()):
        errs.append('metadata.author 缺失（r374-r1 warning）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向（r361）')
        if 'Boundary cases' not in desc:
            errs.append('description 缺边界案例（r374-r1/r2）')
    if 'mcp-servers/' in text:
        errs.append('残留悬空 knowledge 路径（r361-r2 error）')
    if 'CLAUDE OFFICE SKILL' in text:
        errs.append('残留私标元数据注释头（r361）')
    # v2：去人称化（面向用户的一/二人称指令）
    for ph in BANNED_PHRASES:
        if ph in text:
            errs.append(f'残留第一/二人称表述: {ph!r}（r374 error/warning）')
    if '## Workflow' not in body:
        errs.append('缺工作流（r361-r2）')
    # v2：准据法守卫
    if 'Governing law guard' not in body or 'Governing Law Unspecified' not in body:
        errs.append('缺准据法缺失/冲突守卫（r374-r2 info→硬项）')
    # v2：references 拆分 + 引用
    refs = {
        'references/risk-catalog.md': ['references/risk-catalog.md'],
        'references/jurisdictions/us.md': ['references/jurisdictions/us.md'],
        'references/jurisdictions/eu.md': ['references/jurisdictions/eu.md'],
        'references/jurisdictions/china.md': ['references/jurisdictions/china.md'],
        'references/jurisdictions/uk.md': ['references/jurisdictions/uk.md'],
    }
    for rel, needles in refs.items():
        p = root / rel
        if not p.is_file():
            errs.append(f'{rel} 缺失（r374-r1/r2 拆分）')
        for n in needles:
            if n not in body:
                errs.append(f'未被正文引用: {n}')
    # v2：tests 回归集
    for t in ('tests/fixtures/sample-ca-employment.txt', 'tests/eval-contract-review.yaml'):
        if not (root / t).is_file():
            errs.append(f'{t} 缺失（r374-r2）')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/contract-review-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': ('SKILL.md', lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1)),
        'drop-tags': ('SKILL.md', lambda t: t.replace('tags: [contract, legal, risk-analysis, review]\n', '', 1)),
        'strip-compat': ('SKILL.md', lambda t: t.replace('compatibility: "任何具备文本生成能力', 'runtime-note: "任何具备文本生成能力', 1)),
        'strip-negative': ('SKILL.md', lambda t: t.replace('Do NOT use for drafting entire contracts', 'Also fine for drafting entire contracts', 1)),
        'drop-author': ('SKILL.md', lambda t: t.replace('metadata:\n  author: "Claude Office Skills community"\n', '', 1)),
        'drop-boundary': ('SKILL.md', lambda t: t.replace('Boundary cases: clause-level', 'Additional scope: clause-level', 1)),
        'reintroduce-office': ('SKILL.md', lambda t: t.replace('# Contract Review Skill', '# CLAUDE OFFICE SKILL', 1)),
        'drop-workflow': ('SKILL.md', lambda t: t.replace('## Workflow', '## 流程', 1)),
        'reintroduce-firstperson': ('SKILL.md', lambda t: t.replace('### Step 1: Input Validation', '### Step 1: Share Your Contract', 1)),
        'reintroduce-ill': ('SKILL.md', lambda t: t.replace('Compare the contract clause by clause', "I'll compare the contract clause by clause", 1)),
        'drop-law-guard': ('SKILL.md', lambda t: t.replace('Governing law guard', 'General note').replace('Governing Law Unspecified', '法域未标注')),
        'unref-catalog': ('SKILL.md', lambda t: t.replace('references/risk-catalog.md', '风险模式库')),
        'unref-jurisdictions': ('SKILL.md', lambda t: t.replace('references/jurisdictions/', '法域文件 ')),
        'delete-tests': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, spec in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-tests':
                (dst / 'tests' / 'eval-contract-review.yaml').unlink()
            else:
                target, mutate = spec
                p = dst / 'SKILL.md'
                t = p.read_text(encoding='utf-8')
                mutated = mutate(t)
                assert mutated != t, f'{name}: 突变未生效（锚点漂移）'
                p.write_text(mutated, encoding='utf-8')
            e2 = validate(dst)
            red = bool(e2)
            print(f"[负控 {name}] {'RED(期望)' if red else 'GREEN(异常!)'} {e2[:2]}")
            ok = ok and red
    sys.exit(0 if ok else 1)


main()
