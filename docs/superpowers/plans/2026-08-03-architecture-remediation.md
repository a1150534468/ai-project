# 架构整治执行计划（按严重度排序）

**Created:** 2026-08-03 · **Baseline:** `main` @ `d2c5625` · **Status:** 待执行

**Architecture:** 四个优先级，严重度递减、独立可交付。P0 止血（有用户已扣费但拿不到货的真实路径）→ P1 止腐（无门禁导致的系统性劣化）→ P2 可维护性（复制粘贴与巨型文件）→ P3 交回既有计划。每个任务独立成 commit，任何一步变红即 `git revert` 单个提交。

---

## 与既有计划的关系（执行者必读）

本计划**不重复** [`2026-07-27-legacy-workflow-optimization.md`](2026-07-27-legacy-workflow-optimization.md)。二者分工：

| 既有计划 | 状态 | 本计划的处理 |
|---|---|---|
| 阶段 0（修 `codex-pet-routes.integration.test.ts` 红灯） | 未执行（5 步未勾） | **并入本计划 P0.1**，与另一个红灯一起修 |
| 阶段 1（`codex-pet-runner.ts` 纯移动拆分，37 步） | ✅ 2026-08-22 完成（37 步全勾） | **不动**，见 P3.1 |
| 阶段 2（`executeRun` 去重 / lease CAS 收敛，14 步） | 未执行 | **不动**，见 P3.1 |
| 阶段 3（加厚 `packages/llm`，14 步） | 未执行 | **不动**，见 P3.1；本计划 P2.2 的去重范围**明确排除** llm 相关符号，避免撞车 |
| 阶段 4（article-workflow 止血 + reaper） | ✅ 2026-07-28 完成 | **作为 P0.3–P0.5 的模板复制源** |

**关键约束（项目已拍板，不要重新讨论）**：存量工作流保持自研编排、只做代码优化，不迁编排框架；新工作流才走框架选型。见 `docs/orchestration.md`。

---

## 范围边界（明确不做什么）

- **不迁编排框架**，不引入 Inngest/Temporal 等。
- **不改计费语义**：`reserve → work → 写终态 → settle`（失败走 `refundResource`）的次序与幂等口径一律不动。只补"没人兜底"的那一环。
- **不改 SSE / 事件表结构**，前端与 admin 直读的 Prisma 状态投影不变。
- **不改 `services/billing`（Go）**：该模块质量最高（测试比 0.81），本计划不碰。
- **不做前端框架迁移**：不引入 react-router / zustand / react-query。P1.2 只做 HTTP 层收敛，路由与状态管理留作独立决策。
- **不拆 `codex-pet-runner.ts`**：交由既有计划阶段 1。

## 前置条件

工作区当前有一批与本计划无关的未提交改动（`ArticleWorkflow*` 6 个文件）。**开工前请项目所有者自行提交或 stash；执行者不得代为提交这些改动。**

---

## 全局验证纪律（每个任务都适用）

### 1. 必须先 source `.env`，否则测试结果不可信

这是本项目最容易踩的坑，已实测确认**两种不同的失效方式**：

```bash
cd "/Users/z/code/ai project" && set -a && . .env && set +a
```

- **响亮失败**：`apps/api/src/admin/*.test.ts` 等在缺 `DATABASE_URL` 时 Prisma 初始化直接报错。实测 `admin/audit-routes.test.ts` 无 env 时失败、source 后 2/2 通过。
- **静默跳过 = 假绿**（危险）：**12 个测试文件**用 `describe.skipIf(!databaseEnabled)` / `skipIf(!have)` 守卫。缺 env 时它们**静默消失且退出码为 0**。实测：`codex-pet-failed-continuation.test.ts` + `codex-pet-recovery-finalizer.test.ts` 无 env 时 `2 passed | 4 skipped`，一个只看"绿不绿"的执行者会误报成功。

**执行者纪律**：报告测试结果时**必须同时报告 skipped 数**。只写 "passed" 不写 "skipped" 的报告视为无效。

### 2. 分层验证节奏

```bash
# 秒级：改完立刻跑
pnpm typecheck                                    # 基线：11/11 通过，~10s

# 定向：改哪个域跑哪个
cd apps/api && pnpm vitest run src/workflow/<domain>
cd apps/web && pnpm vitest run src/<file>

# 全量：仅在阶段收尾跑
pnpm test
```

### 3. 已知基线（不是你改坏的）

| 现象 | 判定 |
|---|---|
| `apps/web` `codexPetApi.test.ts` 1 例失败 | **P0.1 要修的红灯**，随 `fe35f44` 进 main |
| `apps/api` `codex-pet-routes.integration.test.ts` 红 | 既有计划阶段 0 未执行，P0.1 一并修 |
| 缺 `DATABASE_URL` 时 `apps/api` 大面积失败 | 环境问题，非代码缺陷 |
| `admin/code-routes`、`admin/membership-routes`、`admin/resource-routes`、`agents/routes` 共 12 例 | 既有计划阶段 4 已确认与代码改动无关（`.env` 可达性 / S3 已配置导致的预期差异） |

---

# P0：止血（有真实资金损失路径）

严重度最高的判据：**用户已被 `reserve` 扣了额度，但因为进程重启/崩溃，任务永久卡在 `running`，且没有任何机制退款**。

## 现状盘点（已实测，执行者不需重新调研）

| 域 | 兜底机制 | 能否退款 | 缺口 |
|---|---|---|---|
| `codex-pet` | lease + stale + cleanup 队列 | ✅ | 无 |
| `article-workflow` | ✅ `article-workflow-reaper.ts`（定时） | ✅ `billingOperationId` 列 | 无（阶段 4 已修） |
| `dub` | ✅ `dub-reaper.ts`（定时） | ✅ | 无 |
| `local-business-promo` | ✅ `local-business-promo-refund.ts`（定时） | ✅ | 无 |
| `image` | ⚠️ **有恢复逻辑但只被动触发** | ✅ `operationId` 可由 `requestId` 重建 | **P0.4** |
| `portrait` | ❌ 无 | ✅ `PortraitTask.billingOperationId @unique` **列已存在** | **P0.3（最便宜）** |
| `video` | ✅ 2026-08-05 补（主动扫 + 上游三态核对） | ✅ 由 `requestId` 派生，无需加列 | ~~**P0.5**~~ 完成 |
| `novel` | ✅ 主动恢复（worker 15s 一轮），`chapterRewrite` 缺口已修 | ✅ `operationId @unique` 列已存在 | **P0.7 已修（commit `bbff854`）** |
| `ecom-main` | ❌ 无 | ⚠️ `refund` 有 3 处调用 | **待审**（P0.6 改范围后未做） |
| `comic-production` / `report` / `audio` | ❌ 无 | ⚠️ 无 `reserve` 迹象 | **待审**（P0.6 改范围后未做） |

**模板源**：`apps/api/src/workflow/article/article-workflow-reaper.ts`（2711 字节，含 4 个测试用例）。它的形状是本项目的既定约定，P0.3–P0.5 一律照抄，不要另创设计：

- `updatedAt` 当心跳（runner 每步写进度，`@updatedAt` 自动刷新），超期即认定无人继续
- **先按原状态条件 `updateMany` 抢占置终态，抢到（`count === 1`）才退款** —— 避免与正在收尾的 runner 双写
- 退款**不清** `operationId`：`refundResource` 按 `operationId` 幂等，列值留作审计
- Redis `SET NX EX 55` 做多实例互斥，`setInterval` 60s
- **不要 `void tick()` 立即首跑**：与既有 3 个 reaper 形状一致，避免进程启动瞬间打 DB/Redis；阈值 15 分钟，首轮延迟 60s 无实质影响

---

## Task P0.1: 修复 main 上的两个红灯（约 1 小时）

`main` 当前红着。在此之上做任何重构都无法区分"我改坏了"和"本来就坏"。

### Step 1: 修 `apps/web/src/codexPetApi.test.ts`

- [x] 失败用例：`normalizes install links and project details used by knowledge-base actions`。断言 `expected { project: {…12}, …6 } to deeply equal { project: {…12}, …5 }`，多出的键是 `extraCallBudget: null`。
- [x] 根因：`extraCallBudget` 随 `fe35f44`（`fix(codex-pet): 按次计费下不再花钱不出图`）加进 `codexPetApi.ts` 的返回类型，测试 fixture 的 expected 对象没跟着加。
- [x] 改法：在该用例的 expected 对象补 `extraCallBudget: null`。**先读 `codexPetApi.ts` 确认默认值确实是 `null` 而非 `0` 或 `undefined`**，按实现对齐，不要凭猜。
- [x] 验证：`cd apps/web && pnpm vitest run src/codexPetApi.test.ts` → 10/10 通过。

### Step 2: 修 `apps/api/src/workflow/codex-pet-routes.integration.test.ts`

- [x] 直接执行既有计划的**阶段 0 Task 0.1 Step 1–2**（该文档已写好详细步骤，含行号与 mock 形状照抄来源 `codex-pet-routes.test.ts:494`）。
- [x] 摘要：`start` 路由改按图预留后，该测试的 billing mock 只有 `chargeResource`，缺 `reserveResource` → 503。需补 mock 并把断言从整包扣费语义改为按图预留（`reserveResource` 一次、units 14，常量见 `codex-pet-call-ledger.ts:5`）。
- [x] 验证（**必须 source `.env`**）：`cd apps/api && pnpm vitest run src/workflow/codex-pet-routes.integration.test.ts`，报告 passed **与 skipped** 两个数字。

### Step 3: 记录绿基线

- [x] source `.env` 后跑 `pnpm test`，把每个 workspace 的 `passed / failed / skipped` 三元组写进本文件末尾的「基线记录」小节。这是后续所有任务的对照基准。
- [x] Commit `test: 修复 main 上的 codexPetApi 与 codex-pet 集成测试红灯`

---

## Task P0.2: CI 门禁 + 假绿防护（约 2-4 小时）

**这是 P0 里唯一防止问题复发的任务。** 没有它，P0.1 修的红灯会再次悄悄变红——`extraCallBudget` 那个失败就是这样进 main 的。

- [x] **Step 1: 建 `.github/workflows/ci.yml`**。当前全仓无 `.github`、无任何 lint/formatter。最小可用门禁：
  - `pnpm install --frozen-lockfile`
  - `pnpm --filter @ai-assistant/db generate`（`typecheck` 脚本已依赖它）
  - `pnpm typecheck`（基线 11/11，最便宜的高价值门禁）
  - `pnpm test`，其中 `apps/api` 需要 Postgres + Redis service container
- [x] **Step 2: service container 与 env**。参照 `docker-compose.dev.yml` 起 `postgres` + `redis`；`DATABASE_URL` / `REDIS_URL` 指向它们。**不要把真实第三方 Key 放进 CI** —— `turbo.json` 的 `passThroughEnv` 已列 ~55 个变量，CI 只需喂 DB/Redis/`*_SECRET` 这类本地可造的，模型类 Key 留空（相关测试本就有 `skipIf` 守卫）。
- [x] **Step 3: 假绿防护（本任务的核心价值）**。CI 必须断言 skip 数不超过基线，否则"少跑了 40 个 DB 测试"会显示为绿：
  - 在 CI 里把 vitest 的 skipped 计数取出（`--reporter=json` 后读 `numPendingTests`），与提交进仓的基线数字比对，**超出即 fail**。
  - 基线数字取自 Step P0.1.3 的记录。
  - 12 个 `skipIf` 守卫文件清单：`memory/__tests__/embedding.poc`、`memory/__tests__/memory-store`、`storage/s3`、`workflow/codex-pet-generated-board-recovery`、`workflow/codex-pet-failed-continuation`（2 处）、`workflow/codex-pet-r7-recovery.poc`、`workflow/codex-pet-look.poc`（3 处）、`workflow/codex-pet-recovery-finalizer`、`workflow/codex-pet-runner.integration`。
- [x] **Step 4: 加 formatter（不加 linter）**。当前无 eslint/prettier/biome。建议 **biome**（单二进制、快、format + 基础 lint 一体），只开 `format` + `noUnusedImports` 一类零争议规则，**`--check` 模式进 CI 但先不改存量代码**（避免一次几万行 diff 淹没 review）。存量格式化留作独立提交，不在本任务范围。
- [x] **验证**：推一个故意加 `const x: number = "s"` 的分支，确认 CI 变红；推一个故意删 `.env` 依赖的分支，确认 skip 防护变红。**两个负向测试都要做** —— 只验证"绿的时候是绿的"证明不了门禁有效。
- [x] Commit `ci: 加 typecheck/test 门禁与 skip 计数防护`

---

## Task P0.3: portrait reaper（约 2-3 小时，P0 里最便宜）

选它作为 P0 第一个 reaper，因为**前置条件全都已经就绪**：`PortraitTask.billingOperationId String @unique` 列已存在，`@@index([status, updatedAt])` 已存在（正是 reaper 查询要用的索引），无需任何 migration。

> **⚠️ 本节 Step 2 的设计已被推翻，勿照抄。** 下面写的「抢占改 `failed` + 退款」对 portrait 是**有害**的：portrait 是可续跑域，标 `failed` 会把行永久踢出 `recover()` 的过滤器、丢掉已出的图。实际交付的是「主动扫续跑 + 计费对账」。原因与实现见文末执行记录 P0.3。**P0.4（image）同构，同样不要照抄收尸形状。**

- [x] **Step 1: 读模板**。通读 `workflow/article-workflow-reaper.ts` 与 `article-workflow-reaper.test.ts`（各 ~2.7KB / ~5KB），照抄结构。
- [x] **Step 2: 建 `workflow/portrait-reaper.ts`（TDD，先写测试）** —— ⚠️ 下列子项按执行记录 P0.3 的方案实施，非本节原文。
  - 查询：`prisma.portraitTask.findMany({ where: { status: "running", updatedAt: { lt: threshold } }, select: { id: true, status: true, billingOperationId: true } })`
  - 抢占：`updateMany({ where: { id, status: "running" }, data: { status: "failed", error: "服务重启或任务超时，已自动终止，可重新发起生成" } })`，`count !== 1` 则 `continue`
  - 退款：抢到后 `billing.refundResource(row.billingOperationId).catch(() => undefined)`
  - **先确认 `PortraitTask.status` 的实际取值集合**（读 `portrait-routes.ts` 的状态机），`running` 之外若有 `queued` / `processing` 一并纳入 `in` 列表。不要凭 `@default("running")` 就断定只有一个非终态。
  - 测试 4 例（照抄模板的用例形状）：超期被收割并退款 / 未超期不动 / 抢占失败（并发）不退款 / 无 `operationId` 不炸
- [x] **Step 3: `startPortraitReaper` + 注册**。`SET NX EX 55` + `setInterval` 60s，**不加 `void tick()`**、带 `timer.unref()`。⚠️ 注册位置**不是** `server.ts` 而是 portrait 插件内部，原因见执行记录。
- [x] **验证**：`cd apps/api && pnpm vitest run src/workflow/portrait` + `pnpm typecheck`。报告 passed/skipped。
- [x] Commit（实际文案 `fix(portrait): 卡单改为主动定时扫续跑并对账计费`，非原文的「超时收割与退款」——形状变了）

---

## Task P0.4: image 主动扫（约 3-4 小时）

image **已经有完整且质量不错的恢复逻辑** —— `reconcilePendingImageBilling`（`image-routes.ts:603`，处理 `settle_failed` / 卡在 `settling` / 状态已写但结算前崩掉的 `reserved`）+ `resumeStaleTasks`。**缺的不是逻辑，是触发器。**

现状：这两个只挂在 `resumeTasksIfNeeded`，而它只被 `GET /api/workflow/images/tasks`（:1016）和 `GET /api/workflow/images/state`（:1027）调用，且查询范围是 `listRecentTasks(prisma, userId)` —— **只扫当前轮询用户自己的行**。

后果：**用户如果不回来看，那笔 reserve 永远悬空**。反之，正在轮询的用户会顺手帮自己修好，所以这个 bug 在有人盯着的时候不可见。

> **⚠️ 本节 Step 1 的查询条件写错了，勿照抄。** 「查询改为 `status: { in: [...非终态] }` 喂给两个函数」对对账那趟是**永远零行**：`reconcilePendingImageBilling` 第一道过滤就是 `if (!terminalReasonOf(task.status)) return false`，只收终态行。而 image 只有一个非终态（`running`）。实际交付的是**两条查询、两趟**。详见文末执行记录 P0.4。

- [x] **Step 1: 抽出与用户无关的全局扫描**。新建 `workflow/image-reaper.ts`，复用**已有的** `reconcilePendingImageBilling` 与 `resumeStaleTasks`（**不要复制实现**）。~~查询改为跨用户：`where: { status: { in: [...非终态] }, updatedAt: { lt: threshold } }`~~ → 改为两条：续跑扫 `status: "running"`，对账扫 `status: { in: 三个终态 }, billingMode: "reserve", billingStatus: { in: ["reserved","settle_failed","settling"] }`。两条都吃已有的 `@@index([status, updatedAt])`。
- [x] **Step 2: 加 batch 上限**。`IMAGE_REAPER_BATCH = 200`，两条查询都带 `take`，可被参数覆盖（测试用 5 / 7 验证）。
- [x] **Step 3: 保留被动路径**。`resumeTasksIfNeeded` 在两个 GET 里原样保留，只是内部拆成 `reconcileTasksBilling` + `resumeTasksIfStale` 两个闭包好让 reaper 分别接线，合起来的行为与拆分前一致。
- [x] **Step 4: 注册 + 测试**。`startImageReaper` 照 P0.3 形状（Redis `SET NX EX 55` 抢锁 + `setInterval` 60s + `unref`，不立即跑一轮）。注册在插件内而非 `server.ts`（`resumeStaleTasks` 要 `scheduleTask`/`fetchFn`，只在插件闭包里有），`redis` 留成可选依赖；**新加了 `onClose` 钩子清定时器**（image-routes 原本一个都没有）。
- [x] **验证**：见文末执行记录 P0.4（含变异测试与 12 个既有环境失败的定性）。
- [x] Commit `fix(image): 计费对账与卡单恢复改为主动定时扫`

---

## Task P0.5: video reaper（约 3-5 小时）

video 有 `reserve`（1 处）、`operationId`（12 处）、`refund`（3 处），有 `listRecentTasks` 但**没有任何 resume/reconcile**。`VideoGenerationTask` 有 `@@index([status, updatedAt])` 与 `providerTaskId`。

- [x] **Step 1: 先查清能否退款**。`VideoGenerationTask` 未见 `billingOperationId` 列。确认 `operationId` 的构造方式：若像 image 一样由 `requestId` 派生（`video:${requestId}` 之类），则**无需 migration**，直接重建；若是随机 `randomUUID()` 且未落库，则**必须先加列**（照抄阶段 4 Task 4.1 的手写 migration 做法，见下方注意事项）。**这一步的结论决定本任务成本，先查再动手。**
- [x] **Step 2: 注意 `providerTaskId` 的语义差异**。video 是**外部异步任务**（先提交给上游拿 `providerTaskId`，再轮询结果）。这意味着"卡住"有两种：本地进程死了（应恢复轮询，**不是**直接失败），或上游任务真的没了（应失败退款）。**不要简单照抄 article reaper 的"超期即置 failed"** —— 那会把还在上游正常跑的长任务误杀退款。正确做法：超期先按 `providerTaskId` 向上游查一次真实状态，据此决定恢复轮询还是失败退款。
- [x] **Step 3: 实现 + 测试**。覆盖：上游仍在跑 → 恢复轮询不退款 / 上游已完成 → 结算 / 上游查不到 → 失败退款 / 无 `providerTaskId`（提交前就崩） → 直接失败退款。
- [x] **验证**：`pnpm vitest run src/workflow/video`（测试比 0.47，偏薄，本任务应顺带把新增分支的覆盖补厚）+ `pnpm typecheck`。
- [x] Commit `fix(video): 补上游状态核对式超时兜底`

**若需加列（Step 1 结论为"必须加"）**：dev 库存在与本次无关的历史 drift（`LocalBusinessPromoRun`、`NovelKnowledgeFact` 的索引名），**`prisma migrate dev` 会要求 reset 整个 schema，禁止执行**。照抄阶段 4 的安全做法：手写 `packages/db/prisma/migrations/<ts>_add_video_billing_operation_id/migration.sql` → `prisma db execute` → `prisma migrate resolve --applied` → `prisma generate` → `psql \d` 核对列存在。**不执行任何 reset。**

---

## Task P0.6: 剩余域定级（约 2-3 小时，纯调研 + 决策，不写实现）

`ecom-main` / `comic-production` / `report` / `audio` 四个域：`stale` / `resume` / `reconcile` 全为 0；`ecom-main` 有 `refund` 3 处、`reserve` 1 处，其余三个未见 `reserve`。

