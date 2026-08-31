# 知识库 / 素材库拆分执行计划

**Created:** 2026-08-31 · **Baseline:** `main` @ `f0be226` · **Status:** 🚧 执行中（14/23 项，P0 + P1 + P2 + P3.1 + P3.2 + P3.3 已完成，下一步 P3.4 —— 重新定义 `pruneImages` 的保留策略）

**决策（已拍板，不再讨论）**：AI 产物**不再落知识库**。删掉 `AI_ARTIFACTS` 系统库与全套自动归档触发器；知识库回到「官方知识库 + 个人自建知识库」两类；可复用媒体素材进新的**素材库**；长文本成品留在各自工作流；运行报告留在运行详情。

**本计划的两个核心产出**：第一部分是**问题全清单**（拆分要解决的东西，逐条带 `path:line`）；第二部分是**产物分类裁定**（哪些落素材库、哪些不落、依据什么规则）。第三部分才是执行顺序。

---

## 溯源：这套东西是怎么进来的

引入 commit 是 `4b552c2`（2026-07-17），36 文件 `+1035/-1231`，message 写的是「删除了"监控与 DAG"独立标签」——那句话对应的 diff 是 `NovelRunCockpit.tsx` 里删掉一行标签数组元素。同一提交里夹着 335 行触发器 + 4 个新列 + 2 个跨表唯一索引 + 一次全用户全产物回填，外加配额包整条下线。

`docs/` 整体是 2026-08-17 才第一次进 git，比这个迁移晚一个月；11 条 ADR 无一涉及 `systemKey` / `sourceType=ARTIFACT`；全部 commit 的 md 历史里 grep「素材库|作品库」零命中——**是没比较过替代方案，不是比较后选了知识库**。

唯一带「理由」性质的文字是 [`apps/api/src/kb/indexer.ts:313`](../../../apps/api/src/kb/indexer.ts) 的注释「自动归档产物是平台能力，不重复向用户收取知识库索引费用」。那次改动的主题是**知识库的钱怎么算**，在那个框架里把产物挂进已有的配额/索引/计费三条管道是高效的；只是那个框架里没有「知识库该装什么」这个问题的位置。

**机制性教训（写进本计划的验收项）**：含迁移的 commit 不与功能改动混提；触发器必须有集成测试才能进主干。当前 335 行 SQL 零测试覆盖（全仓 grep `ImageAsset_archive` / `archive_image_asset` / `ai_artifact_` 在 `.ts/.tsx` 里零命中），是这次拆分最大的单点风险——**删之前必须先有测试钉住现状，否则删错了没人知道**。

---

## 范围边界（明确不做什么）

- **不做「素材库也能被 RAG 检索」**。素材库不建向量索引、不建第二条检索链路、不建第二个越权校验入口。需要让 AI 引用某个产物时，走 P4 的手动策展路径（「加入我的知识库」）。
- **不动 `services/billing`（Go）**。
- **不动 RAG 检索算法**（topK / minScore / rerank 一律不调）。删掉产物库之后 `resolveEffectiveKbIds` 的候选集合自然收敛，不需要改打分。
- **不重构 codex-pet runner**。P0 只解「ready 判据依赖 `knowledgeDocumentId`」这一处耦合，不碰 `codex-pet-runner.ts` 的拆分（交由既有计划）。
- **不改各工作流自己的产物展示**。小说「作品空间」、漫画「资产 tab」、文章项目列表、本地商家「素材资料」四分组都保持原样——它们是长文本成品的正确归宿，本计划只是**不再往知识库复制一份**。
- **不做用户注销 / 数据导出**。`KnowledgeBase.userId` 缺 FK 到 `User`（[`schema.prisma:251`](../../../packages/db/prisma/schema.prisma)、建表迁移 `20260628124422_kb_and_quota/migration.sql:15` 无 FK 约束）单独立项。

---

## 第一部分：问题全清单

来源：2026-08-31 的九路只读取证（检索 / 索引与配额 / 前端信息架构 / codex 产物 / 历史溯源 / 生命周期，加两路对抗复核与一路裁定）。**全部为静态取证**：没连数据库、没跑测试、没比对生产库 `pg_trigger`。标注「结构性」的条目是代码文本已确认、运行时后果未实测。

每条后面标注拆分后的归宿：**[删]** = 触发器一删即不存在；**[搬]** = 会跟着产物搬到素材库，必须在 P3 单独解决；**[留]** = 与本次拆分无关，独立立项。

### H 级（高）

**H1 — 归档同步跑在业务事务里，且全文零 `EXCEPTION` 兜底。** **[删]**
`archive_ai_artifact`、`ensure_ai_artifacts_kb` 与 10 个归档触发器函数没有任何异常兜底（整个 `20260717090000_ai_artifact_knowledge_base/migration.sql` 里 `EXCEPTION` 出现 **0** 次）。可达耦合点：小说落章整块在 `prisma.$transaction` 内（章节 upsert + 结构节点 + ChapterVersion + KnowledgeFact + 叙事账本 + 连续性资产），见 [`novel-task-persist.ts:151`](../../../apps/api/src/workflow/novel/novel-task-persist.ts)；ecom 生图落库同样在显式 `$transaction` 内，见 [`ecom-routes.ts:40`](../../../apps/api/src/workflow/ecom/ecom-routes.ts)。**一次纯登记动作失败，能把一次已经烧掉算力、内容已产出的业务写入整体回滚。**

**H2 — 单行 `KnowledgeBase` 锁热点。**（结构性）**[删]**
`ensure_ai_artifacts_kb` 的 `ON CONFLICT DO UPDATE SET "updatedAt" = "KnowledgeBase"."updatedAt"` 是**真实行更新**（自己赋给自己），行级排他锁持到事务提交（`migration.sql:34-35`）。结果：同一用户所有模块的产物写入被串行化到一行上；并发生图（[`image-task-runner.ts:99`](../../../apps/api/src/workflow/image/image-task-runner.ts) 的 `Promise.all` 多分支 upsert）互相排队；小说长事务持锁期间该用户其它模块归档全部阻塞；每次归档还在 `KnowledgeBase` 上留一个死元组。

**H3 — 孤儿文档 + 可点击死链，只增不减。** **[搬]** ← 本次最需要警惕的一条
`pruneImages` 在每次生图任务收尾都跑（[`image-task-runner.ts:127`](../../../apps/api/src/workflow/image/image-task-runner.ts)），只保留每用户最新 50 条图、连 S3 对象一起删，**全程不碰 `Document`**（[`image-route-helpers.ts:149-163`](../../../apps/api/src/workflow/image/image-route-helpers.ts)）。而豁免名单只有 `ecom-` 一个前缀——实测 `where: { userId, NOT: { requestId: { startsWith: ECOM_IMAGE_REQUEST_PREFIX } } }`，所以 `article:`（文章配图）、`comic:`（漫画分镜）、`portrait-request-`（形象照）、`pet-run-`（桌宠出图）**全部在裁剪范围内**。全仓零 DELETE 触发器、零孤儿回收 reaper。前端还给孤儿渲染可点击的「打开产物」外链且不校验对象存在（[`Knowledge.tsx:729-736`](../../../apps/web/src/pages/Knowledge.tsx)）。
**为什么标 [搬]**：这条的成因不是「存在知识库里」，是「删源行时不通知副本」。**素材库如果建新表，同样的孤儿会在新表里原样长出来。** 见第二部分「素材库不建表」的论证。

**H4 — 删除既非终态也不一致。** **[删]**
同一个文档列表、同一个删除按钮，三种结果：①媒体类（image/video/audio 只有 `AFTER INSERT`，`migration.sql:250-252`）删了永不回来；②8 个带 `UPDATE OF` 的模块下次更新原地复活——`ON CONFLICT DO UPDATE` 无 tombstone（`migration.sql:78`），而文章 PATCH 保存无条件写 `title/summary/bodyHtml`，正好命中该触发器的监听列（[`article-workflow-routes.ts:298`](../../../apps/api/src/workflow/article/article-workflow-routes.ts)）；③codex_pet 被 `archive_deleted` 永久拒绝。删文档路由只做 `assertKbOwner`，对 ARTIFACT / `sourceModule` / `systemKey` **零守卫**（[`kb/routes.ts:174`](../../../apps/api/src/kb/routes.ts)），而同一个 service 对系统库改名/删库是硬 403（[`kb/service.ts:99,130`](../../../apps/api/src/kb/service.ts)）——**保护漏在了文档粒度上**。团队在 codex_pet 路径里明确知道并规避了复活问题（[`codex-pet-cleanup.ts:169`](../../../apps/api/src/workflow/codex-pet/codex-pet-cleanup.ts) 注释原文 `without resurrecting the deleted knowledge document`），触发器路径没有任何等价保护。

