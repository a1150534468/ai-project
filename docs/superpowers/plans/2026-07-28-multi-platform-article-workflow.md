# 多平台图文工作流执行计划（公众号 / 小红书 / 抖音）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有「公众号图文工作流」扩成多平台图文工作流：一次导入文章，AI 自动配图 + 自动排版/成稿，生成后可继续编辑并按平台一键复制。支持微信公众号（内联 CSS 的 HTML 片段）、小红书与抖音（正文文案 + 竖版配图 + 话题标签）。

**Architecture:** 不引入编排框架，不引入卡片渲染引擎（无 puppeteer/canvas 排版）。在现有自研链路上做三件事：（1）给 `ArticleWorkflowProject` 加平台维度与批次维度，一次导入 = N 行同批次记录，每行仍是独立的生成单元；（2）生成器按平台产出两种形态——`html-fragment`（公众号，走既有 plan → layout → HTML guard 两次 LLM 调用）与 `caption`（小红书/抖音，单次 LLM 调用产出标题 + 正文文案 + 标签 + 配图计划，不经 HTML guard）；（3）前端从「单项目工作台」升级为「批次 + 平台页签工作台」，每个平台各自编辑、各自复制。

**为什么按行拆而不是新建 output 表：** 崩溃收尸（`article-workflow-reaper.ts`）、`billingOperationId` 退款、条件终态写（`finalizeArticleWorkflowProjectState`）全部以 `ArticleWorkflowProject` 行为单位。保持「一行 = 一个生成单元 = 一笔 reserve」，这套刚落地的止血逻辑一行都不用改，只需加列。

**Tech Stack:** TypeScript + pnpm monorepo + turbo；Fastify（API）/ React 19 + Vite + Tailwind（web）；Prisma + Postgres；测试 vitest。article-workflow 现有测试全部是 mock 驱动、**不依赖 DB**，秒级可跑。

---

## 前置状态（开工前确认）

- 阶段 4「崩溃收尸与退款」已落盘：`article-workflow-reaper.ts`、`billingOperationId` 列（迁移 `20260728100000_add_article_billing_operation_id`）、`finalizeArticleWorkflowProjectState` 条件终态写、图片费回滚（`onCharged` 回调）均已在库。**本计划不重复这部分工作，也不修改它们的语义。**
- 基线（已实测，2026-07-28）：
  - `apps/api` 的 `src/workflow/article-workflow*` → **4 文件 20 用例全绿**（约 1.1s，无需 DB）
  - `apps/web` 的 `ArticleWorkflowStudio.test.tsx` → **2 用例全绿**
- 开工前 `packages/db/prisma/schema.prisma` 必须无未提交改动（阶段 1 要改它）。工作区其它无关改动由项目所有者自行处理，**本计划执行者不得代为提交无关文件**。

## 范围边界（明确不做什么）

- **不引入编排框架**、不引入队列。`scheduledRunner` 的 fire-and-forget 保持原样，崩溃兜底交给已落地的 reaper。
- **不做文字卡片图渲染**（无 chromium/canvas 排版、无 1080×1440 卡片流水线）。小红书/抖音的图 = AI 生成的竖版配图，不是把文字排到图上。
- **不做自动发布**。交付形态仍是「一键复制 / 下载配图」，不做平台登录自动化。
- **不接定时任务**。`ScheduledTask` 的 kind/params 扩展、新闻采集源是独立立项，见本目录后续计划。
- **不改计费语义**：`article_workflow_text_output` 资源键、图片按张 `chargeResource`、reserve/settle/refund 时序与 `operationId` 生成方式全部不变。多平台 = 多行 = 多笔独立 reserve。
- **不改 HTML guard 的规则集**，只把它的适用范围收窄到公众号链路。
- **不动图片上游**：3:4（`768x1024`）与 9:16（`864x1536`）预设已存在于 `IMAGE_UPSTREAM_PRESETS`，无需新增管道。

## 关键设计决策

| 决策 | 选择 | 理由 / 被否方案 |
| --- | --- | --- |
| 多平台数据模型 | `ArticleWorkflowProject` 加 `platform` + `batchId` 两列，一次导入插 N 行 | 否掉「新建 `ArticleWorkflowPlatformOutput` 子表」：reaper / 退款 / 条件终态写全部要跟着迁到子表，风险与工作量都翻倍，收益只是省掉 sourceText 的 N 份拷贝 |
| 输出形态 | 两种 `outputKind`：`html-fragment`、`caption` | 三个平台其实只有两条投递通道。公众号要富文本 HTML，小红书/抖音要纯文本 + 图，不存在第三种 |
| 保留原文模式 | `preserve-text` 只对公众号有效，caption 平台强制 `polish-text` | 小红书/抖音必须压缩重写，与「可见文字完全相等」的硬校验天然冲突。用 `resolveArticleWorkflowMode(platform, requested)` 做无声降级而非 400，避免前端组合爆炸 |
| HTML guard | 只作用于 `html-fragment` 链路 | caption 输出不产 HTML，走 guard 只会误杀 |
| caption 的 LLM 调用数 | 1 次（plan 与成稿合并） | 公众号需要两次是因为「先定计划再排版」；caption 没有排版环节，第二次调用纯属浪费钱和延迟 |
| 平台默认勾选 | 三个平台默认全选 | 模块定位就是多平台。成本透明靠生成按钮上方的「N 平台 × 最多 M 张图」预估文案兜住 |
| 图片槽位枚举 | 沿用现有 5 槽（`cover` + `inline-1..4`） | 小红书理论支持 9 图，但 v1 统一封顶 5 张，避免动 slot 枚举、schema、manifest 合并逻辑 |

## 平台配置矩阵（阶段 1 落成常量，后续任务全部读它）

| 平台 key | 展示名 | outputKind | 封面尺寸 | 内页尺寸 | 图片上限 | 标题上限 | 正文上限 | 标签数 | 允许的生成模式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `wechat` | 微信公众号 | `html-fragment` | `1536x864`(16:9) | `1024x768`(4:3) | 5 | 120 | — | 0 | `preserve-text` / `polish-text` |
| `xiaohongshu` | 小红书 | `caption` | `768x1024`(3:4) | `768x1024`(3:4) | 5 | 20 | 1000 | 3–6 | `polish-text` |
| `douyin` | 抖音 | `caption` | `864x1536`(9:16) | `864x1536`(9:16) | 5 | 30 | 600 | 3–5 | `polish-text` |

小红书标题 20 字是平台硬限制；抖音标题 30 字是可读性取值（平台允许更长）。语气提示词（tone）留在服务端 prompt 层，不进共享包。

## 全局验证纪律（每个任务都适用）

