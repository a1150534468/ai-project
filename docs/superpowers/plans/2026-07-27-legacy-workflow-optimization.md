# 存量工作流优化执行计划（codex-pet 优先）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不引入编排框架、行为零变化的前提下，把 codex-pet-runner.ts（5115 行）拆成可维护的模块、消除三份 look 修复循环拷贝、收敛 packages/llm 的三处路由复刻，并给 article-workflow 补上崩溃收尸与退款路径。

**Architecture:** 四个独立阶段按风险递增排序：先修红灯建立绿色基线（阶段 0）→ 纯移动拆分 runner（阶段 1，零行为变化）→ 行为敏感的去重与解耦（阶段 2）→ llm 层收敛（阶段 3）→ article 止血（阶段 4）。每阶段独立可交付、可暂停。决策背景见 [docs/orchestration.md](../../orchestration.md)：存量工作流保持自研编排并优化，新工作流将采用编排框架。

**Tech Stack:** TypeScript + pnpm monorepo + turbo；测试 vitest（DB 集成测试依赖 docker dev postgres:5433）；Prisma；@anthropic-ai/sdk。

---

## 范围边界（明确不做什么）

- **不引入编排框架**——那是新工作流的事。
- **不动 novel 线**（executeNovelEngineStep 的 240 行大函数、三套工作单元表等已知债留待后续单独立项）。
- **不抽通用 orchestration-kit**——先把 codex-pet 内部理干净，kit 等新框架选型落地后再决定要不要抽。
- **不改任何计费语义**：CodexPetImageCall 台账、reserve/settle/refund 时序、审批预算语义全部原样保留。
- **不改 SSE/事件表结构**，前端与 admin 直读的 Prisma 状态表投影不变。

## 全局验证纪律（每个任务都适用）

1. **DB 集成测试的静默跳过陷阱（最重要）**：`codex-pet-runner.integration.test.ts` 等 DB-gated 测试在 `DATABASE_URL` 未 export 时会 `describe.skipIf` 静默跳过且整体显示绿色。每轮验证前必须：
   ```bash
   cd "/Users/z/code/ai project" && docker compose -f docker-compose.dev.yml up -d --no-recreate postgres redis billing-postgres minio
   ```
   跑测试的 shell 里先 `set -a && source .env && set +a`，且**确认输出中 runner.integration 的用例数 > 0 而非 skipped**。
2. **标准命令**（下文任务里引用时写「typecheck」「合同测试」「runner 集成」「codex-pet 全量」）：
   ```bash
   # typecheck（约 8s）
   cd "/Users/z/code/ai project" && pnpm --filter @ai-assistant/db generate && pnpm exec turbo run typecheck --filter @ai-assistant/api --filter @ai-assistant/llm --filter @ai-assistant/codex-pet-pipeline
   # 合同测试（秒级，拆分期间的快速烟测）
   cd "/Users/z/code/ai project/apps/api" && pnpm exec vitest run src/workflow/codex-pet-runner-contract.test.ts src/workflow/codex-pet-board-version.test.ts
   # runner 集成（约 3-4 分钟，行为安全网）
   cd "/Users/z/code/ai project/apps/api" && set -a && source ../../.env && set +a && pnpm exec vitest run src/workflow/codex-pet-runner.integration.test.ts
   # codex-pet 全量（约 5 分钟，28 文件 229 用例，基线 = 221 通过 8 跳过，阶段 0 完成后）
   cd "/Users/z/code/ai project/apps/api" && set -a && source ../../.env && set +a && pnpm exec vitest run codex-pet
   ```
3. **行号免责声明**：本计划所有行号基于 2026-07-27 的工作区（含未提交改动）。执行每个任务前先用函数名 grep 校验锚点，行号漂移属预期，函数名不匹配才是异常。
4. **前置条件**：当前工作区有一批与本计划无关的未提交改动（admin/auth/schema.prisma 等）。**开工前请项目所有者先自行提交或 stash**，本计划的执行者不得代为提交这些改动。阶段 4 会改 schema.prisma，尤其要求先清空该文件的未提交状态。
5. 集成测试直接写共享 dev 库：跑测试期间**不要同时运行本地 codex-pet worker**，避免真实 worker 抢走测试 seed 的 queued run。

---

## 阶段 0：建立绿色基线（约 0.5 天）

### Task 0.1: 修复 codex-pet-routes.integration.test.ts 红灯

commit 0e41be5「harden codex pet generation billing」后 start 路由改为按图预留：`codex-pet-routes.ts:1697` 在 `billing.reserveResource` 缺失时抛「Codex pet billing reserve capability is unavailable」→ 503。该测试的 billing mock 只提供了 `chargeResource`，断言也停留在旧的整包扣费语义（期待 `chargeResource` 调用一次、`billingChargeStatus="charged"`、`billingPoints=200`）。

**Files:**
- Modify: `apps/api/src/workflow/codex-pet-routes.integration.test.ts:42-53`（billing mock）、`:88` 附近（断言）
- 参照: `apps/api/src/workflow/codex-pet-routes.test.ts:494` 的 `createBilling`（已含 `reserveResource`）

- [ ] **Step 1: 跑该测试确认失败形态**
  ```bash
  cd "/Users/z/code/ai project/apps/api" && set -a && source ../../.env && set +a && pnpm exec vitest run src/workflow/codex-pet-routes.integration.test.ts
  ```
  预期：FAIL，期望 202 收到 503。
- [ ] **Step 2: 补 mock 并更新断言**。对照 `codex-pet-routes.test.ts:494` 的 `createBilling` 形状，给本文件 42-53 行的 billing mock 增加 `reserveResource: vi.fn().mockResolvedValue(...)`（返回形状照抄 494 处）；把「chargeResource 调用一次 / billingChargeStatus="charged" / billingPoints=200」的断言改为按图预留语义：`reserveResource` 调用一次、units 为 14（planned 调用数上限，见 `codex-pet-call-ledger.ts:5` 的常量）。幂等 replay 断言（同幂等键第二次 start 不再 reserve）保留。
- [ ] **Step 3: 重跑该测试**，预期 PASS。
- [ ] **Step 4: 跑 codex-pet 全量**，预期 221 通过、8 跳过、0 失败。把这组数字记为基线。
- [ ] **Step 5: Commit**
  ```bash
  git add apps/api/src/workflow/codex-pet-routes.integration.test.ts
  git commit -m "test: 修复 start 路由集成测试的按图预留断言"
  ```

---

## 阶段 1：codex-pet-runner.ts 纯移动拆分（约 2-3 天）

**执行结果（2026-08-22，37 步全部完成）**：13 个模块搬完，`codex-pet-runner.ts` 5815 → 1561 行，只剩 `WORKER_ID` + `executeRun` + `executeCodexPetRun` + 子模块导入/re-export。136 个符号用脚本逐字节核对与拆分前原文一致（唯一允许的差异是私有符号新增的 `export `），门面兼容契约达成：4 个外部源文件 + 6 个外部测试文件零改动。验证：typecheck 3/3 绿；合同测试 25 passed / 0 failed / 0 skipped；runner 集成（Task 1.4、1.8 检查点）39 passed / 0 failed / 1 skipped；codex-pet 全量 320 passed / 0 failed / 8 skipped，与拆分前基线完全一致。实际模块划分与下方 Task 1.12 的分组略有出入：`runner-archive` 与 `runner-packaging-resume` 拆成了两个独立提交。

**原则：只做移动，不做任何行为修改。** 新建目录 `apps/api/src/workflow/codex-pet-runner/`（与 `codex-pet-runner.ts` 文件同名共存，ESM 导入统一带 `.js` 后缀，与现有代码风格一致）。原 `codex-pet-runner.ts` 最终保留为「编排 + 门面」：`WORKER_ID`、`executeRun`、`executeCodexPetRun` 加全部既有导出符号的 re-export。

**门面兼容契约（拆分成功判据）**：以下 6 个源文件 + 5 个测试文件**一行都不改**——`codex-pet-worker.ts`、`codex-pet-packaging.ts`、`codex-pet-failed-continuation.ts`、`codex-pet-generated-board-recovery.ts`、`codex-pet-recovery-finalizer.ts`、`server.ts`。为此门面必须 re-export：`CODEX_PET_ACTIVE_STATUSES`、`CODEX_PET_RESOURCE_KEY`、`CODEX_PET_BOARD_PROMPT_VERSION`、`CODEX_PET_IDLE_BOARD_PROMPT_VERSION`、`codexPetStandardRowPromptVersion`、`CodexPetLeaseLostError`、`codexPetShouldAttachFailedBoardForRepair`、`codexPetRepairGenerationReferences`、`codexPetMaxBoardAttempts`、`codexPetBoardInputRevision`、`assertCodexPetVisualQaProvenance`，以及全部导出类型（`CodexPetExecutionStatus/CodexPetExecutionResult/CodexPetArtifactPutInput/CodexPetArtifactStore/CodexPetEventInput/CodexPetRunnerDeps`）。

**三条硬约束**：
1. 信号异常类（`CodexPetLeaseLostError/CodexPetCancelledError/CodexPetImageApprovalRequiredError/CodexPetArchiveDeferredError`）catch 链靠 `instanceof` 分派，拆分后必须保持**单一定义点**（runner-types.ts），私有的三个类改为导出（TS 可见性变化，运行时零影响）。
2. `emit`（:533-566）在 `run.repairing` 事件上有隐藏写路径（事务内 lease CAS 并把 run/project 置 repairing），**不得**在移动中把它简化成纯事件函数。
3. `deriveRunningLeft` 与 `executeRun` 之间的 `Error("MIRROR_NOT_SAFE")` 字符串契约（:2384 抛出 / :4130 匹配）保持不变。

每个移动任务的标准验证：**typecheck → 合同测试**；在 Task 1.4、1.8、1.13 之后额外跑 **runner 集成**。

### Task 1.1: runner-types.ts（类型、常量、信号异常）

**Files:** Create `apps/api/src/workflow/codex-pet-runner/runner-types.ts`；Modify `codex-pet-runner.ts`