**H5 — 召回污染没有出口，且 UI 文案在诱导用户打开它。** **[删]**
`resolveEffectiveKbIds` 是全仓唯一候选库解析函数（三条 RAG 链路：聊天 / 智能体团队 / 口播洗稿都走它）。`kbAttachAllOwn=true` 时无条件取该用户全部 `ownerType='USER'` 库，**函数全文不含 `systemKey`**（[`retrieve.ts:22-31`](../../../apps/api/src/kb/retrieve.ts)）。召回结果 `RetrievedChunk` 只有 `content/docName/ordinal/score`（`retrieve.ts:85`），SQL 谓词只有 `c."kbId" = ANY($2) AND d.status = $3`（`retrieve.ts:188`）——**下游即使想在召回后过滤，也拿不到「这条是产物还是资料」的判据**。`filterRelevantChunks` 只有全局条数与单文档条数上限，无 per-source 配额（`retrieve.ts:124`）；聊天总上限 4 条（`chat/routes-runtime.ts:23-28`），两篇产物文档就占满。
两个选择器都不过滤 `systemKey`（`ChatKnowledgePicker.tsx:93-95`、`agent-teams/KnowledgePicker.tsx:134-168`），而「你自己创建的 N 个知识库」的 N 把用户从没创建过的系统库计入（`useChatComposerState.ts:70`）。
**精确说法**：默认是关的（`kbAttachAllOwn` 初值 false，口播只接受显式 kbIds）。但用户一旦打开「我的全库搜索」，产物库全量进来且无法排除——库本身不可删。
**智能体团队那条更重**：它**根本不做向量检索**，按 `orderBy: { updatedAt: "desc" }, take: 2` 取每库最新 indexed 文档（[`agent-knowledge-context.ts:110-113`](../../../apps/api/src/agent-teams/agent-knowledge-context.ts)），与提问无关；而归档 upsert 每次刷新 `updatedAt`（`migration.sql:90`）→ **产物库永远排最前**。叠加 `AgentWorkflowRun.finalReport` 自己被归档（`migration.sql:266`），上一次报告会喂给下一次运行的 prompt。

**H6 — 重复 embedding 按「源行被 UPDATE 的次数」而不是「内容变化次数」计费。** **[删]**
`ON CONFLICT` 无条件把 `status` 打回 `pending`、`attempts` 归 0、清租约，**不比较 content**（`migration.sql:84-89`）。文章配图进度回调每张图都 `SET title + summary`，而 `ArticleWorkflowProject_archive` 正好监听 `bodyHtml/title/summary`（`migration.sql:258`）→ **一篇文章配 10 张图 ≈ 全文重嵌 10 次**（[`article-workflow-runner.ts:348`](../../../apps/api/src/workflow/article/article-workflow-runner.ts)）。同仓 `novel-vector-memory.ts:248` 已有 contentHash 跳过的现成模式，没用上。

**H7 — 平台 embedding 成本零可观测。** **[删]**
`settle` 被 `!doc.sourceModule` 跳过（[`indexer.ts:313-314`](../../../apps/api/src/kb/indexer.ts)），`tokensUsed` 写进 Document 但全仓无人读取/聚合（`indexer.ts:339`），billing 无流水。叠加迁移 backfill 对 `ImageAsset`/`VideoAsset`/`AudioAsset` **无 WHERE 全表扫描**排队（`migration.sql:274-295`，而小说那条反而有 `INNER JOIN` + 非空过滤），且 reaper 固定 20 条/30 秒、`orderBy: createdAt asc`（[`reaper.ts:38-50`](../../../apps/api/src/kb/reaper.ts)）→ **老产物排在用户新上传文档前面，队头阻塞**。

### M 级（中）

**M1 — codex_pet 产物吃用户上传配额。** **[删]**
两条归档路的配额账不一致：触发器路径 `sizeBytes` 硬编码 `0` 且 `DO UPDATE` 的 SET 列表也不含它（`migration.sql:68,78-90`），而 codex_pet 走 TS 路径写真实 ZIP 字节（[`codex-pet-archive.ts:347`](../../../apps/api/src/workflow/codex-pet/codex-pet-archive.ts)）。`usedBytes` 按 `kb.userId` 汇总所有 `status != 'failed'` 文档的 `sizeBytes`、**零 systemKey/sourceType 排除**（[`kb/service.ts:205`](../../../apps/api/src/kb/service.ts)），并被上传路径的 `assertQuota` 使用（全仓唯一调用点，[`kb/ingest.ts:220`](../../../apps/api/src/kb/ingest.ts)）→ **桌宠 ZIP 可以把 used 顶过 effective，随后用户自己上传直接 402**，而 UI 明写「媒体复用原文件，不会重复占用空间」（[`Knowledge.tsx:634`](../../../apps/web/src/pages/Knowledge.tsx)）。

**M2 — 用户上传的参考图被当成 AI 产物永久归档。** **[删]**
参考图 requestId 是 `ecom-reference:<uuid>`、prompt 写死 `image_reference_upload`（[`image-routes.ts:214,228`](../../../apps/api/src/workflow/image/image-routes.ts)），触发器无条件归档（`migration.sql:100,250`）→ 知识库里一条正文为「图片提示词：image_reference_upload」的**可召回**文档，而它在生图模块的历史里被 `ecom-` 前缀过滤掉、也永不被裁剪。

**M3 — 文档列表本身不可用。** **[部分搬]**
`GET /api/kb/:id/documents` 是 `findMany({ where: { kbId }, orderBy: createdAt desc })`——**无 take、无 skip、无过滤、无搜索**（[`kb/routes.ts:123-140`](../../../apps/api/src/kb/routes.ts)），前端同样无搜索框无分页。文档名精度只到分钟（`'AI 图片 · ' || to_char(createdAt,'YYYY-MM-DD HH24:MI')`，`migration.sql:98`）→ 同分钟多张图同名。`thumbnailUrl` 已写进 metadata（`migration.sql:101`）但前端从不渲染（`Knowledge.tsx:657-662`），唯一有预览图的是 codex_pet（`Knowledge.tsx:700-715`，被三条测试固化于 `Knowledge.codex-pet.test.tsx:202,235,265`）。
**为什么标 [部分搬]**：知识库那半会随产物清空而消失（知识库回到用户自己上传的几十份文档，分页不再是刚需）；但**素材库天生就是几百上千条媒体，分页/过滤/缩略图从第一版就必须有**，否则 M3 在素材库原样重演。

**M4 — 索引器被触发器踩。**（结构性）**[删]**
归档 upsert 把 `status` 打回 pending 并清 `lockedBy/lockedAt`，而 `claim()` 只要求 `status='pending'` 或租约过期的 `'indexing'`（[`indexer.ts:188`](../../../apps/api/src/kb/indexer.ts)）→ 第二个 worker 能抢走正在索引的文档，两边都跑「删旧 chunk + 插新 chunk」，而 `Chunk` 表只有 `kbId`/`documentId` 两个普通索引、**没有 `(documentId, ordinal)` 唯一约束**（`schema.prisma:532-544`）→ 可能留下重复分块与失真的 `chunkCount`。`attempts` 归零同时破坏有界重试（reaper 候选条件是 `attempts < maxAttempts`，[`reaper.ts:47`](../../../apps/api/src/kb/reaper.ts)）：源行每被碰一次，失败计数就清零。