1. **标准命令**（下文引用为「article 测试」「web 测试」「包测试」「typecheck」）：
   ```bash
   cd "/Users/z/code/ai project/apps/api" && pnpm exec vitest run src/workflow/article-workflow
   ```
   ```bash
   cd "/Users/z/code/ai project/apps/web" && pnpm exec vitest run rticleWorkflow
   ```
   ```bash
   cd "/Users/z/code/ai project/packages/article-workflow" && pnpm exec vitest run
   ```
   ```bash
   cd "/Users/z/code/ai project" && pnpm --filter @ai-assistant/db generate && pnpm exec turbo run typecheck --filter @ai-assistant/api --filter @ai-assistant/web --filter @ai-assistant/article-workflow
   ```
   web 那条用 `rticleWorkflow` 子串匹配（掐掉首字母以同时命中 `ArticleWorkflowStudio.test.tsx` 与新增的 `articleWorkflow*.test.ts`），避免把另外 14 个无关 studio 测试拖进每轮验证。
2. **用例数不得倒退**：已实测基线为 article 测试 **4 文件 / 20 用例**（~0.8s，无 DB）、web 测试 **1 文件 / 2 用例**、包测试 **1 文件**（`markdown.test.ts`）。每轮验证要确认**用例数只增不减**且 0 失败——这几个文件不含 DB-gated 的 `describe.skipIf`，出现 skipped 就是异常。
3. **行号免责声明**：本计划行号基于 2026-07-28 工作区。执行前先用函数名/符号名 grep 校验锚点，行号漂移属预期，符号不匹配才是异常。
4. **迁移不用 `migrate dev`**：dev 库存在与本次无关的历史 drift（`LocalBusinessPromoRun`、`NovelKnowledgeFact` 索引名），`migrate dev` 会要求 reset 整库。沿用上一次的手写迁移流程（见 Task 1.2）。
5. **向后兼容硬要求**：`platform` 列默认 `wechat`、`batchId` 可空。存量项目行不迁移、不回填，读路径必须能处理 `batchId = null`（视为单平台独立批次）。

---

## 阶段 1：平台维度落地（约 0.5–1 天）

**目标：** 数据模型、共享常量、序列化都带上平台，但**生成行为零变化**——所有新建项目仍是 `wechat`，跑出来的东西和今天完全一样。阶段 1 结束时 20 个既有用例必须原样通过。

### Task 1.1: 共享包新增平台常量与配置

**Files:**
- Modify: `packages/article-workflow/src/types.ts`
- Modify: `packages/article-workflow/src/index.ts`（导出新符号）
- Create: `packages/article-workflow/src/platforms.ts`
- Create: `packages/article-workflow/src/platforms.test.ts`

- [x] **Step 1:** `types.ts` 增加 `ARTICLE_WORKFLOW_PLATFORMS = ["wechat","xiaohongshu","douyin"] as const`、`ARTICLE_WORKFLOW_OUTPUT_KINDS = ["html-fragment","caption"] as const` 与对应的 `ArticleWorkflowPlatform` / `ArticleWorkflowOutputKind` 类型。给 `ArticleWorkflowDocument` 加 `platform`、可选 `captionText`、可选 `tags: readonly string[]`（`version` 保持 `1`，该类型目前无持久化消费方，加字段安全——执行时 grep `ArticleWorkflowDocument` 复核）。
- [x] **Step 2:** `platforms.ts` 落「平台配置矩阵」表：`interface ArticleWorkflowPlatformConfig { platform, label, outputKind, coverSize, inlineSize, maxImages, titleMaxLength, captionMaxLength, minTags, maxTags, allowedModes }`，导出 `ARTICLE_WORKFLOW_PLATFORM_CONFIGS: Readonly<Record<ArticleWorkflowPlatform, ArticleWorkflowPlatformConfig>>`、`articleWorkflowPlatformConfig(platform)`（未知值回落 `wechat`）、`isCaptionPlatform(platform)`、`resolveArticleWorkflowMode(platform, requested)`（不在 `allowedModes` 里就返回 `allowedModes[0]`）。
- [x] **Step 3:** `platforms.test.ts` 覆盖：三个平台的 outputKind 与尺寸取值；未知平台回落 wechat；`resolveArticleWorkflowMode("xiaohongshu","preserve-text") === "polish-text"`；`resolveArticleWorkflowMode("wechat","preserve-text") === "preserve-text"`。
- [x] **Step 4:** `index.ts` 补齐导出（现有导出块已用 `export { type ArticleWorkflowDocument, ... }` 形式，照抄风格）。跑包测试 + typecheck + article 测试 + web 测试，预期全绿且包测试用例数 +≥4。
- [x] **Step 5:** Commit `feat(article-workflow): 平台配置矩阵与模式解析`

### Task 1.2: schema 加平台、批次、文案、标签四列

**Files:**
- Modify: `packages/db/prisma/schema.prisma`（`model ArticleWorkflowProject`，grep `model ArticleWorkflowProject` 定位）
- Create: `packages/db/prisma/migrations/20260729100000_add_article_workflow_platform/migration.sql`

- [x] **Step 1:** 确认 `schema.prisma` 无未提交改动。在 `ArticleWorkflowProject` 增加四列并补一个批次索引：
  ```prisma
  platform          String   @default("wechat")
  batchId           String?
  captionText       String   @default("")
  tagsJson          Json     @default("[]")
  ```
  ```prisma
  @@index([userId, batchId])
  ```
- [x] **Step 2:** 手写迁移 SQL（**不要跑 `migrate dev`**，见全局纪律 4）：
  ```sql
  -- 一次导入 = 同 batchId 的 N 行，每行一个平台、一个独立生成单元与一笔 reserve。
  -- 存量行默认 wechat、batchId 为空（视为单平台独立批次），不回填。
  ALTER TABLE "ArticleWorkflowProject" ADD COLUMN "platform" TEXT NOT NULL DEFAULT 'wechat';
  ALTER TABLE "ArticleWorkflowProject" ADD COLUMN "batchId" TEXT;
  ALTER TABLE "ArticleWorkflowProject" ADD COLUMN "captionText" TEXT NOT NULL DEFAULT '';
  ALTER TABLE "ArticleWorkflowProject" ADD COLUMN "tagsJson" JSONB NOT NULL DEFAULT '[]';
  CREATE INDEX "ArticleWorkflowProject_userId_batchId_idx" ON "ArticleWorkflowProject"("userId", "batchId");
  ```
- [x] **Step 3:** 应用迁移并生成客户端：
  ```bash
  cd "/Users/z/code/ai project" && set -a && source .env && set +a && pnpm --filter @ai-assistant/db exec prisma db execute --file prisma/migrations/20260729100000_add_article_workflow_platform/migration.sql --schema prisma/schema.prisma && pnpm --filter @ai-assistant/db exec prisma migrate resolve --applied 20260729100000_add_article_workflow_platform && pnpm --filter @ai-assistant/db generate
  ```
- [x] **Step 4:** 用 `psql` 的 `\d "ArticleWorkflowProject"` 核对四列与索引已存在。typecheck 全绿。
- [x] **Step 5:** Commit `feat(db): ArticleWorkflowProject 平台/批次/文案/标签列`