- [x] **Step 1: 逐域回答三个问题**并把结论写进本文件：① 是否 `reserve` 扣费？② 失败路径是否已同步退款？③ 进程中途死掉会留下什么状态？
- [x] **Step 2: 只对"是 + 无兜底"的域开任务**。不扣费的域（疑似 `report` / `audio` / `comic`）卡单只是脏数据，**不属于 P0**，降级到 P2 做状态清理即可。**不要为了整齐给每个域都加 reaper** —— 那是过度工程。
- [x] **Step 3: `ecom-main` 若确认扣费且无兜底**，按 P0.3 模板补，`EcomMainImageJob` 无 `status,updatedAt` 复合索引（只有 `[userId, createdAt]` 与 `[userId, stage]`），**需一并加索引**否则 reaper 全表扫。
- [x] Commit `docs: 补齐 ecom-main/comic/report/audio 的兜底定级结论`（若 Step 3 触发则另起实现提交）

> **执行时范围被改过**：用户指定只定级侧边栏那四个在用的工作流（生图 / 小说 / Codex 桌宠工坊 / 多平台图文），其余不动。`ecom-main` / `comic` / `report` / `audio` 的定级**未做**，Step 3 的加索引因此也没触发。详见下方执行记录。

---

### P0.6 执行记录（2026-08-06，范围改为侧边栏在用的四个域）

**范围变更**：原计划要定级 `ecom-main` / `comic-production` / `report` / `audio`。用户按侧边栏截图指定改为**生图模块 / 小说模块 / Codex 桌宠工坊 / 多平台图文工作流**，其余工作流不动。UI 标签到域 id 的映射取自 `apps/web/src/workflowState.ts:186` 的 `WORKFLOW_MODULES`（这是权威映射，不要靠猜）：

| 侧边栏标签 | 域 id | 此前状态 |
|---|---|---|
| 生图模块 | `image` | P0.4 已补 |
| 小说模块 | `novel` | **从未定级**，也不在原 P0.6 名单里 |
| Codex 桌宠工坊 | `codex-pet` | 已有 lease + stale + cleanup |
| 多平台图文工作流 | `article-workflow` | 阶段 4 已补 reaper |

侧边栏另有 `commerce-long-image` / `local-business-promo` / `ai-comic` / `scheduled-task`，用户明确排除。

**结论先行**：四个域里三个覆盖是真的（不是我假设的，逐条验了接线和第一道过滤条件）。**`novel` 有一个真缺口**，且不是"没建 reaper"，而是"已有的主动恢复把一类扣费任务漏在过滤条件外面"。

#### 逐域定级

| 域 | ① reserve 扣费 | ② 失败路径同步退款 | ③ 进程死掉留下什么 | 三分类 | 判定 |
|---|---|---|---|---|---|
| `image` | 是 | 是 | `running` + 未结算 reserve | 可续跑 | ✅ P0.4 已补，两条扫都在跑 |
| `novel`（普通生成 / 引擎 step） | 是（`novel-task-runner.ts:451`） | 是（`:490` 建行失败退、`:914` 跑挂退） | `queued`/`running` + 未结算 reserve | 可续跑 | ✅ 已有主动恢复，15s 一轮 |
| `novel`（`chapterRewrite`） | 是（同上，200–6000 字） | 是（进程活着时） | `running` + 未结算 reserve，**且无人恢复** | 可续跑 | ❌ **缺口，见下** |
| `codex-pet` | 是 | 是 | `queued`/心跳过期 run | 可续跑 | ✅ 60s maintenance 循环 |
| `article-workflow` | 是（`article-workflow-billing.ts:26`，唯一扣费点） | 是（`:37` 竞态退、`:47` 异常退） | `generating`/`revising` + 未结算 reserve | 该收尸 | ✅ reaper 已覆盖这两个状态 |

#### 覆盖是真的：验了什么

不满足于"文件存在就算覆盖"，逐个验了接线和过滤条件：

- **`image`** —— `startImageReaper`（`image-reaper.ts:103`）一个 tick 里跑**两条**：`scanStaleImageTasks` 续跑 `running` 超期，`reconcileStaleImageBilling` 对账终态但 `billingStatus` 未结算的行。接线在 `image-routes.ts:908`，`server.ts:163` 传了 redis 才起。两条 where 都干净，无附带排除。
- **`article-workflow`** —— 单一扣费点，reaper 覆盖 `generating|revising` 全集。**这个域是四个里最严谨的**：`runReservedArticleTextTask` 的 `commitResult` 返回 false 时**退款而不是结算**，注释写明了理由（"settle 会造成双结算，什么都不做则会漏一笔悬空 reserve"）—— 它把"reaper 抢先置 failed"这个竞态显式处理掉了，其余三个域没有等价保护。
- **`codex-pet`** —— 注册时没传 redis，兜底不在 API 进程，在 `codex-pet-worker.ts:1015` 的 60s maintenance 循环里，一轮同时做：计费意图激活对账、按图结算对账、`recoverStaleRuns`、停车 run 过期、退款失败重试（指数退避上限 24h）。`recoverStaleRuns` 的过滤是 `OR: [heartbeatAt: null, heartbeatAt < staleBefore, status: "queued"]`，默认 15 分钟，且**刻意不碰等审批的 run**（`:517` 有注释说明）。覆盖面比其余三个都宽。
- **`novel`** —— `novel-worker.ts:55` 有 15s 的 `recoveryTimer`，跑 `recoverInterruptedNovelSteps` + `recoverInterruptedNovelTasks`，比 reaper 的 60s 还密。**但过滤条件有问题**，见下。

#### 唯一缺口：`chapterRewrite` 落在两套恢复之间

`recoverInterruptedNovelTasks`（`apps/api/src/novel/outbox.ts:71`）第一道过滤是 `targetId: null`。

这道过滤**本身是刻意的、正确的**。`targetId` 在 `NovelTask` 上被两种语义复用：

- 引擎路径（`novel/runner.ts:69`）传 `targetId = stepId`。这类 task 由 `recoverInterruptedNovelSteps` 间接恢复 —— step 重新入队后 `runGeneratedTarget`（`runner.ts:58`）按 `targetId: stepId` **找回同一行 task、同一个 operationId** 继续跑。所以必须把它们从 task 恢复里排除，否则 step 和 task 两套恢复会重复入队。
- `chapterRewrite` 路径（`novel-routes.ts:471`）传 `targetId = chapter.id`。**没有 step 拥有它。**

于是 `chapterRewrite` 是唯一一类既进不了 task 恢复（`targetId` 非 null）、又没有 step 来救的扣费任务。Worker 中途死掉后：

1. task 停在 `running`（`novel-task-runner.ts:706` 一进来就置 running），`updatedAt` 停止刷新；
2. reserve 已扣（200–6000 字，`estimateReserveChars:112`），**既不结算也不退款**，钱一直压着；
3. `novel-routes.ts:454-462` 的 409 守卫按 `status in (queued, running)` 拦重试 —— **该章节的局部改写功能被永久锁死**；
4. 唯一出路是用户自己发现并调 `POST /tasks/:taskId/cancel`（`:692` 会退款）。要用户主动发现，不算兜底。

**为什么之前没被发现**：`outbox.test.ts:83` 那个测试的 mock 是 `findMany: vi.fn(async () => [row])` —— 完全不看 `where`，无论过滤条件写什么都返回那一行。这和 P0.5 里 video-routes 那个假通过的 mock 是同一个形状。过滤条件既没有测试钉住、也没有注释解释语义，`git log -S` 显示它和 `chapterRewrite` 是**同一个提交** `c07be4a`（2026-07-14 重构小说引擎）引入的 —— 当时只考虑了 step 那一种 `targetId`。

#### 顺带验清的两件事（都不是 bug，值得记下来免得后人重查）

**settle / refund 都幂等，`novel` 续跑不会重复计费。** 这是"续跑重跑整条链"这个设计能成立的前提，之前没人验过：

- `wallet/settle.go:38` `rec.Status != "reserved"` 直接返回 nil，更新谓词再兜一层 `WHERE status = 'reserved'`。已 settle 的行再 settle 是 no-op。
- `resource/charge.go:296` `refundablePoints` 对 `refunded` 状态返回 -1 → `:232` 直接跳过。已退的行再退是 no-op。
- 已 settled 的行**可以**退（退 `ActualPoints`，并反冲 VIP 成长值 `:244`）。所以"settle 成功但保存结果前进程死掉 → 续跑重跑 → 失败 → 退款"这条路径退的是实扣金额，语义正确。

**`NovelRun` 级不存在缺口。** 下一个 step 与它的 outbox 行**同事务创建**（`run-store.ts:126-144`），所以任何时刻要么上一个 step 还是 `running`（被 step 恢复捞走），要么下一个 step 已存在且 outbox 是 `pending`（被 dispatcher 捞走）。不需要 run 级扫描。失败侧也有闸：连续 3 次失败开断路器（`runner.ts:553`），step 和 run 一起置 `failed`，不会无限重试。

#### 一个次要的不对称（不是 P0，记下来）

`recoverInterruptedNovelTasks` 显式处理"queued 且 Redis job 丢了"（测试名就叫 `recovers queued generation tasks that may have lost their Redis job`），但 `recoverInterruptedNovelSteps` 只扫 `status: "running"`，**没有 queued 分支**。step 卡在 `queued` 而 outbox 已是 `sent` 时（Redis 被清/被淘汰）无人恢复。

严重度低于 `chapterRewrite`：不压钱（step 的钱在它的 task 上，task 要么已 settle 要么已 refund），且需要 Redis 真丢 job 才能触发。**不建议现在动** —— 加 queued 分支要先想清楚怎么和 BullMQ 的 `attempts: 3` 退避重试区分，否则会把正在退避等待的 step 提前抢走重跑。

#### 结论与后续

- **不需要迁移。** `NovelTask` / `NovelRun` / `NovelRunStep` 三张表都已有 `@@index([status, updatedAt])`。原计划 Step 3 担心的那类全表扫在 `novel` 这边不存在。
- **`chapterRewrite` 的修法**（未实施，需单独批准）：把 `recoverInterruptedNovelTasks` 的 `targetId: null` 换成"排除被 step 拥有的 task"这个真实意图。判据是 `targetKind`（`chapterRewrite` 恒为章节 id）而不是 `targetId` 是否为 null。**同时必须把 `outbox.test.ts:83` 那个不看 `where` 的 mock 改成按条件过滤**，否则改完还是假通过。
- 原计划的 `ecom-main` / `comic` / `report` / `audio` **本次未定级**，仍是待办。

---

## Task P0.7: 修 `chapterRewrite` 恢复缺口（约 1 小时，P0.6 查出）

排在 P1.1 前面的理由是顺序：这个缺口同时压着一笔钱（reserve 既不 settle 也不 refund）、一条卡在 `running` 的任务、以及一个把该章节改写入口永久 409 锁死的守卫。带着它去动 245 处鉴权重构是错的顺序。

### 根因

`NovelTask.targetId` 是一列两义：

| 创建点 | targetKind | targetId 存什么 | 谁负责恢复 |
| --- | --- | --- | --- |
| `novel-routes.ts:342` | `setup*` | null | `recoverInterruptedNovelTasks` |
| `novel-routes.ts:361` | `chapter` | null | `recoverInterruptedNovelTasks` |
| `novel-routes.ts:465` | `chapterRewrite` | **章节 id** | **没人**（缺口） |
| `novel/runner.ts:63` | `chapter` | **step id** | `recoverInterruptedNovelSteps`（必须排除） |

旧过滤条件 `targetId: null` 想表达的是"排除被 step 拥有的 task"，但它借了"targetId 是否为空"来表达这个意图。`chapterRewrite` 往同一列塞章节 id，于是被误判成 step 拥有，掉进两套恢复之间。

真正的判据是 `targetKind`，不是 `targetId` 是否为 null。

### 改动（3 处，commit `bbff854`）

1. **`novel/outbox.ts`** 新增 `TARGET_ID_HOLDS_STEP_ID: Record<NovelTargetKind, boolean>` 登记表，过滤条件改成 `{ OR: [{ targetId: null }, { targetKind: { notIn: STEP_OWNED_TARGET_KINDS } }] }`。

   用穷尽 `Record` 而不是裸写 `targetKind: { not: "chapter" }`，是因为**这个 bug 的成因是加新 targetKind 时没人想起这里**。类型写成 `Record<NovelTargetKind, boolean>` 后，往 `NOVEL_TARGET_KINDS` 加种类会直接编译失败，逼人表态。注释里写明了别改成 `Partial`。

2. **`novel/outbox.test.ts`** 把 `findMany: vi.fn(async () => [row])` 换成真按 `where` 过滤的 mock（`matchesWhere` + `taskRecoveryPrisma`）。**这一步不做，第 1 步改完照样绿灯** —— 原 mock 完全不看 `where`，所以过滤条件从来没被任何测试钉住，这才是缺口能混进主干的直接原因。mock 遇到不认识的算子直接抛错，避免以后改过滤条件时再退化成假通过。

3. 新增用例 `recovers a stuck chapterRewrite task but never one owned by an engine step`，5 行样本一次钉住四件事：`setup` / 路由直发 `chapter` / `chapterRewrite` 会被捞；step 持有的 `chapter` 不会被捞；未超时的不会被抢走。

### 双向验证（这次特意做了，不然等于没测）

改完就绿不能说明问题 —— 旧代码在旧测试下也是绿的。所以两个方向都反向验过：

- 把过滤条件退回 `targetId: null` → 新用例失败（`expected 2 to be 3`，少了 `rewrite`）。**证明它真能抓住这个 bug。**
- 把 step 排除条件整个删掉 → 新用例失败（`expected 4 to be 3`，多了 `chapter-engine`）。**证明原过滤条件防的重复入队没有因为这次修改而破掉。**

### 为什么是续跑不是收尸

重跑 `chapterRewrite` 幂等，已验：`novel-task-runner.ts:655-674` 在事务内重新校验 `chapter.content.slice(start, end) !== selectedText`，正文变了就抛错走 refund；版本快照 + 章节更新 + task 置 `succeeded` 同事务。所以"恢复期间用户正好编辑了这一章"是干净失败，不会写坏数据。配合 P0.6 验清的 settle/refund 幂等，续跑不会重复计费。

### 不需要迁移

`novelTask` 已有 `@@index([status, updatedAt])`，新增的 `targetKind` / `targetId` 谓词只在按 status+updatedAt 取出的窄结果集上过滤，且 `take: 100` 封顶。

### 未纳入本次范围

`recoverInterruptedNovelSteps` 仍无 `queued` 分支（P0.6 记录的次要不对称）。要动得先和 BullMQ `attempts: 3` 的退避重试对齐，否则会抢走正在等退避的 step。另外 `recoverInterruptedNovelTasks` 自身没有重试次数上限 —— 一个必然失败的 task 会被 90 秒一轮无限捞（每轮结局都是 refund，不重复扣钱，所以不压钱）。这两条都该单开任务，不塞进本次。

---

# P1：止腐（系统性劣化，改动面广但机械）

## Task P1.1: Fastify 鉴权装饰器（约 1-2 天）

一次消掉两类系统性问题：**245 处** `reply.code(401).send({ error: "未登录" })` 手抄，和 **69 处** `(req as unknown as { userId: string }).userId` 双重断言 —— 后者等于在类型系统上挖了 69 个洞，`FastifyRequest` 从未被正确扩展。

密集区：`novel/resource-routes.ts` 48 处、`dub-routes.ts` 22、`novel-routes.ts` 18、`codex-pet-routes.ts` 18、`comic-routes.ts` 15。

- [x] **Step 1: 扩展 `FastifyRequest` 类型**。建 `apps/api/src/auth/fastify.d.ts`，`declare module "fastify" { interface FastifyRequest { userId?: string } }`。这一步单独提交并跑 `typecheck`：**它会让 69 处双重断言变成冗余但不报错**，为后续机械替换铺路。
- [x] **Step 2: 建 `requireUser` preHandler**。放 `apps/api/src/auth/require-user.ts`，行为与现有内联逻辑**逐字节一致**（同样的 401 文案 `"未登录"`，同样的返回形状），避免前端出现任何可观测差异。
- [x] **Step 3: 按域逐个迁移，一域一提交**。**不要一次性全仓替换。** 顺序建议从密集区开始：`novel/resource-routes.ts`（48 处，收益最大）→ `dub-routes.ts` → `novel-routes.ts` → `codex-pet-routes.ts` → `comic-routes.ts` → 其余。每域改完立刻跑该域测试。
- [x] **Step 4: 注意例外**。部分路由的 401 可能带**不同文案或不同语义**（如 admin 侧、reseller 侧、`connector` 的设备鉴权）。迁移前先 `grep` 出该文件所有 401 文案，**文案不同的不要合并** —— 保持原样并在提交信息里说明为何排除。
- [x] **验证**：每域 `pnpm vitest run src/<domain>` + 全量 `pnpm typecheck`。阶段收尾跑一次 `pnpm test` 全量。
- [x] Commit（多个）`refactor(auth): <域> 鉴权收敛到 requireUser preHandler`

**顺带收益**：完成后 `apps/api` 的 `as unknown as` 计数应从 166 显著下降，可作为完成度的量化指标。

### P1.1 执行记录（2026-08-10，24 个提交，`99216eb..96e0830`）

> 末尾的 `96e0830` 是收尾的 lint 修正（清掉 3 处未使用 import，避免 `biome ci --changed` 把本批改动判红）。

#### 先纠三个指标（计划里的数字不完全准）

以 P1.1 起点 `bbff854` 实测：

| 指标 | 计划写的 | 实测 | 差在哪 |
| --- | --- | --- | --- |
| `reply.code(401).send({ error: "未登录" })` | 245 | **233** | 计划高估 12 |
| `(req as unknown as { userId: string }).userId` | 69 | **70**（生产）/ 84（含测试） | 差的 1 处是 `server.ts` 唯一写入点，计划没算成缺陷 |
| `apps/api` 生产 `as unknown as` | 166 | **170** | 量级一致 |

#### 计划没数到的第三类：`authUserId` 辅助函数

`workflow/ecom-route-helpers.ts:62` 和 `workflow/local-business-promo-route-helpers.ts:38` 各有一个 `authUserId`，函数体内一处 401 字面量，但被 **48 个调用点**用（11 个文件：`article-workflow-routes.ts` 12、`ecom-routes.ts` 11、`local-business-promo-project-routes.ts` 6、`ecom-main-routes.ts` 5、`report-routes.ts` 5、`local-business-promo-run-routes.ts` 3、四个 audio 路由文件各 2、`ecom-helpwrite-routes.ts` 1）。

这 48 处**不在 233 里**，因为它们早就收敛到了单一真相点，不是手抄。迁到 preHandler 能再省 48 行内联守卫，但那是"减样板"而非"消手抄"，**不属于 P1.1 声明的范围，留给用户决定是否单开任务**。

#### 两种挂法，区别是承重的

- **插件级钩子** `app.addHook("preHandler", requireUser)`：整个插件所有路由一起生效。一个文件一条 401 断言就够钉住。
- **逐路由** `{ preHandler: requireUser }`：**每条路由各自独立**。所以 54 处逐路由守卫必须**各有一条自己的 401 断言**，否则任何一条的 preHandler 被删掉都不会有人发现。

Fastify 的 `app.register(fn)` 会封装作用域，**直接调用不会**。`novel/routes.ts:370` 是直接调 `registerNovelResourceRoutes` / `registerNovelExportRoutes`，所以 3 个文件 60 条路由共享一个作用域——这是 novel 那 60 处能一次拿下的原因。

#### 结果

233 处字面量 → **22 处**（2026-08-17 codex-pet 尾巴补做后 → **5 处**，见下），其中 1 处是 `requireUser` 钩子本体（即收敛后的单一真相点）。原 233 里只剩 **21 处**，**消掉 212**。

21 个文件迁完：15 个插件级 + 6 个逐路由（`dub-routes.ts` 22、`comic-production-routes.ts` 14、`image-routes.ts` 8、`portrait-routes.ts` 7、`tools/routes.ts` 3、`auth/routes.ts` 1 = 55 条逐路由）。**2026-08-17 codex-pet 尾巴补做后：22 个文件 / 7 个逐路由 / 72 条逐路由。**

生产代码双重断言 **70 → 0**；生产 `as unknown as` **170 → 100**，正好降 70，与消掉的断言一一对应。

顺带删掉 6 个失效的 `userIdFrom*` 辅助函数（`tools.userIdFromRequest`、dub 内层 `uid`、`comic-production-helpers.userIdFrom` 等），`grep -rn "userIdFrom" src/` 现在只剩两条文档注释。

#### 双向验证：55/55「摘了就红」（2026-08-17 补做 codex-pet 后 72/72）

逐路由的每一条都单独摘掉 preHandler 跑过一次（`.cc-tmp/reverse-verify-per-route.py`，逐条摘→跑→从内存原文恢复）。image 8/8、portrait 7/7、dub 22/22、tools 3/3、comic-production 14/14 全部由红转绿，没有一条是"摘了还绿"的死断言。codex-pet 17/17 由临时给公开 artifact 路由挂上 requireUser 验证会红、再还原的方式反向验证。