**M5 — 统计口径污染。** **[删]**
用户侧「知识晶格数」（[`kb/service.ts:73`](../../../apps/api/src/kb/service.ts)）与管理端 `kbUploads*` / `kbUploadBytesTotal`（[`admin/analytics-routes.ts:218-220`](../../../apps/api/src/admin/analytics-routes.ts)）都是全量 count/sum `Document`，不区分 `sourceModule`。

**M6 — 「全部 AI 产物」覆盖面名不副实且不一致。** **[留]**
漏的：小红书/抖音文章 `outputKind=caption`，正文恒为 `bodyHtml=""`（实际内容在 `captionText`，[`platforms.ts:50`](../../../packages/article-workflow/src/platforms.ts)、[`article-workflow-runner-caption.ts:113`](../../../apps/api/src/workflow/article/article-workflow-runner-caption.ts)），被空正文守卫挡掉、永远不进库，但 `title/summary` 更新照样触发一次空转；`PortraitOutput` / `TryOnOutput` 两条后加的出图业务既无触发器也不写 `ImageAsset`。
多的：ecom 中间图 / 文章配图 / 漫画分镜——**用户在自己图库里根本看不到**（`listRecentImages` 排除 `ecom-` 前缀）却一张不落全部进库。
**为什么标 [留]**：这条证明「按表挂触发器」这个切法本身就抓不住业务语义。它不会因为换容器而消失，但也不该由本次拆分负责——第二部分的分类规则会给出正确切法，覆盖面缺口在 P3 按该规则重新核一遍。

**M7 — 触发器链路零测试覆盖。** **[删，但删之前必须先补]**
全仓（含 `.test.ts` / `.integration.test.ts`）grep 不到 `ImageAsset_archive` / `archive_image_asset` / `ai_artifact_` / `archive_ai_artifact` 任何一个标识符；有测试的只有后来手写的 codex_pet 应用层归档。`retrieve.test.ts` 用 `prisma.user.create` 建测试用户——**触发器已经在给每个测试用户建一个 AI 产物库，而全部断言是 `toContain`，没有一条会注意到**。
**这既说明现状零回归保护，也说明 P1 的删除不会打破现有测试——恰恰是最危险的情况：删对了删错了都是绿的。**

### L 级（低 / 形状缺陷）

**L1 — HTML 进向量库。** **[删]**
文章产物存 raw `bodyHtml` 却标 `text/plain`（`migration.sql:161`）；ARTIFACT 文档强制按 `text/plain` 读 `Document.content`、**从不回源 S3**（[`kb/deps.ts:30`](../../../apps/api/src/kb/deps.ts)）；`parseDocument` 对 `text/plain` 只做 `buf.toString('utf8').trim()`、无任何 HTML 清洗（[`kb/parse.ts:73`](../../../apps/api/src/kb/parse.ts)）→ 标签被原样切块嵌入，并作为「参考资料」前 200 字进 systemPrompt（[`chat/routes.ts:355`](../../../apps/api/src/chat/routes.ts)）。

**L2 — 唯一键不含 userId 且 `kbId` 被无条件覆盖。**（当前不可达）**[删]**
唯一索引是 `("sourceModule","sourceId")`、主键是 `'ai_artifact_' || md5(module || ':' || sourceId)`，均不含 userId（`migration.sql:11`）；`ON CONFLICT DO UPDATE` 里 `"kbId" = EXCLUDED."kbId"` 是无条件覆盖（`migration.sql:79`）→ 同一 `(module, sourceId)` 以另一 userId 归档时，文档会**静默搬进另一个用户的库**而不是报错。当前代码不可达（sourceId 恒为源表 cuid，全局唯一；grep 不到改 owner 的路径），但 DB 层不设防。对照：同一唯一键上的 codex_pet 路径显式校验 `kb.userId` 并抛 `source_conflict`（[`codex-pet-archive.ts:379`](../../../apps/api/src/workflow/codex-pet/codex-pet-archive.ts)）。

**L3 — 小说触发器缺关联行兜底。**（当前不可达）**[删]**
`archive_novel_chapter_trigger` 用非 STRICT 的 `SELECT * INTO`（`migration.sql:141`）：project 查不到时不报错，`v_project` 全字段 NULL → `md5(NULL)` 为 NULL → 往 `KnowledgeBase."id"` 插 NULL 违反 NOT NULL，错误冒泡到章节写入事务。当前被 `NovelChapter.projectId` 的普通外键挡住（`schema.prisma:1186`）。同一迁移的 backfill 用了 `INNER JOIN` 防护（`migration.sql:297`）、`archive_scheduled_report_trigger` 用了 `COALESCE` 兜底（`migration.sql:234`）——**说明这是漏写而非统一风格**。

**L4 — 清空源内容不会清空归档。** **[删]**
空内容守卫是 `RETURN NEW`（不删文档，`migration.sql:216`）。`failRun` 会把已存在 run 的 `finalReport` 写成空串（[`agent-workflow-store.ts:143`](../../../apps/api/src/agent-teams/agent-workflow-store.ts)）→ 触发器直接返回，**上一版报告永久留在知识库里并继续参与检索**。

### 单独立项（不并入本计划）

**X1 — codex_pet 把「写进知识库」绑成 ready 的硬前置。**
`knowledgeDocumentId` 被写进状态更新的 where 谓词（[`runner-archive.ts:271-279`](../../../apps/api/src/workflow/codex-pet/codex-pet-runner/runner-archive.ts)），归档重试到上限即判运行失败并**全额退款**（`docs/codex-pet.md:487`）。这是 codex-pet 自己的架构决定，不是「产物该不该进 KB」的账；但它是**一个事后登记动作能否掉一次已交付付费运行**的真实耦合。
**注意**：本计划的 P0 必须先解开它才能往下走，但「把归档降级为 best-effort + 后台补偿」这个更大的改造独立立项。

---

## 第二部分：产物分类裁定（本计划的核心）

### 为什么必须先分类

「工作流产物」这个词把**三个正交维度**压平成了一个：

| 维度 | 取值 |
|---|---|
| **形态** | 媒体二进制（图/视频/音频/精灵图） · 长文本 · 结构化包（ZIP/JSON） |
| **来源** | AI 生成 · 用户上传 |
| **角色** | 交付成品 · 可复用原料 · 中间件 · 运行证据 · 输入素材 |

现状的 10 个触发器**只按「表」切**，所以三个维度全被压平：`ImageAsset` 一张表里同时装着用户的成品图、电商中间拼图、文章配图、漫画分镜、形象照、桌宠出图、以及用户自己上传的参考图——触发器一视同仁全归档。这就是 M6（覆盖面名不副实）和 M2（参考图被当产物）的共同根因。

**如果素材库沿用「按表收」这个切法，只是换个容器堆同一堆东西。** 所以准入规则必须同时用三个维度。

### 准入规则

一条产物进素材库，必须同时满足：

1. **形态 = 媒体二进制。** 长文本一律不进（它不是「素材」，是「作品」）。
2. **角色 ∈ {交付成品, 可复用原料, 用户上传的输入素材}。** 中间件与运行证据不进。
3. **没有更合适的家。** 已有专属工作台/项目视图承载的，留在原地，素材库最多做引用。

第 3 条是最容易被忽略的。判据是**「用户会去哪里找它」**：找一章小说会去小说工作台，找一张图会去哪里？——目前没有地方（`listRecentImages` 只给最新 50 条的横向 strip）。**素材库要填的正是这个空缺，而不是给已有入口的东西再建一个入口。**

### 逐类裁定

**落素材库（4 类，全部是媒体，全部已有权威表）**

| # | 类型 | 权威表 | 裁定 | 依据 |
|---|---|---|---|---|
| 1 | 生图成品 | `ImageAsset`（裸 `req-*` 前缀） | ✅ 进 | 形态=媒体，角色=交付成品，且**当前无处可找**（`listRecentImages` 只给最新 50 条 strip，超出即被 `pruneImages` 连 S3 一起删）。素材库是这类东西第一次有正式的家。 |
| 2 | 生成视频 | `VideoAsset` | ✅ 进 | 同上。 |
| 3 | 生成音频 | `AudioAsset`（`kind='narration'` 等 AI 产出） | ✅ 进 | 同上。**但要按 `kind` 分区**，见下方「音频的三种角色」。 |
| 4 | 口播成品视频/音频 | `DubProject.finalVideoUrl` / `resultVideoUrl` / `audioUrl` | ✅ 进（只进媒体那半） | 形态=媒体、角色=交付成品，且可被二次剪辑复用。**`DubProject.script` 那半不进**——现状的 `DubProject_archive` 同时监听 `script` 和三个媒体 URL（`migration.sql:264`），**一条记录同时是文本又是媒体，这正是「按表收」必然产出的畸形**。 |