### Task 1.3: 读写层带上平台字段

**Files:**
- Modify: `apps/api/src/workflow/article-workflow-shared.ts`（`ArticleWorkflowPersistedProject`）
- Modify: `apps/api/src/workflow/article-workflow-serializer.ts`（`readArticleWorkflowProject` / 两个 serialize 函数）
- Modify: `apps/api/src/workflow/article-workflow-store.ts`（两个 patch 类型 + 写入体）
- Modify: `apps/api/src/workflow/article-workflow-schema.ts`（新增 `articleWorkflowTagsSchema`）
- Modify: `apps/api/src/workflow/article-workflow-test-helpers.ts`（`ProjectRow` 补四列）

- [x] **Step 1:** `ArticleWorkflowPersistedProject` 增 `platform: ArticleWorkflowPlatform`、`batchId: string | null`、`captionText: string`、`tags: readonly string[]`。
- [x] **Step 2:** `article-workflow-schema.ts` 加 `articleWorkflowTagsSchema = z.array(z.string().trim().min(1).max(40)).max(8).default([])`，供序列化与路由共用。
- [x] **Step 3:** `readArticleWorkflowProject` 解析新列（`platform` 走 `articleWorkflowPlatformConfig(...).platform` 归一化，`tagsJson` 用 `articleWorkflowTagsSchema.safeParse` 兜底成 `[]`）。两个 serialize 函数把 `platform`、`batchId`、`captionText`、`tags` 输出给前端。
- [x] **Step 4:** `ArticleWorkflowProjectStatePatch` 与 `updateArticleWorkflowProjectState` 的 patch 类型加 `captionText?: string`、`tags?: readonly string[]`（写入时 `tagsJson: data.tags ? jsonValue(data.tags) : undefined`，保持 Prisma 的 undefined = 不改语义）。`platform`/`batchId` 只在 create 时写，不进 patch。
- [x] **Step 5:** 测试桩 `ProjectRow` 补四列（`platform: "wechat"`、`batchId: null`、`captionText: ""`、`tagsJson: []`），`createArticleWorkflowPrismaMock` 的 `findMany` 支持按 `batchId` 过滤。
- [x] **Step 6:** article 测试 + web 测试 + typecheck 全绿，**20 个既有用例原样通过**（此步不改行为）。
- [x] **Step 7:** Commit `feat(api): 图文项目读写层带上平台与批次字段`

---

## 阶段 2：caption 生成链路（约 1–1.5 天）

**目标：** 小红书/抖音能真正跑出「标题 + 正文文案 + 标签 + 竖版配图」。公众号链路一行行为都不变。

### Task 2.1: prompt 按平台参数化

**Files:** Modify `apps/api/src/workflow/article-workflow-prompt.ts`

- [x] **Step 1:** 把 `buildArticleWorkflowPlanSystemPrompt(mode)` 改成 `buildArticleWorkflowPlanSystemPrompt({ platform, mode })`，签名改为对象参数。公众号分支的文案**逐字保留**（"你是资深微信公众号编辑与电商内容策划。"那一串），保证现有用例断言不变。
- [x] **Step 2:** 新增 `buildArticleWorkflowCaptionSystemPrompt({ platform, config })`：输出结构固定为 `{"title":"","captionText":"","tags":[],"images":[...]}`；按 config 注入标题字数上限、正文字数上限、标签数量区间；注入平台语气（小红书：第一人称口语、真实体验感、适度 emoji 分段、结尾引导互动、禁止浮夸承诺与违禁词式营销话术；抖音：前 2 行必须抓住注意力、句子更短、口播感、话题标签放结尾）；明确「标签不带 # 号，由前端/复制时补」；明确「不要输出 Markdown 与 HTML 标签」。
- [x] **Step 3:** 新增 `buildArticleWorkflowCaptionUserPrompt({ sourceFormat, sourceText, currentCaption?, instruction?, config })`，素材裁剪沿用 `ARTICLE_SOURCE_PROMPT_BUDGET`。
- [x] **Step 4:** `buildArticleWorkflowLayoutSystemPrompt` 保持原样（公众号专用）。typecheck + article 测试全绿。
- [x] **Step 5:** Commit `feat(api): 图文 prompt 按平台参数化 + caption 提示词`

### Task 2.2: caption 计划的 schema 与归一化

**Files:**
- Modify: `apps/api/src/workflow/article-workflow-schema.ts`
- Create: `apps/api/src/workflow/article-workflow-caption.ts`
- Create: `apps/api/src/workflow/article-workflow-caption.test.ts`

- [x] **Step 1:** schema 加 `articleWorkflowCaptionPlanSchema`：`title`（min 1 / max 200，宽松收，归一化时再截）、`captionText`（min 1 / max 20_000）、`tags` 用 `articleWorkflowTagsSchema`、`images` 复用 plan 的 images 形状（min 1 / max 5）。导出 `ArticleWorkflowCaptionPlan` 类型。
- [x] **Step 2:** `article-workflow-caption.ts` 落 `normalizeArticleWorkflowCaptionPlan({ plan, config })`：标题按 `titleMaxLength` 截断（不抛错）；正文按 `captionMaxLength` 截断，截断时保证不在半个换行处切断；`tags` 去重、去掉前导 `#`、按 `maxTags` 截取；images 按 `maxImages` 截取且强制首张为 `cover`、其余顺序补 `inline-n`。**归一化而非抛错**——LLM 超字数是常态，重跑一次的钱不该由用户出。
- [x] **Step 3:** 同文件加 `articleWorkflowCaptionSummary(captionText)`：取首句/首行前 100 字，作为列表页与历史侧栏的 `summary`。
- [x] **Step 4:** `article-workflow-caption.test.ts` 覆盖：标题超长截断；正文超长截断；标签去 `#`、去重、超量截取；images 超量截取 + slot 重排；`summary` 取首行。
- [x] **Step 5:** article 测试 + typecheck 全绿（用例数 +≥5）。Commit `feat(api): caption 计划 schema 与归一化`

### Task 2.3: LLM 层新增 caption 调用

**Files:** Modify `apps/api/src/workflow/article-workflow-llm.ts`

- [x] **Step 1:** `generateArticleWorkflowPlan` 的 args 加 `platform`，透传给 `buildArticleWorkflowPlanSystemPrompt`。
- [x] **Step 2:** 新增 `generateArticleWorkflowCaptionPlan({ llm, model, platform, config, sourceFormat, sourceText, currentCaption?, instruction? })`：复用 `callLlmText` + `stripCodeFence` + `jsonrepair`，用 `articleWorkflowCaptionPlanSchema` 解析，返回**未归一化**的 plan（归一化由 Task 2.2 的函数在 runner 里做，便于单测分离）。
- [x] **Step 3:** `estimateArticleWorkflowReserveUnits` 加可选 `currentCaption` 计入长度（保持 `Math.max(1000, ...)` 下限不变）。
- [x] **Step 4:** article 测试 + typecheck 全绿。Commit `feat(api): caption 计划的 LLM 调用`

