# 编排现状分析：要不要引入 Agent 编排框架

> 2026-07-26 · 由多智能体代码分析产出（6 个子系统读取 agent + 3 个对立立场评估 agent，全部结论有代码位置支撑）。
> 结论是**建议**而非已定案；若采纳，请在 [decisions.md](decisions.md) 补一条 ADR。
>
> **2026-10-13 校订**：三重约束里「计费精确一次语义」那条已随 ADR-012 失去载体（计费整块下线），文中所有 `reserve/settle/refund` 计费叙述已改写为通用的「外部付费调用幂等」诉求；「connector-protocol + desktop」子系统章节与计费台账叙述已删除/改写。
> 另外，本文引用的以下模块**已从仓库删除**，对应句子已重写而非保留：`dub-rewrite-service.ts`、`fanout-billing.ts`、`video-script-service.ts`、`report-service.ts`、`local-business-promo-queue.ts`、`wechat/turn.ts`、`scheduled/cron.ts`、`codex-pet-call-ledger.ts`、`codex-pet-per-image-billing-correction.ts`。
> **行号与代码量仍是 2026-07-26 快照**，未经逐行复核；请以文件名与模式为锚点。校订时已核实「已落地/已缓解」的地方用 **现状** 标出。

## TL;DR

1. **本项目没有使用任何 agent 编排框架**（无 LangChain/LangGraph/CrewAI/Mastra/Vercel AI SDK），全部直连 `@anthropic-ai/sdk`。
2. 但主流框架的核心能力——checkpoint、重试策略、人工介入挂起、断点恢复、可续传事件流——**已经全部自研落地**，编排相关代码约 1.2~1.9 万行。问题不是"缺能力"，而是"每条业务线各抄一份"。
3. **建议：现在不做整体框架迁移**。对外部付费调用（生图等）不重复发起的幂等要求、产品状态表即产品接口、2 万+ 行编排测试三重约束使迁移性价比不成立。（原文写的是「计费精确一次语义」——计费已于 2026-09 随 ADR-012 下线，约束的实际载体改为外部付费调用的幂等。）
4. 应做的是**收敛式重构**（加厚 `packages/llm` → 止血 article-workflow → 抽 orchestration-kit），并把框架试点位留给下一条全新业务线（Inngest/Temporal 类 durable 引擎，明确不选 LangGraph）。**现状**：第 1 步已基本落地、第 2 步落地一半，所以接续工作时请先读第五节的进度标注，别把已完成的当成新任务。

---

## 一、现状盘点（按子系统）

| 子系统 | 编排代码量（非测试） | 编排方式 |
| --- | --- | --- |
| `packages/llm` | 162 行（刻意做薄）→ **现状 355 行 / 3 文件** | 双层 monkey-patch：bailian quirk 适配 + 按模型名多网关路由；**现状**：重试与路由解析已进包（`retry.ts` / `routes.ts`，见 1.1） |
| novel 线 | ~7k 行（核心 ~2.7k） | 五张表状态机 + 事务性 outbox + BullMQ + 三层重试 + checkpoint 快照 |
| article 线 | ~1.9k 行（狭义编排 ~700） | **现状**：已接 `article-workflow-reaper.ts` 收尸（`server-background.ts:9` 启动），不再是纯 fire-and-forget；卡死项目的恢复放行仍缺 |
| codex-pet 线 | ~19k 行（runner 单文件 5115 行）→ **现状 1412 行** | 手写持久化工作流引擎：job 依赖图 + 幂等重放 + 租约/心跳/CAS + 双层 QA 循环（巨石已拆） |
| api 异步基础设施 | ~8.6k 行 | **现状**：3 条 BullMQ 队列（novel-runs / codex-pet / codex-pet-cleanup）+ 2 个独立 worker 进程 + 各域自管 reaper + 事件表/SSE |

### 1.1 packages/llm：全项目 LLM 调用的唯一入口（**现状：已加厚，见文末**）

当初只做三件事：

- env 驱动的 provider 选择（bailian / anthropic 兼容网关），`client.ts:110-153`
- bailian quirk 适配（thinking+tools 冲突时自动注入 `thinking:{type:'disabled'}`），`client.ts:42-64`
- 按模型名多网关路由（`CHATGPT_MODELS` 白名单转发到 AI Pixel），`client.ts:83-108`，即 ADR-001

**当时「重试、超时、usage 记账、结构化输出全部不在包内」**，由 apps/api 的 20+ 个调用方各自实现：

