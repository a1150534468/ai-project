# 公众号排版主题库实施计划（视觉主题 = layout 约束输入）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给多平台图文工作流里的**公众号（html-fragment）链路**加「排版主题」：用户在生成前从预设主题库选一套视觉风格，并可**自定义该主题的主色**；主题作为约束注入 layout 步骤，AI 按主题的色板/字号/节奏排内联 CSS HTML。默认主题 `auto` = 今天的自由发挥，**零回归**。

**Architecture:** 不引入模板渲染引擎、不做生成后换肤。只做一条链路：主题常量（共享包）→ prompt 注入（`buildArticleWorkflowLayoutSystemPrompt`）→ 持久化（DB 加 `theme` + `themeColor` 两列）→ 前端主题选择卡片 + 主色取色器。主题只影响 layout 那一层 LLM 调用，plan / 配图 / guard / 计价全都不动。

**Tech Stack:** TypeScript + pnpm monorepo + turbo；Fastify（API）/ React 19 + Vite + Tailwind（web）；Prisma + Postgres；测试 vitest。article-workflow 测试全部 mock 驱动、不依赖 DB。

---

## 前置状态（开工前确认）

- 基线（2026-07-28 计划附录 B 实测）：article 测试 **12 files / 111 passed**（无 DB）、web 测试 **77 files / 401 passed**、`apps/api` 与 `apps/web` 各 `tsc --noEmit` clean。
- 主题注入点已定位：`apps/api/src/workflow/article-workflow-llm.ts:188` `renderArticleWorkflowBodyHtml` → `buildArticleWorkflowLayoutSystemPrompt()`（现无参）。`apps/api/src/workflow/article-workflow-runner.ts:353` 是它的唯一调用点。
- `packages/db/prisma/schema.prisma` 必须无未提交改动（Task A.3 要改它）。无关文件由项目所有者处理，执行者不得代为提交。

## 范围边界（明确不做什么）

- **不做生成后换肤**（把已生成的 bodyHtml 做颜色变量级替换）。这是 P2，依赖排版后处理，本计划只做「生成前选主题」。
- **不做 caption 平台主题**。小红书/抖音无 layout 步骤，主题不适用；`theme` 列对 caption 行存 `auto`、读路径忽略。
- **不做悬停实时试看**。生成前没有正文可试看；生成后试看依赖 P2 换肤。v1 主题卡片只做「色块 + 名称 + 选中高亮 + 主色取色」。
- **不改计费**。主题只改变 layout system prompt 的长度，`estimateArticleWorkflowReserveUnits` 按 `sourceText` 长度算，不含 prompt，reserve/settle/refund 时序零变化。
- **不改 HTML guard 规则集**。主题给的色值/字号/间距都是合法 `style` 属性，不涉及 `position/float/transform` 等被禁属性，白名单不用动。
- **不引入字体文件**。主题字号/字距只给 CSS 数值，不嵌 webfont。

## 关键设计决策（已按用户 2026-08-18 定案）

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 主题形态 | 「约束参数」注入 layout prompt，而非「CSS 模板」 | 照搬固定模板会覆盖 AI 排版能力。主题只给色板/字号/节奏的取值建议，排版结构仍由 AI 决定 |
| `auto` 兜底 | `auto` = 现状原文，非 auto 才追加风格段 | 默认值零回归；现有 111 个 article 用例断言现状 layout 行为，必须逐字保留 |
| 主题数量 | **5 套预设 + `auto`**（用户定案：4~6 套） | 极简/商务/暖阳/清新/杂志，色系差异化足够（灰/蓝/橙/绿/红） |
| 可调主色 | 每套非 auto 主题的 `palette.primary` 可被用户覆盖，覆盖值存 `themeColor` 列 | 用户定案「每套可调主色」。`themeColor` 为空 = 用主题默认主色 |
| 主题持久化 | `ArticleWorkflowProject` 加 `theme`（默认 `auto`）+ `themeColor`（可空）两列 | rewrite / retry 要用同一主题重排；跟 `platform` 的做法一致 |
| 主题定义位置 | `packages/article-workflow/src/themes.ts` | 与 `platforms.ts` 并列，前后端共用；与「内容风格」`TopicStyle` 明确区分 |
| 主题入参校验 | `theme` 对 caption-only 批次静默忽略；`themeColor` 仅在 `theme != auto` 时生效 | 跟 `resolveArticleWorkflowMode` 无声降级同一取舍 |
| prompt 注入方式 | 非 auto 时在现状约束**之后**追加主题约束；主色取 `themeColor ?? theme.palette.primary` | 现状约束一条不少，主题只追加「什么颜色/多大字号」 |

