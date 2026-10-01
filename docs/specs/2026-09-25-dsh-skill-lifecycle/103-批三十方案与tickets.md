# 103｜批三十方案与 tickets：旧英文 ID 第一波

状态：用户已明确确认“三件按方案执行”，三个技能六文件已写回并逐票验证，6/6 tickets 完成。更新26处旧 ID、修正2条悬空链接；原包测试7/7、文本执行器回归6/6，三个CLI输出新 ID。真实模型请求：0 次；未commit/push。三处非计划 `.DS_Store` 漂移已单独登记，未触碰；完整读数见 §7。

## 1. 目标与来源

接续 [102 号批二十九记录](102-旧英文id清扫记录.md) §4 的旧英文 ID 残留，而不是把 Birdview 截图问题当主线。重新读取旧清单的119个路径，119个都仍含对应完整 token；这是原清单复核，不是全库新增文件扫描，也不证明119个都是缺陷。

本批三个端到端切片：让 ad-creative、social-content、outreach-automation 在正文、manifest和真实离线CLI输出中引用现行技能身份。三者均保留自己的名称、版本、触发语义、输出结构和脚本实现。

原记录编号102对应批二十九；本文件编号103对应批三十，文档号和批次号不混用。

## 2. 固定修改范围

技能库根：`/Users/lute/project/AgentTools/技能库`。每个技能只修改 `SKILL.md` 和 `.skill-meta/manifest.yaml`，共6文件。

| Ticket | 技能 | 旧 ID → 新 ID | 次数 |
|---|---|---|---:|
| 103-003 | ad-creative | mkt-copywriting → copywriting；mkt-paid-ads → paid-advertising；mkt-email-sequence → email-automation-flow-builder | 8 |
| 103-004 | social-content | mkt-ad-creative → ad-creative；mkt-email-sequence → email-automation-flow-builder；da-social-sentiment-tracker → brand-mention-tracking；mkt-viral-video-analyzer → viral-video-analyzer | 8 |
| 103-005 | outreach-automation | gtm-icp-profiler → icp-profiler；bm-marketing-content-suite → marketing-content-suite；mkt-ad-creative → ad-creative；gtm-gtm-strategy-planner → gtm-strategy-planning | 10 |

合计26处旧 token；outreach正文另外将两条不存在的包内技能链接改成纯技能标识符，避免只换链接文字仍然悬空。所有目标已核对实际 `SKILL.md` 的 frontmatter `name`。

明确不改：`author: lute-skills-creator` 是作者归属，不是调用引用；README历史身份、tests/momcozy、负控字符串、脚本常量、斜杠中文调用约定、包版本与许可证、`skill-zyx`、其余旧清单文件。本批不重构文本执行器、不升级宿主、不联网评测、不上传外部技能库。

## 3. Tickets 与依赖

票面与状态见 [tickets.json](../../../.birdview/local/batch-103/tickets.json)，逐票文件见 [tickets/](../../../.birdview/local/batch-103/tickets/)。为避免公开私有库原文，工件放在已忽略的 `.birdview/local/batch-103/`，不新增公开目录或改忽略配置；用户确认后按原粒度执行并固化逐票证据。

| ID | 切片 | Blocked by | 当前状态 | 验收 |
|---|---|---|---|---|
| 103-001 | 复核119项与目标身份 | 无 | done | 119路径有身份指纹、原桶保留、9个现行目标name匹配 |
| 103-002 | 三技能用户路径基线与精确预览 | 103-001 | done | 三个CLI复现旧ID；原测试7/7；6文件dry-run全接收；准备期45包文件与119清单字节未改 |
| 103-003 | ad-creative 依赖/正文/CLI一致写回 | 103-002 + 已确认范围 | done | 2文件逐字等于计划；8旧token清零；正文输出使用新ID；备份等于原件 |
| 103-004 | social-content 路由与manifest一致写回 | 103-002 + 已确认范围 | done | 2文件逐字等于计划；8旧token清零；CLI与4项测试通过；元数据漂移单独登记 |
| 103-005 | outreach-automation 路由与依赖一致写回 | 103-002 + 已确认范围 | done | 2文件逐字等于计划；10旧token清零、2死链接修正；3项测试及默认拒网保持 |
| 103-006 | 批次对账、复扫与三处归档 | 103-003/004/005 | done | 六文件及备份对账正确；113个非目标清单文件未变；保留作者；103/README/06已同步 |

