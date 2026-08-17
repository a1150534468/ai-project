# 编排现状分析：要不要引入 Agent 编排框架

> 2026-07-26 · 由多智能体代码分析产出（6 个子系统读取 agent + 3 个对立立场评估 agent，全部结论有代码位置支撑）。
> 结论是**建议**而非已定案；若采纳，请在 [decisions.md](decisions.md) 补一条 ADR。

## TL;DR

1. **本项目没有使用任何 agent 编排框架**（无 LangChain/LangGraph/CrewAI/Mastra/Vercel AI SDK），全部直连 `@anthropic-ai/sdk`。
2. 但主流框架的核心能力——checkpoint、重试策略、人工介入挂起、断点恢复、可续传事件流——**已经全部自研落地**，编排相关代码约 1.2~1.9 万行。问题不是"缺能力"，而是"每条业务线各抄一份"。
3. **建议：现在不做整体框架迁移**。计费精确一次语义、Prisma 状态表即产品接口、2 万+ 行编排测试三重约束使迁移性价比不成立。
4. 应做的是**收敛式重构**（加厚 `packages/llm` → 止血 article-workflow → 抽 orchestration-kit），并把框架试点位留给下一条全新业务线（Inngest/Temporal 类 durable 引擎，明确不选 LangGraph）。

---

## 一、现状盘点（按子系统）

| 子系统 | 编排代码量（非测试） | 编排方式 |
| --- | --- | --- |
| `packages/llm` | 162 行（刻意做薄） | 双层 monkey-patch：bailian quirk 适配 + 按模型名多网关路由 |
| novel 线 | ~7k 行（核心 ~2.7k） | 五张表状态机 + 事务性 outbox + BullMQ + 三层重试 + checkpoint 快照 |
| article 线 | ~1.9k 行（狭义编排 ~700） | 裸 Promise fire-and-forget，无队列无恢复，单发 LLM + 硬校验门禁 |
| codex-pet 线 | ~19k 行（runner 单文件 5115 行） | 手写持久化工作流引擎：job 依赖图 + 幂等重放 + 租约/心跳/CAS + 双层 QA 循环 |
| api 异步基础设施 | ~8.6k 行 | 4 条 BullMQ 队列 + 3 个 worker 进程 + 自研定时 dispatcher + 事件表/SSE |
| connector-protocol + desktop | ~3.8k 行 | 自研远程工具 RPC（功能上是手写的 MCP 等价物），桌面机作云端 agent 的工具执行节点 |

### 1.1 packages/llm：全项目 LLM 调用的唯一入口，但只做三件事

- env 驱动的 provider 选择（bailian / anthropic 兼容网关），`client.ts:110-153`
- bailian quirk 适配（thinking+tools 冲突时自动注入 `thinking:{type:'disabled'}`），`client.ts:42-64`
- 按模型名多网关路由（`CHATGPT_MODELS` 白名单转发到 AI Pixel），`client.ts:83-108`，即 ADR-001

**重试、超时、usage 记账、结构化输出全部不在包内**，由 apps/api 的 20+ 个调用方各自实现：

- `codex-pet-visual.ts:824-839` 被迫 `maxRetries:0` 后自研约 100 行重试循环
- 超时常量在 `fanout-billing.ts:51`、`dub-rewrite-service.ts:61`、`ecom-helpwrite-service.ts:72`、`report-service.ts:201`、`video-script-service.ts:118` 各起各的名字
- usage 手工累加在 `agent/run.ts:230-231`、`chat/routes.ts:673-674`、`wechat/turn.ts:215` 各写一遍
- `CHATGPT_MODELS` 路由解析三处重复：`client.ts:66-76`、`codex-pet-model-contract.ts:70-71`、`codex-pet-visual.ts:104-109`；后者还整段复刻了 bailian baseURL/key 解析

### 1.2 novel 线：最完整的 DB 驱动链式状态机

