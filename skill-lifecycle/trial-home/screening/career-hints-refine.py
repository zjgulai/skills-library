#!/usr/bin/env python3
"""Q7-A 补记·career domainHint 留空 273 行细化（零请求、只读源、确定性）：

对 110-q7-tightening/career-domain-hints-v1.csv 中 domainHint 为空的行做一轮
**保守细化**：curated（逐名可辩护）规则表，不做宽词扩展（R-5 教训）。
- v1 已填行逐字节保留；只填空行；判不动仍留空。
- 基据值：新填行 hintBasis = refine-name / refine-desc；未动行保持原值。
- 版本纪律（106 规范 §9）：出 v1.1（旧 v1 保留）＋干跑读数＋抽样复核件。

用法：python3 -B career-hints-refine.py [--out <dir>]
"""
import argparse
import csv
import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

BASE = Path(__file__).resolve().parent


def find_repo(start):
    cur = start
    for _ in range(8):
        if (cur / 'skill-lifecycle').is_dir() and (cur / 'docs').is_dir():
            return cur
        cur = cur.parent
    raise SystemExit(f'仓库根推断失败: {start}')


REPO = find_repo(BASE)
SPEC = REPO / 'docs/specs/2026-09-25-dsh-skill-lifecycle'
OUT = SPEC / '110-q7-tightening'
V1 = OUT / 'career-domain-hints-v1.csv'

DOMAINS = ['经营与组织', '产品与创新', '供应与履约', '渠道经营', '品牌与增长', '服务与体验', '财务与合规', '数据与AI运行']