**不落素材库 — 长文本成品，留在各自工作流（6 类）**

| # | 类型 | 权威表 | 已有的家 | 裁定 |
|---|---|---|---|---|
| 5 | 小说章节 | `NovelChapter` | 小说工作台「作品空间」 | ❌ 不进。且小说自有 `NovelVectorMemory` 做语义检索，**从来就不需要 KB**。 |
| 6 | 文章全文 | `ArticleWorkflowProject` | 文章项目列表 | ❌ 不进。 |
| 7 | 漫画剧本 | `ComicWorkflowScriptVersion` | 漫画 episode + 资产 tab | ❌ 不进。且它是**版本**（`versionNo`），版本历史属于工作流内部，不该外泄到全局库。 |
| 8 | 宣传片脚本 | `LocalBusinessPromoProject` | 项目自身即容器（`sourceId` 就是 project id） | ❌ 不进。归档它等于把项目复制一份。 |
| 9 | 智能体任务报告 | `AgentWorkflowRun.finalReport` | 运行详情页 | ❌ 不进任何库。**角色=运行证据**，脱离 `taskGoal` 无意义。现状它被自己归档后喂给下一次运行的 prompt（H5），是 bug 不是 feature。 |
| 10 | 定时任务报告 | `ScheduledTaskRun.reportText` | 任务运行历史 | ❌ 不进任何库。纯流水，**量最大、单条价值最低**，每次运行一条。 |

**不落素材库 — 中间件与运行证据（同表内按角色剔除）**

| 来源 | 识别方式 | 裁定 |
|---|---|---|
| 电商中间图 | `ImageAsset.requestId` 前缀 `ecom-` / `ecom-stitch:` | ❌ 不进。**系统已经认定它们不属于用户图库**——`listRecentImages` 明确排除该前缀。 |
| 文章配图 | 前缀 `article:` | ⚠️ 进，但归到所属文章项目下、默认折叠。它是媒体且用户可能想单独取用，但主入口应是文章项目。**注意它当前不在 `pruneImages` 豁免名单里，会被连 S3 删掉**（H3）。 |
| 漫画分镜图 | 前缀 `comic:` | ❌ 不进。漫画已有「资产 tab」，规则 3 命中。同样不在豁免名单、会被删（H3）。 |
| 形象照/试穿输出 | 前缀 `portrait-request-` / `portrait-pending-`；`PortraitOutput`/`TryOnOutput` | ✅ 进。形态=媒体、角色=交付成品。**注意这两条业务当前既无触发器也不写 `ImageAsset`**（M6 漏的那半），素材库要主动纳入。 |
| 桌宠运行证据 | `CodexPetArtifact.kind` ∈ `qa_report` / `qa_contact_sheet` / `direction_qa` / `direction_blind_qa` / `frame` / `base_candidate` / `pose_board*` / `identity_guide` / `look_row` / `look_cardinals` / `cardinal_anchor_strip` / `package_source_atlas` / `direction_registration_*` / `knowledge_archive` … | ❌ 不进。一次桌宠运行产生 **20+ 种** artifact kind，绝大多数是中间件与质检证据。 |
| 桌宠交付物 | `kind` ∈ `final_package` / `package` / `preview` / `animation_preview` | ✅ 进。**白名单已经在数据里**：`CodexPetRun` 自己有 `spritesheetArtifactId` / `packageArtifactId` / `previewArtifactId` / `selectedBaseArtifactId` 四个指定列（`schema.prisma:331-400`）——**run 已经声明了哪几个 artifact 是有意义的，素材库直接用这四个指针，不要扫 `CodexPetArtifact` 全表**。 |

**音频的三种角色（`AudioAsset.kind` 必须分区）**

- `narration` — AI 生成旁白 → ✅ 进「AI 生成」区（[`local-business-promo-audio-helpers.ts:201,225`](../../../apps/api/src/workflow/local-business-promo/local-business-promo-audio-helpers.ts)）
- `bgm` — 用户上传的背景音乐 → ✅ 进「我上传的」区（[`local-business-promo-audio-upload-routes.ts:87`](../../../apps/api/src/workflow/local-business-promo/local-business-promo-audio-upload-routes.ts)）
- `voice-sample` — 音色样本 → ✅ 进「我上传的」区，但标为**输入素材**（`local-business-promo-audio-upload-routes.ts:41`）

**用户上传的输入素材（现状被误当成 AI 产物）**

`ecom-reference:` 参考图（M2）、`PortraitReferenceAsset`、`TryOnReferenceAsset`、`bgm`、`voice-sample`、`DubBgmPreset`——这些**是素材，但不是 AI 产物**。
（P3.3 复核更正：`DubBgmPreset` 列在这里是错的，它**没有 `userId`**，是带后台 CRUD 的平台预设目录，不是用户上传物；用户自己传的 BGM 在 `AudioAsset(kind='bgm')`。两张 `*ReferenceAsset` 也判为不收，理由见 P3.3。）
这恰恰说明「素材库」比「AI 产物库」是更正确的容器名：**素材库天然应该同时装「我上传的」和「AI 生成的」**，并用来源维度分区。而现状那个叫「AI 产物」的库把参考图混进去，正文写成「图片提示词：image_reference_upload」，是概念错位的直接证据。

### 裁定汇总

**11 类「产物」里，只有 4 类主体 + 3 类补充该进素材库，且全部是媒体、全部已有权威表。6 类长文本一个都不进——它们的正确归宿是「什么都不做」，因为权威表和前端入口本来就都有。**

### 素材库不建新表（本计划最重要的约束）

**事实**：产物本体从来不在知识库里。媒体本体在 S3 + `ImageAsset`/`VideoAsset`/`AudioAsset`/`CodexPetArtifact`，长文本在 `NovelChapter`/`ArticleWorkflowProject`/…。KB 里的 `Document` 只是**一份登记副本**——ARTIFACT 文档强制读 `Document.content`、**从不回源 S3**（`kb/deps.ts:30`）。

因此上表全部 4+3 类都已有权威表，**素材库 = 这几张表的聚合读模型**：

- ✅ **不新增 `MaterialLibrary` / `MaterialItem` 表**
- ✅ **不新增向量索引与第二条检索链路**
- ✅ **不做数据搬迁**（只删 KB 侧的 ARTIFACT 副本）

**为什么这条是硬约束而不是偏好**：H3（孤儿死链）的成因是「删源行时不通知副本」。新表就是第三份副本，就要有第三套同步——而这套同步的 bug 正是现在这 335 行触发器。**建新表 = 把 H1/H2/H3/H4/H6 原样搬到新表上重写一遍。** 读模型没有同步问题：查不到就是没有，源删则自然消失，**孤儿结构性地不可能存在**。

**代价（必须承认）**：跨 4 张表的 UNION 分页与统一排序会比单表难写，`createdAt desc` 全局排序在数据量大时需要每表各取 N 再归并。这是本方案唯一的实现复杂度集中点，但它是**查询层**的复杂度，不是**一致性**的复杂度——后者才是会长期流血的那种。

### 会丢的能力，以及怎么补

拆完之后「让 AI 引用我自己产出的东西」这个能力消失。当前这个能力质量极差（图片产物在向量库里就一条「图片提示词：xxx」；智能体那条按 `updatedAt` 取最新 2 篇、与提问无关），但方向是对的。

**补法（P4）**：素材库与各工作流成品页给一个「加入我的知识库」按钮，走现有手工上传/ingest 链路，以 `sourceType='TEXT'` 落进用户**自选的个人知识库**、计入用户配额、可正常删除。

这不只是补偿，**它恰好把知识库的语义恢复成应有的样子**：入库 = 人主动声明「这值得被引用」，而不是系统偷偷塞进来。

