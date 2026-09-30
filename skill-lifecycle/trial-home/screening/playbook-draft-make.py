#!/usr/bin/env python3
"""105-012 首批 8 家族 Playbook 起草生成器（零请求）。

输入：114-w3-family/family-definitions-v1.json（家族/岗位/技能）
     109-loop-ledger/loop-ledger-v1.csv（技能闭环状态与更新态）
     108-w2-classification/role-candidates-review.json（岗位标题/面）
     114-w3-family/playbook-template-v1.md（冻结模板的结构约束）
输出：115-w3-playbooks/playbook-DOM-0X-<家族名>.md ×8 ＋ playbook-verify.json
验证：① 技能交叉引用存在；② 交接四要素齐备；③ §6 之外无权限措辞。

用法：python3 -B playbook-draft-make.py
"""
import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SPEC = ROOT / 'docs/specs/2026-09-25-dsh-skill-lifecycle'
OUT = SPEC / '115-w3-playbooks'

defs = json.loads((SPEC / '114-w3-family/family-definitions-v1.json').read_text(encoding='utf-8'))
ledger = {r['name']: r for r in csv.DictReader(
    (SPEC / '109-loop-ledger/loop-ledger-v1.csv').open(encoding='utf-8-sig'))}
review = json.loads((SPEC / '108-w2-classification/role-candidates-review.json').read_text(encoding='utf-8'))
role_info = {r['roleId']: r for r in review['roles']}

skill_primary_family = {}
for f in defs['families']:
    for s in f['skillsPrimary']:
        skill_primary_family[s] = f['name']

GROUP_SRC = {'A': '81-Skills', 'B': '角色候选', 'C': '平铺试点'}

def score_pair(reading):
    m = re.match(r'^\s*(\d+(?:\.\d+)?/\d+(?:\.\d+)?)', reading or '')
    return m.group(1) if m else ''