- [x] **Step 1:** 移动以下符号（现位于 :110-286 区间）：模块常量组 `CODEX_PET_ACTIVE_STATUSES / CODEX_PET_RESOURCE_KEY / INTERMEDIATE_TTL_MS / DEFAULT_STALE_RUN_MS / IDENTITY_GUIDE_VERSION / BOARD_JOB_INPUT_SCHEMA_VERSION / CODEX_PET_BOARD_PROMPT_VERSION / CODEX_PET_IDLE_BOARD_PROMPT_VERSION / CODEX_PET_RECOVERY_SCHEMA_VERSION`（**`WORKER_ID` 除外**——它在模块加载时求值 `process.pid`，留在入口文件）、`codexPetStandardRowPromptVersion`、四个异常类 `CodexPetLeaseLostError / CodexPetCancelledError / CodexPetImageApprovalRequiredError / CodexPetArchiveDeferredError`（后三个由私有改导出）、类型块 `CodexPetExecutionStatus / CodexPetExecutionResult / CodexPetArtifactPutInput / CodexPetArtifactStore / CodexPetEventInput / CodexPetRunnerDeps / RunnerContext / BoardJobResult / RegisteredDirectionRowResult`（:144-258）、`RunnerRunWithProject`（:756-758）、`isCodexPetRecoverySnapshot`（:493-531 组内）。
- [x] **Step 2:** `codex-pet-runner.ts` 顶部 `import { ... } from "./codex-pet-runner/runner-types.js"`，并对既有导出符号加 `export { ... } from "./codex-pet-runner/runner-types.js"`。顺带收益：`codex-pet-packaging.ts` 的 `import type` 改指 runner-types 可打断现存类型级循环导入——**本任务不改 packaging.ts**（门面 re-export 已保证其不需要改），仅在门面保留类型导出。
- [x] **Step 3:** typecheck，预期全绿。
- [x] **Step 4:** 合同测试，预期通过。
- [x] **Step 5:** Commit：`git add -A apps/api/src/workflow && git commit -m "refactor(codex-pet): 拆出 runner-types（纯移动）"`

### Task 1.2: runner-util.ts

- [x] **Step 1:** Create `codex-pet-runner/runner-util.ts`，移动：`asRecord / safeError`（:288-310）、`imageFailureMetadata / providerMetadata`（:493-531 组内）、`mapWithConcurrency`（:445-491，抛 `CodexPetCancelledError`，从 runner-types 导入）、`sameOrderedStrings`（:1628-1679 组内）、`imageInput`（:2424-2426）、`configuredVisualConcurrency / configuredArchiveMaxAttempts`（:411-419）、`staleRunMs`（:753-758 组内）、`frozenPerImageCallPoints`（:312-326）。
- [x] **Step 2:** 更新 runner.ts 导入。 **Step 3:** typecheck。 **Step 4:** 合同测试。 **Step 5:** Commit `refactor(codex-pet): 拆出 runner-util（纯移动）`。

### Task 1.3: runner-lease.ts

- [x] **Step 1:** Create `codex-pet-runner/runner-lease.ts`，移动：`claimRunLease`（:766-818）、`checkCancelled`（:820-833）、`currentRun`（:568-574）、`emit`（:533-566，注意硬约束 2）、`stage`（:835-876）、`resumeStageIfRepairing`（:884-935）。
- [x] **Step 2-5:** 同 Task 1.2 的导入更新 / typecheck / 合同测试 / Commit `refactor(codex-pet): 拆出 runner-lease（纯移动）`。

### Task 1.4: runner-billing.ts

- [x] **Step 1:** Create `codex-pet-runner/runner-billing.ts`，移动：`recordImageGenerationAttempt`（:576-643）、`prepareImageGenerationDispatch / completeImageGenerationAttempt`（:645-682）、`consumeImageGenerationApproval`（:684-704）、`pauseForImageApproval`（:706-751）、`refundRun`（:3296-3332）、`settlePerImageRunBilling / settlePerImageBilling / recordPerImageSettlementFailure`（:3334-3410，refundRun→settlePerImageBilling 同文件互调）。
- [x] **Step 2-4:** 导入更新 / typecheck / 合同测试。
- [x] **Step 5:** **runner 集成**（第一个检查点），预期与基线一致。
- [x] **Step 6:** Commit `refactor(codex-pet): 拆出 runner-billing（纯移动）`。

### Task 1.5: runner-jobs.ts

- [x] **Step 1:** Create `codex-pet-runner/runner-jobs.ts`，移动：`ensureJob`（:937-970）、`codexPetMaxBoardAttempts`（:972-987）、`startJob / failJobAttempt`（:989-1042）、`persistProviderMetadata / markImageSucceeded`（:1044-1088）、`putJsonArtifact / loadArtifactsInOrder`（:1090-1150）。
- [x] **Step 2-5:** 导入更新（门面 re-export `codexPetMaxBoardAttempts`）/ typecheck / 合同测试 / Commit `refactor(codex-pet): 拆出 runner-jobs（纯移动）`。

### Task 1.6: runner-provenance.ts

- [x] **Step 1:** Create `codex-pet-runner/runner-provenance.ts`，移动：`REQUIRED_VISUAL_JOB_KEYS / VisualQaProvenanceSummary / assertCodexPetVisualQaProvenance / summarizeRequiredVisualJobProvenance`（:3221-3294）、`summarizeProviderUsage`（:3198-3219）、`FINAL_REPAIR_ROWS / FinalRepairRow / repairRowsFromFinalQa`（:421-443）。
- [x] **Step 2-5:** 导入更新（门面 re-export `assertCodexPetVisualQaProvenance`）/ typecheck / 合同测试 / Commit `refactor(codex-pet): 拆出 runner-provenance（纯移动）`。

### Task 1.7: runner-board-job.ts（核心生成循环）

- [x] **Step 1:** Create `codex-pet-runner/runner-board-job.ts`，移动：`poseBoardRepairPrompt`（:328-354）、`codexPetShouldAttachFailedBoardForRepair / codexPetRepairGenerationReferences`（:361-372）、`jumpingQaEvidence / isJumpingScaleEvidenceConflict`（:374-409）、`visualQaPasses`（:493-531 组内）、`completedBoardJob`（:1592-1626）、`BoardJobInputBinding / codexPetBoardInputRevision / boardJobInputPayload / boardOutputArtifactIds`（:1628-1679）、`bindBoardJobInput`（:1691-1787）、`runBoardJob`（:1854-2297）。
- [x] **Step 2-5:** 导入更新（门面 re-export `codexPetShouldAttachFailedBoardForRepair / codexPetRepairGenerationReferences / codexPetBoardInputRevision`——`codex-pet-board-version.test.ts` 与 `codex-pet-generated-board-recovery.ts` 依赖）/ typecheck / 合同测试 / Commit `refactor(codex-pet): 拆出 runner-board-job（纯移动）`。

### Task 1.8: runner-base.ts

- [x] **Step 1:** Create `codex-pet-runner/runner-base.ts`，移动：`reuseGptContinuationBaseCandidate`（:1152-1227）、`generateBaseCandidate`（:1229-1299）、`selectBaseAutomatically / ensurePersistedBaseSelection`（:1301-1401）、`getIdentityGuide`（:1403-1590，注意 :1578 对 `CodexPetModelContractError` 的提前重抛保持原样）。
- [x] **Step 2-4:** 导入更新 / typecheck / 合同测试。
- [x] **Step 5:** **runner 集成**（第二个检查点）。
- [x] **Step 6:** Commit `refactor(codex-pet): 拆出 runner-base（纯移动）`。

### Task 1.9: runner-standard-rows.ts

- [x] **Step 1:** Create `codex-pet-runner/runner-standard-rows.ts`，移动：`runStandardRow`（:2494-2626）、`deriveRunningLeft`（:2299-2422，硬约束 3）、`storeStandardAtlas`（:2628-2669）。
- [x] **Step 2-5:** 导入更新 / typecheck / 合同测试 / Commit `refactor(codex-pet): 拆出 runner-standard-rows（纯移动）`。

### Task 1.10: runner-direction.ts

- [x] **Step 1:** Create `codex-pet-runner/runner-direction.ts`，移动：`createApprovedCardinalAnchor`（:1793-1852）、`lookRowReferences`（:2437-2484）、`appendCumulativeRepairRequirement`（:2486-2492）、`getLookMechanics`（:2671-2711）、`recoveredRegistrationDiagnostics / registeredSourceBoardSize`（:2713-2735）、`completedRegisteredDirectionRow`（:2737-2797）、`registerDirectionRow`（:2804-3011）、`requireApprovedRegisteredRow`（:3013-3020）、`reviewFirstLookRow / reviewSecondLookRow`（:3022-3196）。
  **注意**：三份 look 修复循环（:4232-4283 / :4337-4379 / :4421-4504）**不在本任务范围**——它们是 `executeRun` 的内联代码，纯移动阶段留在原地，阶段 2 处理。
- [x] **Step 2-5:** 导入更新 / typecheck / 合同测试 / Commit `refactor(codex-pet): 拆出 runner-direction（纯移动）`。

### Task 1.11: runner-finalize.ts

- [x] **Step 1:** Create `codex-pet-runner/runner-finalize.ts`，移动：`finalizeClaimedSetupFailure`（:3419-3485）、`finalizeFailure`（:3487-3564）、`finalizeCancellation`（:3566-3621）。`finalizeFailure→finalizeCancellation` 互调，必须同文件。
- [x] **Step 2-5:** 导入更新 / typecheck / 合同测试 / Commit `refactor(codex-pet): 拆出 runner-finalize（纯移动）`。

### Task 1.12: runner-archive.ts + runner-packaging-resume.ts

- [x] **Step 1:** Create `codex-pet-runner/runner-archive.ts`，移动：`TERMINAL_ARCHIVE_ERROR_CODES / terminalArchiveError / archiveErrorCode`（:3623-3643）、`withCurrentKnowledgeArchiveLease`（:3653-3672）、`transitionKnowledgeArchiveJob / ensureKnowledgeArchiveJob / reconcileKnowledgeArchiveJob`（:3674-3798）、`runKnowledgeArchiveAttempt`（:3807-3891）、`completeKnowledgeArchive`（:3893-3917）、`releaseDeferredArchiveLease`（:3919-3938 组内）。
- [x] **Step 2:** Create `codex-pet-runner/runner-packaging-resume.ts`，移动：`releaseDeferredPackagingLease`（:3942-3960）、`deferRecoveryPackaging`（:3963-3994）、`continueAfterDurablePackaging / resumeDurablePackaging`（:3996-4030）。
- [x] **Step 3-5:** 导入更新 / typecheck / 合同测试 / Commit `refactor(codex-pet): 拆出 runner-archive 与 runner-packaging-resume（纯移动）`。

### Task 1.13: 门面收尾与全量验证

