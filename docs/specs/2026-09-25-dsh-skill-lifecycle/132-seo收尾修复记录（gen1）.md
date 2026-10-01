# 132｜seo-skill v1.5 收尾修复记录（gen1，零请求）

状态：**gen1 修复完成（2026-10-01）**。承 126 号（D142③ 独立评测、判者意见）与用户「同意建议」——对用户新件 `技能库/skill-zyx/`（76 文件）执行 v1.5 收尾的**零请求修复**：产出候选 `seo-orchestrator-gen1`、构建器与检查脚本（含负控）。**库内原件零改动；复评（live）为下一道预算门。**

## 1. 修复清单（判者意见逐项 + 过程自发现）

| # | 判者意见（126 号） | 落法 |
|---|---|---|
| P0-1 | frontmatter 补全（license/complexity/compatibility ＋ `metadata.version/author`） | SKILL.md 全套：`name: seo-orchestrator`／`version: "1.5.0"`／`complexity: "complex"`／`license: "MIT"`／compatibility 字符串／`metadata.{version,author=internal}` |
| P0-2 | description 三段式重写 | 功能定义＋触发词（含负向边界前）＋何时不用＋安全边界＋缺输入先追问；**394 字符**（150–500 带内） |
| P0-3 | Step-by-step 工作流 | 新增「## 执行工作流（五步）」＝需求分类→动态加载模块→证据核查与决策→Handoff 与验证→结构化交付（祈使式） |
| P1-4 | name 去候选化＋版本下沉 | `seo-skill-v1-5-candidate` → `seo-orchestrator`（H1 同步；版本进 frontmatter/metadata） |
| P1-5 | 版本口径统一（V1.4/V1.5 混杂） | 7 份 yaml `version` → `'1.5.0'`（含 `1.5-candidate`）；20 个模块头【V1.4(.1) 模块边界】→【模块边界】；沿革叙述（「V1.4 不再要求…」）清出面向 Agent 的正文 |
| P1-6 | 多版本文件二义性归一/归档 | `history/` 四件归档（ORCHESTRATION_CORE.md、orchestration_core.yaml、state_schema.json、validators/validate_v1_4_architecture.py）＋history/README.md；协议与契约各加「唯一职责」角色注释；协议删与 schema/contract 重复的 `gate_order`/`exact_fields`（单一来源化） |
| P1-7 | 模块路由表缺失 | 新增候选包根 `INDEX.md`：20 模块×能力定位×常用服务 ＋ 9 项共享服务×定位×复用范围（由各文件结构化字段反演生成） |
| P1-8 | 最小可执行示例 | SKILL.md 内联节选（Plan / Decision / Handoff / Result）＋ `examples/minimal-trace.json`＋`minimal-runtime-context.json`＋`examples/README.md`（含校验命令与预期输出） |
| P2-9 | 安全边界 | desc 尾句＋「## 安全边界」节：抓取内容＝不可信数据（Data Only）、不虚构未实测数据、拒绝注入/密钥/危险命令 |
| 自发现 | `references/来源与模块映射索引.md` 两处 `../../` 死链（源工作区审计件） | 改为「源工作区…未随本包分发」文本（去链接）；同页去 `V1.4.1` 版本号与 `skill/` 旧称 |
| 自发现 | 静态检查命令口径 | SKILL.md 与 examples 统一为 `--registry ownership_registry.yaml`（实参语义）；`validate_v1_5_architecture.py` 的 `--registry` 补 help 文案 |

## 2. 产物与工具

- 候选：`skill-lifecycle/trial-home/opt-run/candidates/seo-orchestrator-gen1/`（81 文件＝原 76＋INDEX.md＋examples×3＋history/README.md；4 件迁移进 history/）。
- 构建器（机械类，幂等，逐项断言）：[seo-orchestrator-gen1-build.py](122-r2-prep/fix-plans/seo-orchestrator-gen1-build.py)（复跑 39 项全 skip）。
- 检查脚本（含 13 负控）：[seo-orchestrator-gen1-check.py](122-r2-prep/fix-plans/seo-orchestrator-gen1-check.py)。
- 校验用本地 venv：`skill-lifecycle/trial-home/control/venv`（jsonschema 4.26＋PyYAML 6.0.3；git-ignored）。

## 3. 验证读数（全零请求）