- 8 步静态流水线（`packages/novel-workflow/src/server/pipeline.ts:3-33`，indexOf+1 推进），执行引擎全在 apps/api
- 事务性 outbox（步骤行与 `novelCommandOutbox` 同事务落库）→ BullMQ → 独立 worker，`novel/outbox.ts:7-42`
- 三层重试：BullMQ 指数退避 ×3 → `consecutiveFailures≥3` 熔断 → 质量门不过自动返修 writeChapter（上限 2 次），`novel/runner.ts:455-495,544-569`
- 断点恢复：90 秒 stale step 回收 + 章节前全量 checkpoint 快照可回滚，`novel/outbox.ts:44-109`、`checkpoint-snapshot.ts`
- 人工介入：awaitingReview / 余额不足自动 paused，`novel/runner.ts:508-542`
- 流式：Anthropic stream → 事件表分块 → Redis pub/sub → SSE（支持 Last-Event-ID 续传）

### 1.3 article 线：最薄弱的一条

- 两次 LLM 调用（JSON 计划 → 微信 HTML 排版）+ 分批并行配图
- **fire-and-forget 裸 Promise**（`article-workflow-shared.ts:93-97`）：无队列、无重试、无崩溃恢复；进程崩溃后项目永久卡在 generating/revising，且 `canRecoverArticleProject` 只放行 ready/failed（`shared.ts:103-105`），**API 层无法解救**（dub 线有 dub-reaper 收尸，article 没有）
- 校验失败即整单 failed：逐字保真校验 + HTML guard 白名单（`article-workflow-html-guard.ts:142-171`），**缺"把校验错误喂回 LLM 修复"的重试半边**；失败后已生成配图的 charge 不回滚（`images.ts:39-44`）

### 1.4 codex-pet 线：最重、最接近手写 Temporal

- 每个节点是一行 `CodexPetJob`（key 唯一、dependencyKeys、输入 revision 哈希、outputArtifactIds）；**每次队列投递幂等重放整个依赖图**（`codex-pet-runner.ts:851-853` 注释），已完成节点从 artifact 加载并校验 provenance——这就是手写的 Temporal replay
- 租约所有权：`claimRunLease` CAS + 10 秒心跳 + 15 分钟陈旧接管（`runner.ts:766-818`），全文 30+ 处手拼 `workerId+status+cancelRequested` 谓词
- 双层 QA 循环：确定性像素/几何规则（`packages/codex-pet-pipeline/src/extraction.ts:469-725`）→ LLM 多数投票共识评审 → 失败诊断转成累积编号修复需求注入下次生图 prompt，上限 1~3 次
- 人工介入：awaiting_base_review / awaiting_direction_review / awaiting_regeneration_approval 三种挂起态 + 每图审批预算递减（`runner.ts:684-751`）
- 计费台账：`CodexPetImageCall` 以 FOR UPDATE 行锁 + dispatching→sent→succeeded 状态卡在 fetch 前后（`codex-pet-call-ledger.ts:68-209`），防 crash 后重复发起付费调用——此机制来自一次真实计费事故（存在 215 行的 `codex-pet-per-image-billing-correction.ts` 事后矫正脚本）
- 控制流靠 7 类异常在 `executeCodexPetRun` 的 catch 链（`runner.ts:5044-5109`）逐一分派恢复策略

### 1.5 connector-protocol：自研的 MCP 等价物

桌面端零 LLM 调用，纯工具执行节点；云端 agent 循环（`agent/run.ts:204` 唯一的 `messages.stream`）产出 tool_use 经 hub 下发桌面执行 22+ 个本地工具。与编排问题正交，**无论是否上框架都不动它**。

---

## 二、已自研的"框架能力"对照

| 框架能力 | 自研等价物 | 位置 |
| --- | --- | --- |
| Durable execution / replay | job 依赖图幂等重放 + 输入 revision 哈希缓存失效 | `codex-pet-runner.ts:851,937,1592` |
| Checkpoint | NovelCheckpoint 全量快照 + 回滚端点 | `novel/checkpoint-snapshot.ts` |
| Retry policy | BullMQ 退避 + 熔断 + QA 返修三层 | `novel/runner.ts:544-569` |
| Interrupt / human-in-the-loop | awaitingReview、三种 awaiting_*、审批预算、余额暂停 | `novel/runner.ts:508-542`、`codex-pet-runner.ts:684-751` |
| 事件流 / streaming | 事件表 + 单调 sequence + Redis pub/sub + SSE + Last-Event-ID | `novel/events.ts`、`codex-pet-events.ts` |
| Task queue | 4 条 BullMQ 队列 + outbox + 租约 | `novel/queue.ts`、`codex-pet-queue.ts` 等 |
| Model router | 按模型名多网关路由（monkey-patch 实现） | `packages/llm/src/client.ts:83-108` |
| 定时调度 | croner 只算表达式，调度是自研 setInterval + Redis SETNX | `scheduled/cron.ts:8-60` |