---

## 第三部分：执行顺序

**总原则**：先补测试 → 再解耦 → 再停写 → 再清存量 → 最后才做素材库页面。**前四步做完已拿到约 90% 收益**（H1/H2/H4/H5/H6/H7 + M1/M2/M4/M5 + L1–L4 全消失），素材库页面可以慢工出细活。

### P0 — 先给现状上锁（删之前必须做）

M7 说明现状零回归保护：**删对了删错了都是绿的**。所以第一步不是删，是钉住现状。

- [x] P0.1 写第一个触发器集成测试（当前 335 行 SQL 零覆盖）：插 `ImageAsset` → 断言 `Document` 出现且 `sizeBytes=0`；删源行 → 断言 `Document` **残留**（钉住 H3 现状）；重复 UPDATE 同内容 → 断言 status 被打回 pending（钉住 H6 现状）；`$transaction` 内让归档抛错 → 断言主业务**一起回滚**（钉住 H1 现状）。
  → [`apps/api/src/kb/ai-artifact-triggers.integration.test.ts`](../../../apps/api/src/kb/ai-artifact-triggers.integration.test.ts)，7 例全绿。H1 的抛错手法：抢占触发器的确定性主键 `ai_artifact_<md5(module:id)>` 并挂到另一组 `(sourceModule, sourceId)` 上，`ON CONFLICT` 只处理后者 → `Document_pkey` unique_violation 原样抛出 → `ImageAsset` 插入被回滚。另外钉了两条：`KnowledgeBase.updatedAt` 自赋值不变（是纯拿锁的空写），`chunkCount`/`tokensUsed` 不在 upsert 的 SET 列表里（旧 chunk 计数留在原地）。
- [x] P0.2 清点存量影响面（只读，需连库）：`AI_ARTIFACTS` 库数、`sourceType='ARTIFACT'` 文档数、其 `Chunk` 数、`sum(tokensUsed)`。这决定 P2 是一次性删还是分批。
  → **2026-08-31 实测（`localhost:5433/ai-assistant`）：**
  - 11 个触发器确认在库（10 归档 + `User_ai_artifacts_kb`）——未验证项 1 消除。
  - `AI_ARTIFACTS` 系统库 **9,563** 个，用户自建库 **17** 个 → **99.8% 的知识库行是系统自动开的产物库**。
  - `Document`：ARTIFACT **1,265** / FILE 6 / TEXT 2 → 用户真实上传一共 **8 篇**。
  - ARTIFACT 状态：**failed 1,086 / indexed 179，失败率 86%**。其中 **1,080 条是同一个原因**：`embeddings 400 ... Access denied, please make sure your account is in good standing`，`attempts` 全部 = 3 已耗尽。**这 1,080 条永久占位、永不重试、用户不可见也删不掉。**
  - `Chunk` 总数 **211，全部来自 ARTIFACT 文档**；用户上传的那 8 篇一个 chunk 都没有。
  - `tokensUsed` ARTIFACT 合计 **121,391**，是真金白银的 embedding 花费。
  - **配额污染确认（M5 从「待核」升级为已确认）**：`sizeBytes>0` 的 381 篇全是 `codex_pet`（触发器那条路硬编码 0，应用层归档写真实字节），合计 **13.9 MB**，占了 **376 个用户**的知识库配额。
  - **量级结论：P2.1 一次性删即可**，不需要分批（1,265 文档 / 211 chunk / 9,563 库行）。未验证项 6 消除。
- [x] P0.3 解开 X1 耦合：`knowledgeDocumentId` 从 codex-pet 的 ready 判据里摘出来（[`runner-archive.ts`](../../../apps/api/src/workflow/codex-pet/codex-pet-runner/runner-archive.ts) 的 `completeKnowledgeArchive`）。**这是唯一的硬拆点**，不解开 P1 无法往下走。
  → 改动量比预估小：**一个函数**。`completeKnowledgeArchive` 里归档改成尽力而为（只有 `CodexPetLeaseLostError` / `CodexPetCancelledError` 继续上抛），ready 转换的 where 谓词去掉 `knowledgeDocumentId: documentId`。`ready + knowledgeDocumentId=null` 从此是合法终态。未验证项 3 消除。
  → **这一步本身就是个生产 bug 修复，实测有据**：库里 `CodexPetRun` 共 127 条，**47 条 refunded**；`knowledge-archive` Job 有 1 条 `failed` 且 `attempt=3`（重试耗尽），即「一个事后登记动作掉了一次已交付的付费运行」真的发生过。另有 3 条 `ready` 运行的 `knowledgeDocumentId` 已是 null（FK `SetNull` 生效），在旧判据下是不该存在的状态。
  → 三条断言旧耦合的集成测试改成断言新契约：`enters ready even when the archived knowledge document is concurrently deleted`、`delivers ready without a refund when knowledge archival fails outright`、`does not retry archival on an already-delivered run`。前端 `useCodexPetStudio.ts` / `CodexPetStudioWorkbench.tsx` / `CodexPetStudioRunSidebar.tsx` 的归档文案不在这里改——P1.2 会整段删掉，避免改两遍。
- [x] P0.4 `Knowledge.tsx` 的 codex-pet 交付 UI（`:16,309,700-715`）与三条测试（`Knowledge.codex-pet.test.tsx:202,235,265`）——决定是搬到素材库还是搬到桌宠工作台。**建议后者**（规则 3：桌宠有自己的工作台）。
  → **裁定：搬到桌宠工作台，即「就地删除，不另建入口」。** 那张交付卡（打开桌宠项目 / 安装到 Codex / 下载兼容包）三个动作在 `CodexPetStudioWorkbench.tsx` 里本来就都有，知识库那份是重复入口；`initialDocumentId` 深链与 `codexPetDetails` 预取也一并删。`Knowledge.codex-pet.test.tsx` 整个文件 3 例全部覆盖被删行为，`git rm`。
  → **副产物：`App.tsx` 的跨页深链意图少了一条。**「知识库 → 桌宠项目」和「工作流 → 知识库文档」是一对，后者随交付卡消失。`App.behavior.test.tsx` 的 `describe("App 跨页深链")` 3 例一起删。**tsc 抓不到这三例**——probes 是松类型，`probes.knowledge?.initialDocumentId` 编译期合法，只有 grep 意图名才找得到。

### P1 — 停写

- [x] P1.1 一个迁移：`DROP TRIGGER` × 10（`ImageAsset_archive` / `VideoAsset_archive` / `AudioAsset_archive` / `NovelChapter_archive` / `ArticleWorkflowProject_archive` / `ComicWorkflowScriptVersion_archive` / `LocalBusinessPromoProject_archive` / `DubProject_archive` / `AgentWorkflowRun_archive` / `ScheduledTaskRun_archive`）+ `User_ai_artifacts_kb` + `DROP FUNCTION` × 12。**这一个迁移即删掉 H1/H2/H4/H5/H6/H7/L1/L3/L4。**
  → [`20260831120000_drop_ai_artifact_archive_triggers`](../../../packages/db/prisma/migrations/20260831120000_drop_ai_artifact_archive_triggers/migration.sql)，已 `migrate deploy` 到 `localhost:5433/ai-assistant`。实际是 **11 个 `DROP TRIGGER` + 13 个 `DROP FUNCTION`**：计划漏数了 `ensure_ai_artifacts_kb` 之外的一个内部辅助函数，按 `pg_proc` 实际清单补齐（P1.4 的第一条测试就是拿 `pg_proc`/`pg_trigger` 反查，数不对会红）。存量数据一行未动，留给 P2.1。
