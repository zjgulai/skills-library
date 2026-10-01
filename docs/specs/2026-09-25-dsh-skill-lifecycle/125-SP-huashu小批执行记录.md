# 125 SP-huashu 小批执行记录（文本面优化；两件全收口）

范围：特殊件文本面小批 `huashu-design`（191 文件/33.2MB）＋`huashu-slides`（25 文件/14.4MB）。授权：D142 登记＋D144「发射 SP-huashu」。**cap 建议 2.4M/480 req（D142）**；大包档 40/240k（amend-10）；**只改文本面——二进制资产不入材料、不入写回**。预检：`opt-run/sp-huashu-preflight.sh`（零出境 capture＋wake-check）。

## 逐件台账（审计口径；审计册 `122-r2-prep/evidence/sp-huashu-void-audit-r268-274.json`）

| # | 件 | 轮次链 | 请求 | tokens | 状态 |
|---|---|---|---|---|---|
| 1 | huashu-design | r268 基线 78.75/76.75 → r269 v1 91.0/**81.5** → r272 v2 83.5/**92.55** → r273 v3 **92.25/91.5** | 148 | 1,664,937 | ✅ 收口（写回 9 put/0 拒；装配 updated 1/0 拒〔b8a331fe00b2，198 文件〕；L5 双树 PASS；屏检不差；主干 583→231 行/65KB→18.1KB） |
| 2 | huashu-slides | r270 基线 76/77.5 → r271 v1 83.5/83.5 → r274 v2 **93.0/91.0** | 119 | 1,318,427 | ✅ 收口（写回 4 put/0 拒；装配 updated 1/0 拒〔56212de498f4，26 文件〕；L5 双树 PASS；屏检不差；主干 641→473 行/32.4KB→20.9KB） |
| — | **合计** | 7 轮 / 14 读数 | **267** | **2,983,364** | **0 void / 0 未覆盖 / 0 对账异常** |

**预算说明（如实登记）**：cap 2.4M → 实耗 **2,983,364（+24.3%）**；请求 267/480 内。超支主因＝两件各多跑 1–2 轮修复复评（计划按 baseline＋reeval 两轮估；实际 design 4 轮、slides 3 轮，首复评 81.5/83.5 未过线）。**逐件止损未触发**（design 1.66M、slides 1.32M，均 < 大档 4 跑理论 2×1.92M）。巨件单轮实测 253k–572k（含 34 主读取尝试），件均 ≈1.49M——**B-2…B-5 为常规 65 件（件均 240k），不沿此系数**；若未来再批巨件批，预算应按「件均 1.5M×轮数裕量」计。

## 过程注记

- **预检发现并修复 opt-loop 合并预算缺陷**（关键）：huashu-design 首跑 capture 双红 `INPUT_TOO_LARGE`——107+ 处「未并入」占位符字节未计入 mergedBytes，叠加判者技能文件后总输入 200.4KB>196,608。修复＝**两遍式预算**（先按「剩余文件全出占位符」预留，并入内容须满足 mergedBytes+body+reserve−ph≤limit）；修复后总输入 192.2KB（余 4.4k），双绿。此后 r269/r272/r273 大件全部照常。
- **判者互冲实录**：`required-tools`——r269-r2 要求加（warning，给出示例字段）、r272-r1 判其非规范字段（**error**）。处置：按「双跑零 error」取严格，v3 移除并统一并入 compatibility/正文。**镜像教训**：同一份「建议加非标字段」的单跑意见，别当共识执行。
- 件形态差异：design 在库根 `huashu-design-master/`、slides 嵌套 `huashu-skills-master/huashu-slides/`——库内树 L5 须用 `--ledger`（按 sourcePath 解析），装配根用 `--subdir ""`。
- 资产零触碰：写回仅 13 个文本文件（9＋4）；二进制（mp3/png 84 个）不进候选、不进材料、不入写回；装配 projection 照常携带全量（198/26 文件）。
- v1 修复要点：design＝渐进式披露拆解（7 份新 references 逐字保留）＋frontmatter＋环境三级矩阵＋assets 非必需声明；slides＝宿主私有绝对路径清除（`~/.claude/...`、`process.env.HOME`）＋悬空 `huashu-wechat-image` 引用改降级叙述＋去营销段＋伪路径占位符改能力探测叙述＋安全边界节＋GOOD/BAD 案例下沉。

## 状态

两件全部收口（写回→装配→L5→屏检全绿）；loop-ledger 全闭 118→**120**、opt-queue 55→**53**。特殊 4 件处置（D142）自此**全部落地**（huashu×2 本批；leadership 并入 B-1 已收口；seo-skill 独立评测仍待发射）。
