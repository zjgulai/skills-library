#!/usr/bin/env python3
"""dataset-health-audit-gen1 静态校验（零请求）：kimi 工具族——frontmatter 全套/desc 何时不用/
H1 统一/Agent 执行工作流/脚本被引用；v2（r346）：依赖声明与三方库对齐（pandas/numpy 非仅标准库）/
--date-columns 实装（脚本消费而非死参数）/异常与错误应对/安全与资源边界/tests 自检样例/
规则渐进式披露 references；带负控（16 突变各自判红，含脚本侧突变）。"""
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
    if fm.get('name') != 'dataset-health-audit':
        errs.append('name != dataset-health-audit')
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(fm.get('version', ''))):
        errs.append('version 非 semver（r333 error）')
    if fm.get('complexity') not in ('minimal', 'standard', 'complex'):
        errs.append('complexity 非法/缺失（r333 error）')
    if not str(fm.get('license', '')).strip():
        errs.append('license 缺失')
    tags = fm.get('tags')
    if not (isinstance(tags, list) and tags and all(isinstance(t, str) and t.strip() for t in tags)):
        errs.append('tags 缺失/空（r333-r1）')
    compat = fm.get('compatibility')
    if not (isinstance(compat, str) and compat.strip()):
        errs.append('compatibility 缺失（r333 error）')
    else:
        # v2：依赖声明必须与脚本真实依赖（pandas/numpy）对齐
        if 'pandas' not in compat or '仅标准库' in compat:
            errs.append('compatibility 未与三方依赖对齐（r346-r1/r2 error）')
    desc = fm.get('description', '')
    if not isinstance(desc, str):
        errs.append('description 非字符串')
    else:
        if not (150 <= len(desc) <= 500):
            errs.append(f'description 长度越界（150-500）: {len(desc)}')
        if '何时不用' not in desc:
            errs.append('description 缺「何时不用」负向（r333-r1/r2）')
        if '边界情况' not in desc:
            errs.append('description 缺边界情况声明（r346-r1/r2）')
    if '# data-quality-checker' in text:
        errs.append('H1 命名不一致（data-quality-checker）')
    if '# Dataset Health Audit' not in body:
        errs.append('缺统一后的 H1')
    if '## Agent 执行工作流' not in body:
        errs.append('缺 Agent 执行工作流（r333 warning）')
    if '人机协作提示' not in body:
        errs.append('缺人机协作提示步')
    # v2：异常与错误应对
    if '异常与错误应对' not in body or 'ModuleNotFoundError' not in body:
        errs.append('缺异常与错误应对（r346-r1/r2）')
    # v2：安全与资源边界
    if '## 安全与资源边界' not in body:
        errs.append('缺安全与资源边界节（r346-r2）')
    if '--sample' not in body:
        errs.append('安全节缺大文件采样指引')
    sp = root / 'scripts' / 'data_quality_checker.py'
    if not (sp.is_file() and sp.stat().st_size > 0):
        errs.append('scripts/data_quality_checker.py 缺失')
    else:
        src = sp.read_text(encoding='utf-8')
        # v2：--date-columns 必须被真实消费（非死参数）
        if 'date_columns=date_cols' not in src or 'date:explicit' not in src:
            errs.append('--date-columns 未实装消费（r346-r1 warning）')
    if 'data_quality_checker.py' not in body:
        errs.append('未被正文引用: data_quality_checker.py')
    # v2：tests 自检样例
    tp = root / 'tests' / 'sample_dirty.csv'
    if not tp.is_file():
        errs.append('tests/sample_dirty.csv 缺失（r346-r1/r2）')
    if 'tests/sample_dirty.csv' not in body:
        errs.append('未被正文引用: tests/sample_dirty.csv')
    # v2：规则渐进式披露
    rp = root / 'references' / 'rule-definitions.md'
    if not rp.is_file():
        errs.append('references/rule-definitions.md 缺失（r346-r2 info→硬项）')
    if 'references/rule-definitions.md' not in body:
        errs.append('未被正文引用: references/rule-definitions.md')
    return errs


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        'skill-lifecycle/trial-home/opt-run/candidates/dataset-health-audit-gen1')
    root = root.resolve()
    errs = validate(root)
    print(f"[candidate] {'PASS' if not errs else 'FAIL'} {root}")
    for e in errs:
        print('  -', e)
    ok = not errs
    # (目标, 突变)；'SKILL.md'/'script'/'tests'/'rules'；None=删除文件
    mutations = {
        'drop-version': ('SKILL.md', lambda t: t.replace('version: "1.0.0"\ncomplexity:', 'complexity:', 1)),
        'drop-tags': ('SKILL.md', lambda t: t.replace('tags: [data-quality, audit, data-profiling]\n', '', 1)),
        'strip-compat': ('SKILL.md', lambda t: t.replace('compatibility: "需要可执行 Python 3.8+ 且已安装', 'runtime-note: "需要可执行 Python 3.8+ 且已安装', 1)),
        'revert-compat-claim': ('SKILL.md', lambda t: t.replace('且已安装 pandas、numpy 的 agent 运行时', '的 agent 运行时（仅标准库）', 1)),
        'strip-negative': ('SKILL.md', lambda t: t.replace('何时不用：非结构化文本分析', '同样用于：非结构化文本分析', 1)),
        'drop-desc-boundary': ('SKILL.md', lambda t: t.replace('边界情况：超过 50MB', '补充：超过 50MB', 1)),
        'reintroduce-h1': ('SKILL.md', lambda t: t.replace('# Dataset Health Audit', '# data-quality-checker', 1)),
        'drop-workflow': ('SKILL.md', lambda t: t.replace('## Agent 执行工作流', '## 说明', 1)),
        'drop-step4': ('SKILL.md', lambda t: t.replace('人机协作提示', '补充说明')),
        'drop-error-handling': ('SKILL.md', lambda t: t.replace('异常与错误应对', '继续执行', 1).replace('ModuleNotFoundError', '依赖错误')),
        'drop-safety': ('SKILL.md', lambda t: t.replace('## 安全与资源边界', '## 补充说明', 1)),
        'unref-script': ('SKILL.md', lambda t: t.replace('data_quality_checker.py', '质检脚本')),
        'unwire-datecols': ('script', lambda t: t.replace('date_columns=date_cols', 'date_columns=None', 1).replace('date:explicit', 'date:auto')),
        'unref-tests': ('SKILL.md', lambda t: t.replace('tests/sample_dirty.csv', '样例数据文件')),
        'unref-rules': ('SKILL.md', lambda t: t.replace('references/rule-definitions.md', '规则文档')),
        'delete-script': None,
    }
    with tempfile.TemporaryDirectory() as td:
        for name, spec in mutations.items():
            dst = Path(td) / name
            shutil.copytree(root, dst)
            if name == 'delete-script':
                (dst / 'scripts' / 'data_quality_checker.py').unlink()
            elif name.startswith('drop-tests-file'):
                (dst / 'tests' / 'sample_dirty.csv').unlink()
            else:
                target, mutate = spec
                p = dst / ('SKILL.md' if target == 'SKILL.md' else 'scripts/data_quality_checker.py')
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
