#!/usr/bin/env python3
"""ai-prompt-engineering-safety-review-gen1 静态校验（零请求）：genspark 族——修复双 frontmatter
与截断描述/补全 schema 字段/去 Roleplay 人格化改 SOP 工作流/负向边界/渐进式披露（checklist＋
report 模板）＋示例；带负控（12 突变各自判红，含 checklist 内容突变与文件删除）。"""
import re, shutil, sys, tempfile
from pathlib import Path
import yaml

BANNED = ['You are an expert AI prompt engineer', 'providing detailed im']


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
    if fm.get('name') != 'ai-prompt-engineering-safety-review':
        errs.append('name != ai-prompt-engineering-safety-review')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r312 error）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r312 error）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r312 error）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向（r312 warning）')
    # 单 frontmatter：正文不得再出现 frontmatter 块 / 截断残片
    if body.lstrip().startswith('---'):
        errs.append('重复 frontmatter 块（r312 error）')
    for ph in BANNED:
        if ph in text:
            errs.append(f'残留: {ph!r}（r312 error/warning）')
    # SOP 工作流
    if '## Workflow' not in body or '### Step 4' not in body:
        errs.append('缺 SOP 工作流四步（r312 error）')
    if '## When to Use / When NOT to Use' not in body:
        errs.append('缺 何时使用/何时不用（r312 warning）')
    # 渐进式披露 + 引用
    for rel in ('references/safety-checklist.md', 'references/report-template.md', 'examples/example-review.md'):
        if not (root / rel).is_file():
            errs.append(f'{rel} 缺失（r312 warning）')
        if rel not in body:
            errs.append(f'未被正文引用: {rel}')
    cl = root / 'references' / 'safety-checklist.md'
    if cl.is_file():
        c = cl.read_text(encoding='utf-8')
        for token in ('OWASP', 'DAN', 'Crescendo'):
            if token not in c:
                errs.append(f'checklist 缺具象检测基准: {token}（r312-r2 warning）')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/ai-prompt-engineering-safety-review-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': ('SKILL.md', lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1)),
        'drop-tags': ('SKILL.md', lambda t: t.replace('tags: [prompt-engineering, safety, bias, security, review]\n', '', 1)),
        'strip-compat': ('SKILL.md', lambda t: t.replace('compatibility: "任何具备文本分析能力', 'runtime-note: "任何具备文本分析能力', 1)),
        'strip-negative': ('SKILL.md', lambda t: t.replace('Do NOT use for ordinary text proofreading', 'Also fine for ordinary text proofreading', 1)),
        'dup-frontmatter': ('SKILL.md', lambda t: t.replace('# AI Prompt Engineering Safety Review & Improvement', '---\nname: dup\ndescription: providing detailed im\n---\n\n# AI Prompt Engineering Safety Review & Improvement', 1)),
        'restore-persona': ('SKILL.md', lambda t: t.replace('Audit a prompt for safety, bias, security, and effectiveness', 'You are an expert AI prompt engineer and safety specialist. Audit a prompt for safety, bias, security, and effectiveness', 1)),
        'drop-whennot': ('SKILL.md', lambda t: t.replace('## When to Use / When NOT to Use', '## 适用说明', 1)),
        'unref-checklist': ('SKILL.md', lambda t: t.replace('references/safety-checklist.md', '安全清单')),
        'checklist-unconcrete': ('checklist', lambda t: t.replace('OWASP', '（框架待定）').replace('DAN', '（模式A）').replace('Crescendo', '（模式B）')),
        'delete-report-tpl': None,
        'delete-example': 'EX',
        'drop-step4': ('SKILL.md', lambda t: t.replace('### Step 4: 输出报告与改进版', '## 结束', 1)),
    }
    with tempfile.TemporaryDirectory() as td:
        for name, spec in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-report-tpl':
                (dst / 'references' / 'report-template.md').unlink()
            elif name == 'delete-example':
                (dst / 'examples' / 'example-review.md').unlink()
            else:
                target, mutate = spec
                p = dst / ('SKILL.md' if target == 'SKILL.md' else 'references/safety-checklist.md')
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