- [x] **Step 1:** 确认 `codex-pet-runner.ts` 只剩：`WORKER_ID`、`executeRun`（:4032-4822，含 regenerateDirectionRows 闭包与两个内联 look 修复循环）、`executeCodexPetRun`（:4824-5115）、全部 re-export。`ctx.identity.canonicalGuide` 在 :4111 的原地赋值（RunnerContext 名义 readonly）保持原样。
- [x] **Step 2:** `git diff --stat` 核对：6 个外部导入方源文件 + 5 个外部测试文件零改动。
- [x] **Step 3:** typecheck + **codex-pet 全量**，预期与基线一致（221 通过 8 跳过）。
- [x] **Step 4:** `wc -l apps/api/src/workflow/codex-pet-runner.ts` 记录收尾行数（预期从 5115 降到 ~1400）。
- [x] **Step 5:** Commit `refactor(codex-pet): 完成 runner 纯移动拆分`

---

## 阶段 2：executeRun 解耦与去重（行为敏感，约 3-5 天）

**这一阶段不再是纯移动**，每一步都必须先让 runner 集成测试驱动到相关分支再动手。integration harness 的 `visual.qa` 可配置「先 fail 后 pass」序列来驱动修复循环（见 `codex-pet-runner.integration.test.ts:310-363` 的 `runnerDeps()`）。

### Task 2.1: 收敛方向行共享状态为 DirectionRowState

`executeRun` 的方向行段落持有 8 个共享可变局部变量，`regenerateDirectionRows` 闭包读写其中全部——这是三份拷贝无法去重的根因。实测这 8 个是：`lookA`(:554) `lookB`(:657) `registeredLookA`(:578) `registeredLookB`(:682) `firstLookGate`(:584) `secondLookGate`(:689) `registeredLookAReference`(:644) `lookBScreenLeftTrajectoryReference`(:645)。

**Files:** Modify `apps/api/src/workflow/codex-pet/codex-pet-runner.ts`（executeRun 内 :554-858；本文件原写的 :4110-4700 是 P2.1 拆分前的行号，已作废）；`codex-pet/codex-pet-runner/runner-types.ts`

- [x] **Step 1:** 在 runner-types.ts 定义（字段类型全部取自既有函数返回值，不新造类型）：
  ```ts
  export interface DirectionRowState {
    lookA: BoardJobResult
    lookB: BoardJobResult | null
    registeredLookA: RegisteredDirectionRowResult | null
    registeredLookB: RegisteredDirectionRowResult | null
    firstLookGate: Awaited<ReturnType<typeof reviewFirstLookRow>> | null
    secondLookGate: Awaited<ReturnType<typeof reviewSecondLookRow>> | null
    registeredLookAReference: ReturnType<typeof composeLookSourceBoardReference> | null
    lookBScreenLeftTrajectoryReference: ReturnType<typeof composeLookBScreenLeftTrajectoryReference> | null
  }
  ```
  （`ReturnType<typeof ...>` 若因函数在别的模块不便引用，就把这两个 compose 函数的返回类型名字化后引用。）
- [x] **Step 2:** executeRun 内把这 8 个 `let` 变量替换为一个 `const dir: DirectionRowState` 对象的字段读写（`lookA` 等首次赋值处初始化）。只做机械替换 `lookA` → `dir.lookA`，不改任何控制流。
- [x] **Step 3:** typecheck；**runner 集成**，预期与基线一致。
- [x] **Step 4:** Commit `refactor(codex-pet): 方向行共享状态收敛为 DirectionRowState`

**执行记录（2026-08-26，提交 `1d284db`）**

落地形状与计划不同，收敛成了**两个**类型而不是一个扁平的 8 字段 `DirectionRowState`：

```ts
export interface LookRowState<TGate> { row: BoardJobResult; registered: RegisteredDirectionRowResult; gate: TGate }
export interface LookBReferenceState { registeredLookAReference: Buffer; lookBScreenLeftTrajectoryReference: Buffer }
```

理由：8 个 `let` 天然是「每行 3 个（产物 / 注册结果 / 门禁）× 2 行 + 2 张派生参考图」。按行分组后 Task 2.2 的修复函数只需要收一个 `state` 参数，而不是把整段方向行状态整体交出去；`TGate` 泛型还让两行各自保留自己的门禁类型（`FirstLookRowGate` / `SecondLookRowGate`，同批在 runner-direction.ts 命名），不必退化成联合类型再在循环里收窄。字段也因此都是非 null 的——首次赋值就在声明处，不存在计划里那批 `| null`。

### Task 2.2: 三份 look 修复循环统一为 repairLookARow / repairLookBRow

三份拷贝的差异空间在 2026-08-25 用「只抹行别、保留一切字面量与进度数字」的归一化 diff 穷举过一遍（4 个循环体两两对比），结果是**两条正交轴的乘积**：行别轴（look-a / look-b）在两个阶段下逐字节一致，阶段轴（前置门禁 / 校验期重建）在两个行别下逐字节一致。所以「按行别拆两个函数 + 按阶段传 options」这个分法是成立的。

真实位置（P2.1 拆分后，本文件里的 4xxx 行号全部作废）：副本 1 `codex-pet-runner.ts:586-637`、副本 2 `:691-733`、副本 3 `:775-858`（内含 look-a `:782-810` 与 look-b `:824-855` 两个 `for(;;)`）。

计划原先只列了四类差异，**实际有 9 项阶段轴差异，其中 5 项在表外**（下表标 ★）。按本文件末尾的执行约束，表外差异先补进表格，不顺手"修复"。

**阶段轴（→ `LookRepairOptions`，两个行别完全共用）**

| # | 差异维度 | 副本 1/2（内联·前置门禁） | 副本 3（regenerateDirectionRows·校验期） | 收敛方式 |
| --- | --- | --- | --- | --- |
| 1 ★ | **循环形状** | `while (!gate.pass)`：先判后生成 | `for(;;)`：先生成后判 —— 进入时门禁通常**是 pass 的**（下游判决才强制重建），`while` 形状根本进不去循环 | `forceFirstRound: boolean`，计划原 options 缺这一档 |
| 2 | 额度耗尽行为 | 审批门开启（`ctx.perImageBilling \|\| CODEX_PET_IMAGE_APPROVAL_GATE !== "0"`）抛 `CodexPetImageApprovalRequiredError`，否则普通 Error | 只抛普通 Error | `budgetExhausted: "approval-gate" \| "plain-error"` |
| 3 | diagnosticBoard 附带时机 | 首次生成不带，修复迭代才带 | 从第一轮就带 | **不需要参数**：副本 1 的「首次生成」在循环**外**（`:554`/`:657`），循环内每一轮都带 `dir.lookX.board`；抽取边界只包住循环体后这项自动消失，计划原 `attachDiagnosticFromStart` 应删掉 |
| 4 | progress | 74 / 注册 73（A）、78 / 78（B） | 两行都 84 / 84 | `progress` + `registerProgress` |
| 5 | workflowStage | 默认（`direction_generating`） | `"validating"` | `workflowStage?: "validating"` |
| 6 | emit `run.repairing` | 循环内 emit（`attempt` / `retryKind:"visual"` / `failures`） | 不 emit（调用点先行 emit） | `emitRepairing: boolean` |
| 7 ★ | 累积修复要求数组生存期 | 循环外声明一次，整段修复共享 | 每次 `regenerateDirectionRows` 调用重建 | **不需要参数**：数组挪进函数内部后两者语义都保持（副本 1 的整个 while 段落 = 一次函数调用） |
| 8 ★ | 首轮 hint 来源 | `gate.repairPrompt \|\| failures \|\| 兜底语` | 调用方传入的 `repairHint \|\| "Rebuild both coherent look rows…"` | `initialHint?: string` |
| 8b ★ | 门禁兜底修复语 | A `"Keep the complete 000 through 157.5 row on one monotonic clockwise screen-right arc."` / B `…180 through 337.5…screen-left arc.` | A `"Keep row A monotonic across the top-to-bottom row boundary between chronological cells 4 and 5."` / B `…row B…and both row seams.` | `gateFallbackHint: string` —— 同一行别的两个阶段是两句**不同**英文，不是笔误 |
| 9 ★ | `requireApprovedRegisteredRow` 标签 | `"第一组观察方向"` / `"第二组观察方向"` | `"修复后的第一组…"` / `"修复后的第二组…"` | **不需要参数**：这行留在调用点，不进函数 |

**行别轴（→ `repairLookARow` / `repairLookBRow` 的天然分界，不参数化；两个阶段下完全一致）**

| 维度 | look-a | look-b |
| --- | --- | --- |
| `dependencies` | `["look-cardinals"]` | `["look-a-registration"]` |
| `inputArtifactIds` | selected / cardinalAnchor / standard.contact | 追加 `registeredLookA.registeredRowArtifact.id` + `.manifestArtifact.id` |
| `references` | `anchorStoryboard: lookAAnchorStoryboard` | anchor 换 B，追加 `directionArcGuide: lookBScreenLeftTrajectoryReference` + `registeredLookA: registeredLookAReference` |
| `registerDirectionRow` | 无额外参数 | 追加 `lockedRow9: registeredLookA` |
| 门禁函数 | `reviewFirstLookRow` | `reviewSecondLookRow`（多传 `previousLook: registeredLookA`） |
| `prompt` / `animationDurations` / `qaContext` / 失败文案 | `"look-a"`、000–157.5 | `"look-b"`、180–337.5 |

**两处查证为「像差异但不是差异」的点（都关于 attempt 预算，结论：不需处理）**

- `force: true` **不**重置 attempt。只有 `bindBoardJobInput` 检测到 `inputRevision` 或有序 `inputArtifactIds` 变化才 `attempt: 0`（`runner-board-job.ts:484-499`）。而副本 1 与副本 3 的 `prompt` / `inputArtifactIds` / `columns` / `rows` / `frameCount` / `frameOrder` / `promptVersion` 在归一化 diff 里**一行都没出现**，即 revision 相同 —— 两个阶段共享同一份 attempt 预算，不存在「换个阶段就白送两次重试」。
- 副本 3 的「先生成后判」在 attempt 已耗尽时**不会多打一次 provider**：`runBoardJob` 的 `for (attempt = firstAttempt; attempt <= job.maxAttempts; …)` 在 `firstAttempt = job.attempt + 1 > maxAttempts` 时循环体一次都不执行（连 `startJob` 都到不了），直接落到末尾 `throw new Error(lastError || \`${qaContext} failed\`)`。唯一后果是**错误消息不同**：副本 1 抛构造好的中文门禁消息（审批门开启时还是审批异常），副本 3 在这个边缘情况抛通用的 `修复方向 000 到 157.5 的完整连续动作组 failed`。属既有行为，原样保留。

**Files:** Create `apps/api/src/workflow/codex-pet/codex-pet-runner/runner-look-repair.ts`；Modify `codex-pet/codex-pet-runner.ts`