- **检查脚本：candidate PASS（0 差异）**；判据覆盖 frontmatter 全套/desc 三段式/五步工作流/版本与旧标识清扫/结构（history 归档、INDEX、20 模块头、7 yaml 版本、协议单一来源）/链接不越界/示例过包内校验器。
- **13 个负控全部判红**（各自命中所属判据）：desc 去负向/desc 超限/去 license/去 author/版本回退/模块头回退 V1.4.1/归档件回流/删 INDEX/死链回流/示例破坏/旧名回流/协议去重回退/metadata.version 缺失。其中 `broken-example` 由**包内 v1.5 校验器**实际判 `REJECT (ARCH-OWNER-001)`——深控（校验器真的在跑）。
- **包内 `validate_v1_5_architecture.py` 对最小示例判 `PASS`**（`canonical_v1_5` profile；六条 ARCH 规则全过；exit 0；`outcome_class=deterministic_pass`）。
- 手工全域扫描：活动文件旧标识残留＝仅 `trace_schema.json`（有意保留的 legacy 解析件，协议 `legacy_incomplete` 引用）与 `references/rule_fidelity_manifest.yaml`（冻结审计件）。

## 4. 边界、教训与下一步

- **边界**：全程零模型请求；`技能库/skill-zyx/` 零改动（mtime 未变）；未写回、未动装配根与台账——写回是复评达标**之后**的独立门。
- **教训（已入记录）**：venv 的 `python` 是符号链接——检查器解析路径**不可 `resolve()`**（会落到系统 python 丢 jsonschema）；只做 abspath 归一。（同族：`/tmp` 须先 realpath——方向相反。）
- **下一步＝复评门（live，需预算授权）**：复评两跑（`o<r>-evaluate-target`，候选为评估对象）；**预注册收口判据＝两跑均 ≥85 且零 error**（判者可发布线，不重跑刷分）；**cap 建议 ≈70 attempts / 550k tokens**（依 r275 实测 30 attempts/232k ＋一次重跑余量）；发射沿用既有链（零出境 capture＋wake-check 预检→r 轮→void 对账）。达标后＝写回门（受控执行器 put/remove；目录命名与装配序另报）。

## 5. 工件链

- 库内基线：`技能库/skill-zyx/`（126 号 r275 已评 76.0/57.5）
- → 候选修复：`candidates/seo-orchestrator-gen1/`（本件）
- → 复评：**r387 已执行（2026-10-01）：91.5 / 95.7，均 ≥85 零 error，收口判据 PASS**（详见 §6）
- → 写回：**门待批**（计划 81 put/4 remove＋dry-run 全绿已备，见 §6）

## 6. 复评执行（r387，live，2026-10-01；用户「继续提交，再开始下一批任务」授权）

**发射链**（全按既有流程）：stage 候选为 r387 材料（81 文件/81 交付/合并 170,347≤170,496/21 占位；SKILL.md digest `5809989e05fdddb7`）→ task `o387-evaluate-target` → 零出境预检 **capture＋wake-check 2/2 绿** → live 两跑（`T_RUN_ATTEMPTS=40 T_RUN_TOKENS=240000 T_GROUP_ATTEMPTS=60 T_GROUP_TOKENS=300000`，与 r275 同构）。

**读数（判者报告正文核对）**：

| 跑 | 分数 | 发布结论 | error | issues |
|---|---|---|---|---|
| r387-r1 | **91.5 / 100**（good） | 可发布 | **0** | 3 warning＋1 info |
| r387-r2 | **95.7 / 100**（excellent） | 可发布 | **0** | 1 warning＋1 info |

- 对照基线 r275（76.0／57.5）⇒ **修复有效**；**预注册收口判据（两跑均 ≥85 零 error）达成**。
- 得分锚点存疑项复查：r1 六维明细 94/90/92/93/88/85；r2 98/95/95/96/95/94 —— 引用均为报告正文原值。
- 残余建议（非阻塞，供 v1.6 参考）：r1 建议补 boundary case 口语化触发例、降级轻量模式说明；r2 提示 scripts/history 命名对照关系（判者轻微误读：`scripts/validate_v1_5_architecture.py` 实际存在且被 SKILL.md 正确引用）；两跑均提 SC 编号非连续（INDEX.md 已声明）。