- `codex-pet-visual.ts:824-839` 被迫 `maxRetries:0` 后自研约 100 行重试循环
- 超时常量各起各的名字：`ecom-helpwrite-service.ts:72`，以及 ~~`fanout-billing.ts:51`~~、~~`dub-rewrite-service.ts:61`~~、~~`report-service.ts:201`~~、~~`video-script-service.ts:118`~~（划掉者所在模块已删除）
- usage 手工累加在 `agent/run.ts:230-231`、`chat/routes.ts:673-674`，以及 ~~`wechat/turn.ts:215`~~（`wechat/` 目录已删）
- `CHATGPT_MODELS` 路由解析三处重复：`client.ts:66-76`、`codex-pet-model-contract.ts:70-71`、`codex-pet-visual.ts:104-109`；后者还整段复刻了 bailian baseURL/key 解析

**现状（2026-10 核实）**：包内已新增 `retry.ts`（`defaultRetryableLlmError` / `llmRetryDelayMs` / `waitCancellable` / `withLlmRetry`）与 `routes.ts`（`CHATGPT_MODELS`、`parseChatgptModelList`、`configuredChatgptModelList`、`resolveChatgptCredentials`、`resolveBailianCredentials`、`LlmRouteError`），由 `index.ts` 统一导出，14 个调用点已改为从 `@ai-assistant/llm` 导入——`codex-pet-visual.ts` 与 `codex-pet-model-contract.ts` 里已搜不到任何自拼 baseURL / key 的痕迹。**即：路由解析收敛（原第 4 条）已完成，分类重试也已进包；usage 记账与结构化输出 fix-loop 仍未进包。**

### 1.2 novel 线：最完整的 DB 驱动链式状态机

- 8 步静态流水线（`packages/novel-workflow/src/server/pipeline.ts:3-33`，indexOf+1 推进），执行引擎全在 apps/api
- 事务性 outbox（步骤行与 `novelCommandOutbox` 同事务落库）→ BullMQ → 独立 worker，`novel/outbox.ts:7-42`
- 三层重试：BullMQ 指数退避 ×3 → `consecutiveFailures≥3` 熔断 → 质量门不过自动返修 writeChapter（上限 2 次），`novel/runner.ts:455-495,544-569`
- 断点恢复：90 秒 stale step 回收 + 章节前全量 checkpoint 快照可回滚，`novel/outbox.ts:44-109`、`checkpoint-snapshot.ts`
- 人工介入：awaitingReview / 余额不足自动 paused，`novel/runner.ts:508-542`
- 流式：Anthropic stream → 事件表分块 → Redis pub/sub → SSE（支持 Last-Event-ID 续传）

### 1.3 article 线：曾经最薄弱的一条（**现状：已补收尸，自助恢复仍缺**）

- 两次 LLM 调用（JSON 计划 → 微信 HTML 排版）+ 分批并行配图
- **原为 fire-and-forget 裸 Promise**（`article-workflow-shared.ts:93-97`）：无队列、无重试、无崩溃恢复；进程崩溃后项目永久卡在 generating/revising，且 `canRecoverArticleProject` 只放行 ready/failed（`article-workflow-shared.ts:103-105`，行号为旧快照），**API 层无法解救**
- **现状**：`article-workflow-reaper.ts` 已落地并在 `server-background.ts:9` 启动（`setInterval` 收尸，`onClose` 里 `clearInterval`），卡死项目不再只能靠人工改库；但 `canRecoverArticleProject` 仍只放行 ready/failed（现有两处判定在 `article-workflow-routes.ts:310`、`:356`）⇒ **用户侧自助恢复的缺口仍在**
- 校验失败即整单 failed：逐字保真校验 + HTML guard 白名单（`article-workflow-html-guard.ts:142-171`），**缺「把校验错误喂回 LLM 修复」的重试半边**（原文还提到「失败后已生成配图的 charge 不回滚」，随计费下线已不再适用）

### 1.4 codex-pet 线：最重、最接近手写 Temporal（**现状：巨石已拆**）