# —— 细化规则表（curated 逐名映射；生成顺序：name 精确 → desc（仅限无名 SKILL 行）→ 留空）——
# 判定依据：族一致性核对（同族近邻在 v1/全表的既有归属）＋逐名描述目检；
# 争议件一律不填（判不动留空）。评审记录见 career-hints-refine-review.json。
REFINE_NAME = {
    # ===== 数据与AI运行：授权安全/逆向工具族（v1 已把 security-*/attack-path 归此域）=====
    'browser-extension-reverse': '数据与AI运行',
    'digital-forensics': '数据与AI运行',
    'identity-federation': '数据与AI运行',
    'protocol-reverse': '数据与AI运行',
    'threat-intelligence': '数据与AI运行',
    'windows-ad': '数据与AI运行',
    'Authorization': '数据与AI运行',
    'mtls-configuration': '数据与AI运行',
    # ===== 数据与AI运行：harness / agent 平台与技能工具 =====
    'editing-cordis-compositions': '数据与AI运行',
    'dsh-dcp-config': '数据与AI运行',
    'find-plugins': '数据与AI运行',
    'qoder-cloud-agents': '数据与AI运行',
    'model-only-skill': '数据与AI运行',
    'user-only-skill': '数据与AI运行',
    'skills-security-check': '数据与AI运行',
    'Hook Development': '数据与AI运行',
    'Skill结构医生': '数据与AI运行',
    'onboarding': '数据与AI运行',
    'agentmail': '数据与AI运行',
    # ===== 数据与AI运行：工程 / 数据 / 前端 / 运维工具 =====
    'shell': '数据与AI运行',
    'AppleScript': '数据与AI运行',
    'historical-pattern-analysis': '数据与AI运行',
    'playwright-trace': '数据与AI运行',
    'saga-orchestration': '数据与AI运行',
    'adapter-express': '数据与AI运行',
    'pwa-manifest-generator': '数据与AI运行',
    'tailwind-class-optimizer': '数据与AI运行',
    'vue-composable-creator': '数据与AI运行',
    'release-manager': '数据与AI运行',
    'safe-file-operations': '数据与AI运行',
    'glab-runner-controller': '数据与AI运行',
    'mongodb-search-and-ai': '数据与AI运行',
    'dbt-transformation-patterns': '数据与AI运行',
    'graphql-architect': '数据与AI运行',
    'prometheus-configuration': '数据与AI运行',
    'spark-optimization': '数据与AI运行',
    'dummy-dataset': '数据与AI运行',
    'domain-modeling': '数据与AI运行',
    'setup-pre-commit': '数据与AI运行',
    'resolving-merge-conflicts': '数据与AI运行',
    'verification-before-completion': '数据与AI运行',
    'crafting-effective-readmes': '数据与AI运行',
    'content-modeling-best-practices': '数据与AI运行',
    'github-gem-seeker': '数据与AI运行',
    'insights-repository-kit': '数据与AI运行',
    'anchor-text-splitter': '数据与AI运行',
    'flowio': '数据与AI运行',
    'tyc-mcp': '数据与AI运行',
    'twilio-organizations-setup': '数据与AI运行',
    'zoom-cobrowse-sdk': '数据与AI运行',
    'mckinsey-multi-dimensional-charts': '数据与AI运行',
    'p2s-ai-social-impact-measurement': '数据与AI运行',
    '使用 Skills 提升 Claude 的设计水平': '数据与AI运行',
    '可视化项目数据': '数据与AI运行',
    '在与 Claude 的对话中为数据建表，在深入分析前先看清全貌': '数据与AI运行',
    'paper-skills-graph': '数据与AI运行',
    'clickhouse-architecture-advisor': '数据与AI运行',
    # ===== 数据与AI运行：agent 协作/会话工作流族 =====
    'grilling': '数据与AI运行',
    'grill-me': '数据与AI运行',
    'grill-with-docs': '数据与AI运行',
    'deep-probe': '数据与AI运行',
    'handoff': '数据与AI运行',
    'claude-handoff': '数据与AI运行',
    'wait-what': '数据与AI运行',
    'wayfinder': '数据与AI运行',
    'triage': '数据与AI运行',
    'to-spec': '数据与AI运行',
    'to-tickets': '数据与AI运行',
    'writing-for-agents': '数据与AI运行',
    # ===== 数据与AI运行：研发项目管理 / 项目材料 =====
    'lark-project': '数据与AI运行',
    'pb-006': '数据与AI运行',
    'pb-cto-01': '数据与AI运行',
    # ===== 品牌与增长：品牌 / 营销 / 内容 =====
    'brand-voice-glossary': '品牌与增长',
    'doubao-marketing-plan': '品牌与增长',
    'seed-audio': '品牌与增长',
    'media-database': '品牌与增长',
    'value-prop-statements': '品牌与增长',
    'positioning-ideas': '品牌与增长',
    'market-segments': '品牌与增长',
    'storytelling': '品牌与增长',
    'writing-beats': '品牌与增长',
    'writing-fragments': '品牌与增长',
    'writing-shape': '品牌与增长',
    'canva-translate-design': '品牌与增长',
    'dsh-motion-deck': '品牌与增长',
    'office': '品牌与增长',
    'business-plan-ppt': '品牌与增长',
    'icp-profiler': '品牌与增长',
    '理想客户画像': '品牌与增长',
    'crisis-playbooks': '品牌与增长',
    # ===== 经营与组织：商业方法 / 组织 / 会议 / 非营利运营 =====
    'business-model': '经营与组织',
    'lean-canvas': '经营与组织',
    'swot-analysis': '经营与组织',
    'ansoff-matrix': '经营与组织',
    'monetization-strategy': '经营与组织',
    'org-structure-research': '经营与组织',
    'xmind-arena-rootcause': '经营与组织',
    'xmind-arena-strategy': '经营与组织',
    'xmind-arena-sysfail': '经营与组织',
    'doubao-record': '经营与组织',
    '创建志愿者管理系统': '经营与组织',
    '了解你的筹款目标真正需要什么': '经营与组织',
    '分析筹款绩效': '经营与组织',
    '在 Claude 对话中理解为什么留住捐赠者比获取新捐赠者更重要': '经营与组织',
    '拨款提案流水线': '经营与组织',
    '在 Google Drive 中整理文件': '经营与组织',
    # ===== 财务与合规：合同 / 政策 / 预算 / 平台违规 =====
    'doubao-contract-amendment': '财务与合规',
    '违规处罚查询': '财务与合规',
    'Generate an AI policy': '财务与合规',
    '制定 AI 政策': '财务与合规',
    '合同审阅批注与谈判': '财务与合规',
    '在 Claude 对话中并排对比预算前景': '财务与合规',
    # ===== 渠道经营 =====
    '创建销售提案演示文稿': '渠道经营',
    'mckinsey-maternal-ecommerce-charts': '渠道经营',
    'ucp': '渠道经营',
    # ===== 产品与创新：产品发现 / 假设 / 创意 =====
    'brainstorm-ideas-existing': '产品与创新',
    'identify-assumptions-existing': '产品与创新',
    'identify-assumptions-new': '产品与创新',
    'product-brainstorming': '产品与创新',
    'ai-product-designer': '产品与创新',
    # ===== 服务与体验 =====
    'customer-journey-map': '服务与体验',
}

