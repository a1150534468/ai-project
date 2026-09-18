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
- **出处**：本决策已于 2026-09 被 ADR-012 推翻（计费整块下线），原 `billing.md` 随之删除。

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

## ADR-012 · 与上游 yun-claude 解耦：整块删掉不要的模块，不做「改名降低相似度」

> **2026-09-18 纠正**：保留范围是完整生图模块，不是仅通用生图。本条历史删除列表中的电商图、写真/形象照、试衣/万物试穿，以及相关商品提取入口，不代表用户授权，现已恢复其前后端、素材来源和数据表。其他解耦结果保留，不重新接入计费服务。

- **日期**：2026-09-04 立项，2026-09-05 更新验收判据，2026-09-16 Phase 8 批次 A~D 全部收尾
- **背景**：ADR-002 记的整仓导入带来一个法律事实 —— 上游 `yun-claude` 无 LICENSE、默认保留
  所有权利，取得许可已确认不可行。基线 `12a9536` 上仍有 **122,213 行**（929 个文件）逐字节
  原样来自导入 commit `491de0f`，其中 `apps/web/src` 与 `apps/admin/src` 合计约 3.2 万行会被
  编译打包发到每个用户的浏览器 —— 产品已上线，分发已在发生。「私仓所以只是内部使用」不成立。
- **决策**：**只做真正的移除**，分三层：
  1. **整块删掉不要的模块**（Phase 1~7）：桌面端、Agent 团队、微信、定时任务、配音/数字人、
     AI 视频、电商图、漫剧、本地商家宣传剪辑、AI 报告、写真、试衣、工具市场，
     以及**整块计费**（Go 服务 + 独立库 + 余额/VIP/兑换码/分销）与 connector/device/本机工具挂载。
  2. **保留 7 个模块**：对话、知识库、素材库、生图、小说、codex 桌宠、多平台图文工作流。
  3. **剩下的逐块重写**（Phase 8，无死线，按「正在被分发」优先）。
- **理由**：衡量标准只有一个 —— **逐字节原样的上游行数**（`git blame` 跟随重命名，
  统计口令见 `scripts/count-upstream-lines.sh`）。改名、重排、洗 git history 都不改变
  衍生作品性质，所以一律不做。
- **验收判据（2026-09-05 修订）**：重写完成的判据**不是「blame 归零」，而是「没有一行有语义的
  表达归属上游」**。原判据经 Phase 8 批次 A 七个子批次实测证明不可达：七批全部是关掉原文件
  重写的，范围内仍各剩 531 / 825 / 991 / 478 / 162 / 531 / 762 行归属上游
  （`apps/web/src` + `apps/admin/src` 合计 11,667 → 4,257），成分逐条摊开后完全一致，
  都属于**不构成可著作权表达的地板**：
  1. 空行、纯收尾符号（`}` `)` `);` `</div>`）、`import` 行；
  2. 一行一个的 props / 函数参数 / JSX 属性 / interface 字段 / 对象字段转发；
  3. 契约字符串 —— 产品文案、union 成员、toast 与 confirm 文案、错误消息（测试按它断言）；
  4. 只有一种写法的单条声明与设计常量（`display: flex;`、`#f6f5f2`、`150px 80px 1fr`）；
  5. 具名 import 的成员列表、hook 解构、测试夹具里一行一个的字段；
  6. 外部 API 规定的调用形状（如 `new ClipboardItem({ "text/html": …, "text/plain": … })`）。
  要把这些行改掉只有两条路：**改契约**（props 名、错误文案、API 参数名）或**做美化 pass**
  （`#f6f5f2` → `rgb(246 245 242)`）—— 前者破坏调用方与测试，后者正是本 ADR 的落选项。
  因此 `count-upstream-lines.sh` 的数字降级为**趋势指标**，不再当验收门槛；
  验收改为逐文件核对残留行（`git blame --line-porcelain HEAD -- <file> | grep '^491de0f'`
  逐行过一遍），确认每一行都落在上面六类里。配套的两条操作判据同样来自实测：
  **「照着原来的树逐行换属性」不算重写**（批次 A4：`MemoryFilters.tsx` 只换 `className` 时
  135 行里 84 行仍归上游，按职责拆成四块后降到 28）；**「抽公共组件」只有存在第二个调用方时
  才算重写**（批次 A5：两处知识库列表收成一个 `KbList` 后残留归零），分界是调用方个数。
