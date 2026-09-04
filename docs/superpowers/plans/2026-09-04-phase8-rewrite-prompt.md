# Phase 8 执行提示词（重写剩余上游代码）

> 这份文件就是提示词本体。**新开一个窗口，把「## 提示词正文」整节原样贴进去即可**，
> 它是自包含的，不需要先读别的文档。
> 上游：`docs/superpowers/plans/2026-09-03-decouple-from-yun-claude.md`（Phase 1~7+9 的执行记录在那里）。

---

## 提示词正文

**目标**：把本仓 HEAD 上剩余的 **35,340 行**逐字节原样来自上游导入 commit 的代码重写掉，
分批进行、每批独立可发布，保留的 7 个模块（对话、知识库、素材库、生图、小说、codex 桌宠、
多平台图文工作流）功能不变、CI 全绿。

### 先读这些既成事实，别重新推导

- 背景与决策：`docs/decisions.md` 的 **ADR-012**。判定标准只有一个：**逐字节原样的上游行数**，
  用 `git blame`（跟随重命名）判定，不是「看起来像不像」。改名、重排、洗 history 一律不算，也一律不做。
- Phase 1~7 + 9 已于 2026-09-04 全部完成（分支 `chore/retire-legacy-modules`，13 个 commit）：
  上游行 **122,213 → 42,027**，已删掉 billing（Go 服务 + 独立库）、桌面端、connector/device/
  本机工具挂载，以及 agent 团队 / 微信 / 定时任务 / 配音 / AI 视频 / 电商图 / 漫剧 /
  本地商家宣传 / AI 报告 / 写真 / 试衣 / 工具市场共 12 条业务线。
- **统计口令已入库**：`scripts/count-upstream-lines.sh`（全仓逐文件 blame，12 并发约 13 秒）。
  `-o out.tsv` 出每文件明细。**每批收尾都跑一次，实测值写回本文件的「进度」表。**
- **`pnpm-lock.yaml` 的 6,687 行不算在 35,340 里，也不要试图动它。** 已实测：`git blame` 认内容，
  把 lockfile 删掉从零重生成，产物与 `pnpm install --lockfile-only` **逐字节一致**，
  所以那些行只能靠真改依赖版本才会变 —— 那是升级，不是解耦。
- **基线口径差 551 行**：方案正文写 121,662，同一条口令在同一棵树实测 122,213。引用方案里的
  任何门槛数字时按「方案值 + 551」看。

### 优先级：按「正在被分发」排，不按行数排

`apps/web/src` 与 `apps/admin/src` 的构建产物会被打包发到每一个用户的浏览器 —— 那就是分发，
已经在发生。所以**批次 A 优先，与行数多少无关**。

### 批次

| 批次 | 范围 | 上游行（2026-09-04 实测） | 为什么这个顺序 |
|---|---|---|---|
| **A** | `apps/web/src` + `apps/admin/src` 全部 | **11,667** | 正在被分发；做完浏览器里再无上游代码 |
| **B** | `apps/api/src/agents/presets.md` | **6,288** | 纯文本、不碰构建、**可与任何批次并行** |
| **C** | api 的保留模块后端 | **13,807** | 随迭代做，无死线 |
| **D** | `packages/db`（schema + 迁移） | **1,960** | 最后动，且历史迁移不许改 |
| — | `pnpm-lock.yaml` | 6,687 | **不做**，见上 |

测试文件占 9,064 行，**不单独立项** —— 跟着各自模块走（改哪块就把那块的测试按目标行为重写）。

#### 批次 A：分发面（11,667 → 0）

按这个子顺序做，每个子批次一个 commit：