## 主题配置矩阵（Task A.1 落成常量）

| key | 展示名 | 默认主色 | 视觉定位 |
| --- | --- | --- | --- |
| `auto` | AI 自动 | — | 现状，AI 自由发挥（默认值，零回归） |
| `minimal` | 极简 | `#1d1d1f` | 黑白灰、大留白、细边框 |
| `business` | 商务 | `#185fa5` | 深蓝主色、专业、强调重点 |
| `warm` | 暖阳 | `#e08b1c` | 暖橙、亲和、生活化 |
| `fresh` | 清新 | `#1d9e75` | 浅绿、清爽、轻盈 |
| `magazine` | 杂志 | `#c0392b` | 大标题强调、节奏感强 |

每套主题完整定义结构（`themes.ts`）：

```ts
interface ArticleWorkflowTheme {
  key: ArticleWorkflowThemeKey;   // 不含 auto
  label: string;                  // 中文展示名
  description: string;            // 自然语言风格描述，注入 prompt
  palette: {
    primary: string;              // 主色（强调/标题/链接），可被 themeColor 覆盖
    secondary: string;            // 辅色（背景块/分隔）
    background: string;           // 页面底色
    text: string;                 // 正文文字色
    muted: string;                // 弱化文字色
    accentBg: string;             // 强调背景（引用块/卡片底）
  };
  typography: {
    baseFontSize: string;         // 正文字号，如 "15px"
    lineHeight: string;           // 行高，如 "1.8"
    letterSpacing: string;        // 字距，如 "0.01em"
    headingScale: string;         // 标题字号相对正文的倍数描述
  };
  rhythm: {
    sectionPadding: string;       // section 内边距
    radius: string;               // 圆角
    borderWidth: string;          // 边框
  };
}
```

## 全局验证纪律

1. **标准命令**（下文引用为「article 测试」「web 测试」「包测试」「typecheck」）：
   ```bash
   cd "/Users/z/code/ai project/apps/api" && pnpm exec vitest run src/workflow/article-workflow
   cd "/Users/z/code/ai project/apps/web" && pnpm exec vitest run rticleWorkflow
   cd "/Users/z/code/ai project/packages/article-workflow" && pnpm exec vitest run
   cd "/Users/z/code/ai project" && pnpm --filter @ai-assistant/db generate && pnpm exec turbo run typecheck --filter @ai-assistant/api --filter @ai-assistant/web --filter @ai-assistant/article-workflow
   ```
2. **用例数不得倒退**：基线 article 111 / web 401 / 包 ≥1。每轮验证确认用例数只增不减、0 失败、无 skipped。
3. **行号免责声明**：本计划行号基于 2026-08-18 工作区。执行前用函数名/符号名 grep 校验锚点，符号不匹配才是异常。
4. **迁移不用 `migrate dev`**：沿用项目既有纪律，手写迁移 + `prisma db execute` + `migrate resolve --applied`。
5. **向后兼容硬要求**：`theme` 列默认 `auto`，`themeColor` 可空；存量行不回填，读路径必须能处理未知 `theme` 值（归一化回落 `auto`）。

---

## 阶段 A：主题库落地（约 2–2.5 天）

### Task A.1: 共享包新增主题常量与配置

**Files:**
- Modify: `packages/article-workflow/src/types.ts`
- Modify: `packages/article-workflow/src/index.ts`
- Create: `packages/article-workflow/src/themes.ts`
- Create: `packages/article-workflow/src/themes.test.ts`