- [x] **Step 1:** 先在 runner 集成测试里确认现有修复分支用例可跑（「行10配准修复」用例）并新增一个驱动 look-a 修复循环的用例：`visual.qa` 对 look-a 第一次返回 fail verdict（带 repairPrompt）、第二次 pass，断言 run 最终 ready 且 `codexPetEvent` 中存在 `run.repairing` 事件、`CodexPetJob` 中 look-a 的 attempt=2。跑之，PASS 后作为去重的行为锚。
- [x] **Step 2:** 在 runner-look-repair.ts 实现（options 按上表修订：删 `attachDiagnosticFromStart`，加 `forceFirstRound` / `initialHint` / `gateFallbackHint`）：
  ```ts
  export interface LookRepairOptions {
    progress: number                 // runBoardJob 与 emit 用的进度
    registerProgress: number         // registerDirectionRow 用的进度
    workflowStage?: "validating"     // 副本 3 专用
    forceFirstRound: boolean         // 差异 1：true = 先生成后判（副本 3）
    initialHint?: string             // 差异 8：forceFirstRound 时的首轮 hint 来源
    gateFallbackHint: string         // 差异 8b：gate 既无 repairPrompt 又无 failures 时的兜底语
    budgetExhausted: "approval-gate" | "plain-error"
    emitRepairing: boolean
  }
  export async function repairLookARow(ctx: RunnerContext, dir: DirectionRowState, deps: {...副本1 所需的只读入参: selected/cardinalAnchor/standard/lookLayout/lookAAnchorStoryboard/mechanics/neutralDirectionFrame...}, opts: LookRepairOptions): Promise<void>
  export async function repairLookBRow(ctx, dir, deps, opts): Promise<void>  // 行别轴差异见上表
  ```
  循环体逐行取自副本 1/2，`opts` 分支覆盖阶段轴的 6 个真参数；`dir` 上的字段就地更新（与 Task 2.1 后的现状一致）。`requireApprovedRegisteredRow` 与 `resumeStageIfRepairing` 留在调用点（差异 9）。
- [x] **Step 3:** 副本 1 替换为 `repairLookARow(..., { progress: 74, registerProgress: 73, forceFirstRound: false, gateFallbackHint: "Keep the complete 000 through 157.5 row…", budgetExhausted: "approval-gate", emitRepairing: true })`；typecheck + runner 集成（含 Step 1 新用例）。
- [x] **Step 4:** 副本 2 替换为 `repairLookBRow(..., { progress: 78, registerProgress: 78, forceFirstRound: false, gateFallbackHint: "…180 through 337.5…", budgetExhausted: "approval-gate", emitRepairing: true })`；同样验证。
- [x] **Step 5:** `regenerateDirectionRows` 闭包改写为：`repairLookARow(..., { progress: 84, registerProgress: 84, workflowStage: "validating", forceFirstRound: true, initialHint: repairHint, gateFallbackHint: "Keep row A monotonic…", budgetExhausted: "plain-error", emitRepairing: false })` → 重算两个派生参考图 → `repairLookBRow(同型，row B 兜底语)` → `resumeStageIfRepairing(ctx, "validating", 84, …)`。闭包本体移入 runner-look-repair.ts 导出为 `regenerateDirectionRows(ctx, dir, deps)`（deps 需在每个调用点**现场构造**，因为 `repairScopedRows` 会先改写 `cardinals`/`standard`/两个 anchorStoryboard 等再调它）。
- [x] **Step 6:** **codex-pet 全量**，预期基线 + 1 个新用例。
- [x] **Step 7:** Commit `refactor(codex-pet): 三份 look 修复循环统一为 repairLook{A,B}Row`

**执行记录（2026-08-26）**

四段循环体现在只剩 `runner-look-repair.ts` 里的一个 `runLookRepairLoop` 骨架 + 两个行别函数；`codex-pet-runner.ts` 1577 → 1499 行。四处与计划的偏差：

1. **`forceFirstRound: boolean` + `initialHint?: string` 合并为 `initialHint: string | null`。** 这两项本来就是同一个决定（差异 1 与差异 8 描述的是同一条分支），拆成两个字段能配出 `forceFirstRound: true, initialHint: undefined` 这种无意义组合；合并后不可能配错。
2. **新增表外差异 #10 `exhaustedPrefix: string`。** 归一化 diff 只抹了行别，所以没暴露出这条：额度耗尽的报错文案在**两条轴上都变**（`方向 000 到 157.5 未通过 row-10 前置门禁` / `修复后的第一组观察方向未通过前置门禁`），而 `：${failures.join("；") || "方向语义或连续性失败"}` 的尾巴四份逐字一致。顺带记一条既有怪处：副本 1 的 look-a 文案确实写着「row-10 前置门禁」（look-a 是 row-9），原样保留。
3. **`regenerateDirectionRows` 闭包本体没有移入 runner-look-repair.ts**，只有它内含的两个 `for(;;)` 被替换成两次 `repairLook{A,B}Row` 调用。它剩下的部分（两张派生参考图的重算、两个 `requireApprovedRegisteredRow` 标签、`resumeStageIfRepairing`）只有一个调用形状，搬出去要为它造一个 ~11 字段的 deps 对象却换不到任何去重。Step 5 的实质目标（两个 `for(;;)` 消失）已达成。共享的 7 个 deps 字段在闭包内**每次调用现场构造**（`const sharedDeps`），理由与计划一致。
4. **`ApprovedRegisteredDirectionRow` 在 runner-direction.ts 命名。** 原先是 `requireApprovedRegisteredRow` 断言签名里的匿名交叉类型；look-b 的循环搬出 `executeRun` 后要把已批准的 row-9 当参数传，匿名类型过不了函数边界。

Step 1 的行为锚（`retries the row-9 pre-gate before starting the second look row`）比计划写的更严：两次拒绝（attempt=3 而非 2），并钉住累积修复要求逐轮叠加、诊断板只在修复轮出现且首轮不出现、参考图前两张的顺序、`run.repairing` 的 progress/message/payload。行内 row-9 前置门禁此前**零覆盖**（row-10 的与校验期重建的都有），这条补的就是它。

**测试：** `npx vitest run codex-pet` = 25 passed | 0 failed | 4 skipped（文件），321 passed | 0 failed | 8 skipped（用例），331.62s。基线 320 + 新增 1。typecheck 与 biome lint 全绿。

### Task 2.3: lease CAS 样板收敛（只收形状 A）

全文 33 处 CAS 中，谓词形状有 5 种变体。**只收敛最常见的形状 A**（run 表 `workerId + status ∈ ACTIVE + cancelRequested: false`，count!==1 → LeaseLost，约 12 处：:613-627、:711-731、:839-874 内、:1065-1078、:1708-1719、:4068-4069、:4073-4078、:4085-4104 内的 run 部分等）与**形状 B**（job 表 ownership CAS → LeaseLost，约 6 处：:1047-1051、:1382-1400、:1481-1502、:1542-1571、:2892-2911、:2967-2987）。`claimRunLease`、finalize 三兄弟的「放弃迁移」变体、`withCurrentKnowledgeArchiveLease` 的 raw FOR UPDATE、含审批额度/计费谓词的特殊形状**全部不动**。

**Files:** Modify `codex-pet-runner/runner-lease.ts`（新增 2 个 helper）+ 各调用文件

- [x] **Step 1:** 在 runner-lease.ts 新增（where 形状逐字照抄现有 `stage` :839-874 与 `persistProviderMetadata` :1047-1051 的谓词，包括事务句柄参数化——先读这两处确定 `tx` 的类型别名）：
  ```ts
  export async function updateOwnedActiveRun(tx, ctx: RunnerContext, data, extraWhere = {}): Promise<void> {
    const res = await tx.codexPetRun.updateMany({
      where: { id: ctx.runId, workerId: ctx.workerId, status: { in: CODEX_PET_ACTIVE_STATUSES }, cancelRequested: false, ...extraWhere },
      data,
    })
    if (res.count !== 1) throw new CodexPetLeaseLostError(ctx.runId)
  }
  export async function updateOwnedJob(tx, ctx, jobId: string, data, extraWhere = {}): Promise<void> { /* 同型，codexPetJob + ownership 列 */ }
  ```
- [x] **Step 2:** 逐处替换形状 A（一次 2-3 处一提交），每批后 typecheck + 合同测试；全部完成后 runner 集成。
- [x] **Step 3:** Commit（分批）`refactor(codex-pet): lease CAS 形状A/B 收敛为 updateOwnedActiveRun/updateOwnedJob`

**执行记录（2026-08-26）**

三次提交：`090e823`（helper + 形状 A 4 处）、`1e21f99`（形状 B runner-jobs / runner-direction 4 处）、`c47c556`（形状 B runner-base / runner-archive 5 处）。形状 A 收敛 4 处、形状 B 收敛 9 处，共 13 处。

计划里的 `:xxx` 行号全部是 P2.1 拆分前那份 5115 行 `codex-pet-runner.ts` 的偏移，本次先逐处重新定位到拆分后的模块再动。重新定位后与计划的预估有出入，出入本身就是结论：

| 计划预估 | 实际 | 原因 |
| --- | --- | --- |
| 形状 A 约 12 处 | 只有 4 处能逐字合一 | 计划把「run 表 + count 判定」都算作形状 A，但谓词与失败分支实测有 4 种变体（见下） |
| 形状 B 约 6 处 | 9 处 | 计划漏了 runner-base 的 3 处与 runner-archive 的 2 处 |
| 两个 helper 都带 `extraWhere` | 只有 `updateOwnedJob` 带 | 形状 A 的 4 处调用点谓词完全相同，没有一处需要 `extraWhere`；留着一个永远传不到的可选参数只会招来误用 |
| `CodexPetLeaseLostError(ctx.runId)` | `CodexPetLeaseLostError()` | 现有构造函数不收参数，全文 30 余处也都是无参调用 |

**被判定「不是形状 A」而保留原样的 run CAS（逐字比对过，不顺手改）：**

- `runner-jobs.ts` `markImageSucceeded`：count 不中时会重查一次再决定抛 Cancelled 还是 LeaseLost，用不了只会抛 LeaseLost 的 helper。
- `runner-billing.ts` `consumeImageGenerationApproval`：谓词含 `imageGenerationApprovalBudget: { gt: 0 }`，抛的是 `CodexPetImageApprovalRequiredError`。
- `runner-billing.ts` `settlePerImageRunBilling` 与 `refundRun` 的台账写入：带计费谓词，且失败是有条件抛。
- `codex-pet-runner.ts` 主形象选择的 3 处（`selectedBaseArtifactId` / `awaiting_base_review` / 选择提交）与 `colorKeyClaim`：**根本没有 `status: { in: ACTIVE }` 谓词**，套进 `updateOwnedActiveRun` 等于收紧 CAS，属于行为变更。`colorKeyClaim` 还在 `ctx` 构造之前，只有 `run` / `workerId` 局部量，签名上就传不进去。这 4 处是后续「要不要补 status 谓词」的独立议题，本次只登记不动。
- `runner-archive.ts` / `runner-packaging-resume.ts` 的 `status: "archiving"` / `"packaging"` 字面量谓词、finalize 三兄弟的「不中就返回 `transitioned: false`」、`emit` 里没有 count 判定的那处、`claimRunLease`、`leaseHeartbeat`（fire-and-forget 且按计费模式变形）：与计划的排除清单一致。