# 无名 SKILL 行的 desc 判别（仅对 name == 'SKILL' 的行生效；逐条命中须核对 ledgerId）
REFINE_DESC_SKILL = [
    (r'入库批次|按质检标准输出放行', '供应与履约'),
    (r'退场方案', '渠道经营'),
    (r'导入/成长/成熟/衰退', '渠道经营'),
    (r'母婴「信任优先」|IBCLC', '品牌与增长'),
]

# 明确留空名单（判不动；记录用，不参与判定）
LEAVE_REASONS = {
    '(空白名)': '无描述/无信号',
    'SKILL(占位)': '模板占位文本（触发用：一句话说明何时调用）',
    'lark-mail': '跨域办公工具，无单一主域',
    'lark-markdown': '跨域办公工具，无单一主域',
    'paper-write-zh': '学术论文写作，无经营域',
    'game-guide': '游戏攻略，无经营域',
    'ex_ex-jiejie / ex_example_liuzhimin / ex_stone / create-ex / example_me': '个人情感人格，无经营域',
    'save-system': '游戏子系统，无经营域',
    'opentrons-heater-shaker': '实验室设备，无经营域',
    'sunlight-analysis': '建筑日照分析，无经营域',
    'teach': '通用教学方法，无单一主域',
    'research': '通用调研方法，无单一主域',
    'scaffold-exercises': 'workshop 练习脚手架，无经营域',
    'to-questionnaire': '通用访谈工具，无单一主域',
    'xindaya-translator': '跨域翻译（明示不含本地化），无单一主域',
    'region-insight': '描述过薄（POI/围栏），用途未明',
    'defi-protocol-templates': 'DeFi 协议，无经营域',
    '将通勤时间转化为研究时间': '个人生产力',
    '在对话中绘制文献综述地图，揭示潜在争议': '学术研究',
    '构建自定义愿望清单': '个人应用',
    '设计本地觅食指南': '个人指南',
    '开发项目工具包': '非营利语境过泛，判不动',
    'user-context': '证券投资插件上下文，无经营域',
    'research-brief-blueprint': '市场调研立项模板，归属两可（品牌与增长/服务与体验）',
}


def desc_of(path, limit=140):
    try:
        text = Path(path).read_text(encoding='utf-8', errors='replace')[:1400]
    except Exception as error:  # noqa: BLE001
        return f'(read-fail {error.__class__.__name__})'
    m = re.search(r'description:\s*(.*?)(?:\n[a-zA-Z_-]+:|\n---)', text, re.S)
    if not m:
        return '(no-desc)'
    return re.sub(r'\s+', ' ', m.group(1)).strip().strip('"\'')[:limit]