`auth/routes.ts` 的 `/api/auth/me` 单独说：原有的「/me 未带 token 401」**只断了 statusCode，是个假绿**。摘掉守卫后 `req.userId` 是装饰器默认空串，`findUnique` 拿不到人会落到下一行的「用户不存在」，**那也是 401**，测试照样过。补上 `expect(r.json()).toEqual({ error: "未登录" })` 后反向验证才真的变红。

顺带补了本来完全没有路由测试的两个域：`tools/routes.test.ts`（新建，3 例）、`comic-production-routes.test.ts`（新建，3 例）。`dub-routes.test.ts` 把 5 条零散 401 用例合成 1 个 22 路由循环，用例数 24→20 但 401 覆盖 5/22→22/22。

#### 踩到的两个坑，都值得记

1. **注册时副作用会毒化 `not.toHaveBeenCalled()`**。`portrait-routes.ts:564` 在插件注册时就跑 `cleanupExpiredPortraitReferences`，它会调 `portraitReferenceAsset.findMany`——在任何请求之前。断这个方法会得到一条**永远红的假失败**，和路由无关。已在测试里写了警告注释，换成只断路由才会碰的方法。
2. **可选 mock 方法断了会直接抛错**。`listResourcePrices` 在 `BillingMock` 上是可选的、默认工厂不给，`expect(billing.listResourcePrices).not.toHaveBeenCalled()` 拿到 `undefined` 就炸。必须显式传进去。

#### Step 4 的例外（保持原样，逐条给理由）

| 位置 | 处数 | 为什么不合并 |
| --- | --- | --- |
| `memory/routes.ts` | 7 | 文案是 `Unauthorized` 而不是 `未登录`。合并会改变前端可观测的响应体 |
| `local-business-promo-audio-blob-routes.ts` | 2 | **看着像守卫其实不是**：条件是 `!isOwner && !hasSignedAccess`，签名 URL 访问是合法路径。换成 `requireUser` 会把签名链接打死 |
| `auth/routes.ts` | 2 | `账号或密码错误`、`用户不存在`——登录失败和查不到人，语义不同 |
| `admin/routes.ts` | 1 | `账号或密码错误，或已被禁用`，admin 侧独立会话 |
| `image-routes.ts` | 1 | `图片地址已失效`——签名过期，不是未登录 |
| `codex-pet-routes.ts` | 1 | `资源地址已失效`，同上 |

另外给 7 条**故意公开**的路由（provider 回调、签名 URL blob、静态目录、登录注册）都补了正向可达性断言，这样以后有人给整个插件加钩子时会立刻红，而不是静默打死回调。

#### 未纳入：`codex-pet-routes.ts` 的 17 处 —— **阻塞已解除（2026-08-13）**

当时这是唯一**因为工作区状态而非技术原因**推迟的文件：它有未提交改动（属于项目所有者在做的另一件事），按约定不动。同理跳过 `codex-pet-routes.test.ts` 和 `codex-pet-routes.integration.test.ts` 里各 1 处测试侧双重断言。剩下 8 处测试侧断言已清（提交 `281c3ab`，可单独 revert——它超出计划的 69/70 指标）。

**2026-08-13 更新**：那批改动已由项目所有者在 `661503f..8f29992` 提交入库，工作区现已干净，**这个阻塞不存在了**。补做时注意：18 条路由里跳过 `资源地址已失效` 那条签名产物路由（约 L2863），并删掉它自己的 `userIdOf` 辅助函数；两处测试侧双重断言也可一并清掉。做完则 401 字面量从 22 降到 5（`requireUser` 本体 1 + audio-blob 2 + 两个 `authUserId` 辅助 2），生产双重断言维持 0、测试侧归零。

**2026-08-17 补做完成（提交 `d0a5a56`，落在 main = `3455285` 之后）**：17 条逐路由全部迁到 `{ preHandler: requireUser }`（跳过签名产物公开路由 `资源地址已失效`），删掉 codex-pet 内层 `userIdOf`；`codex-pet-routes.test.ts` / `integration.test.ts` 各 1 处测试侧双重断言清掉，全仓 `as unknown as { userId` 归零。测试新增 17 条表驱动 401 断言（逐路由各自独立，一一对应）+ 1 条公开 artifact 路由 200 正向断言（不带 x-test-user，防有人顺手补上 requireUser）。401 字面量 **22 → 5**，`codex-pet-routes.test.ts` 43 → 61 例。全量对照：admin 11 例 + agents 1 例失败为已知本地 env artifact（billing/minio 活、测试期望不可达，见 ci-baseline-gotchas 第 7 条），与本次改动无关；audio 两文件通过。CI 结果见会话报告。

#### 收尾验证

| 项 | 结果 |
| --- | --- |
| CI run `31352292232`（HEAD=`281c3ab`） | `success` |
| 全仓 | **passed 2433 / failed 0 / skipped 23**，基线下限 2411、skipped 上限 23、workspaces 10/10 |
| `apps/api` 单独 | 1747 passed / 0 failed / 18 skipped（232 文件通过 / 6 文件跳过） |
| `tsc -p apps/api/tsconfig.json --noEmit` | exit 0 |
| `biome ci`（每个改动文件） | 无发现 |

推送前预测的 passed 是 2433（2429 + image 1 + portrait 1 + dub −4 + tools 3 + comic-production 3），实际命中。P1.1 期间 CI 全绿的四个 run：`31073858638`、`31349555444`、`31351079405`、`31352292232`。

本地跑全量时要注意：`admin` 11 条失败和 `agents` 头像那条都是 `.env` 真值覆盖不掉测试 `??=` 占位值导致的，不是代码问题（详见下节）。

#### 一个环境坑（不是代码问题，但会让人误判）

本地 `.env` 配了 MinIO，`agents/routes.test.ts` 的头像上传用例注释写着"测试环境无 S3，回落到裸 key"，于是本地必红（拿到完整 URL）。和 admin 那 11 条 `BILLING_BASE_URL` 是同一类：**测试用 `??=` 设占位值，`.env` 里已有真值时覆盖不掉**。跑这两个域前要 `unset` 对应变量，否则会把环境干扰当成自己改坏了。已 `git stash` 验证过：改动拿掉后照旧失败。

---

## Task P1.2: 前端统一 HTTP 客户端（约 2-3 天）

现状：**13 个 API 客户端模块、106 处裸 `fetch`**（`api.ts` 一个文件 75 处），`token` 手工穿透 **175 个导出函数**（`token: string` 出现 241 次），`authorization: Bearer` 手拼 **105 次**。改一次鉴权或加一次全局 401 跳登录要动上百处。

**好消息：底座已经有了，本任务是"扩展已有"而非"新建"**：
- `apps/web/src/apiError.ts` 已有 `ApiError`（含 `status` + 结构化 `data`）、`readErrorMessage`、`readErrorBody`
- 后端响应壳已统一：`{ success: true, data }` 共 243 处，`api.ts:18` 已有 `unwrapData`

- [x] **Step 1: 建 `apps/web/src/http.ts`**。一个 `request<T>(path, init)`：注入 `authorization`、统一 `content-type`、非 2xx 用**已有的** `readErrorBody` 抛**已有的** `ApiError`、成功走**已有的** `unwrapData`。**不要重新发明这三个** —— 直接 import。→ 另配了一个 `requestResponse()`（同鉴权同报错，但不碰 body），给流式与 blob 用；`unwrapData` 按项目所有者要求从 `api.ts` 搬进 `http.ts` 并导出。
- [x] **Step 2: token 来源集中化**。当前 175 个函数收 `token` 参数。**不要一次性改签名**（会波及整个组件树）。先让 `http.ts` 支持"显式传入 token"与"从集中处读取"两种，存量调用保持传参不变；新代码不再传参。签名收敛留作后续独立任务。→ 三态：省略 = 回落集中存储、`token: "x"` = 显式、`token: null` = 明确不带（登录/注册/公开菜单/模型列表用）。
- [x] **Step 3: 按模块逐个迁移，一模块一提交**。顺序：先挑最小的 `portraitApi.ts`（1 处 fetch）验证封装形状，再 `workflowArticleApi.ts` / `workflowEcomApi.ts` / `workflowComicApi.ts`（各 1 处）→ `codexPetApi.ts`（3）→ `workflowLocalBusinessPromoApi.ts`（3）→ `dubApi.ts`（4）→ `agentTeamApi.ts`（8）→ `videoApi.ts`（9）→ **`api.ts`（75 处，最后做，单独拆多个提交）**。→ 照此顺序做完，`api.ts` 拆成 3 个提交（账号/聊天流/工具市场/计费 → 小说与生图 → 记忆/会员/会话/智能体/知识库）。
- [x] **Step 4: 注意 SSE / 流式不能走通用封装**。`streamChat`（`api.ts:60` 起）与 codex-pet 的事件流是流式读取，`request<T>()` 的"读完 body 再 JSON.parse"模型不适用。**这些保持裸 `fetch`**，只把 header 构造抽出复用。识别方法：`grep` 含 `getReader()` / `ReadableStream` / `text/event-stream` 的调用。→ 改成走 `requestResponse()`：鉴权与报错也收敛了，body 原样留给 reader，比"只抽 header"更彻底。
- [x] **验证**：`cd apps/web && pnpm vitest run`（基线 415 passed / 1 failed，P0.1 后应为 416/0）。该模块测试比仅 0.25，**回归信号弱** —— 每迁一个模块建议手动点一遍对应页面。→ 实测基线已是 85 文件 / 438 passed / 0 failed / 0 skipped（计划里的 415/1 早已过时）；按项目所有者要求**只跑自动化不手点页面**，另给 `http.ts` 补了 10 个单测。
- [x] Commit（多个）`refactor(web): <模块> 迁移到统一 http 客户端`

### P1.2 执行记录（2026-08-24，9 个提交）

**计划里的数字全部偏低**（计划统计的是 `await fetch(` 之类的窄模式，漏了多行写法与私有 wrapper 内部的调用）：

| 指标 | 计划写的 | 实测（02a6f59） | 完工后 |
| --- | --- | --- | --- |
| 非测试代码裸 `fetch(` | 106 | **124** | **4** |
| 其中 `api.ts` | 75 | **75** ✓ | **0** |
| 含裸 `fetch` 的文件数 | 13 个模块 | **19 个文件**（13 个 API 模块 + 6 处散落在组件/页面里） | **3** |
| 手拼 `authorization: Bearer` | 105 | **109** | **1**（`http.ts` 自己那一处） |
| `token: string` 形参 | 241 | **321** | 未动（Step 2 明确留作后续任务） |

**剩下 3 处裸 `fetch` 是故意留的，不是漏迁**：`components/workflow/imageDownload.ts:54`、`components/workflow/articleWorkflowImageDownload.ts:44`、`components/workflow/ecomWorkflowStitch.ts:51`（`defaultFetchBlob`）。这三处下载的是**对象存储 / CDN 的外站 URL**，走注入 `authorization` 的统一客户端会把 bearer token 送给第三方主机。三处都就地写了注释说明。`ecomWorkflowStitch` 的同源分段 blob 由调用方 `EcomWorkflowStudio` 注入带鉴权的 `fetchBlob`，所以只有兜底路径是裸 `fetch`。

**迁移中踩到 / 提前拦下的三个坑**：

1. **`unwrapData` 会吃掉信封的兄弟字段**。`/api/model-marketplace` 回的是 `{ data: rows, vip }`，`request<T>()` 只会把 `data` 拿出来，`vip` 静默丢失。这一处改用 `requestResponse()` + 手动 `.json()`。全仓扫过，只有它一个是这种形状。
2. **私有 wrapper 的 body 双重编码**。`novelEngineRequest` 原签名收 `RequestInit`，~30 个调用点自己 `JSON.stringify(...)`；改成收原始对象后必须同步把调用点的 `JSON.stringify` 全脱掉，否则 body 变成 JSON 字符串的 JSON。共脱掉 13 处（其余调用点本来就没有 body）。
3. **CI 的 lint 门会因为"你碰过这个文件"而追责既有问题**。`biome ci --changed` 对触碰过的文件全量报 `noUnusedImports`，包括迁移前就存在的。`EcomWorkflowStudio.tsx` 的 `createEcomMasterPayload` 属于这类，必须一起删掉才能过门。

**顺手清掉的重复**：`api.ts` 里 11 个只描述 `{ success, data }` 壳的信封 interface（`MemoriesListResponse` / `MemoryGalaxyResponse` / `MemorySearchResponse` / `UpdateMemoryResponse` / `MemoryToggleResponse` / `MembershipCardResponse` / `MyMembershipsResponse` / `KnowledgeBasesResponse` / `KbDocumentsResponse` / `KbDocumentResponse` / `KbQuotaResponse`）在 `unwrapData` 内化之后已无价值，全仓确认无外部引用后删除；月卡列表那个 11 行的匿名行内类型提成 `MembershipCard`。`api.ts` 自带的重复 `ApiError` 也删了 —— 现在全仓只有 `apiError.ts:1` 一个定义，所有 import 都指向它。

**刻意没有"顺手改好"的行为**：登录、注册、`Login.tsx` 三处原本把后端报错吞掉换成固定文案（避免泄露账号是否存在），迁移后仍然 `catch (ApiError)` 覆盖文案，不让统一客户端把后端原文透到界面上。`listModels` 的"服务端报错就回空列表"和两个头像接口的 429 固定提示语，同样按 `ApiError.status` 原样保留。

**验证**：每个提交都过 `npx tsc -p apps/web/tsconfig.json --noEmit` + `npx biome check --formatter-enabled=false <改动文件>`，最后按 origin/main 为 base 跑了一次 `biome ci --changed`（模拟 CI lint 门，23 个文件 0 error）。测试 **85 文件 / 448 passed / 0 failed / 0 skipped**（438 基线 + `http.test.ts` 10 个新增），每个检查点复现一致。


---

## Task P1.3: 仓库卫生（约 30 分钟，成本最低）

`.cc-tmp/` 有 **343 个文件已提交入库**，其中 **212 个二进制**（png/jpg/zip/log），磁盘 220MB，102 个子目录；`.workbuddy/` 4 个文件。`.gitignore` **未包含这两个目录**，所以还在持续入库。

- [x] **Step 1:** `.gitignore` 追加 `.cc-tmp/` 与 `.workbuddy/`。→ `.cc-tmp/` 早已在 `.gitignore:4`（`5485de4` 带进来的）；`.workbuddy/` 按项目所有者决定**不加**。
- [x] **Step 2:** `git rm -r --cached .cc-tmp` —— **只从索引移除，保留磁盘文件**。`.workbuddy` 不动。
- [x] **Step 3:** 提交。**不做 history rewrite**（`filter-branch` / `bfg`）—— 220MB 已在历史里，重写会打断所有人的 clone，收益不抵风险。此步只阻止继续增长。
- [x] Commit `chore: .cc-tmp 停止入库（只脱离索引，磁盘文件全留）`（`cb33b6a`）

### P1.3 执行记录（2026-08-13，1 个提交 `cb33b6a`）

**计划描述与实测的出入**：`.gitignore:4` 早就有 `.cc-tmp/` 了，但**已跟踪的文件不受忽略规则影响** —— 这正是它还在增长的原因。所以 Step 1 实际无需改动，真正没做的是 Step 2。

| 指标 | 计划写的 | 实测 |
| --- | --- | --- |
| `.cc-tmp` 索引内文件数 | 343 | **456** |
| 其中二进制 | 212 | **230** |
| 索引内 blob 体积 | 220MB | **218.6MB** |
| `.workbuddy` 文件数 | 4 | **6** |

**`.workbuddy` 保留入库**（项目所有者决定）。理由：`git rm --cached` 记录的是一次删除，**别人 pull 之后工作树里这些文件会被真删掉**。`.cc-tmp` 是调试产物无所谓，但 `.workbuddy/memory/*.md` 是有意共享的工作日志。

**磁盘零损失的证明**：提交前后各测一次 `find | wc -l` = **473**、`du -sh` = **220M**、路径清单 `sha1` = `689421294f33abd1a2a045ec48f65530f32945e5`，三项完全一致。提交内容 456 条全是 `D`，越界文件 0 条，`.workbuddy` 索引数保持 6 且 status 干净。

---

## Task P1.4: env 中心化校验 + 文档入库（约 4-6 小时）

现状：`process.env` 读取 **105 个变量**，`.env.example` 只记 78 个 → **27 个未文档化**。`apps/api/src/env.ts` **只 loadEnvFile 不校验** —— 缺 key 的表现是跑到一半才炸。`turbo.json` 手工列了 ~55 个 `passThroughEnv`，正是"无中心配置"的症状。

### 执行前实测（2026-08-13）：几个数字和一处描述要改

| 指标 | 计划写的 | 实测 |
| --- | --- | --- |
| Node 侧读取的 env 变量 | 105 | **103**（另有 Go 计费服务 `os.Getenv` 读 **11** 个） |
| `.env.example` 记录 | 78 | **78** ✓ |
| 未文档化 | 27 | **28 个真实配置 + 25 个测试/POC 专用**（后者本就不该进 `.env.example`） |
| `turbo.json` `passThroughEnv` | ~55 | **48** |
| `docs` 下文档已入库 | 17 份中 3 份 | **20 份中 0 份** |

**描述要改的一处**：「`env.ts` 只 loadEnvFile 不校验」不准确。校验是**有**的，只是**懒且分散** —— 仓库里有 **104 个** `loadXConfig(env: NodeJS.ProcessEnv = process.env)` 形态的可注入读取函数，其中 **12 个**带 `throw new Error("X required")`（如 `storage/s3.ts:20` 的 `loadS3Config`、`novel/queue.ts:11` 的 `requiredRedisUrl`）。「跑到一半才炸」的真因不是没校验，而是**校验发生在模块首次被用到时**，而不是启动时。

**这一层不能推倒**：`env` 参数可注入正是测试能 `vi.stubEnv` / 传假 env 的原因，换成模块级单例 zod schema 会把这 104 个注入点全打死。正确做法是**加一层启动期聚合校验**（启动时就把「必需」那一档跑一遍，缺则拒绝启动），保留现有可注入读取器不动。

**Step 3 的实情比计划更糟**：`.gitignore:16` 是 `docs/*`，17-21 行白名单了 3 个文件 —— 但 `docs/api-reference.md`、`docs/codex-pet-workflow.md`、`docs/development/novel-workflow-e2e-audit-2026-07-15.md` **在磁盘上都不存在**，是早就改名或删掉的路径。所以白名单整套失效，`docs` 下 20 份文档、16755 行**一份都不在版本控制里**（含 `dub.md` 4204 行、`novel.md` 3283 行、`wechat.md` 2382 行、`fanout.md` 2018 行，以及本计划自己）。

**Step 4 死链已确认**：`DESIGN.md:3` 指向 `docs/reference/design-system.md`，该路径不存在，实际在 `docs/design-system.md`。

- [x] **Step 1: 生成完整清单**。`grep -rhoE "process\.env\.[A-Z_0-9]+" apps/api/src packages | sort -u`，与 `.env.example` 对差集，补齐 27 个缺失项（含用途注释）。
- [x] **Step 2: 建 zod schema + 启动 fail-fast**。在 `env.ts` 加 schema，**区分三类**：启动必需（`DATABASE_URL` / `REDIS_URL` / `SESSION_SECRET`）→ 缺则拒绝启动；功能可选（各模型 Key）→ 缺则该功能降级并在启动日志 `warn`；有默认值的调参 → 直接给默认。**不要把所有变量都设为必需** —— 会让本地只想跑对话功能的人无法启动。
- [x] **Step 3: 文档入库**。`docs/*` 被 `.gitignore:13` 整目录忽略，**17 份文档只有 3 份入库**，14 份设计文档（含 4204 行的 `dub.md`、3283 行的 `novel.md`）不在版本控制里。改 `.gitignore` 为白名单反转（保留 `docs/`，只忽略确需忽略的），或明确 `!docs/*.md`。**此步需项目所有者确认** —— 可能存在故意不入库的敏感内容。
- [x] **Step 4: 修 `DESIGN.md` 死链**。它指向 `docs/reference/design-system.md`，该路径不存在，实际在 `docs/design-system.md`。
- [x] **验证**：故意删 `DATABASE_URL` 启动 → 应立刻明确报错而非跑到一半炸；删某个模型 Key → 应能启动且日志有 warn。
- [x] Commit `chore(env): 中心化校验与启动 fail-fast` + `docs: 设计文档入库并修死链`

### P1.4 执行记录（2026-08-17）