三个写回票相互独立，但同一库串行执行，避免混淆写回回执与并发外部变动。每票是“内容与元数据 → 实际消费者 → 校验与回执”的完整切片，不按文件层水平拆分。

## 4. 已执行与产物

所有项目命令在 `/Users/lute/project/AgentTools/思维库/skill管理` 运行。

- `baseline.json`：119路径内容SHA256、原分类、精确token命中。原分类47待核、22候选残留、46测试语境、4合法，未擅自重判其余项。
- `text-plan.json`：6个精确整文件replace操作；`scope.json` 给出两侧摘要、26处替换明细。
- `preview.diff`：逐行差异，已整份通读。
- `<slug>.plan.json`：每票2个文件的独立计划；`dry-run.json`：三个执行器结果均 `applied:false, changed:2, refused:0, receipt:null`。
- `read-only-verification.json`：原包自测social 4/4、outreach 3/3；三个真实CLI的输出带旧ID；outreach默认不放行网络时按预期退出2；45个包文件和119清单的前后摘要一致。

示例命令（准备期执行，不含 `--apply`；确认后的写回在同一命令追加 `--apply`，三份实际回执见 §7）：

```sh
node skill-lifecycle/trial-home/screening/skill-repair-text.mjs \
  --plan .birdview/local/batch-103/ad-creative.plan.json \
  --library /Users/lute/project/AgentTools/技能库 \
  --backup .birdview/local/batch-103/backup/ad-creative
```

跑完读 `applied/changed/refused`，不能把 dry-run 的 `changed:2` 当实际写入；只有 `applied:true` 才表示调用了写入路径。准备期零写入证据在 `read-only-verification.json`；实际写回和范围对账在 `final-verification.json`。

## 5. 已确认并执行的操作契约

1. 重新核对六文件与119项基线，漂移则暂停；检查每票备份目录尚不存在。
2. 每个文件只用一个“完整原文 → 完整改后文本”replace操作，绑定原始SHA256和 `expectCount:1`。它是精确补丁而非重新生成正文；diff已列全，不碰未声明文本。
3. 逐票追加 `--apply`，各用独立的新备份目录，立刻检查每文件实际字节等于plan.replace、备份等于plan.find。执行器不提供整批事务，任一失败立即停止后续票，记录已写项。
4. 用同样的离线CLI验证新ID；运行原测试与项目 `skill-repair-text` 回归。Python全程 `-B`，子进程 `PYTHONDONTWRITEBYTECODE=1`；不设置 `--allow-network`、不读取凭据。
5. 根据实际文件逐项复扫原119清单。outreach manifest保留作者值，因此“仍命中文件数”不一定下降6；只报告目标token清零，不追求错误的全零。
6. 将实际读数同步本文件、README索引和06决策；是否提交/推送另按用户指令，不继承上一批首次推送授权。

## 6. 同批发现但不扩围

- `text-plan-oldid-make.py` 顶部旧docstring仍写链式哈希，与同文件build说明和102号最终策略相矛盾；本批不调用这个会重跑已完成两家族的专用生成器。
- `skill-repair-text.mjs` 在写文件后才检查回执是否存在。为避免重跑产生副作用，每票执行前必须确认备份根不存在；本批不靠旧回执的拒绝保护源文件。后续若频繁复用，应独立票硬化前置检查。
- ad-creative没有可执行Python单测，仅历史验收资料；本批用真实CLI读取路径验证，不把0测试算通过。
- 旧清单按宽token记录，outreach的作者字段属于合理保留；本批结果使用精确替换集合，不以raw hit总数充当缺陷数。
- Birdview仍是声明快照＋本地刷新；本批复用v3模块身份，在“技能库筛查与安全写回 → 外部技能库本体”显示范围。外部文件不冒充项目相对ownership。