- 每个节点是一行 `CodexPetJob`（key 唯一、dependencyKeys、输入 revision 哈希、outputArtifactIds）；**每次队列投递幂等重放整个依赖图**（`codex-pet-runner.ts` 内注释），已完成节点从 artifact 加载并校验 provenance——这就是手写的 Temporal replay
- 租约所有权：`claimRunLease` CAS + 10 秒心跳 + 15 分钟陈旧接管（现落在 `codex-pet-runner/runner-lease.ts`），全文 30+ 处手拼 `workerId+status+cancelRequested` 谓词
- 双层 QA 循环：确定性像素/几何规则（`packages/codex-pet-pipeline/src/extraction.ts:469-725`）→ LLM 多数投票共识评审 → 失败诊断转成累积编号修复需求注入下次生图 prompt，上限 1~3 次
- 人工介入：awaiting_base_review / awaiting_direction_review / awaiting_regeneration_approval 三种挂起态 + 每图审批预算递减
- **~~计费台账~~**：原文写「`CodexPetImageCall` 以 FOR UPDATE 行锁 + dispatching→sent→succeeded 状态卡在 fetch 前后（`codex-pet-call-ledger.ts:68-209`），防 crash 后重复发起付费调用；此机制来自一次真实计费事故，并有 215 行的 `codex-pet-per-image-billing-correction.ts` 事后矫正脚本」。
  **现状**：`codex-pet-call-ledger.ts` 与那支矫正脚本**均已删除**，`apps/api/src` 里已搜不到 `refundStatus` 的读写；但 `CodexPetImageCall` 表与 `refundStatus` / `refundedAt` / `refundError` 三列**仍在 `schema.prisma` 里**（历史数据，无人读写 —— 别以为还有退款状态机）。留下的教训仍然成立：**付费外部调用要用「调用前落库占位 + 状态机推进」防 crash 后重复发起**，新链路照办。
- 控制流靠 7 类异常在 `executeCodexPetRun` 的 catch 链逐一分派恢复策略（行号为旧快照；`executeCodexPetRun` 仍在 `codex-pet-runner.ts`）

---

## 二、已自研的"框架能力"对照

| 框架能力 | 自研等价物 | 位置 |
| --- | --- | --- |
| Durable execution / replay | job 依赖图幂等重放 + 输入 revision 哈希缓存失效 | `codex-pet-runner.ts`、`codex-pet-runner/runner-jobs.ts` |
| Checkpoint | NovelCheckpoint 全量快照 + 回滚端点 | `novel/checkpoint-snapshot.ts` |
| Retry policy | BullMQ 退避 + 熔断 + QA 返修三层 | `novel/runner.ts:544-569` |
| Interrupt / human-in-the-loop | awaitingReview、三种 awaiting_*、审批预算、余额暂停 | `novel/runner.ts:508-542`、`codex-pet-runner/runner-image-approval.ts` |
| 事件流 / streaming | 事件表 + 单调 sequence + Redis pub/sub + SSE + Last-Event-ID | `novel/events.ts`、`codex-pet-events.ts`、`chat/sse.ts` |
| Task queue | **3 条** BullMQ 队列 + outbox + 租约 | `novel/queue.ts`、`codex-pet-queue.ts` 等 |
| Model router | 按模型名多网关路由（monkey-patch 实现） | `packages/llm/src/client.ts:83-108`、`packages/llm/src/routes.ts` |
| 定时调度 | **现状**：无统一 dispatcher，改为各域自管 reaper（`setInterval` + Redis 锁）；原先那个「croner 算表达式 + 自研 dispatcher」的模块已删除 | `article-workflow-reaper.ts`、`kb/reaper.ts`、`image-reaper.ts`、`portrait-reaper.ts` |

基础设施分析的自评：**与带持久化状态的编排框架重叠度 70%+**。

---

## 三、确凿的问题清单

按严重性排序：

1. **横向复制税**（最大的债，且框架解决不了）：
   - **现状 2 份**几乎相同的 BullMQ 连接样板（`novelBullConnection` @ `novel/queue.ts:17`、`codexPetBullConnection` @ `codex-pet-queue.ts:17`；cleanup 队列复用后者），重试/去重语义却各不相同（原为 4 份，promo 线已删）
   - **现状**：`chat/sse.ts` 已抽为公共 SSE 模块，但 novel 与 codex-pet 两条事件流通路仍各自实现（`novel/routes.ts` vs `codex-pet/codex-pet-event-routes.ts`）
   - **现状 2 套**语义各异的断点恢复策略（novel 90s updatedAt / codex-pet 15min 心跳租约），差异靠长注释维系（原为 3 套，promo 线已删）
   - ~~reserve/settle/refund 计费模板每条业务线各写一份~~ → **现状**：计费已整块下线，改为「外部付费调用（生图）的占位/幂等去重」在各域各写一份 —— 债的性质没变，只是换了对象
