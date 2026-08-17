# 数字人口播（dub）

> 自包含模块文档：设计 spec、分阶段实现计划、上游接口与数据模型。

## 一、模块概述

用户上传一段参考视频，平台自动完成：**分析拆解 → 洗稿改写文案 → MiMo TTS 生成口播音频 → 选/建数字人形象（飞天）→ 飞天数字人对口型成片 → 叠 BGM 出成品**。全程按算力点（文案/语音/分析）和视频点（数字人操作）计费。

内部模块名 `dub`，代码在 `apps/api/src/workflow/dub-*.ts`，前端页面名「数字人口播」。

## 二、核心架构决策

- **对口型上游 = 飞天数字人**（`skyhumanapi.pilihu.vip`），不用 seedance。飞天是音频驱动、返回 duration，无超时长拆分限制。
- **TTS = 小米 MiMo**（`api.xiaomimimo.com/v1`，OpenAI 兼容）。选 MiMo 而非飞天自带 TTS，因为要覆盖「文字描述音色」(voicedesign) 能力。**MiMo 管声音，飞天管人像**。
- **多租户铁律**：飞天的 `avatar/list`、`account/credit` 是平台单 token 级、全租户混一起。**绝不直接暴露给用户**——自建 `Avatar` 表按 userId 隔离。
- **异步用回调 + 轮询兜底**：飞天克隆/成片是异步操作。回调为主、reaper 轮询为兜底。
- **计费**：飞天数字人视频域操作 → 视频点；文案/语音/分析 → 算力点。

## 三、分阶段实现计划

### 数字人口播成片流水线 · 设计 spec

> 源文件：`2026-07-08-dub-digital-human-design.md`


> 立项 2026-07-08。内部模块名 `dub`（文件前缀 `apps/api/src/workflow/dub-*`，对齐现有 `video-*/comic-*/ecom-*/fanout-*` 命名）。用户端页面名「数字人口播」。

#### 1. 目标

用户上传一段参考视频，平台自动：分析拆解 → 洗稿改写文案（可挂知识库）→ MiMo TTS 生成口播音频 → 选/建数字人形象 → 飞天数字人对口型成片 → 叠 BGM 出成品。全程按算力点/视频点计费。

#### 2. 关键决策（已锁定）

- **对口型上游 = 飞天数字人**（`skyhumanapi.pilihu.vip`），**不用 seedance**。飞天是整条音频驱动、返回 `duration`，**去掉「超时长拆 15s 再合并」**（那是 seedance-mini 固定档限制；飞天无此限，实现时探一次真实上限，真撞上限再补分段，隔离良好不伤主干）。
- **TTS = 小米 MiMo**（`api.xiaomimimo.com/v1`，OpenAI 兼容、独立 key、同步返回 base64 音频）。选 MiMo 而非飞天自带 TTS，因为要覆盖原需求的「文字描述音色」(voicedesign)，飞天没有。职责切分：**MiMo 管声音，飞天管人像**。
- **多租户铁律**：飞天 `avatar/list`、`account/credit` 是**平台单 token 级、全租户混一起**，绝不直接暴露给用户。**自建 `Avatar` 表按 userId 隔离**。
- **异步用回调 + 轮询兜底**：飞天成片/克隆异步。回调（带 secret）为主、reaper 轮询为兜底（复用现有 reaper 模式），任一条通即可。
- **计费规则**：飞天（数字人视频域）操作 → **视频点**；文案/语音/分析 → **算力点**。

#### 3. 上游接口摘要

##### 3.1 飞天数字人（`https://skyhumanapi.pilihu.vip`，`Authorization: Bearer <SKYHUMAN_API_TOKEN>`）
统一响应 `{code,message,data,request_id}`，`code=0` 成功；401=token 失效；业务异常 HTTP200 靠 code 区分。任务状态 `1 等待/2 处理/3 完成/4 失败`。

- `POST /api/v2/fly/upload/create_upload_url` `{file_extension}` → `{upload_url(预签名PUT,10min), content_type, file_id}`；再 PUT 二进制到 upload_url（Content-Type 用返回值）。
- `POST /api/v2/fly/avatar/create_by_video` `{title, video_url | file_id}` → `{task_id}`。
- `GET /api/v2/fly/avatar/task?task_id=` → `{status, avatar}`（完成返 avatar_code）。
- `POST /api/v2/fly/avatar/delete` `{avatar_code}`。
- `POST /api/v2/fly/video/create_by_audio` `{avatar, audio_url | file_id, title}` → `{task_id}`（**消耗积分**）。
- `GET /api/v2/fly/video/task?task_id=` → `{status, video_url(临时,尽快转存), duration}`。
- `GET /api/v2/fly/account/credit` → `{left}`（平台余额，仅 admin 用）。
- 回调（账号级配置，无签名）：完成/失败推 `{task_id,type(clone|video),status,avatar|video_url,duration,cost,error_message}`；非 200 视为失败，5 分钟内重试。
- 错误码：`11 参数错/14 找不到资源/1001 并发上限/1002 积分不足/2003 token 无效/2013 取音频失败/2014 取视频失败/2015 克隆失败`。

##### 3.2 MiMo TTS（`https://api.xiaomimimo.com/v1/chat/completions`，header `api-key: <MIMO_API_KEY>`）
非流式，`audio:{format:"wav"|"mp3", voice}`，返回 `choices[0].message.audio.data`(base64)。三模型：
- `mimo-v2.5-tts` 预置精品音色（voice=冰糖/茉莉/苏打/白桦/Mia/…；风格用 user 消息自然语言或 assistant 内 `(风格)`/`[标签]`）。
- `mimo-v2.5-tts-voicedesign` 文字描述音色（user 消息=音色描述；`optimize_text_preview:true` 可免 assistant）。
- `mimo-v2.5-tts-voiceclone` 音频复刻（`voice="data:audio/mpeg;base64,<...>"`，≤10MB，mp3/wav）。
- 目标文案放 **assistant** 消息；user 消息放风格/音色描述。

#### 4. 数据模型（Prisma，新增 3 表）

##### `DubProject`（向导聚合状态，一次成片一行）
```
id, userId
sourceVideoUrl?, sourceObjectKey?            // 上传的参考视频
analysis        Json?                          // §6 多板块分析结果
script?                                        // 洗稿后的口播文案（可编辑）
attachedKbIds   String[]  @default([])         // 洗稿挂的知识库
ttsMode         String?                        // preset | design | clone
ttsParam        Json?                          // {voice} | {description} | {refObjectKey}
audioUrl?, audioObjectKey?, audioDurationSec?  // TTS 口播音频
avatarId?                                      // 引用 Avatar.id
bgmRef?         Json?                          // {kind:preset,id} | {kind:upload,objectKey} | null
bgmVolume       Float     @default(0.3)
resultVideoUrl?                                // 飞天原片（转存我方 S3）
finalVideoUrl?, finalObjectKey?                // 叠 BGM 成品
stage           String    @default("draft")    // draft→analyzed→scripted→voiced→generating→mixing→done|failed
error?
billingOperationIds String[] @default([])
createdAt, updatedAt
@@index([userId, createdAt]) @@index([userId, stage])
```

##### `SkyhumanTask`（飞天异步任务，结构照抄 `VideoGenerationTask`）
```
id, userId, projectId?
kind            String                         // avatar_clone | video_create
providerTaskId  String?
status          String    @default("running")  // running | completed | failed
resultPayload   Json?                          // {avatarCode} | {videoUrl,duration,cost}
resourceKey     String
chargedPoints   Int       @default(0)
error?, completedAt?, createdAt, updatedAt
@@index([status, updatedAt])                   // reaper
@@index([providerTaskId]) @@index([userId, createdAt])
```

##### `Avatar`（用户数字人形象库，userId 隔离）
```
id, userId, avatarCode, title, coverUrl?, sourceObjectKey?, isFavorite Boolean @default(false), createdAt
@@index([userId, createdAt])
```

##### BGM 预制（admin 管理）
```
model DubBgmPreset { id, title, url, objectKey, sortOrder Int @default(0), enabled Boolean @default(true), createdAt }
```
用户上传的 BGM 不单独建表，随 `DubProject.bgmRef{kind:upload,objectKey}` 存对象键即可。

#### 5. 接口与流程

| 步 | 接口 | 同步性 | 计费 | 复用 |
|---|---|---|---|---|
| 分析 | `POST /api/workflow/dub/projects`（multipart 视频）| M3 同步 | `video_analyze_video_sec` 按秒·算力点 | analyze-reference/M3 视频直传 |
| 洗稿 | `POST /api/workflow/dub/projects/:id/rewrite` `{attachedKbIds, injectHighlights?}` | LLM 同步 | LLM token **×3**·算力点 | KB 检索注入 |
| 配音 | `POST /api/workflow/dub/projects/:id/tts` `{mode, param}` | MiMo 同步 | `dub_tts_char` 按输入字符·算力点 | 新 mimo client |
| 形象-建 | `POST /api/workflow/dub/avatars`（multipart 无配音场景视频）| 异步 | `dub_avatar_clone` PER_CALL·视频点 | 飞天 upload+create_by_video |
| 形象-列/删/收藏 | `GET/DELETE/PATCH /api/workflow/dub/avatars[/:id]` | 同步 | — | 自建隔离 |
| 成片 | `POST /api/workflow/dub/projects/:id/generate` `{avatarId, bgmRef?, bgmVolume?}` | 飞天异步 | `dub_video_sec` 按秒·视频点 | 照 task 范式 |
| 状态 | `GET /api/workflow/dub/projects/:id` | 同步 | — | — |
| 回调 | `POST /api/workflow/dub/skyhuman/callback?secret=` | — | — | reaper 兜底 |
| BGM | `GET /api/workflow/dub/bgm`（预制+我方上传）/ `POST .../bgm`（用户上传）| 本地 | — | — |
| BGM-admin | `GET/POST/PATCH/DELETE /api/admin/dub/bgm` | — | — | requireAdmin |

**拆解可选**：有原视频就分析；也允许直接粘贴/手写文案跳过分析步（`analysis=null, script=手填`）。

**文件流转**：avatar 源视频、口播音频优先走飞天 `create_upload_url`+PUT 拿 `file_id` 传给飞天，**不把我方 S3 暴露给飞天**（规避 2013/2014）。MiMo base64 音频：先转存我方 S3（留档+ffprobe 测长）→ 再 PUT 飞天拿 file_id。成片结果 `video_url` 临时 → 立即转存我方 S3。

#### 6. 分析视频 = 多板块结构化拆解

M3 一次调用（视频直传 Anthropic `video` block，判 ingest 看 input_tokens 上涨）产出结构化 JSON，前端**分区展示 + 口播文稿可编辑**：

| 板块 key | 内容 | 用途 |
|---|---|---|
| `spokenScript` | 逐字口播完整文稿 | **默认喂洗稿** |
| `shotScript` | 分镜脚本（画面/台词/时长逐镜）| 展示参考 |
| `structure` | 结构拆解（开头钩子/正文/结尾 CTA/节奏）| 展示参考 |
| `highlights` | 亮点卖点（卖点/受众/场景）| 洗稿可选注入 |

洗稿默认改写 `spokenScript`；`injectHighlights=true` 时把 `highlights` 作为约束注入 prompt。

#### 7. 计费终版

| 环节 | 上游 | key | 计法 | 钱包 | 备注 |
|---|---|---|---|---|---|
| 分析视频 | M3 | `video_analyze_video_sec`（复用）| PER_UNIT 按秒 | 算力点 | 预扣→按 ffprobe 时长结算 |
| 洗稿文案 | M3 | LLM token | reserve/settle **×3**（api 层 token×3，不改 Go）| 算力点 | 同「脚本生成」隐藏模型名口径 |
| 配音 TTS | MiMo | `dub_tts_char` | PER_UNIT 按输入字符（后台配每字单价）| 算力点 | 预扣=字符数，成功后 settle |
| 建形象 | 飞天 | `dub_avatar_clone` | PER_CALL（后台可配，可停用）| 视频点 | 克隆一次 |
| 成片视频 | 飞天 | `dub_video_sec` | PER_UNIT 按秒 | 视频点 | reserve 按音频估长→settle 按飞天返回 duration |
| 叠 BGM | 本地 ffmpeg | 免费 | — | — | — |

**资金红线**：所有异步计费一律 **reserve 先于提交 → 成功 settle → 失败/1001/1002/超时全额退 reserve**，绝不假成功扣费。新 key 走现有 `ResourcePrice`，admin 资源计价页自动可配。**上线前须在后台配真实单价并启用**，否则该环节应置灰不可用（沿用 helpwrite「价格未配置置灰」交互）。

#### 8. 飞天多租户治理（关键风险）

平台单 token，三硬问题：
- **并发上限（1001）**：Redis 全局信号量限并发飞天任务数（键 `yunclaude:dub:sky:sem`）；触顶入队等待/退避重试，不直接失败告知用户。
- **积分不足（1002）**：飞天平台余额耗尽 → 用户显示「平台繁忙，稍后重试」+ 退 reserve + 告警 admin，不扣用户。`GET /api/admin/dub/skyhuman/credit` 给 admin 查飞天余额。
- **回调无签名**：`?secret=<SKYHUMAN_CALLBACK_SECRET>` 门 + 回调只当唤醒信号，收到后拿 `task_id` 回查飞天 `GET video/task` 取权威结果，不信 body。reaper（键 `yunclaude:dub:reaper:lock`）扫 `status=running` 超期任务补查。

#### 9. 客户端（MiMo / 飞天）实现约束

- **MiMo client**：裸 fetch 到 `/v1/chat/completions`，header `api-key`，body 按模式构造 messages+audio；解析 `choices[0].message.audio.data` base64。独立文件 `apps/api/src/workflow/dub-mimo-client.ts`，**不进 `packages/llm`**（那是 Anthropic 兼容层）。env `MIMO_API_KEY`。
- **飞天 client**：`apps/api/src/workflow/dub-skyhuman-client.ts`，封装 upload/avatar/video/credit/poll，zod 校验响应，超时+重试+错误码归一。env `SKYHUMAN_API_TOKEN` / `SKYHUMAN_BASE_URL` / `SKYHUMAN_CALLBACK_SECRET`。
- 两个 token 均只进 k8s secret，绝不硬编码；本会话明文出现过，**上线前轮换**。

#### 10. UI

- 新页 `apps/web/src/pages/DigitalHuman.tsx`：多步向导，照 `HelpWriteWizard`（步骤条 + 每步「确认消耗算力点」再扣）。步骤：上传/粘贴文案 → 分析结果分区展示（口播文稿可编辑）→ 洗稿（选 KB / 注入亮点）→ 配音（三模式 + 试听）→ 选形象（形象库/新建）→ 配 BGM（预制/上传/音量）→ 成片（异步进度）→ 预览下载。
- 形象库管理（建/选/删/收藏）。
- admin：BGM 预制 CRUD + 新 ResourcePrice key 自动出现在资源计价页 + 飞天余额查看。

#### 11. 分期（一个 spec → 4 个实现 plan，风险最高的上游先做先验证）

| 期 | 交付 | 为什么这个顺序 |
|---|---|---|
| **P1** 飞天地基 + 形象库 | 上传视频建数字人 → 音频驱动出对口型视频（含 client/task/callback/reaper/并发闸/`dub_avatar_clone`+`dub_video_sec` 计费）| 最大未知：先端到端验证飞天对口型效果达标，不达标整功能重估 |
| **P2** MiMo TTS 口播 | 文本→口播音频（preset/design/clone 三模式）+ `dub_tts_char` 计费 + 试听 | 第二个新上游，独立可验 |
| **P3** 文案链路 | 多板块分析（复用 M3 视频直传）+ 洗稿（LLM×3 + KB 注入）| 最简单，复用面大 |
| **P4** BGM + 混音 + 向导编排 | BGM 库 + ffmpeg 叠轨 + `DubProject` 全流程编排 + `DigitalHuman.tsx` 向导页 | 依赖 P1-P3 |

#### 12. 复用/不动清单

- 复用：M3 视频直传（video-multimodal / analyze-reference）、KB 检索注入、`ResourcePrice`/`reserve`/`settleVideo`/`chargeResource`、reaper 范式、S3 storage、`VideoGenerationTask` 结构范本、helpwrite「价格未配置置灰」交互。
- 不动：seedance 相关（本功能不用）、`packages/llm`（MiMo 独立）、飞天 voice/TTS（用 MiMo 代替）。
- 严守：userId 隔离、异步全路径（超时/失败/重试/降级）、金额 reserve-settle 幂等、多租户不共享飞天平台态。

#### 13. 部署漂移

新增：主库迁移（DubProject/SkyhumanTask/Avatar/DubBgmPreset）、api 镜像重建、k8s secret 加 `MIMO_API_KEY`/`SKYHUMAN_API_TOKEN`/`SKYHUMAN_CALLBACK_SECRET`/`SKYHUMAN_BASE_URL`、飞天控制台配回调 URL `https://api.example.com/api/workflow/dub/skyhuman/callback?secret=<...>`、admin 配 5 个 ResourcePrice 真实单价并启用、上传 BGM 预制。

关联 [[yun-claude-video-helpwrite]] [[yun-claude-billing-model]] [[yun-claude-project]]。

### 数字人口播 P1：飞天地基 + 形象库 实现计划

> 源文件：`2026-07-08-dub-p1-skyhuman-foundation.md`


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **子代理纪律**：每个 implementer 的 prompt 开头必须写「跳过所有 superpowers 规划/brainstorming skill，直接按本任务实现」，否则会跑偏去自建子计划。

**Goal:** 用户上传无配音场景视频建数字人形象（飞天异步克隆，userId 隔离形象库），选形象 + 上传一段音频驱动出对口型视频，全程视频点 reserve/settle/refund 计费，回调 + reaper 双保险兜底异步任务。

**Architecture:** 照抄现有 `video-routes.ts` 的「reserve/charge → 建任务行(status=running) → 后台 scheduleTask 提交上游 → 轮询 → settle/refund → 标记 completed/failed」范式。飞天是平台单 token，加 Redis 并发信号量。异步 finalize 逻辑集中为一个幂等函数，后台轮询 / 回调 / reaper 三处都调它。飞天 avatar/credit 是平台级全租户混一起，**绝不透传给用户**——自建 `Avatar` 表按 userId 隔离。

**Tech Stack:** TS / Fastify / Prisma / ioredis / vitest / @fastify/multipart / @aws-sdk/client-s3（S3 转存成品）/ ffprobe（探音频时长，复用 `video-probe.ts`）。

**范围边界（P1 不做，留后续期）：** MiMo TTS（P2）、多板块分析+洗稿（P3）、BGM/ffmpeg 混音/`DubProject` 聚合/向导页（P4）。P1 成片输入=直接上传的音频文件；`DubProject`/`DubBgmPreset` 两表本期不建。

---

#### 文件结构

| 文件 | 职责 |
|---|---|
| `packages/db/prisma/schema.prisma`（改）| 新增 `Avatar`、`SkyhumanTask` 两 model |
| `apps/api/src/workflow/dub-skyhuman-client.ts`（建）| 飞天 HTTP client：config、upload、avatar 建/查/删、video 建/查、credit、状态/错误码归一 |
| `apps/api/src/workflow/dub-concurrency.ts`（建）| Redis 并发信号量 acquire/release（防飞天 1001）|
| `apps/api/src/workflow/dub-constants.ts`（建）| 资源 key、状态枚举、上限常量集中 |
| `apps/api/src/workflow/dub-finalize.ts`（建）| 幂等 finalize：轮询飞天→settle/refund→落 Avatar/结果→标记终态 |
| `apps/api/src/workflow/dub-avatar-service.ts`（建）| 建数字人（收费→建任务→后台上传+提交+finalize）/ 列/删/收藏 |
| `apps/api/src/workflow/dub-video-service.ts`（建）| 音频驱动成片（探时长→收费→建任务→后台上传+提交+finalize）|
| `apps/api/src/workflow/dub-routes.ts`（建）| 用户端路由 + 回调 |
| `apps/api/src/workflow/dub-reaper.ts`（建）| 扫 running 超期 SkyhumanTask → finalize 兜底 |
| `apps/api/src/admin/dub-routes.ts`（建）| `GET /api/admin/dub/skyhuman/credit`（飞天余额，requireAdmin）|
| `apps/api/src/server.ts`（改）| register dubRoutes/adminDubRoutes + 启 dubReaper |
| `apps/admin/src/pages/ResourcePricingPanels.tsx`（改）| 声明 `dub_avatar_clone`/`dub_video_sec` 两 key 供后台配价 |

所有异步计费函数签名统一（跨任务一致，务必对齐）：
- `chargeResource({operationId, userId, resourceKey, units, accountType:"video"}) => {charged}`
- `settleVideoResource({operationId, resourceKey, units}) => {settled}`
- `refundResource(operationId) => {success}`

---

#### Task 1: Prisma — 新增 Avatar / SkyhumanTask 两表

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- 迁移命令见步骤

- [ ] **Step 1: 在 schema.prisma 末尾（VideoGenerationTask 之后附近）新增两 model**

```prisma
model Avatar {
  id              String   @id @default(cuid())
  userId          String
  avatarCode      String
  title           String   @default("未命名")
  coverUrl        String?
  sourceObjectKey String?
  isFavorite      Boolean  @default(false)
  createdAt       DateTime @default(now())
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, createdAt])
}

model SkyhumanTask {
  id             String    @id @default(cuid())
  userId         String
  kind           String                        // avatar_clone | video_create
  avatarId       String?                        // avatar_clone 完成后回填 Avatar.id；video_create 记所用形象
  providerTaskId String?
  status         String    @default("running")  // running | completed | failed
  resourceKey    String
  operationId    String    @unique              // 计费幂等键，finalize/refund 用
  chargedPoints  Int       @default(0)
  audioObjectKey String?                         // video_create：驱动音频对象键
  title          String    @default("未命名")
  resultPayload  Json?                           // {avatarCode} | {videoUrl,duration,cost}
  error          String?
  completedAt    DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  user           User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([status, updatedAt])
  @@index([providerTaskId])
  @@index([userId, createdAt])
}
```

- [ ] **Step 2: 在 `model User` 中补反向关系字段**（找到 User model，在已有关系旁加两行）

```prisma
  avatars       Avatar[]
  skyhumanTasks SkyhumanTask[]
```

- [ ] **Step 3: 生成迁移**

Run: `pnpm --filter @yc/db exec prisma migrate dev --name dub_avatar_skyhuman_task`
Expected: 生成 `packages/db/prisma/migrations/*_dub_avatar_skyhuman_task/migration.sql`，包含 `CREATE TABLE "Avatar"` 与 `CREATE TABLE "SkyhumanTask"`。

- [ ] **Step 4: 生成 client 并验证 tsc**

Run: `pnpm --filter @yc/db exec prisma generate && pnpm --filter @yc/api exec tsc --noEmit`
Expected: 无报错（新类型 `prisma.avatar` / `prisma.skyhumanTask` 可用）。

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations
git commit -m "新增 Avatar 与 SkyhumanTask 数据表"
```

---

#### Task 2: 常量集中 dub-constants.ts

**Files:**
- Create: `apps/api/src/workflow/dub-constants.ts`

- [ ] **Step 1: 直接写常量（无需测试，纯声明）**

```typescript
// 资源计价 key（后台配价用；上线前须在 admin 资源计价页配真实单价并启用）
export const DUB_AVATAR_CLONE_KEY = "dub_avatar_clone"; // PER_CALL 按次·视频点
export const DUB_VIDEO_SEC_KEY = "dub_video_sec";       // PER_UNIT 按秒·视频点

// 本地任务状态
export const DUB_TASK_STATUS = { running: "running", completed: "completed", failed: "failed" } as const;
export type DubTaskStatus = (typeof DUB_TASK_STATUS)[keyof typeof DUB_TASK_STATUS];

export const DUB_TASK_KIND = { avatarClone: "avatar_clone", videoCreate: "video_create" } as const;
export type DubTaskKind = (typeof DUB_TASK_KIND)[keyof typeof DUB_TASK_KIND];

// 上传上限（与既有视频参考一致）
export const DUB_AVATAR_VIDEO_MAX_BYTES = 100 * 1024 * 1024; // 100MB 场景视频
export const DUB_AUDIO_MAX_BYTES = 20 * 1024 * 1024;         // 20MB 驱动音频

// 飞天并发信号量
export const DUB_SKY_INFLIGHT_KEY = "yunclaude:dub:sky:inflight";
export const DUB_SKY_MAX_INFLIGHT = Number(process.env.SKYHUMAN_MAX_INFLIGHT ?? "3");
export const DUB_SKY_SLOT_TTL_SEC = 1800; // 单任务最长占位 30min，防崩溃泄漏

// reaper
export const DUB_REAPER_LOCK_KEY = "yunclaude:dub:reaper:lock";
export const DUB_TASK_STALE_MS = 90_000; // running 超 90s 未终结即由 reaper 补查
```

- [ ] **Step 2: tsc 通过 + Commit**

Run: `pnpm --filter @yc/api exec tsc --noEmit`
```bash
git add apps/api/src/workflow/dub-constants.ts
git commit -m "数字人口播常量集中"
```

---

#### Task 3: 飞天 client dub-skyhuman-client.ts

**Files:**
- Create: `apps/api/src/workflow/dub-skyhuman-client.ts`
- Test: `apps/api/src/workflow/dub-skyhuman-client.test.ts`

参照 `video-service.ts` 的 `loadSeedanceConfig` / fetch 封装 / zod 校验风格。

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect, vi } from "vitest";
import {
  loadSkyhumanConfig, createUploadUrl, createAvatarByVideo, getAvatarTask,
  createVideoByAudio, getVideoTask, getCredit, SkyhumanError, mapSkyStatus,
} from "./dub-skyhuman-client.js";

const cfg = { apiKey: "t", baseUrl: "https://sky.test" };
function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("dub-skyhuman-client", () => {
  it("mapSkyStatus 归一飞天 int 状态", () => {
    expect(mapSkyStatus(1)).toBe("running");
    expect(mapSkyStatus(2)).toBe("running");
    expect(mapSkyStatus(3)).toBe("completed");
    expect(mapSkyStatus(4)).toBe("failed");
  });

  it("createUploadUrl 解出 fileId/uploadUrl/contentType", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ code: 0, data: { upload_url: "https://oss/x", content_type: "video/mp4", file_id: "file_1" } }));
    const r = await createUploadUrl(cfg, fetchFn, "mp4");
    expect(r).toEqual({ uploadUrl: "https://oss/x", contentType: "video/mp4", fileId: "file_1" });
  });

  it("createAvatarByVideo 返回 taskId", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ code: 0, task_id: "task_9" }));
    const r = await createAvatarByVideo(cfg, fetchFn, { title: "a", fileId: "file_1" });
    expect(r.taskId).toBe("task_9");
  });

  it("getVideoTask 完成时带 videoUrl/duration/cost", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ code: 0, status: 3, video_url: "https://v/1.mp4", duration: 45, cost: 450 }));
    const r = await getVideoTask(cfg, fetchFn, "task_9");
    expect(r).toMatchObject({ status: "completed", videoUrl: "https://v/1.mp4", duration: 45, cost: 450 });
  });

  it("业务错误码抛 SkyhumanError 带 code（1002 积分不足）", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ code: 1002, message: "积分不足" }));
    await expect(createVideoByAudio(cfg, fetchFn, { avatar: "av_1", fileId: "file_a", title: "t" }))
      .rejects.toMatchObject({ name: "SkyhumanError", code: 1002 });
  });

  it("401 抛 SkyhumanError code=2003", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    await expect(getCredit(cfg, fetchFn)).rejects.toMatchObject({ name: "SkyhumanError", code: 2003 });
  });

  it("loadSkyhumanConfig 缺 token 抛错", () => {
    expect(() => loadSkyhumanConfig({} as NodeJS.ProcessEnv)).toThrow(/SKYHUMAN_API_TOKEN/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @yc/api exec vitest run src/workflow/dub-skyhuman-client.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 client**

```typescript
import { z } from "zod";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export interface SkyhumanConfig { readonly apiKey: string; readonly baseUrl: string }
export type SkyTaskStatus = "running" | "completed" | "failed";