**死变量排查（前置调查，零改动）**：全量扫描（含间接 `env.X` 与 `helper(env, "KEY")` 字符串传参两种读取形态）后结论——**代码层面没有真死配置**。`.env.example` 记了但代码"看似不读"的 39 项里 37 项是活的（读取形态多样导致初扫误判）；`MINIO_ROOT_USER/PASSWORD` 是 docker-compose minio 容器的 infra 凭据（Node/Go 不读，保留）；`.env` 里仅 `ARTICLE_WORKFLOW_MODEL` 1 项代码与 example 都不引用，但它在 `article-workflow-routes.ts:58` 有 `env.ARTICLE_WORKFLOW_MODEL?.trim() || env.LLM_DEFAULT_MODEL` 读取（漏扫），实为活变量。**未文档化真实配置 32 个**（Node 24 + Go billing 8）已全部补进 `.env.example`（注释形式，与现有风格一致）；`RUN_*_POC` 等 18 个测试/POC/脚本专用变量明确不进 example。

**Step 2 落地**：`env.ts` 新增 `REQUIRED_ENV`（DATABASE_URL/REDIS_URL/SESSION_SECRET）+ `OPTIONAL_FEATURE_ENV`（7 个模型 Key）+ `assertRequiredEnv()`/`warnMissingOptionalEnv()`。挂载点：`server.ts` 真实启动入口 + 3 个 worker（codex-pet/novel/local-business-promo）的 `main()` 开头——**测试入口不经过**，不毒化 vitest。未用 zod：手写数组校验足够且零依赖；保留 104 个 `loadXConfig` 可注入读取器不动（那是测试传假 env 的根基）。

**Step 3/4 落地**：`.gitignore` 的 `docs/*` + 4 条失效白名单（指向不存在的文件）替换为仅忽略 `docs/.DS_Store`；20 份 md 全部入库。`DESIGN.md:3` 死链已修为 `docs/design-system.md`。整理：`docs/README.md` 补 `ai-collaboration.md` 与 `superpowers/plans/` 导航；`docs/codex-pet.md` 遗留的 `docs/reference/codex-pet-ops.md` 引用更新为"已归并入本文档"；`docs/ai-collaboration.md` 的「不入库」过时声明更新。

**验证**：① 删 DATABASE_URL/REDIS_URL/SESSION_SECRET 后 `assertRequiredEnv` 打印三条明细并 exit 1（单元验证，`UNREACHABLE` 未打印）；② 正常启动：4 个未配模型 Key（EMBEDDING/MIMO/SKYHUMAN/TOAPIS）打出 warn，服务照常 listen。tsc 0、相关测试 75 passed。

### P1.4 返工（2026-08-22）：上一轮 6 处不到位

上一轮验收放过了，复查发现 6 处问题，本次一并修掉。

| # | 问题 | 根因 / 影响 | 修法 |
| --- | --- | --- | --- |
| 1 | `.env.example` 只补了 32 个，**还差 36 个真实配置** | 上一轮扫描漏了 `env.X`（注入式 `loadXConfig` 的参数）这种读取形态，而 workflow 各域几乎全用它 → 整族配置没记上：SMTP×6、VIDEO/TOAPIS×6、SEEDANCE×3、VISION×2、IMAGE×7、PORTRAIT/TRY_ON×4、AUDIO×1、CODEX_PET 重试×3、各域模型覆盖×3 | 按域分组补齐 36 项（注释形式 + 用途 + 默认值 + 回落关系）；补后重扫「该进 example 的未文档化 = 0」 |
| 2 | `.env.example` 出现重复项 | `NOVEL_WORKER_CONCURRENCY` 第 99 行已有实值，补齐块里又写了一条注释版 | 删掉重复的注释版；加重复检查（184 条目 / 184 唯一） |
| 3 | fail-fast 漏了 `ADMIN_SESSION_SECRET` | `server.ts` 无条件 `register(adminRoutes)`，而 `admin/routes.ts:27` 在**注册期**就要求它 ≥32 字节 —— 缺它服务照样起不来，正是「启动必需」档 | 新增 `SERVER_REQUIRED_ENV = REQUIRED_ENV + ADMIN_SESSION_SECRET`；worker 不注册后台路由，仍用 `REQUIRED_ENV` |
| 4 | 只判「非空」，不判长度 | 5 处代码写着 `secret.length < 32 → throw`（`auth/routes.ts:23`、`admin/routes.ts:27`、`image-routes.ts:279`、`local-business-promo-media-access.ts:7`、`codex-pet-storage.ts:96`），其中两处是注册期抛。配一个 8 字节的 SESSION_SECRET 能通过聚合校验，然后 `buildServer()` 照样炸 —— 这一层的目的就落空了 | `EnvRequirement.minLength`，两个密钥都标 32 |
| 5 | 可选档报假警报 | `warnMissingOptionalEnv` 逐 key 判存在，但 4 个 key 有等价回落：`BAILIAN←DASHSCOPE`、`GPT_IMAGE←CHATGPT`、`EMBEDDING←BAILIAN/DASHSCOPE/LLM_API_KEY`、`TOAPIS←VIDEO_API_KEY`（`video-service.ts:149` 首选后者）。配了 VIDEO_API_KEY 的人会被告知「视频解析不可用」 | `EnvRequirement.alternates`，任一有值即视为已配 |
| 6 | **零测试** | `assertRequiredEnv` / `warnMissingOptionalEnv` 全仓无测试文件，「验证」是一次性手工跑。删掉入口的调用、删掉任一必需项，仓库不会有任何测试变红 —— 正是 P1.1 花力气消灭的那类无人看守代码 | 新增 `apps/api/src/env.test.ts`（14 例）：纯函数 `collectEnvProblems` 抽出来专供断言；两条源码级钉子分别钉住「注册期 ≥32 字节的密钥必须在 `SERVER_REQUIRED_ENV` 里」和「5 个进程入口都调用了启动校验」 |

**顺带清掉的死链**：上一轮只修了计划点名的 `DESIGN.md:3`。全仓链接扫描（192 条内部链接，含锚点校验）发现另有 6 条死链，全部指向 `docs/` 下不存在的子目录（`docs/setup/` `docs/reference/` `docs/lessons/` 从来没有过）：根 `README.md` 4 条（`:19` `:26`×2 `:56`），`infra/k8s/README.md` 与 `infra/k8s/overlays/local/README.md` 各 1 条（指向从未入库的 `docs/setup/deploy-k8s.md`）。修后 **192 条链接 / 0 死链**。

**顺带修掉的文档陈述**：`docs/ai-collaboration.md` 是上一轮刚入库的，里面两处声明当场就是假的 —— `:39`「当前 main 是红的」（实际绿，2542 passed）、`:202`「docs 被 gitignore，17 份只有 3 份入库」（实际 23 份全入库）。已改成现状，并补了「本地 12 例假红不要修」的清单。

**双向验证（7/7 破了就红，脚本 `.cc-tmp/reverse-verify-env.py`）**：去掉 `SESSION_SECRET` 的 `minLength` → 红；把 `ADMIN_SESSION_SECRET` 从服务必需集移除 → 红；去掉 TOAPIS 的 `alternates` → 红；长度校验分支短路 → 红；`server.ts` 把启动校验**注释掉** → 红；**整行删掉** → 红；`novel-worker` 删掉调用 → 红。第 5 条一开始是绿的（`toContain` 骗得过注释），已改为先剥整行注释再断言。

---

# P2：可维护性

## Task P2.1: `workflow/` 按域拆目录（约 2-3 天）

**287 个文件全部平铺**在 `apps/api/src/workflow/`，69,381 行、12 个互不相干的业务域共享一个扁平命名空间，域隔离仅靠文件名前缀。没有任何机制阻止 `dub` 直接 import `codex-pet` 的内部实现。

- [x] **前置**：**必须等既有计划阶段 1（runner 拆分）完成后再做**，否则两个任务会在同一批 `codex-pet-*` 文件上产生大面积冲突。若阶段 1 尚未开始，本任务可先做**不含 codex-pet 的域**。（阶段 1 已完成，codex-pet 正常纳入）
- [x] **Step 1: 纯移动，零行为变化**。每域一个子目录 + `index.ts` 门面：`workflow/dub/`、`workflow/novel/`、`workflow/image/`… 用 `git mv` 保留 history。
- [x] **Step 2: 一域一提交，跑该域测试**。顺序从耦合最少的开始：`portrait`（2 文件）→ `audio`（2）→ `report`（4）→ `image`（6）→ `video`（8）→ `comic`（9）→ `ecom`（12）→ `novel`（14）→ `dub`（22）→ `article-workflow`（22）→ `codex-pet`（23）→ `local-business-promo`（39）。
- [x] **Step 3: 门面契约**。外部（`server.ts` / `workers/`）只从 `<域>/index.ts` import。这一步产出的边界是后续"禁止跨域 import 内部文件"规则的物理基础。
- [x] **验证**：每域 `pnpm vitest run src/workflow/<域>` + `pnpm typecheck`。
- [x] Commit（多个）`refactor(workflow): <域> 收进独立目录（纯移动）`

### P2.1 执行记录（2026-08-22，16 个提交 `c5cb0d7..b79ca23`）

`workflow/` 根目录已清空，只剩 13 个子目录（12 个业务域 + `_shared/`）：

| 目录 | 文件数 | 门面导出 | 目录 | 文件数 | 门面导出 |
| --- | ---: | ---: | --- | ---: | ---: |
| `_shared/` | 30 | 不设门面 | `novel/` | 24 | 15 |
| `article/` | 39 | 5 | `portrait/` | 8 | 2 |
| `codex-pet/` | 53 + 嵌套 `codex-pet-runner/` 13 | 24 | `report/` | 9 | 1 |
| `comic/` | 16 | 2 | `try-on/` | 5 | 1 |
| `dub/` | 43 | 9 | `video/` | 12 | 2 |
| `ecom/` | 18 | 3 | `image/` | 6 | 2 |
| `local-business-promo/` | 56 | 4 | | | |

**四个计划没写、执行时定下来的判断**：

1. **`_shared/` 的判据是实测消费者，不是文件名前缀。** 进 `_shared/` 的条件是「≥2 个域实际 import 且属于基建」（上游客户端、传输管道、ffmpeg/probe、计价 key、通用路由 helper）。域自己的业务逻辑一律留在域内。按这个判据搬进去 30 个文件，顺带消掉两处 `_shared → 域` 的倒挂依赖。
2. **`audio` 不是独立域。** 计划里把它列成 2 文件的域，但 `audio-service.ts` 导出的全是 `LOCAL_BUSINESS_PROMO_*` 前缀的 BGM/配音能力，且只被 lbp 引用 —— 既不该单独成域也不属于 `_shared/`，直接并入 `local-business-promo/`（该域因此从 52 变 55 个文件）。同理 `try-on` 计划里没列，实际是独立的 4 文件小域，单独建目录。
3. **门面导出必须按依赖从叶子到入口排。** `workflow/novel ↔ src/novel` 本来就有模块环（`novel-routes → src/novel/outbox → 门面`），而 outbox 在模块求值期就要 `NOVEL_TARGET_KINDS.filter(...)`。第一版 `novel/index.ts` 把 routes 排在类型/常量前面，直接炸出 5 个套件 `TypeError: Cannot read properties of undefined (reading 'filter')`。改成叶子优先后恢复。codex-pet / lbp 的门面按同一规则排，注释里写了原因。
4. **`_shared/ecom-route-helpers.ts` 不走 ecom 门面，是有意留的例外。** 它混装了通用路由基建（被 article/image/report 共用）和 ecom 专属入参解析，两边都拆不干净；把门面插进已有的 `ecom-route-types → workflow-pricing → ecom-route-helpers` 环里会重演第 3 条的 TDZ。留到 P2.2 Step 4 拆分后这处倒挂自动消失，注释已写在 `ecom/index.ts`。**（已于 P2.2 Step 4 / commit `75b5597` 拆完：通用部分进 `_shared/route-auth.ts` + `_shared/reference-image.ts`，`ECOM_RESOURCE_KEYS` 进 `_shared/workflow-pricing.ts` 断环，其余进 `ecom/ecom-route-helpers.ts`；`ecom/index.ts` 的例外注释已删。）**

**两类 move 脚本看不见的东西，得手工补**（都在 `.cc-tmp/workflow-split/` 的工具改完之后逐一核对）：

- `import.meta.url` 相对路径。`_shared/gpt-image-edit.poc.test.ts` 读 `.env`（`"../../../../.."`）、`local-business-promo/audio-service.ts` 的 BGM 目录（结尾带 `/`，脚本只改能解析到文件的路径）都随目录下沉一层错位；后者是唯一一次测试变红（29 failed，全是 `ENOENT ... local-business-promo-bgm/*.mp3`）。补完写脚本全量核对了 `apps/api/src` 下所有 `import.meta.url` 相对路径，0 处遗漏。
- `video/` 两个 `.md` skill 资产随 `git mv` 一起搬，`SKILL_PATH` 改回 `./x.md`。

**CI lint 的坑**：`biome ci --changed` **会 lint 被 rename 的文件**，所以移动前就存在的未使用 import 会在移动后变成 CI 报错。这类修复与纯移动无关，单独提了 `3d5e2e4`。另外 biome 的 `--write --unsafe` 会顺手改到不相干文件，作用域必须限定在本次真正动过的目录。

**验证**：每域 `tsc --noEmit` 全部 exit 0；分域测试（passed/failed/skipped）portrait 沿用上轮、`_shared` 99/0/8、report 34/0/0、image 63/0/0、video 41/0/0、comic 20/0/0、ecom 73/0/0、novel（含 `src/novel`）86/0/0、dub（含 `admin/dub-routes`）141/0/0、article 133/0/0、codex-pet（含 `workers/codex-pet-worker.test.ts`）320/0/8 与拆分前基线逐数字一致、local-business-promo + audio-service 57/0/0、try-on 14/0/0。

**文档同步**：只改「活文档」里能解析到现有文件的路径（`docs/image.md` 8 处、`docs/codex-pet.md` 4 处、`docs/pitfalls.md` 1 处）+ `docs/ai-collaboration.md` 5.1 的落位规则。`docs/dub.md` / `docs/novel.md` / `docs/fanout.md` 里的旧路径全在带日期的历史实施计划与审计报告段落内，属于当时的事实记录，不改。

---

## Task P2.2: 收敛重复工具函数（约 1 天，含正确性风险）

**这不只是整洁问题，存在真实的正确性风险。** 已实测确认同名函数**语义漂移**：

| 函数 | 副本数 | 漂移内容 |
|---|---:|---|
| `isRecord` | **7** | 有的 `!Array.isArray()` 有的没有 → **同名函数对数组的判定相反**。读代码的人以为是同一个工具，实际行为按文件不同。 |
| `safeErrorMessage` | **7** | 截断 500 / 300 / 不截断，兜底文案各不同 |
| `trimTrailingSlash` | **6** | 正则 `/\/+$/` vs `/\/+$/u` 混用 |
| `estimateInputTokens` | **6** | **涉及计费口径**，各域估算可能不一致 |
| `fetchWithTimeout` | 3 | 超时/中断语义各自实现 |
| `createPrismaMock` / `createApp` | 各 8 | 测试脚手架 |

- [x] **Step 1: `estimateInputTokens` 单独先做，当正确性 bug 处理**。6 份实现若口径不一致，等于不同域按不同标准扣费。**先逐份 diff 并把差异表格化写进本文件**，再决定统一口径 —— 如果发现某份是"对的"而其他是"错的"，这已经是计费 bug，需单独提 issue 并评估是否影响已产生的账单。**不要顺手统一成任意一份。**
- [x] **Step 2: `isRecord` 逐个调用点核对**。7 份中区分"确实需要排除数组"和"不需要"的调用场景。**不要无脑统一成最严格的版本** —— 那会改变现有行为。做法：统一命名为语义明确的两个函数（`isPlainObject` 排除数组 / `isObjectLike` 不排除），按原行为逐处替换。
- [x] **Step 3: 其余机械收敛**。`safeErrorMessage` 统一签名但**保留各域的兜底文案与截断长度作为参数**（文案是用户可见的，不要统一掉）。`trimTrailingSlash` / `fetchWithTimeout` 可直接统一。
- [x] **Step 4: 落位**。放 `workflow/_shared/`（若 P2.1 已完成）或 `apps/api/src/shared/`。**明确排除 `packages/llm` 相关符号** —— 既有计划阶段 3 会把 `retry` / `routes` 迁进 `packages/llm`，避免撞车。测试脚手架（`createPrismaMock` / `createApp`）放 `test-support/`。
- [x] **验证**：每步 `pnpm typecheck` + 相关域测试。`estimateInputTokens` 那步必须跑所有计费相关测试。
- [x] Commit（多个）`refactor(workflow): 收敛 <函数> 重复实现`

### P2.2 执行记录（2026-08-24，5 个提交 `9754baf..c30ccf2`）

#### 动手前重测：计划表里的数字有一半不准

计划的副本数是 grep 出来的，漏掉跨行调用与私有包装，实测后两项明显缩水：

| 函数 | 计划 | 实测 | 差异原因 |
|---|---:|---|---|
| `estimateInputTokens` | 6 | **7 份，口径完全一致** | 全部是 `长度 / 3` 向上取整，没有漂移 |
| `isRecord` | 7 | **apps/api 7 份**（另有 web 1 / desktop 1） | 计划只数了 apps/api |
| `safeErrorMessage` | 7 | **8 份，其中 2 份是导出的**（30+ 下游调用点） | 导出副本决定了必须保留各域包装 |
| `trimTrailingSlash` | 6 | **7 份** | 漏了 `storage/public-url.ts` |
| `fetchWithTimeout` | 3 | **1 份真在用 + 1 份死代码 + 1 份实现不同** | 「3 份可合 2 份」不成立 |

#### Step 1（`9754baf`）：计费风险被证伪，不需要提 issue

7 份 `estimateInputTokens` 逐字节 diff 后确认除以 3 的口径统一，不存在「某份是对的其他是错的」。因此按计划的风险预案（第 770 行「若确认口径不一致，停下来先报告」）**不触发**，降级为普通去重，落 `workflow/_shared/token-estimate.ts`。

#### Step 2（`43ec2ba`）：拆成两个函数，按原行为逐处替换

新建 `runtime/records.ts` 导出 `isPlainObject`（排除数组）/ `isObjectLike`（不排除），配 4 条测试**钉住「唯一差异就是数组」**，并额外钉住两者都不做原型检查（`new Date()` / `new Error()` 都能通过）—— 防止后人再来一次「统一」。原本排除数组的 3 处（`agent-workflow-plan` / `novel-task-runner` / `novel-billable`）换 `isPlainObject`，原本不排除的 4 处（`fact-extractor` / `image-service` 13 个调用点 / `image-stream` / `video-service`）换 `isObjectLike`。

**`apps/web` 与 `apps/desktop` 的两份故意不动**：为两个 4 行函数拉一个跨包 shared 入口，收益不抵成本。

#### Step 3（`24e862d`）：保留 6 个一行包装，比穿参数到 50 个调用点划算

`_shared/error-message.ts` 的 `errorMessageOrFallback(error, fallback, maxLength = 500)` 是唯一实现，三条口径写进注释：非 Error 一律走兜底（**不再 `String(err)`**）、空白 message 走兜底、截断只作用于 message。各域保留一行包装（`safeErrorMessage(e) => errorMessageOrFallback(e, "视频生成失败")` 之类）——重复的**逻辑**没了，剩下的每域一行是配置而非实现。

三处顺手修掉的真问题：

1. **article 两个文件用错了域的兜底文案**。它们 import 的是 ecom 的 `safeErrorMessage`，非 Error 失败时给用户显示「电商长图处理失败」。已改为直接调 `errorMessageOrFallback` 并传自己的文案。
2. **local-promo 的 `|| "具体文案"` 差点被新口径吃掉**。核心加了「空白 message → 兜底」后，`safeErrorMessage(e) || "口播试听失败"` 会变成死代码，把 3 处用户可见文案静默降级成「操作失败」。改为把具体文案作为 fallback 参数传进去。
3. **删掉两处死代码**：`local-business-promo-audio-helpers.ts` 的 `narrationPreviewErrorMessage`（导出，零调用点）、`image-routes.ts` 的 19 行 `fetchWithTimeout`（零调用点）。

`InsufficientBalanceError` 的分支删除做了双向验证才动手：`packages/billing` 里它的 message 本身就是「余额不足，请充值」，且 portrait/try-on 的测试没有像 `kb/routes.test.ts` 那样用空 message mock 这个类 —— 删除是**输出逐字节等价**的。

`fetchWithTimeout` 最终**只删死代码不合并**：`video-service.ts` 那份（AbortController + 外部 signal 转发）是唯一真用户，`image-service.ts` 那份走 `withImageAttemptDeadline` 且多一个 `onRequestSent`，实现目标不同。`runtime/with-timeout.ts` 是 `Promise.race`、不带 abort，也不能替代。

#### Step 4（`75b5597`）：拆 `_shared/ecom-route-helpers.ts`，还掉 P2.1 的账

这是 P2.1 遗留的例外（本文件第 614 行）。判据定为**「有 ecom 域外的 importer 才留在 `_shared`」**：

