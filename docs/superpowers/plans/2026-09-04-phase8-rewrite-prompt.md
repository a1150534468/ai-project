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

#### 实测：blame 归零做不到，A1 已经触到地板（方案第三个量化错误）

A1 两个文件都是关掉原文件重写的，不是改名重排，blame 也只降到 **531**
（`index.css` 444 / `ui.tsx` 87），不是 0。把 444 行拆开看：**190 行是纯语法**
（111 行空行 + 79 行只有一个右花括号的行），其余 254 行**全是单条声明**。
最长的连续非平凡段只有 **6 行**（第 33~38 行，就是 `--good`~`--badbg` 六个色值），
≥3 行的段一共 38 段，无一例外属于下面三类：

- 颜色 token 清单（`--bg: #f6f5f2;` 这种，一行一个十六进制值）；
- 选择器加上它唯一可能的拼法（`display: grid;` / `grid-template-columns: 212px 1fr;`）；
- 设计常量本身（`150px 80px 1fr`、`max-height: 80vh`、`32px`）。

要让这些行「不一样」只有两条路：**改掉产品的颜色和布局**（那不是解耦，是改设计），
或者把 `#f6f5f2` 重写成 `rgb(246 245 242)`（跟本文件明令禁止的「换引号」是同一类美化 pass）。
两条都不走，所以 A1 到此为止。

**建议把判据从「blame 归零」改成「没有一行有语义的表达归属上游」**：空行、右花括号、
十六进制色值、`display: flex;` 这类只有一种写法的单条声明本来就不构成可著作权的表达。
A2~D 会撞同一块地板（`.tsx` 上是 `import` 行、`}` 行、`return (` 行），按老判据永远验收不了。

**A2 实测印证了这条地板。** 22 个文件全部关掉原文件重写，范围内仍剩 **825 行**归属上游
（本批净消 1,645 行：41,184 → 39,539）。残留最多的三个是 `Shell.tsx` 94 /
`AgentRail.tsx` 90 / `NavRail.tsx` 84 —— 把 Shell 那 94 行摊开：**24 行纯语法**
（空行、单独的 `}` / `)` / `</main>`、`return (`），**53 行是 props 声明或逐个转发**
（`onNewSession?: (agentId: string) => void;`、`currentSessionId={currentSessionId}`
这种一行一个），剩下十几行是 `import { Icon } from "@iconify/react";` 和 6 行
`toggleCollapsed`。这些行要「不一样」，只能改 props 名 —— 那就是改契约（`App.tsx` 与
测试都按名字调），而且正是本文件禁止的「改名降低相似度」。**结论与 A1 同：到此为止。**

**A3 第三次撞同一块地板，这次连「地板由什么构成」都数清了。** 22 个文件重写 + 6 个文件删除，
范围内从 2,372 降到 **991**（净消 1,381 行：39,539 → 38,158），消掉 58%。残留最多的是
`api.ts` 171 / `index.css` 81 / `chatAttachments.ts` 60。把 `motion/Toast.tsx` 那 36 行全列出来看
（这个文件是彻底重写的，连状态结构都从 `{ items }` 拍平成数组了）：4 行空行、
2 行 `import`、6 行是 JSX 属性各占一行（`initial="initial"` / `animate="animate"` /
`exit="exit"` / `className="glass-card"`）、11 行是 `}` `)` `);` `</motion.div>`
`</ToastCtx.Provider>` 这类收尾符号，剩下的是 `export function useToast(): ToastApi {` 起头那
4 行 —— 那 4 行里的错误文案 `useToast 必须在 ToastProvider 内使用` 是对外契约，测试按它断言。
`api.ts` 的 171 行同理：`streamChat(` 的 9 个参数一行一个、`export interface WorkflowImageAsset {`
这种头行、`}` 收尾。`index.css` 的 81 行里有 `@tailwind base;` 三条指令和
`height: 100%;` / `-webkit-font-smoothing: antialiased;` 这种只有一种写法的声明。

**三批实测（A1 531 / A2 825 / A3 991）足够定案了**：地板 = 空行 + 收尾符号 + import +
一行一个的 props/参数/属性/声明 + 契约字符串。这些行不构成可著作权的表达，
判据必须改成「没有一行有语义的表达归属上游」，否则 A4~D 一样验收不了，
而且再往下压只有两条路：改契约（props 名、错误文案、API 参数名）或做美化 pass，两条本文件都禁止。

