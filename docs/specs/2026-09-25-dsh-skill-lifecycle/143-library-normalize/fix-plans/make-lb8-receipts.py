#!/usr/bin/env python3
"""LB-8 批回执生成（recert＋writeback 两份；从 closeout/plans 程序化取数）。幂等：覆盖写。"""
import json, pathlib, collections

NORM = pathlib.Path('docs/specs/2026-09-25-dsh-skill-lifecycle/143-library-normalize')
LB8 = NORM / 'lowband-lb8'
REC = NORM / 'receipts'

# —— 复评（recert）逐段取数 ——
segs = [
    ('pilot10（校准确认；r1744–r1753＋r1755 重试）', {'items': 10, 'legs': 12, 'tokens': 1128141, 'attempts': 144,
        'closed': 10, 'open': 0, 'note': '8/10 首评收口＋2 件 gen2 补丁（competitive-brief 96.0／messenger-read 88.5）'}),
]
def load(name):
    return json.loads((LB8 / name).read_text(encoding='utf-8'))

w1 = load('wave1-closeout.json'); g28 = load('gen2-8-closeout.json'); g3 = load('gen3-closeout.json')
w2a = load('wave2a-closeout.json'); w2ar = load('wave2a-remedy-closeout.json')
w2b = load('wave2b-closeout.json'); w2br = load('wave2b-remedy-closeout.json'); w2br2 = load('wave2b-remedy2-closeout.json')

def spend(d):
    s = d['summary']; return {'tokens': s['grandTotalTokensAudit'], 'attempts': s['attemptsAllLegs']}

segs += [
    ('wave1（批 C-F 24 件；r1756–r1779）', {**{'items': 24, 'legs': 24, 'closed': w1['summary']['certifiedKeep'],
        'open': len(w1['summary']['openItems'])}, **spend(w1)}),
    ('gen2-8（wave1 未闭 8 件定向补丁重跑；r1781/83/84/86/87）', {**{'items': 8, 'legs': 8, 'closed': g28['summary']['certifiedKeep'],
        'open': len(g28['summary']['openItems'])}, **spend(g28)}),
    ('gen3（残余 3 件三轮补丁重跑；r1812–r1814）', {**{'items': 3, 'legs': 3, 'closed': g3['summary']['certifiedKeep'],
        'open': len(g3['summary']['openItems'])}, **spend(g3)}),
    ('wave2a（批 G-J 24 件；r1788–r1811）', {**{'items': 24, 'legs': 24, 'closed': w2a['summary']['certifiedKeep'],
        'open': len(w2a['summary']['openItems'])}, **spend(w2a)}),
    ('wave2a-remedy（comp-analysis 同轮重跑＋3 件补丁；r1792R/r1815–17）', {**{'items': 4, 'legs': 4,
        'closed': w2ar['summary']['certifiedKeep'], 'open': len(w2ar['summary']['openItems'])}, **spend(w2ar)}),
    ('wave2b（批 K-N 24 件；r1818–r1841）', {**{'items': 24, 'legs': 24, 'closed': w2b['summary']['certifiedKeep'],
        'open': len(w2b['summary']['openItems'])}, **spend(w2b)}),
    ('wave2b-remedy（paper-review 同轮重跑＋2 件补丁；r1828R/r1842–43）', {**{'items': 3, 'legs': 3,
        'closed': w2br['summary']['certifiedKeep'], 'open': len(w2br['summary']['openItems'])}, **spend(w2br)}),
    ('wave2b-remedy2（paper-review 补丁重跑；r1844）', {**{'items': 1, 'legs': 1, 'closed': w2br2['summary']['certifiedKeep'],
        'open': len(w2br2['summary']['openItems'])}, **spend(w2br2)}),
]