**`stage` 的两处等价变更（已写在代码注释里）：** 谓词多了 `projectId` / `userId`——同一次调用里 `checkCancelled` 已按这两列查过同一行，不匹配时它会先抛 Cancelled，判定结果不变；CAS 不中改为在事务内抛 LeaseLost，而此刻事务里还没有任何写入（项目行更新在其后且受 `advanced` 约束），回滚与空提交等价，错误类型也一样。`!current` 分支仍走原来的 `transition.claimed` 外抛路径。

**`updateOwnedJob` 基础谓词不含 `workerId`：** runner-base.ts 手工选择补记那处故意不锁 worker（选择由路由提交，job.workerId 可能已是 null），基础谓词若带上 workerId 就会把手工选择打死。需要锁 worker 或锁状态的 7 处自己用 `extraWhere` 加。

**验证：** `tsc --noEmit` 干净；改动的 7 个文件 `biome lint` 干净；每批后 `codex-pet-runner-contract.test.ts` 21 passed / 0 failed / 0 skipped；末批加 `codex-pet-archive.test.ts` 共 33 passed / 0 failed / 0 skipped；全量 `npx vitest run codex-pet` = 25 passed | 0 failed | 4 skipped（文件），321 passed | 0 failed | 8 skipped（用例），324.28s —— 与 Task 2.2 收尾时的基线逐个数字一致。

### Task 2.4（可选）: catch 链表驱动

`executeCodexPetRun` 的 catch 链（:5044-5109）7 类信号异常逐一分派。**仅当阶段 2 前三个任务全绿后再做**：把每个 `instanceof` 分支的处理体提为命名函数（`handleApprovalRequired/handleArchiveDeferred/...`，放 runner-finalize.ts），catch 链只留分派。不引入注册表抽象（YAGNI——新增暂停类型的频率不支撑）。验证：typecheck + runner 集成（暂停/取消/退款用例是关键路径）。Commit `refactor(codex-pet): catch 链处理体命名化`。

**执行记录（2026-08-26）**

catch 链在拆分后位于 `codex-pet-runner.ts:1426-1499`（计划里的 `:5044-5109` 是 P2.1 拆分前的偏移）。7 个处理体全部提入 `runner-finalize.ts`：`handleImageApprovalRequired` / `handleImageCallLedgerPause` / `handlePackagingDeferred` / `handleArchiveDeferred` / `handleLeaseLost` / `handleCancelled` / `handleUnexpectedFailure`。catch 链从 66 行缩到 22 行，只剩 `instanceof` 判定 + `return await handleXxx(...)`。未引入注册表，与计划一致。

三处需要说明的判断：

- **handler 只收 `ctx`，不收 `run`/`deps`。** 原处理体读 `run.id / run.project.id / run.userId`，换成 `ctx.runId / ctx.project.id / ctx.project.userId`。等价性由领取租约前的归属断言保证（`codex-pet-runner.ts` 里 `initialRun.project.id !== initialRun.projectId || initialRun.project.userId !== initialRun.userId` 直接抛错），走到 catch 链时这三列必然同源。理由写进了代码注释。
- **四处重复重读合一为 `readOwnedRunOutcome`。** 原来带三种 `select` 形状（`{status,cancelRequested}` / `{status}` / `{cancelRequested,status}`），统一取超集两列——多读一列不改变任何分支判定。
- **`controller.signal.reason instanceof ...` 留在 catch 链里。** 它属于*分派谓词*而不是处理体；且 `controller` 是 `executeCodexPetRun` 的局部量，搬进 handler 就得多传一个参数换不来任何收益。
- **`handleUnexpectedFailure` 声明为返回 `CodexPetExecutionResult`，但只有取消竞态那条路径真的返回**，其余情况 `finalizeFailure` 之后原样重抛（`throw error`，同一个 error 实例）。调用方 `return await`，语义与合一前逐字一致。

顺带清掉了 `codex-pet-runner.ts` 因此空出的 5 个导入符号（`releaseDeferredPackagingLease` / `releaseDeferredArchiveLease` / `finalizeCancellation` / `finalizeFailure` / 整个 `runner-billing.js` 导入块只剩的 `pauseForImageApproval`）——这些调用点现在都在 runner-finalize.ts 内部。`runner-finalize.ts` 反向新增了对 `runner-archive.js` / `runner-packaging-resume.js` / `runner-billing.js` 的导入，无环：这三者都不导入 runner-finalize，而 runner-finalize 全仓只有 `codex-pet-runner.ts` 一个导入方。

**验证：** `tsc --noEmit` 干净；两个改动文件 `biome lint` 干净；`codex-pet-runner-contract.test.ts` + `codex-pet-archive.test.ts` 共 33 passed / 0 failed / 0 skipped；全量 `npx vitest run codex-pet` = 25 passed | 0 failed | 4 skipped（文件），321 passed | 0 failed | 8 skipped（用例），341.27s —— 与 Task 2.2 / 2.3 的基线逐个数字一致。

---

## 阶段 3：加厚 packages/llm 并收敛复刻（约 2-3 天）

目标：消灭 CHATGPT_MODELS 三处解析、codex-pet-visual 复刻的 bailian 凭据解析与自研重试循环。**不做**统一 usage 记账 / 结构化输出封装（等新框架选型时一并定，避免现在设计错 API）。

### Task 3.1: packages/llm 新增 routes.ts（严格路由解析，TDD）

**Files:** Create `packages/llm/src/routes.ts`、`packages/llm/src/__tests__/routes.test.ts`；Modify `packages/llm/src/client.ts`（导出 `CHATGPT_DEFAULT_BASE_URL`）、`packages/llm/src/index.ts`

- [x] **Step 1: 写失败测试**（模式照抄 `client.test.ts` 的纯函数直测：手工构造 `{...} as NodeJS.ProcessEnv`）：
  ```ts
  import { describe, expect, it } from "vitest"
  import { parseChatgptModelList, resolveChatgptCredentials, resolveBailianCredentials, LlmRouteError } from "../routes.js"

  describe("parseChatgptModelList", () => {
    it("解析 env 列表并去空白", () => {
      expect(parseChatgptModelList({ CHATGPT_MODELS: " gpt-5.6-sol , gpt-5.5 ,, " } as NodeJS.ProcessEnv)).toEqual(["gpt-5.6-sol", "gpt-5.5"])
    })
    it("未配置时回退内置名单", () => {
      expect(parseChatgptModelList({} as NodeJS.ProcessEnv)).toContain("gpt-5.6-sol")
    })
  })
  describe("resolveChatgptCredentials", () => {
    it("CHATGPT_API_KEY 优先，缺省 baseURL 用默认端点", () => {
      expect(resolveChatgptCredentials({ CHATGPT_API_KEY: "k1", GPT_IMAGE_API_KEY: "k2" } as NodeJS.ProcessEnv))
        .toEqual({ baseURL: "https://api.ai-pixel.online", apiKey: "k1" })
    })
    it("两个 key 都缺时抛 LlmRouteError", () => {
      expect(() => resolveChatgptCredentials({} as NodeJS.ProcessEnv)).toThrow(LlmRouteError)
    })
  })
  describe("resolveBailianCredentials", () => {
    it("BAILIAN_BASE_URL 缺省时由 workspace 拼接", () => {
      expect(resolveBailianCredentials({ BAILIAN_API_KEY: "bk", BAILIAN_WORKSPACE_ID: "ws1" } as NodeJS.ProcessEnv))
        .toEqual({ baseURL: "https://ws1.cn-beijing.maas.aliyuncs.com/apps/anthropic", apiKey: "bk" })
    })
    it("key 缺失抛 LlmRouteError", () => {
      expect(() => resolveBailianCredentials({ BAILIAN_WORKSPACE_ID: "ws1" } as NodeJS.ProcessEnv)).toThrow(LlmRouteError)
    })
  })
  ```
  运行：`cd "/Users/z/code/ai project/packages/llm" && pnpm exec vitest run src/__tests__/routes.test.ts`，预期 FAIL（模块不存在）。
- [x] **Step 2: 实现 routes.ts**（语义逐条对齐三处现存解析——`client.ts:66-76`、`codex-pet-model-contract.ts:70-77`、`codex-pet-visual.ts:86-118`）：
  ```ts
  import { CHATGPT_MODELS, CHATGPT_DEFAULT_BASE_URL, buildBailianBaseURL } from "./client.js"

  export class LlmRouteError extends Error {}
  export interface LlmRouteCredentials { readonly baseURL: string; readonly apiKey: string }

  export function parseChatgptModelList(env: NodeJS.ProcessEnv = process.env): readonly string[] {
    const configured = env.CHATGPT_MODELS?.split(",").map((m) => m.trim()).filter(Boolean)
    return configured && configured.length > 0 ? configured : CHATGPT_MODELS
  }
  export function resolveChatgptCredentials(env: NodeJS.ProcessEnv = process.env): LlmRouteCredentials {
    const apiKey = env.CHATGPT_API_KEY?.trim() || env.GPT_IMAGE_API_KEY?.trim()
    if (!apiKey) throw new LlmRouteError("缺少 CHATGPT_API_KEY / GPT_IMAGE_API_KEY")
    return { baseURL: env.CHATGPT_BASE_URL?.trim() || CHATGPT_DEFAULT_BASE_URL, apiKey }
  }
  export function resolveBailianCredentials(env: NodeJS.ProcessEnv = process.env): LlmRouteCredentials {
    const apiKey = env.BAILIAN_API_KEY?.trim() || env.DASHSCOPE_API_KEY?.trim()
    if (!apiKey) throw new LlmRouteError("缺少 BAILIAN_API_KEY / DASHSCOPE_API_KEY")
    const workspaceId = env.BAILIAN_WORKSPACE_ID?.trim()
    const baseURL = env.BAILIAN_BASE_URL?.trim() || (workspaceId ? buildBailianBaseURL(workspaceId, env.BAILIAN_REGION?.trim() || "cn-beijing") : undefined)
    if (!baseURL) throw new LlmRouteError("缺少 BAILIAN_BASE_URL / BAILIAN_WORKSPACE_ID")
    return { baseURL, apiKey }
  }
  ```
  client.ts 将 `CHATGPT_DEFAULT_BASE_URL` 改为导出；`loadModelRoutes`（client.ts:66-76）改用 `parseChatgptModelList` + `try { resolveChatgptCredentials } catch { return [] }`（保留“无 key 静默返回空路由表”的现状语义）。index.ts 增加 `export { parseChatgptModelList, resolveChatgptCredentials, resolveBailianCredentials, LlmRouteError } from "./routes.js"`。