### Task 2.4: 图片生成按平台取尺寸

**Files:** Modify `apps/api/src/workflow/article-workflow-images.ts`

- [x] **Step 1:** `imageSize(slot)` 改成 `imageSize(slot, config)`：`slot === "cover" ? config.coverSize : config.inlineSize`。删掉 `ARTICLE_COVER_IMAGE_SIZE` / `ARTICLE_INLINE_IMAGE_SIZE` 的直接引用（常量本身保留在 shared.ts 供 wechat 配置引用）。
- [x] **Step 2:** `generateArticleWorkflowImageAsset` 与 `populateArticleWorkflowImages` 的 args 各加 `config: ArticleWorkflowPlatformConfig`。alt 兜底文案按平台走：wechat 保持"公众号头图"/"正文配图"，caption 平台用"封面图"/"配图"。
- [x] **Step 3:** `chargeResource` 的 `resourceKey` 计算方式不动（仍是 `imageGenerationResourceKey(imageResolutionFromSize(size))`）——三个平台的尺寸都是 1k 预设，落到同一资源键，计价不变。
- [x] **Step 4:** article 测试 + typecheck 全绿（既有用例断言的 size 仍是 wechat 的两个值）。Commit `feat(api): 配图尺寸按平台取值`

### Task 2.5: runner 按 outputKind 分叉

**Files:**
- Modify: `apps/api/src/workflow/article-workflow-runner.ts`
- Create: `apps/api/src/workflow/article-workflow-runner-caption.ts`

- [x] **Step 1:** `MaterializedArticle` 增 `captionText: string`、`tags: readonly string[]`（wechat 路径填 `""` / `[]`）。`commitReadyArticleProject` 把这两个字段写进终态（走既有 `finalizeArticleWorkflowProjectState`，**继承条件写与 reaper 抢占保护**）。
- [x] **Step 2:** 从 `materializeArticleWorkflow` 里抽出**共享的图片填充 + 进度上报**为 `populateWithProgress({...})`（35% → 70% 那段，含 `onCharged` 收集与 `onProgress` 写库），两条链路共用，避免图片费回滚逻辑出现第二份拷贝。
- [x] **Step 3:** 现有 `work` 主体改名为 `materializeHtmlFragmentArticle`（plan → 保留模式校验 → 图片 → layout → HTML guard → manifest 落 HTML），行为逐行不变。
- [x] **Step 4:** 新建 `article-workflow-runner-caption.ts` 落 `materializeCaptionArticle`：`generateArticleWorkflowCaptionPlan` → `normalizeArticleWorkflowCaptionPlan` → 写库（title/summary/manifest，进度 `illustrating` 35%）→ `populateWithProgress` → 直接返回 `{ title, summary, bodyHtml: "", captionText, tags, imageManifest }`。**不调 layout、不过 HTML guard。**
- [x] **Step 5:** `materializeArticleWorkflow` 的 args 加 `platform`，在 `work` 内按 `config.outputKind` 二选一分派；`runReservedArticleTextTask` 包裹层、`onReserved` 落 `billingOperationId`、`commitResult`、`refundChargedImages` 全部保持在外层共用。
- [x] **Step 6:** 两个入口函数 `runInitialArticleWorkflowGeneration` / `runArticleWorkflowRewrite` 的 args 加 `platform`（rewrite 从 `project.platform` 读），并把 caption 平台的进度文案改成「AI 正在写文案」/「文案已生成」（wechat 文案不变）。
- [x] **Step 7:** article 测试 + typecheck 全绿，**20 个既有用例原样通过**。Commit `feat(api): 图文生成器按平台输出形态分叉`

---

## 阶段 3：路由与批次（约 0.5–1 天）

### Task 3.1: 创建接口收多平台，返回批次

**Files:**
- Modify: `apps/api/src/workflow/article-workflow-schema.ts`
- Modify: `apps/api/src/workflow/article-workflow-routes.ts`

- [x] **Step 1:** `createArticleWorkflowProjectSchema` 加 `platforms: z.array(platformSchema).min(1).max(3).optional().default(["wechat"])`（`.transform` 去重）。`generationMode` 语义变为「期望模式」，实际模式由 `resolveArticleWorkflowMode` 按平台裁定。**保留缺省 `["wechat"]` 以兼容旧客户端。**
- [x] **Step 2:** `POST /api/workflow/article-workflow` 改为：生成一个 `batchId = randomUUID()`；对每个平台 create 一行（`platform`、`batchId`、`generationMode: resolveArticleWorkflowMode(...)`，其余字段与今天一致）；逐行 `scheduleTask(() => runInitialArticleWorkflowGeneration({ ..., platform }))`。
- [x] **Step 3:** 响应体改为 `{ batchId, projects: [{ projectId, platform }], projectId: <首个> }`——`projectId` 保留是为了不打破旧前端与既有用例。
- [x] **Step 4:** article 测试全绿（既有创建用例走 default `["wechat"]`，断言 `data.projectId` 仍在）。Commit `feat(api): 图文创建接口支持多平台批次`

### Task 3.2: 批次查询与历史

**Files:** Modify `apps/api/src/workflow/article-workflow-routes.ts`、`article-workflow-shared.ts`（历史上限常量）

- [x] **Step 1:** 新增 `GET /api/workflow/article-workflow/batch/:batchId`：按 `{ userId, batchId }` findMany（`orderBy: { createdAt: "asc" }`），空数组返回 404，否则返回 `{ batchId, projects: [...serializeArticleWorkflowProject] }`。**必须注册在 `GET /:id` 之前**，否则 Fastify 会把 `batch` 当成 id。
- [x] **Step 2:** `GET /history` 保持返回**扁平** summary 数组（已带 `platform`/`batchId`），把 `ARTICLE_HISTORY_LIMIT` 从 20 提到 60（一批最多 3 行，仍保证 ≥20 个批次）。分组是纯展示逻辑，放前端纯函数里做（阶段 4 Task 4.2）。
- [x] **Step 3:** 补路由用例：批次查询返回 3 行且平台各异；跨用户批次返回 404；`/batch/:id` 不被 `/:id` 抢路由。
- [x] **Step 4:** article 测试 + typecheck 全绿。Commit `feat(api): 图文批次查询接口`

### Task 3.3: 保存、改稿、重生图按平台分叉

**Files:** Modify `apps/api/src/workflow/article-workflow-schema.ts`、`article-workflow-routes.ts`