- 留 `_shared`：`authUserId` → `route-auth.ts`（report/article/ecom 三域用）；`loadReferenceImage` / `loadOwnedReferenceImages` → `reference-image.ts`（image 域也用，参数改成结构化类型，不再 import ecom 的 `InlineImageInput`）
- `ECOM_RESOURCE_KEYS` 移进 `_shared/workflow-pricing.ts`，**断开真实模块环** `workflow-pricing → ecom-route-helpers → ecom-route-types → workflow-pricing`
- 其余 16 个符号 + 3 个类型整体搬到 `ecom/ecom-route-helpers.ts`，同目录 import，倒挂消失
- 顺手删 3 个零调用点导出（`imageDataUrl` / `serializeWorkflows` / `serializeWorkflow`），`serializeWorkflowWithAssets` 与 `BILLING_OPERATION_APPEND_MAX_ATTEMPTS` 收回文件内不再导出
- `ecom/index.ts` 里那段 P2.1 例外说明删除

**`authUserId` 只搬不合**：`local-business-promo` 域另有一份同名同形的实现，48 个调用点跨 11 个文件，合并是独立改动，注释已写在 `route-auth.ts`，等确认后再动。

#### 补做（`c30ccf2`）：P0.4 记录里挂账到 P2.2 的那处重复

本文件 P0.4 执行记录末尾（「未做（不在范围）」）标了 `loadImageAttemptTimeoutMs` 在 `image-service.ts` 与 `image-routes.ts` 逐字节重复，归属 P2.2。计划的 P2.2 表格里没有这一项，本次一并清掉：两处的 `DEFAULT_ATTEMPT_TIMEOUT_MS` 都是 `600_000`，实现完全一致，删掉 `image-routes.ts` 的副本改为从 `_shared/image-service.js` import 并原名 re-export（`image-routes.test.ts` 三条断言不动）；随之孤立的本地常量一起删。

#### 按约定跳过的部分

**测试脚手架不动**（计划 Step 4 提到的 `test-support/`）：`createPrismaMock` 14 份 / `createApp` 10 份，每个域的 prisma mock 种子形状都不一样，抽公共层等于给每个调用点加一层配置对象，不划算。

**`packages/llm` 相关符号排除**，按计划第 18 行避免与 P3.1 阶段 3 撞车。

同时记录但**明确不在本次范围**：`FetchLike` 在 `_shared/image-service.ts` / `_shared/video-service.ts` / `_shared/vision-client.ts` 定义了三次（后者导出）；`BILLING_BASE_URL` 有约 40 个非测试文件在读，`readBillingClientEnv` 只是其中一个读取方。

#### 验证数字

| 步骤 | typecheck | biome（`--formatter-enabled=false`） | 测试 |
|---|---|---|---|
| Step 2 | exit 0 | 9 files clean | `runtime memory agent-teams workflow/novel workflow/_shared`：42 文件通过 / 2 跳过；**271 passed / 0 failed / 9 skipped** |
| Step 3 | exit 0 | 25 files clean | `runtime storage workflow`：129 文件通过 / 5 跳过；**1102 passed / 0 failed / 16 skipped**（321.81s） |
| Step 4 | exit 0 | 11 files clean | `workflow/{ecom,image,report,article,_shared}`：42 文件通过 / 1 跳过；**443 passed / 0 failed / 8 skipped** |
| 补做 | exit 0 | 1 file clean | `workflow/{image,portrait,article}`：20 文件通过 / 0 跳过；**238 passed / 0 failed / 0 skipped** |

---

## Task P2.3: 前端基础组件层 + 色值收敛（约 2-3 天）

`components/ui/` **只有 2 个文件 198 行**，对着 28,721 行组件 —— **没有基础组件层**，每个 Studio 自己手搓按钮/卡片/输入框。设计 token 建了（`text-brand-ink` / `bg-brand`）但被绕过：`text-[#1d1d1f]` **266 次**、`border-[#d2d2d7]` **150**、`text-[#6e6e73]` **110**、`border-[#e8e8ed]` 78、`text-[#8a8a8f]` 65。

- [x] **Step 1: 先补 token 再动组件**。按 `docs/design-system.md`（192 行，已有规范）把上述高频硬编码色值映射为 token。`DESIGN.md` 明确要求"新增颜色/动效 token 必须先更新规范再进组件"——**遵守这条既有约定**。
- [x] **Step 2: 机械替换色值**。一次一个色值、一个提交，`sed` 后 `pnpm typecheck` + 视觉抽查。266 处那个先做。
- [x] **Step 3: 抽 3-5 个真正高频的基础组件**（Button / Card / Input / Modal 已有 `motion/Modal`）。**不要一次建完整组件库** —— 从实际重复最多的开始，YAGNI。
- [x] **Step 4: 前端大文件拆分不在本任务范围**，见 P2.4（按测试厚度分批,前端需先补测试）。
- [x] **验证**：`pnpm vitest run` + 手动过一遍主要页面（测试薄，必须人眼确认）。
- [x] Commit（多个）`style(web): <色值/组件> 收敛到设计 token`

### P2.3 执行记录（2026-08-25，20 个提交 `e161d99..45a4dd6`，137 文件 +3174/-2790）

范围按用户确认扩大了两处：**以代码现状的颜色为准**（`#0066cc` 品牌蓝），把 `docs/design-system.md` §2 里那套从未落地的愿景色板整段删掉；**顺带修掉从来没做过暗色处理的颜色**（接受暗色下的可见变化）。

#### 分成 5 步做（比上面的勾选项更细的一层拆解），顺序是 `DESIGN.md` 规定的：规范 → token → 组件 → 组件库

| 步 | 内容 | 结果 |
|----|------|------|
| 1 | 文档 §2 重写 + `index.css` 建 `--color-*` + `tailwind.config.js` 暴露 | 50 个 token |
| 2 | 按**角色**逐个替换手写色值，一个角色一个提交 | ink / ink-secondary / ink-tertiary / hairline / surface-subtle / surface-muted 共 232 处 |
| 3 | 补齐**从未做过暗色处理**的 74 个颜色 / 238 处用法 | 新增 `scrim` / `console` / `console-ink` 三个不翻转角色 |
| 4 | 4a `white`→surface 444 处、4b gray/slate→语义 token 611 处、4c 状态色 292 处、4d 压暗层→`scrim`、4e 删 brand `!important` 覆盖块 | 暗色白名单 60 条 + `!important` 块 40 条全删 |
| 5 | 抽 Button / Card / Badge / Alert 四个基元 | `components/ui/` 新增 6 文件 317 行 + 16 条测试 |

#### token 层的形状：暗色只靠翻三元组，一个 `dark:` 都不写

`--color-*` 存 `R G B` 三元组（`:root` 与 `html[data-theme="dark"]` 各一份），Tailwind 侧写成 `"rgb(var(--color-x) / <alpha-value>)"`，于是 `bg-danger/10` 这种带透明度的写法能直接用。`--apple-*` 是派生别名，不需要重复声明暗色。

**收尾数字**：`dark:` 变体 **0** 个；暗色白名单 **0** 条；brand `!important` 覆盖块 **0** 条。

#### 刻意留下的两处例外（不是漏改）

- **11 处装饰性渐变端点色**（`components/video/*` 的会员等级金/银/深灰渐变、`novel/NovelLibraryPage` 的书脊色）—— 它们是插画性质的具体色，不承担语义角色，塞进 token 只会让 token 表变成色号仓库。
- **60 处记忆类型色阶**（全部集中在 `components/memory/memoryStyles.ts`）—— 这是文档 §2 里独立记录的 `Memory Semantic Palette`（CORE / PERMANENT / TEMPORARY / KNOWLEDGE / OTHER），本来就是「集中在一个文件里的第二套语义色板」，符合规范。

#### 三个可访问性判断（都是算完对比度才定的，不是审美）

1. 实底按钮禁用态**不能用透明度**：`bg-brand/50` 上白字只有 **2.2:1**。改成 `bg-hairline` + `ink-tertiary`（灰底灰字 **4.6:1**）。
2. hover **不能换到 `-ink` 档**：`brand-ink` 在暗色下是提亮值 `#5bafff`，白字落上去 **2.3:1**。改用同色 `/90`，两套主题都在 5:1 以上。
3. `Badge variant="solid"` 的 warning / success **不能配白字**（**3.1:1 / 3.4:1**，过不了 AA）。改 `text-scrim`（**5.5:1**）—— 动手前先 grep 确认全站原本 0 处 `bg-warning|success|info` + `text-white`，所以这个决定不改变任何既有观感。

#### Step 4e 删掉 `!important` 块，顺带修好了一个没人报的 bug

那 40 条 `html[data-theme="dark"] .bg-brand { background: … !important }` 压过了 `disabled:` 变体，导致**暗色下禁用的品牌按钮仍然是亮蓝色、看起来可点**。删掉 `!important` 后 `disabled:bg-hairline` 才生效（`disabled:` 是 Tailwind 核心变体里排最后的一个，天然赢过 `hover:` 和裸 utility）。`probe-before.png` / `probe-after.png` 是这处的前后对照。

#### 基元层为什么是「类名工厂 + 薄壳」而不是组件优先

站内大量按钮实际是 `motion/RippleButton`（样式全靠 `className` 传入）。只给 `<Button>` 组件的话这些点接不进来；把动效焊进 `<Button>` 又会让普通按钮被强塞 spring。所以真身是 `buttonClass()` / `cardClass()` / `badgeClass()` / `alertClass()`，组件只是「工厂 + 标签」。

档位取全站实测最高频值：按钮高度 `h-9` 117 处 / `h-10` 91 / `h-8` 74 / `h-11` 34；圆角从 **13 个值**收成 2 档；禁用态从 **4 种写法**收成 1 档；`cardClass()` 的默认输出正是全站 **23 处逐字重复**的那串 className；Alert 覆盖 66 处弱底提示条里的 **11 种** danger 横幅漂移。

#### 一个真会咬人的坑：className 顺序不决定胜负

同属性的第二个 utility 谁生效，取决于两条规则在**构建产物**里的先后，而那个顺序是 Tailwind 自己排的。实测两例：`.flex-1` 排在 `.flex-none` 之前 —— 所以 `Button` 的 `BASE` **刻意不设 `flex-none`**，否则弹窗底部 `flex-1` 平分宽度的按钮行永远赢不了（已加回归测试）；`disabled:` 排在所有核心变体之后 —— 这正是上面那个 bug 的解释。因此 `ui/cx.ts` 故意不做 tailwind-merge 式冲突消解，约定是「能用参数表达的就用参数，`className` 只加工厂没碰过的属性」。

早期尺寸档太粗（`px-6 py-2.5` 的 CTA、`p-6` 的面板、`text-[10px]` 的 chip 都得靠 className 覆盖，正好踩这个坑），改法是**加档**而不是允许覆盖：Button `xl: h-11 px-6`、Card `xl: p-6`、Badge `xs: px-2 py-0.5 text-[10px]`。

#### 把规范写成可执行断言，而不是写成文档里的一句话

`ui.test.tsx` 16 条测试遍历所有 variant × size 组合，断言：零字面色值 / 零调色板色阶、`X/10` 弱底必配 `X-ink` 文字、实底档不拿 `X-ink` 当底色、每个按钮只产出一种圆角、实底档禁用态换灰底灰字、`BASE` 不含 `flex` 系、`cardClass()` 默认输出等于那 23 处的原串、`<Button>` 默认 `type=button`、`<Alert tone="danger">` 用 `role=alert` 其余 `role=status`。

#### 人眼确认这一关做了防作弊

测试薄的地方靠目视，但**「没样式」在截图里和「样式对」长得一样**（Tailwind JIT 不生成没出现在 `content` 里的类）。所以三道独立校验：① 预览页手抄的 class 串与工厂输出逐字比对（临时 vitest 文件，跑完即删）；② 预览页每个 class 都存在于**真实构建产物** `app.css`（90/0、95/0 缺失）；③ `src` 全量 token 类的产物覆盖（163 类 / 0 缺失）。之后才用 headless Chrome 按 `--force-device-scale-factor=2` 出浅色 + 暗色两套截图逐档看。

#### 转换点刻意收窄

只转了 3 个可读性好的调用点（`ConfirmDialog` / `ModelMarketplace` / `billing/RechargeTab`）来验证工厂够用。`components/novel/*` 那种一行超长 JSX 的文件、以及真正的特殊处理（segmented control、虚线空态、品牌浅色渐变价格块）保持显式手写 —— **工厂只覆盖默认情形**，特殊处理留在原地比塞进参数表更好维护。

#### 顺带修掉 `design-system.md` 三处与代码相反的描述

| 位置 | 文档原话 | 代码实际 |
|------|---------|---------|
| §4 | 面板圆角只用 `8 / 10 / 14px` 三档 | `.apple-shell` **改写**了圆角类：`rounded-xl`→11px、`rounded-2xl`/`3xl`→18px |
| §3 | 字体栈以 `Inter` 起头 | 仓库里没有 Inter、没有 `@font-face`，实际是 `SF Pro Text` 起头的纯系统栈 |
| §7 | 两个 shadow token 用于详情面板/悬浮 | `.apple-shell [class*="shadow-"]{box-shadow:none!important}` 已让它们在壳内彻底失效，是死样式 |

#### 验证数字

- `pnpm build` ✓ 2.70s；`tsc --noEmit` ✓；`biome ci src --formatter-enabled=false` ✓ 286 文件
- `vitest run`（`apps/web`，已 `source .env`）= **86 文件 / 464 passed / 0 failed / 0 skipped**
- 浅色 + 暗色两套基元总览截图 + 全站色板前后截图 + `!important` 块删除前后对照，已交付人眼确认

#### 未纳入本次范围

- `components/novel/*` 等密集单行 JSX 文件的基元转换 —— 等 P2.4 前端批次先补测试。
- Input / Modal 基元：`index.css` base 层已统一输入控件（`rounded-[10px]` + token 色），`motion/Modal` 已存在，按 YAGNI 不重复造。


---

## Task P2.4: 大文件拆分（约 6-9 天，分两批）

全仓 **19 个文件超 800 行,合计 27,241 行**。这些文件同时是**变更磁铁** —— churn 最高的文件与最大的文件几乎完全重合(`api.ts` 12 改/1775 行、`Workflow.tsx` 11/815、`image-service.ts` 11/1082、`CodexPetStudio.tsx` 10/1941、`codex-pet-routes.ts` 10/2930)。每次需求都得挤进同一个巨型文件。

### 拆分安全性的唯一判据:该文件自己的测试厚度

已实测每个大文件对应的测试比,结论是**后端与前端处在两个完全不同的处境**:

| 文件 | 行数 | 测试文件 | 测试行 | 比 | 判定 |
|---|---:|---:|---:|---:|---|
| `workflow/image-routes.ts` | 1307 | 1 | 2028 | **1.55** | ✅ 可直接拆 |
| `workflow/codex-pet-visual.ts` | 1133 | 1 | 1176 | **1.04** | ✅ 可直接拆 |
| `workflow/image-service.ts` | 1082 | 1 | 1064 | **0.98** | ✅ 可直接拆 |
| `workflow/codex-pet-runner.ts` | 5678 | 3 | 5484 | **0.97** | ✅ P3.1 阶段 1 已拆完（→ 1561 行 + 13 个模块） |
| `workflow/codex-pet-routes.ts` | 2930 | 2 | 4548 | **1.55** | ✅ 可直接拆 |
| `workers/codex-pet-worker.ts` | 1157 | 1 | 967 | **0.84** | ✅ 可直接拆 |
| `workflow/video-routes.ts` | 893 | 1 | 640 | **0.72** | ✅ 可直接拆 |
| `workflow/codex-pet-packaging.ts` | 850 | 1 | 604 | **0.71** | ✅ 可直接拆 |
| `chat/routes.ts` | 816 | 1 | 555 | **0.68** | ✅ 可直接拆 |
| `codex-pet-pipeline/extraction.ts` | 1276 | 1 | 800 | **0.63** | ✅ 可直接拆 |
| `workflow/novel-task-runner.ts` | 937 | 1 | 553 | **0.59** | ✅ 可直接拆 |
| `novel/resource-routes.ts` | 894 | 1 | 305 | 0.34 | ⚠️ 先补测试 |
| **`web/components/workflow/CodexPetStudio.tsx`** | **1941** | 1 | 616 | **0.32** | ⚠️ 先补测试 |
| **`web/api.ts`** | **1775** | 1 | 289 | **0.16** | ⚠️ 先补测试 |
| `web/components/workflow/useArticleWorkflowStudio.ts` | 840 | 0 | 0 | **0** | ❌ 必须先补 |
| **`web/pages/Chat.tsx`** | **1077** | 0 | 0 | **0** | ❌ 必须先补 |
| **`web/pages/Workflow.tsx`** | **815** | 0 | 0 | **0** | ❌ 必须先补 |
| `web/App.tsx` | 749 | 0 | 0 | **0** | ❌ 必须先补 |

**`apps/web/src/pages/` 整个目录零测试文件。** 这不是"测试比低",是完全没有。

**因此拆分顺序不是按文件大小排,是按测试厚度排。** 后端 11 个文件测试比 0.59–1.55,拆分是安全的机械操作;前端 5 个文件测试比 0–0.32,先拆等于蒙眼手术。

### 批次一:后端(测试已就绪,纯移动,约 3-4 天)

- [x] **通用纪律:纯移动,零行为变化**。每个文件拆完保留原文件名作**门面**,只 re-export,外部 import **一行都不改**。这是既有计划阶段 1 已验证的手法(它明确列出 6 个源文件 + 5 个测试文件作为"一行不改"的成功判据)。测试文件也不改 —— 如果拆分需要改测试,说明不是纯移动,停下重新设计。
  - **达成证明(2026-08-29)**:批次一 9 个提交(`f2eb2c5` / `bfb3696` / `ecde051` / `a1b7033` / `6649ce1` / `2822bb9` / `35365b5` / `2abcd62` / `643b758`)的 `--name-status` 里,状态为 `M` 的既有文件**恰好只有被拆的那 9 个源文件本身 + 本计划文档**,`.test.ts` / `.tsx` 一个都没有。所以"测试文件与外部 import 零行改动"不是自述,是提交历史可复算的。
  - **门面与非门面各一半,判据是 800 行而非"必须门面"**:`codex-pet-routes.ts` / `codex-pet-visual.ts` / `novel-task-runner.ts` / `codex-pet-packaging.ts` 做成了纯门面;`image-routes.ts`(553)、`video-routes.ts`(455)、`chat/routes.ts`(628)、`codex-pet-worker.ts`(467)、`extraction.ts`(605)保留成"编排 + 身份",因为它们导出的就是 fastify 插件本体 / 进程入口 / 模块的五个公开入口,再套一层门面只会多一层 ctx 间接。
- [x] **Step 1: `codex-pet-routes.ts`(2930 → 5 个文件)**。接缝已勘定(18 条路由的行号已核实):
  - `codex-pet-catalog-routes.ts` — pricing/models/list(:1205-1246,约 40 行)
  - `codex-pet-project-routes.ts` — 项目 CRUD(:1247-1602,约 355 行)
  - `codex-pet-run-routes.ts` — 运行生命周期 start/continue-failed/resume-gate-failure/base-selection/cancel/approve-next-image(:1603-2674,**约 1070 行,最肥的一块**)
  - `codex-pet-event-routes.ts` — events + SSE stream(:2675-2796,约 120 行)
  - `codex-pet-delivery-routes.ts` — install-link/download/公开产物(:2797-2930,约 130 行)
  - 原文件保留为门面,注册顺序不变。**注意 `/api/public/codex-pets/artifacts/:artifactId`(:2863)是公开路由,不走鉴权**,拆走时别把它塞进带 `preHandler` 的分组。
  - **执行结果(2026-08-29)**:`codex-pet-routes.ts` **2961 → 39 行门面**(实际行数比计划记的 2930 又长了 31 行),同目录新增 9 个兄弟文件,最大 638 行 —— 拆分**没有制造任何新的 800+ 行文件**:
    - `codex-pet-route-types.ts`(191,原 :176-362)、`codex-pet-route-helpers.ts`(638,原 :53-174 + :364-846)、`codex-pet-route-context.ts`(446,原 :849-1245 包进 `createCodexPetRouteContext(app, deps)`)
    - `codex-pet-catalog-routes.ts`(38)、`codex-pet-project-routes.ts`(408)、`codex-pet-run-routes.ts`(600)、`codex-pet-run-review-routes.ts`(560)、`codex-pet-event-routes.ts`(108)、`codex-pet-delivery-routes.ts`(191)
  - **有意偏离计划:路由文件是 6 个而不是 5 个**。计划里的单一 run 分组自己就是"约 1070 行,最肥的一块",整块搬过去等于新造一个 800+ 行文件,直接和本任务的完成判据矛盾。因此按语义切成两半:`codex-pet-run-routes.ts`(start / continue-failed / resume-gate-failure)与 `codex-pet-run-review-routes.ts`(base-selection / cancel / approve-next-image),并**按这个顺序注册**,路由注册顺序与拆分前完全一致。
  - **公开路由的处置**:`/api/public/codex-pets/artifacts/:artifactId` 放进 delivery 分组,与另外两条带鉴权的路由同文件。这里的 `preHandler` 是**逐路由**声明的、不是分组级的,所以同文件不会给它加上鉴权 —— 它仍然没有 `preHandler`。
  - **共享上下文的类型**用 `export type CodexPetRouteContext = ReturnType<typeof createCodexPetRouteContext>` 推导,不手写签名(那些闭包返回 Prisma 行类型,手写一份必然分叉)。各分组文件在顶部解构 `ctx`,搬过去的函数体因此**逐字不变**。
  - **逐字性怎么证的**:用 `sed` 机械切行段,再和 `git show HEAD:` 的同一行段 `diff`,不重打任何一行。9/9 段落逐字内嵌;types/helpers 两段与原文的差异**只有新加的 `export ` 关键字**;其余 7 段 diff 全空。
  - **验证**:`pnpm typecheck` 干净;`npx tsc --noEmit --noUnusedLocals` 在新文件里**零个未使用 import**(唯一命中是搬过来的 pricing 路由里本来就有的 `catalog-routes.ts(11,11) TS6133 'userId'` 死代码,原样保留);测试 **27 files passed / 4 skipped(31),336 passed / 0 failed / 8 skipped(344)**,与拆分前基线逐数字一致。**测试文件与全部外部 import 零行改动**。
