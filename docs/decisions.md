# 关键决策记录（ADR）

# 关键决策记录（ADR）

用 ADR（Architecture Decision Record）的方式记录「当时为什么这么选」。每条含背景、决策、理由、后果、出处。日期为该决策进入本仓库的大致时间；部分决策实际形成于 yun-claude 期。

---

## ADR-001 · 一切对话走 Anthropic Messages 协议，按模型名多网关路由

- **背景**：需要同时用阿里云百炼（qwen）、AI Pixel（gpt-5.x）以及旧 NewAPI 网关，且要能随时切换。
- **决策**：全部对话调用统一用 `@anthropic-ai/sdk`（`packages/llm/src/client.ts`），不做 OpenAI 协议转换；`LLM_PROVIDER` 决定主路由，`CHATGPT_MODELS` 白名单把 GPT 系列按模型名挂到 AI Pixel 的 Anthropic 兼容端点。
- **理由**：业务代码只认识一种消息形状，换网关/换模型只动环境变量；白名单顺带隔离上游的音频/Realtime/图片等非对话模型。
- **后果**：新增网关成本极低；代价是要维护 provider 归一化与按模型名的路由缓存。
- **出处**：[architecture/llm-integration.md](./overview.md)、[setup/model-providers.md](./overview.md)。

## ADR-002 · 底座整仓导入 yun-claude，而非从零重建