基础设施分析的自评：**与带持久化状态的编排框架重叠度 70%+**。

---

## 三、确凿的问题清单

按严重性排序：

1. **横向复制税**（最大的债，且框架解决不了）：
   - 4 份几乎相同的 BullMQ 连接样板（`novel/queue.ts:17-29`、`codex-pet-queue.ts:17-32`、`local-business-promo-queue.ts:17-29`、`codex-pet-cleanup.ts`），重试/去重语义却各不相同
   - 2 份同构 SSE 通路（`novel/routes.ts:319-368` vs `codex-pet-routes.ts:2519-2590`）
   - 3 套语义各异的断点恢复策略（novel 90s updatedAt / codex-pet 15min 心跳租约 / promo 纯 Bull 重试），差异靠长注释维系（`codex-pet-queue.ts:71-75`）
   - reserve/settle/refund 计费模板每条业务线各写一份
2. **`packages/llm` 过薄导致编排税外溢**：见 1.1，这是六份子系统报告里复现率最高的痛点。
3. **article-workflow 无恢复路径**：崩溃即永久卡死，用户侧无解。这是自研路线的真实事故案例。
4. **codex-pet-runner.ts 巨石**：单文件 5115 行、executeRun 单函数约 790 行（`:4032-4822`）、look 行修复逻辑 3 份拷贝（改一个参数要同步 6 处）、异常当控制流。
5. **零散缺陷**：scheduled dispatcher 对到期任务 `void exec` 火后不理且并发无上限（`scheduled/cron.ts:40`，`SCHED.maxConcurrent` 定义了没人用）；novel worker 靠 30 秒重写 progress=1 刷 updatedAt 对抗 stale 回收（`runner.ts:379-384`）；`novel-workflow/ports.ts` 三个端口接口零实现零引用是死代码；可观测性完全自研（手写 Prometheus 文本格式，`codex-pet-worker.ts:382-401`）。

---

## 四、三方对抗评估摘要

三个立场 agent 基于同一份代码事实互相较量，各自必须承认对方成立的点。

### 4.1 支持上框架（Temporal + Vercel AI SDK 双轨）

核心论点：项目已手写一个"三套语义互不一致的残缺版 Temporal"；确定性重放可消灭手写重放与租约/CAS 两类最大样板；article 卡死、dispatcher 无上限这类缺陷是 durable 框架默认杜绝的；历史计费事故说明手写 exactly-once 翻过车。选型上明确**不选 LangGraph**（本项目的"图"都很简单，难点在持久化与人审暂停，LangGraph 的 durable 能力绑平台托管）。

**其承认的反面**：计费幂等设施一行不能删，只是被包进 activity；Prisma 状态表投影层必须保留，迁移期有双写窗口；2 万+ 行编排测试大部分作废；bailian quirk、HTML guard、prompt 工程类痛点换任何框架都原样存在；codex-pet 迁移回归风险最高。

### 4.2 反对上框架（收敛式重构）

核心论点：框架核心能力已全部自研且经生产验证，引入框架是"为已有的东西付双份钱"；**三重硬约束**——① 计费与编排深度耦合且要求精确一次，框架 at-least-once 重放恰是最危险默认；② 状态表即产品接口（前端轮询、SSE 回放、admin 直查），换私有 checkpoint store 必现双状态源；③ 迁移成本与风险不成比例（复杂度集中在 codex-pet 一条线，其余没到需要框架的量级）。多数 pain point 是"缺内部共享库"而非"缺框架"。

**其承认的反面**：article 卡死是自研路线的真实事故，每条新线都可能重犯；复制税随业务线数量线性增长；可观测性落后（没有 Temporal Web UI 级调试体验）；巴士系数风险——自研引擎的正确性靠少数人头脑维系，Temporal 经验可招聘、自研引擎不可。

### 4.3 中立缺口分析

