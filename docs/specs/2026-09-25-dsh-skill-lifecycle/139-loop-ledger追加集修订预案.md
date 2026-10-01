# 139｜loop-ledger 追加集修订预案（v2-draft → 已执行）

状态：**✅ 已执行（2026-10-01；用户「执行（草案提升生效）」；D175）**——生成器已就地升级；v2 台账已入 109；v1 冻结留档（执行记录见 §6）。
触发：dir2（136 号）与 gdir2（138 号）两批去向②新制作共 **6 件**已入库/投影/收口，两份登记册均注明「并入追加集待批；是否修订 loop-ledger 生成器待批」。

## 1. 问题与口径目标

- 现行 `loop-ledger-make.py` 只覆盖**批一指定集 173 件**（A 81-Skills 81＋B 角色候选 91＋C 平铺 1）；6 件新制作件不在台账内（`in v1? False`×6）。
- 目标：让台账**如实反映装配根 179 件事实**，同时保住三条不变量：
  1. **指定集 173 口径不变**（语义与字节都不变）；
  2. 生成器＝唯一改写入口（追加集也由生成器并入，不手改产物）；
  3. 追加集可辨识（组/状态/id 显式标记，不与批一混淆）。

## 2. 修订设计（v2-draft）

- **草案工具**：`skill-lifecycle/trial-home/screening/loop-ledger-make-v2-draft.py`——对现行生成器做 13 处**受断言保护**的补丁式只增改动：
  - 新增 `--append`（并入 `APPEND_SOURCES` 两份登记册）与 `--tag`（默认 v1；输出 `loop-ledger-<tag>.{csv,summary.json}`）；
  - 新增 `load_append_rows()`：从登记册构建追加行（**同 28 列**）；
  - `loopClosed` 谓词扩展：`assemblyStatus ∈ {batch1-projected, appended-projected}`；
  - 摘要新增 `sets`（仅 `--append` 时写入）。
- **追加行 schema（6 行）**：

| 字段 | 取值 | 说明 |
|---|---|---|
| ledgerId／opId | `LAP01–LAP06`／`ap-001–ap-006` | 追加集专用前缀（不占用 L 序列；无工具解析该格式——已核） |
| group | `X`（追加集） | byGroup 增 `X: 6` |
| sourcePath | 各件库内 home | hardware→81-Skills；其余 →skills-genspark |
| routeV1／roleCandidates／sageRoles／basisV1 | 空／`new-draft（去向②新制作；非 v1 路由件）` | 非 v1 路由件，明示 |
| classificationState／completenessState | `closed`＋注记（记录文档） | 新制作即其域归属；检查/测试全绿 |
| optState／optReadings／optEvidence | `done-full-loop`／两跑读数／136 或 138 号 | 新制作弧线（起草→评审→入库）＝完整回路 |
| assemblyStatus | `appended-projected` | 区别于 batch1-projected（回执 project-batch-2026-10-01dir2/gdir2） |
| nextAction | `closed` | 无待办 |

## 3. 验证读数（已跑，零请求）

- **回归（不带 --append）**：草案输出与现行 **逐字节一致**（`loop-ledger-v1.csv`＋`.summary.json` 双 cmp 通过）——「未启用追加时行为不变」有字节级证据。
- **v2 草案（--append --tag v2）**：产物在 `109-loop-ledger/draft-v2/`：
  - **v2 以 v1 全量字节为前缀**（173 行一个字节未动）＋6 行追尾；
  - 读行抽验：`LAP03 hardware-quality-closure 93.5/96.0（两跑） appended-projected closed` 等 6 行全部正确；
  - 摘要：`total 179；byGroup {A:81,B:91,C:1,X:6}；sets {batch1:173, append:6}；loopClosed 179、loopOpen 0；queue {closed:179}`。
  - `frozenInputs` 含追加源（两份登记册）哈希——登记册自此为冻结输入。

## 4. 影响面

- **产物**：建议 v1 **冻结留档**（不再重建）；v2 入 `109-loop-ledger/`（`loop-ledger-v2.csv`＋summary），draft-v2 目录在生效前仅作草案。
- **生成器**：建议以草案为准**就地升级**（`loop-ledger-make.py` 支持 `--append`；命名可保留或升 `-v2`），旧行为仍可复现（不带 flag）。
- **消费方**：现行记录对 109 的引用均为历史快照口径（无格式解析依赖 `ledgerId`）；06/README 引用需随生效刷新一行。
- **不改变**：173 指定集四态、队列口径、观测名单、optReadingStats 等——追加集只增行。

## 5. 待批选项（一句话即可）

| 选项 | 含义 |
|---|---|
| **① 执行**（推荐） | 草案提升生效：现行生成器并入 `--append`；生成 `loop-ledger-v2.{csv,summary.json}` 入 109；v1 冻结留档；06/README 刷新一行 —— **✅ 已于 2026-10-01 执行（见 §6）** |
| ② 不执行 | 维持 173 指定集口径；6 件仅以登记册（136/138 receipts）为旁证 |
| ③ 调口径再议 | 若组标签（X）、状态名（appended-projected）或 loopClosed 口径想改，指一句即改后重跑验证 |

> 边界：本预案为**零请求**；草案工具与 draft-v2 产物均已落盘可复跑；执行与否不改变已收口事实——仅决定台账口径是否随装配根 179 件同步。

## 6. 执行记录（2026-10-01；用户「执行（草案提升生效）」）

- **生成器就地升级**：`loop-ledger-make.py` ← 草案内容（13 处断言补丁全部生效；语法检查过）；**无 `--append` 时行为逐字节不变（升级后回归：与 v1 逐字节一致）**。
- **正式 v2 生成**：`python3 -B loop-ledger-make.py --append --tag v2 --out-dir 109-loop-ledger/` → `loop-ledger-v2.csv`＋`.summary.json`（`total 179；byGroup {A81,B91,C1,X6}；loopClosed 179、loopOpen 0；queue {closed:179}`）。
- **双核查**：① 正式 v2 与提案期草案 v2 **逐字节一致**（csv＋summary 双 cmp）；② 升级后不带 `--append` 回归 **v1 逐字节一致**（旧行为可复现）。
- **留档与清理**：v1 保留冻结（不再重建）；提案期 `draft-v2/` 草案目录已在核验一致后清理；草案工具 `loop-ledger-make-v2-draft.py` 保留（验证形态留底）。
- **刷新**：06 控制台行（已执行）＋本预案状态＋README 索引行。