- [x] P1.2 删 codex-pet 的应用层归档：`codex-pet-archive.ts`、`runner-archive.ts` 的 KB 部分、`codex-pet-cleanup.ts:155-169`。→ 删掉 M1。
  → `codex-pet-archive.ts` + `codex-pet-archive.test.ts`（9 例）整文件删；`archiving` **保留为直通阶段**——`CODEX_PET_RUN_STAGES` 枚举不动，省掉一次数据迁移，崩在 `archiving` 的运行照旧可被新 worker 接走走到 ready。
  → 连带死掉的东西比计划列的多：`CodexPetJob(kind='knowledge_archive')` 那套可续跑重试机制（含 `CODEX_PET_ARCHIVE_MAX_ATTEMPTS`，已从 `.env.example` 与 `infra/k8s/base/10-configmap.yaml` 摘除）、`codex-pet.md` 里 7 处归档描述、`codex-pet-cleanup.ts` 的产物文档删除块（其测试断言翻成 `document.deleteMany` **不被调用**）。
  → `codex-pet-runner.integration.test.ts` 41 → 37 例：原先 4 例专门覆盖「归档失败仍交付 / 已交付不重试 / 按归属 reconcile 已有 Document / 陈旧 worker 竞态」，机制没了就地合并成 1 例（崩在 archiving → 新 worker 接走 → ready，且不建 Document、不建归档 Job、不退款），顺带把仅有的 `seedArchivingDeliverables` 两个调用点保活。
- [x] P1.3 `indexer.ts:313-314` 的 `!doc.sourceModule` 跳过 settle 分支删除（不再有 sourceModule 文档）→ 恢复 billing 口径单一。
  → **实际有两处，不是一处。** 计划只点了成功路径（`indexer.ts:313`），另一处在**最终失败路径**（`indexer.ts:376`，零额退款结算同样按 `sourceModule` 豁免）。两处都删，口径这才真的单一。`indexer.test.ts` 13 → 11 例，删掉的两例（`Codex 桌宠自动归档在成功索引时不重复计费`、`…在索引失败时也不发起零额退款结算`）钉的正是被删的豁免；正向断言（USER 库文档确实结算）文件里第一例本来就有。
- [x] P1.4 P0.1 的测试全部反转断言：删源行 → 断言无 `Document`；归档抛错 → 断言主业务**不受影响**（因为不再有归档）。
  → 同一个文件整体重写，仍是 7 例，逐条与 P0.1 一一对应反转。多做了两件事：(1) 第一例直接查 `pg_trigger`/`pg_proc` 断言两张清单都为 `[]`——触发器在 Prisma schema 里不可见，光删迁移不留断言，下一个人再加回来 CI 依然全绿；(2) H1 那例的诱饵文档现在得先手建一个 KB 才挂得上去（自动开库的触发器已死），插入 `ImageAsset` 必须成功。


### P2 — 清存量

- [x] P2.1 迁移：`DELETE FROM "Document" WHERE "sourceType" = 'ARTIFACT'`（`Chunk` 走 `onDelete: Cascade` 自动清），再 `DELETE FROM "KnowledgeBase" WHERE "systemKey" IS NOT NULL`。按 P0.2 的量级决定是否分批。**不可逆——执行前确认已有备份。**
  → [`20260831130000_delete_ai_artifact_documents_and_kbs`](../../../packages/db/prisma/migrations/20260831130000_delete_ai_artifact_documents_and_kbs/migration.sql)，已 `migrate deploy`。**写成三步而不是计划里的两步**，因为「先删库让 `Document_kbId_fkey` 级联」会把任何被手工上传进产物库的用户文件一起 cascade 掉：① 删产物文档 → ② 仍有用户文件的产物库只摘 `systemKey`（降级成普通个人库，能改名能删）→ ③ 只删已空的产物库。②③ 都带 `ownerType = 'USER'` 护栏。**不分批**（P0.2 的量级结论）。
  - 删前审计（用户要求「看清楚不要删错」，全部只读）：`ownerType` × `systemKey` 交叉表证明唯一那个 OFFICIAL 库 `systemKey` 是 NULL，谓词碰不到它；`systemKey` 只有 `AI_ARTIFACTS`(9,661) 和 NULL(17) 两种取值；**零交叉污染**——1,275 个 ARTIFACT 文档全在系统库内，8 个用户上传（6 FILE + 2 TEXT）全在系统库外；孤儿文档 0；`Chunk.kbId` 与其文档不一致 0；三张表上的外键只有 CASCADE / SET NULL，**没有 RESTRICT 会挡住删除**；松引用（无 FK 的 KB id）`Session.attachedKbIds` / `DubProject.attachedKbIds` / `ScheduledTask.kbIds` 命中 **0 / 0 / 0**，`kbAttachAllOwn=true` 的会话 **0**。
  - 实际结果与预测**逐项吻合**：Document 1,275 → **8**（ARTIFACT 0、`sourceModule` 非空 0）、Chunk 211 → **0**、KnowledgeBase 9,678 → **17**（16 自建 + 1 官方，`systemKey` 非空 0）、`CodexPetRun.knowledgeDocumentId` 非空 43 → **0**（`CodexPetRun` 本身 127 行未变）。步骤 ② 本地命中 0 行（776 个装产物的库删完产物后全空）。
  - 备份：用户以「本地开发环境」为由放弃全库备份，仍做了定向 `pg_dump --data-only -t Document -t Chunk -t KnowledgeBase` → `/tmp/kb-p2-backup/kb-before-p2.sql`（462 MB，绝大部分是产物正文）。
- [x] P2.2 处理 `CodexPetRun.knowledgeDocumentId` 外键（`20260717180000_codex_pet_workflow/migration.sql:161`，`ON DELETE SET NULL`）：P0.3 解耦后该列可置空并在 P5 退役。
  → **不需要改 schema**：`confdeltype = 'n'`（SET NULL）已经是想要的语义，P2.1 一删就把 43 个非空值全置空了，现在全表 127 行该列皆为 NULL。这列从此是惰性的，等 P5.4 连列带外键一起退役；P0.3 已经让 `ready + knowledgeDocumentId=null` 成为合法终态，所以中间态不会有人报错。
- [x] P2.3 校验：`usedBytes`（`service.ts:205`）与「知识晶格数」（`service.ts:73`）回归到只反映用户上传 → 顺带解掉 M5。管理端 `kbUploads*`（`analytics-routes.ts:218-220`）同步核对。
  → **三处都不用改代码**：它们从来没做产物/上传的区分，只是「`Document` 里有什么就报什么」，所以产物一删就自动正确了。`usedBytes` 是 `sum(sizeBytes) where kb.userId=… and status != 'failed'`；晶格数是 `groupBy kbId, sum(chunkCount)`，产物库行没了就不会再多出条目；管理端 `kbUploads{Today,Month,Total}` 是不带过滤的 `Document.count()`——之前把 1,275 个产物当「用户上传」报，现在是 8。M5 解除。
  - 附带确认「删掉的东西回不来」：应用代码里**没有任何一处写** `sourceType: 'ARTIFACT'` 或 `KnowledgeBase.systemKey`。剩下的 `ARTIFACT` 只有三个**读**点——`kb/deps.ts:30-36`（`loadObject` 的内联正文分支，已不可达，随 P5.3 一起删）、`service.ts:99/130`（`systemKey` 的 403 保护，随 P5.1 退役）、`Knowledge.tsx:254/383/396`（「自动归档」徽章与隐藏改名/删除按钮的分支，同 P5.1）。`codex-pet` 里那批 `CODEX_PET_*_ARTIFACT_*` 是 S3 产物命名，与知识库无关。

### P3 — 素材库（读模型 + 页面）

