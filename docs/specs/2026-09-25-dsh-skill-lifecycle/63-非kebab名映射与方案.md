# 63｜129 份非 kebab 名：映射表已就绪，方案三选一（待拍板）

**零请求**。映射表产物：`trial-home/screening/kebab-mapping-2026-09-28.json`（129 条，含来源、可信度、冲突分类）。

## 1. 背景（一句话）

DSH 只认 **kebab-case ASCII** 技能名，非 kebab 的会被**逐份忽略** ⇒ 库内 **129 份（17.6%）在 DSH 里隐形**（见 60 号）。
要装/要探针，就得有一份「库内名 → 可装载名」的对应关系——本方案把它做成了机器可读的表。

## 2. 映射表怎么来的（三个来源，可信度分级）

| 包 | 份数 | 来源 | 可信度 |
| --- | ---: | --- | --- |
| `81-Skills` | 81 | **你自己的 `dsh-overseas-skills` 计划**：A 类 14 对、B 类 15 对是**显式映射**；C 类 52 个只有英文名单，我按语义逐一对齐 | A/B＝high；C＝medium-high（**1 条 medium**：`社媒舆情追踪 → brand-mention-tracking`，语义略有出入：品牌提及 vs 社媒舆情） |
| `MuseAI-Skills-main` | 43 | **机械**：`snake_case` → `kebab-case`（下划线换连字符，唯一改动） | high |
| `paper_to_skills` | 5 | 我起草（`paper-同步→paper-sync`、`审核→paper-review`、`维护→paper-maintenance`、`萃取→paper-extract`、`选题→paper-topic`） | medium-high |

**校验（脚本自动跑，结果 9 条——都写进表里）**：kebab 形状 ✓ 无重复 ✓；**9 条冲突**如下：

| 冲突 | 说明 |
| --- | --- |
| `copywriting` / `competitor-profiling` / `cold-email` / `company-research` / `brand-voice-glossary` / `performance-tracking` | **库内已有同名技能**，且抽查确认是**别的实现**：`copywriting`（顶层营销包 v2.0.2）、`competitor-profiling`（顶层 v2.0.1）、`cold-email`/`company-research`（`skills-genspark` 包）。⇒ 把 81 包改成计划里的英文名，会在库内造出 **6 组同名双份**（正是屏检的 `DUPLICATE_NAME`）。**注意**：在计划里这 6 个恰是 B 类的"**替换**目标"——即原意是"81 版顶掉既有技能"，落到库内就是一次**替换/合并**决策，不是单纯改名 |
| `skill-creator` | **跨包撞名**：81-Skills 的 `Skill创建器` 与 MuseAI 的 `skill_creator` 是两个不同实现 |

## 3. 三条路（方案，待拍板）

### 路 A｜只维护映射表，库内一律不改（**推荐给 81-Skills**）

- 库里保持中文名（那是你流水线的既有约定，计划本身也是"安装时映射"）；安装/探针/评估按映射表取 kebab 名；
- 代价：每次安装都要读一次映射；库内屏检会持续报 81 条 `NON_KEBAB_NAME`（已在案，不算新债）。

### 路 B｜库内改名（**推荐给 MuseAI 43 + paper 5**）

- **MuseAI 43**：`apple_healthkit → apple-healthkit` 这类机械改——顺带把 `name` 与**目录名对齐**（现目录本就是 kebab），零冲突（除 `skill-creator`）；
- **paper 5**：`paper-同步 → paper-sync` 等，**目录一起改**（目录名也含中文）；
- 执行走既有纪律：逐份身份校验（`expectName`）＋备份到项目内＋回执（`skill-repair-rename.mjs` 已具备，只改 name 不动目录时可复用；改目录用 `renameDir` 开关）；
- `skill-creator` 跨包撞名 → 建议 MuseAI 那份改 **`muse-skill-creator`**（81 包按计划占 `skill-creator`）。

### 路 C｜81-Skills 也改名（**需要先做替换/合并决策，不建议现在做**）

- 要改名就得先把 6 处同名双份处置掉（替换/合并/加前缀），那是**内容决策**（涉及 12 份技能的取舍）；
- 而且改完，库内的中文名与流水线产物（`lute-skills-creator` 输出的中文名）就不一致了，**回写流水线时要再映射一次**。

## 4. 我的建议（一条条可单独否掉）

1. **MuseAI 43 + paper 5 走 B**（机械/低风险，且修好"name 与目录不一致"）；
2. **81-Skills 81 走 A**（只维护映射；库内不动），映射表里那 1 条 `medium` 可信度的对齐请你看一眼（`社媒舆情追踪 → brand-mention-tracking`）；
3. **6 处同名双份**登记为「替换/合并候选」（接 `planMerge`），与 55 号那 11 组「同主题两版本」同类处置——**本轮不动**；
4. 映射表补一条**用途说明**：探针/安装/评估一律按它取可装载名（probe B 的 `install-form` 就是这条路的手工版，之后可脚本化）。

## 5. 如果照此执行，我会做什么（零请求）

1. 用 `skill-repair-rename.mjs`（含改名与目录同步、备份、回执）执行 MuseAI 43 + paper 5；
2. 复跑屏检：预期 `NON_KEBAB_NAME` **129 → 81**（只剩 81-Skills），high 相应下降；
3. 全量回归 + 更新 60/63 号与索引；
4. 把映射表登记进 `registered-items`（作为"库内不改、安装时映射"的登记项）。

## 6. 执行结果（2026-09-28，用户拍板「按建议：改 48 份」）

| 项 | 结果 |
| --- | --- |
| MuseAI 43 + paper 5 **库内改名** | **48 改、0 拒收**；`skill-repair-rename.mjs`（逐份 `expectName` 身份校验＋备份＋回执）；备份 `library-backup-kebab-2026-09-28/`（48 份）；paper 的**目录一起改**（`paper-同步` → `paper-sync`），MuseAI 目录已是 kebab 故只改 name |
| 跨包撞名的处置 | MuseAI 的 `skill_creator` → **`muse-skill-creator`**（`skill-creator` 已被 **kimi 包**的 `skills/kimi/skills/skill-creator` 占用） |
| 复跑读数 | `NON_KEBAB_NAME` **129 → 81**（只剩 `81-Skills`）、high **146 → 99**、技能总数 734 不变 |
| 81-Skills 81 份 | 走**路 A**：库内不改，映射表为准（台账新增 `non-kebab-kept-with-mapping`） |
| 6 处同名双份 | 登记为 `name-collision-replace-candidates`（替换/合并候选，走 planMerge，本轮不动） |
| 那条 medium 对齐 | 用户确认照准（`社媒舆情追踪 → brand-mention-tracking`） |

**注意（给后续用表的人）**：映射表是「库内名 → 可装载名」的权威；MuseAI/paper 改名后**它们的 name 已是 kebab**，
表里那 48 条相当于「历史对照」——实际取用时应优先看库内现状（name 已是 kebab 就不必再映射）。