export class SkyhumanError extends Error {
  readonly name = "SkyhumanError";
  constructor(readonly code: number, message: string) { super(message); }
}

export function loadSkyhumanConfig(env: NodeJS.ProcessEnv = process.env): SkyhumanConfig {
  const apiKey = env.SKYHUMAN_API_TOKEN?.trim();
  if (!apiKey) throw new Error("SKYHUMAN_API_TOKEN required");
  const baseUrl = (env.SKYHUMAN_BASE_URL?.trim() || "https://skyhumanapi.pilihu.vip").replace(/\/+$/u, "");
  return { apiKey, baseUrl };
}

export function mapSkyStatus(status: number): SkyTaskStatus {
  if (status === 3) return "completed";
  if (status === 4) return "failed";
  return "running"; // 1 等待 / 2 处理
}

const envelope = z.object({ code: z.number(), message: z.string().optional() });

async function call(cfg: SkyhumanConfig, fetchFn: FetchLike, path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetchFn(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (res.status === 401) throw new SkyhumanError(2003, "飞天 token 无效");
  if (!res.ok) throw new SkyhumanError(-1, `skyhuman http ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  const env = envelope.parse(body);
  if (env.code !== 0) throw new SkyhumanError(env.code, env.message ?? `skyhuman code ${env.code}`);
  return body;
}

export async function createUploadUrl(cfg: SkyhumanConfig, fetchFn: FetchLike, fileExtension: string): Promise<{ uploadUrl: string; contentType: string; fileId: string }> {
  const body = await call(cfg, fetchFn, "/api/v2/fly/upload/create_upload_url", { method: "POST", body: JSON.stringify({ file_extension: fileExtension }) });
  const d = z.object({ upload_url: z.string(), content_type: z.string(), file_id: z.string() }).parse(body.data);
  return { uploadUrl: d.upload_url, contentType: d.content_type, fileId: d.file_id };
}

export async function putToPresigned(fetchFn: FetchLike, uploadUrl: string, contentType: string, body: Buffer): Promise<void> {
  const res = await fetchFn(uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body });
  if (!res.ok) throw new SkyhumanError(-1, `presigned put http ${res.status}`);
}

export async function createAvatarByVideo(cfg: SkyhumanConfig, fetchFn: FetchLike, args: { title: string; videoUrl?: string; fileId?: string }): Promise<{ taskId: string }> {
  const body = await call(cfg, fetchFn, "/api/v2/fly/avatar/create_by_video", {
    method: "POST",
    body: JSON.stringify({ title: args.title, ...(args.videoUrl ? { video_url: args.videoUrl } : {}), ...(args.fileId ? { file_id: args.fileId } : {}) }),
  });
  return { taskId: z.string().parse(body.task_id) };
}

export async function getAvatarTask(cfg: SkyhumanConfig, fetchFn: FetchLike, taskId: string): Promise<{ status: SkyTaskStatus; avatarCode?: string }> {
  const body = await call(cfg, fetchFn, `/api/v2/fly/avatar/task?task_id=${encodeURIComponent(taskId)}`, { method: "GET" });
  const d = z.object({ status: z.number(), avatar: z.string().optional() }).parse(body);
  return { status: mapSkyStatus(d.status), ...(d.avatar ? { avatarCode: d.avatar } : {}) };
}

export async function deleteAvatar(cfg: SkyhumanConfig, fetchFn: FetchLike, avatarCode: string): Promise<void> {
  await call(cfg, fetchFn, "/api/v2/fly/avatar/delete", { method: "POST", body: JSON.stringify({ avatar_code: avatarCode }) });
}

export async function createVideoByAudio(cfg: SkyhumanConfig, fetchFn: FetchLike, args: { avatar: string; audioUrl?: string; fileId?: string; title: string }): Promise<{ taskId: string }> {
  const body = await call(cfg, fetchFn, "/api/v2/fly/video/create_by_audio", {
    method: "POST",
    body: JSON.stringify({ avatar: args.avatar, title: args.title, ...(args.audioUrl ? { audio_url: args.audioUrl } : {}), ...(args.fileId ? { file_id: args.fileId } : {}) }),
  });
  return { taskId: z.string().parse(body.task_id) };
}

export async function getVideoTask(cfg: SkyhumanConfig, fetchFn: FetchLike, taskId: string): Promise<{ status: SkyTaskStatus; videoUrl?: string; duration?: number; cost?: number }> {
  const body = await call(cfg, fetchFn, `/api/v2/fly/video/task?task_id=${encodeURIComponent(taskId)}`, { method: "GET" });
  const d = z.object({ status: z.number(), video_url: z.string().optional(), duration: z.number().optional(), cost: z.number().optional() }).parse(body);
  return { status: mapSkyStatus(d.status), ...(d.video_url ? { videoUrl: d.video_url } : {}), ...(d.duration != null ? { duration: d.duration } : {}), ...(d.cost != null ? { cost: d.cost } : {}) };
}

export async function getCredit(cfg: SkyhumanConfig, fetchFn: FetchLike): Promise<{ left: number }> {
  const body = await call(cfg, fetchFn, "/api/v2/fly/account/credit", { method: "GET" });
  return { left: z.number().parse(body.left) };
}
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm --filter @yc/api exec vitest run src/workflow/dub-skyhuman-client.test.ts`
Expected: PASS 全部用例。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workflow/dub-skyhuman-client.ts apps/api/src/workflow/dub-skyhuman-client.test.ts
git commit -m "飞天数字人 API client"
```

---

#### Task 4: Redis 并发信号量 dub-concurrency.ts

**Files:**
- Create: `apps/api/src/workflow/dub-concurrency.ts`
- Test: `apps/api/src/workflow/dub-concurrency.test.ts`

- [ ] **Step 1: 写失败测试（用内存假 redis）**

```typescript
import { describe, it, expect } from "vitest";
import { acquireSkySlot, releaseSkySlot } from "./dub-concurrency.js";

// 极简假 redis：仅实现 incr/decr/expire/set，够信号量用
function fakeRedis() {
  const store = new Map<string, number>();
  return {
    store,
    async incr(k: string) { const v = (store.get(k) ?? 0) + 1; store.set(k, v); return v; },
    async decr(k: string) { const v = Math.max(0, (store.get(k) ?? 0) - 1); store.set(k, v); return v; },
    async expire(_k: string, _s: number) { return 1; },
  } as any;
}

describe("dub-concurrency 信号量", () => {
  it("未达上限可获取，超限拒绝并回退计数", async () => {
    const r = fakeRedis();
    expect(await acquireSkySlot(r, 2)).toBe(true);
    expect(await acquireSkySlot(r, 2)).toBe(true);
    expect(await acquireSkySlot(r, 2)).toBe(false); // 第 3 个超限
    expect(r.store.get("yunclaude:dub:sky:inflight")).toBe(2); // 回退后仍为 2
  });

  it("release 递减不为负", async () => {
    const r = fakeRedis();
    await acquireSkySlot(r, 2);
    await releaseSkySlot(r);
    expect(r.store.get("yunclaude:dub:sky:inflight")).toBe(0);
    await releaseSkySlot(r); // 再减不为负
    expect(r.store.get("yunclaude:dub:sky:inflight")).toBe(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @yc/api exec vitest run src/workflow/dub-concurrency.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```typescript
import type { Redis } from "ioredis";
import { DUB_SKY_INFLIGHT_KEY, DUB_SKY_SLOT_TTL_SEC } from "./dub-constants.js";

// INCR 抢位，超限则 DECR 回退。TTL 兜底进程崩溃不泄漏（每次抢位刷新过期）。
export async function acquireSkySlot(redis: Pick<Redis, "incr" | "decr" | "expire">, max: number): Promise<boolean> {
  const n = await redis.incr(DUB_SKY_INFLIGHT_KEY);
  await redis.expire(DUB_SKY_INFLIGHT_KEY, DUB_SKY_SLOT_TTL_SEC);
  if (n > max) { await redis.decr(DUB_SKY_INFLIGHT_KEY); return false; }
  return true;
}

export async function releaseSkySlot(redis: Pick<Redis, "decr">): Promise<void> {
  await redis.decr(DUB_SKY_INFLIGHT_KEY);
}
```

> 注：max<=0 时 incr 返回≥1 恒超限→全部拒绝，符合「关闭飞天」语义；`DUB_SKY_MAX_INFLIGHT` 默认 3。

- [ ] **Step 4: 运行测试通过 + Commit**

Run: `pnpm --filter @yc/api exec vitest run src/workflow/dub-concurrency.test.ts`
```bash
git add apps/api/src/workflow/dub-concurrency.ts apps/api/src/workflow/dub-concurrency.test.ts
git commit -m "飞天并发信号量"
```

---

#### Task 5: 幂等 finalize dub-finalize.ts

集中「轮询飞天→settle/refund→落 Avatar 或成片结果→标记终态」，后台/回调/reaper 三处共用。**必须幂等**：仅当任务仍 running 才处理。

**Files:**
- Create: `apps/api/src/workflow/dub-finalize.ts`
- Test: `apps/api/src/workflow/dub-finalize.test.ts`

- [ ] **Step 1: 写失败测试（mock prisma/billing/client 依赖，注入）**

```typescript
import { describe, it, expect, vi } from "vitest";
import { finalizeSkyhumanTask } from "./dub-finalize.js";

function deps(overrides: any = {}) {
  const task = { id: "t1", userId: "u1", kind: "video_create", status: "running", operationId: "op1", resourceKey: "dub_video_sec", providerTaskId: "p1", avatarId: "av-row", title: "x", ...overrides.task };
  const prisma = {
    skyhumanTask: {
      findUnique: vi.fn().mockResolvedValue(task),
      update: vi.fn().mockResolvedValue({}),
    },
    avatar: { create: vi.fn().mockResolvedValue({ id: "new-av" }) },
  };
  const billing = { settleVideoResource: vi.fn().mockResolvedValue({ settled: 10 }), refundResource: vi.fn().mockResolvedValue({ success: true }) };
  return { prisma: prisma as any, billing: billing as any, ...overrides.env };
}

describe("finalizeSkyhumanTask", () => {
  it("video 完成：转存+按真实 duration settle+标记 completed", async () => {
    const d = deps();
    const sky = { getVideoTask: vi.fn().mockResolvedValue({ status: "completed", videoUrl: "https://v/1.mp4", duration: 30 }) };
    const store = vi.fn().mockResolvedValue({ url: "https://our/1.mp4", objectKey: "k" });
    await finalizeSkyhumanTask({ ...d, taskId: "t1", cfg: {} as any, fetchFn: vi.fn(), sky: sky as any, storeVideo: store });
    expect(d.billing.settleVideoResource).toHaveBeenCalledWith({ operationId: "op1", resourceKey: "dub_video_sec", units: 30 });
    expect(d.prisma.skyhumanTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) }));
  });

  it("失败：refund + 标记 failed", async () => {
    const d = deps();
    const sky = { getVideoTask: vi.fn().mockResolvedValue({ status: "failed" }) };
    await finalizeSkyhumanTask({ ...d, taskId: "t1", cfg: {} as any, fetchFn: vi.fn(), sky: sky as any, storeVideo: vi.fn() });
    expect(d.billing.refundResource).toHaveBeenCalledWith("op1");
    expect(d.prisma.skyhumanTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }));
  });

  it("非 running（已终结）直接返回不重复处理", async () => {
    const d = deps({ task: { status: "completed" } });
    const sky = { getVideoTask: vi.fn() };
    await finalizeSkyhumanTask({ ...d, taskId: "t1", cfg: {} as any, fetchFn: vi.fn(), sky: sky as any, storeVideo: vi.fn() });
    expect(sky.getVideoTask).not.toHaveBeenCalled();
  });

  it("avatar 完成：建 Avatar 行 + 标记 completed", async () => {
    const d = deps({ task: { kind: "avatar_clone", resourceKey: "dub_avatar_clone" } });
    const sky = { getAvatarTask: vi.fn().mockResolvedValue({ status: "completed", avatarCode: "av_abc" }) };
    await finalizeSkyhumanTask({ ...d, taskId: "t1", cfg: {} as any, fetchFn: vi.fn(), sky: sky as any, storeVideo: vi.fn() });
    expect(d.prisma.avatar.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: "u1", avatarCode: "av_abc" }) }));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @yc/api exec vitest run src/workflow/dub-finalize.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现（依赖全注入，便于测试）**

```typescript
import type { PrismaClient } from "@yc/db";
import type { SkyhumanConfig, FetchLike } from "./dub-skyhuman-client.js";
import * as skyClient from "./dub-skyhuman-client.js";
import { DUB_TASK_STATUS, DUB_TASK_KIND } from "./dub-constants.js";

export interface FinalizeBilling {
  settleVideoResource: (a: { operationId: string; resourceKey: string; units: number }) => Promise<{ settled: number }>;
  refundResource: (operationId: string) => Promise<{ success: boolean }>;
}
export interface StoredVideo { url: string; objectKey: string }

export interface FinalizeArgs {
  prisma: PrismaClient;
  billing: FinalizeBilling;
  cfg: SkyhumanConfig;
  fetchFn: FetchLike;
  taskId: string;
  sky?: Pick<typeof skyClient, "getVideoTask" | "getAvatarTask">; // 测试注入
  storeVideo: (args: { url: string; userId: string; taskId: string }) => Promise<StoredVideo>;
}

// 幂等：仅当 status=running 才推进；完成/失败已是终态直接返回。
export async function finalizeSkyhumanTask(args: FinalizeArgs): Promise<void> {
  const sky = args.sky ?? skyClient;
  const task = await args.prisma.skyhumanTask.findUnique({ where: { id: args.taskId } });
  if (!task || task.status !== DUB_TASK_STATUS.running) return;
  if (!task.providerTaskId) return; // 尚未提交上游，交给后台/下一轮

  if (task.kind === DUB_TASK_KIND.avatarClone) {
    const st = await sky.getAvatarTask(args.cfg, args.fetchFn, task.providerTaskId);
    if (st.status === "running") return;
    if (st.status === "failed" || !st.avatarCode) {
      await args.billing.refundResource(task.operationId).catch(() => undefined);
      await markFailed(args.prisma, task.id, "数字人克隆失败");
      return;
    }
    const avatar = await args.prisma.avatar.create({
      data: { userId: task.userId, avatarCode: st.avatarCode, title: task.title, sourceObjectKey: task.audioObjectKey ?? null },
    });
    await args.prisma.skyhumanTask.update({
      where: { id: task.id },
      data: { status: DUB_TASK_STATUS.completed, avatarId: avatar.id, resultPayload: { avatarCode: st.avatarCode }, completedAt: new Date(), error: null },
    });
    return;
  }

  // video_create
  const st = await sky.getVideoTask(args.cfg, args.fetchFn, task.providerTaskId);
  if (st.status === "running") return;
  if (st.status === "failed" || !st.videoUrl) {
    await args.billing.refundResource(task.operationId).catch(() => undefined);
    await markFailed(args.prisma, task.id, "视频生成失败");
    return;
  }
  const stored = await args.storeVideo({ url: st.videoUrl, userId: task.userId, taskId: task.id });
  if (st.duration && st.duration > 0) {
    await args.billing.settleVideoResource({ operationId: task.operationId, resourceKey: task.resourceKey, units: st.duration }).catch(() => undefined);
  }
  await args.prisma.skyhumanTask.update({
    where: { id: task.id },
    data: { status: DUB_TASK_STATUS.completed, resultPayload: { videoUrl: stored.url, objectKey: stored.objectKey, duration: st.duration ?? 0, cost: st.cost ?? 0 }, completedAt: new Date(), error: null },
  });
}

async function markFailed(prisma: PrismaClient, id: string, error: string): Promise<void> {
  await prisma.skyhumanTask.update({ where: { id }, data: { status: DUB_TASK_STATUS.failed, error } }).catch(() => undefined);
}
```

- [ ] **Step 4: 运行测试通过 + Commit**

Run: `pnpm --filter @yc/api exec vitest run src/workflow/dub-finalize.test.ts`
```bash
git add apps/api/src/workflow/dub-finalize.ts apps/api/src/workflow/dub-finalize.test.ts
git commit -m "飞天任务幂等 finalize"
```

---

#### Task 6: 建数字人服务 dub-avatar-service.ts

**Files:**
- Create: `apps/api/src/workflow/dub-avatar-service.ts`
- Test: `apps/api/src/workflow/dub-avatar-service.test.ts`

职责：`startAvatarClone`（收费→建 SkyhumanTask→后台 acquire slot→飞天 upload→create_by_video→回填 providerTaskId→轮询 finalize→release slot）、`listAvatars`（userId 隔离）、`removeAvatar`（飞天 delete + 删行）、`setAvatarFavorite`。

- [ ] **Step 1: 写失败测试（聚焦纯逻辑：收费失败不建任务；列举 userId 隔离；删除调飞天）**

```typescript
import { describe, it, expect, vi } from "vitest";
import { listAvatars, removeAvatar } from "./dub-avatar-service.js";

describe("dub-avatar-service", () => {
  it("listAvatars 只返回本人形象", async () => {
    const prisma = { avatar: { findMany: vi.fn().mockResolvedValue([{ id: "a1", userId: "u1" }]) } } as any;
    await listAvatars(prisma, "u1");
    expect(prisma.avatar.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "u1" } }));
  });

  it("removeAvatar 越权（非本人）不删、返回 false", async () => {
    const prisma = { avatar: { findFirst: vi.fn().mockResolvedValue(null), delete: vi.fn() } } as any;
    const sky = { deleteAvatar: vi.fn() };
    const ok = await removeAvatar({ prisma, cfg: {} as any, fetchFn: vi.fn(), sky: sky as any, userId: "u1", avatarId: "a1" });
    expect(ok).toBe(false);
    expect(prisma.avatar.delete).not.toHaveBeenCalled();
    expect(sky.deleteAvatar).not.toHaveBeenCalled();
  });

  it("removeAvatar 本人：先飞天删再删行", async () => {
    const prisma = { avatar: { findFirst: vi.fn().mockResolvedValue({ id: "a1", userId: "u1", avatarCode: "av_x" }), delete: vi.fn().mockResolvedValue({}) } } as any;
    const sky = { deleteAvatar: vi.fn().mockResolvedValue(undefined) };
    const ok = await removeAvatar({ prisma, cfg: {} as any, fetchFn: vi.fn(), sky: sky as any, userId: "u1", avatarId: "a1" });
    expect(ok).toBe(true);
    expect(sky.deleteAvatar).toHaveBeenCalledWith({}, expect.any(Function), "av_x");
    expect(prisma.avatar.delete).toHaveBeenCalledWith({ where: { id: "a1" } });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @yc/api exec vitest run src/workflow/dub-avatar-service.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```typescript
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@yc/db";
import type { Redis } from "ioredis";
import type { SkyhumanConfig, FetchLike } from "./dub-skyhuman-client.js";
import * as skyClient from "./dub-skyhuman-client.js";
import { finalizeSkyhumanTask, type FinalizeBilling, type StoredVideo } from "./dub-finalize.js";
import { acquireSkySlot, releaseSkySlot } from "./dub-concurrency.js";
import { DUB_AVATAR_CLONE_KEY, DUB_TASK_KIND, DUB_TASK_STATUS, DUB_SKY_MAX_INFLIGHT } from "./dub-constants.js";

export interface AvatarBilling extends FinalizeBilling {
  chargeResource: (a: { operationId: string; userId: string; resourceKey: string; units: number; accountType: "video" }) => Promise<{ charged: number }>;
}

export async function listAvatars(prisma: PrismaClient, userId: string) {
  return prisma.avatar.findMany({ where: { userId }, orderBy: [{ isFavorite: "desc" }, { createdAt: "desc" }] });
}

export async function setAvatarFavorite(prisma: PrismaClient, userId: string, avatarId: string, favorite: boolean): Promise<boolean> {
  const r = await prisma.avatar.updateMany({ where: { id: avatarId, userId }, data: { isFavorite: favorite } });
  return r.count > 0;
}

export async function removeAvatar(args: { prisma: PrismaClient; cfg: SkyhumanConfig; fetchFn: FetchLike; sky?: Pick<typeof skyClient, "deleteAvatar">; userId: string; avatarId: string }): Promise<boolean> {
  const sky = args.sky ?? skyClient;
  const row = await args.prisma.avatar.findFirst({ where: { id: args.avatarId, userId: args.userId } });
  if (!row) return false;
  await sky.deleteAvatar(args.cfg, args.fetchFn, row.avatarCode).catch(() => undefined); // 飞天删失败不阻断本地清理
  await args.prisma.avatar.delete({ where: { id: row.id } });
  return true;
}

export interface StartAvatarCloneArgs {
  prisma: PrismaClient; redis: Redis; billing: AvatarBilling; cfg: SkyhumanConfig; fetchFn: FetchLike;
  userId: string; title: string; buffer: Buffer; mime: string;
  storeVideo: (a: { url: string; userId: string; taskId: string }) => Promise<StoredVideo>;
  scheduleTask: (fn: () => Promise<void>) => void;
}

// 收费(按次·视频点)→建任务→后台执行。返回任务行供路由 202 响应。
export async function startAvatarClone(args: StartAvatarCloneArgs) {
  const operationId = `dub-avatar:${randomUUID()}`;
  const charged = await args.billing.chargeResource({ operationId, userId: args.userId, resourceKey: DUB_AVATAR_CLONE_KEY, units: 1, accountType: "video" });
  let task;
  try {
    task = await args.prisma.skyhumanTask.create({
      data: { userId: args.userId, kind: DUB_TASK_KIND.avatarClone, status: DUB_TASK_STATUS.running, resourceKey: DUB_AVATAR_CLONE_KEY, operationId, chargedPoints: charged.charged, title: args.title },
    });
  } catch (e) {
    await args.billing.refundResource(operationId).catch(() => undefined);
    throw e;
  }
  args.scheduleTask(() => runAvatarClone({ ...args, task }));
  return task;
}

async function runAvatarClone(args: StartAvatarCloneArgs & { task: { id: string } }): Promise<void> {
  const ext = args.mime.includes("quicktime") ? "mov" : "mp4";
  if (!(await acquireSkySlot(args.redis, DUB_SKY_MAX_INFLIGHT))) {
    // 触顶：留 running，交给 reaper 下轮重试提交（此处直接返回不占位）
    return;
  }
  try {
    const up = await skyClient.createUploadUrl(args.cfg, args.fetchFn, ext);
    await skyClient.putToPresigned(args.fetchFn, up.uploadUrl, up.contentType, args.buffer);
    const submitted = await skyClient.createAvatarByVideo(args.cfg, args.fetchFn, { title: args.title, fileId: up.fileId });
    await args.prisma.skyhumanTask.update({ where: { id: args.task.id }, data: { providerTaskId: submitted.taskId } });
    await pollFinalize({ prisma: args.prisma, billing: args.billing, cfg: args.cfg, fetchFn: args.fetchFn, taskId: args.task.id, storeVideo: args.storeVideo });
  } catch (e) {
    await args.billing.refundResource(`dub-avatar:${args.task.id}`).catch(() => undefined); // 兜底（operationId 已存 task，reaper 也会退）
    await args.prisma.skyhumanTask.update({ where: { id: args.task.id }, data: { status: DUB_TASK_STATUS.failed, error: (e as Error).message } }).catch(() => undefined);
  } finally {
    await releaseSkySlot(args.redis);
  }
}

// 有界轮询，每次调幂等 finalize；到终态即停。留 reaper 兜底超时。
export async function pollFinalize(args: { prisma: PrismaClient; billing: FinalizeBilling; cfg: SkyhumanConfig; fetchFn: FetchLike; taskId: string; storeVideo: (a: { url: string; userId: string; taskId: string }) => Promise<StoredVideo>; maxAttempts?: number; intervalMs?: number }): Promise<void> {
  const maxAttempts = args.maxAttempts ?? 60;
  const intervalMs = args.intervalMs ?? 10_000;
  for (let i = 0; i < maxAttempts; i++) {
    await finalizeSkyhumanTask(args);
    const t = await args.prisma.skyhumanTask.findUnique({ where: { id: args.taskId }, select: { status: true } });
    if (!t || t.status !== DUB_TASK_STATUS.running) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
```

> 注：`operationId` 退款以 `task.operationId` 为准（reaper/finalize 用）；上面 catch 里的 `dub-avatar:${task.id}` 兜底为防御性，真正退款在 finalize 失败分支按 `task.operationId` 执行。实现时统一：catch 分支改为读 `task.operationId` 退款（避免键不一致）——见 Step 3 修正：把 catch 里退款键改成任务真实 operationId。

- [ ] **Step 3b: 修正退款键一致性**

将 `runAvatarClone` catch 分支改为先查任务 operationId 再退款：

```typescript
  } catch (e) {
    const row = await args.prisma.skyhumanTask.findUnique({ where: { id: args.task.id }, select: { operationId: true } });
    if (row) await args.billing.refundResource(row.operationId).catch(() => undefined);
    await args.prisma.skyhumanTask.update({ where: { id: args.task.id }, data: { status: DUB_TASK_STATUS.failed, error: (e as Error).message } }).catch(() => undefined);
  }
```

- [ ] **Step 4: 运行测试通过 + Commit**

Run: `pnpm --filter @yc/api exec vitest run src/workflow/dub-avatar-service.test.ts`
```bash
git add apps/api/src/workflow/dub-avatar-service.ts apps/api/src/workflow/dub-avatar-service.test.ts
git commit -m "建数字人服务（克隆/形象库/删除）"
```

---

#### Task 7: 音频驱动成片服务 dub-video-service.ts

**Files:**
- Create: `apps/api/src/workflow/dub-video-service.ts`
- Test: `apps/api/src/workflow/dub-video-service.test.ts`

职责：`startVideoCreate`（探音频时长→按秒收费·视频点→建 SkyhumanTask→后台 acquire slot→飞天 upload audio→create_by_audio→回填 providerTaskId→pollFinalize→release）。成品转存我方 S3 = `storeGeneratedVideo`（复用 video-service 已有函数或包一层）。

- [ ] **Step 1: 写失败测试（收费按音频秒数、越权校验 avatar 归属）**

```typescript
import { describe, it, expect, vi } from "vitest";
import { startVideoCreate } from "./dub-video-service.js";

function base() {
  const prisma = {
    avatar: { findFirst: vi.fn().mockResolvedValue({ id: "av-row", userId: "u1", avatarCode: "av_x" }) },
    skyhumanTask: { create: vi.fn().mockResolvedValue({ id: "t1" }), findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
  } as any;
  const billing = { chargeResource: vi.fn().mockResolvedValue({ charged: 100 }), settleVideoResource: vi.fn(), refundResource: vi.fn() } as any;
  return { prisma, billing };
}

describe("dub-video-service", () => {
  it("avatar 非本人 → 抛 403 语义错误，不收费", async () => {
    const { prisma, billing } = base();
    prisma.avatar.findFirst.mockResolvedValue(null);
    await expect(startVideoCreate({
      prisma, billing, redis: {} as any, cfg: {} as any, fetchFn: vi.fn(),
      userId: "u1", avatarId: "av-row", title: "t", audioBuffer: Buffer.from("x"), audioMime: "audio/mpeg",
      probeDurationSec: vi.fn().mockResolvedValue(30), storeVideo: vi.fn(), scheduleTask: vi.fn(),
    })).rejects.toThrow(/形象不存在/);
    expect(billing.chargeResource).not.toHaveBeenCalled();
  });

  it("按音频秒数收费·视频点，建任务并排后台", async () => {
    const { prisma, billing } = base();
    const scheduleTask = vi.fn();
    const task = await startVideoCreate({
      prisma, billing, redis: {} as any, cfg: {} as any, fetchFn: vi.fn(),
      userId: "u1", avatarId: "av-row", title: "t", audioBuffer: Buffer.from("x"), audioMime: "audio/mpeg",
      probeDurationSec: vi.fn().mockResolvedValue(30), storeVideo: vi.fn(), scheduleTask,
    });
    expect(billing.chargeResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "dub_video_sec", units: 30, accountType: "video" }));
    expect(task.id).toBe("t1");
    expect(scheduleTask).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @yc/api exec vitest run src/workflow/dub-video-service.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```typescript
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@yc/db";
import type { Redis } from "ioredis";
import type { SkyhumanConfig, FetchLike } from "./dub-skyhuman-client.js";
import * as skyClient from "./dub-skyhuman-client.js";
import { pollFinalize } from "./dub-avatar-service.js";
import type { AvatarBilling } from "./dub-avatar-service.js";
import type { StoredVideo } from "./dub-finalize.js";
import { acquireSkySlot, releaseSkySlot } from "./dub-concurrency.js";
import { DUB_VIDEO_SEC_KEY, DUB_TASK_KIND, DUB_TASK_STATUS, DUB_SKY_MAX_INFLIGHT } from "./dub-constants.js";

export interface StartVideoCreateArgs {
  prisma: PrismaClient; redis: Redis; billing: AvatarBilling; cfg: SkyhumanConfig; fetchFn: FetchLike;
  userId: string; avatarId: string; title: string; audioBuffer: Buffer; audioMime: string;
  probeDurationSec: (buf: Buffer) => Promise<number>;
  storeVideo: (a: { url: string; userId: string; taskId: string }) => Promise<StoredVideo>;
  scheduleTask: (fn: () => Promise<void>) => void;
}

export async function startVideoCreate(args: StartVideoCreateArgs) {
  const avatar = await args.prisma.avatar.findFirst({ where: { id: args.avatarId, userId: args.userId } });
  if (!avatar) throw new Error("形象不存在或无权使用");
  const seconds = Math.max(1, Math.ceil(await args.probeDurationSec(args.audioBuffer)));
  const operationId = `dub-video:${randomUUID()}`;
  const charged = await args.billing.chargeResource({ operationId, userId: args.userId, resourceKey: DUB_VIDEO_SEC_KEY, units: seconds, accountType: "video" });
  let task;
  try {
    task = await args.prisma.skyhumanTask.create({
      data: { userId: args.userId, kind: DUB_TASK_KIND.videoCreate, avatarId: avatar.id, status: DUB_TASK_STATUS.running, resourceKey: DUB_VIDEO_SEC_KEY, operationId, chargedPoints: charged.charged, title: args.title },
    });
  } catch (e) {
    await args.billing.refundResource(operationId).catch(() => undefined);
    throw e;
  }
  args.scheduleTask(() => runVideoCreate({ ...args, task, avatarCode: avatar.avatarCode }));
  return task;
}

async function runVideoCreate(args: StartVideoCreateArgs & { task: { id: string }; avatarCode: string }): Promise<void> {
  if (!(await acquireSkySlot(args.redis, DUB_SKY_MAX_INFLIGHT))) return; // 触顶留 running，reaper 补
  try {
    const ext = args.audioMime.includes("wav") ? "wav" : "mp3";
    const up = await skyClient.createUploadUrl(args.cfg, args.fetchFn, ext);
    await skyClient.putToPresigned(args.fetchFn, up.uploadUrl, up.contentType, args.audioBuffer);
    const submitted = await skyClient.createVideoByAudio(args.cfg, args.fetchFn, { avatar: args.avatarCode, fileId: up.fileId, title: args.task.id });
    await args.prisma.skyhumanTask.update({ where: { id: args.task.id }, data: { providerTaskId: submitted.taskId } });
    await pollFinalize({ prisma: args.prisma, billing: args.billing, cfg: args.cfg, fetchFn: args.fetchFn, taskId: args.task.id, storeVideo: args.storeVideo });
  } catch (e) {
    const row = await args.prisma.skyhumanTask.findUnique({ where: { id: args.task.id }, select: { operationId: true } });
    if (row) await args.billing.refundResource(row.operationId).catch(() => undefined);
    await args.prisma.skyhumanTask.update({ where: { id: args.task.id }, data: { status: DUB_TASK_STATUS.failed, error: (e as Error).message } }).catch(() => undefined);
  } finally {
    await releaseSkySlot(args.redis);
  }
}
```

> `probeDurationSec` 注入 = 复用 `video-probe.ts` 的 `probeVideoDurationSec`（ffprobe 读 format duration，对音频同样有效）。`storeVideo` 注入 = 复用 `video-service.ts` 的成品转存逻辑（fetch 临时 video_url → putObject 到 `dub/videos/<userId>/<taskId>.mp4`）。

- [ ] **Step 4: 运行测试通过 + Commit**

Run: `pnpm --filter @yc/api exec vitest run src/workflow/dub-video-service.test.ts`
```bash
git add apps/api/src/workflow/dub-video-service.ts apps/api/src/workflow/dub-video-service.test.ts
git commit -m "音频驱动数字人成片服务"
```

---

#### Task 8: reaper dub-reaper.ts

**Files:**
- Create: `apps/api/src/workflow/dub-reaper.ts`
- Test: `apps/api/src/workflow/dub-reaper.test.ts`

照抄 `connector/reaper.ts` 的 Redis SET NX 锁 + setInterval + unref。扫 `status=running` 且 `updatedAt < now-STALE` 的 SkyhumanTask，逐个 `finalizeSkyhumanTask`。

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect, vi } from "vitest";
import { reapStaleSkyhumanTasks } from "./dub-reaper.js";

describe("dub-reaper", () => {
  it("对每个超期 running 任务调用 finalize", async () => {
    const prisma = { skyhumanTask: { findMany: vi.fn().mockResolvedValue([{ id: "t1" }, { id: "t2" }]) } } as any;
    const finalize = vi.fn().mockResolvedValue(undefined);
    const n = await reapStaleSkyhumanTasks({ prisma, cfg: {} as any, fetchFn: vi.fn(), billing: {} as any, storeVideo: vi.fn(), staleMs: 90_000, finalize });
    expect(n).toBe(2);
    expect(finalize).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @yc/api exec vitest run src/workflow/dub-reaper.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```typescript
import type { PrismaClient } from "@yc/db";
import type { Redis } from "ioredis";
import type { SkyhumanConfig, FetchLike } from "./dub-skyhuman-client.js";
import { finalizeSkyhumanTask, type FinalizeBilling, type StoredVideo } from "./dub-finalize.js";
import { DUB_TASK_STATUS, DUB_REAPER_LOCK_KEY, DUB_TASK_STALE_MS } from "./dub-constants.js";

export interface ReaperArgs {
  prisma: PrismaClient; cfg: SkyhumanConfig; fetchFn: FetchLike; billing: FinalizeBilling;
  storeVideo: (a: { url: string; userId: string; taskId: string }) => Promise<StoredVideo>;
  staleMs: number;
  finalize?: (a: { prisma: PrismaClient; billing: FinalizeBilling; cfg: SkyhumanConfig; fetchFn: FetchLike; taskId: string; storeVideo: ReaperArgs["storeVideo"] }) => Promise<void>;
}

export async function reapStaleSkyhumanTasks(args: ReaperArgs): Promise<number> {
  const finalize = args.finalize ?? finalizeSkyhumanTask;
  const threshold = new Date(Date.now() - args.staleMs);
  const stale = await args.prisma.skyhumanTask.findMany({
    where: { status: DUB_TASK_STATUS.running, providerTaskId: { not: null }, updatedAt: { lt: threshold } },
    select: { id: true },
  });
  for (const t of stale) {
    await finalize({ prisma: args.prisma, billing: args.billing, cfg: args.cfg, fetchFn: args.fetchFn, taskId: t.id, storeVideo: args.storeVideo }).catch(() => undefined);
  }
  return stale.length;
}

export function startDubReaper(args: Omit<ReaperArgs, "staleMs"> & { redis: Redis }): NodeJS.Timeout {
  const tick = async () => {
    const got = await args.redis.set(DUB_REAPER_LOCK_KEY, "1", "EX", 55, "NX");
    if (got !== "OK") return;
    try { await reapStaleSkyhumanTasks({ ...args, staleMs: DUB_TASK_STALE_MS }); } catch { /* 下轮重试 */ }
  };
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  return timer;
}
```

- [ ] **Step 4: 运行测试通过 + Commit**

Run: `pnpm --filter @yc/api exec vitest run src/workflow/dub-reaper.test.ts`
```bash
git add apps/api/src/workflow/dub-reaper.ts apps/api/src/workflow/dub-reaper.test.ts
git commit -m "飞天任务 reaper 兜底"
```

---

#### Task 9: 用户端路由 + 回调 dub-routes.ts

**Files:**
- Create: `apps/api/src/workflow/dub-routes.ts`
- Test: `apps/api/src/workflow/dub-routes.test.ts`

路由（全部 `req.userId` 鉴权，回调例外走 secret）：
- `POST /api/workflow/dub/avatars`（multipart 视频）→ startAvatarClone → 202 {taskId}
- `GET /api/workflow/dub/avatars` → 本人形象库
- `PATCH /api/workflow/dub/avatars/:id`（{favorite}）
- `DELETE /api/workflow/dub/avatars/:id`
- `POST /api/workflow/dub/video/generate`（multipart audio + field avatarId + title）→ startVideoCreate → 202 {taskId}
- `GET /api/workflow/dub/tasks/:id` → 本人任务状态（含 resultPayload）
- `POST /api/workflow/dub/skyhuman/callback?secret=` → 校验 secret → 按 providerTaskId 找任务 → 触发 pollFinalize（不信 body）

- [ ] **Step 1: 写失败测试（用 app.inject，mock 服务层 + billing + s3）**

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getPrisma } from "@yc/db";
import { buildServer } from "../server.js";
import { signToken } from "../auth/token.js";
import { generateUniqueUid } from "../auth/uid.js";

// mock 计费/存储，参照 kb/routes.test.ts
vi.mock("@yc/billing", () => ({
  createBillingClient: vi.fn(() => ({
    chargeResource: vi.fn().mockResolvedValue({ charged: 1 }),
    settleVideoResource: vi.fn().mockResolvedValue({ settled: 1 }),
    refundResource: vi.fn().mockResolvedValue({ success: true }),
  })),
  InsufficientBalanceError: class extends Error {},
}));
vi.mock("../storage/s3.js", async () => {
  const actual = await vi.importActual<typeof import("../storage/s3.js")>("../storage/s3.js");
  return { ...actual, makeS3: vi.fn(() => ({ client: { send: vi.fn().mockResolvedValue({}) }, bucket: "t" })), putObject: vi.fn(), getObject: vi.fn() };
});

const prisma = getPrisma();
let app: Awaited<ReturnType<typeof buildServer>>;
let auth = ""; let userId = "";

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "x".repeat(32);
  process.env.ADMIN_SESSION_SECRET ??= "y".repeat(32);
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.SKYHUMAN_API_TOKEN ??= "sk-test";
  process.env.SKYHUMAN_CALLBACK_SECRET ??= "cbsecret";
  process.env.S3_ENDPOINT ??= "http://localhost:9000"; process.env.S3_BUCKET ??= "t";
  process.env.S3_ACCESS_KEY ??= "a"; process.env.S3_SECRET_KEY ??= "b"; process.env.BILLING_BASE_URL ??= "http://localhost:1";
  const uid = await generateUniqueUid(async (u) => Boolean(await prisma.user.findUnique({ where: { uid: u } })));
  const u = await prisma.user.create({ data: { uid, username: `dub_${Date.now()}`, passwordHash: "x" } });
  userId = u.id; auth = `Bearer ${signToken(userId, process.env.SESSION_SECRET!)}`;
  app = await buildServer(); await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.skyhumanTask.deleteMany({ where: { userId } });
  await prisma.avatar.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("dub 路由", () => {
  it("GET /avatars 未登录 401", async () => {
    const r = await app.inject({ method: "GET", url: "/api/workflow/dub/avatars" });
    expect(r.statusCode).toBe(401);
  });
  it("GET /avatars 已登录返回本人形象", async () => {
    await prisma.avatar.create({ data: { userId, avatarCode: "av_1", title: "我" } });
    const r = await app.inject({ method: "GET", url: "/api/workflow/dub/avatars", headers: { authorization: auth } });
    expect(r.statusCode).toBe(200);
    expect((r.json() as any).data.some((a: any) => a.avatarCode === "av_1")).toBe(true);
  });
  it("GET /tasks/:id 越权他人任务 404", async () => {
    const r = await app.inject({ method: "GET", url: "/api/workflow/dub/tasks/nonexist", headers: { authorization: auth } });
    expect(r.statusCode).toBe(404);
  });
  it("回调 secret 错误 403", async () => {
    const r = await app.inject({ method: "POST", url: "/api/workflow/dub/skyhuman/callback?secret=wrong", payload: { task_id: "p1" } });
    expect(r.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @yc/api exec vitest run src/workflow/dub-routes.test.ts`
Expected: FAIL（路由未注册）。

- [ ] **Step 3: 实现路由**

```typescript
import type { FastifyInstance } from "fastify";
import { getPrisma } from "@yc/db";
import { getRedis } from "../redis.js"; // 若无此单例，见 Step 3b 用现有 redis 获取方式
import { createBillingClient } from "@yc/billing";
import { loadSkyhumanConfig } from "./dub-skyhuman-client.js";
import { listAvatars, setAvatarFavorite, removeAvatar, startAvatarClone, pollFinalize } from "./dub-avatar-service.js";
import { startVideoCreate } from "./dub-video-service.js";
import { probeVideoDurationSec } from "./video-probe.js";
import { storeGeneratedVideo } from "./video-service.js";
import { DUB_AVATAR_VIDEO_MAX_BYTES, DUB_AUDIO_MAX_BYTES } from "./dub-constants.js";

export async function dubRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const redis = getRedis();
  const billing = createBillingClient();
  const cfg = loadSkyhumanConfig();
  const fetchFn: typeof fetch = (...a) => fetch(...a);
  const scheduleTask = (fn: () => Promise<void>) => { void fn().catch((e) => app.log.error(e)); };
  const storeVideo = async (a: { url: string; userId: string; taskId: string }) => {
    const s = await storeGeneratedVideo({ url: a.url, userId: a.userId, requestId: `dub-${a.taskId}`, requestIndex: 0, format: "mp4", fetchFn });
    return { url: s.originalUrl, objectKey: s.objectKey };
  };

  function uid(req: unknown): string | null { return (req as { userId?: string }).userId || null; }

  app.get("/api/workflow/dub/avatars", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    return { success: true, data: await listAvatars(prisma, userId) };
  });

  app.post("/api/workflow/dub/avatars", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const file = await req.file(); if (!file) return reply.code(400).send({ error: "请选择场景视频" });
    if (!file.mimetype.startsWith("video/")) return reply.code(400).send({ error: "仅支持视频文件" });
    const buffer = Buffer.from(await file.toBuffer());
    if (buffer.byteLength > DUB_AVATAR_VIDEO_MAX_BYTES) return reply.code(413).send({ error: "场景视频不能超过 100MB" });
    const title = String((file.fields?.title as any)?.value ?? "未命名").slice(0, 40);
    try {
      const task = await startAvatarClone({ prisma, redis, billing, cfg, fetchFn, userId, title, buffer, mime: file.mimetype, storeVideo, scheduleTask });
      return reply.code(202).send({ success: true, data: { taskId: task.id } });
    } catch (e) {
      return reply.code(billingErrCode(e)).send({ error: billingErrMsg(e) });
    }
  });

  app.patch("/api/workflow/dub/avatars/:id", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const favorite = Boolean((req.body as { favorite?: boolean } | undefined)?.favorite);
    const ok = await setAvatarFavorite(prisma, userId, (req.params as { id: string }).id, favorite);
    return ok ? { success: true } : reply.code(404).send({ error: "形象不存在" });
  });

  app.delete("/api/workflow/dub/avatars/:id", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const ok = await removeAvatar({ prisma, cfg, fetchFn, userId, avatarId: (req.params as { id: string }).id });
    return ok ? { success: true } : reply.code(404).send({ error: "形象不存在" });
  });

  app.post("/api/workflow/dub/video/generate", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const file = await req.file(); if (!file) return reply.code(400).send({ error: "请选择驱动音频" });
    if (!file.mimetype.startsWith("audio/")) return reply.code(400).send({ error: "仅支持音频文件" });
    const buffer = Buffer.from(await file.toBuffer());
    if (buffer.byteLength > DUB_AUDIO_MAX_BYTES) return reply.code(413).send({ error: "音频不能超过 20MB" });
    const avatarId = String((file.fields?.avatarId as any)?.value ?? "");
    const title = String((file.fields?.title as any)?.value ?? "未命名").slice(0, 40);
    if (!avatarId) return reply.code(400).send({ error: "请选择数字人形象" });
    try {
      const task = await startVideoCreate({ prisma, redis, billing, cfg, fetchFn, userId, avatarId, title, audioBuffer: buffer, audioMime: file.mimetype, probeDurationSec: probeVideoDurationSec, storeVideo, scheduleTask });
      return reply.code(202).send({ success: true, data: { taskId: task.id } });
    } catch (e) {
      if ((e as Error).message.includes("形象不存在")) return reply.code(403).send({ error: (e as Error).message });
      return reply.code(billingErrCode(e)).send({ error: billingErrMsg(e) });
    }
  });

  app.get("/api/workflow/dub/tasks/:id", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const task = await prisma.skyhumanTask.findFirst({ where: { id: (req.params as { id: string }).id, userId } });
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    return { success: true, data: { id: task.id, kind: task.kind, status: task.status, resultPayload: task.resultPayload, error: task.error } };
  });

  app.post("/api/workflow/dub/skyhuman/callback", async (req, reply) => {
    const secret = (req.query as { secret?: string }).secret;
    if (!secret || secret !== process.env.SKYHUMAN_CALLBACK_SECRET) return reply.code(403).send({ error: "forbidden" });
    const providerTaskId = (req.body as { task_id?: string } | undefined)?.task_id;
    if (!providerTaskId) return { received: true };
    const task = await prisma.skyhumanTask.findFirst({ where: { providerTaskId }, select: { id: true } });
    if (task) scheduleTask(() => pollFinalize({ prisma, billing, cfg, fetchFn, taskId: task.id, storeVideo, maxAttempts: 1, intervalMs: 0 }));
    return { received: true };
  });
}

function billingErrCode(e: unknown): number { return (e as Error)?.name === "InsufficientBalanceError" ? 402 : 502; }
function billingErrMsg(e: unknown): string { return (e as Error)?.name === "InsufficientBalanceError" ? "视频点不足，请充值" : "计费未配置或服务不可用"; }
```

- [ ] **Step 3b: 确认 redis 单例获取方式**

若无 `../redis.js` 的 `getRedis()`，查现有 reaper 启动处（server.ts 里 `startReaper(prisma, redis)` 的 redis 从哪来），照那个来源获取，替换本文件 `getRedis()`。Run: `grep -rn "new Redis\|ioredis\|getRedis\|startReaper" apps/api/src/server.ts`

- [ ] **Step 4: 注册路由到 server.ts**

在 `apps/api/src/server.ts` register 段（video 路由旁）加：

```typescript
import { dubRoutes } from "./workflow/dub-routes.js";
// ...
await app.register(dubRoutes);
```

并确保 multipart 已全局注册（video 素材上传能用即已注册；否则照 video 路由的 multipart 注册方式）。

- [ ] **Step 5: 运行测试通过**

Run: `pnpm --filter @yc/api exec vitest run src/workflow/dub-routes.test.ts`
Expected: PASS（4 用例）。

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/workflow/dub-routes.ts apps/api/src/server.ts
git commit -m "数字人口播用户端路由与回调"
```

---

#### Task 10: 启动 reaper + admin 飞天余额路由

**Files:**
- Modify: `apps/api/src/server.ts`
- Create: `apps/api/src/admin/dub-routes.ts`
- Test: `apps/api/src/admin/dub-routes.test.ts`

- [ ] **Step 1: server.ts 启动 dubReaper**

在现有 `startReaper(...)` 调用旁：

```typescript
import { startDubReaper } from "./workflow/dub-reaper.js";
import { loadSkyhumanConfig } from "./workflow/dub-skyhuman-client.js";
import { storeGeneratedVideo } from "./workflow/video-service.js";
// ... 在拿到 prisma/redis/billing 之后：
if (process.env.SKYHUMAN_API_TOKEN) {
  const fetchFn: typeof fetch = (...a) => fetch(...a);
  startDubReaper({
    prisma, redis, billing, cfg: loadSkyhumanConfig(), fetchFn,
    storeVideo: async (a) => { const s = await storeGeneratedVideo({ url: a.url, userId: a.userId, requestId: `dub-${a.taskId}`, requestIndex: 0, format: "mp4", fetchFn }); return { url: s.originalUrl, objectKey: s.objectKey }; },
  });
}
```

> `billing` 在 server.ts 里如何构造，照现有传给 videoWorkflowRoutes 的同一个实例来。

- [ ] **Step 2: admin 余额路由（写失败测试）**

```typescript
import { describe, it, expect } from "vitest";
// 参照 admin/resource-routes.test.ts 的鉴权测试骨架：无 VIEW_ANALYTICS 403
describe("admin dub credit", () => {
  it("无权限 403", async () => {
    // ...buildServer + 无权限 admin token（复用现有 admin 测试 fixture）
    // GET /api/admin/dub/skyhuman/credit → 403
    expect(true).toBe(true); // 占位：按 resource-routes.test.ts 实测断言替换
  });
});
```

> 注：此测试骨架需按 `apps/api/src/admin/resource-routes.test.ts` 现有 admin fixture（建带/不带权限的 admin、签 admin token）补全，断言 403 与 200/502。实现前先读该测试文件照抄 fixture。

- [ ] **Step 3: 实现 admin 路由**

```typescript
import type { FastifyInstance } from "fastify";
import { requireAdmin } from "./guard.js";
import { loadSkyhumanConfig, getCredit } from "../workflow/dub-skyhuman-client.js";

export async function adminDubRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/dub/skyhuman/credit", { preHandler: requireAdmin("VIEW_ANALYTICS") }, async (_req, reply) => {
    try {
      const fetchFn: typeof fetch = (...a) => fetch(...a);
      const r = await getCredit(loadSkyhumanConfig(), fetchFn);
      return { success: true, data: { left: r.left } };
    } catch {
      return reply.code(502).send({ error: "飞天服务不可用" });
    }
  });
}
```

在 server.ts register：`await app.register(adminDubRoutes);`

- [ ] **Step 4: 运行测试通过 + Commit**

Run: `pnpm --filter @yc/api exec vitest run src/admin/dub-routes.test.ts`
```bash
git add apps/api/src/server.ts apps/api/src/admin/dub-routes.ts apps/api/src/admin/dub-routes.test.ts
git commit -m "启动飞天 reaper 与 admin 余额查询"
```

---

#### Task 11: admin 资源计价页声明两 key

**Files:**
- Modify: `apps/admin/src/pages/ResourcePricingPanels.tsx`

让 `dub_avatar_clone`(PER_CALL)、`dub_video_sec`(PER_UNIT) 出现在后台资源计价页可配。

- [ ] **Step 1: 照现有 video key 声明格式，新增两行**

参照该文件已有 `{ resourceKey: "video_seedance_2_720p_text", displayName: ..., ... }` 的声明数组，在合适分组新增：

```typescript
{ resourceKey: "dub_avatar_clone", displayName: "数字人-建形象（按次·视频点）", pricingType: "PER_CALL" },
{ resourceKey: "dub_video_sec", displayName: "数字人-成片（按秒·视频点）", pricingType: "PER_UNIT" },
```

> 若该页声明结构与上不同（如无 pricingType 字段、按 model/resolution 分组），按其真实结构适配——先读该文件顶部声明数组的确切 TS 类型再填。

- [ ] **Step 2: 构建通过 + Commit**

Run: `pnpm --filter @yc/admin exec tsc --noEmit && pnpm --filter @yc/admin build`
```bash
git add apps/admin/src/pages/ResourcePricingPanels.tsx
git commit -m "后台资源计价页新增数字人两 key"
```

---

#### Task 12: 全量回归 + 环境变量登记

**Files:**
- Modify: `infra/k8s/*`（configmap/secret 声明，仅登记不填值）或 `.env.example`（若有）

- [ ] **Step 1: api 全量测试**

Run: `pnpm --filter @yc/api exec vitest run`
Expected: 全绿（含新增 dub-*.test.ts；既有用例无回归）。

- [ ] **Step 2: tsc 净**

Run: `pnpm --filter @yc/api exec tsc --noEmit && pnpm --filter @yc/admin exec tsc --noEmit`
Expected: 无报错。

- [ ] **Step 3: 登记新 env（找现有 env 声明处，加占位说明，不填真值）**

新增：`SKYHUMAN_API_TOKEN`、`SKYHUMAN_BASE_URL`（默认 `https://skyhumanapi.pilihu.vip`）、`SKYHUMAN_CALLBACK_SECRET`、`SKYHUMAN_MAX_INFLIGHT`（默认 3）。若仓库有 `.env.example` / `infra/k8s/base/*configmap*` / `create-secrets.sh`，在对应文件加声明。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "数字人口播 P1 环境变量登记与回归"
```

---

#### 部署漂移（P1 上线需做）

1. 主库迁移 `dub_avatar_skyhuman_task`（新增 Avatar/SkyhumanTask）。
2. api 镜像重建。
3. k8s secret 加 `SKYHUMAN_API_TOKEN`（**上线前轮换**，本会话明文出现过）、`SKYHUMAN_CALLBACK_SECRET`（随机 ≥32）；configmap 加 `SKYHUMAN_BASE_URL`、`SKYHUMAN_MAX_INFLIGHT`。
4. 飞天控制台配回调 URL：`https://api.example.com/api/workflow/dub/skyhuman/callback?secret=<SKYHUMAN_CALLBACK_SECRET>`。
5. admin 资源计价页配 `dub_avatar_clone`、`dub_video_sec` 真实单价并启用（否则收费环节应报 502，前端置灰）。

---

#### Self-Review 结论

- **spec 覆盖**：P1 对应 spec §11 的 P1 行（飞天地基+形象库+成片闭环+计费+回调/reaper+并发闸）——Task 3(client)/4(并发)/5-7(finalize+avatar+video)/8(reaper)/9(路由+回调)/10(reaper启动+admin余额)/11(计价key) 全覆盖。TTS/分析/洗稿/BGM/向导明确不在 P1（spec §11 P2-P4）。
- **占位扫描**：Task 10 Step 2 的 admin 测试与 Task 11 声明格式标注了「按现有文件真实结构适配」——因这两处依赖未逐字读取的既有文件（resource-routes.test.ts 的 admin fixture、ResourcePricingPanels 声明类型），实现时须先读该文件再填，非逻辑占位。
- **类型一致**：`operationId`（SkyhumanTask 唯一键，退款/settle 依据）、`resourceKey`、`storeVideo` 返回 `{url,objectKey}`、`FinalizeBilling`/`AvatarBilling` 接口跨 Task 5-10 一致；`probeVideoDurationSec` 复用既有、`storeGeneratedVideo` 复用既有。
- **资金红线**：avatar 按次 / video 按秒 均 charge 先于建任务，任何失败路径（建任务异常/上传失败/提交失败/上游 failed）都 `refundResource(task.operationId)`；video 完成按真实 duration `settleVideoResource` 退差额；finalize 幂等（status!=running 直接返回）防重复扣退。

### 数字人口播 P2：MiMo TTS 口播 实现计划

> 源文件：`2026-07-08-dub-p2-mimo-tts.md`


> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development 或 executing-plans，逐任务实现，`- [ ]` 勾选跟踪。子代理 prompt 开头须写「跳过所有 superpowers 元技能直接实现」。

**Goal:** 文本 → MiMo TTS 口播音频（preset 预置音色 / design 文字描述音色 / clone 上传音频复刻 三模式），存我方 S3 返回可试听 URL + 时长，按输入字符 `dub_tts_char` 扣算力点，失败退款。

**Architecture:** MiMo 是 OpenAI 兼容、同步返回 base64 音频、独立 key，**不进 `packages/llm`**（那是 Anthropic 层）。裸 fetch client + 按模式构造请求的 service + S3 音频转存。同步链路：charge(按字符·算力点) → MiMo 合成 → 解 base64 → 存 S3 + ffprobe 时长 → 返回；任一步失败 refund。P2 产出独立音频资产（URL），P4 再把它接进成片。

**Tech Stack:** TS / Fastify / @aws-sdk/client-s3（putObject）/ ffprobe（复用 `video-probe.ts` probeVideoDurationSec，对音频有效）/ vitest。

**范围边界（P2 不做）：** 与数字人成片的编排联动（P4）、`DubProject` 聚合（P4）、流式 TTS（YAGNI，用非流式一次返回）、音色管理持久化表（YAGNI，clone 每次传参考音频）。

#### 文件结构

| 文件 | 职责 |
|---|---|
| `apps/api/src/workflow/dub-constants.ts`（改）| 增 `DUB_TTS_CHAR_KEY`、MiMo 上限常量 |
| `apps/api/src/workflow/dub-mimo-client.ts`（建）| MiMo TTS HTTP client（config + synthesizeTts） |
| `apps/api/src/workflow/dub-tts-voices.ts`（建）| 预置音色列表常量 |
| `apps/api/src/workflow/dub-audio-store.ts`（建）| 音频 buffer 存 S3 → {url,objectKey} |
| `apps/api/src/workflow/dub-tts-service.ts`（建）| 按模式构造请求 + charge/合成/存储/refund |
| `apps/api/src/workflow/dub-routes.ts`（改）| `POST /api/workflow/dub/tts`、`GET /api/workflow/dub/tts/voices` |
| `apps/api/src/workflow/dub-routes.test.ts`（改）| 补 TTS 路由测试 |
| `apps/admin/src/pages/ResourcePricingPanels.tsx`（改）| 声明 `dub_tts_char` 配价 |
| `apps/admin/src/pages/ResourcePricing.tsx`（改）| 渲染该配价面板 |
| `.env.example`（改）| 登记 `MIMO_API_KEY`/`MIMO_BASE_URL` |

统一签名（跨任务一致）：
- MiMo：`synthesizeTts(cfg, fetchFn, { model, messages, audio }) => { data: base64, format }`
- 计费：`chargeResource({operationId, userId, resourceKey, units, accountType:"points"}) => {charged}`；`refundResource(operationId)`
- 音频存储：`storeAudioBuffer({ userId, buffer, mime, ext }) => { url, objectKey }`

---

#### Task 1: 常量增补

**Files:** Modify `apps/api/src/workflow/dub-constants.ts`

- [ ] **Step 1: 追加常量**

```typescript
// TTS 计费 key（后台配每字单价·算力点）
export const DUB_TTS_CHAR_KEY = "dub_tts_char"; // PER_UNIT 按输入字符·算力点

// MiMo TTS
export const DUB_TTS_TEXT_MAX_CHARS = 10000; // MiMo 单次上限 1 万字
export const DUB_TTS_CLONE_REF_MAX_BYTES = 10 * 1024 * 1024; // 复刻参考音频 ≤10MB
export const DUB_TTS_MODEL_BY_MODE = {
  preset: "mimo-v2.5-tts",
  design: "mimo-v2.5-tts-voicedesign",
  clone: "mimo-v2.5-tts-voiceclone",
} as const;
export type DubTtsMode = keyof typeof DUB_TTS_MODEL_BY_MODE;
```

- [ ] **Step 2: tsc + Commit**

Run: `pnpm --filter @yc/api exec tsc --noEmit`
```bash
git add apps/api/src/workflow/dub-constants.ts
git commit -m "数字人口播 TTS 常量"
```

---

#### Task 2: MiMo TTS client

**Files:** Create `apps/api/src/workflow/dub-mimo-client.ts` + `dub-mimo-client.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect, vi } from "vitest";
import { loadMimoConfig, synthesizeTts, MimoError } from "./dub-mimo-client.js";

const cfg = { apiKey: "k", baseUrl: "https://mimo.test/v1" };
function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("dub-mimo-client", () => {
  it("synthesizeTts 解出 base64 音频 data 与 format", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ choices: [{ message: { audio: { data: "QUJD" } } }] }));
    const r = await synthesizeTts(cfg, fetchFn, { model: "mimo-v2.5-tts", messages: [{ role: "assistant", content: "你好" }], audio: { format: "wav", voice: "冰糖" } });
    expect(r).toEqual({ data: "QUJD", format: "wav" });
    // 校验请求：api-key 头 + 端点 + body
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://mimo.test/v1/chat/completions");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("k");
    expect(JSON.parse(init.body as string).audio.voice).toBe("冰糖");
  });

  it("非 200 抛 MimoError", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("bad", { status: 400 }));
    await expect(synthesizeTts(cfg, fetchFn, { model: "m", messages: [], audio: { format: "wav" } }))
      .rejects.toMatchObject({ name: "MimoError" });
  });

  it("缺 audio.data 抛 MimoError", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ choices: [{ message: {} }] }));
    await expect(synthesizeTts(cfg, fetchFn, { model: "m", messages: [], audio: { format: "wav" } }))
      .rejects.toMatchObject({ name: "MimoError" });
  });

  it("loadMimoConfig 缺 key 抛错", () => {
    expect(() => loadMimoConfig({} as NodeJS.ProcessEnv)).toThrow(/MIMO_API_KEY/);
  });
});
```

- [ ] **Step 2: 运行失败** — `pnpm --filter @yc/api exec vitest run src/workflow/dub-mimo-client.test.ts`（模块不存在）

- [ ] **Step 3: 实现**

```typescript
import { z } from "zod";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export interface MimoConfig { readonly apiKey: string; readonly baseUrl: string }
export interface TtsMessage { readonly role: "user" | "assistant"; readonly content: string }
export interface TtsAudioOpts { readonly format: "wav" | "mp3"; readonly voice?: string; readonly optimize_text_preview?: boolean }

export class MimoError extends Error {
  readonly name = "MimoError";
  constructor(message: string) { super(message); }
}

export function loadMimoConfig(env: NodeJS.ProcessEnv = process.env): MimoConfig {
  const apiKey = env.MIMO_API_KEY?.trim();
  if (!apiKey) throw new Error("MIMO_API_KEY required");
  const baseUrl = (env.MIMO_BASE_URL?.trim() || "https://api.xiaomimimo.com/v1").replace(/\/+$/u, "");
  return { apiKey, baseUrl };
}

const respSchema = z.object({
  choices: z.array(z.object({ message: z.object({ audio: z.object({ data: z.string() }).optional() }) })).min(1),
});

export async function synthesizeTts(
  cfg: MimoConfig,
  fetchFn: FetchLike,
  req: { model: string; messages: TtsMessage[]; audio: TtsAudioOpts },
): Promise<{ data: string; format: string }> {
  const res = await fetchFn(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "api-key": cfg.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ model: req.model, messages: req.messages, audio: req.audio }),
  });
  if (!res.ok) throw new MimoError(`mimo tts http ${res.status}`);
  const parsed = respSchema.parse(await res.json());
  const data = parsed.choices[0]?.message.audio?.data;
  if (!data) throw new MimoError("mimo tts 响应缺少音频数据");
  return { data, format: req.audio.format };
}
```

- [ ] **Step 4: 通过 + Commit**

Run: `pnpm --filter @yc/api exec vitest run src/workflow/dub-mimo-client.test.ts`
```bash
git add apps/api/src/workflow/dub-mimo-client.ts apps/api/src/workflow/dub-mimo-client.test.ts
git commit -m "MiMo TTS client"
```

---

#### Task 3: 预置音色列表

**Files:** Create `apps/api/src/workflow/dub-tts-voices.ts`

- [ ] **Step 1: 纯声明（无测试）**

```typescript
export interface PresetVoice { readonly id: string; readonly label: string; readonly lang: "zh" | "en"; readonly gender: "male" | "female" }

// 来自 MiMo 预置精品音色列表（mimo-v2.5-tts）
export const DUB_PRESET_VOICES: readonly PresetVoice[] = [
  { id: "冰糖", label: "冰糖", lang: "zh", gender: "female" },
  { id: "茉莉", label: "茉莉", lang: "zh", gender: "female" },
  { id: "苏打", label: "苏打", lang: "zh", gender: "male" },
  { id: "白桦", label: "白桦", lang: "zh", gender: "male" },
  { id: "Mia", label: "Mia", lang: "en", gender: "female" },
  { id: "Chloe", label: "Chloe", lang: "en", gender: "female" },
  { id: "Milo", label: "Milo", lang: "en", gender: "male" },
  { id: "Dean", label: "Dean", lang: "en", gender: "male" },
];

export function isPresetVoice(id: string): boolean {
  return DUB_PRESET_VOICES.some((v) => v.id === id);
}
```

- [ ] **Step 2: tsc + Commit**

Run: `pnpm --filter @yc/api exec tsc --noEmit`
```bash
git add apps/api/src/workflow/dub-tts-voices.ts
git commit -m "MiMo 预置音色列表"
```

---

#### Task 4: 音频转存 S3

**Files:** Create `apps/api/src/workflow/dub-audio-store.ts` + `dub-audio-store.test.ts`

参照 `video-service.ts` 的素材存储（putObject + public-read + 公有 URL）。

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect, vi } from "vitest";
import { buildAudioPublicUrl } from "./dub-audio-store.js";

describe("dub-audio-store", () => {
  it("forcePathStyle 时 URL = endpoint/bucket/key", () => {
    const url = buildAudioPublicUrl({ endpoint: "http://minio:9000", bucket: "yc", forcePathStyle: true } as any, "dub/audio/u1/x.wav", {} as NodeJS.ProcessEnv);
    expect(url).toBe("http://minio:9000/yc/dub/audio/u1/x.wav");
  });
  it("配置了 S3_PUBLIC_BASE_URL 时优先用它", () => {
    const url = buildAudioPublicUrl({ endpoint: "http://minio:9000", bucket: "yc", forcePathStyle: true } as any, "dub/audio/u1/x.wav", { S3_PUBLIC_BASE_URL: "https://cdn.example.com" } as unknown as NodeJS.ProcessEnv);
    expect(url).toBe("https://cdn.example.com/dub/audio/u1/x.wav");
  });
});
```

- [ ] **Step 2: 运行失败**

- [ ] **Step 3: 实现**

```typescript
import { randomUUID } from "node:crypto";
import { loadS3Config, makeS3, putObject, type S3Config } from "../storage/s3.js";

function trimTrailingSlash(v: string): string { return v.replace(/\/+$/u, ""); }
function encodeKey(key: string): string { return key.split("/").map(encodeURIComponent).join("/"); }

export function buildAudioPublicUrl(cfg: S3Config, key: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.S3_PUBLIC_BASE_URL ?? "").trim();
  const encoded = encodeKey(key);
  if (base) return `${trimTrailingSlash(base)}/${encoded}`;
  if (cfg.forcePathStyle) return `${trimTrailingSlash(cfg.endpoint)}/${encodeURIComponent(cfg.bucket)}/${encoded}`;
  return `${trimTrailingSlash(cfg.endpoint).replace(/^(https?:\/\/)/u, `$1${cfg.bucket}.`)}/${encoded}`;
}

export async function storeAudioBuffer(args: { userId: string; buffer: Buffer; mime: string; ext: string; env?: NodeJS.ProcessEnv }): Promise<{ url: string; objectKey: string }> {
  const env = args.env ?? process.env;
  const cfg = loadS3Config(env);
  const s3 = makeS3(cfg);
  const key = `dub/audio/${args.userId}/${randomUUID()}.${args.ext}`;
  await putObject(s3, key, args.buffer, args.mime, { acl: "public-read" });
  return { url: buildAudioPublicUrl(cfg, key, env), objectKey: key };
}
```

- [ ] **Step 4: 通过 + Commit**

Run: `pnpm --filter @yc/api exec vitest run src/workflow/dub-audio-store.test.ts`
```bash
git add apps/api/src/workflow/dub-audio-store.ts apps/api/src/workflow/dub-audio-store.test.ts
git commit -m "数字人口播音频转存 S3"
```

---

#### Task 5: TTS 服务（按模式构造 + 计费）

**Files:** Create `apps/api/src/workflow/dub-tts-service.ts` + `dub-tts-service.test.ts`

- [ ] **Step 1: 写失败测试（依赖注入 billing/synth/store/probe）**

```typescript
import { describe, it, expect, vi } from "vitest";
import { buildTtsRequest, generateTts } from "./dub-tts-service.js";

describe("buildTtsRequest", () => {
  it("preset：model=mimo-v2.5-tts，assistant 放文案，audio.voice=音色", () => {
    const r = buildTtsRequest({ mode: "preset", text: "你好", voice: "冰糖", format: "wav" });
    expect(r.model).toBe("mimo-v2.5-tts");
    expect(r.audio).toMatchObject({ format: "wav", voice: "冰糖" });
    expect(r.messages.find((m) => m.role === "assistant")?.content).toBe("你好");
  });
  it("design：model=voicedesign，user 放音色描述，assistant 放文案", () => {
    const r = buildTtsRequest({ mode: "design", text: "晚安", description: "温柔治愈女声", format: "wav" });
    expect(r.model).toBe("mimo-v2.5-tts-voicedesign");
    expect(r.messages.find((m) => m.role === "user")?.content).toBe("温柔治愈女声");
    expect(r.messages.find((m) => m.role === "assistant")?.content).toBe("晚安");
  });
  it("clone：model=voiceclone，audio.voice=data URI", () => {
    const r = buildTtsRequest({ mode: "clone", text: "测试", refAudioDataUri: "data:audio/mpeg;base64,QUJD", format: "wav" });
    expect(r.model).toBe("mimo-v2.5-tts-voiceclone");
    expect(r.audio.voice).toBe("data:audio/mpeg;base64,QUJD");
  });
});

describe("generateTts", () => {
  function deps() {
    const billing = { chargeResource: vi.fn().mockResolvedValue({ charged: 5 }), refundResource: vi.fn().mockResolvedValue({ success: true }) };
    const synth = vi.fn().mockResolvedValue({ data: Buffer.from("audio").toString("base64"), format: "wav" });
    const storeAudio = vi.fn().mockResolvedValue({ url: "https://our/a.wav", objectKey: "k" });
    const probe = vi.fn().mockResolvedValue(3);
    return { billing: billing as any, synth, storeAudio, probe };
  }

  it("按输入字符收费·算力点，返回 audioUrl/duration", async () => {
    const d = deps();
    const r = await generateTts({ cfg: {} as any, fetchFn: vi.fn(), billing: d.billing, userId: "u1", mode: "preset", text: "你好世界", voice: "冰糖", format: "wav", synth: d.synth, storeAudio: d.storeAudio, probeDurationSec: d.probe });
    expect(d.billing.chargeResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "dub_tts_char", units: 4, accountType: "points" }));
    expect(r).toMatchObject({ audioUrl: "https://our/a.wav", durationSec: 3 });
  });

  it("合成失败：退款并抛错", async () => {
    const d = deps();
    d.synth.mockRejectedValue(new Error("mimo down"));
    await expect(generateTts({ cfg: {} as any, fetchFn: vi.fn(), billing: d.billing, userId: "u1", mode: "preset", text: "你好", voice: "冰糖", format: "wav", synth: d.synth, storeAudio: d.storeAudio, probeDurationSec: d.probe })).rejects.toThrow(/mimo down/);
    expect(d.billing.refundResource).toHaveBeenCalled();
  });

  it("空文案抛错，不收费", async () => {
    const d = deps();
    await expect(generateTts({ cfg: {} as any, fetchFn: vi.fn(), billing: d.billing, userId: "u1", mode: "preset", text: "  ", voice: "冰糖", format: "wav", synth: d.synth, storeAudio: d.storeAudio, probeDurationSec: d.probe })).rejects.toThrow(/文案/);
    expect(d.billing.chargeResource).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行失败**

- [ ] **Step 3: 实现**

```typescript
import { randomUUID } from "node:crypto";
import type { MimoConfig, FetchLike, TtsMessage, TtsAudioOpts } from "./dub-mimo-client.js";
import * as mimo from "./dub-mimo-client.js";
import { DUB_TTS_CHAR_KEY, DUB_TTS_MODEL_BY_MODE, type DubTtsMode } from "./dub-constants.js";

export interface BuildTtsInput {
  mode: DubTtsMode; text: string; format: "wav" | "mp3";
  voice?: string;            // preset 音色 id
  description?: string;      // design 音色描述
  style?: string;            // preset/clone 可选自然语言风格
  refAudioDataUri?: string;  // clone 参考音频 data URI
}

export function buildTtsRequest(input: BuildTtsInput): { model: string; messages: TtsMessage[]; audio: TtsAudioOpts } {
  const model = DUB_TTS_MODEL_BY_MODE[input.mode];
  const messages: TtsMessage[] = [];
  const audio: TtsAudioOpts = { format: input.format };
  if (input.mode === "design") {
    messages.push({ role: "user", content: input.description ?? "" });
    messages.push({ role: "assistant", content: input.text });
  } else {
    if (input.style) messages.push({ role: "user", content: input.style });
    messages.push({ role: "assistant", content: input.text });
    if (input.mode === "preset" && input.voice) audio.voice = input.voice;
    if (input.mode === "clone" && input.refAudioDataUri) audio.voice = input.refAudioDataUri;
  }
  return { model, messages, audio };
}

export interface TtsBilling {
  chargeResource: (a: { operationId: string; userId: string; resourceKey: string; units: number; accountType: "points" }) => Promise<{ charged: number }>;
  refundResource: (operationId: string) => Promise<{ success: boolean }>;
}

export interface GenerateTtsArgs extends BuildTtsInput {
  cfg: MimoConfig; fetchFn: FetchLike; billing: TtsBilling; userId: string;
  synth?: typeof mimo.synthesizeTts;
  storeAudio: (a: { userId: string; buffer: Buffer; mime: string; ext: string }) => Promise<{ url: string; objectKey: string }>;
  probeDurationSec: (buf: Buffer) => Promise<number>;
}

export async function generateTts(args: GenerateTtsArgs): Promise<{ audioUrl: string; objectKey: string; durationSec: number; chargedPoints: number }> {
  const text = args.text?.trim() ?? "";
  if (!text) throw new Error("文案不能为空");
  const synth = args.synth ?? mimo.synthesizeTts;
  const operationId = `dub-tts:${randomUUID()}`;
  const charged = await args.billing.chargeResource({ operationId, userId: args.userId, resourceKey: DUB_TTS_CHAR_KEY, units: text.length, accountType: "points" });
  try {
    const req = buildTtsRequest({ ...args, text });
    const out = await synth(args.cfg, args.fetchFn, req);
    const buffer = Buffer.from(out.data, "base64");
    const ext = out.format === "mp3" ? "mp3" : "wav";
    const mime = ext === "mp3" ? "audio/mpeg" : "audio/wav";
    const stored = await args.storeAudio({ userId: args.userId, buffer, mime, ext });
    const durationSec = Math.max(0, Math.round(await args.probeDurationSec(buffer)));
    return { audioUrl: stored.url, objectKey: stored.objectKey, durationSec, chargedPoints: charged.charged };
  } catch (e) {
    await args.billing.refundResource(operationId).catch(() => undefined);
    throw e;
  }
}
```

- [ ] **Step 4: 通过 + Commit**

Run: `pnpm --filter @yc/api exec vitest run src/workflow/dub-tts-service.test.ts`
```bash
git add apps/api/src/workflow/dub-tts-service.ts apps/api/src/workflow/dub-tts-service.test.ts
git commit -m "MiMo TTS 服务（三模式+计费）"
```

---

#### Task 6: TTS 路由 + 音色列表

**Files:** Modify `apps/api/src/workflow/dub-routes.ts`、`dub-routes.test.ts`

在 `dubRoutes` 内新增两路由（懒加载 MiMo cfg，缺 key 返 502）：
- `GET /api/workflow/dub/tts/voices` → 预置音色列表（无需鉴权外的额外权限，但要求登录）
- `POST /api/workflow/dub/tts` body `{mode, text, format?, voice?, description?, style?, refAudioBase64?, refAudioMime?}` → generateTts → `{audioUrl, durationSec, chargedPoints}`

- [ ] **Step 1: 在 dub-routes.ts 顶部补 import**

```typescript
import { loadMimoConfig, type MimoConfig } from "./dub-mimo-client.js";
import { generateTts } from "./dub-tts-service.js";
import { storeAudioBuffer } from "./dub-audio-store.js";
import { DUB_PRESET_VOICES, isPresetVoice } from "./dub-tts-voices.js";
import { DUB_TTS_TEXT_MAX_CHARS, DUB_TTS_CLONE_REF_MAX_BYTES, type DubTtsMode } from "./dub-constants.js";
```

- [ ] **Step 2: 在 dubRoutes 函数体内（getCfg 之后）加 MiMo 懒加载 + 两路由**

```typescript
  let cachedMimo: MimoConfig | null | undefined;
  function getMimo(): MimoConfig | null {
    if (cachedMimo === undefined) { try { cachedMimo = loadMimoConfig(); } catch { cachedMimo = null; } }
    return cachedMimo;
  }

  app.get("/api/workflow/dub/tts/voices", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    return { success: true, data: DUB_PRESET_VOICES };
  });

  app.post("/api/workflow/dub/tts", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const mimo = getMimo(); if (!mimo) return reply.code(502).send({ error: "MiMo 未配置" });
    const b = (req.body ?? {}) as { mode?: string; text?: string; format?: string; voice?: string; description?: string; style?: string; refAudioBase64?: string; refAudioMime?: string };
    const mode = b.mode as DubTtsMode | undefined;
    if (mode !== "preset" && mode !== "design" && mode !== "clone") return reply.code(400).send({ error: "mode 无效" });
    const text = (b.text ?? "").trim();
    if (!text) return reply.code(400).send({ error: "请输入口播文案" });
    if (text.length > DUB_TTS_TEXT_MAX_CHARS) return reply.code(400).send({ error: `文案不能超过 ${DUB_TTS_TEXT_MAX_CHARS} 字` });
    const format = b.format === "mp3" ? "mp3" : "wav";
    if (mode === "preset" && (!b.voice || !isPresetVoice(b.voice))) return reply.code(400).send({ error: "请选择预置音色" });
    if (mode === "design" && !b.description?.trim()) return reply.code(400).send({ error: "请填写音色描述" });
    let refAudioDataUri: string | undefined;
    if (mode === "clone") {
      if (!b.refAudioBase64 || !b.refAudioMime) return reply.code(400).send({ error: "请上传参考音频" });
      const bytes = Buffer.from(b.refAudioBase64, "base64").byteLength;
      if (bytes > DUB_TTS_CLONE_REF_MAX_BYTES) return reply.code(413).send({ error: "参考音频不能超过 10MB" });
      refAudioDataUri = `data:${b.refAudioMime};base64,${b.refAudioBase64}`;
    }
    try {
      const r = await generateTts({
        cfg: mimo, fetchFn, billing, userId, mode, text, format,
        voice: b.voice, description: b.description, style: b.style, refAudioDataUri,
        storeAudio: storeAudioBuffer, probeDurationSec: probeVideoDurationSec,
      });
      return { success: true, data: { audioUrl: r.audioUrl, durationSec: r.durationSec, chargedPoints: r.chargedPoints } };
    } catch (e) {
      if ((e as Error)?.name === "InsufficientBalanceError") return reply.code(402).send({ error: "算力点不足，请充值" });
      return reply.code(502).send({ error: "语音合成失败：" + (e as Error).message });
    }
  });
```

> `billing` 复用 dubRoutes 已构造的实例（含 chargeResource/refundResource，满足 `TtsBilling`）；`probeVideoDurationSec` 已在文件顶部 import（P1）。`fetchFn` 已有。

- [ ] **Step 3: 在 dub-routes.test.ts 补测试**

```typescript
  it("GET /tts/voices 返回预置音色", async () => {
    const r = await app.inject({ method: "GET", url: "/api/workflow/dub/tts/voices", headers: { authorization: auth } });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { data: Array<{ id: string }> }).data.some((v) => v.id === "冰糖")).toBe(true);
  });
  it("POST /tts 缺 mode 400", async () => {
    const r = await app.inject({ method: "POST", url: "/api/workflow/dub/tts", headers: { authorization: auth }, payload: { text: "你好" } });
    expect(r.statusCode).toBe(400);
  });
  it("POST /tts preset 缺音色 400", async () => {
    const r = await app.inject({ method: "POST", url: "/api/workflow/dub/tts", headers: { authorization: auth }, payload: { mode: "preset", text: "你好" } });
    expect(r.statusCode).toBe(400);
  });
```

> 注：需在测试 beforeAll 设 `process.env.MIMO_API_KEY ??= "mk-test"`，否则 POST /tts 走到 getMimo() 返 502 而非 400。放在其它 env 设置旁。

- [ ] **Step 4: 运行 + tsc + Commit**

Run: `DATABASE_URL='postgresql://yunclaude:yunclaude@localhost:5433/yunclaude' pnpm --filter @yc/api exec vitest run src/workflow/dub-routes.test.ts`
Run: `pnpm --filter @yc/api exec tsc --noEmit`
```bash
git add apps/api/src/workflow/dub-routes.ts apps/api/src/workflow/dub-routes.test.ts
git commit -m "数字人口播 TTS 路由与音色列表"
```

---

#### Task 7: admin 计价页 dub_tts_char + env

**Files:** Modify `apps/admin/src/pages/ResourcePricingPanels.tsx`、`ResourcePricing.tsx`、`.env.example`

- [ ] **Step 1: 在 `DUB_RESOURCE_PRICING_CONFIGS` 数组新增一项**（P1 已建该数组）

```typescript
  {
    resourceKey: "dub_tts_char",
    title: "数字人-配音价格",
    description: "数字人口播：MiMo TTS 按输入字符扣算力点。",
    displayName: "数字人-配音(按字·算力点)",
    pricingType: "PER_UNIT",
    defaultRate: 1,
    rateLabel: "每字配音扣算力点",
  },
```

> `DUB_RESOURCE_PRICING_CONFIGS` 已在 ResourcePricing.tsx 渲染（P1 Task 11），新增项自动出现，无需改渲染。

- [ ] **Step 2: .env.example 增 MiMo**

在「数字人口播（飞天数字人 · P1）」块后追加：
```
# 数字人口播 · 配音（MiMo TTS · P2）
MIMO_API_KEY=                                    # 小米 MiMo 平台 key，未配置则配音不可用
MIMO_BASE_URL=https://api.xiaomimimo.com/v1
```

- [ ] **Step 3: admin 构建 + Commit**

Run: `pnpm --filter @yc/admin exec tsc --noEmit && pnpm --filter @yc/admin build`
```bash
git add apps/admin/src/pages/ResourcePricingPanels.tsx .env.example
git commit -m "后台配音计价 key 与 MiMo 环境变量"
```

---

#### Task 8: 全量回归

- [ ] **Step 1: dub 全量测试**

Run（含 ambient env）：
```bash
DATABASE_URL='postgresql://yunclaude:yunclaude@localhost:5433/yunclaude' BILLING_BASE_URL='http://localhost:1' BILLING_INTERNAL_TOKEN='t' LLM_BASE_URL='http://localhost:9999' LLM_API_KEY='test-key' EMBEDDING_MODEL='m' pnpm --filter @yc/api exec vitest run src/workflow/dub-mimo-client.test.ts src/workflow/dub-audio-store.test.ts src/workflow/dub-tts-service.test.ts src/workflow/dub-routes.test.ts
```
Expected: 全绿。

- [ ] **Step 2: api tsc + admin build**

Run: `pnpm --filter @yc/api exec tsc --noEmit && pnpm --filter @yc/admin exec tsc --noEmit`

- [ ] **Step 3: Commit（若有零散改动）**

---

#### 部署漂移（P2 上线追加）

- k8s secret 加 `MIMO_API_KEY`；configmap 加 `MIMO_BASE_URL`。
- admin 资源计价页配 `dub_tts_char` 真实每字单价并启用（否则配音报 502/置灰）。
- MiMo key 上线前确认有效额度。

#### Self-Review 结论

- **spec 覆盖**：对应 spec §11 P2（MiMo TTS preset/design/clone 三模式 + `dub_tts_char` 按字符·算力点 + 试听 URL）——Task 2(client)/3(音色)/4(存储)/5(服务+计费)/6(路由)/7(计价+env) 全覆盖。成片联动/DubProject 归 P4，明确不在 P2。
- **占位扫描**：无 TBD/TODO；所有代码块完整。
- **类型一致**：`synthesizeTts`/`TtsMessage`/`TtsAudioOpts`/`buildTtsRequest` 返回结构/`storeAudioBuffer` 返回 `{url,objectKey}`/`TtsBilling` 跨 Task 2-6 一致；复用 `probeVideoDurationSec`(P1 已 import)、`putObject`/`loadS3Config`。
- **资金红线**：按 `text.length` charge 先于合成、合成/存储任何失败 `refundResource`、空文案不收费、InsufficientBalanceError→402。同步链路无异步幂等问题。

### 数字人口播 P3：多板块分析 + 洗稿 实现计划

> 源文件：`2026-07-08-dub-p3-analyze-rewrite.md`


> **For agentic workers:** 逐任务实现，`- [ ]` 勾选。子代理 prompt 开头须写「跳过所有 superpowers 元技能直接实现」。

**Goal:** ①上传参考视频 → M3 视频直传拆解出 4 板块（逐字口播文稿 / 分镜脚本 / 结构拆解 / 亮点卖点），按秒扣算力点；②把口播文稿交 M3 洗稿改写（可挂知识库、可注入亮点约束），LLM token ×3 扣算力点。

**Architecture:** 分析照抄 `video-analyze-service.ts` 的 `analyzeReference` 范式（chargeResource 按秒 → M3 video block → `callJsonWithRetry` 宽松解析 → 失败 refund）；洗稿照抄 `video-script-service.ts` 的 `generateScript` 范式（`reserve(est×3)` → M3 → `settle(actual×3)`，失败 `settle(0,0)` 释放预扣，`type:"dub-rewrite"` 隐藏模型名）。KB 检索独立成 `dub-kb-context.ts`（`billableEmbed` → `resolveEffectiveKbIds` → `retrieveChunks` → `filterRelevantChunks` → 拼参考资料串），路由注入，保持洗稿服务纯净。

**Tech Stack:** TS / Anthropic SDK（经 NewAPI，模型 `MiniMax-M3`）/ zod + jsonrepair / Fastify multipart / pgvector KB / vitest。

**范围边界（P3 不做）：** `DubProject` 聚合持久化与向导编排（P4）、BGM/混音（P4）、前端页面（P4）。P3 = 两个**无状态**端点：传视频出分析 JSON；传文本出洗稿文本。

#### 文件结构

| 文件 | 职责 |
|---|---|
| `apps/api/src/workflow/video-analyze-service.ts`（改）| 把 `parseLenientJson` / `callJsonWithRetry` 导出供复用（DRY，禁复制粘贴） |
| `apps/api/src/workflow/dub-constants.ts`（改）| 分析/洗稿的 maxTokens、×3 倍率、视频上限 |
| `apps/api/src/workflow/dub-analyze-service.ts`（建）| M3 视频直传 → 4 板块 JSON + 按秒计费 |
| `apps/api/src/workflow/dub-kb-context.ts`（建）| 知识库检索 → 参考资料串 |
| `apps/api/src/workflow/dub-rewrite-service.ts`（建）| M3 洗稿改写 + reserve/settle ×3 |
| `apps/api/src/workflow/dub-routes.ts`（改）| `POST /api/workflow/dub/analyze`、`POST /api/workflow/dub/rewrite`；billing cast 加 reserve/settle |
| `apps/api/src/workflow/dub-routes.test.ts`（改）| 补两路由测试 |
| `apps/web/src/pages/Billing.tsx`（改）| `dub-rewrite` 账单标签 + 隐藏模型名 |

统一签名（跨任务一致）：
- `AnalyzeBilling { chargeResource(a:{operationId,userId,resourceKey,units,accountType:"points"|"video"}), refundResource(opId) }`
- `RewriteBilling { reserve(a:{operationId,userId,type,model,inputTokens,maxOutputTokens}), settle(a:{operationId,userId,model,inputTokens,outputTokens}) }`
- `DubAnalysis = { spokenScript, shotScript, structure, highlights[] }`

---

#### Task 1: 导出可复用的宽松 JSON 解析

**Files:** Modify `apps/api/src/workflow/video-analyze-service.ts`

- [ ] **Step 1: 给两个内部函数加 `export`**（不改逻辑）

把
```typescript
function parseLenientJson(raw: string): unknown {
```
改为
```typescript
export function parseLenientJson(raw: string): unknown {
```
把
```typescript
async function callJsonWithRetry<T>(produce: () => Promise<string>, parse: (text: string) => T): Promise<T> {
```
改为
```typescript
export async function callJsonWithRetry<T>(produce: () => Promise<string>, parse: (text: string) => T): Promise<T> {
```

- [ ] **Step 2: tsc + 既有测试无回归 + Commit**

Run: `pnpm --filter @yc/api exec tsc --noEmit`（exit 0）
Run: `DATABASE_URL='postgresql://yunclaude:yunclaude@localhost:5433/yunclaude' pnpm --filter @yc/api exec vitest run src/workflow/video-analyze-service.test.ts`
```bash
git add apps/api/src/workflow/video-analyze-service.ts
git commit -m "导出宽松 JSON 解析供数字人口播复用"
```

---

#### Task 2: 常量增补

**Files:** Modify `apps/api/src/workflow/dub-constants.ts`

- [ ] **Step 1: 追加**

```typescript
// 分析（M3 视频直传拆解）
export const DUB_ANALYZE_VIDEO_MAX_BYTES = 50 * 1024 * 1024; // 参考视频 ≤50MB（同既有 analyze-reference）
export const DUB_ANALYZE_MAX_TOKENS = 4000;

// 洗稿（M3 改写）
export const DUB_REWRITE_MAX_TOKENS = 3000;
export const DUB_REWRITE_PRICE_MULTIPLIER = 3; // 洗稿按模型原价 3 倍计费
export const DUB_REWRITE_BILLING_TYPE = "dub-rewrite"; // 账单显示用，隐藏模型名
export const DUB_REWRITE_TEXT_MAX_CHARS = 20000;
```

- [ ] **Step 2: tsc + Commit**

```bash
git add apps/api/src/workflow/dub-constants.ts
git commit -m "数字人口播分析与洗稿常量"
```

---

#### Task 3: 多板块分析服务

**Files:** Create `apps/api/src/workflow/dub-analyze-service.ts` + `dub-analyze-service.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect, vi } from "vitest";
import { analyzeDubVideo, parseDubAnalysis } from "./dub-analyze-service.js";

const good = JSON.stringify({
  spokenScript: "大家好，今天聊聊这款耳机。",
  shotScript: "镜头1：特写耳机；镜头2：主播出镜。",
  structure: "钩子→卖点→CTA",
  highlights: ["降噪强", "续航久"],
});

describe("parseDubAnalysis", () => {
  it("解析 4 板块", () => {
    const r = parseDubAnalysis(good);
    expect(r.spokenScript).toContain("耳机");
    expect(r.highlights).toEqual(["降噪强", "续航久"]);
  });
  it("缺字段用默认值兜底", () => {
    const r = parseDubAnalysis(JSON.stringify({ spokenScript: "x" }));
    expect(r.shotScript).toBe("");
    expect(r.highlights).toEqual([]);
  });
});

describe("analyzeDubVideo", () => {
  function deps() {
    const billing = { chargeResource: vi.fn().mockResolvedValue({ charged: 10 }), refundResource: vi.fn().mockResolvedValue({ success: true }) };
    const callM3 = vi.fn().mockResolvedValue({ text: good, usage: { inputTokens: 1, outputTokens: 1 } });
    return { billing: billing as any, callM3 };
  }
  const base = { userId: "u1", requestId: "r1", videoBase64: "QUJD", mime: "video/mp4", client: {} as any };

  it("按秒收费·算力点，返回 4 板块", async () => {
    const d = deps();
    const r = await analyzeDubVideo({ ...base, durationSec: 30, billing: d.billing, callM3: d.callM3 });
    expect(d.billing.chargeResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "video_analyze_video_sec", units: 30, accountType: "points" }));
    expect(r.spokenScript).toContain("耳机");
  });

  it("时长为 0 抛错且不收费", async () => {
    const d = deps();
    await expect(analyzeDubVideo({ ...base, durationSec: 0, billing: d.billing, callM3: d.callM3 })).rejects.toThrow(/时长/);
    expect(d.billing.chargeResource).not.toHaveBeenCalled();
  });

  it("M3 失败：退款并抛错", async () => {
    const d = deps();
    d.callM3.mockRejectedValue(new Error("m3 down"));
    await expect(analyzeDubVideo({ ...base, durationSec: 10, billing: d.billing, callM3: d.callM3 })).rejects.toThrow(/m3 down/);
    expect(d.billing.refundResource).toHaveBeenCalled();
  });

  it("秒数向上取整", async () => {
    const d = deps();
    await analyzeDubVideo({ ...base, durationSec: 10.2, billing: d.billing, callM3: d.callM3 });
    expect(d.billing.chargeResource).toHaveBeenCalledWith(expect.objectContaining({ units: 11 }));
  });
});
```

- [ ] **Step 2: 运行失败** — `pnpm --filter @yc/api exec vitest run src/workflow/dub-analyze-service.test.ts`

- [ ] **Step 3: 实现**

```typescript
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { callMiniMaxMessages } from "./video-multimodal.js";
import { parseLenientJson, callJsonWithRetry } from "./video-analyze-service.js";
import { VIDEO_ANALYZE_VIDEO_SEC_RESOURCE_KEY } from "./video-service.js";
import { DUB_ANALYZE_MAX_TOKENS } from "./dub-constants.js";

const analysisSchema = z.object({
  spokenScript: z.string().default(""),
  shotScript: z.string().default(""),
  structure: z.string().default(""),
  highlights: z.array(z.string()).default([]),
});
export type DubAnalysis = z.infer<typeof analysisSchema>;

export function parseDubAnalysis(text: string): DubAnalysis {
  return analysisSchema.parse(parseLenientJson(text));
}

const ANALYZE_SYSTEM = [
  "你是短视频口播拆解专家。用户上传一段参考视频。请拆解为 4 个板块：",
  "1) spokenScript：逐字还原视频中的完整口播文稿（只要说出口的话，不要画面描述）；若无人声则根据画面推断一段等长口播；",
  "2) shotScript：分镜脚本，逐镜写「画面/台词/时长」；",
  "3) structure：结构拆解（开头钩子 / 正文展开 / 结尾 CTA / 整体节奏）；",
  "4) highlights：亮点卖点数组（卖点、目标受众、使用场景）。",
  "只输出严格合法的 JSON，禁止 Markdown 代码块、禁止思考过程、禁止 JSON 以外的任何文字。",
  "字符串值内不要出现未转义的双引号，用中文引号「」或去掉引号。JSON 结构：",
  `{"spokenScript":"","shotScript":"","structure":"","highlights":[]}`,
].join("\n");

export interface AnalyzeBilling {
  chargeResource: (a: { operationId: string; userId: string; resourceKey: string; units: number; accountType: "points" | "video" }) => Promise<{ charged: number }>;
  refundResource: (operationId: string) => Promise<{ success: boolean }>;
}

export type CallM3Fn = typeof callMiniMaxMessages;

export async function analyzeDubVideo(input: {
  userId: string; requestId: string; videoBase64: string; mime: string; durationSec: number;
  client: Anthropic; billing: AnalyzeBilling; callM3?: CallM3Fn;
}): Promise<DubAnalysis> {
  const seconds = input.durationSec > 0 ? Math.ceil(input.durationSec) : 0;
  if (seconds <= 0) throw new Error("无法获取参考视频时长");
  const callM3 = input.callM3 ?? callMiniMaxMessages;
  const operationId = `dub-analyze:${input.requestId}`;
  await input.billing.chargeResource({ operationId, userId: input.userId, resourceKey: VIDEO_ANALYZE_VIDEO_SEC_RESOURCE_KEY, units: seconds, accountType: "points" });
  try {
    return await callJsonWithRetry(
      () => callM3({
        client: input.client,
        system: ANALYZE_SYSTEM,
        blocks: [
          { type: "video", source: { type: "base64", media_type: input.mime, data: input.videoBase64 } },
          { type: "text", text: "请按 4 个板块拆解并输出 JSON。" },
        ],
        maxTokens: DUB_ANALYZE_MAX_TOKENS,
      }).then((r) => r.text),
      parseDubAnalysis,
    );
  } catch (err) {
    await input.billing.refundResource(operationId).catch(() => undefined);
    throw err;
  }
}
```

- [ ] **Step 4: 通过 + tsc + Commit**

```bash
git add apps/api/src/workflow/dub-analyze-service.ts apps/api/src/workflow/dub-analyze-service.test.ts
git commit -m "数字人口播多板块视频拆解服务"
```

---

#### Task 4: 知识库检索上下文

**Files:** Create `apps/api/src/workflow/dub-kb-context.ts` + `dub-kb-context.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect, vi } from "vitest";
import { formatKbContext, buildKbContext } from "./dub-kb-context.js";

describe("formatKbContext", () => {
  it("无命中返回 null", () => {
    expect(formatKbContext([])).toBeNull();
  });
  it("命中拼成参考资料串并截断长内容", () => {
    const s = formatKbContext([{ docName: "手册", ordinal: 1, content: "a".repeat(300) } as any]);
    expect(s).toContain("参考资料");
    expect(s).toContain("手册#1");
    expect(s).toContain("...");
  });
});

describe("buildKbContext", () => {
  it("kbIds 为空直接返回 null，不 embed 不检索", async () => {
    const embed = vi.fn(); const retrieve = vi.fn();
    const r = await buildKbContext({ prisma: {} as any, billing: {} as any, userId: "u1", kbIds: [], query: "x", embedFn: embed, retrieveFn: retrieve, resolveFn: vi.fn().mockResolvedValue([]) });
    expect(r).toBeNull();
    expect(embed).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("有有效库：embed→检索→拼串", async () => {
    const embed = vi.fn().mockResolvedValue({ vector: [1, 2, 3] });
    const retrieve = vi.fn().mockResolvedValue([{ docName: "d", ordinal: 1, content: "内容", score: 0.9 }]);
    const resolve = vi.fn().mockResolvedValue(["kb1"]);
    const r = await buildKbContext({ prisma: {} as any, billing: {} as any, userId: "u1", kbIds: ["kb1"], query: "查询", embedFn: embed, retrieveFn: retrieve, resolveFn: resolve });
    expect(embed).toHaveBeenCalled();
    expect(retrieve).toHaveBeenCalledWith(expect.anything(), ["kb1"], [1, 2, 3], expect.any(Number));
    expect(r).toContain("d#1");
  });

  it("检索抛错时降级返回 null（不阻断洗稿）", async () => {
    const embed = vi.fn().mockResolvedValue({ vector: [1] });
    const retrieve = vi.fn().mockRejectedValue(new Error("kb down"));
    const resolve = vi.fn().mockResolvedValue(["kb1"]);
    const r = await buildKbContext({ prisma: {} as any, billing: {} as any, userId: "u1", kbIds: ["kb1"], query: "q", embedFn: embed, retrieveFn: retrieve, resolveFn: resolve });
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: 运行失败**

- [ ] **Step 3: 实现**

```typescript
import type { PrismaClient } from "@yc/db";
import { loadEmbeddingConfig } from "../memory/embedding-client.js";
import { billableEmbed } from "../memory/embedding-billing.js";
import { resolveEffectiveKbIds, retrieveChunks, filterRelevantChunks, type RetrievedChunk } from "../kb/retrieve.js";

const KB_TOPK = 6;
const CONTENT_PREVIEW_CHARS = 200;

export function formatKbContext(hits: readonly RetrievedChunk[]): string | null {
  if (hits.length === 0) return null;
  const lines = hits.map((h) => {
    const preview = h.content.substring(0, CONTENT_PREVIEW_CHARS);
    return `- ${h.docName}#${h.ordinal}: ${preview}${h.content.length > CONTENT_PREVIEW_CHARS ? "..." : ""}`;
  });
  return `参考资料：\n${lines.join("\n")}`;
}

// KB 是增强项：任何一步失败都降级返回 null，绝不阻断洗稿主流程。
export async function buildKbContext(args: {
  prisma: PrismaClient;
  billing: Parameters<typeof billableEmbed>[0]["billing"];
  userId: string;
  kbIds: string[];
  query: string;
  embedFn?: typeof billableEmbed;
  retrieveFn?: typeof retrieveChunks;
  resolveFn?: typeof resolveEffectiveKbIds;
}): Promise<string | null> {
  if (!args.kbIds || args.kbIds.length === 0) return null;
  const resolve = args.resolveFn ?? resolveEffectiveKbIds;
  const embed = args.embedFn ?? billableEmbed;
  const retrieve = args.retrieveFn ?? retrieveChunks;
  try {
    const effective = await resolve(args.prisma, args.userId, { attachedKbIds: args.kbIds });
    if (effective.length === 0) return null;
    const embedded = await embed({
      billing: args.billing,
      cfg: loadEmbeddingConfig(),
      userId: args.userId,
      operationId: `dub-rewrite-embed:${args.userId}:${Date.now()}`,
      input: args.query,
    });
    const raw = await retrieve(args.prisma, effective, embedded.vector, KB_TOPK);
    return formatKbContext(filterRelevantChunks(raw, {}));
  } catch {
    return null; // 降级：KB 不可用不影响洗稿
  }
}
```

> 若 `filterRelevantChunks` 的第二参不接受空对象（必填字段），按其真实签名传阈值常量；实现前先读 `apps/api/src/kb/retrieve.ts:124` 的参数类型。

- [ ] **Step 4: 通过 + tsc + Commit**

```bash
git add apps/api/src/workflow/dub-kb-context.ts apps/api/src/workflow/dub-kb-context.test.ts
git commit -m "洗稿知识库检索上下文"
```

---

#### Task 5: 洗稿服务

**Files:** Create `apps/api/src/workflow/dub-rewrite-service.ts` + `dub-rewrite-service.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect, vi } from "vitest";
import { buildRewritePrompt, rewriteDubScript } from "./dub-rewrite-service.js";

describe("buildRewritePrompt", () => {
  it("含原文案；有亮点时注入，有 KB 时注入参考资料", () => {
    const p = buildRewritePrompt({ text: "原文", highlights: ["卖点A"], kbContext: "参考资料：\n- d#1: xx", style: "活泼" });
    expect(p).toContain("原文");
    expect(p).toContain("卖点A");
    expect(p).toContain("参考资料");
    expect(p).toContain("活泼");
  });
  it("无亮点无 KB 时不出现对应段落", () => {
    const p = buildRewritePrompt({ text: "原文" });
    expect(p).not.toContain("参考资料");
    expect(p).not.toContain("必须保留以下卖点");
  });
});

describe("rewriteDubScript", () => {
  function deps() {
    const billing = { reserve: vi.fn().mockResolvedValue({ reserved: 10 }), settle: vi.fn().mockResolvedValue({ settled: 8 }) };
    const client = { messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "洗后文案" }], usage: { input_tokens: 100, output_tokens: 50 } }) } };
    return { billing: billing as any, client: client as any };
  }

  it("reserve/settle 均按 ×3 倍率，type=dub-rewrite", async () => {
    const d = deps();
    const r = await rewriteDubScript({ userId: "u1", text: "原文", client: d.client, billing: d.billing });
    expect(r.script).toBe("洗后文案");
    expect(d.billing.reserve).toHaveBeenCalledWith(expect.objectContaining({ type: "dub-rewrite", maxOutputTokens: 3000 * 3 }));
    expect(d.billing.settle).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 300, outputTokens: 150 }));
  });

  it("空文案抛错且不预扣", async () => {
    const d = deps();
    await expect(rewriteDubScript({ userId: "u1", text: "  ", client: d.client, billing: d.billing })).rejects.toThrow(/文案/);
    expect(d.billing.reserve).not.toHaveBeenCalled();
  });

  it("模型失败：settle(0,0) 释放预扣并抛错", async () => {
    const d = deps();
    d.client.messages.create.mockRejectedValue(new Error("m3 down"));
    await expect(rewriteDubScript({ userId: "u1", text: "原文", client: d.client, billing: d.billing })).rejects.toThrow(/m3 down/);
    expect(d.billing.settle).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 0, outputTokens: 0 }));
  });

  it("模型返回空文本抛错", async () => {
    const d = deps();
    d.client.messages.create.mockResolvedValue({ content: [{ type: "text", text: "   " }], usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(rewriteDubScript({ userId: "u1", text: "原文", client: d.client, billing: d.billing })).rejects.toThrow(/为空/);
  });
});
```

- [ ] **Step 2: 运行失败**

- [ ] **Step 3: 实现**

```typescript
import type Anthropic from "@anthropic-ai/sdk";
import { M3_MODEL, M3_TIMEOUT_MS } from "./video-multimodal.js";
import { DUB_REWRITE_MAX_TOKENS, DUB_REWRITE_PRICE_MULTIPLIER, DUB_REWRITE_BILLING_TYPE } from "./dub-constants.js";

export interface RewriteBilling {
  reserve: (a: { operationId: string; userId: string; type: string; model: string; inputTokens: number; maxOutputTokens: number }) => Promise<{ reserved: number }>;
  settle: (a: { operationId: string; userId: string; model: string; inputTokens: number; outputTokens: number }) => Promise<{ settled: number }>;
}

const REWRITE_SYSTEM = [
  "你是资深短视频口播文案改写专家（俗称「洗文案」）。用户给你一段原始口播文案，请重写一遍。",
  "要求：",
  "1) 保留原文的核心信息、卖点与说服逻辑，但**换一种全新的表达方式**（措辞、句式、开场钩子、结尾 CTA 全部重写）；",
  "2) 口语化、适合口播，句子短、有节奏，不要书面语长句；",
  "3) 字数与原文相当（±20%）；",
  "4) 不要出现「改写后」「以下是」等元话语，不要 Markdown，不要标题；",
  "5) 只输出改写后的口播文案正文本身。",
].join("\n");

export interface BuildRewriteInput {
  text: string;
  highlights?: readonly string[];
  kbContext?: string | null;
  style?: string;
}

export function buildRewritePrompt(input: BuildRewriteInput): string {
  const lines = [`【原始口播文案】\n${input.text}`];
  if (input.highlights && input.highlights.length > 0) {
    lines.push(`【必须保留以下卖点】${input.highlights.join("、")}`);
  }
  if (input.kbContext) {
    lines.push(`【知识库参考资料（改写时可引用其中事实，不得编造）】\n${input.kbContext}`);
  }
  if (input.style?.trim()) lines.push(`【风格要求】${input.style.trim()}`);
  lines.push("请输出改写后的口播文案。");
  return lines.join("\n\n");
}

function estimateInputTokens(system: string, user: string): number {
  return Math.max(1, Math.ceil(`${system}\n\n${user}`.length / 3));
}

export async function rewriteDubScript(args: {
  userId: string; text: string; client: Anthropic; billing: RewriteBilling;
  highlights?: readonly string[]; kbContext?: string | null; style?: string; operationId?: string;
}): Promise<{ script: string }> {
  const text = args.text?.trim() ?? "";
  if (!text) throw new Error("原始文案不能为空");
  const system = REWRITE_SYSTEM;
  const user = buildRewritePrompt({ text, highlights: args.highlights, kbContext: args.kbContext, style: args.style });
  const operationId = args.operationId ?? `dub-rewrite:${args.userId}:${Date.now()}`;
  await args.billing.reserve({
    operationId, userId: args.userId, type: DUB_REWRITE_BILLING_TYPE, model: M3_MODEL,
    inputTokens: estimateInputTokens(system, user) * DUB_REWRITE_PRICE_MULTIPLIER,
    maxOutputTokens: DUB_REWRITE_MAX_TOKENS * DUB_REWRITE_PRICE_MULTIPLIER,
  });
  try {
    const resp = await args.client.messages.create(
      { model: M3_MODEL, max_tokens: DUB_REWRITE_MAX_TOKENS, system, messages: [{ role: "user", content: user }] },
      { timeout: M3_TIMEOUT_MS },
    );
    const script = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
    if (!script) throw new Error("洗稿结果为空");
    await args.billing.settle({
      operationId, userId: args.userId, model: M3_MODEL,
      inputTokens: (resp.usage?.input_tokens ?? 0) * DUB_REWRITE_PRICE_MULTIPLIER,
      outputTokens: (resp.usage?.output_tokens ?? 0) * DUB_REWRITE_PRICE_MULTIPLIER,
    });
    return { script };
  } catch (err) {
    await args.billing.settle({ operationId, userId: args.userId, model: M3_MODEL, inputTokens: 0, outputTokens: 0 }).catch(() => undefined);
    throw err;
  }
}
```

- [ ] **Step 4: 通过 + tsc + Commit**

```bash
git add apps/api/src/workflow/dub-rewrite-service.ts apps/api/src/workflow/dub-rewrite-service.test.ts
git commit -m "数字人口播洗稿服务（LLM×3 + KB 注入）"
```

---

#### Task 6: 分析 / 洗稿 路由

**Files:** Modify `apps/api/src/workflow/dub-routes.ts`、`dub-routes.test.ts`

- [ ] **Step 1: 顶部补 import**

```typescript
import { randomUUID } from "node:crypto";
import { getLlmClient } from "../llm-client.js"; // ← 若无此模块，用 video-routes.ts 里获取 Anthropic client 的同款方式（实现前 grep `getLlmClient` 确认真实路径）
import { analyzeDubVideo, type AnalyzeBilling } from "./dub-analyze-service.js";
import { rewriteDubScript, type RewriteBilling } from "./dub-rewrite-service.js";
import { buildKbContext } from "./dub-kb-context.js";
import { DUB_ANALYZE_VIDEO_MAX_BYTES, DUB_REWRITE_TEXT_MAX_CHARS } from "./dub-constants.js";
```

- [ ] **Step 2: 把 billing cast 加上 reserve/settle**

将
```typescript
  const billing = createBillingClient({ ... }) as unknown as AvatarBilling;
```
改为
```typescript
  const billing = createBillingClient({ baseUrl: process.env.BILLING_BASE_URL!, token: process.env.BILLING_INTERNAL_TOKEN! }) as unknown as AvatarBilling & RewriteBilling & AnalyzeBilling;
```

- [ ] **Step 3: 新增两路由（放在 tts 路由之后）**

```typescript
  app.post("/api/workflow/dub/analyze", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const file = await req.file(); if (!file) return reply.code(400).send({ error: "请选择参考视频" });
    if (!file.mimetype.startsWith("video/")) return reply.code(400).send({ error: "仅支持视频文件" });
    const buffer = Buffer.from(await file.toBuffer());
    if (buffer.byteLength > DUB_ANALYZE_VIDEO_MAX_BYTES) return reply.code(413).send({ error: "参考视频不能超过 50MB" });
    try {
      const durationSec = await probeVideoDurationSec(buffer);
      const analysis = await analyzeDubVideo({
        userId, requestId: `dub-${userId}-${randomUUID()}`,
        videoBase64: buffer.toString("base64"), mime: file.mimetype, durationSec,
        client: getLlmClient(), billing,
      });
      return { success: true, data: analysis };
    } catch (e) {
      if ((e as Error)?.name === "InsufficientBalanceError") return reply.code(402).send({ error: "算力点不足，请充值" });
      return reply.code(502).send({ error: "视频拆解失败：" + (e as Error).message });
    }
  });

  app.post("/api/workflow/dub/rewrite", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const b = (req.body ?? {}) as { text?: string; kbIds?: string[]; highlights?: string[]; style?: string; injectHighlights?: boolean };
    const text = (b.text ?? "").trim();
    if (!text) return reply.code(400).send({ error: "请输入原始文案" });
    if (text.length > DUB_REWRITE_TEXT_MAX_CHARS) return reply.code(400).send({ error: `文案不能超过 ${DUB_REWRITE_TEXT_MAX_CHARS} 字` });
    const kbIds = Array.isArray(b.kbIds) ? b.kbIds.slice(0, 50) : [];
    try {
      const kbContext = await buildKbContext({ prisma, billing, userId, kbIds, query: text });
      const highlights = b.injectHighlights && Array.isArray(b.highlights) ? b.highlights : undefined;
      const r = await rewriteDubScript({ userId, text, client: getLlmClient(), billing, highlights, kbContext, style: b.style });
      return { success: true, data: { script: r.script } };
    } catch (e) {
      if ((e as Error)?.name === "InsufficientBalanceError") return reply.code(402).send({ error: "算力点不足，请充值" });
      return reply.code(502).send({ error: "洗稿失败：" + (e as Error).message });
    }
  });
```

- [ ] **Step 4: 补路由测试（追加到 dub-routes.test.ts 的 describe 内）**

```typescript
  it("POST /analyze 非视频 400", async () => {
    const form = new FormData();
    form.set("file", new Blob(["x"], { type: "text/plain" }), "a.txt");
    const r = await app.inject({ method: "POST", url: "/api/workflow/dub/analyze", headers: { authorization: auth }, payload: form as unknown as string });
    expect([400, 415]).toContain(r.statusCode);
  });
  it("POST /rewrite 空文案 400", async () => {
    const r = await app.inject({ method: "POST", url: "/api/workflow/dub/rewrite", headers: { authorization: auth }, payload: { text: "  " } });
    expect(r.statusCode).toBe(400);
  });
  it("POST /rewrite 未登录 401", async () => {
    const r = await app.inject({ method: "POST", url: "/api/workflow/dub/rewrite", payload: { text: "x" } });
    expect(r.statusCode).toBe(401);
  });
```

> multipart 注入若不便用 FormData，可只保留 `/rewrite` 的两条测试 + `/analyze` 未登录 401 一条（用 `app.inject` 不带 authorization）。以能稳定通过为准，不为凑测试引入脆弱断言。

- [ ] **Step 5: 通过 + tsc + Commit**

Run: `DATABASE_URL='postgresql://yunclaude:yunclaude@localhost:5433/yunclaude' pnpm --filter @yc/api exec vitest run src/workflow/dub-routes.test.ts`
```bash
git add apps/api/src/workflow/dub-routes.ts apps/api/src/workflow/dub-routes.test.ts
git commit -m "数字人口播分析与洗稿路由"
```

---

#### Task 7: 账单显示口径（隐藏模型名）

**Files:** Modify `apps/web/src/pages/Billing.tsx`

- [ ] **Step 1: `usageTypeLabel` 加一行**（约 141-147 行）

```typescript
  if (row.type === "dub-rewrite") return "洗稿文案扣费";
```

- [ ] **Step 2: 隐藏模型徽标**（约 695 行）

将
```tsx
{row.type !== "video-script" && (
```
改为
```tsx
{row.type !== "video-script" && row.type !== "dub-rewrite" && (
```

- [ ] **Step 3: web 构建 + Commit**

Run: `pnpm --filter @yc/web exec tsc --noEmit && pnpm --filter @yc/web build`
```bash
git add apps/web/src/pages/Billing.tsx
git commit -m "洗稿扣费账单标签与隐藏模型名"
```

---

#### Task 8: 全量回归

- [ ] **Step 1: dub 全量**（ambient env 见 P1/P2 计划）
- [ ] **Step 2: api tsc + web/admin build**
- [ ] **Step 3: 全量 api vitest，确认失败数仍为改前的 3 个外部集成测试**

#### 部署漂移（P3 追加）

- admin 资源计价页确认 `video_analyze_video_sec` 已配价并启用（P3 分析复用它；未配价则分析报 502）。
- 洗稿走 LLM token 计价，需 `PriceRule` 有 `MiniMax-M3` 行（已有）。
- 无新增 env、无新增表。

#### Self-Review 结论

- **spec 覆盖**：spec §6 四板块（spokenScript/shotScript/structure/highlights）→ Task 3；§5 洗稿含 `attachedKbIds` + `injectHighlights` → Task 4/5/6；§7 计费（分析按秒·算力点复用 key；洗稿 ×3·算力点·隐藏模型名）→ Task 3/5/7。`DubProject` 持久化明确留 P4。
- **占位扫描**：无 TBD。Task 6 的 `getLlmClient` 与 Task 4 的 `filterRelevantChunks` 第二参标注了「实现前先 grep/读真实签名」——依赖未逐字读取的既有代码，非逻辑占位。
- **类型一致**：`AnalyzeBilling` / `RewriteBilling` / `DubAnalysis` / `buildKbContext` 返回 `string|null` 跨 Task 3-6 一致；复用 `parseLenientJson`/`callJsonWithRetry`（Task 1 导出）、`callMiniMaxMessages`、`probeVideoDurationSec`、`VIDEO_ANALYZE_VIDEO_SEC_RESOURCE_KEY`。
- **资金红线**：分析 charge 先于 M3、失败 refund、时长 0 不扣；洗稿 reserve 先于调用、成功 settle(actual×3)、失败 settle(0,0) 释放预扣、空文案不预扣；KB embedding 经 `billableEmbed` 独立计费且失败降级不阻断。

### 数字人口播 P4a：BGM + ffmpeg 叠轨 + DubProject 编排 实现计划

> 源文件：`2026-07-08-dub-p4a-bgm-project.md`


> **For agentic workers:** 逐任务实现，`- [ ]` 勾选。子代理 prompt 开头须写「跳过所有 superpowers 元技能直接实现」。

**Goal:** 把 P1–P3 串成一条可持久化的成片流水线：`DubProject` 保存向导状态（分析/文案/音频/形象/BGM）→ 一键成片（飞天音频驱动）→ 完成后用 ffmpeg 把 BGM 叠到对口型视频上 → 出成品。BGM 支持后台预制库 + 用户自行上传。

**Architecture:** 前端向导继续调 P2/P3 的**无状态**端点（analyze/rewrite/tts）拿结果，再 `PATCH` 存进 `DubProject`（YAGNI：不为每步再造一套有状态端点）。只有两件事必须后端编排：①`POST /projects/:id/generate` 建飞天任务并挂 `projectId`；②任务完成后叠 BGM——通过给 `finalizeSkyhumanTask` 注入可选 `finalizeProject` 钩子实现，使**后台轮询 / 回调 / reaper 三条路径都会触发混流**，无需重复布线。混流是本地 ffmpeg（免费、可重试），失败不退款（视频已生成并交付），置 `stage=failed` 且保留无 BGM 版本，提供 `POST /projects/:id/remix` 重试。

**Tech Stack:** TS / Prisma / Fastify multipart / ffmpeg（`spawn` + 临时文件，因混流有两路输入，stdin 只能喂一路）/ S3 / vitest。

**范围边界（P4a 不做）：** `DigitalHuman.tsx` 向导页（P4b）。

#### 文件结构

| 文件 | 职责 |
|---|---|
| `packages/db/prisma/schema.prisma`（改）| 新增 `DubProject`、`DubBgmPreset`；`SkyhumanTask` 加 `projectId` |
| `apps/api/src/workflow/dub-constants.ts`（改）| BGM 上限、混流超时、stage 枚举 |
| `apps/api/src/workflow/dub-ffmpeg.ts`（建）| `buildMixArgs`（纯函数）+ `mixBgmIntoVideo`（临时文件 spawn） |
| `apps/api/src/workflow/dub-bgm-service.ts`（建）| 预制库读取 + 用户上传 + admin CRUD 逻辑 |
| `apps/api/src/workflow/dub-project-service.ts`（建）| 项目 CRUD（userId 隔离）+ `startProjectVideo` + `finalizeProjectVideo`（混流） |
| `apps/api/src/workflow/dub-finalize.ts`（改）| 加可选 `finalizeProject` 钩子（video 完成后调用） |
| `apps/api/src/workflow/dub-routes.ts`（改）| 项目 CRUD/generate/remix、BGM 列表/上传；TTS 响应补 `objectKey` |
| `apps/api/src/admin/dub-routes.ts`（改）| BGM 预制 CRUD（`requireAdmin("KNOWLEDGE_MANAGE")`，官方素材归口） |
| `apps/api/src/server.ts`（改）| reaper 传入 `finalizeProject` 钩子 |

统一签名：
- `mixBgmIntoVideo({ videoBuffer, bgmBuffer, bgmVolume, timeoutMs? }) => Promise<Buffer>`
- `finalizeProject?: (a: { projectId: string; videoUrl: string; videoObjectKey: string }) => Promise<void>`
- stage: `draft | analyzed | scripted | voiced | generating | mixing | done | failed`

---

#### Task 1: Prisma 两表 + SkyhumanTask.projectId

**Files:** Modify `packages/db/prisma/schema.prisma`

- [ ] **Step 1: 新增两 model**

```prisma
model DubProject {
  id             String   @id @default(cuid())
  userId         String
  title          String   @default("未命名口播")
  sourceVideoUrl String?
  analysis       Json?
  script         String?
  attachedKbIds  String[] @default([])
  ttsMode        String?
  audioUrl       String?
  audioObjectKey String?
  audioDurationSec Int    @default(0)
  avatarId       String?
  bgmPresetId    String?
  bgmObjectKey   String?
  bgmVolume      Float    @default(0.3)
  resultVideoUrl String?
  resultObjectKey String?
  finalVideoUrl  String?
  finalObjectKey String?
  stage          String   @default("draft")
  error          String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  user           User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, createdAt])
  @@index([userId, stage])
}

model DubBgmPreset {
  id        String   @id @default(cuid())
  title     String
  url       String
  objectKey String
  sortOrder Int      @default(0)
  enabled   Boolean  @default(true)
  createdAt DateTime @default(now())

  @@index([enabled, sortOrder])
}
```

- [ ] **Step 2: `SkyhumanTask` 增 `projectId`**

在 `model SkyhumanTask` 内加一行（放在 `avatarId` 之后）：
```prisma
  projectId      String?
```
并在其 `@@index` 区加：
```prisma
  @@index([projectId])
```

- [ ] **Step 3: `model User` 加反向关系**

```prisma
  dubProjects   DubProject[]
```

- [ ] **Step 4: 迁移 + generate + tsc**

Run: `DATABASE_URL='postgresql://yunclaude:yunclaude@localhost:5433/yunclaude' pnpm --filter @yc/db exec prisma migrate dev --name dub_project_bgm`
Run: `pnpm --filter @yc/db exec prisma generate && pnpm --filter @yc/api exec tsc --noEmit`
Expected: 迁移含 `CREATE TABLE "DubProject"`、`CREATE TABLE "DubBgmPreset"`、`ALTER TABLE "SkyhumanTask" ADD COLUMN "projectId"`。

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations
git commit -m "新增 DubProject 与 DubBgmPreset 数据表"
```

---

#### Task 2: 常量增补

**Files:** Modify `apps/api/src/workflow/dub-constants.ts`

- [ ] **Step 1: 追加**

```typescript
// BGM 与混流
export const DUB_BGM_MAX_BYTES = 20 * 1024 * 1024; // BGM 音频 ≤20MB
export const DUB_MIX_TIMEOUT_MS = 120_000;
export const DUB_BGM_VOLUME_MIN = 0;
export const DUB_BGM_VOLUME_MAX = 1;

// 项目阶段
export const DUB_STAGE = {
  draft: "draft", analyzed: "analyzed", scripted: "scripted", voiced: "voiced",
  generating: "generating", mixing: "mixing", done: "done", failed: "failed",
} as const;
export type DubStage = (typeof DUB_STAGE)[keyof typeof DUB_STAGE];
```

- [ ] **Step 2: tsc + Commit**

```bash
git add apps/api/src/workflow/dub-constants.ts
git commit -m "BGM 混流与项目阶段常量"
```

---

#### Task 3: ffmpeg 叠轨

**Files:** Create `apps/api/src/workflow/dub-ffmpeg.ts` + `dub-ffmpeg.test.ts`

- [ ] **Step 1: 写失败测试（纯函数 + 一条受 ffmpeg 可用性保护的真实混流）**

```typescript
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { buildMixArgs, mixBgmIntoVideo, clampBgmVolume } from "./dub-ffmpeg.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe("clampBgmVolume", () => {
  it("裁剪到 [0,1]", () => {
    expect(clampBgmVolume(-1)).toBe(0);
    expect(clampBgmVolume(2)).toBe(1);
    expect(clampBgmVolume(0.3)).toBe(0.3);
  });
  it("非数字回退默认 0.3", () => {
    expect(clampBgmVolume(Number.NaN)).toBe(0.3);
  });
});

describe("buildMixArgs", () => {
  it("BGM 循环铺满、按视频音轨时长收尾、视频流直拷", () => {
    const a = buildMixArgs({ videoPath: "/v.mp4", bgmPath: "/b.mp3", outPath: "/o.mp4", bgmVolume: 0.3 });
    const s = a.join(" ");
    expect(s).toContain("-stream_loop -1");   // BGM 循环
    expect(s).toContain("volume=0.3");
    expect(s).toContain("duration=first");     // 以视频音轨为准收尾
    expect(s).toContain("-c:v copy");          // 不重编码视频
    expect(a.indexOf("-stream_loop")).toBeLessThan(a.lastIndexOf("-i")); // -stream_loop 必须在 bgm 的 -i 之前
  });
});

describe.runIf(hasFfmpeg)("mixBgmIntoVideo（真实 ffmpeg）", () => {
  it("把 BGM 叠进带音轨的视频，输出可被 ffprobe 识别", async () => {
    // 造 2s 测试素材：黑底视频+440Hz 人声轨；BGM = 1s 880Hz（会被循环）
    const mk = (args: string[]) => spawnSync("ffmpeg", ["-y", ...args]);
    const tmp = process.env.TMPDIR ?? "/tmp";
    const v = `${tmp}/dub-test-v.mp4`, b = `${tmp}/dub-test-b.mp3`;
    mk(["-f", "lavfi", "-i", "color=c=black:s=64x64:d=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-c:a", "aac", "-shortest", v]);
    mk(["-f", "lavfi", "-i", "sine=frequency=880:duration=1", b]);

    const { readFileSync } = await import("node:fs");
    const out = await mixBgmIntoVideo({ videoBuffer: readFileSync(v), bgmBuffer: readFileSync(b), bgmVolume: 0.3 });
    expect(out.byteLength).toBeGreaterThan(0);

    const { probeVideoDurationSec } = await import("./video-probe.js");
    expect(await probeVideoDurationSec(out)).toBeGreaterThan(0);
  }, 60_000);
});
```

- [ ] **Step 2: 运行失败** — `pnpm --filter @yc/api exec vitest run src/workflow/dub-ffmpeg.test.ts`

- [ ] **Step 3: 实现**

```typescript
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DUB_MIX_TIMEOUT_MS, DUB_BGM_VOLUME_MIN, DUB_BGM_VOLUME_MAX } from "./dub-constants.js";

const DEFAULT_BGM_VOLUME = 0.3;

export function clampBgmVolume(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_BGM_VOLUME;
  return Math.min(DUB_BGM_VOLUME_MAX, Math.max(DUB_BGM_VOLUME_MIN, v));
}

// BGM 用 -stream_loop -1 无限循环铺满；amix duration=first 以视频原音轨（口播人声）时长收尾；视频流直拷不重编码。
export function buildMixArgs(a: { videoPath: string; bgmPath: string; outPath: string; bgmVolume: number }): string[] {
  return [
    "-y",
    "-i", a.videoPath,
    "-stream_loop", "-1", "-i", a.bgmPath,
    "-filter_complex", `[1:a]volume=${a.bgmVolume}[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy", "-c:a", "aac", "-shortest",
    a.outPath,
  ];
}

export async function mixBgmIntoVideo(args: {
  videoBuffer: Buffer; bgmBuffer: Buffer; bgmVolume: number; timeoutMs?: number;
}): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "dub-mix-"));
  const videoPath = join(dir, `${randomUUID()}.mp4`);
  const bgmPath = join(dir, `${randomUUID()}.audio`);
  const outPath = join(dir, `${randomUUID()}-out.mp4`);
  try {
    await writeFile(videoPath, args.videoBuffer);
    await writeFile(bgmPath, args.bgmBuffer);
    await runFfmpeg(buildMixArgs({ videoPath, bgmPath, outPath, bgmVolume: clampBgmVolume(args.bgmVolume) }), args.timeoutMs ?? DUB_MIX_TIMEOUT_MS);
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runFfmpeg(argv: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => { if (settled) return; settled = true; err ? reject(err) : resolve(); };
    let child: ReturnType<typeof spawn>;
    try { child = spawn("ffmpeg", argv); } catch { done(new Error("ffmpeg 未安装")); return; }
    let stderr = "";
    child.stderr?.on("data", (c) => { stderr = (stderr + c.toString()).slice(-2000); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); done(new Error("BGM 混流超时")); }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); done(new Error("ffmpeg 未安装或无法执行")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0 ? undefined : new Error(`BGM 混流失败（ffmpeg ${code}）：${stderr.slice(-300)}`));
    });
  });
}
```

- [ ] **Step 4: 通过 + tsc + Commit**

```bash
git add apps/api/src/workflow/dub-ffmpeg.ts apps/api/src/workflow/dub-ffmpeg.test.ts
git commit -m "ffmpeg BGM 叠轨"
```

---

#### Task 4: BGM 服务（预制库 + 用户上传 + admin CRUD）

**Files:** Create `apps/api/src/workflow/dub-bgm-service.ts` + `dub-bgm-service.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect, vi } from "vitest";
import { listEnabledBgmPresets, listAllBgmPresets, createBgmPreset, updateBgmPreset, deleteBgmPreset, resolveBgmObjectKey } from "./dub-bgm-service.js";

describe("dub-bgm-service", () => {
  it("用户端只列启用的预制，按 sortOrder", async () => {
    const prisma = { dubBgmPreset: { findMany: vi.fn().mockResolvedValue([]) } } as any;
    await listEnabledBgmPresets(prisma);
    expect(prisma.dubBgmPreset.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { enabled: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    }));
  });

  it("admin 列全部（含停用）", async () => {
    const prisma = { dubBgmPreset: { findMany: vi.fn().mockResolvedValue([]) } } as any;
    await listAllBgmPresets(prisma);
    expect(prisma.dubBgmPreset.findMany.mock.calls[0][0].where).toBeUndefined();
  });

  it("createBgmPreset 落库", async () => {
    const prisma = { dubBgmPreset: { create: vi.fn().mockResolvedValue({ id: "b1" }) } } as any;
    const r = await createBgmPreset(prisma, { title: "轻快", url: "u", objectKey: "k", sortOrder: 1 });
    expect(r.id).toBe("b1");
  });

  it("deleteBgmPreset 不存在返回 false", async () => {
    const prisma = { dubBgmPreset: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) } } as any;
    expect(await deleteBgmPreset(prisma, "x")).toBe(false);
  });

  describe("resolveBgmObjectKey", () => {
    it("优先用用户上传的 objectKey", async () => {
      const prisma = { dubBgmPreset: { findUnique: vi.fn() } } as any;
      const k = await resolveBgmObjectKey(prisma, { bgmObjectKey: "user/k.mp3", bgmPresetId: "p1" });
      expect(k).toBe("user/k.mp3");
      expect(prisma.dubBgmPreset.findUnique).not.toHaveBeenCalled();
    });
    it("否则查预制；预制停用视为无 BGM", async () => {
      const prisma = { dubBgmPreset: { findUnique: vi.fn().mockResolvedValue({ objectKey: "p.mp3", enabled: false }) } } as any;
      expect(await resolveBgmObjectKey(prisma, { bgmObjectKey: null, bgmPresetId: "p1" })).toBeNull();
    });
    it("都没有返回 null", async () => {
      const prisma = { dubBgmPreset: { findUnique: vi.fn() } } as any;
      expect(await resolveBgmObjectKey(prisma, { bgmObjectKey: null, bgmPresetId: null })).toBeNull();
    });
  });
});
```

- [ ] **Step 2: 运行失败**

- [ ] **Step 3: 实现**

```typescript
import type { PrismaClient } from "@yc/db";

export async function listEnabledBgmPresets(prisma: PrismaClient) {
  return prisma.dubBgmPreset.findMany({ where: { enabled: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }] });
}

export async function listAllBgmPresets(prisma: PrismaClient) {
  return prisma.dubBgmPreset.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }] });
}

export async function createBgmPreset(prisma: PrismaClient, data: { title: string; url: string; objectKey: string; sortOrder?: number }) {
  return prisma.dubBgmPreset.create({ data: { title: data.title, url: data.url, objectKey: data.objectKey, sortOrder: data.sortOrder ?? 0 } });
}

export async function updateBgmPreset(prisma: PrismaClient, id: string, patch: { title?: string; sortOrder?: number; enabled?: boolean }): Promise<boolean> {
  const r = await prisma.dubBgmPreset.updateMany({ where: { id }, data: patch });
  return r.count > 0;
}

export async function deleteBgmPreset(prisma: PrismaClient, id: string): Promise<boolean> {
  const r = await prisma.dubBgmPreset.deleteMany({ where: { id } });
  return r.count > 0;
}

// 用户上传优先；否则用启用中的预制；预制停用/不存在 → 无 BGM。
export async function resolveBgmObjectKey(
  prisma: PrismaClient,
  sel: { bgmObjectKey: string | null; bgmPresetId: string | null },
): Promise<string | null> {
  if (sel.bgmObjectKey) return sel.bgmObjectKey;
  if (!sel.bgmPresetId) return null;
  const preset = await prisma.dubBgmPreset.findUnique({ where: { id: sel.bgmPresetId } });
  if (!preset || !preset.enabled) return null;
  return preset.objectKey;
}
```

- [ ] **Step 4: 通过 + tsc + Commit**

```bash
git add apps/api/src/workflow/dub-bgm-service.ts apps/api/src/workflow/dub-bgm-service.test.ts
git commit -m "BGM 预制库与选取服务"
```

---

#### Task 5: 项目服务（CRUD + 成片 + 混流收尾）

**Files:** Create `apps/api/src/workflow/dub-project-service.ts` + `dub-project-service.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect, vi } from "vitest";
import { listProjects, getProject, patchProject, deleteProject, finalizeProjectVideo, assertReadyForGenerate } from "./dub-project-service.js";

describe("dub-project-service 隔离", () => {
  it("listProjects 只查本人", async () => {
    const prisma = { dubProject: { findMany: vi.fn().mockResolvedValue([]) } } as any;
    await listProjects(prisma, "u1");
    expect(prisma.dubProject.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "u1" } }));
  });
  it("getProject 越权返回 null", async () => {
    const prisma = { dubProject: { findFirst: vi.fn().mockResolvedValue(null) } } as any;
    expect(await getProject(prisma, "u1", "p1")).toBeNull();
    expect(prisma.dubProject.findFirst).toHaveBeenCalledWith({ where: { id: "p1", userId: "u1" } });
  });
  it("patchProject 越权 count=0 返回 false", async () => {
    const prisma = { dubProject: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } } as any;
    expect(await patchProject(prisma, "u1", "p1", { script: "x" })).toBe(false);
  });
  it("deleteProject 按 userId 限定", async () => {
    const prisma = { dubProject: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) } } as any;
    expect(await deleteProject(prisma, "u1", "p1")).toBe(true);
    expect(prisma.dubProject.deleteMany).toHaveBeenCalledWith({ where: { id: "p1", userId: "u1" } });
  });
});

describe("assertReadyForGenerate", () => {
  it("缺音频抛错", () => {
    expect(() => assertReadyForGenerate({ audioObjectKey: null, avatarId: "a" } as any)).toThrow(/配音/);
  });
  it("缺形象抛错", () => {
    expect(() => assertReadyForGenerate({ audioObjectKey: "k", avatarId: null } as any)).toThrow(/形象/);
  });
  it("齐备不抛错", () => {
    expect(() => assertReadyForGenerate({ audioObjectKey: "k", avatarId: "a" } as any)).not.toThrow();
  });
});

describe("finalizeProjectVideo", () => {
  function deps(project: any) {
    const prisma = {
      dubProject: { findUnique: vi.fn().mockResolvedValue(project), update: vi.fn().mockResolvedValue({}) },
    } as any;
    return { prisma };
  }
  const base = { id: "p1", userId: "u1", bgmObjectKey: null, bgmPresetId: null, bgmVolume: 0.3 };

  it("无 BGM：finalVideoUrl = 原片，stage=done，不调 ffmpeg", async () => {
    const d = deps(base);
    const mix = vi.fn();
    await finalizeProjectVideo({ prisma: d.prisma, projectId: "p1", videoUrl: "https://v/1.mp4", videoObjectKey: "k",
      resolveBgmKey: vi.fn().mockResolvedValue(null), getObject: vi.fn(), storeVideoBuffer: vi.fn(), mixFn: mix });
    expect(mix).not.toHaveBeenCalled();
    expect(d.prisma.dubProject.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stage: "done", finalVideoUrl: "https://v/1.mp4" }),
    }));
  });

  it("有 BGM：下载→混流→转存→stage=done", async () => {
    const d = deps({ ...base, bgmObjectKey: "bgm/k.mp3" });
    const mix = vi.fn().mockResolvedValue(Buffer.from("mixed"));
    const store = vi.fn().mockResolvedValue({ url: "https://our/final.mp4", objectKey: "fk" });
    await finalizeProjectVideo({ prisma: d.prisma, projectId: "p1", videoUrl: "https://v/1.mp4", videoObjectKey: "k",
      resolveBgmKey: vi.fn().mockResolvedValue("bgm/k.mp3"), getObject: vi.fn().mockResolvedValue(Buffer.from("x")), storeVideoBuffer: store, mixFn: mix });
    expect(mix).toHaveBeenCalled();
    expect(d.prisma.dubProject.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stage: "done", finalVideoUrl: "https://our/final.mp4" }),
    }));
  });

  it("混流失败：stage=failed，保留无 BGM 原片可下载，不抛出", async () => {
    const d = deps({ ...base, bgmObjectKey: "bgm/k.mp3" });
    await finalizeProjectVideo({ prisma: d.prisma, projectId: "p1", videoUrl: "https://v/1.mp4", videoObjectKey: "k",
      resolveBgmKey: vi.fn().mockResolvedValue("bgm/k.mp3"), getObject: vi.fn().mockResolvedValue(Buffer.from("x")),
      storeVideoBuffer: vi.fn(), mixFn: vi.fn().mockRejectedValue(new Error("ffmpeg boom")) });
    const data = d.prisma.dubProject.update.mock.calls[0][0].data;
    expect(data.stage).toBe("failed");
    expect(data.resultVideoUrl).toBe("https://v/1.mp4");
    expect(String(data.error)).toContain("ffmpeg boom");
  });

  it("项目不存在直接返回，不更新", async () => {
    const d = deps(null);
    await finalizeProjectVideo({ prisma: d.prisma, projectId: "p1", videoUrl: "u", videoObjectKey: "k",
      resolveBgmKey: vi.fn(), getObject: vi.fn(), storeVideoBuffer: vi.fn(), mixFn: vi.fn() });
    expect(d.prisma.dubProject.update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行失败**

- [ ] **Step 3: 实现**

```typescript
import type { PrismaClient } from "@yc/db";
import { DUB_STAGE } from "./dub-constants.js";
import { resolveBgmObjectKey } from "./dub-bgm-service.js";
import { mixBgmIntoVideo } from "./dub-ffmpeg.js";

export type DubProjectRow = Awaited<ReturnType<PrismaClient["dubProject"]["findFirst"]>>;

const PATCHABLE = ["title", "sourceVideoUrl", "analysis", "script", "attachedKbIds", "ttsMode",
  "audioUrl", "audioObjectKey", "audioDurationSec", "avatarId", "bgmPresetId", "bgmObjectKey", "bgmVolume", "stage"] as const;
export type ProjectPatch = Partial<Record<(typeof PATCHABLE)[number], unknown>>;

export async function createProject(prisma: PrismaClient, userId: string, title?: string) {
  return prisma.dubProject.create({ data: { userId, title: title?.slice(0, 60) || "未命名口播" } });
}

export async function listProjects(prisma: PrismaClient, userId: string) {
  return prisma.dubProject.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 100 });
}

export async function getProject(prisma: PrismaClient, userId: string, id: string) {
  return prisma.dubProject.findFirst({ where: { id, userId } });
}

// 白名单字段 + userId 限定，防越权与字段注入
export async function patchProject(prisma: PrismaClient, userId: string, id: string, patch: ProjectPatch): Promise<boolean> {
  const data: Record<string, unknown> = {};
  for (const key of PATCHABLE) if (key in patch && patch[key] !== undefined) data[key] = patch[key];
  if (Object.keys(data).length === 0) return false;
  const r = await prisma.dubProject.updateMany({ where: { id, userId }, data });
  return r.count > 0;
}

export async function deleteProject(prisma: PrismaClient, userId: string, id: string): Promise<boolean> {
  const r = await prisma.dubProject.deleteMany({ where: { id, userId } });
  return r.count > 0;
}

export function assertReadyForGenerate(p: { audioObjectKey: string | null; avatarId: string | null }): void {
  if (!p.audioObjectKey) throw new Error("请先完成配音");
  if (!p.avatarId) throw new Error("请先选择数字人形象");
}

export interface FinalizeProjectArgs {
  prisma: PrismaClient;
  projectId: string;
  videoUrl: string;
  videoObjectKey: string;
  resolveBgmKey?: typeof resolveBgmObjectKey;
  getObject: (key: string) => Promise<Buffer>;
  storeVideoBuffer: (a: { userId: string; buffer: Buffer }) => Promise<{ url: string; objectKey: string }>;
  mixFn?: typeof mixBgmIntoVideo;
}

// 成片完成后的收尾：无 BGM 直接定稿；有 BGM 则本地混流。混流失败不抛出（视频已交付且已计费），
// 置 stage=failed 并保留无 BGM 原片供下载，可用 remix 重试。
export async function finalizeProjectVideo(args: FinalizeProjectArgs): Promise<void> {
  const project = await args.prisma.dubProject.findUnique({ where: { id: args.projectId } });
  if (!project) return;
  const resolveBgm = args.resolveBgmKey ?? resolveBgmObjectKey;
  const mix = args.mixFn ?? mixBgmIntoVideo;

  const bgmKey = await resolveBgm(args.prisma, { bgmObjectKey: project.bgmObjectKey, bgmPresetId: project.bgmPresetId });
  if (!bgmKey) {
    await args.prisma.dubProject.update({
      where: { id: project.id },
      data: { stage: DUB_STAGE.done, resultVideoUrl: args.videoUrl, resultObjectKey: args.videoObjectKey, finalVideoUrl: args.videoUrl, finalObjectKey: args.videoObjectKey, error: null },
    });
    return;
  }

  try {
    const [videoBuffer, bgmBuffer] = await Promise.all([args.getObject(args.videoObjectKey), args.getObject(bgmKey)]);
    const mixed = await mix({ videoBuffer, bgmBuffer, bgmVolume: project.bgmVolume });
    const stored = await args.storeVideoBuffer({ userId: project.userId, buffer: mixed });
    await args.prisma.dubProject.update({
      where: { id: project.id },
      data: { stage: DUB_STAGE.done, resultVideoUrl: args.videoUrl, resultObjectKey: args.videoObjectKey, finalVideoUrl: stored.url, finalObjectKey: stored.objectKey, error: null },
    });
  } catch (e) {
    await args.prisma.dubProject.update({
      where: { id: project.id },
      data: { stage: DUB_STAGE.failed, resultVideoUrl: args.videoUrl, resultObjectKey: args.videoObjectKey, error: `BGM 混流失败：${(e as Error).message}` },
    }).catch(() => undefined);
  }
}
```

- [ ] **Step 4: 通过 + tsc + Commit**

```bash
git add apps/api/src/workflow/dub-project-service.ts apps/api/src/workflow/dub-project-service.test.ts
git commit -m "数字人口播项目服务与混流收尾"
```

---

#### Task 6: finalize 注入项目收尾钩子

**Files:** Modify `apps/api/src/workflow/dub-finalize.ts` + `dub-finalize.test.ts`

- [ ] **Step 1: `FinalizeArgs` 增可选钩子**

```typescript
  finalizeProject?: (a: { projectId: string; videoUrl: string; videoObjectKey: string }) => Promise<void>;
```

- [ ] **Step 2: video_create 成功分支，标记 completed 之后调用钩子**

在 `dub-finalize.ts` 的 video 完成分支，把
```typescript
  await args.prisma.skyhumanTask.update({
    where: { id: task.id },
    data: { status: DUB_TASK_STATUS.completed, resultPayload: { videoUrl: stored.url, objectKey: stored.objectKey, duration: st.duration ?? 0, cost: st.cost ?? 0 }, completedAt: new Date(), error: null },
  });
```
改为（在其后追加钩子调用）
```typescript
  await args.prisma.skyhumanTask.update({
    where: { id: task.id },
    data: { status: DUB_TASK_STATUS.completed, resultPayload: { videoUrl: stored.url, objectKey: stored.objectKey, duration: st.duration ?? 0, cost: st.cost ?? 0 }, completedAt: new Date(), error: null },
  });
  // 属于某个项目：交给项目收尾（叠 BGM）。钩子内部自吞异常，绝不影响任务终态与计费。
  if (task.projectId && args.finalizeProject) {
    await args.finalizeProject({ projectId: task.projectId, videoUrl: stored.url, videoObjectKey: stored.objectKey }).catch(() => undefined);
  }
```

- [ ] **Step 3: 补测试（追加到 dub-finalize.test.ts）**

```typescript
  it("video 完成且任务属于项目：调用项目收尾钩子", async () => {
    const d = deps({ task: { projectId: "p1" } });
    const sky = { getVideoTask: vi.fn().mockResolvedValue({ status: "completed", videoUrl: "https://v/1.mp4", duration: 30 }), getAvatarTask: vi.fn() };
    const finalizeProject = vi.fn().mockResolvedValue(undefined);
    await finalizeSkyhumanTask({ ...d, taskId: "t1", cfg: {} as any, fetchFn: vi.fn(), sky: sky as any, storeVideo: vi.fn().mockResolvedValue({ url: "https://our/1.mp4", objectKey: "k" }), finalizeProject });
    expect(finalizeProject).toHaveBeenCalledWith({ projectId: "p1", videoUrl: "https://our/1.mp4", videoObjectKey: "k" });
  });

  it("无 projectId 时不调钩子", async () => {
    const d = deps();
    const sky = { getVideoTask: vi.fn().mockResolvedValue({ status: "completed", videoUrl: "https://v/1.mp4", duration: 30 }), getAvatarTask: vi.fn() };
    const finalizeProject = vi.fn();
    await finalizeSkyhumanTask({ ...d, taskId: "t1", cfg: {} as any, fetchFn: vi.fn(), sky: sky as any, storeVideo: vi.fn().mockResolvedValue({ url: "u", objectKey: "k" }), finalizeProject });
    expect(finalizeProject).not.toHaveBeenCalled();
  });
```

> 注：`deps()` 里 task 默认对象需补 `projectId: null`，否则第二条测试取到 `undefined` 也能过但语义不清。

- [ ] **Step 4: 通过 + tsc + Commit**

```bash
git add apps/api/src/workflow/dub-finalize.ts apps/api/src/workflow/dub-finalize.test.ts
git commit -m "飞天任务完成后触发项目 BGM 收尾"
```

---

#### Task 7: 路由（项目 CRUD/generate/remix、BGM 列表/上传）+ TTS 补 objectKey

**Files:** Modify `apps/api/src/workflow/dub-routes.ts`、`dub-routes.test.ts`；`dub-video-service.ts`（`startVideoCreate` 增 `projectId?`）

- [ ] **Step 1: `startVideoCreate` 支持 projectId**

`StartVideoCreateArgs` 增 `projectId?: string;`，并在 `prisma.skyhumanTask.create` 的 `data` 里加 `...(args.projectId ? { projectId: args.projectId } : {})`。

- [ ] **Step 2: TTS 路由响应补 `objectKey`**

把 `return { success: true, data: { audioUrl: r.audioUrl, durationSec: r.durationSec, chargedPoints: r.chargedPoints } };`
改为 `return { success: true, data: { audioUrl: r.audioUrl, objectKey: r.objectKey, durationSec: r.durationSec, chargedPoints: r.chargedPoints } };`

- [ ] **Step 3: 新增路由（`dubRoutes` 内）**

```typescript
  const storeVideoBuffer = async (a: { userId: string; buffer: Buffer }) => {
    const key = `dub/final/${a.userId}/${randomUUID()}.mp4`;
    const cfg = loadS3Config(); const s3 = makeS3(cfg);
    await putObject(s3, key, a.buffer, "video/mp4", { acl: "public-read" });
    return { url: buildAudioPublicUrl(cfg, key), objectKey: key };
  };
  const getObjectByKey = async (key: string) => getObject(makeS3(loadS3Config()), key);
  const finalizeProject = (a: { projectId: string; videoUrl: string; videoObjectKey: string }) =>
    finalizeProjectVideo({ prisma, ...a, getObject: getObjectByKey, storeVideoBuffer });

  app.get("/api/workflow/dub/bgm", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    return { success: true, data: await listEnabledBgmPresets(prisma) };
  });

  app.post("/api/workflow/dub/bgm/upload", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const file = await req.file(); if (!file) return reply.code(400).send({ error: "请选择 BGM 音频" });
    if (!file.mimetype.startsWith("audio/")) return reply.code(400).send({ error: "仅支持音频文件" });
    const buffer = Buffer.from(await file.toBuffer());
    if (buffer.byteLength > DUB_BGM_MAX_BYTES) return reply.code(413).send({ error: "BGM 不能超过 20MB" });
    const ext = file.mimetype.includes("wav") ? "wav" : "mp3";
    const stored = await storeAudioBuffer({ userId, buffer, mime: file.mimetype, ext });
    return { success: true, data: stored };
  });

  app.post("/api/workflow/dub/projects", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const title = (req.body as { title?: string } | undefined)?.title;
    return { success: true, data: await createProject(prisma, userId, title) };
  });

  app.get("/api/workflow/dub/projects", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    return { success: true, data: await listProjects(prisma, userId) };
  });

  app.get("/api/workflow/dub/projects/:id", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const p = await getProject(prisma, userId, (req.params as { id: string }).id);
    return p ? { success: true, data: p } : reply.code(404).send({ error: "项目不存在" });
  });

  app.patch("/api/workflow/dub/projects/:id", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const ok = await patchProject(prisma, userId, (req.params as { id: string }).id, (req.body ?? {}) as Record<string, unknown>);
    return ok ? { success: true } : reply.code(404).send({ error: "项目不存在或无可更新字段" });
  });

  app.delete("/api/workflow/dub/projects/:id", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const ok = await deleteProject(prisma, userId, (req.params as { id: string }).id);
    return ok ? { success: true } : reply.code(404).send({ error: "项目不存在" });
  });

  app.post("/api/workflow/dub/projects/:id/generate", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const cfg = getCfg(); if (!cfg) return reply.code(502).send({ error: "飞天未配置" });
    const projectId = (req.params as { id: string }).id;
    const project = await getProject(prisma, userId, projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    try {
      assertReadyForGenerate(project);
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    try {
      const audioBuffer = await getObjectByKey(project.audioObjectKey!);
      const task = await startVideoCreate({
        prisma, redis, billing, cfg, fetchFn, userId, projectId,
        avatarId: project.avatarId!, title: project.title,
        audioBuffer, audioMime: "audio/wav",
        probeDurationSec: probeVideoDurationSec, storeVideo, scheduleTask,
      });
      await patchProject(prisma, userId, projectId, { stage: DUB_STAGE.generating });
      return reply.code(202).send({ success: true, data: { taskId: task.id } });
    } catch (e) {
      if ((e as Error).message.includes("形象不存在")) return reply.code(403).send({ error: (e as Error).message });
      return reply.code(billingErrCode(e)).send({ error: billingErrMsg(e) });
    }
  });

  app.post("/api/workflow/dub/projects/:id/remix", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const project = await getProject(prisma, userId, (req.params as { id: string }).id);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    if (!project.resultObjectKey || !project.resultVideoUrl) return reply.code(400).send({ error: "尚无成片可混流" });
    await finalizeProject({ projectId: project.id, videoUrl: project.resultVideoUrl, videoObjectKey: project.resultObjectKey });
    return { success: true };
  });
```

顶部补 import：
```typescript
import { loadS3Config, makeS3, putObject, getObject } from "../storage/s3.js";
import { storeAudioBuffer, buildAudioPublicUrl } from "./dub-audio-store.js";
import { listEnabledBgmPresets } from "./dub-bgm-service.js";
import { createProject, listProjects, getProject, patchProject, deleteProject, assertReadyForGenerate, finalizeProjectVideo } from "./dub-project-service.js";
import { DUB_BGM_MAX_BYTES, DUB_STAGE } from "./dub-constants.js";
```
并把 `startVideoCreate` 调用处的 `scheduleTask` 内部 finalize 链路接上钩子：给 `pollFinalize` 传 `finalizeProject`（`dub-avatar-service.pollFinalize` 的入参透传到 `finalizeSkyhumanTask`）。

> **实现要点：** `pollFinalize` 需要把 `finalizeProject` 透传给 `finalizeSkyhumanTask`。给 `pollFinalize` 的参数对象加可选 `finalizeProject`，原样传下去；`startVideoCreate`/`runVideoCreate` 同样透传。

- [ ] **Step 4: 补路由测试**

```typescript
  it("GET /projects 未登录 401", async () => {
    const r = await app.inject({ method: "GET", url: "/api/workflow/dub/projects" });
    expect(r.statusCode).toBe(401);
  });
  it("项目 创建→查询→改名→删除 全链路", async () => {
    const c = await app.inject({ method: "POST", url: "/api/workflow/dub/projects", headers: { authorization: auth }, payload: { title: "测试口播" } });
    expect(c.statusCode).toBe(200);
    const id = (c.json() as { data: { id: string } }).data.id;

    const g = await app.inject({ method: "GET", url: `/api/workflow/dub/projects/${id}`, headers: { authorization: auth } });
    expect(g.statusCode).toBe(200);

    const p = await app.inject({ method: "PATCH", url: `/api/workflow/dub/projects/${id}`, headers: { authorization: auth }, payload: { script: "洗后文案" } });
    expect(p.statusCode).toBe(200);

    const d = await app.inject({ method: "DELETE", url: `/api/workflow/dub/projects/${id}`, headers: { authorization: auth } });
    expect(d.statusCode).toBe(200);
  });
  it("GET /projects/:id 不存在 404", async () => {
    const r = await app.inject({ method: "GET", url: "/api/workflow/dub/projects/nope", headers: { authorization: auth } });
    expect(r.statusCode).toBe(404);
  });
  it("generate 缺配音 400", async () => {
    const c = await app.inject({ method: "POST", url: "/api/workflow/dub/projects", headers: { authorization: auth }, payload: {} });
    const id = (c.json() as { data: { id: string } }).data.id;
    const r = await app.inject({ method: "POST", url: `/api/workflow/dub/projects/${id}/generate`, headers: { authorization: auth } });
    expect(r.statusCode).toBe(400);
    await app.inject({ method: "DELETE", url: `/api/workflow/dub/projects/${id}`, headers: { authorization: auth } });
  });
  it("GET /bgm 返回预制列表", async () => {
    const r = await app.inject({ method: "GET", url: "/api/workflow/dub/bgm", headers: { authorization: auth } });
    expect(r.statusCode).toBe(200);
  });
```

测试 `afterAll` 补清理：`await prisma.dubProject.deleteMany({ where: { userId } });`

- [ ] **Step 5: 通过 + tsc + Commit**

```bash
git add apps/api/src/workflow/dub-routes.ts apps/api/src/workflow/dub-routes.test.ts apps/api/src/workflow/dub-video-service.ts apps/api/src/workflow/dub-avatar-service.ts
git commit -m "数字人口播项目与 BGM 路由"
```

---

#### Task 8: admin BGM 预制 CRUD

**Files:** Modify `apps/api/src/admin/dub-routes.ts` + `dub-routes.test.ts`

权限用 `KNOWLEDGE_MANAGE`（官方素材归口，与官方知识库/配额包一致），不新增权限项。

- [ ] **Step 1: 新增四路由**

```typescript
  app.get("/api/admin/dub/bgm", { preHandler: requireAdmin("KNOWLEDGE_MANAGE") }, async () => {
    return { success: true, data: await listAllBgmPresets(getPrisma()) };
  });

  app.post("/api/admin/dub/bgm", { preHandler: requireAdmin("KNOWLEDGE_MANAGE") }, async (req, reply) => {
    const file = await req.file(); if (!file) return reply.code(400).send({ error: "请选择 BGM 音频" });
    if (!file.mimetype.startsWith("audio/")) return reply.code(400).send({ error: "仅支持音频文件" });
    const buffer = Buffer.from(await file.toBuffer());
    if (buffer.byteLength > DUB_BGM_MAX_BYTES) return reply.code(413).send({ error: "BGM 不能超过 20MB" });
    const q = req.query as { title?: string; sortOrder?: string };
    const ext = file.mimetype.includes("wav") ? "wav" : "mp3";
    const stored = await storeAudioBuffer({ userId: "official", buffer, mime: file.mimetype, ext });
    const row = await createBgmPreset(getPrisma(), { title: (q.title ?? "未命名").slice(0, 40), url: stored.url, objectKey: stored.objectKey, sortOrder: Number(q.sortOrder ?? 0) || 0 });
    const me = (req as unknown as { admin: { id: string } }).admin;
    await writeAudit(getPrisma(), me.id, "DUB_BGM_CREATE", { id: row.id, title: row.title });
    return { success: true, data: row };
  });

  app.patch("/api/admin/dub/bgm/:id", { preHandler: requireAdmin("KNOWLEDGE_MANAGE") }, async (req, reply) => {
    const b = (req.body ?? {}) as { title?: string; sortOrder?: number; enabled?: boolean };
    const ok = await updateBgmPreset(getPrisma(), (req.params as { id: string }).id, b);
    if (!ok) return reply.code(404).send({ error: "BGM 不存在" });
    const me = (req as unknown as { admin: { id: string } }).admin;
    await writeAudit(getPrisma(), me.id, "DUB_BGM_UPDATE", { id: (req.params as { id: string }).id, ...b });
    return { success: true };
  });

  app.delete("/api/admin/dub/bgm/:id", { preHandler: requireAdmin("KNOWLEDGE_MANAGE") }, async (req, reply) => {
    const ok = await deleteBgmPreset(getPrisma(), (req.params as { id: string }).id);
    if (!ok) return reply.code(404).send({ error: "BGM 不存在" });
    const me = (req as unknown as { admin: { id: string } }).admin;
    await writeAudit(getPrisma(), me.id, "DUB_BGM_DELETE", { id: (req.params as { id: string }).id });
    return { success: true };
  });
```

> `writeAudit` 的真实签名实现前先读 `apps/api/src/admin/audit.ts`；`getPrisma` 从 `@yc/db` import。

- [ ] **Step 2: 补 admin 测试**

```typescript
  it("无 KNOWLEDGE_MANAGE 权限 GET /api/admin/dub/bgm 403", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/dub/bgm", headers: { authorization: `Bearer ${otherAdmin}` } });
    expect(r.statusCode).toBe(403);
  });
```
（beforeAll 里新建一个带 `KNOWLEDGE_MANAGE` 的 admin，断言其 GET 得 200。）

- [ ] **Step 3: 通过 + tsc + Commit**

```bash
git add apps/api/src/admin/dub-routes.ts apps/api/src/admin/dub-routes.test.ts
git commit -m "后台 BGM 预制管理"
```

---

#### Task 9: server.ts reaper 传钩子

**Files:** Modify `apps/api/src/server.ts`

- [ ] **Step 1: 给 `startDubReaper` 传 `finalizeProject`**

reaper 的 `ReaperArgs` 透传到 `finalizeSkyhumanTask`，需在 `dub-reaper.ts` 的 `ReaperArgs` 增可选 `finalizeProject` 并在调用 `finalize(...)` 时带上；server.ts 构造与 `dubRoutes` 中同款 `finalizeProject`（`getObject`/`storeVideoBuffer` 用 S3）。

- [ ] **Step 2: tsc + 全量 dub 测试 + Commit**

```bash
git add apps/api/src/server.ts apps/api/src/workflow/dub-reaper.ts apps/api/src/workflow/dub-reaper.test.ts
git commit -m "reaper 兜底路径同样触发项目 BGM 收尾"
```

---

#### Task 10: 全量回归

- [ ] **Step 1:** dub 全量测试（ambient env 见 P1 计划），全绿。
- [ ] **Step 2:** `pnpm --filter @yc/api exec tsc --noEmit`（0 错误）+ admin/web tsc。
- [ ] **Step 3:** 全量 api vitest，确认失败集合仍是已知的 3 个外部集成 +（偶发）reseller 并行 flake，无新增。

#### 部署漂移（P4a 追加）

- 主库迁移 `dub_project_bgm`（DubProject / DubBgmPreset / SkyhumanTask.projectId）。
- api 镜像需含 `ffmpeg`（**已含**，用于 ffprobe）。
- admin 上传若干 BGM 预制并启用。
- 无新增 env。

#### Self-Review 结论

- **spec 覆盖**：spec §4 `DubProject`/`DubBgmPreset` → Task 1；§5 BGM 列表/上传/admin CRUD → Task 4/7/8；§5 成片编排 + §1 「ffmpeg 叠 BGM」→ Task 3/5/6/9。向导页明确留 P4b。
- **占位扫描**：无 TBD。Task 8 的 `writeAudit` 签名标注「实现前先读」；Task 7 的 `pollFinalize` 透传标注为实现要点——依赖既有代码细节，非逻辑占位。
- **类型一致**：`finalizeProject` 钩子签名在 Task 5/6/7/9 完全一致；`mixBgmIntoVideo` / `resolveBgmObjectKey` / `storeVideoBuffer` 返回 `{url,objectKey}` 一致；stage 全用 `DUB_STAGE` 常量。
- **资金红线**：P4a **不新增计费**。混流是本地 ffmpeg，免费；混流失败**不退款**（视频已生成并交付，费用在 P1 的 `dub_video_sec` 已按真实 duration settle），仅置 `stage=failed` 并保留无 BGM 原片 + 提供免费 `remix` 重试。generate 复用 P1 的 `startVideoCreate`（charge→失败 refund），不改计费语义。
- **越权**：项目 CRUD 全部 `where {id, userId}`；`patchProject` 用字段白名单，防客户端注入 `userId`/`finalVideoUrl` 等字段。

### 数字人口播 P4b：向导页 UI 实现计划

> 源文件：`2026-07-08-dub-p4b-wizard-ui.md`


> 逐任务实现，`- [ ]` 勾选。子代理 prompt 开头须写「跳过所有 superpowers 元技能直接实现」。

**Goal:** 用户端「数字人口播」多步向导页，串起 P1–P4a 的全部后端能力：上传/粘贴 → 4 板块分析 → 洗稿(挂 KB) → 配音(三模式+试听) → 选/建数字人形象 → 配 BGM → 成片 → 预览下载。每一步扣费前先展示预计消耗；价格未配置时该步置灰（沿用 helpwrite 交互）。

**Architecture:** 页面用 `DubProject` 持久化向导状态：进入即建项目，每步完成后 `PATCH` 存结果。分析/洗稿/配音走 P2/P3 的**无状态**端点拿结果再存；成片走 `POST /projects/:id/generate` + 轮询 `GET /projects/:id`。纯逻辑（stage 机、消耗估算、校验）抽到 `dubWizard.ts` 做 TDD；React 组件按本仓库 web 约定用 `tsc + build` 把关（无组件测试）。

**Tech Stack:** React 19 + Vite + Tailwind v3 + `@iconify/react`(mdi) + 品牌青绿 `#00b8a9`(`bg-brand`)；Shell `ViewType` 开关式导航（非 react-router）。

**范围边界：** 不做 admin 端 BGM 管理 UI（后端 API 已就绪，admin SPA 后续单独加）。

#### 文件结构

| 文件 | 职责 |
|---|---|
| `apps/api/src/workflow/dub-routes.ts`（改）| 新增 `GET /api/workflow/dub/pricing`（4 个 key 的 rate/perUnits/enabled） |
| `apps/api/src/workflow/dub-routes.test.ts`（改）| 补 pricing 路由测试 |
| `apps/web/src/dubApi.ts`（建）| 全部 dub 端点的类型 + fetch 封装 |
| `apps/web/src/dubApi.test.ts`（建）| mock fetch 单测 |
| `apps/web/src/dubWizard.ts`（建）| 纯逻辑：stage 机 / 消耗估算 / 可否进入下一步 |
| `apps/web/src/dubWizard.test.ts`（建）| TDD |
| `apps/web/src/components/dub/StepRail.tsx`（建）| 步骤条 |
| `apps/web/src/components/dub/SourcePanel.tsx`（建）| 上传参考视频（含消耗确认）/ 直接粘贴文案 |
| `apps/web/src/components/dub/AnalysisPanel.tsx`（建）| 4 板块分区展示，口播文稿可编辑 |
| `apps/web/src/components/dub/RewritePanel.tsx`（建）| KB 多选 + 亮点注入 + 风格 + 洗稿 |
| `apps/web/src/components/dub/VoicePanel.tsx`（建）| preset/design/clone 三模式 + 试听 |
| `apps/web/src/components/dub/AvatarPanel.tsx`（建）| 形象库选择 / 上传新建（轮询克隆任务） |
| `apps/web/src/components/dub/BgmPanel.tsx`（建）| 预制 / 上传 / 无 + 音量滑杆 |
| `apps/web/src/components/dub/ResultPanel.tsx`（建）| 成片进度轮询 + 预览下载 + remix |
| `apps/web/src/pages/DigitalHuman.tsx`（建）| 编排 + 项目持久化 |
| `apps/web/src/components/Shell.tsx`（改）| `ViewType` 加 `digital-human` + 导航项 |
| `apps/web/src/App.tsx`（改）| render 分支 |

---

#### Task 1: 后端 — 价格查询端点

**Files:** Modify `apps/api/src/workflow/dub-routes.ts`、`dub-routes.test.ts`

照 `video-routes.ts` 的 `/api/workflow/videos/analyze-pricing` 范式。

- [ ] **Step 1: billing cast 加 `listResourcePrices`**

在 `dub-routes.ts` 顶部加接口并并入 cast：
```typescript
interface PricingBilling {
  listResourcePrices?: () => Promise<{ data: Array<{ resourceKey: string; rate: number; perUnits: number; enabled: boolean }> }>;
}
```
`const billing = createBillingClient({...}) as unknown as AvatarBilling & RewriteBilling & AnalyzeBilling & PricingBilling;`

- [ ] **Step 2: 新增路由**

```typescript
  app.get("/api/workflow/dub/pricing", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const empty = { rate: 0, perUnits: 1, enabled: false };
    if (!billing.listResourcePrices) return { success: true, data: { analyzeVideoSec: empty, ttsChar: empty, avatarClone: empty, videoSec: empty } };
    try {
      const rows = (await billing.listResourcePrices()).data ?? [];
      const pick = (key: string) => {
        const row = rows.find((r) => r.resourceKey === key);
        return { rate: row?.rate ?? 0, perUnits: row?.perUnits && row.perUnits > 0 ? row.perUnits : 1, enabled: row?.enabled ?? false };
      };
      return { success: true, data: {
        analyzeVideoSec: pick(VIDEO_ANALYZE_VIDEO_SEC_RESOURCE_KEY),
        ttsChar: pick(DUB_TTS_CHAR_KEY),
        avatarClone: pick(DUB_AVATAR_CLONE_KEY),
        videoSec: pick(DUB_VIDEO_SEC_KEY),
      } };
    } catch (error) {
      app.log.warn({ err: error }, "load dub pricing failed");
      return reply.code(502).send({ error: "获取价格失败" });
    }
  });
```
import 补 `VIDEO_ANALYZE_VIDEO_SEC_RESOURCE_KEY`（来自 `./video-service.js`）与 `DUB_TTS_CHAR_KEY, DUB_AVATAR_CLONE_KEY, DUB_VIDEO_SEC_KEY`（来自 `./dub-constants.js`）。

- [ ] **Step 3: 测试**

```typescript
  it("GET /pricing 未登录 401", async () => {
    const r = await app.inject({ method: "GET", url: "/api/workflow/dub/pricing" });
    expect(r.statusCode).toBe(401);
  });
  it("GET /pricing 返回四项（billing mock 无 listResourcePrices 时全 disabled）", async () => {
    const r = await app.inject({ method: "GET", url: "/api/workflow/dub/pricing", headers: { authorization: auth } });
    expect(r.statusCode).toBe(200);
    const d = (r.json() as { data: Record<string, { enabled: boolean }> }).data;
    expect(Object.keys(d).sort()).toEqual(["analyzeVideoSec", "avatarClone", "ttsChar", "videoSec"]);
  });
```

- [ ] **Step 4: 通过 + tsc + Commit**

```bash
git add apps/api/src/workflow/dub-routes.ts apps/api/src/workflow/dub-routes.test.ts
git commit -m "数字人口播价格查询端点"
```

---

#### Task 2: web — dubWizard 纯逻辑（TDD）

**Files:** Create `apps/web/src/dubWizard.ts` + `dubWizard.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect } from "vitest";
import { STAGES, stageIndex, nextStage, prevStage, estimatePerUnit, estimatePerCall, canLeaveStage } from "./dubWizard";

describe("stage 机", () => {
  it("顺序固定", () => {
    expect(STAGES.map((s) => s.id)).toEqual(["source", "analysis", "rewrite", "voice", "avatar", "bgm", "result"]);
  });
  it("stageIndex / next / prev", () => {
    expect(stageIndex("voice")).toBe(3);
    expect(nextStage("voice")).toBe("avatar");
    expect(prevStage("voice")).toBe("rewrite");
    expect(nextStage("result")).toBe("result");
    expect(prevStage("source")).toBe("source");
  });
});

describe("消耗估算", () => {
  it("PER_UNIT: ceil(rate*units/perUnits)", () => {
    expect(estimatePerUnit({ rate: 1, perUnits: 1, enabled: true }, 30)).toBe(30);
    expect(estimatePerUnit({ rate: 1, perUnits: 100, enabled: true }, 250)).toBe(3);
  });
  it("PER_CALL: ceil(rate)", () => {
    expect(estimatePerCall({ rate: 99.2, perUnits: 1, enabled: true })).toBe(100);
  });
  it("未启用返回 null（前端据此置灰）", () => {
    expect(estimatePerUnit({ rate: 1, perUnits: 1, enabled: false }, 30)).toBeNull();
    expect(estimatePerCall({ rate: 1, perUnits: 1, enabled: false })).toBeNull();
  });
  it("units<=0 视为 0 点", () => {
    expect(estimatePerUnit({ rate: 1, perUnits: 1, enabled: true }, 0)).toBe(0);
  });
});

describe("canLeaveStage", () => {
  const empty = { spokenScript: "", script: "", audioObjectKey: null, avatarId: null };
  it("source 需要有文稿", () => {
    expect(canLeaveStage("source", empty)).toBe(false);
    expect(canLeaveStage("source", { ...empty, spokenScript: "你好" })).toBe(true);
  });
  it("rewrite 需要最终文案（洗稿或原稿均可）", () => {
    expect(canLeaveStage("rewrite", { ...empty, spokenScript: "原稿" })).toBe(true);
    expect(canLeaveStage("rewrite", empty)).toBe(false);
  });
  it("voice 需要音频", () => {
    expect(canLeaveStage("voice", { ...empty, script: "x" })).toBe(false);
    expect(canLeaveStage("voice", { ...empty, script: "x", audioObjectKey: "k" })).toBe(true);
  });
  it("avatar 需要选中形象", () => {
    expect(canLeaveStage("avatar", { ...empty, audioObjectKey: "k" })).toBe(false);
    expect(canLeaveStage("avatar", { ...empty, audioObjectKey: "k", avatarId: "a" })).toBe(true);
  });
  it("bgm 可选，总能继续", () => {
    expect(canLeaveStage("bgm", empty)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行失败** — `pnpm --filter @yc/web exec vitest run src/dubWizard.test.ts`

- [ ] **Step 3: 实现**

```typescript
export interface PriceRow { readonly rate: number; readonly perUnits: number; readonly enabled: boolean }

export const STAGES = [
  { id: "source", title: "素材", sub: "上传参考视频或直接写文案" },
  { id: "analysis", title: "拆解", sub: "分镜/结构/口播文稿" },
  { id: "rewrite", title: "洗稿", sub: "改写文案，可挂知识库" },
  { id: "voice", title: "配音", sub: "选音色生成口播音频" },
  { id: "avatar", title: "形象", sub: "选择或新建数字人" },
  { id: "bgm", title: "配乐", sub: "可选背景音乐" },
  { id: "result", title: "成片", sub: "对口型合成并预览" },
] as const;

export type StageId = (typeof STAGES)[number]["id"];

export function stageIndex(id: StageId): number {
  return STAGES.findIndex((s) => s.id === id);
}
export function nextStage(id: StageId): StageId {
  const i = stageIndex(id);
  return STAGES[Math.min(i + 1, STAGES.length - 1)].id;
}
export function prevStage(id: StageId): StageId {
  const i = stageIndex(id);
  return STAGES[Math.max(i - 1, 0)].id;
}

// 与后端 billing 的 PER_UNIT / PER_CALL 口径一致；未启用返回 null（调用方置灰并提示未配价）
export function estimatePerUnit(p: PriceRow, units: number): number | null {
  if (!p.enabled) return null;
  if (units <= 0) return 0;
  const per = p.perUnits > 0 ? p.perUnits : 1;
  return Math.ceil((p.rate * units) / per);
}
export function estimatePerCall(p: PriceRow): number | null {
  if (!p.enabled) return null;
  return Math.ceil(p.rate);
}

export interface WizardState {
  readonly spokenScript: string;
  readonly script: string;
  readonly audioObjectKey: string | null;
  readonly avatarId: string | null;
}

// 最终用于配音的文案：优先洗稿结果，否则原口播文稿
export function effectiveScript(s: Pick<WizardState, "spokenScript" | "script">): string {
  return (s.script || s.spokenScript).trim();
}

export function canLeaveStage(stage: StageId, s: WizardState): boolean {
  if (stage === "source" || stage === "analysis" || stage === "rewrite") return effectiveScript(s).length > 0;
  if (stage === "voice") return Boolean(s.audioObjectKey);
  if (stage === "avatar") return Boolean(s.avatarId);
  return true; // bgm 可选；result 无需离开
}
```

- [ ] **Step 4: 通过 + Commit**

```bash
git add apps/web/src/dubWizard.ts apps/web/src/dubWizard.test.ts
git commit -m "数字人口播向导纯逻辑"
```

---

#### Task 3: web — dubApi 客户端（TDD）

**Files:** Create `apps/web/src/dubApi.ts` + `dubApi.test.ts`

沿用 `videoApi.ts` 的 `ApiError` / `readErrorMessage` 风格。

- [ ] **Step 1: 写失败测试（mock global.fetch）**

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { getDubPricing, listAvatars, createProject, patchProject, generateTts, rewriteScript } from "./dubApi";

function ok(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { "content-type": "application/json" } }));
}
afterEach(() => vi.restoreAllMocks());

describe("dubApi", () => {
  it("getDubPricing 解出 data", async () => {
    vi.stubGlobal("fetch", vi.fn(() => ok({ ttsChar: { rate: 1, perUnits: 1, enabled: true } })));
    const r = await getDubPricing("t");
    expect(r.ttsChar.enabled).toBe(true);
  });

  it("listAvatars 带 Authorization", async () => {
    const f = vi.fn(() => ok([]));
    vi.stubGlobal("fetch", f);
    await listAvatars("tok");
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("createProject POST body 带 title", async () => {
    const f = vi.fn(() => ok({ id: "p1" }));
    vi.stubGlobal("fetch", f);
    const p = await createProject("t", "标题");
    expect(p.id).toBe("p1");
    expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string)).toEqual({ title: "标题" });
  });

  it("patchProject PATCH 到 /projects/:id", async () => {
    const f = vi.fn(() => ok(null));
    vi.stubGlobal("fetch", f);
    await patchProject("t", "p1", { script: "s" });
    expect(f.mock.calls[0][0]).toBe("/api/workflow/dub/projects/p1");
    expect((f.mock.calls[0][1] as RequestInit).method).toBe("PATCH");
  });

  it("非 2xx 抛 ApiError 带后端 error 文案", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: "算力点不足" }), { status: 402 }))));
    await expect(generateTts("t", { mode: "preset", text: "x", voice: "冰糖" })).rejects.toMatchObject({ name: "ApiError", status: 402, message: "算力点不足" });
  });

  it("rewriteScript 传 kbIds 与 injectHighlights", async () => {
    const f = vi.fn(() => ok({ script: "洗后" }));
    vi.stubGlobal("fetch", f);
    const s = await rewriteScript("t", { text: "原", kbIds: ["k1"], injectHighlights: true, highlights: ["卖点"] });
    expect(s).toBe("洗后");
    expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({ kbIds: ["k1"], injectHighlights: true });
  });
});
```

- [ ] **Step 2: 运行失败**

- [ ] **Step 3: 实现**（完整客户端）

```typescript
import { ApiError, readErrorMessage } from "./apiError";

export interface PriceRow { rate: number; perUnits: number; enabled: boolean }
export interface DubPricing { analyzeVideoSec: PriceRow; ttsChar: PriceRow; avatarClone: PriceRow; videoSec: PriceRow }
export interface DubAnalysis { spokenScript: string; shotScript: string; structure: string; highlights: string[] }
export interface DubAvatar { id: string; avatarCode: string; title: string; isFavorite: boolean; createdAt: string }
export interface DubBgm { id: string; title: string; url: string }
export interface DubProject {
  id: string; title: string; analysis: DubAnalysis | null; script: string | null;
  attachedKbIds: string[]; ttsMode: string | null;
  audioUrl: string | null; audioObjectKey: string | null; audioDurationSec: number;
  avatarId: string | null; bgmPresetId: string | null; bgmObjectKey: string | null; bgmVolume: number;
  resultVideoUrl: string | null; finalVideoUrl: string | null; stage: string; error: string | null;
}
export type TtsMode = "preset" | "design" | "clone";
export interface PresetVoice { id: string; label: string; lang: "zh" | "en"; gender: "male" | "female" }
export interface DubTask { id: string; kind: string; status: "running" | "completed" | "failed"; resultPayload: unknown; error: string | null }

const base = "/api/workflow/dub";
function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function unwrap<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) throw new ApiError(await readErrorMessage(res, fallback), res.status);
  const body = (await res.json()) as { data: T };
  return body.data;
}

async function getJson<T>(token: string, path: string, fallback: string): Promise<T> {
  return unwrap<T>(await fetch(`${base}${path}`, { method: "GET", headers: authHeaders(token) }), fallback);
}
async function sendJson<T>(token: string, path: string, method: string, body: unknown, fallback: string): Promise<T> {
  return unwrap<T>(await fetch(`${base}${path}`, { method, headers: { ...authHeaders(token), "content-type": "application/json" }, body: JSON.stringify(body) }), fallback);
}
async function sendForm<T>(token: string, path: string, file: File, fallback: string): Promise<T> {
  const form = new FormData();
  form.set("file", file);
  return unwrap<T>(await fetch(`${base}${path}`, { method: "POST", headers: authHeaders(token), body: form }), fallback);
}

export const getDubPricing = (t: string) => getJson<DubPricing>(t, "/pricing", "获取价格失败");
export const listPresetVoices = (t: string) => getJson<PresetVoice[]>(t, "/tts/voices", "获取音色失败");
export const listBgmPresets = (t: string) => getJson<DubBgm[]>(t, "/bgm", "获取配乐失败");
export const listAvatars = (t: string) => getJson<DubAvatar[]>(t, "/avatars", "获取形象失败");
export const getTask = (t: string, id: string) => getJson<DubTask>(t, `/tasks/${id}`, "获取任务失败");

export const createProject = (t: string, title?: string) => sendJson<DubProject>(t, "/projects", "POST", { title }, "创建项目失败");
export const getProject = (t: string, id: string) => getJson<DubProject>(t, `/projects/${id}`, "获取项目失败");
export const listProjects = (t: string) => getJson<DubProject[]>(t, "/projects", "获取项目失败");
export const patchProject = (t: string, id: string, patch: Record<string, unknown>) => sendJson<null>(t, `/projects/${id}`, "PATCH", patch, "保存失败");
export const deleteProject = (t: string, id: string) => sendJson<null>(t, `/projects/${id}`, "DELETE", {}, "删除失败");
export const generateProjectVideo = (t: string, id: string) => sendJson<{ taskId: string }>(t, `/projects/${id}/generate`, "POST", {}, "成片失败");
export const remixProject = (t: string, id: string) => sendJson<null>(t, `/projects/${id}/remix`, "POST", {}, "重新配乐失败");

export const analyzeVideo = (t: string, file: File) => sendForm<DubAnalysis>(t, "/analyze", file, "视频拆解失败");
export const uploadBgm = (t: string, file: File) => sendForm<{ url: string; objectKey: string }>(t, "/bgm/upload", file, "上传配乐失败");
export const deleteAvatar = (t: string, id: string) => sendJson<null>(t, `/avatars/${id}`, "DELETE", {}, "删除形象失败");
export const favoriteAvatar = (t: string, id: string, favorite: boolean) => sendJson<null>(t, `/avatars/${id}`, "PATCH", { favorite }, "操作失败");

export async function createAvatar(token: string, file: File, title: string): Promise<{ taskId: string }> {
  const form = new FormData();
  form.set("file", file);
  const res = await fetch(`${base}/avatars?title=${encodeURIComponent(title)}`, { method: "POST", headers: authHeaders(token), body: form });
  return unwrap<{ taskId: string }>(res, "创建数字人失败");
}

export interface RewriteInput { text: string; kbIds?: string[]; highlights?: string[]; injectHighlights?: boolean; style?: string }
export async function rewriteScript(token: string, input: RewriteInput): Promise<string> {
  const d = await sendJson<{ script: string }>(token, "/rewrite", "POST", input, "洗稿失败");
  return d.script;
}

export interface TtsInput { mode: TtsMode; text: string; format?: "wav" | "mp3"; voice?: string; description?: string; style?: string; refAudioBase64?: string; refAudioMime?: string }
export const generateTts = (t: string, input: TtsInput) =>
  sendJson<{ audioUrl: string; objectKey: string; durationSec: number; chargedPoints: number }>(t, "/tts", "POST", input, "语音合成失败");
```

- [ ] **Step 4: 通过 + Commit**

```bash
git add apps/web/src/dubApi.ts apps/web/src/dubApi.test.ts
git commit -m "数字人口播 web API 客户端"
```

---

#### Task 4: 步骤条 + 素材步 + 拆解结果步

**Files:** Create `apps/web/src/components/dub/StepRail.tsx`、`SourcePanel.tsx`、`AnalysisPanel.tsx`

要点：
- `StepRail`：照 `HelpWriteWizard` 的 `StepRail` 样式（已完成/当前/未达 三态）。
- `SourcePanel`：两种入口——①上传参考视频（拉 `getDubPricing()`，用 `estimatePerUnit(analyzeVideoSec, 预估秒数)` 展示预计消耗；`enabled=false` 时按钮置灰并提示「管理员未配置拆解价格」）；②直接粘贴文案（跳过分析，直接进洗稿）。视频 ≤50MB 前端先校验。
- `AnalysisPanel`：4 个分区卡片（口播文稿 / 分镜脚本 / 结构拆解 / 亮点卖点）；**口播文稿是 textarea 可编辑**，其余只读展示；亮点用 chip 列出。

组件 props 契约（后续任务依赖，务必一致）：
```typescript
// StepRail.tsx
export function StepRail({ active }: { active: number }): JSX.Element

// SourcePanel.tsx
export interface SourcePanelProps {
  readonly token: string;
  readonly pricing: import("../../dubApi").DubPricing | null;
  readonly busy: boolean;
  readonly onAnalyzed: (a: import("../../dubApi").DubAnalysis) => void;
  readonly onManualScript: (text: string) => void;
  readonly onErr: (msg: string) => void;
  readonly setBusy: (b: boolean) => void;
}

// AnalysisPanel.tsx
export interface AnalysisPanelProps {
  readonly analysis: import("../../dubApi").DubAnalysis;
  readonly spokenScript: string;
  readonly onSpokenScriptChange: (v: string) => void;
}
```

- [ ] **Step 1: 实现三个组件**（每个 < 160 行）
- [ ] **Step 2: `pnpm --filter @yc/web exec tsc --noEmit`（0 错误）**
- [ ] **Step 3: Commit** — `git commit -m "数字人口播向导步骤条与素材拆解面板"`

---

#### Task 5: 洗稿步 + 配音步

**Files:** Create `apps/web/src/components/dub/RewritePanel.tsx`、`VoicePanel.tsx`

- `RewritePanel`：左侧原文稿只读，右侧洗稿结果 textarea 可编辑；控件 = KB 多选（`listKb(token)`）、「注入亮点卖点」开关、风格输入；「洗稿」按钮调 `rewriteScript`。允许**跳过洗稿**（直接用原稿）。
- `VoicePanel`：三 Tab——
  - preset：`listPresetVoices()` 音色卡片（中/英分组，性别图标）
  - design：音色描述 textarea（必填）
  - clone：上传参考音频（≤10MB，`FileReader` 转 base64，去掉 `data:*;base64,` 前缀后传 `refAudioBase64` + `refAudioMime`）
  - 公共：风格输入（可选）、预计消耗 = `estimatePerUnit(ttsChar, 文案字数)`、`enabled=false` 置灰、生成后 `<audio controls src={audioUrl}>` 试听。

props 契约：
```typescript
export interface RewritePanelProps {
  readonly token: string; readonly spokenScript: string; readonly script: string;
  readonly highlights: readonly string[];
  readonly busy: boolean; readonly setBusy: (b: boolean) => void;
  readonly onScriptChange: (v: string) => void; readonly onErr: (msg: string) => void;
  readonly onKbIdsChange: (ids: string[]) => void;
}
export interface VoicePanelProps {
  readonly token: string; readonly text: string;
  readonly pricing: import("../../dubApi").DubPricing | null;
  readonly audioUrl: string | null; readonly busy: boolean; readonly setBusy: (b: boolean) => void;
  readonly onVoiced: (r: { audioUrl: string; objectKey: string; durationSec: number; mode: string }) => void;
  readonly onErr: (msg: string) => void;
}
```

- [ ] **Step 1: 实现**（每个 < 220 行）
- [ ] **Step 2: tsc 0 错误**
- [ ] **Step 3: Commit** — `git commit -m "数字人口播洗稿与配音面板"`

---

#### Task 6: 形象步 + 配乐步 + 成片步

**Files:** Create `apps/web/src/components/dub/AvatarPanel.tsx`、`BgmPanel.tsx`、`ResultPanel.tsx`

- `AvatarPanel`：`listAvatars()` 卡片网格（收藏置顶，可收藏/删除）；「新建数字人」上传无配音场景视频（≤100MB）→ `createAvatar` 返回 `taskId` → 每 3s 轮询 `getTask`，`completed` 后刷新列表并自动选中，`failed` 提示。预计消耗 = `estimatePerCall(avatarClone)`（视频点）。
- `BgmPanel`：三选一（不加配乐 / 预制库 / 上传自己的）；音量滑杆 0–1（默认 0.3）；选择即 `PATCH` 存 `bgmPresetId`/`bgmObjectKey`/`bgmVolume`。
- `ResultPanel`：显示预计消耗 = `estimatePerUnit(videoSec, audioDurationSec)`（视频点）；「开始成片」→ `generateProjectVideo` → 每 3s 轮询 `getProject`，`stage`：`generating` 转圈 / `done` 展示 `<video controls src={finalVideoUrl}>` + 下载 / `failed` 展示错误；若 `failed` 且有 `resultVideoUrl`（BGM 混流失败）→ 提供「下载无配乐版本」+「重新配乐」（`remixProject`）。

props 契约：
```typescript
export interface AvatarPanelProps {
  readonly token: string; readonly pricing: import("../../dubApi").DubPricing | null;
  readonly selectedAvatarId: string | null; readonly onSelect: (id: string) => void;
  readonly busy: boolean; readonly setBusy: (b: boolean) => void; readonly onErr: (msg: string) => void;
}
export interface BgmPanelProps {
  readonly token: string;
  readonly bgmPresetId: string | null; readonly bgmObjectKey: string | null; readonly bgmVolume: number;
  readonly onChange: (v: { bgmPresetId: string | null; bgmObjectKey: string | null; bgmVolume: number }) => void;
  readonly busy: boolean; readonly setBusy: (b: boolean) => void; readonly onErr: (msg: string) => void;
}
export interface ResultPanelProps {
  readonly token: string; readonly projectId: string;
  readonly pricing: import("../../dubApi").DubPricing | null; readonly audioDurationSec: number;
  readonly onErr: (msg: string) => void; readonly onBalanceRefresh?: () => Promise<void>;
}
```

- [ ] **Step 1: 实现**（每个 < 240 行）
- [ ] **Step 2: tsc 0 错误**
- [ ] **Step 3: Commit** — `git commit -m "数字人口播形象配乐成片面板"`

---

#### Task 7: 页面编排 + 导航接入

**Files:** Create `apps/web/src/pages/DigitalHuman.tsx`；Modify `Shell.tsx`、`App.tsx`

- `DigitalHuman.tsx`：
  - 进入即 `createProject` 建项目（或从 `listProjects` 恢复最近草稿——**v1 只建新项目，YAGNI**）。
  - 顶部 `StepRail`；底部「上一步 / 下一步」，`下一步` 由 `canLeaveStage(stage, state)` 控制 disabled。
  - 每步完成后 `patchProject` 存字段（analysis / script / attachedKbIds / ttsMode / audioUrl / audioObjectKey / audioDurationSec / avatarId / bgm*）。
  - 进入时并行拉 `getDubPricing()`。
  - 错误统一走 `useToast()`（`../motion`）。
- `Shell.tsx`：`ViewType` 加 `"digital-human"`；`NAV` 加 `{ id: "digital-human", label: "数字人口播", icon: "mdi:account-voice" }`（放在 `video` 之后）。
- `App.tsx`：`import DigitalHuman from "./pages/DigitalHuman";` + `if (view === "digital-human") return <DigitalHuman token={token} onBalanceRefresh={refreshBalance} />;`

- [ ] **Step 1: 实现**（页面 < 300 行）
- [ ] **Step 2: tsc + build**

Run: `pnpm --filter @yc/web exec tsc --noEmit && pnpm --filter @yc/web build`

- [ ] **Step 3: Commit** — `git commit -m "数字人口播向导页与导航接入"`

---

#### Task 8: 全量回归

- [ ] **Step 1:** `pnpm --filter @yc/web exec vitest run`（含新增两个纯逻辑测试文件，且 `Shell.test.tsx` 不因新增导航项而失败——若断言了导航项数量需同步更新）。
- [ ] **Step 2:** `pnpm --filter @yc/api exec vitest run src/workflow/dub-routes.test.ts` 全绿。
- [ ] **Step 3:** api / admin / web `tsc --noEmit` 均 0 错误；`pnpm --filter @yc/web build` 通过。
- [ ] **Step 4:** Commit（若有零散修正）。

#### 部署漂移（P4b 追加）

无新增表 / env。web 镜像重建即可。上线前 admin 需把 4 个计价项配好并启用（`video_analyze_video_sec`/`dub_tts_char`/`dub_avatar_clone`/`dub_video_sec`），否则对应步骤在向导里置灰。

#### Self-Review 结论

- **spec 覆盖**：spec §10 UI 要求的「多步向导 + 每步确认消耗再扣 + 4 板块分区展示 + 口播文稿可编辑 + 形象库管理 + BGM 预制/上传/音量 + 成片进度 + 预览下载」全覆盖（Task 4–7）。admin BGM 管理 UI 明确排除（后端 API 已就绪）。
- **占位扫描**：无 TBD。Task 4–6 给的是 props 契约 + 实现要点而非逐行代码——这些是样式性 React 组件，本仓库 web 约定以 `tsc + build` 把关、不写组件测试；契约已精确到类型，可直接实现。纯逻辑（stage 机/估算/校验）与 API 客户端给了完整代码 + TDD。
- **类型一致**：`DubPricing`/`PriceRow`/`DubAnalysis`/`StageId`/`WizardState` 在 Task 2/3 定义，Task 4–7 的 props 契约逐字引用；`estimatePerUnit/estimatePerCall` 返回 `number | null`（null=未配价→置灰）贯穿全部消耗展示。
- **资金红线**：前端只**展示**预估消耗，真实扣费一律在后端（P1–P3 已实现 charge/reserve→settle/refund）。前端不做任何扣费决策；未配价时置灰是 UX 兜底，后端仍会返回 502。


## 四、文件地图（P1 核心文件）

| 文件 | 职责 |
| --- | --- |
| `workflow/dub-skyhuman-client.ts` | 飞天 HTTP client：upload/avatar/video/credit |
| `workflow/dub-concurrency.ts` | Redis 并发信号量（防飞天 1001 并发上限）|
| `workflow/dub-finalize.ts` | 幂等 finalize：轮询→settle/refund→终态 |
| `workflow/dub-avatar-service.ts` | 数字人形象管理（建/列/删/收藏）|
| `workflow/dub-video-service.ts` | 音频驱动成片 |
| `workflow/dub-routes.ts` | 用户端路由 + 回调 |
| `workflow/dub-reaper.ts` | 扫 running 超期任务 → finalize 兜底 |
| `admin/dub-routes.ts` | 飞天余额查询（admin only）|

数据模型：`Avatar`（形象库，userId 隔离）、`SkyhumanTask`（异步任务追踪）、`DubProject`/`DubBgmPreset`（P4 聚合）。
