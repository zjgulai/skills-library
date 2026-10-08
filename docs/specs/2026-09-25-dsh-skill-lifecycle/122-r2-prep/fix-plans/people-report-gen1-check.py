#!/usr/bin/env python3
"""people-report-gen1 静态校验（零请求）：genspark 族——去 GENSPARK ADAPTER/去 ../../CONNECTORS.md 与
~~ 伪标记/去 argument-hint/frontmatter 补齐/desc 负向（payroll/appraisal/ATS）/H1 统一/ Execution
Workflow 五步＋口径方法论（年化/Span/Flight Risk/PII）/connectors 拆分并被引用；负控 12 突变判红。"""
import re, shutil, sys, tempfile
from pathlib import Path
import yaml


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
    if fm.get('name') != 'people-report':
        errs.append('name != people-report')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r366 error）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex', 'medium'):
        errs.append('complexity 非法/缺失（r366 error）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    if not str(fm.get('author', '')).strip():
        errs.append('author 缺失（r366）')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r366 error）')
    if 'argument-hint' in fm:
        errs.append('argument-hint 非标字段残留（r366 error）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if 'Do NOT use' not in desc:
            errs.append('description 缺 Do NOT use 负向（r366 warning）')
    if 'GENSPARK ADAPTER' in text:
        errs.append('残留 GENSPARK ADAPTER（r366 error）')
    if 'gsk ' in text:
        errs.append('残留 gsk CLI 耦合（r366 error）')
    if 'CONNECTORS.md' in text or '../../' in body:
        errs.append('残留 ../../CONNECTORS.md 死链（r366 error）')
    if '~~' in text:
        errs.append('残留 ~~ 伪标记（r366 error）')
    if '# /people-report' in body:
        errs.append('H1 未统一（r366）')
    if '# People Report' not in body:
        errs.append('缺统一后的 H1')
    if '## Execution Workflow' not in body:
        errs.append('缺 Execution Workflow（r366 warning）')
    for rel in ('references/metrics-methodology.md', 'references/connectors.md'):
        if not (root / rel).is_file():
            errs.append(f'{rel} 缺失（r366 warning）')
        if rel not in body:
            errs.append(f'未被正文引用: {rel}')
    mm = root / 'references' / 'metrics-methodology.md'
    if mm.is_file():
        c = mm.read_text(encoding='utf-8')
        for token in ('年化', 'Span of Control', 'Flight Risk', 'PII'):
            if token not in c:
                errs.append(f'口径方法论缺: {token}（r366 warning）')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/people-report-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    mutations = {
        'drop-version': ('SKILL.md', lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1)),
        'drop-complexity': ('SKILL.md', lambda t: t.replace('complexity: medium\nlicense:', 'license:', 1)),
        'strip-compat': ('SKILL.md', lambda t: t.replace('compatibility: "任何具备文本与表格数据处理能力', 'runtime-note: "任何具备文本与表格数据处理能力', 1)),
        'strip-negative': ('SKILL.md', lambda t: t.replace('Do NOT use for payroll processing', 'Also fine for payroll processing', 1)),
        'reintroduce-argument-hint': ('SKILL.md', lambda t: t.replace('name: people-report\n', 'name: people-report\nargument-hint: "<x>"\n', 1)),
        'restore-adapter': ('SKILL.md', lambda t: t.replace('# People Report', '<!-- GENSPARK ADAPTER (auto-injected) -->\n通过 `gsk mcp list` 配置\n\n# People Report', 1)),
        'reintroduce-connectors-link': ('SKILL.md', lambda t: t.replace('> 可选连接器（HRIS/聊天工具）使用准则见', '> [CONNECTORS.md](../../CONNECTORS.md)\n\n> 使用准则见', 1)),
        'reintroduce-tilde': ('SKILL.md', lambda t: t.replace('HRIS/聊天工具为可选连接器', '~~HRIS/~~chat 为可选连接器', 1)),
        'drop-workflow': ('SKILL.md', lambda t: t.replace('## Execution Workflow', '## 方式', 1)),
        'unref-methodology': ('SKILL.md', lambda t: t.replace('references/metrics-methodology.md', '口径文件')),
        'methodology-thin': ('methodology', lambda t: t.replace('年化', '周期转化').replace('Span of Control', '管理幅度').replace('Flight Risk', '流失风险').replace('PII', '敏感信息')),
        'delete-connectors': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, spec in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-connectors':
                (dst / 'references' / 'connectors.md').unlink()
            else:
                target, mutate = spec
                p = dst / ('SKILL.md' if target == 'SKILL.md' else 'references/metrics-methodology.md')
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