# —— 家族叙事（人工撰写；表中数据由台账生成）——
NARR = {
'经营与组织': {
 'position': '把经营目标、优先级与资源约束转成可对照的经营节奏与决策材料，并让独立复核保持可见；让"目标—资源—复盘—改进"成为同一条可追踪的线。',
 'questions': ['目标与资源是否匹配；重大资源取舍需要哪些依据材料', '经营偏差如何归因、复盘与形成改进动作线索', '内控与独立复核的发现如何进入整改与跟踪'],
 'boundary': '不含各业务域的具体执行判断（渠道、供应、产品、品牌、服务各有家族）；不含对外的资金、承诺与岗位处置动作——这类动作一律准备材料后交相应有权责任方。',
 'seam': '向全部 8 家族收取月度经营事实（引用各家族产物版本）；与数据与AI运行家族对接口径与数据供给（口径与缺口处置见交接 A③）。',
 'flow': [
  ('季度/年度开始', '按目标拆解与资源情景比较形成经营节奏材料（建议稿）', '目标与资源情景材料 v1', '经营与组织记录'),
  ('月度', '汇总各家族经营事实，做偏差归因与复盘材料', '月度复盘材料 v1', '同上'),
  ('复盘后', '把改进线索按责任域回给相应家族，跟踪到反馈', '改进线索清单 v1', '同上'),
  ('持续', '内控与独立复核安排：抽样核对关键控制与证据', '复核记录 v1', '复核档案'),
 ],
 'handoffs': [
  {'id': 'A', 'scene': '月度经营复盘材料 — 经营分析（AGT-003）→ 经营目标与资源统筹（AGT-001）',
   'input': '各家族月度事实与自身产物（渠道经营周月表 v1、账务结账包 v1、供给方案 v1 等，注明生成日与版本）',
   'use': '用于复盘材料准备与下一周期资源情景比较；涉及资源调整只出"建议稿"，由相应有权责任方决定',
   'dispute': '数据缺口退回数据供给职责补版本；口径分歧提请口径与对象关系治理（AGT-045）核对；未决期间材料保持"未决"标记',
   'accept': '来源可追溯、版本齐全、关键数字可复算、缺口有显式标注'},
  {'id': 'B', 'scene': '内控复核发现 — 内控审计与独立复核（AGT-005）→ 相应责任域',
   'input': '复核记录与证据包 v1（含抽样范围与方法）',
   'use': '用于整改材料准备与再核对安排；整改动作由相应责任域在其职责范围内推进',
   'dispute': '对发现本身有异议时保留双方记录，提请跨职责核对后再行动；不得默认通过',
   'accept': '发现可复现、证据链完整、范围与未覆盖项写明'},
 ],
 'exception': [('关键经营事实无法取得', '标"未决"并列出缺件清单，不估算替代', '经营与组织记录', '数据供给职责（AGT-046）'),
               ('跨家族资源冲突', '形成情景对比材料，不自行取舍', '经营与组织记录', '相应有权责任方')],
},
'产品与创新': {
 'position': '把机会整理成可验证的产品要求与样品证据链：从机会与商业论证材料，到可检验的产品要求、样品与验证结论。',
 'questions': ['机会与人群问题是否有可追溯依据', '产品要求与验收条件是否可检验、可实现', '样品与验证结论的证据强度与适用边界'],
 'boundary': '不含供应与交付承诺（供应与履约家族）；不含对客上架与传播动作（渠道经营/品牌与增长家族）；不含用验证意图替代效果结论。',
 'seam': '接收经营与组织家族的目标/资源材料与需求侧证据；产物交供应与履约、渠道经营、品牌与增长使用（见交接 A/B）。',
 'flow': [
  ('机会出现', '整理机会与人群问题证据，形成立项材料（引用需求证据与情景）', '产品立项材料 v1', '产品与创新记录'),
  ('立项后', '定义产品要求、约束与验收条件，标注未决项', '产品要求 v1', '同上'),
  ('实现中', '与供应侧实现协作，按版本维护要求变更记录', '要求变更记录 v1', '同上'),
  ('样品/测试后', '整理验证结论与缺陷清单，注明覆盖与未覆盖', '验证结论 v1', '同上'),
 ],
 'handoffs': [
  {'id': 'A', 'scene': '产品要求 → 实现协作（设计/工程/供应侧）',
   'input': '产品要求 v1（含验收条件、约束、未决项清单与生成日）',
   'use': '用于实现方案与样品制作；实现完成不等于验证通过',
   'dispute': '要求歧义回产品定义职责澄清并出新版本；未决项不得在实现中被默认填值',
   'accept': '要求可检验、约束可执行、变更历史完整'},
  {'id': 'B', 'scene': '验证结论 → 上市经营策划（渠道/品牌侧）',
   'input': '验证结论 v1（验证对象/条件、覆盖与依据、缺陷与未验证项）',
   'use': '用于上市安排的事实输入；不得对外扩展为功效承诺',
   'dispute': '证据不足时保留"未验证"表述，补证方案另列；分歧提请相应职责核对',
   'accept': '结论不超出证据范围、未验证项有显式清单'},
 ],
 'exception': [('供应商样品与要求不一致', '记录差异并回实现协作，不修改要求迁就样品', '产品与创新记录', '供应与履约家族'),
               ('验证发现需求证据薄弱', '回需求侧补证，结论标注适用边界', '产品与创新记录', '需求研究职责（AGT-006）')],
},
'供应与履约': {
 'position': '把需求变成可兑现的承诺：需求预测、供给安排、供应商协同、生产质量、物流仓储到退货处置的兑现链。',
 'questions': ['预测情景与供给方案是否说明了兑现条件', '承诺在途与库存占用是否互相可见', '质量与履约异常如何回收处理'],
 'boundary': '不含对客承诺与渠道动作（渠道经营家族）；不含账务确认（财务与合规家族）；价格与促销安排由定价职责处理。',
 'seam': '接收渠道经营的可售需求与退货事实；产物（供给方案、可售口径）交渠道经营引用（见交接 A），退货与质量事实交产品与服务侧（见交接 B）；成本事实由财务与合规按需取用。',
 'flow': [
  ('需求变化', '按预测情景形成供给安排建议，注明兑现条件', '供给方案 v1', '供应与履约记录'),
  ('采购/生产', '供应商协同与生产质量跟踪，记录偏差', '履约跟踪表 v1', '同上'),
  ('入仓前后', '库存与效期管理，核对可售口径', '可售核对表 v1', '同上'),
  ('售后退货', '退货与不良品处置记录，回流质量反馈', '退货处置记录 v1', '同上'),
 ],
 'handoffs': [
  {'id': 'A', 'scene': '供给方案 → 渠道经营（可售与上架安排）',
   'input': '供给方案 v1（版本、数量、时间、交付范围与成本条件；区分计划/承诺/实际）',
   'use': '用于渠道上架与可售口径核对；计划不等于可售',
   'dispute': '时间或数量变更出新版本并通知；冲突提请上市经营责任方核对',
   'accept': '兑现条件写明、在途与占用可见、变更留痕'},
  {'id': 'B', 'scene': '退货与质量事实 → 产品与创新 / 服务与体验',
   'input': '退货处置记录与不良样本描述 v1（含批次与时间窗）',
   'use': '用于产品改进线索与售后口径核对',
   'dispute': '质量问题边界不清时保留实物与记录，提请产品验证职责参与判断',
   'accept': '批次可追溯、数据口径标注、样本保留方式写明'},
 ],
 'exception': [('在途延误', '更新供给版本并通知下游家族，重排可售口径', '履约跟踪表', '渠道经营家族'),
               ('质检不合格批次', '隔离并登记，处理意见交相应职责', '退货处置记录', '质量控制职责（AGT-018）')],
},
'渠道经营': {
 'position': '让每个平台、站点与渠道的经营事实可见、可比、可持续：上架与价格执行、流量与转化、账号健康，直至与供应/财务的交接。',
 'questions': ['各渠道经营事实是否按统一口径可见', '价格与促销的实际执行是否与方案一致', '平台规则与账号健康风险是否被及早发现'],
 'boundary': '不含品牌主张与素材主张（品牌与增长家族）；不含售后补救动作（服务与体验家族）；平台结算的"事实采集"在渠道经营，账务"确认与对账"在财务与合规（结算边界句，两家族同写）。',
 'seam': '接收供应与履约的可售口径、品牌与增长的内容素材；产物（渠道经营表、结算事实）交供应、财务与合规引用（见交接 A/B）。',
 'flow': [
  ('上架准备', '按供给口径与商品资料准备上架材料，核对资料版本', '上架材料 v1', '渠道经营记录'),
  ('日常经营', '按渠道口径维护经营表（流量/转化/履约/账号健康）', '渠道经营表 v1', '同上'),
  ('价格与促销', '核对方案与执行的一致性，发现偏差登记', '执行核对记录 v1', '同上'),
  ('周期交接', '把结算事实与经营事实交下游（财务/供应）', '结算事实包 v1', '同上'),
 ],
 'handoffs': [
  {'id': 'A', 'scene': '平台结算事实 — 渠道经营 → 财务与合规（对账用）',
   'input': '结算事实包 v1（平台结算单、周期、币种与口径备注；只做事实采集与整理）',
   'use': '用于账务确认与对账（财务与合规职责）；渠道侧不作账务结论',
   'dispute': '金额或周期差异先两侧复核原始凭证；仍不一致提请账务对账职责登记差异行',
   'accept': '与平台原始记录一致、周期与币种明确、差异有登记'},
  {'id': 'B', 'scene': '渠道经营事实 → 供应与履约（补货与可售）',
   'input': '渠道经营周/月表 v1（SKU 级动销、缺货与退货线索）',
   'use': '用于需求预测与补货安排输入',
   'dispute': '数据缺口走数据供给补版本；口径争议提请口径治理（AGT-045）核对',
   'accept': '缺口标注完整、口径与经营口径表一致'},
 ],
 'exception': [('账号或平台规则异常', '登记事实与影响范围，准备申诉材料；提交与跟进按相应职责安排', '渠道经营记录', '店铺账号健康职责（AGT-027）'),
               ('价格执行与方案不符', '先核对再登记差异行，不自行改价', '执行核对记录', '定价职责（AGT-026）')],
},
'品牌与增长': {
 'position': '让品牌心智与增长投入可对照：从定位与主张、内容与素材，到投放、实验与留存运营，沉淀可复用的判断。',
 'questions': ['品牌主张是否有依据、可适用、版本明确', '内容与投放是否引用正确的产品事实与准入条件', '实验与投放结论是否给出适用边界'],
 'boundary': '不含产品功效的事实认定（产品与创新家族）；不含价格与促销安排的最终执行（渠道/定价职责）；不含品牌主张当作产品证明。',
 'seam': '接收产品与创新的验证事实、渠道经营的经营事实；产物（内容方案、投放方案、实验结论）交渠道执行与经营复盘引用（见交接 A/B）。',
 'flow': [
  ('品牌工作', '维护定位与主张的表达准则（引用依据与版本）', '品牌表达准则 v1', '品牌与增长记录'),
  ('内容工作', '按受众问题与上市目标准备内容方案与素材', '内容方案 v1', '同上'),
  ('投放工作', '形成投放方案（范围、预算、版本依据）并记录执行结果', '投放方案与结果 v1', '同上'),
  ('实验与留存', '整理实验方案与效果判断，维护留存运营线索', '实验结论 v1', '同上'),
 ],
 'handoffs': [
  {'id': 'A', 'scene': '品牌表达准则 → 内容与渠道执行',
   'input': '品牌表达准则 v1（定位、核心主张、表达边界与适用渠道）',
   'use': '用于内容与素材制作、渠道表达核对',
   'dispute': '渠道与文化适配需要变体时，记录适配理由与版本；不得改动事实依据',
   'accept': '依据可追溯、主张与产品事实分列、版本明确'},
  {'id': 'B', 'scene': '投放与实验结论 → 经营复盘与相应责任方',
   'input': '投放方案与结果 v1、实验结论 v1（含观察窗口与适用边界）',
   'use': '用于经营复盘事实输入与下一步建议材料；预算调整由相应有权责任方决定',
   'dispute': '效果归因分歧保留方法与原始读数，提请效果评估职责核对',
   'accept': '方案/执行/结果分列、口径与数据来源写明'},
 ],
 'exception': [('素材与品牌准则冲突', '登记冲突点与证据，回准则维护职责出新版本', '品牌与增长记录', '品牌战略职责（AGT-029）'),
               ('投放效果异常波动', '先核对数据供给与口径，再登记异常与影响范围', '投放方案与结果', '经营实验与效果评估职责（AGT-035）')],
},
'服务与体验': {
 'position': '把购买前后的体验与反馈变成可处理的线索：售前指导、客诉处理材料、体验洞察与会员教育。',
 'questions': ['客诉与体验反馈是否被结构化回收', '反馈线索是否回到产品、供应与渠道形成改进输入', '服务口径是否与售后承诺一致'],
 'boundary': '不含退款与补偿的决定（相应有权责任方）；不含产品缺陷认定（产品验证职责）；客诉处置动作按各渠道既有职责推进。',
 'seam': '接收渠道经营的订单与退货事实、供应侧的处置记录；体验洞察交产品与创新、供应与履约与渠道经营核对（见交接 A）。',
 'flow': [
  ('售前', '整理购买指导与常见问题材料（引用商品资料版本）', '售前材料 v1', '服务与体验记录'),
  ('售中后', '客诉受理与处理材料整理，标注处理状态', '客诉处理材料 v1', '同上'),
  ('周期', '体验洞察：把反馈聚类为可行动的改进线索', '体验洞察 v1', '同上'),
  ('持续', '会员与教育内容维护，回收使用反馈', '会员内容 v1', '同上'),
 ],
 'handoffs': [
  {'id': 'A', 'scene': '体验洞察 → 产品与创新 / 供应与履约 / 渠道经营',
   'input': '体验洞察 v1（聚类主题、样本量、时间窗与原始反馈引用）',
   'use': '用于产品改进线索与履约、渠道流程核对；不作为缺陷或合规结论',
   'dispute': '主题归属分歧保留原始样本，提请相应领域核对后使用',
   'accept': '样本与口径写明、结论不超出反馈范围、改进去向可追踪'},
 ],
 'exception': [('客诉情绪升级或大额争议', '记录事实与时间线，准备材料；处理与承诺交相应有权责任方', '客诉处理材料', '相应责任方'),
               ('退款/补偿诉求', '按渠道既有流程记录与转办，不作决定', '客诉处理材料', '财务与合规/渠道既有职责')],
},
'财务与合规': {
 'position': '把交易与合同事实转成可复核的账务、现金与合规控制：月结与对账、报表、现金与跑道、合规检查与审计材料。',
 'questions': ['账务与现金事实是否可复核、可对账', '经营单位经济与跑道是否支持当期决策', '合规控制（条款/隐私/账号）是否覆盖当前业务事实'],
 'boundary': '不含正式的会计/法律结论（由相应专业人士出具）；平台结算的"事实采集"在渠道经营、"确认与对账"在本家族（结算边界句，两家族同写）；不含对外的合同或文书落笔与款项动作。',
 'seam': '接收渠道经营的结算事实、供应与履约的成本事实、经营与组织家族的目标材料；产物（结账包、合规检查清单）交经营复盘与相应责任方（见交接 A/B）。',
 'flow': [
  ('月结', '按既有节奏做月结与对账，形成结账包', '结账包 v1', '财务与合规记录'),
  ('报表', '生成三表与单位经济材料，标注口径与可信度', '报表与单位经济材料 v1', '同上'),
  ('现金', '维护现金与跑道视图，标注兑现条件与风险', '现金与跑道视图 v1', '同上'),
  ('合规检查', '按周期检查条款/隐私/平台规则适用面，列专业确认项', '合规检查清单 v1', '同上'),
 ],
 'handoffs': [
  {'id': 'A', 'scene': '结账包 → 经营分析 / 税务协作',
   'input': '结账包 v1（对账表、差异行、口径备注；生成日与范围）',
   'use': '用于经营复盘材料与税务协作准备；对外报送由相应职责与专业人士处理',
   'dispute': '差异行未清时保持"未决"，不得静默并入；口径分歧提请口径治理核对',
   'accept': '勾稽复算通过、差异行有登记与去向、来源可追溯'},
  {'id': 'B', 'scene': '合规检查清单 → 相应责任域',
   'input': '合规检查清单 v1（适用面、发现项、专业确认项清单；核验日期）',
   'use': '用于相应责任域准备整改材料；法律结论由专业人士出具',
   'dispute': '义务边界不清时保留两种理解并列明依据，提请专业人士核对',
   'accept': '发现项有原文引用、核验日期写明、专业确认项单独列出'},
 ],
 'exception': [('对账差异超期未清', '升级为待核对项并列出两侧凭证，保持未决状态', '结账包差异行', '账务对账职责（AGT-040）'),
               ('疑似合规变化', '记录变化线索与影响面，列专业确认项', '合规检查清单', '产品合规职责（AGT-044）')],
},
'数据与AI运行': {
 'position': '让口径、数据、集成与运行底座可靠：对象与口径约定、数据供给与质量、集成工具、知识与技能治理、平台运行检查。',
 'questions': ['同一口径是否只有一个家、变更是否可追溯', '数据缺口的修复是否定向且留痕', '技能与 Preset 资产是否与其定稿版本一致'],
 'boundary': '不含业务口径的含义判断（对应业务域负责含义，本家族维护约定与协调）；不含对模型的评测结论作业务结论；平台改动类动作按相应权限安排。',
 'seam': '向全部家族供给口径与数据（引用版本与质量说明）；缺口反馈入向见交接 A、装配回填出向见交接 B。',
 'flow': [
  ('口径工作', '维护对象关系与口径约定，记录变更与适用面', '口径约定 v1', '数据与AI运行记录'),
  ('数据供给', '按用途供给数据并附质量说明；异常时定向修复', '数据供给单 v1', '同上'),
  ('集成与工具', '维护集成与业务工具的可用性检查，记录影响', '运行检查记录 v1', '同上'),
  ('知识与技能', '维护技能资产的版本与装配一致；回收使用反馈', '技能资产台账 v1', '同上'),
 ],
 'handoffs': [
  {'id': 'A', 'scene': '数据供给 → 使用方（分析/经营职责）',
   'input': '数据供给单 v1（来源、版本、适用范围与质量说明；口径引用）',
   'use': '用于分析与经营材料的事实输入；使用方负责其用途适格性',
   'dispute': '用途与口径不符时先核对用途定义，必要时新增口径而非静默混用',
   'accept': '来源与版本可追溯、质量与缺口说明完整、口径引用明确'},
  {'id': 'B', 'scene': '技能资产变动的装配回填反馈 → 使用家族',
   'input': '装配回执与历史归档引用（技能名、版本摘要、日期）',
   'use': '用于使用家族确认所用技能版本；行为变化以被评字节为准',
   'dispute': '版本分歧以库内件与装配根逐字节核对为准；不得以自报版本替代',
   'accept': '版本摘要与回执一致、变更历史可回溯'},
 ],
 'exception': [('数据异常影响扩大', '按用途圈定受影响范围，记录修复与更正依据', '数据供给单', '数据工程与质量职责（AGT-046）'),
               ('口径冲突', '并列两种理解与适用范围，提请口径治理核对后统一', '口径约定', '业务口径与主数据职责（AGT-045）')],
},
}

