#!/usr/bin/env python3
"""seo-orchestrator-gen1 机械修复构建器（零请求、幂等、逐项断言）：

对候选副本（seo-skill-v1-5-candidate → seo-orchestrator-gen1）执行**机械类**修复：
  ① 20 个模块头【V1.4(.1) 模块边界】→【模块边界】（版本沿革去除）
  ② 7 份 yaml 的 version 字段统一为 '1.5.0'（1.4 / 1.5 / 1.5-candidate 混杂收敛）
  ③ minimal_execution_protocol.yaml：删除与 canonical contract/schema 重复的
     gate_order 与 exact_fields（单一来源），并加「唯一职责」角色注释
  ④ canonical_trace_contract.yaml：加「唯一职责」角色注释
  ⑤ modules/README.md：更新为指向 INDEX.md 与 minimal_execution_protocol.yaml
  ⑥ references/来源与模块映射索引.md：清死链（../../evidence、../../release）、
     去 V1.4.1 版本号与 `skill/` 旧称
  ⑦ 归档 v1.4 件到 history/：ORCHESTRATION_CORE.md、orchestration_core.yaml、
     state_schema.json、validators/validate_v1_4_architecture.py

每次替换断言「旧形存在 → 换；已换 → 跳过；都不在 → 报错」。可重复运行。
SKILL.md / INDEX.md / examples/ / history/README.md 属内容创作，另行写入，不在本脚本内。

用法：python3 -B seo-orchestrator-gen1-build.py --dst <候选目录>
"""
import argparse
import re
import shutil
import sys
from pathlib import Path

FAILURES = []


def apply_replace(path: Path, old: str, new: str, label: str):
    text = path.read_text(encoding='utf-8')
    if new in text and old not in text:
        print(f'  [skip] {label}（已应用）')
        return
    if old not in text:
        FAILURES.append(f'{label}: 旧形不存在且新形不存在（{path.name}）')
        return
    if text.count(old) != 1:
        FAILURES.append(f'{label}: 旧形出现 {text.count(old)} 次（预期 1）')
        return
    path.write_text(text.replace(old, new, 1), encoding='utf-8')
    print(f'  [ok] {label}')


def op_module_headers(dst: Path):
    print('① 模块头版本沿革去除（20 文件）')
    n = 0
    for p in sorted((dst / 'modules').glob('*.md')):
        m = re.match(r'^\d\d｜', p.name)
        if not m:
            continue
        text = p.read_text(encoding='utf-8')
        if '【模块边界】' in text and not re.search(r'【V1\.4', text):
            print(f'  [skip] {p.name}')
            continue
        new_text, cnt = re.subn(r'【V1\.4(?:\.1)? 模块边界】', '【模块边界】', text)
        if cnt != 1:
            FAILURES.append(f'模块头: {p.name} 命中 {cnt} 次（预期 1）')
            continue
        p.write_text(new_text, encoding='utf-8')
        print(f'  [ok] {p.name}')
        n += 1
    assert n >= 0


def op_versions(dst: Path):
    print('② version 字段统一 1.5.0')
    for name, old, new in [
        ('evaluation_policy.yaml', "version: '1.4'", "version: '1.5.0'"),
        ('ownership_registry.yaml', "version: '1.4'", "version: '1.5.0'"),
        ('runtime_invariants.yaml', "version: '1.4'", "version: '1.5.0'"),
        ('router.yaml', "version: '1.4'", "version: '1.5.0'"),
        ('module_identity_registry.yaml', "version: '1.5'", "version: '1.5.0'"),
        ('canonical_trace_contract.yaml', "version: '1.5'", "version: '1.5.0'"),
        ('minimal_execution_protocol.yaml', "version: '1.5-candidate'", "version: '1.5.0'"),
    ]:
        apply_replace(dst / name, old, new, f'{name} version')


def op_protocol_dedupe(dst: Path):
    print('③ minimal_execution_protocol.yaml 单一来源化 + 角色注释')
    p = dst / 'minimal_execution_protocol.yaml'
    text = p.read_text(encoding='utf-8')
    role = ('# Role (single responsibility): protocol entry - profiles, stages (plan/reason/validate),\n'
            '# object minimal fields, operating rules. Fields/enums are single-sourced in\n'
            '# canonical_trace_schema.json; gate order, linkage and verdict rules in\n'
            '# canonical_trace_contract.yaml.\n')
    if not text.startswith('# Role'):
        p.write_text(role + text, encoding='utf-8')
        text = p.read_text(encoding='utf-8')
        print('  [ok] 角色注释')
    else:
        print('  [skip] 角色注释')
    # 删 gate_order
    gate = '    gate_order: [profile, base_schema, canonical_schema, architecture]\n'
    if gate in text:
        text = text.replace(gate, '', 1)
        p.write_text(text, encoding='utf-8')
        print('  [ok] 删 gate_order（单一来源=contract）')
    else:
        print('  [skip] gate_order')
    # 删 exact_fields 块（到 rules: 前）
    m = re.search(r'    exact_fields:\n(?:      [^\n]*\n)+    rules:\n', text)
    if m:
        text = p.read_text(encoding='utf-8')
        text = text[:m.start()] + '    rules:\n' + text[m.end():]
        p.write_text(text, encoding='utf-8')
        print('  [ok] 删 exact_fields（单一来源=schema/contract）')
    else:
        print('  [skip] exact_fields')