- [ ] **Step 1:** `types.ts` 增加 `ARTICLE_WORKFLOW_THEMES = ["auto","minimal","business","warm","fresh","magazine"] as const` 与 `export type ArticleWorkflowThemeKey = typeof ARTICLE_WORKFLOW_THEMES[number]`。
- [ ] **Step 2:** `themes.ts` 落主题矩阵：`interface ArticleWorkflowTheme`、`ARTICLE_WORKFLOW_THEME_MAP: Readonly<Record<Exclude<ArticleWorkflowThemeKey,"auto">, ArticleWorkflowTheme>>`、`articleWorkflowTheme(key)`（未知/`auto` 回落 `auto`）、`articleWorkflowThemeConfig(key)`（非 `auto` 返回主题对象，`auto` 返回 `null`）。每套主题填全 `palette/typography/rhythm`（色值见矩阵表，字号统一 `15px` 起步、行高 1.7–1.85、字距 0–0.02em）。
- [ ] **Step 3:** `themes.test.ts` 覆盖：枚举含 `auto` 且共 6 个；`articleWorkflowTheme("bogus") === "auto"`；每套非 auto 主题字段齐全且非空；`articleWorkflowThemeConfig("auto") === null`。
- [ ] **Step 4:** `index.ts` 补齐导出。跑包测试 + typecheck，包测试用例数 +≥3。
- [ ] **Step 5:** Commit `feat(article-workflow): 主题常量与配置矩阵`

### Task A.2: prompt 注入主题（含 auto 零回归）

**Files:** Modify `apps/api/src/workflow/article-workflow-prompt.ts`

- [ ] **Step 1:** `buildArticleWorkflowLayoutSystemPrompt()` 改为 `buildArticleWorkflowLayoutSystemPrompt(args: { theme?: ArticleWorkflowThemeKey; themeColor?: string })`。`theme` 缺省或 `auto` 时**逐字返回现状原文**。
- [ ] **Step 2:** 非 auto 时，在现状约束数组**末尾**追加「排版风格」约束（新函数 `articleWorkflowThemePromptHints(theme, primaryColor)`）：`theme.description`、色板逐个列出（`primary` 用 `primaryColor`）、字号/行高/字距数值，外加两条硬约束——「仍只能输出白名单标签/属性」「仍禁止 position/float/z-index/transform/filter 与固定 height」。
- [ ] **Step 3:** `llm.ts` 的 `renderArticleWorkflowBodyHtml` 先传 `theme: "auto"` 兜底跑通（完整透传在 Task A.5）。补一条 prompt 单测：`auto` 分支返回与现状原文 `toEqual`，锁死零回归。
- [ ] **Step 4:** article 测试全绿（111 个既有用例原样通过）。Commit `feat(api): 排版 prompt 按主题注入`