tokens = sum(s['tokens'] for _, s in segs)
attempts = sum(s['attempts'] for _, s in segs)
# 各段 open 均为中间态（被后续补救段闭环）；终态由最终段复核＝0
final_open = 0
final_closed = 82
assert all(s['open'] == 0 for n, s in segs if n.startswith('wave2b-remedy2')), '终段仍有 open'
void_extra = w2ar['summary'].get('voidExtraTokensAudit', 0) + w2br['summary'].get('voidExtraTokensAudit', 0)
rec = {
    'record_type': 'p2_lb8_receipt',
    'at': '2026-10-04',
    'scope': '低带补齐批 LB-8：wave-1 的 82 件 <85 遗留全链（校准 10＋放量 72；轮号 r1744–r1844）',
    'method': '逐件：整包修复候选 → candidate-sweep 复核 → 单跑复评；未过者定向补丁（gen2/gen3）重试；void 移档同轮重跑；波次制（制作与复评流水），写回段独立。成本＝审计口径（四字段和）＋voidExtra。',
    'summary': {
        'items': 82, 'evalRuns': sum(s['legs'] for _, s in segs),
        'finalClosed': 82, 'finalOpen': final_open, 'voidsRemaining': 0,
        'tokensAuditTotal': tokens, 'attemptsTotal': attempts,
        'tokensPerItem': round(tokens / 82, 1),
        'voidExtraIncluded': void_extra,
        'note': 'tokensAuditTotal＝各段 closeout 的 grandTotalTokensAudit 之和（含全部重跑腿与 voidExtra；不含 pilot 的 r1754 空窗口试探与 untrackedEstimate，见 §9e）',
    },
    'segments': [{'segment': n, **s} for n, s in segs],
}
(REC / 'p2-lb8-receipt.json').write_text(json.dumps(rec, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')

# —— 写回逐计划取数 ——
wb_dirs = [LB8 / 'writeback-pilot10', LB8 / 'writeback-wave1', LB8 / 'writeback-wave2a', LB8 / 'writeback-wave2b']
ops = collections.Counter(); plans = 0; items = set()
for d in wb_dirs:
    for pf in sorted(d.glob('plan-*.json')):
        p = json.loads(pf.read_text(encoding='utf-8'))
        plans += 1
        for o in p['ops']:
            ops[o['kind']] += 1
        items.add(pf.stem[len('plan-'):])
wb = {
    'record_type': 'p2_lb8_writeback_receipt',
    'at': '2026-10-04',
    'scope': 'LB-8 全批 82 件的库面写回（pilot10 10＋wave1 24＋wave2a 24＋wave2b 24；对照四份 writeback-summary.json）',
    'authorization': '用户「放量」（整段波次授权含写回段；各段先 dry-run 后 apply，逐段回执）',
    'executed': {
        'plans': plans, 'refusals': 0, 'failed': 0,
        'dry_run_first': '每计划先 dry-run（0 拒）后 apply（0 拒）',
        'backup_roots': 'skill-lifecycle/trial-home/library-backup-writeback-<name>-lb8{,-w2a,-w2b,-pilot10}-2026-10-04（＋两处 rename 专用根）',
        'ops': {'put': ops['put'], 'remove': ops['remove'], 'prune_empty_dirs': ops['prune-empty-dirs']},
    },
    'verification': {
        'L1': '逐段全量逐字节（target==candidate，不抽样）＋removes 无残留＋无空目录壳',
        'L5': 'pilot10 10/10 PASS（messenger-companion 新路径装载）／wave1 23PASS＋1 预期拒载（ask-matt）／wave2a 24/24／wave2b 23PASS＋1 预期拒载（implement-spec）；paper-review 改名后按新路径复跑 PASS',
        'screen': 'high 7→7（wave1）→8（wave2a 登记 1：huashu-agent-swarm doc-token 类）→8（wave2b 零新增零变化）→8（pilot10 零新增零变化）；NAME_FOLDER_MISMATCH 经三处治理修正（complex-skill 夹具、paper-review 改名、messenger-read 改名）清零；collisions 0；clusters 8→6（描述更新所致，非 finding）',
    },
    'transparency': {
        'governance_fixes_post_writeback': [
            'complex-skill RED 夹具目录 baseline-unguided→weekly-ads-reconciliation（name==folder 对齐；11 put/1 remove/L1）',
            'paper-review 目录 paper-review→paper-skill-reviewer-crossborder（executor 双计划；旧根空壳 rmdir 收尾并登记）',
        ],
        'registered_high': 'huashu-agent-swarm DANGEROUS_COMMAND（sudo doc/meta 3 处；库内同类 4 例遗留共存，留待库级专项）',
        'registered_author': 'email-sequence「Genspark」/glab-ci、glab-job、glab-api「vince-winkintel」（来源标识机制；E3 登记接受类）',
        'note': 'r1828-void1（429）与 r1792-void1 成本经 voidExtra 并入对应 closeout；无未归属改动',
    },
}
(REC / 'p2-lb8-writeback-receipt.json').write_text(json.dumps(wb, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')

print('tokens total:', tokens, '| attempts:', attempts, '| plans:', plans, '| ops:', dict(ops))
print('written:', REC / 'p2-lb8-receipt.json', '&', REC / 'p2-lb8-writeback-receipt.json')