- [x] **Step 1:** `updateArticleWorkflowProjectSchema` 拆两支：`updateArticleWorkflowHtmlProjectSchema`（今天的 title/summary/bodyHtml）与 `updateArticleWorkflowCaptionProjectSchema`（`title`、`summary` 可选、`captionText` min 1 / max 20_000、`tags` 用 `articleWorkflowTagsSchema`）。
- [x] **Step 2:** `PATCH /:id` 先读项目取 `platform`，再按 `outputKind` 选 schema：`html-fragment` 分支逐行保持今天的行为（`assertArticleWorkflowHtmlFragment` + `applyArticleImageManifestToHtml`）；`caption` 分支**不过 HTML guard**，写 `captionText`/`tags`，`bodyHtml` 保持 `""`。两支都置 `ready`/100%。
- [x] **Step 3:** `POST /:id/rewrite`：`generationMode` 经 `resolveArticleWorkflowMode(project.platform, ...)` 裁定后落库；`runArticleWorkflowRewrite` 传 `platform`。caption 平台的 `currentCaption` 由 runner 从项目行读，路由不额外传参。
- [x] **Step 4:** `POST /:id/images/:slot/regenerate`：给 `generateArticleWorkflowImageAsset` 传 `config: articleWorkflowPlatformConfig(project.platform)`；caption 平台跳过 `applyArticleImageManifestToHtml`（只更新 manifest）。
- [x] **Step 5:** 补用例：caption 项目保存不触发 HTML guard；caption 项目 PATCH 传 bodyHtml 被忽略；xiaohongshu 项目 rewrite 请求 `preserve-text` 落库为 `polish-text`；caption 项目重生图用 3:4 尺寸。
- [x] **Step 6:** article 测试 + typecheck 全绿。Commit `feat(api): 图文保存/改稿/重生图按平台分叉`

### Task 3.4: 计价接口带上平台元信息

**Files:** Modify `apps/api/src/workflow/article-workflow-pricing.ts`（+ 既有测试）

- [x] **Step 1:** `ArticleWorkflowPricing` 加 `platforms: readonly { platform, label, outputKind, maxImages }[]`，从 `ARTICLE_WORKFLOW_PLATFORM_CONFIGS` 生成。`maxImages: 5` 保留（旧字段，前端过渡期还在读）。
- [x] **Step 2:** `DEFAULT_ARTICLE_WORKFLOW_TEXT_PRICE.displayName` 从"公众号图文生成"改为"多平台图文文本生成"（**只改兜底展示名，`resourceKey` 一个字都不能动**——billing 侧按键取价）。
- [x] **Step 3:** article 测试 + typecheck 全绿。Commit `feat(api): 图文计价接口返回平台元信息`

---

## 阶段 4：前端工作台批次化（约 1.5–2 天）

**ADR-007 约束：** 视图组件保持薄，纯逻辑进 `*Model.ts`，React-free 且带 colocated 测试。

### Task 4.1: API 客户端支持平台与批次

**Files:** Modify `apps/web/src/workflowArticleApi.ts`

- [x] **Step 1:** `ArticleWorkflowProjectSummary` 加 `platform`、`batchId`；`ArticleWorkflowProject` 加 `captionText`、`tags`。
- [x] **Step 2:** `createArticleWorkflowProject` 的 body 改成 `{ sourceFormat, sourceText, generationMode, platforms }`，返回类型改 `{ batchId, projects: readonly { projectId, platform }[], projectId }`。
- [x] **Step 3:** 新增 `getArticleWorkflowBatch(token, batchId): Promise<{ batchId, projects }>`。
- [x] **Step 4:** `updateArticleWorkflowProject` 的 body 改成联合类型（html 支 / caption 支）。`ArticleWorkflowPricing` 加 `platforms`。
- [x] **Step 5:** typecheck + web 测试全绿。Commit `feat(web): 图文 API 客户端支持多平台批次`

### Task 4.2: 批次分组纯函数

**Files:**
- Modify: `apps/web/src/components/workflow/articleWorkflowStudioModel.ts`
- Create: `apps/web/src/components/workflow/articleWorkflowBatchModel.ts`
- Create: `apps/web/src/components/workflow/articleWorkflowBatchModel.test.ts`

- [x] **Step 1:** `articleWorkflowBatchModel.ts` 落纯函数：`groupArticleWorkflowHistory(rows)` → `readonly { batchId, key, title, summary, platforms, status, updatedAt }[]`（`batchId` 为 null 时用 `project:${id}` 当 key 自成一批；批次标题优先取 wechat 行、否则取首个 `ready` 行、否则取第一行；批次状态：任一 busy → busy，全 ready → ready，否则 failed；按 `updatedAt` 倒序）。
- [x] **Step 2:** 同文件加 `articleWorkflowBatchProgress(projects)`（返回 `{ completed, total, percent }`，供忙碌面板显示「2/3 平台已完成」）与 `platformLabel(platform)`。
- [x] **Step 3:** `articleWorkflowStudioModel.ts` 的 `articleWorkflowDraftHash` 扩成同时覆盖 `captionText` 与 `tags`（否则 caption 平台改文案不会触发自动保存）。
- [x] **Step 4:** 新建测试覆盖：三平台同批次分组为一条；`batchId: null` 的存量行各自成批；标题优选 wechat；混合状态取 busy；hash 对 captionText/tags 变化敏感。
- [x] **Step 5:** web 测试 + typecheck 全绿（用例数 +≥5）。Commit `feat(web): 图文批次分组纯函数`

### Task 4.3: hook 从单项目升级为批次 + 平台页签

**Files:** Modify `apps/web/src/components/workflow/useArticleWorkflowStudio.ts`

- [x] **Step 1:** 状态从「单 project」改为「batch」：`batchProjects: readonly ArticleWorkflowProject[]`、`activePlatform`、`selectedBatchKey`。派生 `project = batchProjects.find(p => p.platform === activePlatform) ?? batchProjects[0]`，下游组件继续拿单个 `project`，改动面可控。
- [x] **Step 2:** 草稿状态改为按平台键的 record：`titleDrafts/summaryDrafts/bodyHtmlDrafts/captionDrafts/tagsDrafts: Record<platform, ...>`，`lastSavedHashRef` 改 `Map<platform, string>`。切页签时**不清草稿**（多平台交叉编辑是主场景），仅在切批次时按 `ensureCanLeaveDirty` 提示。
- [x] **Step 3:** 输入面板状态加 `selectedPlatforms: readonly ArticleWorkflowPlatform[]`（默认三个全选，至少留一个不可全部取消）；`handleGenerate` 传 `platforms`，创建成功后按返回的 `batchId` 走 `loadBatch`。
- [x] **Step 4:** 轮询从 `getArticleWorkflowProject` 换成 `getArticleWorkflowBatch`：只要批次内**任一**项目 busy 就继续 2.5s 轮询；全部落终态时提示「N 个平台已生成」并 `onBalanceRefresh`；有失败项时把失败平台名拼进 error 文案。
- [x] **Step 5:** `saveProject` 按当前平台的 outputKind 选 body 形状（html 支 / caption 支）；自动保存与 `handleBodyBlur` 逻辑不变，只是作用于当前平台。
- [x] **Step 6:** 补 `handleSelectPlatform`、`handleTogglePlatform`、`markCaptionDirty`、`markTagsDirty`、`handleCopyCaption`、`handleCopyTags`。
- [x] **Step 7:** web 测试 + typecheck 全绿。Commit `feat(web): 图文工作台按批次与平台页签驱动`