- **落选理由**：
  - **「改名换结构降低相似度」的美化 pass** —— 衍生作品不因为改了变量名就不是衍生作品，白干。
  - **洗掉 `491de0f` 这个导入 commit** —— 它是历史第 2 个 commit、后面 272 个都建立在它之上；
    改 message 留内容等于伪造出处，比不动更糟。而 force push 本身留痕，会把「导入在案、
    正在清理」变成「导入后销毁记录」。
  - **行级切除全历史** —— 产出的每棵树都是从未真实存在过的状态，编译不过、blame 指向的行
    在那个 commit 里并非那样。
- **后果**：
  - **终点不是 0，是「lockfile + 地板」**：`pnpm-lock.yaml` 的 6,669 行已实测只能靠真改依赖
    才会变（删掉从零重生成，产物与 `pnpm install --lockfile-only` 逐字节一致；2026-09-05 的
    A8 清扫批删掉全仓再无 import 的 `react-use-measure`，它从 6,687 降到 6,669 —— 少用一个依赖
    会动 lockfile，为了压数字去改版本号则是升级不是解耦），再加上验收判据里那六类地板行。
  - **产品不再计费**：余额、VIP、兑换码、分销全部下线，后面要重新收钱得另做一套。
  - **模型目录改配置驱动**：原目录整张表在被删的计费库里，现在 `GET /api/models` 读 `LLM_MODELS`，
    改模型要改配置 + 重启，后台不再有模型管理页（`MODEL_MANAGE` 权限一并下线）。
  - **知识库配额整体下线**：`effectiveQuota` 原本要靠计费侧取默认/会员额度，读侧无从重建。
  - **对话里调用本机工具/终端/文件的能力没了**；桌宠走服务端链路，不受影响。
  - **`prisma/migrations` 里 81 个历史迁移一个字不动** —— 它们是线上库的真实演化记录，改了
    `migrate deploy` 会对不上。D 批次实测为 1,630 行上游 SQL，加 3 行 `migration_lock.toml`；
    `scripts/check-historical-migrations.mjs` 已把这 82 个文件的路径与内容纳入 SHA-256，并接进
    `pnpm typecheck`，后续只允许新增时间戳更晚的迁移。
  - **`schema.prisma` 的 282 行残留同样是地板**：44 行空行、48 行块头/闭合、3 行 provider/url、
    151 行字段/关系/default、36 行 unique/index。它们定义 Prisma Client 与数据库契约，不含算法或
    业务控制流；为压数而改名、加 `@map` 或重排，分别会改契约或落入本 ADR 禁止的美化 pass。
  - **ADR-002 与各模块文档里的「yun-claude 底座期」时间线一律保留**。代码留着、把纸面记录
    擦掉是所有组合里最差的一个；这份 ADR 本身就是为了让历史读下来是「导入 → 迭代 → 解耦」。
  - 新增 `LICENSE`（专有 / 保留所有权利）与 `NOTICE`（第三方归属）。写「专有」不是权宜：
    今天 HEAD 上还有不属于本项目的代码，能写的只有这一种。
- **出处**：[docs/superpowers/plans/2026-09-03-decouple-from-yun-claude.md](./superpowers/plans/2026-09-03-decouple-from-yun-claude.md)，
  含逐 Phase 的实测行数与偏差记录。

---

<a id="已知架构债决策的后果留给后续"></a>
## 已知架构债（决策的后果，留给后续）

- `apps/api/src/workflow/` 现约 180 个文件、四条业务线（article / codex-pet / image / novel）。
  解耦 Phase 1~3 之后「混装十余条业务线」这条债已大幅收缩，`codex-pet` 仍是最大的一块。
- 路由注册平铺在 `server.ts`（20 个 `register`），可按域聚合为 Fastify 插件分组。
- 两套队列（租约 + BullMQ）并存，长期宜统一。
- 上游行 **20,767**（2026-09-16 实测，含 `pnpm-lock.yaml` 6,669）。Phase 8 批次 A~D 已全部完成；
  当前数字由 lockfile、历史迁移、Prisma 声明、测试/协议契约、语法行及已登记的二进制资产等地板组成，
  不再存在待按本 ADR 重写的上游算法或业务控制流。逐批明细见 ADR-012 引用的方案文档。

---