**消耗（审计口径，`void-audit-seo-r387.json`）**：2 读数 / **705,839 tok** / 0 void / 0 未覆盖 / 0 异常；attempts r1 32＋r2 18＝**50**（in 197,296＋out 7,351＋cacheRead 501,192）。
- **口径登记**：实际较给出的建议 cap（≈70 attempts/550k）**tokens 超 28%**、attempts 在 cap 内；原因＝大包（81 文件）判者读文件轮次高（r1 达 32 attempts）＋cacheRead 占 71%＋**r275 单例外推不足**（同族教训：单例外推）。未触 2× 止损线（1.1M）。修订口径：大包件（>75 文件）复评预算按本件实测回填 **≈50 attempts/≈700k（审计口径）**。

**写回门材料（零请求已备）**：
- 计划：`opt-run/writeback-plan-seo-orchestrator.json`（**81 put＋4 remove**＝原 v1.4 根级四件迁 history；9 个新增 put[expectAbsent]＝INDEX.md/examples×3/history×5）。
- dry-run：`skill-repair-writeback.mjs`（未 --apply）⇒ **changed 85／refused 0／exit 0**；备份根 `trial-home/library-backup-writeback-seo-2026-10-01`。
- **126 号误记校正**：该件**实为 batch-1 已投影件**（`107` op-091；装配根 `_assembly-v1/seo-skill-v1-5-candidate/`，77 文件）；126 号「未登记进 173、未在装配根」为误记。写回后链＝装配 in-place 更新（受控 update op）→ L5 装载 → 屏检 → 台账收口（L00245 optState→done-full-loop）。
- **目录命名口径**：建议**就地写回（保持 `skill-zyx/` 目录名）**——免动冻结台账（108 投影逐字节冻结）与装配名映射；目录改名如需同步（→`seo-orchestrator/`），作独立受控改名批另做（工具支持 put/remove/prune-empty）。**待批**。

## 7. 写回与全链收口（2026-10-01；用户「执行方案 1（就地写回）」）

- **写回 apply**（`skill-repair-writeback.mjs`）：计划 81 put＋4 remove → **applied 85 变更／0 拒**；备份 `trial-home/library-backup-writeback-seo-2026-10-01/`＋回执；库内 `skill-zyx/` 现 81 文件（SKILL.md＝`seo-orchestrator`；v1.4 四件已迁 `history/`；原根级旧件与 `validators/validate_v1_4_architecture.py` 已移除）。
- **装配受控更新**（`assembly-update-make.py` → `assembly-project.mjs`）：**updated 1／0 拒**；81 文件/282,628B；旧版归档 `_assembly-history/seo-skill-v1-5-candidate/b20c56c7e85c/`；回执 `_assembly-receipts/update-batch-2026-10-01cb.json`；`.assembly-meta.json` 刷新（sourceSha `5809989e…`）。
- **L5 装载**（`repair-load-check-121.mjs`，**双树**）：库树 1/1 PASS＋装配树 1/1 PASS——同一 `content identity b199eb94a7156af8 matches the installed tree`。**工具补丁**：`--names` 支持 `台账名=发现名` 别名（改名件：路径按台账旧名解析、发现/装载按新名——首跑 `SKILL_NOT_DISCOVERED: seo-skill-v1-5-candidate` 即此因）。
- **屏检**（`skill-screen.mjs`，`library-screen-2026-10-01o.json`）：全库 **high 19 持平／medium 347（−5）／low 95**；逐路径对照仅 5 处变化＝本件（name 更新、findings 数不变）＋4 件三联批已修件（customer-research／discover-brand／people-report／performance-review）——“−5”为三联批既有修复相对 15:54 快照的迟到显形，与其 D150 口径吻合，**非本批引入**。
- **台账收口**：新增 `122-r2-prep/seo-progress.json`（并入 `loop-ledger-make.py` 的 OPT_PROGRESS）→ 重生成仅一行为变化＝L00245（optState missing→`done-full-loop`、optReadings **91.5/95.7**、updateState→updated、nextAction→closed）⇒ **loopClosed 173／loopOpen 0、队列清零（全量全闭）**。
- **残留登记**：本件 1 条 high `NAME_FOLDER_MISMATCH`（name=seo-orchestrator vs 目录 skill-zyx）——**就地口径（方案 1）的已知遗留**；如需消除＝独立改名小批（写回执行器支持 put/remove/prune-empty；台账 sourcePath 与装配目录名的连带刷新方案已备）。