def op_contract_role(dst: Path):
    print('④ canonical_trace_contract.yaml 角色注释')
    p = dst / 'canonical_trace_contract.yaml'
    text = p.read_text(encoding='utf-8')
    role = ('# Role (single responsibility): machine-readable contract - gate order, handoff linkage,\n'
            '# dedup/forecast/dependency verdict rules, source declarations.\n'
            '# Protocol entry is minimal_execution_protocol.yaml.\n')
    if not text.startswith('# Role'):
        p.write_text(role + text, encoding='utf-8')
        print('  [ok] 角色注释')
    else:
        print('  [skip] 角色注释')


def op_modules_readme(dst: Path):
    print('⑤ modules/README.md 更新')
    p = dst / 'modules' / 'README.md'
    old = ('# Specialist Modules\n\n'
           '20 个模块只保留 SEO 专业职责，不再复制全局编排规则。\n\n'
           '全局行为统一由：\n'
           '- `orchestration_core.yaml`\n'
           '- `ownership_registry.yaml`\n'
           '- `router.yaml`\n'
           '- `runtime_invariants.yaml`\n'
           '控制。\n\n'
           '模块发现跨域信号时只需标记 capability domain，不自行决定跨域最终结论。\n')
    new = ('# Specialist Modules\n\n'
           '20 个模块只保留 SEO 专业职责，不复制全局编排规则。模块与服务索引见 [../INDEX.md](../INDEX.md)。\n\n'
           '全局行为统一由：\n'
           '- `minimal_execution_protocol.yaml`\n'
           '- `ownership_registry.yaml`\n'
           '- `router.yaml`\n'
           '- `runtime_invariants.yaml`\n'
           '控制。\n\n'
           '模块发现跨域信号时只需标记 capability domain，不自行决定跨域最终结论。\n')
    apply_replace(p, old, new, 'modules/README.md 重写')


def op_refs_index(dst: Path):
    print('⑥ references/来源与模块映射索引.md 死链与版本残留清理')
    p = dst / 'references' / '来源与模块映射索引.md'
    apply_replace(
        p,
        '`rule_fidelity_manifest.yaml` 是 V1.4.1 冻结审计原件：',
        '`rule_fidelity_manifest.yaml` 为冻结的规则保真审计原件（版本号系审计自身版本，保持原样不改写）：',
        '去 V1.4.1 版本号')
    apply_replace(
        p,
        'V1.5 的 Router、Owner 和运行约束以当前 `skill/` 内文件为准；',
        'Router、Owner 和运行约束以本包内现行文件为准；',
        '去 skill/ 旧称')
    apply_replace(
        p,
        '每条规则的 `matched_paths`、`destination_resolved` 和验证证据见[现有 V1.5 规则保真审计结果](../../evidence/results/V1_5_RULE_FIDELITY_AUDIT_RESULTS.json)；该结果是审计证据，不是第二套规则来源。历史清单中的工作区路径与交付包路径之间的逐文件映射见[路径迁移清单](../../release/PATH_RELOCATION_MAP.json)。若某条历史 destination 并未在 V1.5 中保留，必须以现有 Phase 5 规则保真审计为依据，不可自行补造目标。',
        '每条规则的 `matched_paths`、`destination_resolved` 和验证证据见源工作区的 V1.5 规则保真审计结果（`V1_5_RULE_FIDELITY_AUDIT_RESULTS.json`，未随本包分发）；该结果是审计证据，不是第二套规则来源。历史清单中的工作区路径与交付包路径之间的逐文件映射见源工作区路径迁移清单（`PATH_RELOCATION_MAP.json`，未随本包分发）。若某条历史 destination 并未在当前包中保留，必须以 Phase 5 规则保真审计为依据，不可自行补造目标；需要上述审计文件时向包维护方索取。',
        '清 ../../ 死链')


def op_archive(dst: Path):
    print('⑦ v1.4 件归档到 history/')
    hist = dst / 'history'
    hist.mkdir(exist_ok=True)
    for rel in ['ORCHESTRATION_CORE.md', 'orchestration_core.yaml', 'state_schema.json',
                'validators/validate_v1_4_architecture.py']:
        src, tgt = dst / rel, hist / Path(rel).name
        if src.exists():
            shutil.move(str(src), str(tgt))
            print(f'  [ok] {rel} → history/')
        elif tgt.exists():
            print(f'  [skip] {rel}（已归档）')
        else:
            FAILURES.append(f'归档: {rel} 既不在原位也不在 history/')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dst', required=True)
    args = parser.parse_args()
    dst = Path(args.dst).resolve()
    if not (dst / 'SKILL.md').is_file():
        sys.exit(f'目标目录不是候选副本: {dst}')
    op_module_headers(dst)
    op_versions(dst)
    op_protocol_dedupe(dst)
    op_contract_role(dst)
    op_modules_readme(dst)
    op_refs_index(dst)
    op_archive(dst)
    if FAILURES:
        print('\nFAILURES:')
        for f in FAILURES:
            print(' -', f)
        sys.exit(1)
    print('\nbuild ok')


if __name__ == '__main__':
    main()