# 作业流逐步技能标注（评审修订：步骤须点名所用技能；无专用技能者如实说明）
FLOW_SKILLS = {
'经营与组织': ['ecommerce-quarterly-strategy、okr-planner', 'ecommerce-monthly-review、variance-analysis',
                'triage、risk-assessment', 'fact-check、performance-review'],
'产品与创新': ['customer-research、competitor-profiling', 'idea-to-prd、product-scope',
                'product-design、work-handoff', 'market-viability-logic-auditor、jtbd-analyzer'],
'供应与履约': ['inventory-demand-forecaster、supply-chain-controller', 'contract-review、product-data-deep-analysis',
                'ecommerce-ops、shipment-tracking', 'customer-escalation、international-shipping-customs'],
'渠道经营': ['multi-platform-listing-generator、amazon-listing-expert', 'amazon-competitor-monitor、amazon-sorftime-research、platform-price-monitor',
                'pricing-strategy、margin-analyzer', '（无专用技能，结算以平台原始记录与经营表为准）'],
'品牌与增长': ['brand-narrative-playbook、brand-voice-glossary', 'content-strategy、copywriting、ad-creative',
                'paid-advertising、creator-marketing', 'split-test-evaluator、retention-manager'],
'服务与体验': ['customer-reply-craft、product-attribute-analyzer', 'ticket-deflector',
                'bestseller-pattern-decoder、community-engagement', 'community-ops、content-system'],
'财务与合规': ['close-month、reconciliation', 'financial-statements、financial-modeling、journal-entry-prep',
                'cash-flow-snapshot、runway-calculator、unit-economics', 'tos-risk-checker、legal-risk-assessment'],
'数据与AI运行': ['terminology-standardizer、ddd-glossary-gen', 'data-context-extractor、validate-data、dataset-health-audit',
                'api-doc-gen、incident-retrospective、log-diagnostic', 'skill-creator、skill-evaluator、skill-optimizer、skill-structure-doctor'],
}