### Task 4.4: 视图组件（页签 / caption 编辑器 / 输入面板）

**Files:**
- Create: `apps/web/src/components/workflow/ArticleWorkflowPlatformTabs.tsx`
- Create: `apps/web/src/components/workflow/ArticleWorkflowCaptionEditor.tsx`
- Modify: `ArticleWorkflowEditor.tsx`、`ArticleWorkflowInputPanel.tsx`、`ArticleWorkflowHistorySidebar.tsx`、`ArticleWorkflowBusyPanel.tsx`、`ArticleWorkflowStudio.tsx`、`ArticleWorkflowImageAssetPanel.tsx`

- [x] **Step 1:** `ArticleWorkflowPlatformTabs.tsx`：批次内平台页签，每个页签带平台名 + 状态点（生成中 / 已完成 / 失败）。
- [x] **Step 2:** `ArticleWorkflowCaptionEditor.tsx`：标题输入（带 `titleMaxLength` 计数）、正文 textarea（带 `captionMaxLength` 计数）、标签编辑（逗号/回车分隔的 chip）、配图九宫格（复用 `ArticleWorkflowImageAssetPanel`）、按钮「复制正文」「复制标签」「复制标题」。字数超限只标红不拦保存。
- [x] **Step 3:** `ArticleWorkflowEditor.tsx` 顶部改为按平台渲染标签与复制按钮（`一键复制到公众号` / `复制小红书文案` / `复制抖音文案`），正文区按 outputKind 在富文本编辑器与 caption 编辑器之间二选一。「AI 重新生成」的模式选择在 caption 平台隐藏（只有 polish 一种）。
- [x] **Step 4:** `ArticleWorkflowInputPanel.tsx`：标题改「多平台图文工作流」，加平台多选（三个 checkbox 卡片，含各平台产物说明）；「生成方式」仅在勾选了公众号时显示；生成按钮上方加成本预估文案「将生成 N 个平台，最多 N×5 张配图」。
- [x] **Step 5:** `ArticleWorkflowHistorySidebar.tsx` 改吃 `groupArticleWorkflowHistory` 的批次条目，每条显示标题 + 平台小标签。`ArticleWorkflowBusyPanel.tsx` 改显示批次进度（`articleWorkflowBatchProgress`）与每平台一行状态。
- [x] **Step 6:** `ArticleWorkflowStudio.tsx` 串起来：无批次 → 输入面板；批次内全 busy → 忙碌面板；否则 → 页签 + 编辑器（**部分平台还在生成时也要能编辑已完成的平台**）。
- [x] **Step 7:** web 测试 + typecheck 全绿。Commit `feat(web): 多平台图文编辑与复制界面`

### Task 4.5: 复制与下载

**Files:**
- Modify: `apps/web/src/components/workflow/articleWorkflowCopyActions.ts`
- Create: `apps/web/src/components/workflow/articleWorkflowImageDownload.ts`
- Modify: `ArticleWorkflowImageAssetPanel.tsx`

- [x] **Step 1:** `articleWorkflowCopyActions.ts` 加 `handleCopyCaption`（纯文本，走既有 `copyArticleWorkflowPlainText`）与 `handleCopyTags`（拼成 `#标签 #标签` 空格分隔）。公众号的三个既有 handler 不动。
- [x] **Step 2:** `articleWorkflowImageDownload.ts` 落 `downloadArticleWorkflowImage({ url, fileName })`：data URL 直接建 `<a download>`；http(s) URL 先 `fetch` 成 blob 再 `URL.createObjectURL`（跨域直链加 `download` 属性无效），失败兜底 `window.open`。**这是纯前端浏览器行为，无需后端改动。**
- [x] **Step 3:** `ArticleWorkflowImageAssetPanel.tsx` 每张图加「下载」按钮（小红书/抖音的主要交付路径），并按平台展示尺寸标签（16:9 / 3:4 / 9:16）。
- [x] **Step 4:** web 测试 + typecheck 全绿。Commit `feat(web): 文案复制与配图下载`

---

## 阶段 5：收口（约 0.5 天）

### Task 5.1: 文案与菜单

**Files:** Modify `apps/web/src/workflowState.ts`、`apps/api/src/admin/client-menu-catalog.ts`

- [x] **Step 1:** `workflowState.ts:224` 附近的模块条目：title 改「多平台图文工作流」，description 改「一次导入，公众号 / 小红书 / 抖音自动配图成稿」。**`id: "article-workflow"` 不改**（前端路由 + 菜单键都依赖它）。
- [x] **Step 2:** `client-menu-catalog.ts:46` 的 label 改「多平台图文工作流」，**`key: "workflow.article-workflow"` 不改**（已下发给客户端的菜单可见性配置按键存库）。
- [x] **Step 3:** grep `公众号图文工作台` / `公众号图文项目` 等用户可见文案，逐处改成平台中立说法（错误提示、加载态、toast）。
- [x] **Step 4:** 全量验证：article 测试 + web 测试 + typecheck。Commit `feat: 图文工作流更名为多平台`

**阶段 4 / 5.1 实施偏差（已落地，供后续 review 对照）：**

- Task 4.3 / 4.4 / 4.5 合并为一个 commit（`37d9556`）。三者共用同一批组件 props 类型，
  单独提交任何一步都过不了 typecheck。
- 复制按钮文案定为「复制文案」「复制标签」，没用计划里的「复制小红书文案」——
  页签已经标了平台，按钮里再写一遍是冗余。
- caption 编辑器**没有**内嵌配图九宫格：`ArticleWorkflowImageAssetPanel` 就在同屏下方，
  且它才带下载/重生按钮，再画一份只会分叉。
- 输入面板的成本提示写成「已选 N 个平台，按平台分别扣费」，没写「最多 N×5 张配图」——
  实际张数由 AI 规划决定，写死上限反而误导。
- 字数计数（标题/正文/标签）单独补在 `4840ca4`。

### Task 5.2: 端到端手测清单

- [ ] 三平台全选生成一次：三个页签都出图、公众号是排版 HTML、小红书/抖音是文案 + 竖版图。
- [ ] 只勾小红书生成：只出 1 行，不产 HTML，`preserve-text` 被降级为 `polish-text`。
- [ ] 公众号「一键复制」粘进公众号编辑器：图文完整、样式不丢。
- [ ] 小红书「复制正文」「复制标签」粘进小红书 App：文案带换行、标签带 `#`。
- [ ] 单张配图下载：文件名可读、尺寸符合平台。
- [ ] 编辑任一平台 → 等 1.5s 自动保存 → 刷新页面内容仍在。
- [ ] 切换平台页签不丢未保存草稿；切换批次有未保存提示。
- [ ] 生成中途 kill API 进程 → 15 分钟后 reaper 把三行都置 failed 并退款（阶段 4 已落地的能力，此处只做回归确认）。
- [ ] 历史侧栏：一次三平台生成显示为**一条**批次记录。
- [ ] 余额不足时创建：三行照常落库（create 返回 201，不是 402），扣费失败的那一行显示 failed + 「余额不足」原因，同批其他平台不受影响。
      注：原先这条写的是「create 报错、不留半截项目行」，与实际设计不符——reserve 在异步 runner 里做，不在 create 请求里。
      契约已由 `article-workflow-routes.test.ts` 的「keeps the other platforms running when one row's reserve fails on balance」锁定，手测只需确认前端把 failed 行的原因展示清楚。