2. **`packages/llm` 过薄导致编排税外溢**（**现状：已大幅缓解**）：见 1.1，这是六份子系统报告里复现率最高的痛点；`routes.ts` / `retry.ts` 落地后只剩 usage 记账与结构化输出 fix-loop 未进包。
3. **article-workflow 无恢复路径**（**现状：部分缓解**）：原为崩溃即永久卡死、用户侧无解；收尸 reaper 已补上，但 `canRecoverArticleProject` 仍不放行 generating/revising ⇒ **用户自助恢复的缺口仍在**。这是自研路线的真实事故案例。
4. **~~codex-pet-runner.ts 巨石~~**（**现状：已解决**）：原为单文件 5115 行、`executeRun` 单函数约 790 行、look 行修复 3 份拷贝、异常当控制流；现已拆成 1412 行主文件 + `codex-pet-runner/` 下 14 个模块（`runner-lease.ts` / `runner-look-repair.ts` / `runner-jobs.ts` / `runner-finalize.ts` 等）。
5. **零散缺陷**：~~scheduled dispatcher 对到期任务 `void exec` 火后不理且并发无上限（`scheduled/cron.ts:40`，`SCHED.maxConcurrent` 定义了没人用）~~ —— 该模块已删除，现为各域自管 reaper；novel worker 靠 30 秒重写 progress=1 刷 updatedAt 对抗 stale 回收（`runner.ts:379-384`）；**`packages/novel-workflow/src/ports.ts` 三个端口接口零实现零引用仍是死代码**（2026-10 复核：`NovelEventPublisher` / `NovelRunRepository` / `NovelGenerationPort` 无任何消费者，只被 `packages/novel-workflow/src/index.ts` re-export）；可观测性完全自研（手写 Prometheus 文本格式，`codex-pet-worker.ts:382-401`）。

---

## 四、三方对抗评估摘要

三个立场 agent 基于同一份代码事实互相较量，各自必须承认对方成立的点。

### 4.1 支持上框架（Temporal + Vercel AI SDK 双轨）

核心论点：项目已手写一个"三套语义互不一致的残缺版 Temporal"（novel 的 outbox 状态机 / codex-pet 的租约+重放 / article 的裸 Promise）；确定性重放可消灭手写重放与租约/CAS 两类最大样板；article 卡死、dispatcher 无上限这类缺陷是 durable 框架默认杜绝的；一次真实的手写状态机事故说明手写 exactly-once 翻过车（原文写"计费事故"，计费本身已下线）。选型上明确**不选 LangGraph**（本项目的"图"都很简单，难点在持久化与人审暂停，LangGraph 的 durable 能力绑平台托管）。

**其承认的反面**：外部付费调用的幂等设施一行不能删，只是被包进 activity（原文写「计费幂等设施」）；Prisma 状态表投影层必须保留，迁移期有双写窗口；2 万+ 行编排测试大部分作废；bailian quirk、HTML guard、prompt 工程类痛点换任何框架都原样存在；codex-pet 迁移回归风险最高。

### 4.2 反对上框架（收敛式重构）

核心论点：框架核心能力已全部自研且经生产验证，引入框架是"为已有的东西付双份钱"；**三重硬约束**——① 外部付费调用的幂等与编排深度耦合（原文写"计费与编排深度耦合且要求精确一次"；计费已下线，但生图等付费调用「不重复发起」的要求仍在），框架 at-least-once 重放恰是最危险默认；② 状态表即产品接口（前端轮询、SSE 回放、admin 直查），换私有 checkpoint store 必现双状态源；③ 迁移成本与风险不成比例（复杂度集中在 codex-pet 一条线，其余没到需要框架的量级）。多数 pain point 是"缺内部共享库"而非"缺框架"。

**其承认的反面**：article 卡死是自研路线的真实事故，每条新线都可能重犯；复制税随业务线数量线性增长；可观测性落后（没有 Temporal Web UI 级调试体验）；巴士系数风险——自研引擎的正确性靠少数人头脑维系，Temporal 经验可招聘、自研引擎不可。

### 4.3 中立缺口分析

逐项盘点后：所有真实缺口按量级都落在"数百行自研 + 轻量组件"档，唯一接近框架量级的诉求是**未来新业务线**的 durable execution。三路工作量对比：全面上框架保守 3~6 人月且有双状态源风险；纯收敛 3~5 人周、零语义回归风险；折中 = 收敛 + 新线试点轻 durable 引擎（Inngest 的 `step.run` 幂等重放与现有 outbox/ensureJob 语义几乎同构，状态可留自家 Postgres）。

---

## 五、结论与建议路线

**现在不做整体框架迁移；做收敛式重构，框架试点位留给下一条全新业务线。**

按性价比排序（预估合计 3~5 人周，可与业务迭代并行）：

### 第 1 步：加厚 packages/llm（1~2 周，收益最大）— **现状：基本落地**