| # | 范围 | 上游行 | 备注 |
|---|---|---|---|
| A1 | `apps/admin/src/index.css` + `ui.tsx` | 1,374 | 后台样式与基础组件，改动面最独立，先做当热身 |
| A2 | `apps/web/src/components/shell/` + `components/` 顶层散文件 + `components/ui/` | 2,435 | **这批与「UI 改版」是同一批文件，合起来做** |
| A3 | `apps/web/src/` 顶层散文件（`api.ts` `memoryGalaxy.ts` `workflowState.ts` `chatState.ts` …） | 2,372 | `api.ts` 是机械活但量大 |
| A4 | `apps/web/src/components/memory/` + `pages/Memory.tsx` | 1,615 | 记忆前端；后端在批次 C |
| A5 | `apps/web/src/pages/Knowledge.tsx` + `apps/admin/src/pages/Knowledge.tsx` | 1,012 | 两个知识库页，一起改口径才不会漂 |
| A6 | `apps/admin/src/pages/` 其余 + `admin/src` 顶层其余 | 1,704 | 用户 / 公告 / 审计 / 菜单 / 管理员 |
| A7 | `apps/web/src/pages/` 其余 + `components/workflow/` | 1,120+ | 生图 / 图文 / 小说 / 桌宠的 studio 残余 |

**A2 是唯一「产品需求和解耦目标完全重合」的一批**：要改 UI 就得动 `shell/` 与那批顶层散文件，
反正要改，顺手就解耦了。`components/ui/` 只有 266 行、但被 29 个文件引用，所以放在 A2 一起动，
不要单独改它。

#### 批次 B：`presets.md`（6,288 → 0）

`apps/api/src/agents/presets.md` 是提示词库，**100% 原样**。纯文本、不碰前端、不用跑构建，
所以**可以和任何批次并行**，也是唯一一块「不重写就永远归不了零」的自有核心资产。
重写时注意：它是各内置 Agent 的系统提示词来源，改完要跑一遍 `apps/api/src/agents/` 的测试，
并手工验一次「新建对话 → 选内置 Agent → 发一条」的行为没变味。

#### 批次 C：后端保留模块（13,807 → 0）

| 范围 | 上游行 | 备注 |
|---|---|---|
| `apps/api/src/kb/` | 4,233 | 知识库，最大一块，是核心模块 |
| `apps/api/src/workflow/` | 3,074 | article / codex-pet / image / novel 四条线的残余 |
| `apps/api/src/memory/` | 2,134 | 与 A4 的前端配对做更省 |
| `apps/api/src/admin/` | 1,663 | 公告 / 操作日志 / 知识库 / 菜单 / 权限 / token |
| `apps/api/src/chat/` | 1,279 | 对话主链 |
| `apps/api/src/agent/` | 907 | `run.ts` 的 runTurn 循环 |
| `apps/api/src/auth/` + `storage/` | 551 | 基础设施层，动了影响面最广，**放最后** |

#### 批次 D：schema + 迁移（1,960 → 0）

`packages/db/prisma/schema.prisma` 现在还有 282 行上游、`migrations/` 里约 1,678 行。
**`migrations/` 里的 81 个历史迁移一个字都不许改** —— 它们是线上库的真实演化记录，
改了 `migrate deploy` 会对不上。所以这批实际只能重写 `schema.prisma` 那 282 行
（改注释与字段排布不算重写，要真的换写法），迁移那 1,678 行是**刻意留着的代价**，写进 ADR 即可。

### 什么算「重写完成」

**逐字节原样的那些行必须真的不一样了**，而不是改了个变量名。可操作的判据：

- 改完对该文件跑 `git blame --line-porcelain HEAD -- <file> | grep -c '^491de0f'`，数字降到 0；
- **不接受**：批量改缩进 / 换引号 / 重排 import / 改变量名 / 加空行 —— 衍生作品不因为改了变量名
  就不是衍生作品，这种活白干（方案「明确不做的事」第 2 条）。
- **接受**：换数据结构、换控制流、换算法、拆分或合并函数、换库、按自己的口径重新表达同一行为。
  先把这段代码在做什么读懂，然后**关掉原文件自己写一遍**，比逐行改更快也更彻底。

### 硬边界（照抄方案，不许放宽）