- [x] **Step 2: `image-routes.ts`(1307)+ `image-service.ts`(1082)**。这两个测试最厚(1.55 / 0.98)且 churn 最高(11 改),收益最大。注意与 P0.4 的关系:~~**P0.4 已把 `reconcilePendingImageBilling` / `resumeStaleTasks` 导出**~~ → **实际没导出**,P0.4 给 reaper 传的是闭包(它们依赖插件闭包里的 `scheduleTask`/`fetchFn`)。拆分时要把这两个依赖也一并带走,才能把它们移进 `image-reaper.ts` 或 `image-billing.ts`;这比计划原本设想的工作量大。共享的常量与行类型已在 `image-shared.ts`,可直接复用。
  - **执行结果(2026-08-29)**:实际行数比计划记的更长(`image-routes.ts` **1289**、`image-service.ts` **1090**),两边各拆一族,共新增 10 个文件,**最大 553 行,没有制造任何新的 800+ 行文件**:
    - 路由族:`image-route-types.ts`(62,原 :107-155)、`image-route-helpers.ts`(381,原 :53-105 + :157-175 + :181-453)、`image-billing.ts`(165,原 :455-600)、`image-task-runner.ts`(244,原 :602-814)、`image-routes.ts`(**1289 → 553**,原 :816-1289 + :177-179)
    - 上游服务族:`image-service-constants.ts`(41,原 :13-44)、`image-service-types.ts`(135,原 :46-101 + :142-208)、`image-service-upstream.ts`(395,原 :103-141 + :278-287 + :304-580 + :812-854)、`image-service-providers.ts`(276,原 :232-277 + :288-302 + :581-680 + :731-810)、`image-service-storage.ts`(136,原 :210-231 + :681-730 + :1045-1090)、`image-service-calls.ts`(227,原 :856-1043)、`image-service.ts`(**1090 → 71** 纯门面)
  - **有意偏离计划:`image-routes.ts` 不做成纯 re-export 门面**,它仍是那个 fastify 插件(553 行,已在 800 判据以下)。9 条路由要再切分组就得为插件闭包造一层 ctx 间接,行数并不会更少,只会多一层。它的导出面仍是**恰好 3 个名字**(`imageWorkflowRoutes` / `loadImageAttemptTimeoutMs` / `loadImageMaxAttempts`),所以 `image-routes.test.ts` 与 `index.ts` 一行不改。
  - **P0.4 那两个闭包比预想的好搬**:`reconcilePendingImageBilling` / `resumeStaleTasks` 原地就是"读闭包变量"的形状,改成入参对象后干净落到 `image-billing.ts` / `image-task-runner.ts`,**`image-reaper.ts` 完全没动**。计划里"工作量比设想大"的判断在这里不成立。
  - **门面不许放大契约**:`image-service.ts` 转出的名字与拆分前逐字一致,仍是 43 个(约 40 个模块 import 它);`FetchLike` 拆分前是文件内私有别名,现在虽然为跨文件复用从 `image-service-types.ts` 导出,门面**刻意不转出它**。
  - **依赖方向定成 DAG**:`constants`(叶,谁也不 import)→ `types` → `upstream` / `providers` → `storage` → `calls` → 门面。错误类与分类**必须同文件**:`ImageGenerationUpstreamError` 构造函数里调 `sanitizeImageUpstreamRequestId` + `classifyUpstreamFailure`,而 `classifyImageGenerationError` 对这些类做 `instanceof`,拆开就是环。同理 `activeGenerationTasks` 这个模块级 Map 只能有一份(在 helpers 里),task-runner 登记、插件的取消路由 abort,造第二份就会静默弄坏取消。
  - **逐字性怎么证的**:同 Step 1 —— `sed` 机械切行段,与 `git show HEAD:` 的同一行段 `diff`,不重打任何一行。行数账也对得上:路由 1230 行搬运 + 52 行 import/空行 + 7 个分隔 = 1289;上游服务 1071 行搬运 + 19 行(12 import + 7 空行)= 1090。
  - **验证**:`pnpm typecheck` 干净;`npx tsc --noEmit --noUnusedLocals` 在 12 个文件里**零个未使用 import**(唯一命中是 pricing 路由里原本就有的 `image-routes.ts(247,11) TS6133 'userId'`,与原文 :983 逐字相同,原样保留);image 域测试 **99 passed / 0 failed / 0 skipped**(3 文件);全量 apps/api **1896 passed / 12 failed / 17 skipped(1925)**,失败的 12 个正是已知的本地环境集(admin/resource 7、admin/membership 3、admin/code 1、agents 1),无一与 image 相关。**测试文件与全部外部 import 零行改动**。
- [x] **Step 3: `codex-pet-worker.ts`(1157)、`codex-pet-visual.ts`(1133)、`extraction.ts`(1276)、`novel-task-runner.ts`(937)、`video-routes.ts`(893)、`codex-pet-packaging.ts`(850)、`chat/routes.ts`(816)**。一文件一提交,每次跑该域测试。
  - **执行结果(2026-08-29)**:7 个文件 7 次提交,**实际行数普遍比计划记的更长**(计划总计 7062,实测 7319)。七个原文件合计 **7319 → 2263**,新增 33 个兄弟文件(最大 424 行),保留下来的原文件最大 628 行 —— **没有制造任何新的 800+ 行文件**:
    - `codex-pet-worker.ts` **1158 → 467**(`ecde051`),+4:`-billing.ts`(287)、`-metrics.ts`(284)、`-recovery.ts`(239)、`-support.ts`(21)
    - `codex-pet-visual.ts` **1156 → 59 纯门面**(`a1b7033`),+6:`-image.ts`(295)、`-seedream.ts`(253)、`-client.ts`(229)、`-direction.ts`(212)、`-qa.ts`(198)、`-types.ts`(116)
    - `extraction.ts` **1398 → 605**(`6649ce1`),+4:`extraction-alpha.ts`(424)、`-components.ts`(228)、`-types.ts`(227)、`-findings.ts`(100)
    - `novel-task-runner.ts` **935 → 22 纯门面**(`2822bb9`),+5:`novel-task-run.ts`(339)、`-persist.ts`(284)、`-context.ts`(233)、`-read.ts`(121)、`-shared.ts`(74)
    - `video-routes.ts` **992 → 455**(`35365b5`),+5:`video-route-task.ts`(275)、`-serialize.ts`(183)、`-schemas.ts`(118)、`-contracts.ts`(74)、`-support.ts`(47)
    - `codex-pet-packaging.ts` **863 → 27 纯门面**(`2abcd62`),+4:`-run.ts`(314)、`-artifacts.ts`(261)、`-job.ts`(257)、`-shared.ts`(176)
    - `chat/routes.ts` **817 → 628**(`643b758`),+5:`routes-tool-summary.ts`(128)、`routes-errors.ts`(71)、`routes-model-gate.ts`(62)、`routes-runtime.ts`(36)、`routes-schemas.ts`(35)
  - **三个文件做成纯门面,四个没有**。判据是 800 行而不是"必须门面":`codex-pet-visual.ts` / `novel-task-runner.ts` / `codex-pet-packaging.ts` 的导出面可以整体转出(分别 5 / 3 / 7 个名字),做成门面无代价;`codex-pet-worker.ts`(进程入口)、`video-routes.ts` / `chat/routes.ts`(导出的就是 fastify 插件本身,闭包持有注入的 prisma/redis/client/billing)、`extraction.ts`(五个公开入口就是模块的身份)保留原职责,拆完 455-628 行**已在 800 判据以下**,再拆只会多一层 ctx 间接 —— 与 Step 2 的 `image-routes.ts` 同一处理。
  - **逐字性怎么证的**:比 Step 1/2 又收紧一步。`git show HEAD:` 快照 → python 分区预检(未覆盖的非空行必须**恰好**是 import 块)→ `sed` 机械切段 → 在副本上跑 `sed -E` 加 `export ` 再 `diff` 证明"唯一文本变更就是行首多了 export" → 组装后 python 逐 chunk 比对(按实测 header 偏移切片,跨分隔空行)。`extraction.ts` 8 个 chunk 全过、`chat/routes.ts` 21 个 chunk 全过,7 个文件**零处不一致**。每个文件另做导出面前后对比(`少了: 无 多了: 无`)。
  - **`extraction.ts` 是唯一没有自己测试文件的**(覆盖它的是 `pipeline.test.ts` 与 apps/api 的 `codex-pet-visual.test.ts`,都是黑盒),所以它完全靠字节级证明,这一点已写进文件头要求后续沿用。
  - **一处有意的再归位打破了环**:`looksLikeNeighbourBleed` 同时被 `analyzeAlpha`(擦除决策)和 `classifyFrameFindings`(评级)调用,按域分文件会让 alpha ↔ findings 互相依赖。它只用到 `ForegroundComponentDiagnostics` + `FRAME_TOLERANCE`,于是下沉到更底层的 components 层,两个调用点共用同一份。复制成两份的后果很具体:slot 里按 A 判据擦掉的 sliver,到整张 atlas 上按 B 判据又成硬错误。
  - **进程级单例状态只能有一份**(同 Step 2 的 `activeGenerationTasks`):`chat/routes.ts` 的 `enabledCache` 必须和它唯一的三个访问点同文件,否则 `routes.test.ts` 注入的启用集会写到另一个副本上,表现是"注入了启用集、请求却照样放行"。同理 `CodexPetPackagingDeferredError` 只允许一份定义(唯一 throw 在 `markJobDeferred`,唯一 `instanceof` 在 `codex-pet-runner.ts`),出现第二份会让可重试的打包延后被当成硬失败终结整个 run。
  - **验证**:每个文件 `pnpm typecheck` 11/11 + `tsc --noUnusedLocals` 在新文件零告警 + 该域测试。worker 41 passed / 0 failed / 0 skipped;visual 70 / 0 / 8;video 41 / 0 / 0;novel 38 / 0 / 0 与 49 / 0 / 0;codex-pet 域 309 / 0 / 8;chat 27 / 0 / 0;codex-pet-pipeline 54 / 0 / 0。**测试文件与全部外部 import 零行改动。**
  - **完成判据的进度**:非测试源文件 800+ 行从基线 **19 降到 11**。剩下的 11 个里 5 个属于批次二前端(`CodexPetStudio.tsx` 1991、`api.ts` 1509、`Chat.tsx` 1077、`useArticleWorkflowStudio.ts` 959、`Workflow.tsx` 829)、2 个归 P3.1(`codex-pet-runner.ts` 1454、阶段 1 拆出来的 `runner-board-job.ts` 1049)、4 个本就不在批次一名单(`themes.ts` 1261 是数据表、`try-on-routes.ts` 1013、`resource-routes.ts` 847 判定为"先补测试"、`portrait-routes.ts` 815)。
- [x] **Step 4: 与 P3.1 阶段 1 的冲突规避**。`codex-pet-runner.ts` 由既有计划处理,本任务**不碰**。但 `codex-pet-routes.ts` / `codex-pet-worker.ts` / `codex-pet-packaging.ts` / `codex-pet-visual.ts` 在阶段 1 的**门面兼容契约**里被列为"一行都不改"的文件 —— 意味着**本 Step 与阶段 1 不能并行**。二选一:先做本任务再做阶段 1(阶段 1 的契约需相应更新),或先阶段 1 再本任务(**推荐,阶段 1 的 37 步已写好**)。
  - **执行结果(2026-08-29)**:走的是推荐路径 —— 阶段 1 于 2026-08-22 完成,批次一 Step 1/3 在 2026-08-29 才动那些文件,**并行冲突从未发生**,本 Step 落成核对 + 更新契约记录,零代码改动。
  - **本 Step 原文有一处事实错误**:`codex-pet-routes.ts` 与 `codex-pet-visual.ts` **不在**阶段 1 的门面兼容契约里。契约列的恰好 6 个是 `codex-pet-worker.ts` / `codex-pet-packaging.ts` / `codex-pet-failed-continuation.ts` / `codex-pet-generated-board-recovery.ts` / `codex-pet-recovery-finalizer.ts` / `server.ts`。所以真实重叠只有 worker 与 packaging 两个,冲突面比本 Step 当初担心的窄一半。
  - **契约里 6 个源文件其实只有 4 个 import 过门面**(`2edef68^` 实测):worker、packaging、generated-board-recovery、recovery-finalizer。`failed-continuation.ts` 与 `server.ts` 从未直接 import,是保守的过度覆盖 —— 这解释了阶段 1 执行记录写"4 个外部源文件 + 6 个外部测试文件"与契约原文"6 个源文件 + 5 个测试文件"的不一致,不是漏改。
  - **批次一没有破坏契约的目的**:worker 与 packaging 被拆后,对门面的依赖只是换了文件 —— `codex-pet-packaging-artifacts.ts` / `-run.ts` / `-shared.ts` 直接 import 门面,worker 侧四个文件经 P2.1 建的 `workflow/codex-pet/index.js` 域门面间接 import。门面要求的 **11 个值 + 6 个类型今天全部仍在导出面上**(`codex-pet-runner.ts:163-197`),且已是超集(后续功能又加 12 个名字);唯一换老家的 `CODEX_PET_BOARD_PROMPT_VERSION` 现由 `codex-pet-board-version.js` 转出,门面出口不变。
  - **阶段 1 的三条硬约束逐条复验通过**:四个信号异常类仍只在 `runner-types.ts:68/215/222/232` 各一个 `class` 定义点;`emit` 的隐藏写路径完整(`runner-lease.ts:15-47`,`$transaction` 内 `SELECT … FOR UPDATE` + lease CAS + run/project 双置 `repairing`);`MIRROR_NOT_SAFE` 抛在 `runner-standard-rows.ts:126`、匹配在 `codex-pet-runner.ts:425`。
  - **顺带查出一件归 P3.1 的事**:`7c98eb2`(2026-08-26「四份 look 修复循环合一为 `repairLook{A,B}Row`」)是阶段 2 第一项的内容,**已落地但阶段 2 仍未勾选**。开阶段 2 前必须先核对实际剩余范围,已写进既有计划的契约小节。
  - 落档写进 `docs/superpowers/plans/2026-07-27-legacy-workflow-optimization.md` 契约段之后的「契约的后续状态」小节。
- [x] **验证**:每步 `pnpm typecheck` + 该域测试。阶段收尾跑全量,对照 P0.1 记录的基线三元组。
  - **批次一收尾全量(2026-08-29,`set -a && . ./.env && set +a` 后 `pnpm test`,6m25s)**:`failed 12` 与 `skipped 22` **与 P0.1 基线逐一相同,一例不多一例不少** —— 这正是"纯移动不应改变任何测试结果"要的那个等号。

    | workspace | 基线 p/f/s (2026-08-03) | 本次 p/f/s (2026-08-29) |
    |---|---|---|
    | `@ai-assistant/api` | 1642 / **12** / 17 | 1896 / **12** / 17 |
    | `@ai-assistant/web` | 416 / 0 / 0 | 464 / 0 / 0 |
    | `@ai-assistant/desktop` | 123 / 0 / 0 | 123 / 0 / 0 |
    | `@ai-assistant/codex-pet-pipeline` | 48 / 0 / 0 | 54 / 0 / 0 |
    | `@ai-assistant/billing` | 31 / 0 / 0 | 40 / 0 / 0 |
    | `@ai-assistant/admin` | 17 / 0 / 0 | 17 / 0 / 0 |
    | `@ai-assistant/article-workflow` | 13 / 0 / 0 | 27 / 0 / 0 |
    | `@ai-assistant/novel-workflow` | 13 / 0 / 0 | 13 / 0 / 0 |
    | `@ai-assistant/connector-protocol` | 13 / 0 / 0 | 13 / 0 / 0 |
    | `@ai-assistant/llm` | 12 / 0 / 5 | 49 / 0 / 5 |
    | **合计** | **2328 / 12 / 22** | **2696 / 12 / 22** |

  - **passed 从 2328 涨到 2696 不是拆分带来的**,是这一个月功能与测试增量;拆分本身贡献 0 个新用例(批次一没写过一行测试)。
  - **12 个 failed 的文件与例数也逐一对齐基线**:`admin/resource-routes` 7、`admin/membership-routes` 3、`admin/code-routes` 1、`agents/routes` 1。全部是「billing 可达 → 200 而非 502」「S3 已配置」这类把环境当断言前提的既有缺陷,按既定结论**不在本任务修**。
  - **22 个 skipped 同样对齐**:api 17(`.poc.` 16 + runner 集成的文件内单例 1)+ llm 5。

### 批次二:前端(必须先补测试,约 3-5 天)

**这批的顺序是"补测试 → 再拆",不能反。** 前端整体测试比 0.25,`pages/` 目录为 0,没有回归网。

> **勘误(2026-08-29)**:"`pages/` 目录为 0"是基线的测量错误。开工时 `pages/` 已有 6 个测试文件(`AgentTeams` / `Chat` / `Knowledge.codex-pet` / `ModelMarketplace` / `ToolMarket` / `Workflow.image-hub`),只是**没有一个覆盖 Chat.tsx / Workflow.tsx 的编排层**——`Chat.test.tsx` 只管消息面板自动滚动,`Workflow.image-hub.test.tsx` 只管真实 studio 下的生图文案。所以"没有回归网"这个结论仍然成立,补测试照做。

- [x] **Step 1: 先给 `pages/Chat.tsx`(1077)与 `pages/Workflow.tsx`(829,计划里记的 815 已过期)补最小行为测试**。不追求覆盖率,只要覆盖"主要交互路径不炸":渲染、切换、提交、错误态。参照 `components/workflow/` 下已有的测试写法(该目录有 79 个文件、测试比虽低但有可抄的形状,如 `ArticleWorkflowStudio.test.tsx`)。
  - **执行结果(2026-08-29)**:两个新文件共 **68 passed / 0 failed / 0 skipped**——`Chat.behavior.test.tsx` 29 例、`Workflow.behavior.test.tsx` 39 例。四类路径逐一落地:渲染(空态 / 消息列表 / 标题回落)、切换(模型 / 知识库 / 工具 / 生图子 tab)、提交(按钮 / Enter vs Shift+Enter / trim / isLoading 期间不重发)、错误态(error 横幅 / 工具加载失败 / 402 → `积分不足，请充值`)。
  - **断言刻意只落在两端:用户看得见的文案,和回调收到的载荷。** 不碰内部 state 形状——抽子组件必然重排 state 归属,但 `onSend` 的六个字段、`onModelChange` 的模型 id、往 studio 传下去的每个 prop 必须逐字不变。这才是拆分时真正会踩的那根线。
  - **两个 Workflow 测试文件是互补的,不是重复**:`Workflow.image-hub.test.tsx` 保留真实 studio + stub `fetch`,断言 studio 内部渲染;新的 `Workflow.behavior.test.tsx` 把 11 个 studio 全换成探针,断言 **Workflow.tsx 自己算出来往下传的那份 props**。拆分允许改的是前者的那一侧,所以护栏必须钉在后者。
  - **踩到的两个坑记下来**:①`vitest.config.ts` 的 `environment` 是 `node`,页面测试必须自带 `// @vitest-environment jsdom` 顶注,否则连 `document` 都没有;②受控 `<textarea>` 要用 `HTMLTextAreaElement.prototype` 上的原生 value setter + `dispatchEvent(new Event("input"))` 才能让 React 19 收到 onChange,直接赋值不触发。`@iconify/react` 已在 `src/test/setup.ts` 全局 mock,新测试不用再 mock。