- [x] P3.1 `GET /api/assets` 读模型：按第二部分的准入规则聚合 `ImageAsset`（排除 `ecom-` / `comic:` 前缀）+ `VideoAsset` + `AudioAsset`（按 `kind` 分区）+ `DubProject` 媒体列 + `PortraitOutput` / `TryOnOutput` + `CodexPetRun` 的四个指定 artifact 指针。**第一版就要有分页、`sourceModule` 过滤、缩略图**，否则 M3 在素材库重演。
  → 落成 `apps/api/src/assets/` 六个文件：类型层 `asset-types.ts`、准入裁定 `asset-classify.ts`、排序/游标 `asset-cursor.ts`、源适配器 `asset-sources.ts`（P3.1 六路，P3.3 补 `try-on` 起七路）、归并分页 `asset-service.ts`、路由 `asset-routes.ts`。**不建表、不新开取件端点**：每条链接都调原模块自己的签名函数（`imageBlobUrl` / `portraitBlobUrl` / `projectAudioBlobUrl` / `defaultArtifactPreviewUrl`），素材库一条都没自己签。分页是**键集**而不是 offset——多路归并 + 新素材随时插到最前面，offset 会同时漏行和重行。
  → **`TryOnOutput` 这一路在 P3.1 时按项目所有者指示暂缺**（试穿工作流当时有未提交改动在手上），P3.3 已补齐。事后印证了这个设计：加一路只往 `ASSET_SOURCES` 追加一个源，`asset-service.ts` 一个字没动。
  → **偏差 1：桌宠不按计划正文那份 kind 白名单收，只收 `CodexPetRun` 四个指针列指着的 artifact。** 实测裁定表第 173 行的白名单有两处与库不符：`final_package` 这个 kind **在库里根本不存在**；`animation_preview` 有 **691 行、其中被四个指针引用的是 0 行**——按 kind 收会多收 691 条中间件（约 14 倍）。被指针指着的四种 kind 实测占比：`base_candidate` 79/84、`package` 48/50、`spritesheet` 48/50、`preview` 48/50。这正是同一行括号里那句「run 已经声明了哪几个 artifact 是有意义的，直接用这四个指针」，所以取指针、弃 kind 名单。代价是这个源必须走 `$queryRawUnsafe` 做 JOIN：准入条件是「`artifact.id` 等于 run 上四个列之一」，列与列的比较 Prisma 表达不了，而取回内存再筛会让分页判不出见底。
  → **偏差 2：`ecom-master:` / `ecom-segment:` / `ecom-main:` 进素材库，只有 `ecom-stitch:` 和未知 `ecom-*` 不进。** 裁定表第 168 行字面写的是「前缀 `ecom-` 一律不进」，但按计划自己的「形态 × 来源 × 角色」三维规则，这三个前缀是**交付成品**不是中间件；`listRecentImages` 排掉整个 `ecom-` 是因为电商工作台另有视图，对应规则 3 的「素材库最多做引用」——所以按 `article:` 同样的办法处理：进，但带 `groupKey` 折叠到所属 workflow/job 下。`ecom-reference:` 同理进「我上传的」区（M2），`sourceModule` 记作 `reference` 而不是 `ecom`（该前缀被 image 与 ecom 两个模块共用，从前缀恢复不出真正的工作流）。未知 `ecom-*` 默认不进：宁可漏一个成品，也不要把中间件塞进用户素材库。
  → API 除分页与 `sourceModule` 外还带了 `origin=ai|upload`：P3.2 的两个分区没有它就翻不了页（跨表的分区结果无法在前端拼)。
  → 105 个用例，其中 `asset-sources.integration.test.ts` 17 例打真库：钉住嵌套 OR/AND/NOT 真能被翻成 SQL、桌宠那条手写 JOIN 与 `$n` 占位符对得上、以及「一行多素材」+「跨源同毫秒」两种情况下键集分页不重不漏。`asset-classify.test.ts` 里自带一个 where 求值器，逐条比对「SQL 判据」与「规则表判据」等价——两边不一致的症状是「素材库少了/多了一类素材」，没人会立刻发现。
- [x] P3.2 前端素材库页面 + `NavRail.tsx:52-64` 一级入口（现 11 项）。按「AI 生成 / 我上传的」分区。
  → 四个新文件 + 四处改动：网络层 `assetApi.ts`（唯一 fetch 点，类型手抄 `asset-types.ts`——web 与 api 没有共享类型包，这是既有约定）、纯逻辑 `assetLibrary.ts`（分区表/筛选项/翻页归并/两个格式化）、展示组件 `components/assets/AssetLibraryView.tsx`、页面 `pages/Assets.tsx`；一级入口进 `NavRail.tsx`（`ViewType` + `NAV_ITEMS`，紧挨知识库）、`App.tsx` 的 `renderContent` 加第 14 个分支、后台目录加 `nav.assets`（`client-menu-catalog.ts`，`defaultVisible: true`）。
  → **`clientMenu.ts` 一行都不用改**：`isClientMenuVisible` 是 `visibility?.[key] ?? DEFAULT[key] ?? true`（未知 key 默认可见）、`clientMenuKeyForView` 自动推 `nav.<view>`、`FALLBACK_VIEW_ORDER` 只在当前页被隐藏时兜底。新入口天生就被这三处正确处理。
  → **前端必须按 id 去重，这不是防御性代码**：同源游标是 `lte`（`asset-cursor.test.ts` 钉住的行为，因为一行可能产出多条素材，游标那行要重取），所以第二页必然带回已展示过的兄弟素材。`appendAssetPage` 顺带处理「游标不前进」——服务端若返回同一个 `nextCursor`，「加载更多」会永远可点，这里直接判到底。
  → module→分区的对应表**硬编码在前端**（手工与 `asset-classify.ts` + `AUDIO_KIND_RULES` 同步，只管展示，准入仍以 API 为准）：从已加载素材反推筛选项的话，第 5 页才首次出现的模块在那之前根本没有入口。`comic: []`——漫画分镜整段不进素材库。
  → 翻页用显式按钮而不是 `IntersectionObserver`：jsdom 里没有真实滚动，观察器版本的分页在测试里钉不住。59 个新用例（`assetApi` 10 / `assetLibrary` 37 / `Assets` 页面 12）+ `App.behavior.test.tsx` 补一例视图分派。
- [x] P3.3 复核 M6 覆盖面：按新规则重新核一遍，确认 `PortraitOutput`/`TryOnOutput` 已纳入、caption 类文章不再被误期待。
  → 复核方式不是只核正文点到的那两个名字，而是把 schema 里**每个带媒体列**（`objectKey` / `*Url` / `mime`）的 model 全过一遍（15 处命中），逐个查读写点与真实行数再判。
  → **`PortraitOutput` ✅ 早已纳入**（`portraitSource`，库里 16 行）。**`TryOnOutput` 是本项唯一真缺口，已补**：`tryOnSource` 与 portrait 那一路同构（同样 `taskId` + `requestIndex` + 唯一 `objectKey`），链接调试穿自己的签名函数——`try-on-routes.ts` 只加一行 `export const tryOnBlobUrl = blobUrl;`，素材库不重签第二条。`sourceModule` 独立成 `try-on` 而不是并进 `portrait`：后台目录里两者本来就是两个三级菜单（`workflow.image.portrait` / `workflow.image.try-on`），找试穿结果的人不该去「形象照」筛选项下面翻。新前缀 `try-on:` 自动被 `asset-cursor.test.ts` 那条「任意两个源前缀互不为前缀」的性质测试覆盖。
  → **caption 类文章的误期待已经**结构性**消失，不是靠加判断绕过**：库里归档触发器/函数 0 个（P0.4 + P1 删净），`Document` 只剩 FILE 6 行 + TEXT 2 行、**ARTIFACT 0 行**，代码里再没有把配图/caption 与知识库耦合的路径。残留只有文案：`Knowledge.tsx:385/577` 两处已归 P5.1，另发现 `codexPetStudioModel.ts:141` 还有一个「归档到知识库」状态文案，一并留给 P5.1。
  → **四条判「不该进」，理由记在这里，免得下次复核重新纠结**：`PortraitReferenceAsset` / `TryOnReferenceAsset` ❌——24h TTL，清理路径把 S3 对象一起删（`portrait-routes.ts:286-322`），库里各 2 行、**存活 0 行**；收它们等于重造这整个计划要消灭的 H3 死链。`VideoMaterial` ❌——计费用的时长缓存，按 URL 读给 `sumInputDurationSec`，只对 `video/*` 写行，从不回列给用户（0 行）。`Avatar` ❌——自有「我的形象」入口，按规则 3 素材库最多做引用（0 行）。`ComicWorkflowShot.videoUrl` ❌——漫画整段不收（资产 tab，规则 3，0 行）。
  → **另记一条结构缺口（不属本项，本项也不为它加代码）**：不挂 `projectId` 的独立 `video_create` 任务（`dub-video-service.ts:29`）把成品只写进 `SkyhumanTask.resultPayload.videoUrl`，从不落 `DubProject`，于是**永远进不了素材库**。今天 0 行不阻塞；真要收，得先让那条链路把成品落进一张权威表，而不是让素材库去解 `resultPayload`。
  → 用例：`asset-sources.integration.test.ts` +2（试穿独立成 module、链接走自己的签名函数；`module=try-on` 过滤），并把「同毫秒跨源定序」从三源扩到四源（`try-on:` > `portrait:` > `image:` > `codex-pet:`）——`src/assets` 107 例、其中 19 例打真库，全绿 0 跳过。前端 `assetApi.ts` 的枚举与 `assetLibrary.ts` 三张表（标签 / 顺序 / 分区）各加一行，`moduleFiltersForOrigin("ai")` 的精确名单跟着改；web 全量 94 文件 637 例全绿、0 跳过。