def stride_distinct(rows, count):
    """按 name 去重后取 stride 抽样；返回 (name, 代表行, 该名行数)。"""
    by_name = defaultdict(list)
    for r in rows:
        by_name[r['name'] or '(空白名)'].append(r)
    names = sorted(by_name.keys())
    if len(names) <= count:
        picks = names
    else:
        step = len(names) / count
        picks = [names[int(i * step)] for i in range(count)]
    return [(n, by_name[n][0], len(by_name[n])) for n in picks]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', default=str(OUT))
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    v1_bytes = V1.read_bytes()
    v1_hash = hashlib.sha256(v1_bytes).hexdigest()
    rows = list(csv.DictReader(V1.open(encoding='utf-8-sig')))
    assert len(rows) == 1536, f'v1 行数异常: {len(rows)}'

    filled_names, filled_desc, still_empty = [], [], []
    matched_desc_rows = []
    out_rows = []
    for r in rows:
        row = dict(r)
        if row['domainHint']:
            out_rows.append(row)
            continue
        name = row['name']
        if name in REFINE_NAME:
            row['domainHint'] = REFINE_NAME[name]
            row['hintBasis'] = 'refine-name'
            filled_names.append(row)
        elif name == 'SKILL':
            hit = ''
            for pattern, dom in REFINE_DESC_SKILL:
                if re.search(pattern, desc_of(row['entryPath'], 400)):
                    hit = dom
                    break
            if hit:
                row['domainHint'] = hit
                row['hintBasis'] = 'refine-desc'
                filled_desc.append(row)
                matched_desc_rows.append(row['ledgerId'])
            else:
                still_empty.append(row)
        else:
            still_empty.append(row)
        out_rows.append(row)

    # —— 断言：只填空行、值域合法、总数不变 ——
    by_id_v1 = {r['ledgerId']: r for r in rows}
    for r in out_rows:
        v1r = by_id_v1[r['ledgerId']]
        if v1r['domainHint']:
            assert r == v1r, f'v1 已填行被改动: {r["ledgerId"]}'
        if r['domainHint']:
            assert r['domainHint'] in DOMAINS, f'非法域值: {r["ledgerId"]} {r["domainHint"]}'
    assert len(out_rows) == len(rows)
    assert {r['ledgerId'] for r in out_rows} == set(by_id_v1)
    assert sorted(matched_desc_rows) == ['L31301', 'L31330', 'L31342', 'L31381'], \
        f'SKILL 行 desc 命中异常: {matched_desc_rows}'

    v11 = out / 'career-domain-hints-v1.1.csv'
    with v11.open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['ledgerId', 'name', 'entryPath', 'topicCandidate', 'domainHint', 'hintBasis'])
        w.writeheader()
        w.writerows(out_rows)

    before = Counter((r['domainHint'] or '(未映射)') for r in rows)
    after = Counter((r['domainHint'] or '(未映射)') for r in out_rows)
    left_names = Counter((r['name'] or '(空白名)') for r in still_empty)
    summary = {
        'record_type': 'career-hints-refine-summary',
        'note': 'domainHint 留空 273 行保守细化：curated 逐名规则（族一致性核对＋描述目检），只填空行、判不动仍留空；该字段是台账线索，不是路由/权限。',
        'frozenInput': {'path': str(V1), 'sha256': v1_hash, 'rows': len(rows)},
        'filled': {'refine-name': len(filled_names), 'refine-desc': len(filled_desc),
                   'total': len(filled_names) + len(filled_desc)},
        'stillEmpty': {'rows': len(still_empty), 'distinctNames': len(left_names),
                       'names': {k: v for k, v in left_names.most_common()}},
        'leaveReasons': LEAVE_REASONS,
        'byDomain': {'before': dict(before), 'after': dict(after)},
        'descRuleHits': matched_desc_rows,
        'refineNameRules': REFINE_NAME,
        'refineDescRules(SKILL-only)': [[p, d] for p, d in REFINE_DESC_SKILL],
    }
    (out / 'career-hints-refine-summary.json').write_text(
        json.dumps(summary, ensure_ascii=False, indent=1) + '\n')

    # —— 抽样复核件：每域（新填行）至多 30 个不同名 ——
    sample = {}
    for dom in DOMAINS:
        pool = [r for r in out_rows if r['hintBasis'] in ('refine-name', 'refine-desc') and r['domainHint'] == dom]
        picks = stride_distinct(pool, 30)
        sample[dom] = {'available': len(pool), 'distinctNames': len({r['name'] for r in pool}),
                       'sampled': len(picks), 'items': [
            {'ledgerId': r['ledgerId'], 'name': n or '(空白名)', 'copies': c,
             'domainHint': r['domainHint'], 'basis': r['hintBasis'],
             'desc': desc_of(r['entryPath'], 150)} for n, r, c in picks]}
    (out / 'career-hints-refine-sample.json').write_text(
        json.dumps({'record_type': 'q7-refine-sample',
                    'note': '细化批抽样：每域至多 30 个不同名（不足全取）；供逐条核 domainHint 是否成立（评审记录见 career-hints-refine-review.json）',
                    'byDomain': sample}, ensure_ascii=False, indent=1) + '\n')

    print(json.dumps({'filled': summary['filled'], 'stillEmpty': summary['stillEmpty']['rows'],
                      'byDomain': summary['byDomain'], 'v11': str(v11)}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