## 7. 实际执行与终态（2026-09-30）

用户明确回复“三件按方案执行”后，按原三票顺序写回，没有重跑已经应用的计划。每个计划的摘要与准备期dry-run记录一致；每票写前确认源字节与原始SHA256、新备份根不存在。

| 技能 | 实际写回 | 旧ID修复 | 消费者与验证 |
|---|---:|---:|---|
| ad-creative | 2文件 / 0拒 | 8处 | 实际CLI的system prompt含新ID、不含目标旧ID；YAML身份与related_skills一致 |
| social-content | 2文件 / 0拒 | 8处 | 实际CLI instructions含新ID；4项原测试通过 |
| outreach-automation | 2文件 / 0拒 | 10处＋2链接 | render-only输出新ID；3项原测试通过；默认拒网按预期退出2；作者lute-skills-creator保留 |

共同验证：六文件实际字节逐一等于冻结plan.replace，六份备份逐一等于plan.find；YAML解析前后只有指定ID映射变化，名称/版本/作者等其他值不变。项目文本执行器回归6/6通过；三个技能的屏检findings前后逐项相同（各一个既有low级DANGEROUS_COMMAND提示，未清除此类登记项）。没有运行新的模型评测或DSH装载验证，不外推为模型效果提升。

### 7.1 原清单复扫

仅复扫原119路径，不扫描全库新文件。仍含原清单token的文件从119降至114：ad-creative两文件、social-content两文件、outreach正文共5文件清零；outreach manifest保留作者`lute-skills-creator`，所以不应强行降为113。其余113个非目标清单文件的SHA256不变，剩余命中不是重新认定的114个缺陷。

### 7.2 元数据漂移与验证中断

第二件写回后，“45个包文件只改四个目标”的验证断言退出1。立即暂停第三件，确认实际写回文件/备份都与计划一致；额外变化仅为三个包根`.DS_Store`，格式头均为`Bud1`，分别在约09:00—09:01 UTC发生，写入者未观测，不能归因给某个进程。

保留原始基线及`metadata-drift.json`，没有删除、还原或重放apply。终态文件集合仍为45：42个非元数据文件只改本次6个目标，其余36个内容文件不变；三个`.DS_Store`作为独立漂移如实披露，不能再声称整45文件除目标外完全不变。`skill-zyx`的76文件逐项摘要未变。

### 7.3 回执与阅读入口

以下路径均相对项目根 `.birdview/local/batch-103/`：

- `preapply.json`：计划身份、45文件原始摘要及被排除新技能的摘要。
- `backup/<slug>/<slug>.plan-receipt.json`：三份实际执行回执；同目录内`81-Skills/...`是原始备份。
- `<slug>.verified.json`：各票消费者输出摘要、字节一致性和测试结果。
- `screen-comparison.json`：三个技能屏检前后比较。
- `residue-after.json`：119条原清单逐路径剩余token。
- `final-verification.json`：六文件/备份/元数据语义/36未改内容/76新技能文件/原清单的最终核对。
- `tickets.json`与`tickets/*.md`：依赖、验收与6/6完成状态。

备份用于人工审阅后的回退，不提供自动回退授权；不要重复运行已应用的计划。原计划仍绑定旧SHA256，应拒绝再次写入。本批真实模型请求0、没有提交和推送，项目Git HEAD保持`f93c953`。下一波若继续，先从`residue-after.json`挑选并区分有效引用、合法作者与历史/负控语境，不全量替换。