- [ ] P3.4 处理 H3 的另一半：`pruneImages` 的豁免名单（`image-route-helpers.ts:152`）当前只排除 `ecom-`，而形象照/文章配图/桌宠图都会被连 S3 删掉。**素材库上线后这个 50 条上限就是「用户素材会凭空消失」，必须重新定义保留策略。**

### P4 — 策展路径

- [ ] P4.1 素材库 + 各工作流成品页加「加入我的知识库」：选目标个人库 → 走 `kb/ingest.ts` → `sourceType='TEXT'`、计入配额、可删除。
- [ ] P4.2 两个选择器（`ChatKnowledgePicker.tsx`、`agent-teams/KnowledgePicker.tsx`）与「你自己创建的 N 个知识库」计数（`useChatComposerState.ts:70`）——不再需要 `systemKey` 过滤，但要确认删库后计数正确。
- [ ] P4.3 智能体团队那条按 `updatedAt desc take 2` 取文档的逻辑（`agent-knowledge-context.ts:110-113`）：产物库消失后不再有「永远排最前」的库，但**它仍然不做向量检索**——单独记录，不在本计划范围。

### P5 — 列退役

- [ ] P5.1 `KnowledgeBase.systemKey`（`AI_ARTIFACTS` 是全仓唯一取值，删库后完全无用）
- [ ] P5.2 `Document.sourceModule` / `sourceId` / `metadata` / `content`（**先确认 `content` 除 ARTIFACT 外无其他写入者**——手工 `sourceType='TEXT'` 上传是否用它，P5 开工前必须核实）
- [ ] P5.3 `Document.sourceType` 的 `'ARTIFACT'` 取值从注释与校验里移除，回到 `FILE|URL|TEXT`
- [ ] P5.4 `CodexPetRun.knowledgeDocumentId` 与其外键
- [ ] P5.5 `Document_sourceModule_sourceId_key` / `KnowledgeBase_userId_systemKey_key` 两个唯一索引

---

## 验证纪律

**必须先 source `.env`，否则测试结果不可信**（本项目最容易踩的坑）：

```bash
cd "/Users/z/code/ai project" && set -a && . ./.env && set +a
```

**路径必须写 `./.env`**：zsh 的 `.` 只搜 `PATH` 不含 cwd，写 `. .env` 会报 `no such file or directory` 然后你带着空 env 继续跑，得到的正是那批 `skipIf` 静默跳过的假绿。

有 **12 个测试文件**用 `describe.skipIf(!databaseEnabled)` 守卫，缺 env 时**静默消失且退出码为 0**。**报告测试结果时必须同时报告 skipped 数；只写 passed 不写 skipped 的报告视为无效。**

**反过来，source 本地 `.env` 会让 12 例必挂，`apps/api` 本地永远到不了 0 failed**：`admin/{resource,membership,code}-routes.test.ts` 11 例断言「billing 不可达返回 502」，写法是 `process.env.BILLING_BASE_URL ??= "http://localhost:1"`，本地 `.env` 把它设成了真在跑的 billing（:8093）于是拿到 200；`agents/routes.test.ts` 1 例断言「无 S3 时回落 object key」，本地 minio（:9000）是活的。CI 刻意让 `BILLING_BASE_URL` 存在但不可达、S3 一律留空。**判「是不是我改坏的」不能拿本地数字对 CI 数字。**

每个阶段独立成 commit。**含迁移的 commit 不与功能改动混提**（这正是 `4b552c2` 的教训）。任何一步变红即 `git revert` 单个提交——但 P2 是数据删除，不可 revert，执行前必须确认备份。

### P1 收口实测（2026-08-31）

`pnpm exec turbo run test --force --continue`（ci.yml 原命令）+ `node scripts/check-test-report.mjs`：

| | passed | failed | skipped |
|---|---|---|---|
| 10 个 workspace 合计 | **2,794** | 13 | **22** |
| 基线 `.github/test-baseline.json` | 下限 2,411 | — | 上限 23 |

13 个 failed 全部与本阶段无关，逐个查证：12 例是上面那条本地 env 差异；1 例是 `packages/codex-pet-pipeline/src/pipeline.test.ts` 在 10 个 workspace 并行抢 CPU 时 5s 超时，单跑 **45 例全绿**，该包本次一行未改。

**基线不用动**：本阶段净删 21 例（api −15：archive 9 + runner.integration 4 + indexer 2；web −6：Knowledge.codex-pet 3 + App.behavior 3），但 `minPassed` 是**下限**、`maxSkipped` 是**上限**，2,794 ≥ 2,411 且 22 ≤ 23，两条都仍然满足。基线 2,411 是 2026-08-06 的 CI 打印值，此后新增的测试远多于这次删掉的。

`biome lint`（CI 的门只有 lint、不含 formatter）跑改动文件全绿——顺手清掉 3 个**先前就有**的 `noUnusedImports`（`indexer.ts` 的 `getPrisma`、`indexer.test.ts` 的 `Document` 类型、`routes.test.ts` 的 `beforeEach`）：这三个文件本阶段进了改动集，`biome ci --changed` 从此会扫到它们。两个 workspace `tsc --noEmit` 均 0 错。


---

## 未验证项（执行者必读）

> 2026-08-31 P0 执行后更新：第 1、3、6 条已消除，原文留在下面并标注结论。

1. ~~**全程静态取证**：没连数据库、没跑测试、**没有比对生产库 `pg_trigger` 确认这批触发器真的装上了**。~~ → **已消除**：P0.1 的集成测试直接查 `pg_trigger` 断言 11 个触发器全在，7 例全绿。
2. 标「结构性」的条目（H2 锁竞争实际耗时、M4 并发重复 chunk）是代码文本已确认、运行时后果未实测。要钉死 M4 需要并发集成测试。**仍未实测**——但 P1 删掉触发器后这两条自然消失，不再值得单独投入。
3. ~~**P0.3 的改动量未评估**。X1 耦合牵着退款逻辑，是本计划里唯一「不是删除动作」的一步，也是唯一没底的一步。~~ → **已消除**：实际只动一个函数（`completeKnowledgeArchive`），加三条集成测试的断言反转。
4. ~~`Document.content` 是否有 ARTIFACT 之外的写入者未核实（阻塞 P5.2）。~~ → **已消除**（P2 顺带核实）：应用代码里**一个写入者都没有**，库里 `content IS NOT NULL` 的行也是 **0**。全部提及只有三处：`indexer.ts:108`（`loadObject` 签名里的字段）、`indexer.ts:250`（原样透传）、`deps.ts:32`（已不可达的 ARTIFACT 分支）；`retrieve.ts` 那两处是 `Chunk.content`，另一列。**P5.2 解除阻塞**，删这列只需连带删掉 `deps.ts` 的 ARTIFACT 分支和签名里的字段。
5. `ownerType='OFFICIAL'` 官方知识库的现状（有无管理端入口、有无实际数据）未核实。本计划假设它照旧可用，未做任何改动。 → 部分核实：全库**恰好 1 行** OFFICIAL 库、`systemKey` 为 NULL、**没有文档**（所以 P2.1 的谓词碰不到它，且它现在是个空库）。管理端入口仍未核实。
6. ~~存量 ARTIFACT 文档/Chunk 的实际规模未知（阻塞 P2.1 的分批决策）。~~ → **已消除**：见 P0.2 实测数据，1,265 文档 / 211 chunk / 9,563 库行，一次性删即可。