---

## 里程碑与工作量

| 阶段 | 内容 | 估时 | 交付判据 |
| --- | --- | --- | --- |
| 1 | 平台维度落地 | 0.5–1 天 | 四列 + 平台配置在库，20 个既有用例原样绿 |
| 2 | caption 生成链路 | 1–1.5 天 | 小红书/抖音能跑出文案 + 竖版图，公众号零回归 |
| 3 | 路由与批次 | 0.5–1 天 | 一次请求建 N 行、批次查询可用、保存/改稿/重生图分平台 |
| 4 | 前端工作台批次化 | 1.5–2 天 | 页签切换、分平台编辑与复制、配图下载 |
| 5 | 收口 | 0.5 天 | 文案统一、手测清单全过 |

合计约 4–6 天。阶段 1–3 可独立交付（后端先通，用 curl 验证）；阶段 4 依赖阶段 3 的接口定稿。

## 风险与已知残留

- **成本翻倍**：三平台默认全选 = 3 笔文本 reserve + 最多 15 张图。靠输入面板的预估文案兜住；如果实测投诉多，把默认改成只勾公众号（一行常量）。
- **caption 无强校验**：不像公众号有「可见文字完全相等」的硬闸，caption 输出质量只能靠 prompt + 归一化截断保证。字数超限走截断不重跑，可能截掉结尾引导句——观察真实产出后再决定是否加一次「超限重试」。
- **`ArticleWorkflowDocument` 加字段**：已实测该类型只在 `packages/article-workflow/src/{types,index}.ts` 内出现，`apps/` 下零引用，因此加字段安全、`version` 保持 `1`。执行 Task 1.1 时仍复核一次 grep；若届时已出现落库处，改为新增 `version: 2` 分支。
- **批次不是事务**：N 行分别 create、分别 fire-and-forget。某行 create 后进程崩溃，该行由 reaper 收尸，其余行不受影响——这是有意为之（批次原子性不值得引入队列）。
- **历史接口取 60 行**：极端情况下（用户连续做 60 个单平台项目）侧栏批次数会超过 20 条。属可接受偏差，真要精确分页得先落 `ArticleWorkflowBatch` 表。


---

## 附录 A：正文编辑器保真改造（计划外，Task 5.2 手测暴露）

手测「公众号一键复制」时发现：进编辑态什么都不改、刷新后正文就没了。库里两行已被毁。
根因是编辑器 + 自动保存 + 图片回写三处叠加，完整取证与四层修法见
[pitfalls.md「富文本编辑器静默拍平生成结果」](../../pitfalls.md)，选型理由见 [ADR-010](../../decisions.md)。

### 实施顺序（按毁稿链路从后往前堵）

1. **服务端 guard**（止血，先上）
   - `apps/api/src/workflow/article-workflow-html-guard.ts` 新增 `assertArticleWorkflowBodyNotDestroyed({nextHtml, currentHtml})`。
     只拦两种整体销毁：文字全清空、图片槽位全丢。判定相对旧正文，因此本来没图的文章不受影响，
     修复已损坏行的写入也放行。
   - `article-workflow-routes.ts` 的 PATCH 在形状校验**之前**调用它，违反返 422。
     顺序不能反——`assertArticleWorkflowHtmlFragment` 的 `expectedVisibleText` 取自请求自身，对「被清空」无感。
2. **自动保存改成内容驱动**
   - `useArticleWorkflowStudio.ts` 新增 `syncDirtyByContent(platform, override)`：按完整草稿哈希与
     `lastSavedHashRef` 比对置脏，五个 mutator 全部改用它，不再 `markDirty(platform, true)`。
   - `handleBodyBlur` 的自动保存也加同一道比对：编辑器打开就会失焦一次，那一发不该写库。
3. **换编辑器**
   - `packages/article-workflow/src/html-vocabulary.ts`（新）：标签/属性/禁止标签白名单 + 槽位属性名，
     服务端 guard 与前端 sanitizer 同源。比原服务端列表多了 `u`、`s`（Squire 的下划线/删除线产物）。
   - `apps/web/src/components/workflow/articleWorkflowHtmlSanitizer.ts`（新）：喂给 Squire 的
     `sanitizeToDOMFragment`。与服务端 guard 相反——guard 遇违规抛错，这里**尽量救**：
     白名单外的标签只脱壳保留内容，别让粘贴一次就整篇报废。用 `<template>` 解析（惰性，脚本不执行、图片不发请求）。
     遍历用游标而非先快照：脱壳会把孩子提上来，那些孩子也得过一遍。
   - `ArticleWorkflowRichEditor.tsx` 重写在 `squire-rte` 上，props 契约不变
     （`{value, placeholder?, syncKey, onChange, onBlurCommit?}`），上层零改动。
     工具栏只留加粗/斜体/下划线/链接/清格式/撤销/重做——段落、对齐、列表这类布局键会跟生成好的 section 打架。
   - 移除 `@wangeditor/editor`、`@wangeditor/editor-for-react`（连带裁掉 50 个包），
     `articleWorkflowRichEditor.css` 从 `.w-e-*` 选择器改写为自有类名。

### 必须知道的一个坑：Squire 载入时会等价改写

`stylesRewriters` 是模块级常量，配置项里关不掉。载入 `strong` / `em` 会变成 `b` / `i`，
只含图片的块会被补一个 `<br>`。这些改写等价，但**不是用户意图**——直接提交上去就又变成「打开即写库」。

组件因此同时留两份引用：`loadedHtmlRef`（编辑器整理后的那版，用来判断有没有真编辑）和
`originalValueRef`（灌进来的原始字节）。失焦时若 `getHTML() === loadedHtmlRef`，交回**原始字节**，
上层哈希比对判成无变化，不写库。用户真的编辑后才提交编辑器的 HTML，改写随之落库——等价且在白名单内。

### 验证结果

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| guard + 路由 | `cd apps/api && pnpm exec vitest run src/workflow/article-workflow-html-guard.test.ts src/workflow/article-workflow-routes.test.ts` | 27 passed（10 + 17） |
| web 全量 | `cd apps/web && pnpm exec vitest run` | 77 files / 400 passed |
| 类型 | `cd apps/web && pnpm exec tsc --noEmit -p tsconfig.json` | clean |
| 构建 | `cd apps/web && pnpm exec vite build` | 通过，squire 独立 chunk 59.65 kB（gzip 18.37 kB） |

