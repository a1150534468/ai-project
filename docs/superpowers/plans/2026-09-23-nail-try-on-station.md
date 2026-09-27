# 试甲台（Nail Try-On Station）执行计划

- 日期：2026-09-23
- 分支：`feat/nail-try-on-station`（已创建，不动 main）
- 状态：**待批准**（计划阶段，尚未写实现代码）

## 目标
在生图模块新增「试甲台」子标签：上传手部照片 + 美甲参考图，AI 只在指甲区域局部重绘，手部完全不变。

## 技术路线（已定）
- **引擎（不锁定，复用现有多模型基础设施）**：照 try-on/portrait 做 model 选择器，默认 `gpt-image-2`（仅测试期主用），后续可扩展其他模型。**mask 是否下发按 provider 能力决定**：只有 openai 协议（当前 gpt-image-2）支持 mask，Seedream(volcengine)/Qwen(bailian) 传 mask 会抛错（`image-service-calls.ts:117`/`:194`）。新增单一判定 `imageModelSupportsMask(model)`（= 解析到 openai 协议）；选到不支持 mask 的模型则不下发 mask、降级为整图编辑（并在 UI 标注"手部锁定不保证"）。将来接入其他支持 mask 的模型，只需扩 provider + 该判定，不改架构。
- **锁手机制**：mask 透明区=指甲=重绘，不透明区=手=原样拷回。手部像素不进 AI，比 ControlNet 更硬。不使用、也不需要 ControlNet / OpenPose / Depth / Canny。
- **美甲样式**：作为第二张 reference image 传入（等价 IP-Adapter 的效果，非其算法）。
- **蒙版获取（已定：自动 + 手动微调）**：浏览器端 MediaPipe HandLandmarker 检测 21 个手部关键点 → 指尖处生成指甲多边形 → 栅格化为初始 mask → 画布上手动增删/微调 → 定稿。

## 生成语义
- `callImageEdit({ referenceImages:[手部照片, 美甲参考], mask:指甲蒙版, ... })`。
- image[0]=手部照片（被编辑的底图），mask 对齐 image[0]；image[1]=美甲参考。
- prompt 明确「只改指甲，保持手/皮肤/光照/构图不变；按每根指甲的形状与透视贴合」。mask 是硬保证，prompt+参考图是「指甲上画什么」的尽力而为。

## 关键约束（footguns）
1. **手部照片与 mask 必须同像素尺寸**：客户端先把 EXIF 方向烘焙进像素、（可选）降采样到上限，量得最终尺寸后在该尺寸生成 mask；服务端对二者都不再重采样（手照可 JPEG，mask 必须无损 PNG，保 alpha 与硬边缘）。
2. mask 上传**不走** reference 的 JPEG-92 归一路径。
3. 输出 size 跟随所选宽高比；gpt-image-2 仅支持 1K/2K（`human-image-options.ts`）。

## 已定的两个技术决定
- **A. 不养常驻 reaper**：不复制 try-on 的 60s 常驻清理循环（少一条常驻链，合 9→4 方向）。改为**读取 state 时顺手把超时任务标 `failed`** + 客户端取消。`nail-try-on-routes.ts` 因此**不复制 reaper/定时器部分**，`server-routes.ts` **裸注册**（不传 `{ redis }`，照 ecom）。
- **B. 新建 `NailTryOn*` 三张表 + 一次迁移**（存参考图/任务/成品，一工作流一套表，与其它模块一致）。

## 文件改动清单
### 后端（新建 `apps/api/src/workflow/nail-try-on/`）
- `index.ts` — 域门面，导出 `nailTryOnWorkflowRoutes`
- `nail-try-on-routes.ts` — 镜像 `try-on-routes.ts`，前缀 `/api/workflow/nail-try-ons/*`，默认 gpt-image-2 且支持模型选择，`callImageEdit` 仅在 `imageModelSupportsMask` 为真时传 mask，手部照片无损/不重采样，mask 走 generate 内联 b64 PNG；**不复制 reaper 循环**，改在 `state` 读取时把超时任务标 `failed`
- `nail-try-on-prompts.ts` — `NAIL_TRY_ON_CONSENT_VERSION` + `buildNailTryOnPrompt`
- 复用共享模型选项（`human-image-options.ts` 模型集或通用 `IMAGE_GENERATION_MODELS`）；在 `_shared` 加 `imageModelSupportsMask(model)`。不新建"锁单模型"的选项模块