**A4 补上一条地板之外的教训：「照着原来的树逐行换属性」不算重写，得把结构本身拆开。**
本批 9 个文件重写 + 1 个删除，范围内从 1,615 降到 **478**（净消 1,137 行：38,158 → 37,021），
消掉 70%。第一遍提交后逐行核对，发现 `MemoryFilters.tsx` 135 行里有 84 行归属上游 ——
JSX 树跟原文件一模一样，只有 `className` / `aria-*` 这些属性行是新写的，等于打了两个补丁。
第二遍把它按职责拆成搜索框 / 计数 / 开关 / 类型 chip 四块（开关提成
`components/ui/Switch.tsx`，全站本来手写了三遍），同一个组件的残留从 84 掉到 **28**，
渲染结果不变、13 条用例一条没改。**判断一个文件有没有真重写，看的是「树/控制流是不是自己搭的」，
不是行数差多少** —— 属性行本来就在地板里，换掉它们对残留几乎没有影响。

剩下残留最多的是 `pages/Memory.tsx` 107 / `MemoryDetailPanel.tsx` 94 /
`useMemoryGalaxyState.ts` 66。`pages/Memory.tsx` 那 107 行摊开：9 行 import、
21 行是 hook 返回值一行一个的解构、31 行是子组件 props 一行一个地转发
（`selectedId={selectedId}` 这种）、其余是 `<div className="…">` 与收尾符号 ——
类名字符串本身就是版面设计，改它等于改设计稿；这个页面的抽屉与页头在全站都只有一处，
提成公共组件没有第二个调用方，那就纯粹是美化 pass 了。**到此为止，与 A1~A3 同。**

**A5 第一次把范围内的残留压到三位数以下：1,012 → 162（净消 903 行：37,021 → 36,118）。**
本批 18 个文件：web `pages/Knowledge.tsx` 585 → 152 行、拆出 `components/knowledge/` 6 个源文件
+ 6 个测试文件，admin `pages/Knowledge.tsx` 重写 + 新增测试，另退役 `motion/Stagger.tsx`
（已无调用方，用例 −2）。web 侧拆出的 6 个组件文件**全部为 0**，整页只剩 20 行：
7 行空行、11 行收尾符号与 `return (`、1 行 import、1 行 interface 头行，
**没有一行有语义**，最长连续段 2 行。admin 侧剩 142 行：22 行空行、47 行纯收尾符号、
2 行 import，其余 71 行是块头、一行一个的 JSX 属性、四个 `<th>` 列名、产品文案
（「删除知识库」「批量上传文档」「+ 新建库」「例：产品文档」）、confirm 选项
（`confirmText: "删除"` / `danger: true`）、inline style 常量、一行一个的 interface 字段；
最长连续段 11 / 8 / 7 / 6 / 5 行，全是 `</…>` 堆和 `<th>` 列名 —— 与 A1~A4 的地板同一种成分。

**A5 给 A4 那条教训补一个正面例子：有第二个调用方时，「拆公共组件」是真重写而不是美化 pass。**
原来「我的库」和「官方库」是两段各自展开的 JSX，重写时收成一个 `KbList`（`official` 决定角标、
`onEdit`/`onDelete` 缺省即不渲染），树是按「一份实现两处用」重新搭的，残留直接归零 ——
对照 A4 里「抽屉与页头全站只有一处，提出去没有第二个调用方」的判断，两者的分界就是**调用方个数**。

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
6. **收尾第 3、4 步都只认已提交的状态，改完先提交再跑。** `count-upstream-lines.sh` 是
   `git blame HEAD`，工作区里改完没提交就跑，数字一动不动（A1 时实测：仍是 42,027，提交后才变
   41,184）。`biome ci --changed --since=<ref>` 同理，未提交的改动一个都不匹配，会报
   「Checked 0 files」。本机想按 CI 口径验，就在提交后跑 `--since=origin/main`
   —— 非 main 分支上 CI 用的就是这个基准（见 `ci.yml` 的「确定 lint 比对基准」）。
7. **CSS 不在 biome 的检查范围内**（`biome.json` 的 `files.includes` 只收 `.ts/.tsx/.mjs`），
   样式表改错了 lint 不会拦。CSS 的等价性只能靠「按构建 target 降级后逐规则对账」来验，
   A1 用的是 esbuild + postcss 拍平成「@规则上下文 + 单选择器 → 声明集合」再 diff。

### 进度（每批收尾回填，实测值）

| 收尾于 | commit | 上游行实测 | 其中 lockfile |
|---|---|---|---|
| Phase 7+9+5+6 收尾 | `ef3ba7d` | 42,027 | 6,687 |
| 批次 A1 | `d808589` | 41,184 | 6,687 |
| 批次 A2 | `e292c27` | 39,539 | 6,687 |
| 批次 A3 | `41cfa03` | 38,158 | 6,687 |
| 批次 A4 | `272e5a6` | 37,021 | 6,687 |
| 批次 A5 | `cacd6bb` | 36,118 | 6,687 |
| … | | | |
| 全部完成 | | **6,687**（只剩 lockfile） | 6,687 |

**终点不是 0，是 6,687** —— lockfile 洗不掉，理由见上。它是版本与哈希清单，方案自己也写着
「无版权意义」。