- [x] **Step 3:** 跑 routes.test.ts 预期 PASS；跑 `pnpm exec vitest run`（llm 包全量，含 client.test.ts 的 fetch 桩路由用例）预期全绿。
- [x] **Step 4:** Commit `feat(llm): 严格路由解析 routes.ts（收敛三处复刻的前置）`

**执行记录（2026-08-27）**

新增 `packages/llm/src/routes.ts` + `src/__tests__/routes.test.ts`（12 个用例），`client.ts` 的 `loadModelRoutes` 改走新解析，`index.ts` 增加导出。三处复刻中的第一处（`client.ts:66-76`）已消除，另两处（`codex-pet-model-contract.ts:70-77`、`codex-pet-visual.ts:86-118`）按计划留给 Task 3.3。

与计划 sketch 的六处偏差，都是先读现存实现再定的：

| 计划 sketch | 实际 | 原因 |
| --- | --- | --- |
| routes.ts 从 client.ts 导入 `CHATGPT_MODELS` / `CHATGPT_DEFAULT_BASE_URL` / `buildBailianBaseURL` | 这三个符号搬到 routes.ts，client.ts re-export | sketch 的方向会形成 client ↔ routes 双向模块环（`loadModelRoutes` 必须用 routes 的解析函数）。搬迁后依赖只剩 client → routes 一条边，公开 API 与 `index.ts` 导出面不变，`client.test.ts` 的 import 路径也不用改 |
| `LlmRouteError extends Error`，Task 3.3 用 `CodexPetModelContractError(e.message)` 透传 | `LlmRouteError` 带 `code`（3 个字面量），消息文本仍留在调用方 | 透传会改掉 4 条运维可见消息：丢掉 `${model}` 前缀与「for the Codex pet workflow」后缀，而 `codex-pet-visual.test.ts:305` 正断言 `"CHATGPT_API_KEY or GPT_IMAGE_API_KEY"` 这个短语。靠 code 映射，Task 3.3 能逐字保留原消息 |
| `resolveBailianCredentials` 先查 key 再查端点 | 先查端点再查 key | `loadLlmConfig` 的 bailian 分支与 `loadCodexPetVisualQaRoute` 两处现存实现都是端点先判定；两者全缺时报的是端点错误，顺序反了会改变错误消息 |
| region 用 `env.BAILIAN_REGION?.trim() \|\| "cn-beijing"` | 用 `env.BAILIAN_REGION ?? "cn-beijing"` | 两处现存实现都是 `??`。显式配成空串时要继续落到 `buildBailianBaseURL` 抛的普通 `Error("BAILIAN_REGION is required")`——那是配置写错，不能被吞成 `LlmRouteError` 让调用方当成「没启用该路由」 |
| `try { resolveChatgptCredentials } catch { return [] }` | `catch (error) { if (error instanceof LlmRouteError) return []; throw error }` | 裸 `catch {}` 比现状更宽：现在只有缺 key 会返回空表，region 配错这类异常必须继续冒泡 |
| （未提） | `loadLlmConfig` 的 bailian 分支**不迁** | 它多一个 `LLM_BASE_URL` 回退、workspace 不 trim、消息带「when LLM_PROVIDER=bailian」，与 `resolveBailianCredentials` 不等价，不在本任务范围 |

测试除计划给的 6 个用例外补了 6 个，钉住这些判定：空白 key 回退、`CHATGPT_BASE_URL` 覆盖 + 去空白、`CHATGPT_MODELS` 全空项回退内置名单、显式 `BAILIAN_BASE_URL` 优先、端点与 key 都缺时的先后顺序、空白 workspace 等同未配、显式空 region 抛普通 Error 而非 `LlmRouteError`。

**验证：** `pnpm exec tsc --noEmit`（llm 包）与 `npx tsc --noEmit`（apps/api）干净；4 个文件 `biome lint` 干净；llm 包全量 `pnpm exec vitest run` = 文件 2 passed / 0 failed / 2 skipped，用例 24 passed / 0 failed / 5 skipped（跳过的是两个 `.poc.test.ts`，缺凭据时本来就跳）；额外抽查 api 侧 llm 消费方 `codex-pet-visual` / `chat/routes.empty-response` / `agent-workflow-llm` = 文件 3 passed / 0 failed / 0 skipped，用例 32 passed / 0 failed / 0 skipped。

### Task 3.2: packages/llm 新增 retry.ts（通用重试，TDD）

**Files:** Create `packages/llm/src/retry.ts`、`packages/llm/src/__tests__/retry.test.ts`；Modify `packages/llm/src/index.ts`

- [x] **Step 1: 写失败测试**（逻辑源自 `codex-pet-visual.ts:630-640/791-839`，语义必须一致）：
  ```ts
  import { describe, expect, it, vi } from "vitest"
  import { defaultRetryableLlmError, llmRetryDelayMs, withLlmRetry } from "../retry.js"

  describe("defaultRetryableLlmError", () => {
    it("408/409/429/5xx 可重试，400/401 不可", () => {
      expect(defaultRetryableLlmError({ status: 429 })).toBe(true)
      expect(defaultRetryableLlmError({ status: 500 })).toBe(true)
      expect(defaultRetryableLlmError({ status: 400 })).toBe(false)
    })
    it("网络类错误码可重试", () => {
      expect(defaultRetryableLlmError(Object.assign(new Error("boom"), { code: "ECONNRESET" }))).toBe(true)
    })
  })
  describe("llmRetryDelayMs", () => {
    it("3 倍指数退避且封顶", () => {
      expect(llmRetryDelayMs(1, { baseDelayMs: 5_000, capDelayMs: 30_000 })).toBe(5_000)
      expect(llmRetryDelayMs(2, { baseDelayMs: 5_000, capDelayMs: 30_000 })).toBe(15_000)
      expect(llmRetryDelayMs(3, { baseDelayMs: 5_000, capDelayMs: 30_000 })).toBe(30_000)
    })
  })
  describe("withLlmRetry", () => {
    it("可重试错误重试到成功", async () => {
      const fn = vi.fn().mockRejectedValueOnce({ status: 429 }).mockResolvedValueOnce("ok")
      await expect(withLlmRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).resolves.toBe("ok")
      expect(fn).toHaveBeenCalledTimes(2)
    })
    it("不可重试错误直接抛", async () => {
      const fn = vi.fn().mockRejectedValue({ status: 400 })
      await expect(withLlmRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toEqual({ status: 400 })
      expect(fn).toHaveBeenCalledTimes(1)
    })
    it("signal abort 后不再重试", async () => {
      const controller = new AbortController()
      const fn = vi.fn().mockImplementation(() => { controller.abort(); return Promise.reject({ status: 500 }) })
      await expect(withLlmRetry(fn, { maxAttempts: 3, baseDelayMs: 1, signal: controller.signal })).rejects.toEqual({ status: 500 })
      expect(fn).toHaveBeenCalledTimes(1)
    })
  })
  ```
  预期 FAIL。
- [x] **Step 2: 实现 retry.ts**：
  ```ts
  const RETRYABLE_STATUS = new Set([408, 409, 429])
  const RETRYABLE_CODES = new Set(["econnreset", "econnrefused", "enotfound", "eai_again"])

  export function defaultRetryableLlmError(error: unknown): boolean {
    const status = (error as { status?: unknown })?.status
    if (typeof status === "number") return RETRYABLE_STATUS.has(status) || status >= 500
    const name = String((error as { name?: unknown })?.name ?? "").toLowerCase()
    const code = String((error as { code?: unknown })?.code ?? "").toLowerCase()
    return name.includes("connection") || name.includes("timeout") || code.includes("timeout") || RETRYABLE_CODES.has(code)
  }
  export function llmRetryDelayMs(attempt: number, opts: { baseDelayMs?: number; capDelayMs?: number; factor?: number } = {}): number {
    const base = Math.min(opts.capDelayMs ?? 30_000, opts.baseDelayMs ?? 5_000)
    return Math.min(opts.capDelayMs ?? 30_000, base * (opts.factor ?? 3) ** (attempt - 1))
  }
  export function waitCancellable(ms: number, signal?: AbortSignal): Promise<void> { /* 逐字取自 codex-pet-visual.ts:630-640 的 wait */ }
  export interface LlmRetryOptions {
    maxAttempts?: number; baseDelayMs?: number; capDelayMs?: number; factor?: number
    signal?: AbortSignal
    retryable?: (error: unknown) => boolean
  }
  export async function withLlmRetry<T>(fn: (attempt: number) => Promise<T>, opts: LlmRetryOptions = {}): Promise<T> {
    const maxAttempts = Math.max(1, opts.maxAttempts ?? 3)
    const retryable = opts.retryable ?? defaultRetryableLlmError
    for (let attempt = 1; ; attempt += 1) {
      try { return await fn(attempt) } catch (error) {
        if (attempt >= maxAttempts || opts.signal?.aborted || !retryable(error)) throw error
        await waitCancellable(llmRetryDelayMs(attempt, opts), opts.signal)
      }
    }
  }
  ```
  index.ts 补导出。
- [x] **Step 3:** retry.test.ts PASS；llm 包全量 PASS。
- [x] **Step 4:** Commit `feat(llm): 通用 LLM 重试原语 withLlmRetry`

**执行记录（2026-08-27）**

新增 `packages/llm/src/retry.ts` + `src/__tests__/retry.test.ts`（23 个用例），`index.ts` 补 4 个值导出与 2 个类型导出。行为逐字取自 QA 那套（`retryableCodexPetVisualError` :800-812 / `codexPetVisualRetryDelayMs` :814-818 / `wait` :638-648，行号与计划所写有偏移），图片那套（dispatch cooldown、`onRetry` 回调、模型错配直抛）不在原语范围内。本任务只新增原语，`codex-pet-visual.ts` 一行未动。

与计划 sketch 的偏差：