BEGIN = '<!-- BEGIN-GENERATED-TABLE -->'
def role_label(rid):
    info = role_info.get(rid)
    return f"`{rid}` {info['name']}" if info else f"`{rid}`"

files_written = []
report = {'families': []}

for fam in defs['families']:
    name = fam['name']
    nar = NARR[name]
    roles_md = '\n'.join(
        f"| `{r['id']}` | {r['name']} | {r['title']} | frozen-v1 · 面：{r['plane']} |" for r in fam['roles'])
    skill_rows = []
    crossref_ok = True
    for s in fam['skillsPrimary']:
        row = ledger.get(s, {})
        cands = [c for c in (row.get('roleCandidates') or '').split(';') if c.strip()]
        mine = [c for c in cands if any(r['id'] == c for r in fam['roles'])]
        score = score_pair(row.get('optReadings', ''))
        state = row.get('optState', '?') + (f" · {score}" if score else '')
        skill_rows.append(f"| `{s}` | {'、'.join(role_label(c) for c in mine)} | {GROUP_SRC.get(row.get('group'), '?')} | {state} | roleCandidates: {';'.join(cands)} |")
    for s in fam['skillsCrossRef']:
        row = ledger.get(s, {})
        cands = [c for c in (row.get('roleCandidates') or '').split(';') if c.strip()]
        owner = skill_primary_family.get(s, '?')
        mine = [c for c in cands if any(r['id'] == c for r in fam['roles'])]
        who = ('、'.join(role_label(c) for c in mine) if mine
               else (role_label(cands[0]) if cands else ''))
        who = f'{who}（引用）' if who else '（引用）'
        score = score_pair(row.get('optReadings', ''))
        state = row.get('optState', '?') + (f" · {score}" if score else '')
        skill_rows.append(f"| `{s}` | {who} | {GROUP_SRC.get(row.get('group'), '?')} | {state} | 共享（主域：{owner}） |")

    fs = FLOW_SKILLS.get(name, [])
    flow_md = '\n'.join(
        (f"| {i+1} | {a} | {b}{(fs[i] if fs[i].startswith('（') else f'（用 {fs[i]}）')} | {c} | {d} |" if i < len(fs) else f"| {i+1} | {a} | {b} | {c} | {d} |")
        for i, (a, b, c, d) in enumerate(nar['flow']))
    hand_md = []
    for h in nar['handoffs']:
        hand_md.append(f"""### 交接 {h['id']}：{h['scene']}

| 要素 | 内容 |
|---|---|
| **① 输入产物及版本** | {h['input']} |
| **② 接收方与用途** | {h['use']} |
| **③ 缺失/争议处置** | {h['dispute']} |
| **④ 验收标准** | {h['accept']} |""")
    exc_md = '\n'.join(f"| {a} | {b} | {c} | {d} |" for a, b, c, d in nar['exception'])

    extra = ''
    if name == '渠道经营':
        extra = '\n> 跨域件说明：共享件（如 `compliance-check`、`compliance-tracking`）主域在财务与合规侧、版本由主域家族维护，本家族只引用；结算边界句见 §1。'
    if name == '财务与合规':
        extra = '\n> 跨域件说明：`compliance-check`、`compliance-tracking`、`compliance-audit` 主域在本家族（版本由本家族维护，评审例外表见 family-definitions `reviewOverrides`）；`contract-review`（主域：供应与履约）、`margin-analyzer`（主域：渠道经营）为共享件、本家族只引用；结算边界句见 §1。'

    planes = []
    for r in fam['roles']:
        if r['plane'] not in planes:
            planes.append(r['plane'])

    md = f"""# {fam['id']} {name} Playbook — v1

## 0. 元数据

| 字段 | 值 |
|---|---|
| family_id | `{fam['id']}` |
| 家族名 | {name} |
| 面 | {'、'.join(planes)}（成员岗位所在面） |
| 版本 | v1（2026-10-01 定稿） |
| 维护角色 | {role_label(fam['roles'][0]['id'])} |
| 依据 | `114-w3-family/family-definitions-v1.json`（含评审例外表）；模板 `playbook-template-v1.md`；角色候选清单 `frozen-v1` |

> 覆盖说明：8 家族覆盖 50 个 AGT 岗位；`MGT-001`…`MGT-003`（决策权平面）不归任何家族，作为跨家族使用者。

## 1. 定位与边界

- **一句话定位**：{nar['position']}
- **服务的经营问题**：
{chr(10).join('- ' + q for q in nar['questions'])}
- **边界（明确不含）**：{nar['boundary']}
- **与相邻家族的接缝**：{nar['seam']}

## 2. 成员岗位与技能

### 2.1 岗位

| 岗位 | 别名 | 职责（原文标题） | 角色候选清单交叉引用 |
|---|---|---|---|
{roles_md}

### 2.2 技能

| 技能（装配根 kebab） | 主用岗位 | 来源 | 版本/闭环状态（loop-ledger） | 交叉引用 |
|---|---|---|---|---|
{chr(10).join(skill_rows)}
{extra}
> 规则：跨域件（共享）版本由主域家族维护、本家族只引用（114 号走查确认）。

## 3. 端到端作业流

| # | 触发/场景 | 步骤（做什么、用什么技能） | 产物（版本口径） | 记录到 |
|---|---|---|---|---|
{flow_md}

## 4. 交接契约（四要素）

{'\n\n'.join(hand_md)}

## 5. 质量与证据边界

- 事实、用户提供信息、解释、假设、待核验项分别标注；不臆造案例、数字与来源。
- 会变化的信息（价格、平台政策、法律、字段）以当前一手来源核验并记录日期。
- 产物交接前按 DSH 技能评估口径自检（达标线：总分 ≥85 且零 error）。

## 6. 言行边界（无权限措辞）

- **只写**：建议 / 准备 / 记录 / 整理 / 提请核对 / 提请裁定 / 交接收方处理。
- **禁写**：批准 / 审批 / 授权 / 放行 / 付款 / 发布 / 签署；以及直接处置账号、商品、库存、人员。
- 资金、对外承诺、账号、商品、库存、人员的具体动作：一律"准备材料 → 交相应有权责任方处理"。

## 7. 异常与记录

| 异常 | 处置（职责范围内） | 记录到 | 提请谁核对 |
|---|---|---|---|
{exc_md}

## 8. 变更记录

| 版本 | 日期 | 变更 | 评审 |
|---|---|---|---|
| v1 | 2026-10-01 | 首版（105-012 起草＋独立评审修订后定稿） | 评审通过（2026-10-01，116 号） |
"""
    p = OUT / f"playbook-{fam['id']}-{name}.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(md, encoding='utf-8')
    files_written.append(str(p.relative_to(ROOT)))

    # —— 自检 ——
    missing_ref = [s for s in fam['skillsPrimary'] + fam['skillsCrossRef']
                   if s not in ledger or not (ledger[s].get('roleCandidates') or '').strip()]
    four_ok = all(all(k in b for k in ('①', '②', '③', '④')) for b in hand_md)
    body_wo6 = re.split(r'## 6\.', md)[0] + (re.split(r'## 7\.', md)[1] if '## 7.' in md else '')
    forbidden = re.findall(r'批准|审批|授权|放行|付款|发布|签署', body_wo6)
    report['families'].append({
        'file': str(p.name), 'roles': len(fam['roles']),
        'primarySkills': len(fam['skillsPrimary']), 'crossSkills': len(fam['skillsCrossRef']),
        'crossRefMissing': missing_ref, 'handoffFourElements': four_ok,
        'forbiddenOutside6': forbidden,
    })

(OUT / 'playbook-verify.json').write_text(json.dumps(
    {'recordType': 'playbook-draft-verify', 'at': '2026-10-01',
     'basis': '105-012 起草自检：交叉引用/四要素/无权限措辞（§6 之外）', 'families': report['families']},
    ensure_ascii=False, indent=1) + '\n', encoding='utf-8')

ok = all(not f['crossRefMissing'] and f['handoffFourElements'] and not f['forbiddenOutside6']
         for f in report['families'])
print(json.dumps({'files': len(files_written), 'allChecksPass': ok}, ensure_ascii=False))
for f in report['families']:
    flag = 'OK' if not f['crossRefMissing'] and f['handoffFourElements'] and not f['forbiddenOutside6'] else 'FAIL'
    print(f"{flag} {f['file']}: roles={f['roles']} skills={f['primarySkills']}+{f['crossSkills']}"
          + (f"  missing={f['crossRefMissing']}" if f['crossRefMissing'] else '')
          + (f"  forbidden={f['forbiddenOutside6']}" if f['forbiddenOutside6'] else ''))