- [ ] **Step 2: `api.ts`(1775 行、183 个导出、churn 全仓第一)按域拆**。接缝已勘定:**Novel 独占 36 个函数**(最大单一聚类)、Kb 11、Memory 5、Wechat 3、Agent 3、Tool 2、Session 2、Recharge 2。
  - 抽 `novelApi.ts`(36 个)—— 单独一步,收益最大。注意 `api.ts:2` 已 import `@ai-assistant/novel-workflow/contracts`,类型契约跟着走。
  - 抽 `kbApi.ts`(11)、`memoryApi.ts`(5)。
  - 剩余的 auth/chat/balance 等留在 `api.ts`。
  - **与 P1.2 的顺序**:P1.2(统一 HTTP 客户端)把 `api.ts` 的 75 处裸 fetch 迁到 `http.ts`,**先做 P1.2 再拆**,否则拆完要在多个新文件里重复迁移。
  - **`streamChat` 等流式函数不动**(P1.2 Step 4 已说明流式不走通用封装)。
- [ ] **Step 3: `CodexPetStudio.tsx`(1941 行)**。测试比 0.32(616 行测试),是前端大文件里唯一有基础的。先补测试到 0.5 以上再拆。拆法:按面板/阶段抽子组件,状态提升到已有的 `useCodexPetStudio` 类 hook(参照 `useArticleWorkflowStudio.ts` / `useLocalBusinessPromoWorkflowStudio.ts` 的既有模式 —— **这个模式项目里已经有了,照抄**)。
- [ ] **Step 4: `useArticleWorkflowStudio.ts`(840,零测试)与 `App.tsx`(749,零测试,25 个 `useState`)**。`App.tsx` 的拆分与"是否引入 router"强耦合 —— 当前用 `ViewType` 字符串手工切页。**本计划已声明不引入 react-router**,所以这里只做机械抽取(把 25 个 `useState` 按关注点分组进自定义 hook),不改路由机制。路由决策留作独立议题。
- [ ] **验证**:`cd apps/web && pnpm vitest run`。**测试薄,每步必须人眼过一遍对应页面。**

### 完成判据(可量化)

- [ ] 800+ 行文件数从 **19 → ≤8**(`codex-pet-runner.ts` 由 P3.1 处理后应再降)
- [ ] 800+ 行文件合计行数从 **27,241** 显著下降
- [ ] `apps/web/src/pages/` 测试文件数从 **0 → ≥2**
- [ ] 全量测试的 passed/skipped 与 P0.1 基线一致(纯移动不应改变任何测试结果)

### 为什么不做得更激进

- **不追求"每个文件 <300 行"**。目标是让变更磁铁不再是单点,不是均匀切碎。切太细会把"读一个函数要跳 5 个文件"变成新的维护成本。
- **不在拆分提交里做任何行为改动**。发现 bug → 记下来单独提。混在纯移动里会让 review 无法判断"这行为变化是故意的吗"。
- **不拆 `services/billing`(Go)**。`admin.go`(931)/`api.go`(909)虽超 800 行,但该模块整体质量最高(测试比 0.81)、churn 低,不是变更磁铁。**按判据它不该进这批。**

---

# P3：交回既有计划

## Task P3.1: 执行 `2026-07-27-legacy-workflow-optimization.md` 阶段 1-3

- [x] 阶段 1：`codex-pet-runner.ts` 纯移动拆分（5678 行 / 110 函数 / 439 await / 嵌套 9 层 → 13 个文件）。37 步已写好，含**门面兼容契约**（6 个源文件 + 5 个测试文件一行不改）。**2026-08-22 完成**：5815 → 1561 行 + 13 个模块，136 个符号逐字节核对为纯移动，codex-pet 全量 320 passed / 0 failed / 8 skipped 与基线一致。
- [ ] 阶段 2：`executeRun` 去重（三份 look 修复循环、lease CAS 样板）。14 步。**唯一可能改变行为的阶段。**
- [ ] 阶段 3：加厚 `packages/llm`（`routes.ts` 严格路由解析 + `retry.ts` 通用重试，TDD）。14 步。
- [ ] **与本计划的顺序**：P0 全部完成后再开 P3；P2.1（目录拆分）必须等 P3 阶段 1 完成。

---

## 里程碑与工作量

| 优先级 | 内容 | 预估 | 阻塞关系 |
|---|---|---|---|
| **P0** | 红灯 + CI + 4 个兜底 + 1 次定级 | **4-6 天** | P0.1 → P0.2 优先；P0.3-P0.6 可并行 |
| **P1** | 鉴权装饰器 + HTTP 客户端 + 卫生 + env | **5-7 天** | 依赖 P0.2（无门禁不建议大面积重构） |
| **P2** | 目录拆分 + 去重 + 前端 token | **5-7 天** | P2.1 依赖 P3 阶段 1 |
| **P3** | 既有计划阶段 1-3 | **7-11 天** | 依赖 P0 完成 |

**建议执行顺序**：`P0.1 → P0.2 → (P0.3 ∥ P0.4 ∥ P0.5 ∥ P0.6) → P1.3（顺手）→ P1.1 → P1.4 → P3.1 阶段 1 → P2.1 → P1.2 → P2.2 → P2.3 → P3.1 阶段 2-3`

理由：P0.1/P0.2 是所有后续工作的前提（无绿基线 + 无门禁 = 重构无法验证）；P1.3 只需 30 分钟随手做掉；P1.1 是机械但收益面最广的；P3 阶段 1 要在 P2.1 之前以避免冲突。

## 风险与回滚

- **每个任务独立成 commit**，变红即 `git revert` 单个提交。
- **P0.5（video）是 P0 里唯一有误伤风险的**：把仍在上游正常跑的长任务误判为卡单并退款，比不退款更糟（用户拿到了货还被退了钱）。该任务的上游状态核对逻辑必须有测试覆盖四种分支后才能上线。
- **P2.2 Step 1（`estimateInputTokens`）可能挖出既存计费 bug**。若确认口径不一致，**停下来先报告**，不要在重构提交里顺手改计费口径。**（2026-08-24 已验：7 份实现口径一致，均为 `长度 / 3` 向上取整，此风险未触发。）**
- **P1.1 / P1.2 改动面极广但机械**：严格一域/一模块一提交，不要图快合并。
- **前端测试比 0.25、admin 0.11**，回归信号弱。涉及这两处的任务必须人眼验收。
- **P2.4 批次一与 P3.1 阶段 1 不能并行**：阶段 1 的门面兼容契约把 `codex-pet-worker.ts` / `codex-pet-packaging.ts` / `codex-pet-visual.ts` 等列为"一行都不改"，而批次一要拆它们。推荐先阶段 1(37 步已写好)，再批次一。
- **P2.4 批次二必须在 P1.2 之后**：否则 `api.ts` 的 75 处裸 fetch 迁移会在多个新文件里重复做一遍。
- **P2.4 纯移动的判据是"测试文件一行都不用改"**。如果拆分需要改测试，说明动了行为，停下重新设计 —— 这是纯移动与重构的分界线。
- 项目**当前未上线**，是做这批整治的最佳窗口。

## 基线记录（P0.1 Step 3 填写）

> 执行者：source `.env` 后跑 `pnpm test`，把每个 workspace 的 `passed / failed / skipped` 三元组填在这里。后续所有任务以此为对照。

**2026-08-03 实测**，`set -a && . ./.env && set +a` 后 `pnpm test`。全部 10 个 workspace 均为**非缓存实跑**（缓存命中的 7 个已用 `--force` 重跑复核，数字一致，见执行记录偏差 3）。

| workspace | passed | failed | skipped | 测试文件 | 日期 |
|---|---:|---:|---:|---|---|
| `@ai-assistant/api` | 1642 | **12** | 17 | 221 passed / 4 failed / 6 skipped (231) | 2026-08-03 |
| `@ai-assistant/web` | 416 | 0 | 0 | 79 (79) | 2026-08-03 |
| `@ai-assistant/desktop` | 123 | 0 | 0 | 19 (19) | 2026-08-03 |
| `@ai-assistant/codex-pet-pipeline` | 48 | 0 | 0 | 4 (4) | 2026-08-03 |
| `@ai-assistant/billing` | 31 | 0 | 0 | 1 (1) | 2026-08-03 |
| `@ai-assistant/admin` | 17 | 0 | 0 | 5 (5) | 2026-08-03 |
| `@ai-assistant/article-workflow` | 13 | 0 | 0 | 2 (2) | 2026-08-03 |
| `@ai-assistant/novel-workflow` | 13 | 0 | 0 | 5 (5) | 2026-08-03 |
| `@ai-assistant/connector-protocol` | 13 | 0 | 0 | 2 (2) | 2026-08-03 |
| `@ai-assistant/llm` | 12 | 0 | 5 | 1 passed / 2 skipped (3) | 2026-08-03 |
| **合计** | **2328** | **12** | **22** | | |

`pnpm typecheck` = 11/11 通过。

### 12 个 failed 的归属：全部是环境耦合，非代码缺陷

与本文件「已知基线」表一致，**一例不多一例不少**。这些测试断言的是「billing 不可达 → 502」，但 source `.env` 后 `BILLING_BASE_URL` 指向真实在跑的 billing 服务，于是返回 200。实测失败信息即 `expected 200 to be 502`。

| 文件 | 例数 | 根因 |
|---|---:|---|
| `admin/resource-routes.test.ts` | 7 | billing 可达 → 200 而非 502 |
| `admin/membership-routes.test.ts` | 3 | 同上 |
| `admin/code-routes.test.ts` | 1 | 同上 |
| `agents/routes.test.ts` | 1 | S3 已配置，上传路径行为与断言不符 |

**这是测试自身的缺陷**（把环境条件当断言前提，而非 mock 掉），不是产品代码缺陷。修它属于独立任务，不在 P0.1 范围。

### 22 个 skipped 的完整清单（P0.2 Step 3 的防护基线）

source `.env` 后 DB-gated 的守卫已全部放行，剩下的 skip **全部是 `.poc.` 试验测试**，门槛是模型类 API Key —— 与 P0.2 Step 2「模型类 Key 留空」的决定一致，属预期。

| workspace | 文件 | skipped |
|---|---|---:|
| api | `workflow/gpt-image-edit.poc.test.ts` | 8 |
| api | `workflow/codex-pet-look.poc.test.ts` | 2 |
| api | `workflow/codex-pet-look-b.poc.test.ts` | 2 |
| api | `workflow/codex-pet-action.poc.test.ts` | 2 |
| api | `workflow/codex-pet-r7-recovery.poc.test.ts` | 1 |
| api | `memory/__tests__/embedding.poc.test.ts` | 1 |
| api | `workflow/codex-pet-runner.integration.test.ts`（文件内单例，其余 39 例实跑） | 1 |
| llm | `src/__tests__/tooluse.poc.test.ts` | 3 |
| llm | `src/__tests__/bailian-catalog.poc.test.ts` | 2 |

**注意**：本文件 P0.2 Step 3 列的「12 个 `skipIf` 守卫文件」是**无 env 时**的清单。有 env 时只剩上面 9 处。P0.2 的防护应以 **22** 为上限基线。

---

## 执行记录

### P0.1（2026-08-03 完成，commit `af5f926`）

计划与实际有 4 处偏差，均为「计划基于的事实已过期」而非执行取舍：

**偏差 1：Step 2 是空操作 —— 集成测试早已被修好。**
计划断言 `codex-pet-routes.integration.test.ts` 的 billing mock 缺 `reserveResource` 导致 503。实际读文件发现 mock 已含 `reserveResource`（:45、:58），断言也已是按图预留语义（`chargeResource` not called、`reserveResource` 一次、units = `CODEX_PET_PLANNED_IMAGE_CALL_LIMIT`）。实跑 **1 passed / 0 failed / 0 skipped**。`git log -S reserveResource` 显示这些是随 `5801614`（生图模块新增形象照多风格）进仓的 —— 即既有计划的阶段 0 Task 0.1 已被其他改动顺带完成，只是没人回来勾选。**本次未改该文件一行。**

**偏差 2：`. .env` 在 zsh 下直接报错，两份文档给的命令都跑不了。**
`docs/ai-collaboration.md §1.1` 与本文件「全局验证纪律」写的 `set -a && . .env && set +a`，在 zsh 下报 `(eval):.:1: no such file or directory: .env` —— zsh 的 `.` 只搜 `PATH`，不含 cwd。**必须写成 `. ./.env`**。这个坑比它看起来严重：命令失败后若不检查退出码就继续跑测试，得到的正是那 12 个 `skipIf` 文件静默跳过的假绿。两份文档的命令都需订正。

**偏差 3：turbo 的 `passThroughEnv` 使缓存命中可能重放「无 env」的旧结果 —— 一条计划未识别的假绿路径。**
`turbo.json` 的 `test` 任务把 `DATABASE_URL` / `BILLING_BASE_URL` 等 ~49 个变量放在 `passThroughEnv`，该字段**只透传、不参与缓存哈希**。首轮 `pnpm test` 有 **7/10 个 workspace 是 cache hit**（只有 api / web / codex-pet-pipeline 实跑），意味着那 7 个的数字理论上可能来自某次没 source `.env` 的运行。已用 `turbo run test --force` 单独重跑这 7 个复核，**0 cached，数字与缓存值完全一致**，故基线可信。**但机制风险仍在**：P0.2 建 CI 时，`test` 任务应把 DB/Redis 类变量改为 `env`（参与哈希）或对 test 任务设 `cache: false`，否则 skip 计数防护本身会被缓存重放绕过。

**偏差 4：基线记录写进了本文件但进不了 commit。**
`docs/*` 被 `.gitignore:13` 整目录忽略（`git ls-files docs/` 为空），故本次 commit 只含 `apps/web/src/codexPetApi.test.ts` 一个文件。基线数字已同时贴在会话报告里。文档入库需项目所有者决策，见 P1.4 Step 3。

**实际改动**：仅 `apps/web/src/codexPetApi.test.ts` 一处 —— 给 `normalizes install links and project details used by knowledge-base actions` 的 expected 对象补 `extraCallBudget: null`。默认值 `null` 已按纪律读实现确认（`codexPetApi.ts:386` 的 `detail.extraCallBudget ?? null`，且 mock 响应未带该字段），非照抄计划的猜测。该文件 **10 passed / 0 failed / 0 skipped**。

### P0.2（2026-08-05 完成，commit `5485de4` + `d4512d2`）

**交付物**：`.github/workflows/ci.yml`（typecheck+lint 与 test 两个 job）、`scripts/check-test-report.mjs`（假绿防护）、`.github/test-baseline.json`（基线数字）、biome 配置。

**负向测试都做了**（计划 Step 5 要求的两个）：故意的类型错误让 typecheck job 变红；故意抽掉 env 让 skip 数超基线、防护 job 变红。只验证「绿的时候是绿的」证明不了门禁有效，这两个反例才是。

**首次真跑就抓到了两个真实缺陷 —— 防护按设计生效，但也暴露基线本身测错了：**

**偏差 1：`ubuntu-latest` 不带 ffmpeg，而基线是在有 ffmpeg 的本地测的。**
CI 首跑 api 报 1645/2/24，本地是 1653/0/18。差的 8 个用例全是 ffmpeg：`dub-ffmpeg` / `video-compress` / `local-business-promo-render` 用 `describe.runIf(hasFfmpeg)` 静默跳 6 例，`local-business-promo-edit-analysis` 没守卫直接 `spawn ffmpeg ENOENT` 挂 2 例。**这 8 个是真要跑真 ffmpeg 的，所以给 CI 装上，而不是放宽基线** —— 放宽正是这套防护要拦的事。已用本地 PATH shim 把 ffmpeg 藏掉复现，得到 8/2/6，与 CI 完全一致。
教训写进基线文件的 `_ffmpegCaveat`：**「与 ci.yml 的 env block 一致」不等于「环境一致」** —— 系统二进制不在 env 里。

**偏差 2：`upload-artifact@v4` 默认排除隐藏文件，导致红灯时报告是空的。**
报告名 `.vitest-report.json` 以点开头被默认排除，加上 `if-no-files-found: warn`，表现为「上传成功但零文件」。第一次红灯想下报告排查才发现 —— 我为这个场景建的诊断，在它第一次真正被需要时是空的。改 `include-hidden-files: true` + `if-no-files-found: error`（这一步是红灯时唯一能拿到逐用例结果的地方，上传不到就该当失败看）。

**偏差 3：我自己的 skip 机制清单不全。**
计划列的 12 个守卫文件全是 `skipIf`，我照着 grep `skipIf` 去核对那 6 个多出来的 skip，一无所获。真正的机制是 **`describe.runIf`** —— 另一种写法，另一批文件。**查静默跳过时 `skipIf` 和 `runIf` 都要搜。**

**方法论教训（同一个错犯了两次）**：两次算错数字，都是「一次动了两个变量」。第一次拿本地（有 ffmpeg）比 CI（没有）；第二次拿基线的树（`af5f926`）比我的树（含用户 5 个未提交文件），两边都是 18 skipped 就误以为对上了，其实是巧合。修法是搭一次性的验证脚本：干净 HEAD 的 worktree + 只叠自己改的文件 + `diff` 逐个确认别人的未提交文件与 HEAD 一致，再跑。**结论要从报告 JSON 读，不要手算。**

### P0.3（2026-08-05 完成）

**与计划的设计分歧（本任务最重要的一条）：计划写的「抢占改 `failed` + 退款」对 portrait 是有害的，没有照做。**

portrait 与 article-workflow 的差别在于**它是可续跑域**：已生成的图落在 `PortraitOutput` 表里，重跑只补缺的 `requestIndex`，不会重复出图、也不会重复计费。而 `recover()` 捞行的过滤器是 `status in ["pending","running"]` —— **一旦按计划标成 `failed`，这行就永久出不了这个过滤器，已经出好的图连同那笔钱一起丢掉。** 计划的形状是对 article 那种「不可续跑、只能收尸」的域正确，抄到 portrait 上是数据损坏。

而且 portrait 真正缺的不是恢复逻辑 —— `recover()` 早就写好且质量不错，缺的是**触发器**：它只挂在 `GET /api/workflow/portraits/state` 上，且按 `userId` 限定。用户不回来刷页面，进程重启前排期的任务就永远停在 `running`，钱挂在预留里。这与 P0.4 描述的 image 现状是同一个病。

所以实际交付的是**主动扫 + 计费对账**两趟（此方案经确认后采纳，明确接受它比计划的 2-3 小时估时更大）：
1. `scanStalePortraitTasks` —— 跨用户扫 `status in ["pending","running"] AND updatedAt < 阈值`，把行喂给**同一个** `recover()`（复用，不复制实现），`take: 200` 限一轮规模。**不写任何 status。**
2. `reconcileStalePortraitBilling` —— 扫 `status` 已终态但 `billingStatus` 仍 `reserved` 的行并结算。这些行的来源是明确的：`runPortraitTask` 的 `.catch(() => undefined)` 之后紧跟终态写入，中间崩掉就留下这种行。

**偏差 1：阈值不能写死 15 分钟，那会误杀在跑的任务。**
计划给的 15 分钟是照抄 article 的数字。但阈值要盖住的**不是整个任务的耗时，而是两次心跳之间的最长间隔** —— 心跳是 `updatedAt`（runner 每出完一张图写一次 `completedCount`，`@updatedAt` 自动刷新），所以要盖的是「产出单张图的最坏耗时」= 单次尝试超时 × 兜底重试次数 + 固定间隔退避，实测推导出约 45 分钟。写死 15 分钟会把正在重试第二张图的任务判成超时。这正是 article 当年踩过的坑（那边写死 15 分钟，后来加了重试才暴雷，`article-workflow-reaper.test.ts` 第 5、6 例就是为拦这个而存在）。**故阈值从同一批常量推导**（`portraitTaskStaleMs()` 读 `loadImageAttemptTimeoutMs` 与 `portraitMaxAttempts`），超时或重试预算调整时不会悄悄失配，并照抄了那两个回归用例。

**偏差 2：reaper 注册在 portrait 插件内部，不在 `server.ts`。**
计划说照抄 `server.ts` 里 `startArticleWorkflowReaper` 的位置。但续跑要用到插件闭包里的一整套依赖（`activeTasks` / `scheduleTask` / `callImageEdit` …），搬到 `server.ts` 得整套重接一遍。改为 reaper 收 `resume` / `settle` 两个回调，注册在插件内、`clearInterval` 挂插件自己的 `onClose`；`server.ts` 只多传一个 `redis`。**`redis` 是可选的**，不传就不起 timer —— 所以存量 portrait 测试零影响（并有一例专门断言这点）。

**偏差 3：多出一个 `portrait-shared.ts`。**
把常量从 `portrait-routes.ts` 挪出来，否则 routes → reaper → routes 循环导入。形状对齐已有的 `article-workflow-shared.ts`。

**新增文件**：`workflow/portrait-shared.ts`、`workflow/portrait-reaper.ts`、`workflow/portrait-reaper.test.ts`（15 例）。**改动文件**：`workflow/portrait-routes.ts`（`recover` 改为 `{ userId?, rows? }` 双入口共用一份实现）、`server.ts`（一行传 `redis`）。