逐项盘点后：所有真实缺口按量级都落在"数百行自研 + 轻量组件"档，唯一接近框架量级的诉求是**未来新业务线**的 durable execution。三路工作量对比：全面上框架保守 3~6 人月且有双状态源风险；纯收敛 3~5 人周、零语义回归风险；折中 = 收敛 + 新线试点轻 durable 引擎（Inngest 的 `step.run` 幂等重放与现有 outbox/ensureJob 语义几乎同构，状态可留自家 Postgres）。

---

## 五、结论与建议路线

**现在不做整体框架迁移；做收敛式重构，框架试点位留给下一条全新业务线。**

按性价比排序（预估合计 3~5 人周，可与业务迭代并行）：

### 第 1 步：加厚 packages/llm（1~2 周，收益最大）

- 用显式 wrapper 类替换双层 monkey-patch（消灭 `as Create` 强转与 patch 顺序隐式依赖）
- 内置：分类重试（区分可重试/moderation/invalid_request）、统一超时、usage/model/latency 钩子（对接计费与后续可观测）
- zod 结构化输出 + 校验失败回灌 LLM 的 fix-loop（上限 2 次）——顺带补上 article 缺的"重试半边"
- `CHATGPT_MODELS`/bailian 路由解析收敛为唯一导出，删除 `codex-pet-model-contract.ts` 与 `codex-pet-visual.ts` 两处复刻
- 对外保留 `createLlmClient` 门面，20+ 调用方渐进替换

### 第 2 步：止血 article-workflow（约 1 周）

- 照抄 novel 的 outbox+BullMQ 模式（或按 ADR-004 走租约模式）补持久任务与 stale 收尸，消灭 fire-and-forget 卡死
- 放行卡死项目的恢复路径（`canRecoverArticleProject` 当前不放行 generating/revising）
- 修掉"文本 refund 但图片 charge 不回滚"的计费不对称

### 第 3 步：抽 packages/orchestration-kit（2~3 周，渐进）

收编横向复制：队列/连接工厂（统一 Redis 解析，按业务线声明 attempts/backoff）、通用 SSE 模块（事件表 + 单调 sequence + pub/sub + Last-Event-ID 回放，参数化表名）、租约/心跳/CAS helper（消灭 codex-pet 30+ 处手拼谓词）、reserve/settle/refund saga 包装器、progress reporter（消灭散落的进度百分比魔数）。**新业务线强制使用，存量只做机会性迁移、不重写。**

同期机会性拆分 `codex-pet-runner.ts`：executeRun 按 stage 拆函数、look 行修复三份拷贝合一、异常分派链表驱动化。

### 第 4 步：框架试点（下一条全新业务线上）

- 用 Inngest 类轻 durable 引擎（TS 原生、状态留自家 Postgres、`step.run` 与既有幂等重放语义同构）或 Temporal 做受控实验，验证后再讨论存量迁移
- **明确不做的两件事**：不引入 LangGraph.js 作核心编排（三条流水线全是线性+循环，图模型收益低于 20+ 调用点的迁移成本）；不把 novel/codex-pet 迁入任何框架的私有 checkpoint store（计费列、前端直查、租约语义三重耦合会制造双状态源）

### 重新评估触发条件（建议写进 ADR）

出现以下任一情况时，重新评估对**新业务线**引入 Temporal/Inngest：

1. 出现真正的运行时动态 DAG 需求（多 agent 团队自由编排、skill 市场用户自定义工作流）——现有编排全是静态步骤表，`pipelineForMode` 的差异化参数至今被下划线忽略
2. 第三条业务线需要 codex-pet 级别的 durable 语义（依赖图重放 + 多天级人审暂停 + 租约）
3. 微信触发的长任务/定时 agent 规模化，为每条新线手写 durable 语义的累计成本超过一次框架引入

---

## 附录：分析方法

- 读取阶段：6 个 agent 并行深读 `packages/llm`、novel 线、article 线、codex-pet 线、api 异步基础设施、connector-protocol + 设计文档，产出结构化报告（编排模式/调用点/框架等价物/痛点，均带文件:行号）
- 评估阶段：3 个 agent 分别持"支持上框架 / 反对上框架 / 中立缺口分析"立场，基于读取阶段的代码事实对抗论证，各自必须列出对方成立的点（concessions）
- 行号为 2026-07-26 时点快照，随代码演进会漂移；结论请以模式与文件为锚点复核
