#!/usr/bin/env python3
"""旧英文 id 清扫计划生成器（件1 ecommerce-marketing ／ 件2 supply-chain）。

按技能库当前字节生成 `skill-repair-text.mjs` 的 replace 计划：
- 同一文件多处操作时，第 N 处 op 的 expectSha256 按**链式**（前一处之后）计算。
- 生成前逐条断言出现次数；生成后复核旧 token 已全部消失。
生成产物：text-plan-oldid-marketing-2026-09-30.json / text-plan-oldid-supplychain-2026-09-30.json
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

LIB = Path('/Users/lute/project/AgentTools/技能库')
OUT = Path('/Users/lute/project/AgentTools/思维库/skill管理/skill-lifecycle/trial-home/screening')


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def build(edits, policy, out_name):
    """edits: [(relPath, find, replace, count)]，同文件按给定顺序。

    哈希门策略（吸取链式哈希教训）：dry-run 不落盘，执行器每条 op 都对着**原始文件**核
    count/hash；因此要求同一文件的各 op **互不重叠**（任一 op 的 find 不包含/不改变其它 op
    的计数），并且**只有该文件的第一条 op 带 expectSha256**（apply 时只有它面对未改数据）。
    这样 dry-run 的读数与 apply 的读数才一致，不会假绿也不会误拒。
    """
    by_file: dict[str, list] = {}
    for rel, find, replace, count in edits:
        by_file.setdefault(rel, []).append((find, replace, count))
    ops = []
    for rel, pairs in by_file.items():
        content = (LIB / rel).read_text(encoding='utf-8')
        original_sha = sha(content.encode('utf-8'))
        for i, (find, replace, count) in enumerate(pairs):
            n = content.count(find)
            if n != count:
                raise SystemExit(f'COUNT MISMATCH {rel}: got {n}, expect {count} for {find[:80]!r}')
            op = {
                'kind': 'replace', 'relPath': rel,
                'find': find, 'replace': replace,
                'expectCount': count,
            }
            if i == 0:
                op['expectSha256'] = original_sha
            ops.append(op)
    doc = {'record_type': 'library_text_plan', 'at': '2026-09-30', 'policy': policy, 'ops': ops}
    out = OUT / out_name
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'{out.name}: {len(ops)} ops / {len(by_file)} files')



# ============ 件 1：ecommerce-marketing ============
EM = '81-Skills/ecommerce-marketing'

# 1a. SKILL.md 成员表：古文→新文按行硬编码，old 从文件现场抽取（字节精确）
em_skill = (LIB / EM / 'SKILL.md').read_text(encoding='utf-8')
lines = em_skill.split('\n')
hi = next(i for i, l in enumerate(lines) if l == '| Skill | 功能 | 触发场景 |')
old_rows = lines[hi + 2: hi + 11]
new_rows = [
    '| ad-creative（广告创意） | 广告创意生成 | 需要广告文案、创意概念 |',
    '| paid-advertising（付费广告） | 付费广告优化 | 需要预算分配、出价策略 |',
    '| social-content（社媒内容） | 社媒内容生成 | 需要社媒帖子、内容日历 |',
    '| email-automation-flow-builder（邮件序列） | 邮件营销序列 | 需要欢迎/弃购/复购邮件 |',
    '| cold-email（冷邮件） | 冷邮件外联 | 需要B2B外联、销售开发 |',
    '| launch-strategy（上市策略） | 产品发布策略 | 需要GTM方案、增长实验 |',
    '| copywriting（营销文案） | 文案写作 | 需要销售文案、品牌故事 |',
    '| competitor-alternative-analysis（竞品替代分析） | 竞品替代方案 | 需要竞品分析、差异化定位 |',
    '| optimize-ecommerce-page-conversion（CRO优化） | CRO优化 | 需要转化率提升、着陆页优化 |',
]
assert len(old_rows) == 9 and old_rows[0].startswith('| 广告创意（mkt-ad-creative）'), '成员表行不匹配'
row_edits = [(f'{EM}/SKILL.md', o, n, 1) for o, n in zip(old_rows, new_rows) if o != n]

# 1b. playbook 图形块：现场抽取（fence 内）
pb_rel = f'{EM}/references/coordination-playbook.md'
pb = (LIB / pb_rel).read_text(encoding='utf-8')
gi = pb.index('```\n营销主控 (主协调器)\n')
gj = pb.index('\n```', gi)
old_graph = pb[gi + 4:gj]


def w(text: str) -> int:
    return sum(2 if ord(c) > 0x2E7F else 1 for c in text)


graph_rows = [
    ('ad-creative', ['paid-advertising', 'copywriting'], 6),
    ('paid-advertising', ['ad-creative', 'optimize-ecommerce-page-conversion'], 7),
    ('social-content', ['ad-creative', 'copywriting'], 7),
    ('email-automation-flow-builder', ['cold-email', 'copywriting'], 7),
    ('cold-email', ['email-automation-flow-builder', 'copywriting'], 9),
    ('launch-strategy', ['ad-creative', 'social-content', 'email-automation-flow-builder', 'copywriting'], 7),
    ('copywriting', ['ad-creative', 'email-automation-flow-builder', 'social-content'], 7),
    ('competitor-alternative-analysis', ['copywriting'], 4),
    ('optimize-ecommerce-page-conversion', ['copywriting', 'paid-advertising'], 7),
]
glines = ['ecommerce-marketing（营销主控 / 主协调器）']
for idx, (name, children, n_dash) in enumerate(graph_rows):
    last_parent = idx == len(graph_rows) - 1
    branch, cont = ('└──', ' ') if last_parent else ('├──', '│')
    if len(children) == 1:
        glines.append(f'{branch} {name} ' + '─' * n_dash + f'→ {children[0]}')
        continue
    col = 4 + w(name) + 1 + n_dash  # 0-based ┬ 列
    glines.append(f'{branch} {name} ' + '─' * n_dash + f'┬──→ {children[0]}')
    for k, child in enumerate(children[1:]):
        mark = '└──→' if k == len(children) - 2 else '├──→'
        glines.append(cont + ' ' * (col - 1) + f'{mark} {child}')
new_graph = '\n'.join(glines)  # 结尾不带换行：与旧块口径一致，避免围栏前多出空行

marketing_edits = [
    # SKILL.md：成员表 8 行（id 换新＋格式统一；cold-email 行无变化不动）+ 散处 6 个指定位（互不重叠）
    *row_edits,
    (f'{EM}/SKILL.md', 'Use mkt-ad-creative:', 'Use ad-creative:', 1),
    (f'{EM}/SKILL.md', 'launch-strategy + mkt-ad-creative + social-content', 'launch-strategy + ad-creative + social-content', 1),
    (f'{EM}/SKILL.md', '`mkt-ad-creative`', '`ad-creative`', 1),
    (f'{EM}/SKILL.md', 'Use mkt-email-sequence:', 'Use email-automation-flow-builder:', 1),
    (f'{EM}/SKILL.md', '`mkt-email-sequence`', '`email-automation-flow-builder`', 1),
    (f'{EM}/SKILL.md', '`mkt-competitor-alternatives`', '`competitor-alternative-analysis`', 1),
    # README
    (f'{EM}/README.md', 'mkt-ad-creative', 'ad-creative', 1),
    (f'{EM}/README.md', 'mkt-paid-ads', 'paid-advertising', 1),
    (f'{EM}/README.md', 'mkt-email-sequence', 'email-automation-flow-builder', 1),
    (f'{EM}/README.md', 'mkt-competitor-alternatives', 'competitor-alternative-analysis', 1),
    # manifest
    (f'{EM}/.skill-meta/manifest.yaml', 'mkt-ad-creative', 'ad-creative', 1),
    (f'{EM}/.skill-meta/manifest.yaml', 'mkt-paid-ads', 'paid-advertising', 1),
    (f'{EM}/.skill-meta/manifest.yaml', 'mkt-email-sequence', 'email-automation-flow-builder', 1),
    (f'{EM}/.skill-meta/manifest.yaml', 'mkt-cold-email', 'cold-email', 1),
    (f'{EM}/.skill-meta/manifest.yaml', 'mkt-competitor-alternatives', 'competitor-alternative-analysis', 1),
    # playbook：token（两表 8 处）→ 图形块 → 三条编排链
    (pb_rel, 'mkt-ad-creative', 'ad-creative', 1),
    (pb_rel, 'mkt-paid-ads', 'paid-advertising', 1),
    (pb_rel, 'mkt-email-sequence', 'email-automation-flow-builder', 1),
    (pb_rel, 'mkt-cold-email', 'cold-email', 1),
    (pb_rel, 'mkt-competitor-alternatives', 'competitor-alternative-analysis', 1),
    (pb_rel, 'mkt-brand-voice', 'brand-voice-glossary', 1),
    (pb_rel, 'mkt-content-suite', 'marketing-content-suite', 1),
    (pb_rel, 'mkt-video-analysis', 'viral-video-analyzer', 1),
    (pb_rel, old_graph, new_graph, 1),
    (pb_rel, '竞品替代分析 → 上市策略 → 营销文案 → 广告创意 → 邮件序列 → 社媒内容 → CRO优化',
     'competitor-alternative-analysis → launch-strategy → copywriting → ad-creative → email-automation-flow-builder → social-content → optimize-ecommerce-page-conversion', 1),
    (pb_rel, '竞品替代分析 → 营销文案 → 冷邮件 → CRO优化 → 上市策略',
     'competitor-alternative-analysis → copywriting → cold-email → optimize-ecommerce-page-conversion → launch-strategy', 1),
    (pb_rel, '上市策略 → 广告创意 → 邮件序列 → 社媒内容 → 付费广告',
     'launch-strategy → ad-creative → email-automation-flow-builder → social-content → paid-advertising', 1),
    # route.py 出参（对齐 ecommerce-analytics-controller 的 kebab 出参惯例）
    (f'{EM}/scripts/route.py', '"skill": "广告创意"', '"skill": "ad-creative"', 1),
    (f'{EM}/scripts/route.py', '"skill": "营销文案"', '"skill": "copywriting"', 2),
    (f'{EM}/scripts/route.py', '"skill": "付费广告"', '"skill": "paid-advertising"', 1),
    (f'{EM}/scripts/route.py', '"skill": "上市策略"', '"skill": "launch-strategy"', 1),
    (f'{EM}/scripts/route.py', '"skill": "邮件序列"', '"skill": "email-automation-flow-builder"', 1),
    (f'{EM}/scripts/route.py', '"skill": "社媒内容"', '"skill": "social-content"', 1),
    (f'{EM}/scripts/route.py', '"skill": "竞品替代分析"', '"skill": "competitor-alternative-analysis"', 1),
    (f'{EM}/scripts/route.py', '"skill": "CRO优化"', '"skill": "optimize-ecommerce-page-conversion"', 1),
    (f'{EM}/scripts/route.py', '"skill": "品牌声音提取器"', '"skill": "brand-voice-glossary"', 1),
    (f'{EM}/scripts/route.py', '"skill": "营销内容套件"', '"skill": "marketing-content-suite"', 1),
    (f'{EM}/scripts/route.py', '"skill": "爆款视频分析器"', '"skill": "viral-video-analyzer"', 1),
]

# ============ 件 2：supply-chain ============
SC = '81-Skills/supply-chain-controller'
ISC = '81-Skills/international-shipping-customs'
IDF = '81-Skills/inventory-demand-forecaster'
ST = '81-Skills/shipment-tracking'

supply_edits = [
    # 主控 SKILL.md：4 个旧 id → 现行四技能
    (f'{SC}/SKILL.md', 'scm-inventory-forecaster', 'inventory-demand-forecaster', 4),
    (f'{SC}/SKILL.md', 'scm-supplier-evaluator', 'supplier-evaluation', 3),
    (f'{SC}/SKILL.md', 'scm-logistics-optimizer', 'international-shipping-customs', 3),
    (f'{SC}/SKILL.md', 'scm-logistics-tracker', 'shipment-tracking', 2),
    # 主控 route.py 出参
    (f'{SC}/scripts/route.py', 'scm-inventory-forecaster', 'inventory-demand-forecaster', 3),
    (f'{SC}/scripts/route.py', 'scm-logistics-optimizer', 'international-shipping-customs', 4),
    (f'{SC}/scripts/route.py', 'scm-supplier-evaluator', 'supplier-evaluation', 2),
    (f'{SC}/scripts/route.py', 'scm-logistics-tracker', 'shipment-tracking', 3),
    # 主控 workflow-example.md
    (f'{SC}/references/workflow-example.md', 'scm-inventory-forecaster', 'inventory-demand-forecaster', 1),
    (f'{SC}/references/workflow-example.md', 'scm-supplier-evaluator', 'supplier-evaluation', 1),
    (f'{SC}/references/workflow-example.md', 'scm-logistics-optimizer', 'international-shipping-customs', 1),
    # international-shipping-customs description：复合旧名 + 旧显示名 → 现行 kebab
    (f'{ISC}/SKILL.md',
     '运单状态追踪（使用物流追踪）、库存补货预测（使用供应链主控-库存预测）、供应商准入评估（使用供应链主控-供应商评估）',
     '运单状态追踪（使用 shipment-tracking）、库存补货预测（使用 inventory-demand-forecaster）、供应商准入评估（使用 supplier-evaluation）', 1),
    # inventory-demand-forecaster：旧 hub 名 → 现行 kebab（对齐同句既有注记格式）
    (f'{IDF}/SKILL.md', '供应链整体协调（`供应链主控`）', '供应链整体协调（`supply-chain-controller`（供应链主控））', 1),
    # shipment-tracking：混合请求清单 + 对照表首列 + 维护段
    (f'{ST}/SKILL.md', '路由到对应 Skill（物流优化/库存预测/供应商评估/供应链主控）',
     '路由到对应 Skill（international-shipping-customs / inventory-demand-forecaster / supplier-evaluation / supply-chain-controller）', 1),
    (f'{ST}/SKILL.md', '| 物流优化 |', '| international-shipping-customs（物流优化） |', 1),
    (f'{ST}/SKILL.md', '| 供应链主控 |', '| supply-chain-controller（供应链主控） |', 1),
    (f'{ST}/SKILL.md', '| 供应商评估 |', '| supplier-evaluation（供应商评估） |', 1),
    (f'{ST}/SKILL.md', '**停用**：能力被供应链主控完全覆盖时标deprecated',
     '**停用**：能力被 `supply-chain-controller`（供应链主控）完全覆盖时标deprecated', 1),
]

marketing_policy = (
    '批二十九·件1：ecommerce-marketing 家族机器面/图形面旧引用清扫（用户批准 A 方案）。'
    '范围：成员表/清单/出参/ASCII 图/编排链——`mkt-*` 旧 id → 现行 kebab；成员表统一 `kebab（中文）` 注记式；'
    'route.py 出参对齐 ecommerce-analytics-controller 的 kebab 出参惯例；图节点改现行 kebab（中文对照见上方表）。'
    '零真实请求；apply 后验证：route.py 冒烟、屏检、回归、残留扫描。'
)
supply_policy = (
    '批二十九·件2：供应链家族旧 hub 名/旧 id 清扫（用户批准 A 方案）。'
    '范围：`scm-*` 旧 id → 现行四技能（inventory-demand-forecaster / supplier-evaluation / '
    'international-shipping-customs / shipment-tracking）；international-shipping-customs 的复合旧名与旧显示名、'
    'inventory-demand-forecaster 的旧 hub 名、shipment-tracking 的裸中文表行与维护段——统一现行 kebab（表行用 `kebab（中文）` 注记式）。'
    '零真实请求；apply 后验证：两个 route.py 冒烟、屏检、回归、残留扫描。'
)

build(marketing_edits, marketing_policy, 'text-plan-oldid-marketing-2026-09-30.json')
build(supply_edits, supply_policy, 'text-plan-oldid-supplychain-2026-09-30.json')