- **不改写 git history**、不删导入 commit `491de0f`、不 force push。
- **不做「改名换结构降低相似度」的美化 pass。**
- **不动 `packages/db/prisma/migrations/` 里的 81 个历史迁移。**
- **不删第三方开源归属**（`NOTICE`）。`gsap` 是 GreenSock 的「no charge」商用许可、**不是 OSS**，
  别把它当 OSS 处理。
- **不碰 Phase 10 / 11**（换仓库、洗历史、改许可）—— **仍然挂起，等私仓/开源决定**。
  在决定之前不要做任何换仓库、洗历史、改 `LICENSE` 的动作。
- **不起长跑 CI job**：Free 2000 分钟/月，9 月已被三次失败发布烧掉 84%。
- 每批一个能单独 `git revert` 的 commit，**不许跨批混提**。commit message 用中文。

### 每批收尾必做（一条不能省）

1. `pnpm typecheck` → `pnpm build` → `pnpm test` → `pnpm k8s:validate` 四条全过。
2. 测试用 CI 口径跑：
   ```
   pnpm exec turbo run test --force --continue -- --reporter=default --reporter=json --outputFile.json=.vitest-report.json
   node scripts/check-test-report.mjs
   ```
   **本机跑之前先 `unset` 全部 `S3_*`** —— 本机 `.env` 配了 MinIO 会让
   `agents/routes.ts` 的 avatarUrl 用例期望落空，CI 那边是留空的。
3. `scripts/count-upstream-lines.sh` 重跑，实测值写回本文件的「进度」表。**写估算值等于没做。**
4. lint 按 CI 口径只看改动文件：
   `pnpm exec biome ci --changed --since=<base> --formatter-enabled=false --no-errors-on-unmatched`
   —— biome 只开了 `correctness.noUnusedImports` 一条规则，**改过的文件里绝不能留未使用 import**，
   包括本来就存在的那种（一改就会被 lint 到）。
5. **测试数量只许减不许多出红的**；删用例要说清删了哪些、为什么。

### 已经踩过的坑（重来一遍会在同样的地方绕同样的弯）

1. **`prisma migrate diff` 会想删三个 pgvector HNSW 索引**：
   `Chunk_embedding_hnsw_idx` / `Memory_embedding_hnsw_idx` / `NovelVectorMemory_embedding_hnsw_idx`。
   它们由 `20260713130000_bailian_embedding_v4_1024` 用裸 SQL 建，而 schema 里 `embedding` 是
   `Unsupported("vector(1024)")`、datamodel 认不出，于是被判成漂移。
   **删掉等于把知识库与记忆的向量检索退化成全表扫。生成任何迁移后都要手工摘掉这三条**，
   参照 `20260904080000_drop_retired_modules/migration.sql` 的头部注释。
2. **用 subagent / workflow 并行改文件时，子 agent 跑 `git rm` 会直接写索引**，主进程随后
   `git commit` 会把别的批次的删除一起提交。**提交前必须 `git diff --cached --name-only` 核一遍。**
3. **`components/ui/InAppSelect.tsx` 带 78 行上游代码**，是从已删的 `components/agent-teams/`
   搬过来的（生图的三个下拉在用）。它属于批次 A2。
4. **`AudioAsset` / `VideoAsset` 两张表现在没有生产者了**（写它们的模块都删了），素材库的
   video / audio 两个源只读得到存量行。改素材库时别以为是 bug。
5. `apps/api/src/models/routes.ts` 的模型目录是 **env 驱动**（`LLM_MODELS`），不是数据库表 ——
   原表在已被 DROP 的 billing 库里。改前端模型下拉时别去找那张表。

### 进度（每批收尾回填，实测值）

| 收尾于 | commit | 上游行实测 | 其中 lockfile |
|---|---|---|---|
| Phase 7+9+5+6 收尾 | `ef3ba7d` | 42,027 | 6,687 |
| 批次 A1 | | | 6,687 |
| 批次 A2 | | | 6,687 |
| … | | | |
| 全部完成 | | **6,687**（只剩 lockfile） | 6,687 |

**终点不是 0，是 6,687** —— lockfile 洗不掉，理由见上。它是版本与哈希清单，方案自己也写着
「无版权意义」。


