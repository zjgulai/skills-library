#!/usr/bin/env python3
"""LB-7 复核登记表生成（零请求）：把主线两道关的产物汇成写回前需要的 register。

输入：sweep-report.json（candidate-sweep 产物）＋ schema-fixup-table.json ＋ selection.json
输出：lowband-lb7/review-register.json
用法：python3 -B make-review-register.py
"""
import json
from pathlib import Path

BASE = Path(__file__).resolve().parent
REPO = Path(__file__).resolve().parents[5]
SEL = json.loads((BASE / 'selection.json').read_text(encoding='utf-8'))
SW = json.loads((BASE / 'sweep-report.json').read_text(encoding='utf-8'))
FIX = json.loads((BASE / 'schema-fixup-table.json').read_text(encoding='utf-8'))

HELD = {'voice-selector'}
CALIBER = (
    'author/license 口径沿用 LB-3/LB-6 批：判者点名＋包内或祖先明文「值＋许可/署名措辞同现」才落；两者皆无转登记，不猜测填写。'
    '本带新增一条防线（2026-10-03）：祖先 README 若是否认句（例：MuseAI-Skills-main README.md:516「未为整份快照添加 MIT、Apache 等总许可」／'
    'README.en.md:516 同义英文）则**不构成出处**——取证窗口内出现否定形即判无据（license-provenance.NEG_LIC＋affirmed_window）。'
    '上游原件自带的 license/author 值一律视为上游原话，缺失正文只登记不删改。')

no_ev, removals = [], []
for r in SW['items']:
    if r['name'] in HELD:
        continue
    if r.get('no_evidence'):
        no_ev.append({'name': r['name'], 'fields': [f'missing field: {f}' for f in r['no_evidence']],
                      'checked': ['候选 SKILL.md 顶层与 metadata 无该字段',
                                  '包内（不含被写回的 SKILL.md 自身）无许可/署名明文',
                                  '库内祖先链（按 selection.relPath 定位）无 LICENSE/COPYING/NOTICE 或含许可段的 README；'
                                  '命中否定句者按无据处理'],
                      'disposition': '登记复核，不猜测填写'})
    if r.get('removed'):
        removals.append({'name': r['name'], 'removed': r['removed']})

fixes = [{'name': x['name'], 'add': x['add'],
          'source': ('判者点名缺 schema 三件套；库内原件无版本可继承 ⇒ 取本带候选主值 1.0.0（90 件已填中 83 件）'
                     if list(x['add']) == ['version'] else
                     'version 同上；compatibility 按包内脚本实际 import（csv/io/json/os/sys，零依赖、离线、--self-test 可自证）'
                     '与正文「代理执行、不接外部服务」声明写')}
         for x in FIX['items']]
fixes.append({'name': 'paper-sync', 'add': {'license': 'MIT'},
              'source': '判者靶单点名缺 license＋E5 反查命中祖先 paper_to_skills/README.md'
                        '「## 📜 许可证 | License」段的 [MIT License](LICENSE)（affirmed_window 判为肯定句）。'
                        '注：该族库内 9 份 SKILL.md 只有 1 份带 license，同族先例不足以作证，'
                        '此条纯按祖先明文落，不援引先例'})

out = {
    'record_type': 'p2_lb7_review_register',
    'scope': 'lb7',
    'at': '2026-10-03',
    'caliber': CALIBER,
    'no_evidence': no_ev,
    'evidence_based_fixes': fixes,
    'structural_fixes': [
        {'name': 'speech-synthesis',
         'finding': '候选 frontmatter 曾填 `license: MIT`，唯一出处是原包 DISTRIBUTION.md（「## 许可协议 / MIT 许可协议 - 详见 LICENSE 文件」），'
                    '而该文件正是判者点名的打包副产物（连同 _meta.json／skill-info.json／install.sh 一并移除，且其指向的 LICENSE 在包内从来不存在）',
         'action': '剥除 `license: MIT`（库内原件本无该字段＝恢复上游原状），并在「未做的事（登记）」保留历史出处说明；'
                   '补出处的正确动作是上游随包附 LICENSE，不替它造',
         'lesson': '删除有出处的证据件与新增依赖该证据的字段是两个独立动作，必须同批核'},
        {'name': 'grill-with-docs / glab-duo / glab-version',
         'finding': '交付文档的「来源」注记里写了技能库内部路径（skills-mactt/…、skills/kimi/skills/gitlab-cli-guide/…），'
                    '判者本带对同类问题给过 error 级（ticketmaster「硬编码外部路径破坏自包含性」）',
         'action': '改为不带可定位路径的出处表述（同族姊妹件、不随本包发布，只记出处）'},
        {'name': 'ticketmaster',
         'finding': 'references/presentation.md 正文两处按上游写法活引用 `references/flights.md`，该件属上游 booking 包、不随本包发布',
         'action': '加 `[not bundled in this package — fall back to the hierarchy below]` 回退注记，并在文件头 provenance 说明里补一句处置口径'},
    ],
    'removals_vs_library': removals,
    'instrument_notes': [
        'candidate-sweep.py 负控电池 13 项全过（含「署名不认许可套话」「移除件散文登记不判红」「未突变副本不红」两条反向与一条正序控制）',
        'license-provenance 的否定句防线经成对控制：反例 MuseAI ticketmaster/notion hits=0；'
        '正例 glab-attestation（标题与值分行的祖先 README）／paper-sync／huashu LICENSE／huashu 署名 hits>0',
        '跨批审计在该防线落地后重跑，唯一翻案＝lowband-lb3 function-health（已写回库内），并入 #31 待处置清单',
    ],
}
(BASE / 'review-register.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
print(f"no_evidence={len(no_ev)} 件 | evidence_based_fixes={len(fixes)} | removals={len(removals)} 件")
