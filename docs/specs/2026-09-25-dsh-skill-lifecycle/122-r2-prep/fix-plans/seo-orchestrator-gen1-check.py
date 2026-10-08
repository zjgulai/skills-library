#!/usr/bin/env python3
"""seo-orchestrator-gen1 静态校验（零请求）：

判据（对应 126 号判者意见 + 收尾修复策略）：
  A frontmatter 全套（name kebab / version semver / complexity / license MIT / compatibility /
    metadata.version+author）＋ desc 三段式（触发词/何时不用/安全边界，150-500）
  B 正文结构：执行工作流（五步）与安全边界 / 最小可执行示例 / INDEX 引用 / canonical_v1_5
  C 版本沿革与旧标识清扫（活动文件禁止 V1.4、1.5-candidate、旧名、orchestration_core、
    validate_v1_4、state_schema 等；history/、rule_fidelity_manifest.yaml、trace_schema.json 豁免）
  D 结构：history/ 四件归档、活动根无旧件、INDEX/history/examples 就位、20 模块头归一、
    7 份 yaml version=1.5.0、协议 profile 无 exact_fields/gate_order、modules/README 引用 INDEX
  E 最小示例经包内 validate_v1_5_architecture.py 判定 PASS（子进程，需 venv python）
  F 全包 .md 链接不越出包根（相对链接可达且不逃逸）
负控：13 个突变必须各自判红。

用法：python3 -B seo-orchestrator-gen1-check.py <candidate_root> [--python <venv_python>]
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
from pathlib import Path

import yaml

VERSION_FILES = ['evaluation_policy.yaml', 'ownership_registry.yaml', 'runtime_invariants.yaml',
                 'router.yaml', 'module_identity_registry.yaml', 'canonical_trace_contract.yaml',
                 'minimal_execution_protocol.yaml']
ARCHIVED = ['ORCHESTRATION_CORE.md', 'orchestration_core.yaml', 'state_schema.json',
            'validate_v1_4_architecture.py']
LABEL_PATTERNS = [r'V1\.4', r'1\.5-candidate', r'seo-skill-v1-5-candidate',
                  r'orchestration_core', r'validate_v1_4', r'state_schema', r'skill-zyx']
LABEL_EXEMPT = {'references/rule_fidelity_manifest.yaml', 'trace_schema.json'}


def validate(root: Path, venv_python: str) -> list:
    errs = []

    # ---- A：frontmatter ----
    text = (root / 'SKILL.md').read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return ['SKILL.md frontmatter 缺失或围栏不规范']
    fm = yaml.safe_load(m.group(1))
    body = m.group(2)
    if fm.get('name') != 'seo-orchestrator':
        errs.append(f'name 不是 seo-orchestrator: {fm.get("name")}')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失')
    if fm.get('license') != 'MIT':
        errs.append('license 非 MIT')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失/非字符串')
    meta = fm.get('metadata') or {}
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(meta.get('version', ''))):
        errs.append('metadata.version 缺失/非 semver')
    if not (isinstance(meta.get('author'), str) and meta['author'].strip()):
        errs.append('metadata.author 缺失')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        for marker in ['触发词', '何时不用', '安全边界']:
            if marker not in desc:
                errs.append(f'description 缺 {marker}')

    # ---- B：正文结构 ----
    first_line = next((ln for ln in body.splitlines() if ln.strip()), '')
    if first_line.strip() != '# SEO Orchestrator':
        errs.append(f'首行 H1 非 "# SEO Orchestrator": {first_line[:40]}')
    if '## 执行工作流（五步）' not in body:
        errs.append('缺 "## 执行工作流（五步）"')
    for step in ['**需求分类**', '**动态加载模块**', '**证据核查与决策**', '**Handoff 与验证**', '**结构化交付**']:
        if step not in body:
            errs.append(f'执行工作流缺步骤 {step}')
    if '## 安全边界' not in body:
        errs.append('缺 "## 安全边界"')
    if '## 最小可执行示例' not in body:
        errs.append('缺 "## 最小可执行示例"')
    if 'INDEX.md' not in body:
        errs.append('正文未引用 INDEX.md')
    if 'canonical_v1_5' not in body:
        errs.append('正文缺 canonical_v1_5 profile 声明')

    # ---- C：版本沿革与旧标识清扫 ----
    for p in sorted(root.rglob('*')):
        if not p.is_file():
            continue
        rel = str(p.relative_to(root))
        if rel.startswith('history/') or rel in LABEL_EXEMPT:
            continue
        if p.suffix.lower() not in ('.md', '.yaml', '.yml', '.json', '.py', '.txt'):
            continue
        content = p.read_text(encoding='utf-8', errors='replace')
        for pat in LABEL_PATTERNS:
            if re.search(pat, content, re.I):
                errs.append(f'活动文件残留旧标识 {pat}: {rel}')
    for rel in ARCHIVED[:3]:
        if (root / rel).exists():
            errs.append(f'活动根残留旧件: {rel}')

    # ---- D：结构 ----
    for rel in ARCHIVED:
        if not (root / 'history' / Path(rel).name).is_file():
            errs.append(f'history/ 缺归档件: {rel}')
    if (root / 'validators' / 'validate_v1_4_architecture.py').exists():
        errs.append('validators/ 仍残留 validate_v1_4_architecture.py')
    if not (root / 'validators' / 'validate_minimal_trace.py').is_file():
        errs.append('validators/validate_minimal_trace.py 缺失')
    for rel in ['INDEX.md', 'history/README.md', 'examples/README.md',
                'examples/minimal-trace.json', 'examples/minimal-runtime-context.json']:
        if not (root / rel).is_file():
            errs.append(f'缺文件: {rel}')
    mods = sorted((root / 'modules').glob('*.md'))
    num_mods = [p for p in mods if re.match(r'^(0[1-9]|1[0-9]|20)', p.name)]
    if len(num_mods) != 20:
        errs.append(f'模块数异常: {len(num_mods)}')
    for p in num_mods:
        t = p.read_text(encoding='utf-8')
        if '【模块边界】' not in t or '【V1.4' in t:
            errs.append(f'模块头未归一: {p.name}')
    for rel in VERSION_FILES:
        s = yaml.safe_load((root / rel).read_text(encoding='utf-8'))
        if s.get('version') != '1.5.0':
            errs.append(f'{rel} version != 1.5.0: {s.get("version")!r}')
    proto = yaml.safe_load((root / 'minimal_execution_protocol.yaml').read_text(encoding='utf-8'))
    profile = proto['trace_profiles']['canonical_v1_5']
    if 'exact_fields' in profile or 'gate_order' in profile:
        errs.append('协议 profile 残留 exact_fields/gate_order（应为单一来源）')
    if not proto.get('version') == '1.5.0':
        errs.append('协议 version 异常')
    readme = (root / 'modules' / 'README.md').read_text(encoding='utf-8')
    if '../INDEX.md' not in readme:
        errs.append('modules/README.md 未引用 INDEX.md')

    # ---- E：最小示例过包内校验器 ----
    trace, ctx = root / 'examples/minimal-trace.json', root / 'examples/minimal-runtime-context.json'
    if trace.is_file() and ctx.is_file():
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / 'result.json'
            cmd = [venv_python, '-B', 'scripts/validate_v1_5_architecture.py',
                   '--trace', 'examples/minimal-trace.json', '--registry', 'ownership_registry.yaml',
                   '--runtime-context', 'examples/minimal-runtime-context.json',
                   '--trace-profile', 'canonical_v1_5', '--profile-source', 'examples/README.md',
                   '--output', str(out)]
            try:
                proc = subprocess.run(cmd, cwd=root, capture_output=True, text=True, timeout=120)
            except OSError as exc:
                errs.append(f'校验器无法启动（venv python 缺失？）: {exc}')
            else:
                if out.is_file():
                    res = json.loads(out.read_text(encoding='utf-8'))
                    if res.get('status') != 'PASS':
                        errs.append(f'最小示例校验非 PASS: {res.get("status")} {res.get("reject_codes")}')
                else:
                    errs.append(f'校验器无输出（rc={proc.returncode}）: {proc.stderr.strip()[:120]}')

    # ---- F：链接不越界 ----
    for p in sorted(root.rglob('*.md')):
        content = p.read_text(encoding='utf-8', errors='replace')
        for mm in re.finditer(r'\]\(([^)\s]+)\)', content):
            target = mm.group(1)
            if target.startswith(('http://', 'https://', 'mailto:', '#')):
                continue
            t = urllib.parse.unquote(target.split('#')[0])
            if not t:
                continue
            resolved = (p.parent / t).resolve()
            try:
                resolved.relative_to(root.resolve())
            except ValueError:
                errs.append(f'链接越出包根: {p.relative_to(root)} -> {target}')
                continue
            if not resolved.exists():
                errs.append(f'链接不可达: {p.relative_to(root)} -> {target}')
    return errs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', nargs='?', default='skill-lifecycle/trial-home/opt-run/candidates/seo-orchestrator-gen1')
    parser.add_argument('--python', default='skill-lifecycle/trial-home/control/venv/bin/python')
    args = parser.parse_args()
    root = Path(args.root).resolve()
    # 注意：venv 的 python 是符号链接；不可 resolve()（会解析成系统 python 丢 venv），
    # 只做 abspath 归一（同族教训：/tmp realpath —— 此处方向相反）。
    venv_python = args.python if Path(args.python).is_absolute() else str(Path.cwd() / args.python)

    errs = validate(root, venv_python)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs

    mutations = {
        'desc-drop-negative': ('SKILL.md', lambda t: t.replace('何时不用：', '何时使用：', 1)),
        'desc-too-long': ('SKILL.md', lambda t: t.replace('不直接输出方案。', '不直接输出方案。' + '补充说明' * 50, 1)),
        'strip-license': ('SKILL.md', lambda t: t.replace('license: "MIT"\n', '', 1)),
        'strip-author': ('SKILL.md', lambda t: t.replace('  author: "internal"\n', '', 1)),
        'version-drift': ('module_identity_registry.yaml', lambda t: t.replace("version: '1.5.0'", "version: '1.5'", 1)),
        'v14-header-back': ('modules/01｜SEO 基线诊断与分流.md', lambda t: t.replace('【模块边界】', '【V1.4.1 模块边界】', 1)),
        'archive-leak': ('history/ORCHESTRATION_CORE.md', lambda t: None),  # 特判：复制回根
        'orphan-index': ('INDEX.md', lambda t: None),  # 特判：删除
        'dead-link-back': ('references/来源与模块映射索引.md', lambda t: t.replace(
            '（`V1_5_RULE_FIDELITY_AUDIT_RESULTS.json`，未随本包分发）', '见[审计结果](../../evidence/results/x.json)', 1)),
        'broken-example': ('examples/minimal-trace.json', lambda t: t.replace('"to": "08"', '"to": "09"', 1)),
        'candidate-name-leak': ('INDEX.md', lambda t: t.replace('# SEO Orchestrator 索引', '# SEO Orchestrator 索引（seo-skill-v1-5-candidate）', 1)),
        'protocol-dedupe-undo': ('minimal_execution_protocol.yaml', lambda t: t.replace(
            '    rules:\n      - Use exact fields', '    exact_fields:\n      Plan: [primary_route]\n    rules:\n      - Use exact fields', 1)),
        'meta-version-drop': ('SKILL.md', lambda t: t.replace('metadata:\n  version: "1.5.0"', 'metadata:\n  meta: "1.5.0"', 1)),
    }
    with tempfile.TemporaryDirectory() as td:
        for name, (rel, mutate) in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst, ignore=shutil.ignore_patterns('control'))
            p = dst / rel
            if name == 'archive-leak':
                shutil.copy2(dst / 'history' / 'ORCHESTRATION_CORE.md', dst / 'ORCHESTRATION_CORE.md')
            elif name == 'orphan-index':
                p.unlink()
            else:
                t = p.read_text(encoding='utf-8')
                mutated = mutate(t)
                assert mutated is not None and mutated != t, f'{name}: 突变未生效（锚点漂移）'
                p.write_text(mutated, encoding='utf-8')
            e2 = validate(dst, venv_python)
            red = bool(e2)
            print(f"[负控 {name}] {'RED(期望)' if red else 'GREEN(异常!)'} {e2[:2]}")
            ok = ok and red
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