新增回归用例：

- `articleWorkflowHtmlSanitizer.test.ts`（15）：section 嵌套/内联样式/槽位往返、幂等、
  未知标签脱壳、危险标签删除、`javascript:` 六种写法（含大小写混写、中间插制表符、前置空白）与非图片 `data:` 拦截。
- `ArticleWorkflowRichEditor.roundtrip.test.tsx`（3）：真实公众号版式载入后 section 数、
  4 个槽位标记、逐条内联样式、图片属性、全部文字都在；只打开不动手**不触发 onChange**；失焦提交与原文等价。
- `ArticleWorkflowRichEditor.normalize.test.tsx`（5）：用户没动过时失焦提交的就是**原字节**
  （`toBe(原文)`，把上面那个等价改写坑锁死）；base64 内联图不被洗掉；真改了字才提交编辑器 HTML。
- `ArticleWorkflowStudio.retry.test.tsx` 增 3 条：改回原样后不再自动保存、原值重复写入不触发保存、真改了照旧保存。

### 残留

- **一行被毁数据未恢复**：`cms4aaabz0002c3biwrzjp3mn`（可见文字 0，是旧 wangEditor 拍平留下的）。
  `sourceText` 817 字完好，点「重新生成」即可自愈，但**要花算力点**，留给用户决定。
  它的 11.4 MB 体积是 base64 膨胀造成的，已被下面的修复顺带清掉（→ 2,554 字节），但**文字仍是空的**。
- Task 5.2 手测清单中「一键复制粘进公众号编辑器」仍未通过，且不是代码问题：公众号是服务端抓图，
  必须配 `S3_PUBLIC_BASE_URL` / `IMAGE_S3_PUBLIC_BASE_URL` 让配图有公网可取地址。
  data URL 和需要鉴权的相对地址它都拿不到。本地环境不具备这个前提。

## 附录 B：真机跑通与两个线上 bug（2026-07-28）

用户要求「跑一次真实的测试，把 bug 都修复掉」。在**用户已启动的实例**上（API 8090 / web 5174）
用真实模型与真实对象存储跑，不另起一套。跑出两个 bug，都已修。

### B.1 `<h2>` 让整篇生成判失败

页面报「HTML 包含未允许的标签: `<h2>`」。白名单只放行了模型上次用的标签，模型在等价层级间摆动就整篇失败。
放开 `h2`/`h3`/`h4` 并加 `repairArticleWorkflowHtmlFragment` 修复层后，真机重试跑完整链路：
drafting 12% → illustrating 35% → 配图 2/4 53% → layout 80% → **ready 100%**，4 张真实配图。
详见 [pitfalls.md](../../pitfalls.md)「排版模型换了个标题层级」。

### B.2 配图 base64 写进正文（真正的大头）

`bodyHtml` 10,548,130 字节、详情接口 **31,641,351 字节 / 0.602 s**。根因是 `storeWorkflowImage`
的本地内联分支返回 data URL，而图文链路把它写进了会落库的字段，同一张图存三份。
修法见 [ADR-011](../../decisions.md)：落库存稳定代理地址、出参现签短期签名、保存前摘掉签名。

同一接口改前改后实测：

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| 详情接口字节数 | 31,641,351 | **8,583** |
| 详情接口耗时 | 0.602 s | **0.0087 s** |
| `bodyHtml` 字节数 | 10,548,130 | 4,154 |
| 正文含 `data:image` | 是 | 否 |

历史数据用一次性脚本按 manifest 重建正文（字节已在 MinIO 里，**不重新生成、不计费**）：
先全量备份 7 行到 `/tmp/aw-rows-backup.json`（197,773,930 字节），再修 6 行，释放 **177,811,134 字节**。

**页面能不能显示出图**是这次的关键收尾：`<img>` 带不上 `Authorization` 头，而 web 端登录态只在
`localStorage`，所以只靠会话鉴权的取图地址在页面上必然是碎图——这是我自己第一版修法引入的回归。
出参签名解决它。三个平台在实例上实测：公众号正文 4 张图、抖音 4 张、小红书 3 张，
**完全不带任何鉴权头**请求，全部 200 `image/png`，PNG magic `89504e470d0a1a0a`，1.69–2.14 MB。

### B.3 验证

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| 图文全量（api） | `cd apps/api && pnpm exec vitest run src/workflow/article-workflow` | 12 files / 111 passed |
| web 全量 | `cd apps/web && pnpm exec vitest run` | 77 files / 401 passed |
| 类型 | `apps/api` 与 `apps/web` 各 `pnpm exec tsc --noEmit` | 均 clean |

新增回归用例：

- `article-workflow-image-url.test.ts`（7）：data URL + `objectKey` → 代理地址；
  **没有 `objectKey` 时保留 data URL**（那是图片唯一副本）；http(s) 不动；幂等；转义。
- `article-workflow-image-signed-url.test.ts`（12）：签名可验；换 assetId / 改 `exp` / 换密钥 / 过期全部验不过；
  没有密钥时退回稳定地址；出参→落库往返无损；重复出参不叠第二层签名；属性里是 `&amp;` 不是裸 `&`。
- `article-workflow-image-blob-routes.test.ts`（10）：带签名**不需要会话**就能取图；
  签名伪造/过期/张冠李戴一律退回会话鉴权（无会话即 401 且**不碰对象存储**）；
  别人的资产 404；非 `image/*` 的 mime 一律按 png 送出。
- `article-workflow-image-inline.test.ts`（3）：真实 POST + 调度跑完后正文与 manifest 里都没有 base64、
  `bodyHtml < 4096` 字节；每个 assetId 的代理地址都能取到字节；
  **库里稳定地址 → 出参签名地址 → 保存后库里还是稳定地址**这一整圈。
- `article-workflow-image-url-raw-amp.test.ts`（3）：编辑器把 `&amp;` 反序列化成裸 `&` 时，
  正文照样能过校验、assetId 照样能还原（xmldom 会警告 entity not found 但不抛错）。
- `articleWorkflowBatchModel.test.ts` 增 1 条：签名变化**不算内容改动**（否则自动保存每 1.5 秒发一次）。
- `articleWorkflowHtmlSanitizer.test.ts` 增 1 条：前端清洗保留签名查询串（洗掉就全是碎图）。

### B.4 已知残留

- `thumbnailUrl` 与 `imageUrl` 指向同一个对象（都是 ~2 MB 原图），caption 平台的卡片墙因此在下载原图。
  这是既有行为（改前是 2 MB data URL），不在本次范围内，但值得单独做一次真缩略图。
- 签名 TTL 6 小时。页面开着超过 6 小时不刷新会出现碎图，刷新即恢复。真要消掉这一条，
  得让取图路由在签名过期时回落到 cookie 会话——前提是 web 端先改成写 cookie。