| 计划 sketch | 实际 | 原因 |
| --- | --- | --- |
| `String((error as {name?})?.name ?? "").toLowerCase()` | `typeof record.name === "string" ? ... : ""`，且先 `if (!error \|\| typeof error !== "object") return false` | 逐字对齐现存实现。sketch 少了非对象守卫，`defaultRetryableLlmError("connection reset")` 会因为字符串没有 `.name` 而侥幸返回 false，但 `{ name: 123 }` 这类就走上了 `String(123)` 的岔路 |
| `Math.min(cap, base * factor ** (attempt - 1))` | 保留 `Math.max(0, attempt - 1)` | 现存两处都有这个夹子；去掉后 `attempt=0` 会算出 `base/3`，比 base 还短 |
| `opts.baseDelayMs ?? 5_000` | `Number.isFinite(v) && v >= 0 ? v : 5_000` | 现存实现是先 `Number.isFinite(Number(env.X)) && >= 0` 再算。只用 `??` 的话，调用方传 `Number(env.X)` 得到 NaN 时会算出 NaN 延迟 |
| `Math.max(1, opts.maxAttempts ?? 3)` | `Number.isInteger(v) && v >= 1 ? v : 3` | `Math.max(1, NaN)` 是 NaN，`attempt >= NaN` 恒 false → 无限重试。调用方传 `Number(env.CODEX_PET_VISUAL_MAX_ATTEMPTS)` 时这是真实路径。Task 3.3 的 `Math.min(3, ...)` 上限仍留在调用点，可见的尝试次数不变 |
| `waitCancellable` 未标 async | 保留 `async` | 现存 `wait` 是 async，已 abort 时是 reject 而非同步 throw；未 await 的调用点行为必须一致 |

顺带钉住的一个现状（**未修**）：`code: "ETIMEDOUT"` 既不在 `["econnreset","econnrefused","enotfound","eai_again"]` 名单里，也不含子串 `"timeout"`（是 `"timed"`），因此当前判定为不可重试。测试里显式断言了 `toBe(false)` 并写明这是钉既有行为，要改需单独提。

**验证：** `pnpm exec tsc --noEmit`（llm 包）与 `npx tsc --noEmit`（apps/api）干净；3 个文件 `biome lint` 干净；`vitest run retry` = 23 passed / 0 failed / 0 skipped；llm 包全量 `pnpm exec vitest run` = 文件 3 passed / 0 failed / 2 skipped，用例 47 passed / 0 failed / 5 skipped。

### Task 3.3: 迁移 codex-pet-visual.ts 与 codex-pet-model-contract.ts

**Files:** Modify `apps/api/src/workflow/codex-pet-visual.ts`、`apps/api/src/workflow/codex-pet-model-contract.ts`

- [ ] **Step 1:** model-contract（:70-77）：`env.CHATGPT_MODELS?.split(...)` 换成 `parseChatgptModelList(env)`，其余分类条件（`CODEX_PET_VISUAL_QA_MODEL` / `codex-auto-review` / `gpt-` 前缀）原样保留。
- [ ] **Step 2:** visual 的 `loadCodexPetVisualQaRoute`（:86-118）：chatgpt 分支改 `parseChatgptModelList` + `resolveChatgptCredentials`、bailian 分支改 `resolveBailianCredentials`，`catch (e) { if (e instanceof LlmRouteError) throw new CodexPetModelContractError(e.message); throw e }`。**保留**：「配置了列表但不含所选 model 即抛合同错误」的成员检查、`assertHttpModelRoute` 协议校验、`:52` 的 `DEFAULT_CODEX_PET_VISUAL_QA_BASE_URL` 字面量删除（改由 `resolveChatgptCredentials` 的默认值提供）。
- [ ] **Step 3:** visual 的 `createCodexPetVisualMessage`（:811-839）改为 `withLlmRetry((attempt) => client.messages.create(params, { signal, timeout, maxRetries: 0 }), { maxAttempts: Math.min(3, env CODEX_PET_VISUAL_MAX_ATTEMPTS), baseDelayMs: env CODEX_PET_VISUAL_RETRY_BASE_MS 默认 5_000, capDelayMs: 30_000, signal, retryable: (e) => !(e instanceof CodexPetModelContractError) && defaultRetryableLlmError(e) })`；删除本地 `wait/retryableCodexPetVisualError/codexPetVisualRetryDelayMs`。**图片生成那套重试循环（:674-783，用 `classifyImageGenerationError` 分类）本任务不动**——它的错误分类来自 image-service，留待与图像路由收敛时一并处理。
- [ ] **Step 4:** typecheck；跑 `cd "/Users/z/code/ai project/apps/api" && pnpm exec vitest run src/workflow/codex-pet-visual.test.ts src/workflow/codex-pet-model-contract`（visual.test 644 行覆盖节流/QA 门/模型路由强制/瞬时错误重试，是本任务的行为安全网）。再跑 **runner 集成**。
- [ ] **Step 5:** 检查 7 处 `vi.mock("@ai-assistant/llm")` 工厂（chat/routes.empty-response、agents/routes、agent-workflow-llm、agent-workflow-plan、novel-generation、local-business-promo-script、video-prompt-optimize 的测试）：它们的被测对象未导入新符号，预期不需要改；跑 `pnpm exec vitest run src/workflow/novel-generation.test.ts src/agent-teams` 抽查确认。
- [ ] **Step 6:** Commit `refactor(codex-pet): visual/model-contract 收编到 @ai-assistant/llm 路由与重试原语`

---

## 阶段 4：article-workflow 止血（约 1-2 天）

修三个缺陷：崩溃后项目永久卡 generating/revising 且无法自救；文本 reserve 的 operationId 只在内存、崩溃即漏退款；整单失败时已扣的图片费不回滚。**方案贴既有 dub-reaper 形状**（`dub-reaper.ts:20-52`：findMany 超期 → 条件 updateMany 抢占 → 退款吞错 → redis NX 锁 + setInterval 60s + unref）。`updatedAt` 是天然心跳（runner 每步都写进度、`@updatedAt` 自动刷新），staleMs 取 15 分钟（必须 > 图片单次尝试上限 `IMAGE_ATTEMPT_TIMEOUT_MS` 默认 600s）。

### Task 4.1: schema 加列 billingOperationId

**Files:** Modify `packages/db/prisma/schema.prisma:874-895`（ArticleWorkflowProject）

- [x] **Step 1:** 确认 schema.prisma 无未提交改动（见全局纪律 4）。在 ArticleWorkflowProject 增加一行：`billingOperationId String?`。
- [x] **Step 2:** 迁移 + 生成：
  ```bash
  cd "/Users/z/code/ai project" && set -a && source .env && set +a && pnpm --filter @ai-assistant/db migrate -- --name add_article_billing_operation_id && pnpm --filter @ai-assistant/db generate
  ```
- [x] **Step 3:** typecheck 全绿。Commit `feat(db): articleWorkflowProject.billingOperationId 列（reaper 退款用）`

### Task 4.2: 落库 operationId 并在终态清空

**Files:** Modify `apps/api/src/workflow/article-workflow-billing.ts:7-33`、`article-workflow-runner.ts`（终态写入 :226-245、:274-293 一带）

- [x] **Step 1:** `runReservedArticleTextTask` 增加可选参数 `onReserved?: (operationId: string) => Promise<void>`，在 reserve 成功后 `await args.onReserved?.(operationId)`。
- [x] **Step 2:** 两个调用方（`runInitialArticleWorkflowGeneration` / `runArticleWorkflowRewrite`）传入 `onReserved: (opId) => prisma.articleWorkflowProject.update({ where: { id: projectId }, data: { billingOperationId: opId } }).then(() => undefined)`；两处终态写入（ready 与 failed）的 data 里补 `billingOperationId: null`。
- [x] **Step 3:** 更新 `article-workflow-billing.test.ts`：新增用例断言 reserve 后回调收到 operationId、settle 后调用方清列。跑 `pnpm exec vitest run src/workflow/article-workflow`，PASS。
- [x] **Step 4:** Commit `feat(article): 文本 reserve operationId 落库`

### Task 4.3: article-workflow-reaper.ts（TDD）

**Files:** Create `apps/api/src/workflow/article-workflow-reaper.ts`、`apps/api/src/workflow/article-workflow-reaper.test.ts`；Modify `article-workflow-shared.ts`（加常量）

- [x] **Step 1: 写失败测试**（形态照抄 `dub-reaper.test.ts`：纯 vi.fn 桩）：
  ```ts
  import { describe, expect, it, vi } from "vitest"
  import { reapStaleArticleWorkflowProjects } from "./article-workflow-reaper.js"

  function fakePrisma(rows: Array<{ id: string; status: string; billingOperationId: string | null }>, claimCount = 1) {
    return {
      articleWorkflowProject: {
        findMany: vi.fn().mockResolvedValue(rows),
        updateMany: vi.fn().mockResolvedValue({ count: claimCount }),
      },
    } as never
  }

  describe("reapStaleArticleWorkflowProjects", () => {
    it("超期 generating 项目置 failed 并退款", async () => {
      const prisma = fakePrisma([{ id: "p1", status: "generating", billingOperationId: "article-text:p1:abc" }])
      const billing = { refundResource: vi.fn().mockResolvedValue(undefined) }
      await reapStaleArticleWorkflowProjects({ prisma, billing, staleMs: 1_000, now: () => 100_000 })
      const p = (prisma as any).articleWorkflowProject
      expect(p.findMany.mock.calls[0][0].where.status.in).toEqual(["generating", "revising"])
      expect(p.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "p1", status: "generating" }, data: { status: "failed" } })
      expect(billing.refundResource).toHaveBeenCalledWith("article-text:p1:abc")
    })
    it("抢占失败（count=0）不退款", async () => {
      const prisma = fakePrisma([{ id: "p1", status: "generating", billingOperationId: "op" }], 0)
      const billing = { refundResource: vi.fn() }
      await reapStaleArticleWorkflowProjects({ prisma, billing, staleMs: 1_000, now: () => 100_000 })
      expect(billing.refundResource).not.toHaveBeenCalled()
    })
    it("无 billingOperationId 只置 failed 不退款", async () => {
      const prisma = fakePrisma([{ id: "p1", status: "revising", billingOperationId: null }])
      const billing = { refundResource: vi.fn() }
      await reapStaleArticleWorkflowProjects({ prisma, billing, staleMs: 1_000, now: () => 100_000 })
      expect(billing.refundResource).not.toHaveBeenCalled()
    })
  })
  ```
  运行 `pnpm exec vitest run src/workflow/article-workflow-reaper.test.ts`，预期 FAIL。