### Task A.3: DB 加 theme + themeColor 列

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260818000000_add_article_workflow_theme/migration.sql`

- [ ] **Step 1:** 确认 `schema.prisma` 无未提交改动。`ArticleWorkflowProject` 加两列：`theme String @default("auto")`、`themeColor String?`。
- [ ] **Step 2:** 手写迁移 SQL（**不要跑 `migrate dev`**）：
  ```sql
  -- 公众号排版主题与自定义主色：theme 默认 auto，themeColor 空 = 用主题默认主色。
  ALTER TABLE "ArticleWorkflowProject" ADD COLUMN "theme" TEXT NOT NULL DEFAULT 'auto';
  ALTER TABLE "ArticleWorkflowProject" ADD COLUMN "themeColor" TEXT;
  ```
- [ ] **Step 3:** 应用迁移并生成客户端（沿用项目 `.env` 加载 + `prisma db execute` + `migrate resolve --applied` + `generate` 流程）。
- [ ] **Step 4:** `psql` 的 `\d "ArticleWorkflowProject"` 核对两列存在。typecheck 全绿。
- [ ] **Step 5:** Commit `feat(db): ArticleWorkflowProject theme/themeColor 列`

### Task A.4: 读写层带 theme + themeColor

**Files:**
- Modify: `apps/api/src/workflow/article-workflow-shared.ts`
- Modify: `apps/api/src/workflow/article-workflow-serializer.ts`
- Modify: `apps/api/src/workflow/article-workflow-schema.ts`
- Modify: `apps/api/src/workflow/article-workflow-test-helpers.ts`

- [ ] **Step 1:** `ArticleWorkflowPersistedProject` 增 `theme: ArticleWorkflowThemeKey`、`themeColor: string | null`。
- [ ] **Step 2:** `article-workflow-schema.ts` 加 `articleWorkflowThemeSchema = z.enum(ARTICLE_WORKFLOW_THEMES)` 与 `articleWorkflowThemeColorSchema = z.string().trim().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).optional()`；`createArticleWorkflowProjectSchema` 加 `theme: articleWorkflowThemeSchema.optional().default("auto")`、`themeColor: articleWorkflowThemeColorSchema.optional()`。
- [ ] **Step 3:** `readArticleWorkflowProject` 解析 `row.theme`（归一化回落 `auto`）与 `row.themeColor`（`null` 保持 `null`）。`serializeArticleWorkflowProjectSummary` 输出 `theme`、`themeColor`。
- [ ] **Step 4:** 测试桩 `ProjectRow` 补 `theme: "auto"`、`themeColor: null`。补序列化用例：未知 `theme` 读出 `auto`、`themeColor` 透传。
- [ ] **Step 5:** article 测试 + typecheck 全绿（此步不改行为）。Commit `feat(api): 图文读写层带 theme/themeColor`

### Task A.5: 生成链路透传 theme + themeColor

**Files:**
- Modify: `apps/api/src/workflow/article-workflow-llm.ts`
- Modify: `apps/api/src/workflow/article-workflow-runner.ts`
- Modify: `apps/api/src/workflow/article-workflow-routes.ts`

- [ ] **Step 1:** `renderArticleWorkflowBodyHtml` 的 args 加 `theme`、`themeColor`，透传 `buildArticleWorkflowLayoutSystemPrompt({ theme, themeColor })`。
- [ ] **Step 2:** `materializeHtmlFragmentArticle` 加 `theme`/`themeColor` 透传（`materializeCaptionArticle` 不动）；`materializeArticleWorkflow` 透传；`runInitialArticleWorkflowGeneration` 与 `runArticleWorkflowRewrite` 的 args 加 `theme`/`themeColor`。
- [ ] **Step 3:** `routes.ts` `POST /` 的 create data 加 `theme: parsed.data.theme`、`themeColor: parsed.data.themeColor ?? null`，并传进 `runInitialArticleWorkflowGeneration`。`POST /:id/retry` 与 `/:id/rewrite` 从 `readArticleWorkflowProject(project)` 读 `theme`/`themeColor` 传进生成函数。
- [ ] **Step 4:** 补用例：create 传 `theme: "magazine"` + `themeColor` 落库且传给 runner 正确；rewrite 沿用存量 `theme`/`themeColor`；caption 平台 create 时 `theme` 被忽略/存 `auto` 不报错。
- [ ] **Step 5:** article 测试 + typecheck 全绿（111 个既有用例原样通过）。Commit `feat(api): 图文生成链路透传主题与主色`

### Task A.6: 前端主题选择 + 主色取色器

**Files:**
- Modify: `apps/web/src/workflowArticleApi.ts`
- Modify: `apps/web/src/components/workflow/useArticleWorkflowStudio.ts`
- Modify: `apps/web/src/components/workflow/ArticleWorkflowInputPanel.tsx`
- Create: `apps/web/src/components/workflow/ArticleWorkflowThemePicker.tsx`

- [ ] **Step 1:** `workflowArticleApi.ts` 的 `createArticleWorkflowProject` body 加 `theme`、`themeColor`；`ArticleWorkflowProjectSummary` 与 `ArticleWorkflowProject` 类型加 `theme`、`themeColor`。
- [ ] **Step 2:** `useArticleWorkflowStudio.ts` 加 `selectedTheme`（默认 `"auto"`）、`selectedThemeColor`（默认 `""`，空 = 用主题默认）+ `onThemeChange`/`onThemeColorChange`；`handleGenerate` 传 `theme`、`themeColor`。
- [ ] **Step 3:** `ArticleWorkflowThemePicker.tsx`：渲染主题卡片（色块用 `palette.primary` + `label`），选中高亮；选中非 auto 主题时显示主色取色器（`<input type="color">` + 预设色板，默认 = 主题 `primary`）；选 `auto` 时隐藏取色器。纯展示组件。
- [ ] **Step 4:** `ArticleWorkflowInputPanel.tsx` 在「公众号生成方式」下方加「排版主题」块，**仅当 `selectedPlatforms.includes("wechat")` 时显示**；接 `selectedTheme`/`selectedThemeColor` 及回调。
- [ ] **Step 5:** web 测试 + typecheck 全绿（新增 picker 用例：默认 auto、切换选中、非公众号平台不渲染、取色器仅在非 auto 显示）。Commit `feat(web): 公众号排版主题与主色选择`

---

## 阶段 B（预览增强，约 0.5 天）

> **已确认要做，但按用户要求：阶段 A 全部完成并复述阶段 B 内容、经确认后才开工。** 此处仅列内容供阶段 A 完成后复述，不在此次执行。

### Task B.1: 预览比例切换 + 手机样机框

**Files:** Modify `apps/web/src/components/workflow/ArticleWorkflowPreview.tsx`（+ `ArticleWorkflowEditor.tsx` 传入比例态）

- [ ] **Step 1:** `ArticleWorkflowPreview` 加 `scale` 状态（`full`/`desktop`/`mobile`）：`full` 沿用现状 `max-w-[760px]`；`desktop` 收窄约 `640px`；`mobile` 用 `375px` 宽 + 纯 CSS 圆角手机样机框（不引设备图片资源）。
- [ ] **Step 2:** 预览区顶部加比例切换（三枚 icon 按钮），caption 平台复用同一套。
- [ ] **Step 3:** web 测试 + typecheck 全绿。Commit `feat(web): 图文预览比例与手机样机框`

### Task B.2（可选，建议拆独立计划）：编辑/预览并排 + 同步滚动

- 现状是「预览 / 编辑」二选一。并排 + 同步滚动涉及双容器滚动互推与 squire-rte 高度联调，风险高于收益，不在本计划内。

---

## 里程碑与工作量

| 阶段 | 内容 | 估时 | 交付判据 |
| --- | --- | --- | --- |
| A | 主题库落地（5 套 + 可调主色） | 2–2.5 天 | 生成前可选 5 套主题并调主色，`auto` 默认零回归，article 111 / web 401 用例只增不减 |
| B | 预览增强 | 0.5 天 | 满屏/桌面/手机三比例 + 样机框（A 完成后复述确认再开工） |

## 风险与已知残留

- **AI 对色值的执行不可控**：主题给的是「建议色值」，模型可能不完全照搬。缓解：prompt 里写成「尽量使用这些值，允许 ±10% 视觉等效色」，跑几轮真实产出看服从度；若差，再评估是否给 guard 加「颜色在主题色板内」软校验（改 guard 规则集，单独立项）。
- **主色覆盖的边界**：`themeColor` 只覆盖 `palette.primary`，其余色板随主题固定。若未来要「辅色也可调」，扩展成本低（再加 `themeColor` 之外的字段或 JSON），v1 不做。
- **caption 行冗余**：小红书/抖音行存 `auto`/`null`、读路径忽略，无害。
- **`auto` 语义**：`auto` 仍让 AI 自由发挥，与今天行为完全一致，无侵入面。

## 已确认决策（2026-08-18 用户拍板）

1. **主题形态**：5 套预设 + 每套可调主色（用户定案「4~6 套 + 可调主色」）。
2. **阶段 B**：要做，但先完成阶段 A，复述阶段 B 内容、用户确认后再开工。
3. **主题色值**：采用本计划建议的色值（极简 `#1d1d1f` / 商务 `#185fa5` / 暖阳 `#e08b1c` / 清新 `#1d9e75` / 杂志 `#c0392b`）。