### 后端改动
- `server-routes.ts` — import + **裸注册**（不带 `{ redis }`，照 ecom；因决定 A 不含 reaper）
- `packages/db/prisma/schema.prisma` + 新迁移（依决定 B）
- blob 签名 secret 链加 `NAIL_TRY_ON_BLOB_SIGNING_SECRET` → 复用 `PORTRAIT_*` → `SESSION_SECRET`

### 前端（新建 `apps/web/src/`）
- `nailTryOnApi.ts` — 镜像 `tryOnApi.ts`
- `components/workflow/NailTryOnWorkflowStudio.tsx` — 镜像 `TryOnWorkflowStudio.tsx`（3s 轮询）+ 蒙版画布（canvas 画笔）+ MediaPipe 自动检测
- 新依赖：`@mediapipe/tasks-vision`（含一次模型文件下载）

### 前端改动
- `clientMenu.ts` — `ImageHubTabId` 加 `"nail-try-on"`；`IMAGE_HUB_TABS` 加 `{ id, label:"试甲台", menuKey:"workflow.image.nail-try-on" }`
- `pages/Workflow.tsx` — import + dispatch 分支
- `apps/api/src/admin/client-menu-catalog.ts` — 加 menuKey（必需，否则后端不认可见性键）
- `workflowState.ts:26` — 描述文案追加「试甲台」（可选）

### 端点（镜像 try-on 的 9 个注册，前缀 `nail-try-ons`）
`options` / `references`(POST) / `references/:id`(DELETE) / `references/:id/blob`(GET,HMAC) / `outputs/:id/blob`(GET,HMAC) / `state`(GET) / `generate`(POST，含 mask 内联) / `tasks/:id/cancel` / `tasks/:id`(DELETE)
- **安全**：除两个 HMAC 签名 blob 端点外全部 `requireUser`；不新增匿名接口面。
- **计费**：不建价格行（unmetered 死代码全 0），仅复制 `billingResourceKey` 记账字段保持同构。
- **consent**：手部照片=「主体」类比，沿用 `authorizationAccepted` + `NAIL_TRY_ON_CONSENT_VERSION` 门禁。

## 测试与 CI
- 镜像 4 个测试：`nail-try-on-routes.test.ts` / `nail-try-on-prompts.test.ts` / `nailTryOnApi.test.ts` / `NailTryOnWorkflowStudio.test.tsx`
- 需更新断言精确注册表的测试：`client-menu-catalog.test.ts:27`、`clientMenu.test.ts`、`Workflow.tabs`/`image-hub`/`behavior.test.tsx`
- **不动 `.github/test-baseline.json`**：`minPassed` 是下限，加测试不触发；仅新增 workspace 或新 expected-skip 才改（本次都没有）。本地 `pnpm test` 验证，不空烧 CI 分钟。

## 阶段（尽快在 5174 出真实结果）
- **P1 打通核心**：后端 generate+mask + 前端画布（手动刷）→ 上传手照、刷指甲、选样式、生成，验证「只有指甲变、手不变」。首次在 http://localhost:5174/ 真实测试。
- **P2 自动检测**：MediaPipe 预填指甲蒙版，接进 P1 画布（可手动微调）—— 即你选的最终 UX。（画布/画笔 P1 就要有，自动检测只是给它预填，故 P1 先做手动是搭地基而非砍需求。）
- **P3 收尾**：取消/删除、轮询/blob 续签、测试补齐；可选素材库接入（`asset-sources.ts` nailTryOnSource / `asset-types` union / `assetLibrary` 标签）。

## 现实校准
视频里「十分钟」是营销叙事。接进你现有鉴权/存储/任务/测试体系的完整工作流是几个专注的开发段落，不是十分钟；但核心 inpaint 当天可在 5174 验证。