- **背景**：yun-claude 已有 721 commits 的成熟能力（聊天/知识库/记忆/计费/桌面/工作流）。
- **决策**：2026-07-10 以 `import merged yun-claude base` 整仓导入作为本仓库底座。
- **理由**：两周内成型的能力重写代价过高；导入后聚焦增量（百炼接入、小说重写、桌宠）。
- **后果**：继承了成熟度，也继承了历史包袱——`workflow/` 目录横向膨胀、BullMQ 与租约两套队列并存、部分文档端口/路径是旧值。
- **出处**：[项目时间线](#项目时间线)。

## ADR-003 · 计费独立成 Go 服务 + 独立数据库

- **背景**：计费涉及钱，需要强一致、可对账、故障隔离。
- **决策**：`services/billing`（Go + Gin，端口 8093）用独立 PostgreSQL，API 经内部 token 以 HTTP 调用；TS 侧仅保留薄客户端 `packages/billing`。
- **理由**：账本与业务库物理隔离，业务库故障不影响对账；reserve/settle/refund 幂等语义集中一处实现；Go 适合这类强一致小接口集。
- **后果**：多一个服务与一套数据库要运维；跨服务调用需内部鉴权与网络可达性保障。
- **出处**：[architecture/billing.md](./overview.md)。

<a id="adr-004-用-postgres-租约模式做任务队列bullmq-仅存量"></a>
## ADR-004 · 用 Postgres 租约模式做任务队列（BullMQ 仅存量）

- **背景**：小说、桌宠等分钟级生成任务需要异步执行、可恢复、可观测。
- **决策**：Worker 独立进程轮询 + `SELECT ... FOR UPDATE SKIP LOCKED` 事务认领 + 心跳续租 + 过期回收；运行过程写事件表溯源。BullMQ 仅本地商家宣传一条存量业务线在用，不再扩大。
- **理由**：任务状态本来就要落库，用数据库事务认领免去「DB 与队列双写一致性」，少一个中间件；事件表天然支撑前端运行日志与事后排查。
- **后果**：秒级轮询延迟与数据库连接占用（对分钟级任务可接受）；两套队列并存增加心智，新业务线统一走租约。
- **出处**：[architecture/async-jobs.md](./overview.md)。

## ADR-005 · 向量用 pgvector 内置，统一 1024 维 HNSW

- **背景**：长期记忆、知识库、小说记忆都需要语义检索。
- **决策**：不引入独立向量库，用 Postgres + pgvector；统一 `text-embedding-v4`，固定 1024 维，三张向量表建 HNSW 余弦索引。
- **理由**：少一个存储组件，向量与业务数据同库同事务；PlotPilot 原用 ChromaDB，平移到 SaaS 后 pgvector 更省运维。
- **后果**：换 embedding 模型必然伴随重建索引的迁移（4096→1024 就踩过，见 [lessons/pitfalls.md](./pitfalls.md)）。
- **出处**：[architecture/data-model.md](./overview.md)。

## ADR-006 · 关键模型选择写成硬合同 + 显式允许名单

- **背景**：桌宠交付物依赖特定模型（生图 gpt-image-2、质检 gpt-5.6-sol），上游可能静默换模型或回退。
- **决策**：`codex-pet-model-contract.ts` 用显式允许名单（拒绝前缀匹配），非法模型抛不可重试的 `CodexPetModelContractError`，Worker 健康就绪前校验路由、禁止回退。
- **理由**：付费/交付链路的模型溯源必须可信；前缀匹配会被 `gpt-image-2-qwen-fallback` 类别名欺骗。
- **后果**：配置更严格（模型必须在白名单/路由中），但产物来源可信、失败不空烧配额。
- **出处**：[architecture/llm-integration.md](./overview.md)、[modules/codex-pet.md](./codex-pet.md)。

## ADR-007 · 前端 Studio + Model 分层、刻意少依赖

- **背景**：十余条工作流业务线，UI 复杂但需保持可测、可维护。
- **决策**：每条业务线 = `XxxStudio.tsx`（薄视图）+ `xxxStudioModel.ts`（不依赖 React 的纯逻辑）+ `xxxApi.ts`（客户端）+ 同名测试；不引入路由库、全局状态库、组件库。
- **理由**：业务逻辑脱离 DOM 单测，视图重构不动逻辑；少依赖降低升级与体积负担。
- **后果**：跨页共享状态靠手写模块与约定，规模再大需要更强约束；目前靠 Studio+Model 模式支撑良好。
- **出处**：[architecture/frontend.md](./overview.md)。

## ADR-008 · 小说引擎按 PlotPilot 概念用 TS 重写，而非内嵌 Python 服务

- **背景**：小说模块需要 PlotPilot 那套叙事状态管理能力，但 PlotPilot 是 Python/FastAPI + SQLite/ChromaDB 的单机内核。
- **决策**：2026-07-14 用 TypeScript 在本仓库重新实现其五大子系统，状态进 Postgres、执行进独立 Worker，接入平台计费与配额；不内嵌 Python 服务。
- **理由**：保持单一技术栈与统一运维；把单机内核平移成多租户 SaaS 形态；SQLite 单写者路由由 Postgres 事务 + `project-lock.ts` 替代。
- **后果**：小说域数据模型最重（约 35 张表）；获得与其余模块一致的部署/计费/可观测性。
- **出处**：[modules/novel.md](./novel.md)。

## ADR-009 · 计划驱动开发 + POC 环境开关

- **背景**：功能复杂、涉及真实外部配额，需要在动手前对齐设计、又不能让日常测试烧钱。
- **决策**：成熟业务线先写 plan/spec 再实现（[plans/](./README.md) 原样归档）；真实外部链路的验证测试用环境开关显式触发（`RUN_EMBEDDING_POC=1`、`RUN_GPT_IMAGE_EDIT_POC=1`、桌宠 `*.poc.test.ts`）。
- **理由**：计划文档留存「当时怎么想」；POC 开关把真实配额消耗与日常 `pnpm test` 隔离。
- **后果**：`turbo.json` 需 `passThroughEnv` 透传敏感变量，测试与真实凭据的边界靠开关纪律维持。
- **出处**：[architecture/llm-integration.md](./overview.md)、[setup/local-dev.md](./overview.md)。

## ADR-010 · 图文正文编辑器用 DOM 型（Squire），不用 schema 型

- **背景**：公众号正文是 AI 生成的 `section` 多层嵌套 + 纯内联样式 + `data-ai-assistant-image-slot` 锚点。原先用 wangEditor（底层 Slate），**打开编辑器就把版式拍平**，1.5 秒自动保存随即把拍平结果写回库，成品被覆盖。已实测毁掉两行数据。
- **决策**：换 `squire-rte`（2.4.8，MIT，零依赖，自带类型）。HTML 白名单收敛到一份共用词汇表 `packages/article-workflow/src/html-vocabulary.ts`，服务端 guard 与前端 sanitizer 同源。
- **理由**：编辑器分两类——**schema 型**（Slate / ProseMirror，含 wangEditor、Tiptap）把 HTML 解析进内部模型，模型里没声明的标签在**载入阶段**就被剥掉或规范化；**DOM 型**（Squire、SunEditor、原生 contentEditable）拿 DOM 当真源。我们要的是「原样保留」，只有后者的语义对得上。Squire 另有两个恰好合用的性质：`allowedBlock` 正则本身就含 `SECTION`；`setHTML` 置 `_ignoreChange` 因而**不触发 `input` 事件**，等于自带一道「用户意图」闸门。
- **落选理由**：Tiptap 是 ProseMirror，与 wangEditor 同属 schema 型、同一失效模式，用 atomic node 兜住嵌套 section 又会让内容不可编辑，与「生成后可继续编辑」直接冲突。TinyMCE 8 自托管需 GPLv2+ 或付费 key，闭源 SaaS 用不了。
- **后果**：Squire 的 `stylesRewriters` 是模块级常量、**不可配置**，载入时必做等价改写（`strong→b`、`em→i`、空块补 `br`）。因此组件必须同时留住原始字节：用户没编辑时把原字符串交回上层，让哈希比对判成「无变化」，不产生写库。用户真的编辑后，改写会随之落库——等价且在白名单内，可接受。
- **出处**：[docs/superpowers/plans/2026-07-28-multi-platform-article-workflow.md](./superpowers/plans/2026-07-28-multi-platform-article-workflow.md) 附录 A、[pitfalls.md](./pitfalls.md)「富文本编辑器静默拍平生成结果」。

---

## ADR-011 · 图文配图在正文里存代理地址，出参时现签短期签名

- **背景**：`storeWorkflowImage` 在对象存储端点是 localhost 且没配公网前缀时返回 base64 data URL，而图文工作流把这个地址写进 `bodyHtml` 的 `<img src>` 与 `imageManifestJson`。同一张图存了三份（正文 + `imageUrl` + `thumbnailUrl`），线上实测 4 张图的一篇稿子 `bodyHtml` 10.5 MB、详情接口 **31.6 MB / 0.602 s**，编辑器每次自动保存都要把这 10.5 MB 发回来再过两遍 XML 解析。
- **决策**：三种地址形态分工明确——
  - **落库**：`/api/workflow/article-workflow/images/<assetId>/blob`，稳定、不带签名。
  - **出参**：序列化时现签一份 `?exp=<ms>&sig=<hmac>`（TTL 6 小时，密钥用 `SESSION_SECRET`），`bodyHtml` 与 manifest 的 `imageUrl`/`thumbnailUrl` 都签。写进 HTML 属性时 `&` 转义成 `&amp;`。
  - **保存**：落库前用 `articleWorkflowStableBodyHtml` 把签名摘回去。
  取图路由接受「有效签名」**或**「会话 + 资产归属」，任一成立即可。
- **理由**：三条约束互相挤压，只剩这一种解。① 正文要落库，所以存进去的地址必须长期有效，签名地址会烂成死链；② 页面里的 `<img>` 是浏览器自己发的请求，带不上 `Authorization` 头，而 web 端登录态只在 `localStorage`（不是 cookie），所以只靠会话鉴权的地址在页面上必然是碎图；③ 不能改 MinIO 桶策略让配图公开可读（实测匿名 GET 是 403，放开等于把所有用户的配图变成公网可读，是基础设施/安全决策）。把「稳定」交给库、「能取到」交给出参，是唯一同时满足三条的切法。既有的 `image-routes.ts` 就是这个模式，不算新花样。
- **落选理由**：直接配 `S3_PUBLIC_BASE_URL` 看着最省事，但前提是桶公开可读，见上。把 data URL 原样留在库里则是原始故障本身。
- **后果**：
  - 出参地址每次都不一样，所以**前端脏判定必须先摘掉签名再算哈希**（`articleWorkflowDraftHash` 里的 `withoutImageSignature`）。不摘就会出现「编辑器手里是旧签名、基线是新签名」，这行永远脏着、自动保存每 1.5 秒撞一次。
  - 没配对象存储时（`objectKey` 为空）**必须原样保留 data URL**——那时它是图片的唯一副本，换成代理地址就是把图弄丢。
  - 「一键复制到公众号」仍然要求配 `S3_PUBLIC_BASE_URL` / `IMAGE_S3_PUBLIC_BASE_URL`：公众号是服务端抓图，data URL 和需要鉴权的相对地址它都拿不到。这一条与本决策无关，是原本就有的部署前提。
- **出处**：[pitfalls.md](./pitfalls.md)「配图 base64 写进正文」。

---

<a id="已知架构债决策的后果留给后续"></a>
## 已知架构债（决策的后果，留给后续）

- `apps/api/src/workflow/` 已约 250 个文件、混装十余条业务线，`local-business-promo`（52）与 `dub`（42）最值得像 novel 那样拆独立目录/包。
- 路由注册平铺在 `server.ts`（40+ `register`），可按域聚合为 Fastify 插件分组。
- 两套队列（租约 + BullMQ）并存，长期宜统一。
- 部分导入文档端口/路径为 yun-claude 旧值（如桌面 README 的 5173），以 [setup/local-dev.md](./overview.md) 为准。

---
## 已知架构债

- `apps/api/src/workflow/` 约 250 个文件、混装十余条业务线，`local-business-promo`（52）与 `dub`（42）最值得拆独立目录。
- 路由注册平铺在 `server.ts`（40+ register），可按域聚合为 Fastify 插件分组。
- 两套队列（租约 + BullMQ）并存，长期宜统一到租约模式。
- 部分文档端口/路径为 yun-claude 旧值，以各模块文档为准。
