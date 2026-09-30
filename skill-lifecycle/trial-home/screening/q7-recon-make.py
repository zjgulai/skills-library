#!/usr/bin/env python3
"""Q7 分类收尾批·侦察与采样生成器（零请求、只读）：

产出（110-q7-tightening/）：
  career-domain-hints-v1.{csv,summary.json}   A：career 1,536 行 → 8 责任域 domainHint（规则表冻结）
  packet-a-career-sample.json                 A：每域 ≥30 抽样（含描述摘要，供人工核）
  packet-c-topic-sample.json                  C：四类词表边界抽样（共享/其他/待核-有主题/无信号 各 ≥30）
  packet-b-qoder-sample.json                  B：Qoder 未归类 7,697 分层 200 抽样（按字节四分位分层）
  cross-check-20.json                         20 件"机器待核×Sage 有归位"交叉核对数据

用法：python3 -B q7-recon-make.py [--out <dir>]
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
LEDGER_CSV = SPEC / '108-w2-classification/classification-projection-v1.csv'
PLAN = SPEC / '107-w1-assembly/assembly-plan-v1-batch1.json'
SAGE_ROLES = Path('/Users/lute/project/Sage/packages/capabilities/dsh-overseas-skills/manifest/role-assignments.json')
OUT = SPEC / '110-q7-tightening'

DOMAINS = ['经营与组织', '产品与创新', '供应与履约', '渠道经营', '品牌与增长', '服务与体验', '财务与合规', '数据与AI运行']

# —— A：name 家族规则（先匹配先得）——
NAME_RULES = [
    (r'^(alibaba|1688|国际站|shopify|aw-shopify|multi-platform|product-selection|product-package|buyer-|demand-mirror|geo-|lute[- ]?cbec|cbec-|pricing-|coupon-|discount-|dynamic-pricing|sales-)', '渠道经营'),
    (r'^(customer-(retention|winback|rfm|ltv)|lifecycle-|cart-abandonment|google-shopping|marketing|campaign|xiaohongshu|article-|card-|deck-|frame-|video|design|koc-|种草|social-media|image-|vibe-marketing|creator|infimind|极睿|detail-page|product-main-image|influencer)', '品牌与增长'),
    (r'^(customer-voice|helpdesk|product-review|return-policy|returns-exchange)', '服务与体验'),
    (r'^(inventory|warehouse|dropshipping|international-shipping|multichannel-inventory|multi-location-order|fulfillment|logistics)', '供应与履约'),
    (r'^(b2b-payment|invoice|sales-tax|payment-fraud|finance-report|compliance|privacy|search-compliance)', '财务与合规'),
    (r'^(hr-|meeting-notes|kanban|weekly-update|exec-briefing|team-okrs|flowai-team|live-dashboard|dashboard|ai-business-strategy|file-organizer)', '经营与组织'),
    (r'^(loopx|loop-|hermes|cloudbase|ai-model|postgresql|relational-database|provider-operations|airtable|security-|attack-path|dev|api-|code|bug-review|clean-code|kotlin|nunit|docker|vercel|obsidian|json-canvas|artifacts-builder|agentdb|seismograph|pattern-mine|skill-|Skill-|Transaction|Data Validation|Multipart|Idempotency|kb-result)', '数据与AI运行'),
    (r'^(pm-spec|mockup|ui-|responsive-design|drafter)', '产品与创新'),
]
# —— A：描述关键词兜底（name 未命中时先于标签映射；中英混合）——
DESC_RULES = [
    (r'退款|退货|换货|工单|客服|差评|满意度|用户反馈|投诉|工单分类|customer service|support|refund|return|complaint|helpdesk|reviews?\b|satisfaction|chargeback', '服务与体验'),
    (r'库存|补货|备货|履约|物流|运输|关务|仓库|调拨|采购|供应商|断货|货盘|inventory|stock|reorder|warehouse|fulfillment|shipping|logistics|customs|supplier|procurement|dropship|tech pack|BOM', '供应与履约'),
    (r'毛利|成本测算|税务|发票|证书|检测报告|合规|回本|烧钱|payment|invoice|tax|compliance|legal|fraud|audit|financial|GDPR|账期|应收', '财务与合规'),
    (r'SEO|投放|广告|流量|渠道|平台规则|亚马逊|独立站|TikTok|listing|促销|定价|佣金|串货|选品|品类|爆款|测款|amazon|shopify|marketplace|advertis|ppc|marketplace|coupon|promotion|conversion', '渠道经营'),
    (r'达人|种草|文案|调性|素材|视频|评价回复|社媒|brand|copywriting|social media|creative|content design|image prompt|poster|deck|slide|carousel|logo|视频生成', '品牌与增长'),
    (r'复盘|周报|异常|分级|预警|提案|管理层|CGO|路线|编排|路由建议|SOP|看板|strategy|planning|okr|meeting|dashboard|report|onboarding|hr\b', '经营与组织'),
    (r'原型|交互|设计系统|UI\b|UX\b|prototype|roadmap|PRD|feature|design system|product (design|manager|strategy)|用户体验', '产品与创新'),
    (r'代码|数据库|部署|运维|安全评估|渗透|CTF|漏洞|框架|工具链|推理链|知识提取|code\b|api\b|sql|database|deploy|devops|security|vulnerab|agentic|LLM|prompt engineering|framework|MCP', '数据与AI运行'),
]
# —— A：topic 标签兜底映射（name 未命中时）——
LABEL_MAP = {
    '业务经营与AgenticOS': '渠道经营', '安全与治理': '数据与AI运行', 'skills graph': '',
    'claude learn': '数据与AI运行', 'marketing': '品牌与增长', 'lute cbec': '渠道经营',
    '其他待归类': '', 'design': '品牌与增长', 'engineering': '品牌与增长', 'video': '品牌与增长',
    'marketing-growth': '品牌与增长', 'operations': '经营与组织', 'product': '产品与创新',
    'business-operations': '供应与履约', 'fulfillment-shipping': '供应与履约',
    'payments-checkout': '财务与合规', 'dev': '数据与AI运行', 'finance': '财务与合规',
    'pricing-promotions': '渠道经营', 'customer-crm': '服务与体验', 'creator': '品牌与增长',
    'data-analytics': '数据与AI运行', 'document-processing': '数据与AI运行', 'Backend': '数据与AI运行',
    'ai': '数据与AI运行', 'devops': '数据与AI运行', '数据分析': '渠道经营',
    'methodology-analysis': '数据与AI运行', 'productivity': '数据与AI运行', 'education': '品牌与增长',
    'market-research': '服务与体验', 'design-ui': '产品与创新', 'campaign-analysis': '渠道经营',
    'hr': '经营与组织', 'sales': '渠道经营', 'security-compliance': '财务与合规',
    'reporting-analysis': '数据与AI运行', 'creative': '数据与AI运行', 'frontend': '数据与AI运行',
    'meta': '数据与AI运行', 'agentdb': '数据与AI运行', 'code-review': '数据与AI运行',
    'code-quality': '数据与AI运行', '写作与内容创作': '品牌与增长', 'qoder-builder': '数据与AI运行',
    'kotlin': '数据与AI运行', 'unit-testing': '数据与AI运行', 'everyday-tools': '数据与AI运行',
    'content-creation': '品牌与增长', 'file-generation': '品牌与增长', 'change-intelligence': '数据与AI运行',
    'Databases': '数据与AI运行', 'business-productivity': '经营与组织', 'creative-collaboration': '数据与AI运行',
    '01-因果推断': '数据与AI运行', '12-ML基础': '数据与AI运行', '21-合规决策': '财务与合规',
    '25-搜索流量工程': '渠道经营', '11-user-behavior-analysis': '数据与AI运行', 'tool': '数据与AI运行',
}


def desc_of(path, limit=170):
    try:
        text = Path(path).read_text(encoding='utf-8', errors='replace')[:1400]
    except Exception as error:  # noqa: BLE001
        return f'(read-fail {error.__class__.__name__})'
    m = re.search(r'description:\s*(.*?)(?:\n[a-zA-Z_-]+:|\n---)', text, re.S)
    if not m:
        return '(no-desc)'
    return re.sub(r'\s+', ' ', m.group(1)).strip().strip('"\'')[:limit]


def stride(rows, count):
    ordered = sorted(rows, key=lambda r: r['entryPath'])
    if len(ordered) <= count:
        return ordered
    step = len(ordered) / count
    return [ordered[int(i * step)] for i in range(count)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', default=str(OUT))
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rows = list(csv.DictReader(LEDGER_CSV.open(encoding='utf-8-sig')))
    plan = json.loads(PLAN.read_text())
    sage = json.loads(SAGE_ROLES.read_text())['skills']

    # ============ A：career 域映射 ============
    career = [r for r in rows if r['routeV1'] == 'unassigned-needs-review'
              and r['sourceKind'] == 'career' and r['qualityBlocked'] == 'False']
    hints = []
    HETERO_LABELS = {'业务经营与AgenticOS', '安全与治理', 'skills graph', '其他待归类'}
    for r in career:
        name = r['name'] or ''
        domain, basis = '', ''
        for pattern, dom in NAME_RULES:
            if re.search(pattern, name, re.I):
                domain, basis = dom, 'name-rule'
                break
        label = r['topicCandidate']
        if not domain and label not in HETERO_LABELS and LABEL_MAP.get(label):
            domain, basis = LABEL_MAP[label], 'label-map'
        if not domain:
            text = desc_of(r['entryPath'], 400)
            for pattern, dom in DESC_RULES:
                if re.search(pattern, text, re.I):
                    domain, basis = dom, 'desc-rule'
                    break
        hints.append({'ledgerId': r['ledgerId'], 'name': name, 'entryPath': r['entryPath'],
                      'topicCandidate': label, 'domainHint': domain, 'hintBasis': basis or 'none'})
    with (out / 'career-domain-hints-v1.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['ledgerId', 'name', 'entryPath', 'topicCandidate', 'domainHint', 'hintBasis'])
        w.writeheader()
        w.writerows(hints)
    hint_summary = {
        'record_type': 'career-domain-hints-v1', 'total': len(hints),
        'byDomain': dict(Counter(h['domainHint'] or '(未映射)' for h in hints)),
        'byBasis': dict(Counter(h['hintBasis'] for h in hints)),
        'unmapped': [h['ledgerId'] for h in hints if not h['domainHint']][:50],
        'rules': {'nameRules': [[p, d] for p, d in NAME_RULES], 'labelMap': LABEL_MAP},
        'note': 'domainHint 为台账字段（8 责任域轴），不是路由、不是权限；映射为规则级 best-effort，样本核验见 packet-a。',
    }
    (out / 'career-domain-hints-v1.summary.json').write_text(
        json.dumps(hint_summary, ensure_ascii=False, indent=1) + '\n')

    by_domain = defaultdict(list)
    for r in career:
        h = next(x for x in hints if x['ledgerId'] == r['ledgerId'])
        if h['domainHint']:
            by_domain[h['domainHint']].append(r)
    sample_a = {}
    for dom in DOMAINS:
        picks = stride(by_domain[dom], 30)
        sample_a[dom] = {'available': len(by_domain[dom]), 'sampled': len(picks), 'items': [
            {'ledgerId': r['ledgerId'], 'name': r['name'], 'topic': r['topicCandidate'],
             'path': r['entryPath'].split('/skills/')[-1], 'desc': desc_of(r['entryPath'], 130)} for r in picks]}
    (out / 'packet-a-career-sample.json').write_text(
        json.dumps({'record_type': 'q7-packet-a', 'note': '每域 ≥30（不足全取）；供逐条核 domainHint 是否成立',
                    'byDomain': sample_a}, ensure_ascii=False, indent=1) + '\n')

    # ============ C：四类词表边界抽样 ============
    shared = [r for r in rows if r['routeV1'] == 'shared-topic-candidate']
    other = [r for r in rows if r['routeV1'] == 'other-topic-candidate']
    unassigned = [r for r in rows if r['routeV1'] == 'unassigned-needs-review']
    un_topic_noncareer = [r for r in unassigned if r['sourceKind'] in ('qoder', 'zip') and r['topicCandidate']]
    no_signal = [r for r in unassigned if r['qualityBlocked'] == 'False' and not r['topicCandidate']]
    packet_c = {'record_type': 'q7-packet-c',
                'note': '四类各 ≥30 抽样核词表边界：①共享主题精确率 ②其他主题精确率 ③待核-有主题（非 career）是否漏判 ④无信号是否漏判',
                'classes': {}}
    for cls, pool, expect in [('shared-topic', shared, '应归属所标主题'),
                              ('other-topic', other, '应归属所标主题'),
                              ('unassigned-with-topic', un_topic_noncareer, '按主题应可判（漏判检查）'),
                              ('no-signal', no_signal, '确无可判信号（漏判检查）')]:
        picks = stride(pool, 30)
        packet_c['classes'][cls] = {'available': len(pool), 'sampled': len(picks), 'expect': expect, 'items': [
            {'ledgerId': r['ledgerId'], 'sourceKind': r['sourceKind'], 'name': r['name'],
             'topic': r['topicCandidate'], 'path': r['entryPath'].split('/技能库/')[-1][:78],
             'desc': desc_of(r['entryPath'], 120) if r['sourceKind'] != 'zip' else '(zip-member)'} for r in picks]}
    (out / 'packet-c-topic-sample.json').write_text(json.dumps(packet_c, ensure_ascii=False, indent=1) + '\n')

    # ============ B：Qoder 未归类分层 200 抽样 ============
    qoder_un = [r for r in unassigned if r['sourceKind'] == 'qoder' and r['topicCandidate'] == '未归类']
    ordered = sorted(qoder_un, key=lambda r: int(r['bytes']))
    quart = len(ordered) // 4
    strata = [ordered[:quart], ordered[quart:2 * quart], ordered[2 * quart:3 * quart], ordered[3 * quart:]]
    picks = []
    for i, band in enumerate(strata):
        picks += [(i, r) for r in stride(band, 50)]
    packet_b = {'record_type': 'q7-packet-b',
                'note': 'Qoder 未归类分层抽样：按字节四分位分层，每层 50，共 200；判"可归类（角色/共享/其他）"与否',
                'population': len(qoder_un),
                'byBytes': {'p25': ordered[quart]['bytes'], 'median': ordered[2 * quart]['bytes'],
                            'p75': ordered[3 * quart]['bytes']},
                'items': [{'stratum': s, 'ledgerId': r['ledgerId'], 'name': r['name'], 'bytes': int(r['bytes']),
                           'path': r['entryPath'].split('/技能库/')[-1][:70],
                           'desc': desc_of(r['entryPath'], 120)} for s, r in picks]}
    (out / 'packet-b-qoder-sample.json').write_text(json.dumps(packet_b, ensure_ascii=False, indent=1) + '\n')

    # ============ 20 件交叉核对 ============
    ops = {}
    for op in plan['operations']:
        ops[op['name']] = op
    twenty = []
    # 20 件来自 loop-ledger：机器待核、Sage 有归位
    ll = list(csv.DictReader((SPEC / '109-loop-ledger/loop-ledger-v1.csv').open(encoding='utf-8-sig')))
    targets = [r for r in ll if r['classificationState'] == 'cross-check-pending']
    for t in targets:
        op = ops[t['name']]
        entry = (op['sourceDir'] + '/' + op['entryRelPath'].split('/')[-1]) if op['mode'] == 'dir' else op['sourceFile']
        sage_entry = sage.get(t['name'], {})
        roles = [{'id': x['id'], 'responsibility': x.get('responsibility', ''), 'confidence': x.get('confidence', ''),
                  'note': (x.get('note') or '')[:110]} for x in sage_entry.get('roles', [])]
        twenty.append({'name': t['name'], 'routeV1': t['routeV1'], 'basisV1': t['basisV1'],
                       'machineRoleCandidates': t['roleCandidates'], 'sageRoles': t['sageRoles'],
                       'sageDetail': roles, 'theme': sage_entry.get('theme', ''),
                       'desc': desc_of(entry, 150)})
    (out / 'cross-check-20.json').write_text(json.dumps(
        {'record_type': 'q7-cross-check-20', 'count': len(twenty),
         'note': '20 件机器待核×Sage 有归位；逐件给内容摘要与 Sage 角色明细，供交叉核对与收口', 'items': twenty},
        ensure_ascii=False, indent=1) + '\n')

    summary = {
        'a': {'rows': len(hints), 'byDomain': hint_summary['byDomain'], 'byBasis': hint_summary['byBasis'],
              'unmappedCount': sum(1 for h in hints if not h['domainHint'])},
        'c': {k: {'available': v['available'], 'sampled': v['sampled']} for k, v in packet_c['classes'].items()},
        'b': {'population': len(qoder_un), 'sampled': len(picks), 'byBytes': packet_b['byBytes']},
        'crossCheck20': len(twenty),
        'frozenInputs': {str(p): hashlib.sha256(Path(p).read_bytes()).hexdigest()
                         for p in [LEDGER_CSV, PLAN, SPEC / '109-loop-ledger/loop-ledger-v1.csv']},
    }
    (out / 'q7-recon-summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