- [x] **Step 2: 实现**（`article-workflow-shared.ts` 加 `export const ARTICLE_PROJECT_STALE_MS = 15 * 60_000`）：
  ```ts
  import type { PrismaClient } from "@prisma/client"
  import type Redis from "ioredis"
  import { ARTICLE_PROJECT_STALE_MS } from "./article-workflow-shared.js"

  export const ARTICLE_REAPER_LOCK_KEY = "ai-assistant:article-workflow:reaper:lock"
  interface ReaperBilling { refundResource(operationId: string): Promise<unknown> }

  export async function reapStaleArticleWorkflowProjects(args: {
    prisma: PrismaClient
    billing: ReaperBilling
    staleMs?: number
    now?: () => number
  }): Promise<void> {
    const threshold = new Date((args.now?.() ?? Date.now()) - (args.staleMs ?? ARTICLE_PROJECT_STALE_MS))
    const stuck = await args.prisma.articleWorkflowProject.findMany({
      where: { status: { in: ["generating", "revising"] }, updatedAt: { lt: threshold } },
      select: { id: true, status: true, billingOperationId: true },
    })
    for (const row of stuck) {
      const claimed = await args.prisma.articleWorkflowProject.updateMany({
        where: { id: row.id, status: row.status },
        data: {
          status: "failed",
          progressStage: "failed",
          progressPercent: 100,
          progressMessage: "生成超时中断",
          error: "服务重启或任务超时，已自动终止，可重新发起生成",
        },
      })
      if (claimed.count !== 1) continue
      if (row.billingOperationId) await args.billing.refundResource(row.billingOperationId).catch(() => undefined)
    }
  }

  export function startArticleWorkflowReaper(args: { prisma: PrismaClient; redis: Redis; billing: ReaperBilling }): NodeJS.Timeout {
    const tick = async () => {
      const locked = await args.redis.set(ARTICLE_REAPER_LOCK_KEY, "1", "EX", 55, "NX").catch(() => null)
      if (!locked) return
      await reapStaleArticleWorkflowProjects(args).catch(() => undefined)
    }
    const timer = setInterval(() => { void tick() }, 60_000)
    timer.unref()
    void tick()
    return timer
  }
  ```
  （退款成功后不清列：refund 按 operationId 幂等，列值留作审计；项目已置 failed 不会被再次收割。）
- [x] **Step 3:** 测试 PASS。 **Step 4:** Commit `feat(article): 卡死项目收尸 reaper（15 分钟超时置 failed + 退文本 reserve）`

### Task 4.4: server.ts 注册 reaper

**Files:** Modify `apps/api/src/server.ts`（`startLocalBusinessPromoRefundReaper` 注册点 :195-199 旁；onClose :264-270）

- [x] **Step 1:** 仿照 :195-199 的形状注册 `startArticleWorkflowReaper({ prisma: getPrisma(), redis: getRedis(), billing: createBillingClient({...同旁边 reaper 的构造参数}) })`，返回的 timer 存变量；onClose 钩子里 `clearInterval(articleReaperTimer)`。
- [x] **Step 2:** typecheck；启动冒烟：`pnpm dev` 起 api 后看日志无报错（或跑 apps/api 现有的 server 启动类测试）。
- [x] **Step 3:** Commit `feat(article): 注册 article reaper 与优雅停机清理`

### Task 4.5: 整单失败回滚已扣图片费

**Files:** Modify `apps/api/src/workflow/article-workflow-images.ts`（:37 operationId、返回值）、`article-workflow-runner.ts`（materializeArticleWorkflow :79-201）

- [x] **Step 1:** 在 `article-workflow-routes.test.ts` 或新文件加失败用例：mock llm 让 layout 阶段（第二次 LLM 调用）抛错，断言 billing 桩收到对每个已 charge 图片 operationId 的 `refundResource` 调用（buildArticleWorkflowApp 的 billing 假件记录调用即可）。预期 FAIL。
- [x] **Step 2:** `populateArticleWorkflowImages` 把每张成功 charge 的 `operationId`（:37 生成的 `article-image:${projectId}:${slot}:${uuid}`）收集进返回值：返回形状从 `manifest` 改为 `{ manifest, chargedOperationIds: string[] }`，更新调用点。
- [x] **Step 3:** `materializeArticleWorkflow` 用 try/catch 包住图片生成之后的余下流程（layout LLM 调用与 HTML guard），catch 里 `for (const opId of chargedOperationIds) await billing.refundResource(opId).catch(() => undefined)` 后重抛（与 `article-workflow-billing.ts:30` 同款吞错语义；billing 服务按 operationId 幂等，重复退款安全）。
- [x] **Step 4:** 用例 PASS；跑 `pnpm exec vitest run src/workflow/article-workflow` 全绿。
- [x] **Step 5:** Commit `fix(article): 整单失败回滚已扣图片费`

### Task 4.6: 终态写入防迟到覆盖

**Files:** Modify `apps/api/src/workflow/article-workflow-store.ts:17-48`、`article-workflow-runner.ts` 终态调用点

- [x] **Step 1:** store 增加受保护变体：
  ```ts
  export async function finalizeArticleWorkflowProjectState(prisma: PrismaClient, projectId: string, data: ...): Promise<boolean> {
    const res = await prisma.articleWorkflowProject.updateMany({
      where: { id: projectId, status: { in: ["generating", "revising"] } },
      data,
    })
    return res.count === 1
  }
  ```
- [x] **Step 2:** runner 的 ready / failed 两处终态写入改用它；返回 false（reaper 已抢先置 failed）时记 warn 日志并跳过 settle（reserve 已被 reaper 退款，settle 会造成双结算——这是本任务必须防住的竞态）。
- [x] **Step 3:** 加用例：项目已被置 failed 后 runner 迟到写 ready，断言不覆盖且不 settle。PASS 后跑 article 全组测试。
- [x] **Step 4:** Commit `fix(article): 终态条件写防 reaper 竞态双结算`

### 阶段 4 执行记录（2026-07-28 完成）

提交（均在 `main`，未 push）：`b8acec6` → `5b20c98` → `d6197b2` → `fd5501b` → `d0fe27f` → `875b48b`，一任务一提交，可逐个回退。
验证：`pnpm exec tsc --noEmit` 全绿；`pnpm exec vitest run src/workflow/article-workflow` 20/20 PASS（新增 reaper 4 例 + billing 4 例）。apps/api 全量 1511 passed / 12 failed，12 例集中在 `admin/code-routes`、`admin/membership-routes`、`admin/resource-routes`、`agents/routes`，与本次改动无关：把 `server.ts` 换回改动前版本（`5801614`）重跑同 4 个文件，失败数与断言完全一致（11 例 `expected 200 to be 502`——source 了 `.env` 后 billing 可达；1 例 avatarUrl——S3 已配置，测试预期无 S3 的回落值）。计费语义未改：reserve → work → 写终态 → settle 的次序与 refund 吞错语义保持原样。

与计划的偏差（都是执行中发现更安全的做法）：

1. **Task 4.1 Step 2 未用 `migrate dev`**：dev 库存在与本次无关的历史 drift（`LocalBusinessPromoRun`、`NovelKnowledgeFact` 的索引名），`migrate dev` 要求 reset 整个 schema。改为手写 `packages/db/prisma/migrations/20260728100000_add_article_billing_operation_id/migration.sql`，`prisma db execute` 应用后 `prisma migrate resolve --applied`，再 `generate`，并用 `psql \d` 核对列已存在。**未执行任何 reset**，dev 数据保留。
2. **Task 4.3 Step 2 省掉了 `void tick()`**：与 `dub-reaper` / `local-business-promo-refund` 两个既有 reaper 形状一致（只 `setInterval`），避免进程启动瞬间打 DB/redis；判定阈值是 15 分钟，首轮延迟 60s 无实质影响。
3. **Task 4.5 Step 2 未改 `populateArticleWorkflowImages` 返回值**：改成回调 `onCharged?: (operationId: string) => void`，已扣清单由 `materializeArticleWorkflow` 持有。原因正是本任务要修的漏洞——若清单走返回值，图片批次自身抛错时返回值拿不到，已扣的费就漏退了。
4. **Task 4.6 Step 2 的"跳过 settle"落成"退款"**：终态被 reaper 抢占时只跳过 settle 会留下一笔悬空 reserve，故走 `refundResource`（按 operationId 幂等，与 reaper 的退款重复也安全）。实现上给 `runReservedArticleTextTask` 加了 `commitResult?: (result) => Promise<boolean>` 钩子，把"写终态"夹在 work 与 settle 之间，settle 不暴露给 runner。同一路径下 reaper 收割前已扣的图片费也一并退回（计划未覆盖这条竞态分支）。

已知残留（不在本阶段范围，未改）：reaper 收割后，仍在跑的 runner 的中途进度写入（`updateArticleWorkflowProjectState`，非终态）会盖掉 `progressMessage: "生成超时中断"`，但 `status: failed` 与 `error` 文案不受影响（终态写是条件写）。前端按 status 分支，属文案残留。若要彻底干净，可把中途进度写也改成带 `status in (generating, revising)` 条件的 updateMany。

---

## 里程碑与工作量

| 阶段 | 内容 | 估时 | 交付判据 |
| --- | --- | --- | --- |
| 0 | 绿色基线 | 0.5 天 | codex-pet 全量 221 通过 0 失败 |
| 1 | runner 纯移动拆分 | 2-3 天 | runner.ts 5115→~1400 行，13 个模块，外部调用方零改动，全量测试与基线一致 |
| 2 | executeRun 解耦去重 | 3-5 天 | 三份 look 拷贝→2 个参数化函数；形状 A/B CAS 收敛约 18 处 |
| 3 | llm 收敛 | 2-3 天 | CHATGPT_MODELS 解析 3→1 处；visual 自研重试删除约 100 行 |
| 4 | article 止血 | 1-2 天 | 卡死项目 15 分钟自动 failed 可重试；崩溃不漏退文本 reserve；整单失败退图费 |

## 风险与回滚

- **每个任务独立成 commit**，任何一步集成测试变红即 `git revert` 单个提交，不影响已完成部分。
- **runner 集成套件跑一轮约 3-4 分钟**：阶段 1 只在 3 个检查点跑全量，其余靠 typecheck + 秒级合同测试，控制迭代节奏。
- **阶段 2 是唯一可能改变行为的阶段**：look 修复循环的四类差异已表格化，执行者若发现表外差异（如参数默认值不一致），停下来先补进表格再继续，不要顺手"修复"。
- worker 主循环（`codex-pet-worker.ts` main()）与生产接线（server.ts:157 默认 deps）无测试覆盖——本计划刻意不动这两处。
- 上线前（当前未上线）是本次重构的最佳窗口，但**阶段 2 完成后建议在 dev 环境完整跑一次真实桌宠生成**（POC env 守卫测试或手动触发）做端到端确认。