**验证**：
- `portrait-reaper.test.ts` **15 passed / 0 failed / 0 skipped**；`src/workflow/portrait` 全域 **41 passed / 0 failed / 0 skipped**
- `tsc --noEmit` exit 0；biome exit 0（顺带被 biome 抓到我自己留的一个未用类型导入 —— P0.2 建的门禁抓到了 P0.3 的回归）
- **两次变异测试证明用例非空转**（15/15 首跑即绿，而测试与实现是一起写的，不验就是自证）：把阈值推导改成写死常量 → 恰好那 2 个回归用例红；把 reaper 接线摘掉 → 恰好 2 个接线用例红
- 全仓实测（空库 + ci.yml 原命令 + `--force`）：干净 HEAD 只叠本任务文件 = **2354 / 0 / 23**，防护脚本自身 exit 0。相比上一版基线 2339 只多 api 的 +15，即新增的 15 例，无新增 skip。基线 `minPassed` 已抬到 2354（实测值，非推算）
- 当前工作树（含他人 5 个未提交文件）= **2367 / 0 / 23**，即那 5 个文件净加 13 例 —— 故抬到 2354 不会挡住他们后续提交

**未做（不在范围）**：`server.ts:247` 的 `startDubReaper` 返回值被丢弃、没有 `clearInterval`，关停后 interval 仍在跑。这是既有缺陷，与本任务无关，留待独立处理。

---

## 执行记录 P0.4（2026-08-05）

### 与计划的偏差

**偏差 1（计划有错，已在正文标注）：对账那趟必须扫终态。** 计划 Step 1 让一条「非终态」查询同时喂给两个函数。但 `reconcilePendingImageBilling`（`image-routes.ts:603`）的第一道过滤是 `if (!terminalReasonOf(task.status)) return false` —— 只收 `completed`/`failed`/`cancelled`。而 image 只有一个非终态（`running`）。照计划写，对账那趟**永远零行**，而且静默：漏账照旧，测试也不会红。与 P0.3 那个「照抄收尸形状」是同一类错 —— 计划把两个域的形状按表面相似度归了类，没核对被复用函数的实际过滤条件。

故改为两条查询、两趟：续跑扫 `status: "running"`；对账扫 `status: { in: 三个终态 }, billingMode: "reserve", billingStatus: { in: ["reserved","settle_failed","settling"] }`。为此专门加了一条回归用例（`对账扫的是终态而不是 running`），直接断言 where 条件，否则这个错下次还会被抄回去。

**偏差 2：注册在插件内，不在 `server.ts`。** `resumeStaleTasks` 需要 `scheduleTask` 与 `fetchFn`，这两个只在 `imageWorkflowRoutes` 的闭包里有。`server.ts` 只多传一个 `redis`。**并且新加了 `onClose` 钩子** —— image-routes 原本一个钩子都没有，漏了就会攒定时器（P0.3 的 portrait 本来就有，这里是新增的）。

**偏差 3：阈值不重新推导。** 与 portrait 相反。portrait 的心跳是每出完一张图刷一次，阈值要盖单张图的最坏耗时（含全部重试预算），所以那边推导。image 的 runner 在 `onRetry` 里就 `updateTask`（刷 `@updatedAt`），两次心跳的最长间隔 = 一次尝试超时 + 一次退避，**不乘 maxAttempts** —— 现成的 `DEFAULT_STALE_TASK_MS`（10.5 分钟）正是这个式子，原样搬走即可。

**偏差 4：整批交回，不逐行。** portrait 的 reaper 是逐行 try/catch（那边 `recover()` 会按行抛）。image 的两个函数**内部已经吞掉逐行计费错误**（`settleImageTaskBilling(...).catch(() => undefined)`），剩下能抛的只有 prisma —— 那是系统性故障，整轮放弃才对。所以整批一次交回，保住 `Promise.all` 的并行度（image 是最高频域，一批 200 行逐行串行发计费请求代价太大）。

### 循环导入

新建 `image-shared.ts` 放 `IMAGE_TASK_STATUS` / 终态与未结算状态分组 / `SETTLING_STALE_MS` / 阈值 loader / **行类型 `ImageGenerationTaskRow`**。把行类型也搬进去之后，`image-reaper.ts` 对 `image-routes.ts` 是**零 import**，循环从根上不存在（不是靠 `import type` 擦除绕过）。搬移前逐个数过引用数，确认这些符号此前只在 image-routes 内部使用。

顺带删掉一个自己造的死代码：`IMAGE_ACTIVE_STATUSES` 定义了但没人用（续跑查询用的是标量 `status: "running"`），提交前移除。

### 变异测试（证明用例不空转）

| 变异 | 预期 | 实测 |
|---|---|---|
| 对账查询改回计划的「扫非终态」 | 回归用例挂 | ✅ 只挂 `对账扫的是终态而不是 running` 1 例 |
| `if (deps.redis)` → `if (false && deps.redis)` | 接线用例挂 | ✅ 挂 3 例（断言「不该起」的 2 例自然仍绿） |
| `resume: resumeTasksIfStale` → `async () => 0` | 只挂续跑那条 | ✅ 精确 1 例 |
| `reconcile: reconcileTasksBilling` → `async () => 0` | 只挂对账那条 | ✅ 精确 1 例 |
| 删掉对账查询的 `billingStatus` 过滤 | —— | ⚠️ 见下 |

**一处自我纠正**：我最初写了条叫「与被动路径并发不双花」的用例，用假定时器让 reaper 那趟和轮询那趟对撞。变异 `settleImageTaskBilling` 的原子抢占（`if (claimed.count !== 1) return` → `if (false) return`）时，挂的是**既有**用例 `settles a reservation exactly once when two settlement paths race`，我那条没挂 —— 说明它实际是顺序执行（第一趟已把行写成 `settled`，第二趟的查询才开始），没造出真竞争。后来试图用闸门确定性造竞争，又踩了第二个坑：reaper 一轮自己就发两次查询（扫 + 对账），我的计数闸门在轮询那趟到达前就放行了（幸好加了前置校验 `expect(claims).toBeGreaterThanOrEqual(2)`，把空转当场逮住）。

结论是把用例名改成它真正证明的东西（`没人轮询也能把终态漏掉的账补上`），并在注释里写明：瞬时竞争由那条既有用例守着，跨轮不重复由 `reconcilePendingImageBilling` 自己的 `billingStatus` 过滤守着，我这条多跑几轮只是顺带的冒烟——不是那两条保证的替身。**这也是上表最后一行的含义**：删掉我 reaper 查询里的 `billingStatus` 过滤，只有 reaper 单测的 where 断言会挂，多轮那半断言打不挂它。与其让用例名许下守不住的承诺，不如写清由谁守。

### 一个新踩到的坑

`vi.useFakeTimers()` **必须在注册插件之前调用**。`setInterval` 是注册时创建的，事后切假定时器不会把已存在的真定时器接管过来 —— 表现是 `advanceTimersByTimeAsync` 怎么推都不触发，`redis.set` 零调用。已写进用例注释。

### 验证结果

- `pnpm vitest run src/workflow/image`：**125 / 0 / 0**（6 个文件；新增 21 例 = reaper 单测 16 + 插件接线 5）
- `tsc --noEmit`（apps/api）：exit 0
- `biome lint`（6 个涉及文件，与 CI 门禁同款、`--formatter-enabled=false`）：exit 0。格式检查另有 2 处提示，但 `portrait-reaper.ts` 同样 2 处，CI 刻意关掉了 formatter（见 `ci.yml:49-52`），非本次引入。
- apps/api 全量，同一 env 前后对照（工作树都含他人 5 个未提交文件）：

| | passed | failed | skipped | 合计 |
|---|---|---|---|---|
| 干净 HEAD（我的改动 stash 掉） | 1670 | 12 | 17 | 1699 |
| 叠上 P0.4 | 1691 | 12 | 17 | 1720 |
| 差值 | **+21** | **0** | **0** | +21 |

### 那 12 个失败：既有的本地/CI env 分歧，不是我改坏的

分布：`src/agents/routes.test.ts` 1 例 + `src/admin/{resource,membership,code}-routes.test.ts` 11 例。**把我的改动全部 stash 后用同一 env 复跑，同样是这 12 例**，逐条同名。

根因：这些用例写的是 `process.env.BILLING_BASE_URL ??= "http://localhost:1"` —— `??=` 只在变量**未设**时才填不可达占位。而 `set -a && . ./.env` 把它设成了本地**真实在跑**的 billing（:8093），于是拿到 200 而非预期的 502。agents 那条同理：它断言「测试环境无 S3，回落 object key」，但 .env 里 minio（:9000）是活的。

CI 上不会红：`ci.yml:107` 的注释写明 `BILLING_BASE_URL` **必须「存在但不可达」**（CI 里 8093 没人监听），S3 一律留空。

**这条与前提 1 直接冲突，值得记下**：source .env 是跑那些 `skipIf`/`runIf` 守卫用例的前提，但同一个 .env 会让这 12 例必挂。本地全量永远到不了 0 failed；要和 CI 数字对齐，得用 CI 那套 env（P0.2 的基线实测就是这么做的），不是本地 .env。已写进记忆 `ci-baseline-gotchas.md`。

### CI 验证（main，3 个提交）

| run | 提交 | 结果 |
|---|---|---|
| 31000904356 | `fix(image): 计费对账与卡单恢复改为主动定时扫` | ✅ 全绿。**2375 / 0 / 23**，api 1689/0/18 —— 相对基线记录的 api 1668 正好 +21，与新增用例数吻合，无新增 skip |
| 31002058241 | `ci: 基线下限顶到 2375` | ❌ test job 绿（14m9s），typecheck+lint 红（24s）—— 见下 |
| 31003402016 | `ci: 只改被 biome 忽略的文件时不该判红灯` | ✅ 全绿，`passed 下限 2375 / 实际 2375` |

基线下限从 2354 顶到 2375，数字直接取 CI 自己打印的合计（比上一版的本地 worktree 实测更可信 —— CI 就是被防护的那个环境）。理由同 P0.3：`minPassed` 是防「悄悄删测试」的，留在旧值上新增的 21 例就不受保护。`maxSkipped` 保持 23。

**顺手修掉一个门禁自身的缺陷**（我这次 push 才触发）：`ci: 基线下限顶到 2375` 只动了一个 biome 忽略的 JSON，`biome ci --changed` 于是报「No files were processed」并 exit 1，把纯配置/文档提交判成红灯。「这次没有需要 lint 的文件」是正常情况不是失败，加了 `--no-errors-on-unmatched`。本地用同一条 `--since=HEAD~1` 复现确认：不带 flag exit 1、带上 exit 0。**这个坑对后面每个「只改文档/基线」的提交都成立**，包括 P0.6（纯调研，只改文档）。

**未做（不在范围）**：`loadImageAttemptTimeoutMs` 在 `image-service.ts:825` 与 `image-routes.ts:199` 逐字节重复 —— 属计划 Task P2.2（收敛重复工具函数），未动。另：`DEFAULT_STALE_TASK_MS` 用的是**默认**尝试超时常量、不读 `IMAGE_ATTEMPT_TIMEOUT_MS`，把那个 env 调大而不同步调大 `IMAGE_STALE_TASK_MS` 会让在跑的行被判成卡单。这是既有行为，本次原样搬移未改，已在 `image-shared.ts` 注释标注。

---

## P0.5 執行記錄（2026-08-05）

### Step 1 的结论把这个任务变便宜了：不需要 migration

`operationId` 在两处都是 `` `video:${requestId}` `` 现拼的，`requestId` 是 `@unique` 列，`@@index([status, updatedAt])` 与 `@@index([providerTaskId])` 都已存在。所以兜底扫能原地重建 operationId，**不加列、不写 migration**。计划里那整段「若需加列」的手写 migration 流程（含 `prisma migrate dev` 禁令）本次完全没用上。

### 三个动手前发现的问题，两个计划没预料到

**① 计划的「上游查不到 → 失败退款」会在上游抖动时错退钱。** `getVideoGenerationStatus` 对 404 和 500/超时/DNS 抛的是同一种异常，按它的返回值分不出「任务没了」和「上游暂时答不了」。照计划直接实现，上游一次 502 就会把全库在跑的长任务集体退款 —— 正是计划第 430 行自己警告的那种误伤。

解法是新增 `probeVideoGenerationStatus`，三态返回 `found` / `missing`(404,410) / `unknown`(5xx、401/403/429、超时、网络、响应体坏)。**`unknown` 一行都不动**，等下一轮。`getVideoGenerationStatus` 逐字节没改 —— 它在轮询热路径上，不值得为兜底去动它。

**② 用 `runVideoTask` 续跑会重新向上游提交、重新扣费。** 它是从「提交」那步开始的。抽出后半段 `finishSubmittedVideoTask`（轮询 → 入库 → 结算 → 标记完成）给兜底复用。这是本任务最大的一处改动，且**动到了主路径代码**（P0.4 只搬常量，这次不是）。

**③ 实现中发现的第三个钱的问题（批准后才发现，此处补记）：兜底扫拿 0 当输入秒数会「多退」。** 自动时长的结算走 `settleVideoResource` → Go 侧 `SettleVideoIO` → `QuoteVideoIO`，对 `VIDEO_IO` 定价是 `ceil(输入秒×Rate + 输出秒×OutputRate)`（`services/billing/internal/resource/resource.go:88`，已读源码确认）。`inputSec` 传 0 会把实际成本算少，于是**多退给用户一笔**。

而兜底扫**真的拿不到**输入秒数：建行时 `resultPayload` 存的是含 `video_with_roles` 的请求体，**首次轮询就把它覆盖成状态体了**。所以 `inputDurationSec` 的类型是 `number | null`，`hasInputVideo && null` 时**跳过**这次自动时长结算精修（而不是拿 0 顶上），并 warn 日志。代价是用户按预扣的 15s 多付一点 —— 方向上比多退安全得多。

### 阈值是推导出来的，不是拍的

阈值要盖住的是**两次 `updatedAt` 写入之间的最长间隔**，不是任务总耗时。video 有两段空窗：

| 空窗 | 内容 | 最坏值 |
|---|---|---|
| 建行 → 提交成功 | `submitWithRetry`：60s 超时 × (1+2 重试) + 2×2s 退避 | **184s** |
| 最后一次轮询 → 标记 completed | 视频下载（硬编码 120s 超时）+ S3 上传 + upsert | 120s + 余量 |

轮询本身**不是空窗**（每轮都 `update`，间隔 10s），所以阈值与 `maxPollAttempts × pollIntervalMs`（600s 总窗口）无关 —— 拿总窗口当阈值会让兜底晚十分钟才介入。取 184s 的两倍取整到 10 分钟。`DEFAULT_VIDEO_STALE_TASK_MS = 600_000` 恰好等于那个总窗口是**巧合**，测试里专门注释了这点，免得后人以为是依据。

### 与 portrait/image 刻意不同的两处

| 项 | portrait/image | video | 为什么 |
|---|---|---|---|
| 批量上限 | 200 | **50** | 每行都要发一次上游请求，批量大了一轮打爆限流 |
| 异常边界 | 整批交回 | **逐行 try/catch** | 一行的网络失败不该带走整批，紧接着那行可能正好能救 |

其余照既定形状：Redis `SET NX EX 55` 抢锁 + `setInterval` 60s + `unref`，**不立即跑第一轮**（同时重启的实例会在启动瞬间抢同一把锁），`onClose` 清 timer。

### 变异测试：18 条全部被杀

| # | 变异 | 结果 |
|---|---|---|
| M1 | `unknown` 也去退款（把上游抖动当任务没了） | 3 红 |
| M2 | 去掉 `providerTaskId` 缺失的直接失败 | 4 红 |
| M3 | `missing` 也去续跑 | 3 红 |
| M4 | `upstreamFailed` 不再退款 | 1 红 |
| M5 | `findMany` 去掉 `status` 过滤 | 1 红 |
| M6 | `findMany` 去掉 `updatedAt` 过滤 | 2 红 |
| M7 | 立即跑第一轮 | 5 红 |
| M8 | 不抢锁就干活 | 2 红 |
| M9 | 去掉 `timer.unref()` | 1 红 |
| M10 | 阈值缩到 60s（盖不住 184s 空窗） | 3 红 |
| M11 | `loadVideoStaleTaskMs` 不做正数校验 | 1 红 |
| M12 | 404 也算 `unknown`（永远不收尸，钱永久悬空） | 2 红 |
| M13 | 5xx 也算 `missing`（上游抖动就退款） | 3 红 |
| M14 | fetch 抛异常（超时/DNS）也算 `missing` | 2 红 |
| M15 | 不注册兜底扫 | 6 红 |
| M16 | 去掉 `onClose` 清 timer | 1 红 |
| M17 | 逐行 catch 改成往外抛 | 1 红 |
| M18 | 一行抛异常时顺手退款（原因不明就动钱） | 1 红 |

**M14 第一轮活下来过**，暴露的是真缺口：当时没有任何用例钉住「fetch 抛异常 → `unknown`」。补了 `probeVideoGenerationStatus` 的 8 条直接单测（含 401/403/429 → `unknown`，那两个尤其危险：配置写错或被限流时若判成 `missing`，会把全库在跑的任务集体退款）后被杀。这条是本次变异测试唯一的真实收获，不是走过场。

（M17 第一轮输出为空 —— perl 替换把 try/catch 改成了 `if (true) {` + 悬空 `catch`，语法错误导致 vitest 连收集都没做完。那是脚本 bug，不是「变异存活」。改成在 catch 里 `throw error` 后 1 红。）

### 一处覆盖不到的地方，说明白

「`hasInputVideo` 且输入秒数未知 → **跳过**结算而不是传 0」这条**没有**路由层用例。原因：`video-routes.test.ts` 在 `beforeEach` 里 `delete process.env.S3_*`，于是 `storeGeneratedVideo` 短路返回 `durationSec: 0`，而结算分支的前置条件是 `stored.durationSec > 0` —— 在这个测试环境里该分支物理上不可达。要覆盖得搭 S3 + ffmpeg + 下载 mock，成本远超收益。当前靠代码注释（引 `resource.go:88`）+ 本記錄标注风险，**留作已知缺口**。

### 验证数字

| 项 | 结果 |
|---|---|
| `video-reaper.test.ts` | **20 passed / 0 failed / 0 skipped**（新建） |
| `video-routes.test.ts` | **17 passed / 0 / 0**（HEAD 为 9，+8） |
| `video-service.test.ts` | **15 passed / 0 / 0**（HEAD 为 7，+8） |
| `npx tsc --noEmit -p tsconfig.json` | 通过（无输出） |
| `biome check --formatter-enabled=false`（8 个改动文件） | Checked 8 files，无问题 |
| apps/api 全量 | **1727 passed / 12 failed / 17 skipped**（P0.4 记录为 1691/12/17，**+36/+0/+0**，与新增 36 例吻合） |

**那 12 个失败是环境问题，不是回归**，与 P0.4 逐条相同：11 个 `admin/*` 的「billing 不可达返回 502」+ 1 个 `agents/routes` 的 S3 avatarUrl 回落。根因是本地 `.env` 提供了**可达**的 `BILLING_BASE_URL` / `S3_ENDPOINT`，而这些用例断言的正是不可达路径。CI 没有这些 env，所以 CI 是绿的。**本次 video 相关 0 失败。**

### 改动文件

新建 `video-shared.ts`（破 routes↔reaper 循环导入，与 portrait-shared/image-shared 同构）、`video-reaper.ts`、`video-reaper.test.ts`；改 `video-service.ts`（+`probeVideoGenerationStatus`）、`video-routes.ts`（抽 `finishSubmittedVideoTask` / `refundAndFailVideoTask`，加 `redis?` dep，接线 + `onClose`）、`video-service.test.ts`、`video-routes.test.ts`（prisma mock 的 `findMany` 补 `status` 与 `updatedAt.lt` —— 旧 mock 只认 `userId`，不补就会把所有行都返回，兜底测试变成假通过）、`server.ts:166`。

### CI 验证

| 提交 | run | 结果 |
|---|---|---|
| `4a4a898 fix(video): 补上游状态核对式超时兜底` | 31062750749 | ✅ test + typecheck/lint 双绿，**2411 passed / 0 failed / 23 skipped** |
| `a7eb98e ci: 基线下限顶到 2411` | 31063591531 | ✅ 双绿，`下限 2411 / 实际 2411` |

api 单 workspace 在 CI 上 **1725 / 0 / 18**，相比 P0.4 记录的 1689 正好 **+36**，与新增 36 例吻合。基线下限从 2375 顶到 2411，数字取 CI 自己打印的合计（沿用 P0.4 定下的做法）。`maxSkipped` 保持 23。

**顺带验证了 P0.4 那个门禁修复真的管用**：`a7eb98e` 只动了一个 biome 忽略的 JSON，正是上次让 `typecheck + lint` 红掉的形状，这次绿。P0.6 是纯文档提交，同样受这个 flag 保护。