- ✅ **路由解析收敛**：`CHATGPT_MODELS` / bailian 解析全在 `routes.ts`，`codex-pet-model-contract.ts` 与 `codex-pet-visual.ts` 里已搜不到任何自拼 baseURL / key
- ✅ **分类重试**：`retry.ts` 提供 `defaultRetryableLlmError` / `llmRetryDelayMs` / `waitCancellable` / `withLlmRetry`
- 🟡 **门面**：`index.ts` 已导出 `createLlmClient` 等，14 个调用点已改为从 `@ai-assistant/llm` 导入
- ⬜ **未做**：用显式 wrapper 类替换双层 monkey-patch（`client.ts` 仍是 monkey-patch）；统一超时；usage / model / latency 钩子（原文写"对接计费"，计费已下线，改为对接可观测）；zod 结构化输出 + 校验失败回灌 LLM 的 fix-loop

### 第 2 步：止血 article-workflow（约 1 周）— **现状：落地一半**

- ✅ **收尸**：`article-workflow-reaper.ts` 已在 `server-background.ts:9` 启动，消灭了"崩溃即永久卡死且无人回收"
- ⬜ **放行恢复**：`canRecoverArticleProject` 仍只放行 ready/failed（`article-workflow-routes.ts:310`、`:356`）—— 用户自助恢复仍无解
- ✅ **计费不对称**：随计费整块下线自动消失（原文"文本 refund 但图片 charge 不回滚"已不适用）

### 第 3 步：抽 packages/orchestration-kit（2~3 周，渐进）— **现状：未做（但附带的那项拆分已完成）**

收编横向复制：队列/连接工厂（统一 Redis 解析，按业务线声明 attempts/backoff）、通用 SSE 模块（事件表 + 单调 sequence + pub/sub + Last-Event-ID 回放，参数化表名）、租约/心跳/CAS helper（消灭 codex-pet 30+ 处手拼谓词）、**外部付费调用的占位/幂等 saga 包装器**（原文写"reserve/settle/refund saga 包装器"；计费已下线，诉求改为通用幂等）、progress reporter（消灭散落的进度百分比魔数）。**新业务线强制使用，存量只做机会性迁移、不重写。**

同期机会性拆分 `codex-pet-runner.ts` —— ✅ **已完成**：现为 1412 行主文件 + `codex-pet-runner/` 下 14 个模块（`runner-lease.ts` / `runner-look-repair.ts` / `runner-jobs.ts` / `runner-finalize.ts` / `runner-image-approval.ts` …）。

### 第 4 步：框架试点（下一条全新业务线上）

- 用 Inngest 类轻 durable 引擎（TS 原生、状态留自家 Postgres、`step.run` 与既有幂等重放语义同构）或 Temporal 做受控实验，验证后再讨论存量迁移
- **明确不做的两件事**：不引入 LangGraph.js 作核心编排（三条流水线全是线性+循环，图模型收益低于 20+ 调用点的迁移成本）；不把 novel/codex-pet 迁入任何框架的私有 checkpoint store（历史计费列、前端直查、租约语义三重耦合会制造双状态源）

### 重新评估触发条件（建议写进 ADR）

出现以下任一情况时，重新评估对**新业务线**引入 Temporal/Inngest：

1. 出现真正的运行时动态 DAG 需求（多 agent 团队自由编排、skill 市场用户自定义工作流）——现有编排全是静态步骤表，`pipelineForMode` 的差异化参数至今被下划线忽略
2. 第三条业务线需要 codex-pet 级别的 durable 语义（依赖图重放 + 多天级人审暂停 + 租约）
3. 微信触发的长任务/定时 agent 规模化，为每条新线手写 durable 语义的累计成本超过一次框架引入

---

## 附录：分析方法

- 读取阶段：6 个 agent 并行深读 `packages/llm`、novel 线、article 线、codex-pet 线、api 异步基础设施、connector-protocol + 设计文档，产出结构化报告（编排模式/调用点/框架等价物/痛点，均带文件:行号）。※ 其中 `connector-protocol` 与桌面端**已整块下线**，该份报告仅作历史
- 评估阶段：3 个 agent 分别持"支持上框架 / 反对上框架 / 中立缺口分析"立场，基于读取阶段的代码事实对抗论证，各自必须列出对方成立的点（concessions）
- 行号为 2026-07-26 时点快照，随代码演进会漂移；结论请以模式与文件为锚点复核。2026-10-13 做过一次校订（删掉已下线模块的引用、标注已落地项），但**未重新测量代码量**
