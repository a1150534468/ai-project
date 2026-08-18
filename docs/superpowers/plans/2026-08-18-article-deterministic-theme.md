# 公众号确定性主题 + 画廊排版实施计划（方案 A）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把公众号（html-fragment）排版从「AI 生成式」（layout 步骤让 LLM 自由发挥内联 CSS）改成「确定性模板渲染」（对齐 md-wechat）：AI 只负责内容（标题/正文 Markdown/配图规划），排版由**确定性主题模板**渲染成内联 CSS HTML，支持**实时换肤**与**多图画廊（拼贴/网格/单列）**。选定主题 → 全文立即换肤，效果确定、可复现。

**Architecture:** 核心是「渲染器前置到共享包 + 前后端共用」。`packages/article-workflow` 加一个 `mdast → 内联 CSS HTML` 渲染器（复用已有 `remark-parse`，自写遍历渲染，主题作为渲染参数），前端与后端各用同一份渲染器：后端生成时渲染一次落库，前端拿到 `bodyMarkdown` 后本地实时换肤。layout 步骤的 LLM 调用删除。

**Tech Stack:** TypeScript + pnpm monorepo + turbo；Fastify（API）/ React 19 + Vite（web）；Prisma + Postgres；vitest。已有 `remark-parse`/`remark-gfm`/`remark-stringify`/`unified`（`packages/article-workflow`）。

---

## 前置状态（开工前确认）

- 现状链路（已定位，2026-08-18）：`apps/api/src/workflow/article-workflow-runner.ts` `materializeHtmlFragmentArticle` → `renderArticleWorkflowBodyHtml`（`llm.ts`，唯一 layout LLM 调用）→ `buildArticleWorkflowLayoutSystemPrompt`（`prompt.ts`，产内联 CSS + 空槽位 section）→ `repairArticleWorkflowHtmlFragment` + `assertArticleWorkflowHtmlFragment`（`html-guard.ts`）→ `applyArticleImageManifestToHtml`（`image-manifest.ts`，单列 slot 回填）。
- 已有能力：`packages/article-workflow/src/markdown.ts` 用 remark 解析/序列化 Markdown，含 `parseArticleWorkflowMarkdown`（返回 mdast Root）与 `articleWorkflowVisibleTextFromMarkdown`（可见文字提取），已覆盖所有节点类型的遍历。
- 主题常量：`packages/article-workflow/src/themes.ts` 已有 5 套主题的 `palette/typography/rhythm`（之前主题库落地），方案 A 要扩展成「完整渲染样式规则」。
- 基线（2026-08-18 实测）：api article 测试 **130 passed**、web 全量 **430 passed**、三包 typecheck clean、包测试 17 passed。
- `packages/db/prisma/schema.prisma` 无未提交改动；迁移沿用项目手写流程（不跑 `migrate dev`）。

## 范围边界（明确不做什么）

- **不动 caption 平台**（小红书/抖音）：它们产「标题+文案+标签+竖版配图」，无 HTML 排版，方案 A 只改公众号 html-fragment 链路。
- **不做自动发布**、不做视频内联（平台限制，后续独立立项）。
- **不改图片生成**：配图仍走既有生图服务，只改「排版/回填方式」（单列 → 画廊）。
- **不改计费**：layout 少一次 LLM 调用，reserve 按 sourceText 计价不变（少花的那次 layout token 不再产生，但 billing 资源键/时序不动）。
- **不引入 markdown-it**：复用已有 remark 生态，自写渲染器（见决策 1）。

## 关键设计决策

| 决策 | 选择 | 理由 / 被否方案 |
| --- | --- | --- |
| 渲染器选型 | 复用 `remark-parse` 解析 → 自写 `mdast → HTML` 渲染器（放 `packages/article-workflow`） | 主题内联 CSS 需要逐元素精细控制；md-wechat 也是自写 renderer。否掉「引入 markdown-it」（换掉现有 remark 链成本大）、否掉「remark-rehype 管道」（主题内联需大量 rehype 插件，不如自写直观） |
| 渲染器位置 | **共享包**，前后端共用同一份 | 实时换肤要求前端能本地渲染；同一份渲染器保证「预览所见 = 落库所得」零漂移（沿用 html-vocabulary 同源思路） |
| 主题结构 | 扩展 `themes.ts`，每套主题含**各元素的完整 CSS 规则**（heading/paragraph/list/blockquote/table/code/image/链接等），渲染器遍历时按元素读取 | 之前只有 palette/typography/rhythm 概览，方案 A 要精确到「h2 用什么字号/颜色/边距、blockquote 用什么底色/左边框」 |
| 实时换肤 | **前端本地渲染**：序列化时新增输出 `bodyMarkdown`，前端用共享渲染器 + 主题重渲 | 切换主题零网络延迟、可做悬停试看。否掉「后端重新渲染」（每次换肤一个请求，体验差，且试看几乎不可做） |
| preserve-text 校验 | 前移到 plan 阶段（对比 `bodyMarkdown` 可见文字 vs 原文），HTML 层校验**简化** | 确定性渲染不丢文字（渲染器保证可见文字 = Markdown 可见文字），无需再对 HTML 做「可见文字完全一致」硬闸 |
| HTML guard | **保留但瘦身**：删「可见文字一致」与「禁止解释性文案」两条（渲染器不产生），只保留标签/属性白名单校验（防御渲染器 bug） | 白名单仍是「编辑器 sanitize + 服务端 guard」的契约，不能删 |
| 封面 vs 画廊 | 公众号 `cover` 仍单列首图（平台头图），`inline-*` 图按画廊布局（拼贴/网格/单列） | 封面是公众号头图语义，与正文画廊分开；画廊管正文多图 |
| 画廊实现 | 拼贴用 `table`/`flex` 内联布局（禁 position/float 的白名单内），网格用同宽行，单列逐张 | 白名单禁 position/float/transform，拼贴底边齐平用 flex 或 table 实现（md-wechat 已实测公众号支持） |
| 主题数量 | 沿用 **5 套 + auto**，可加 1–2 套；每套主色可调 | 之前用户定 5 套；方案 A 主题是完整模板，套数可后扩 |

## 主题结构（阶段 2 落成，扩展 themes.ts）

```ts
interface ArticleWorkflowTheme {
  key: Exclude<ArticleWorkflowThemeKey, "auto">;
  label: string;
  palette: { primary; secondary; background; text; muted; accentBg };   // 已有
  typography: { baseFontSize; lineHeight; letterSpacing; headingScale }; // 已有
  rhythm: { sectionPadding; radius; borderWidth };                       // 已有
  // 新增：逐元素渲染规则（渲染器按 mdast 节点类型读取）
  styles: {
    h1: CssRule; h2: CssRule; h3: CssRule;          // 字号/颜色/加粗/上下边距/是否需要分隔线或底色
    paragraph: CssRule;                              // 字号/行高/段间距/首行缩进
    blockquote: CssRule;                             // 底色/左边框/内边距/文字色
    listItem: CssRule;                               // 缩进/符号样式
    table: CssRule; tableHeader: CssRule; tableCell: CssRule; // 边框/表头底色/内边距
    inlineCode: CssRule; codeBlock: CssRule;         // 底色/等宽/边框圆角
    link: CssRule;                                   // 链接色/下划线
    image: CssRule;                                  // 圆角/图注样式
    hr: CssRule;                                     // 分隔线样式
  };
}
type CssRule = Record<string, string>; // style 属性片段，渲染时拼成内联 CSS
```

`auto` 主题 = 现状行为（AI 自由排版），**保留**：当 `theme === "auto"` 时仍走原 LLM layout 链路，非 auto 走确定性渲染。这样存量 auto 项目零回归，且两条链路可并行灰度。

---

## 阶段 1：确定性渲染器（约 1–1.5 天）

**Files:** Create `packages/article-workflow/src/render.ts` + `render.test.ts`；Modify `index.ts`

- [ ] **Step 1:** `render.ts` 落 `renderArticleWorkflowHtml(args: { markdown, theme, themeColor?, galleryMode? }): string`。用 `parseArticleWorkflowMarkdown` 解析成 mdast，自写遍历：`paragraph/heading/blockquote/list(ul/ol)/listItem/table/tableRow/tableCell/code/inlineCode/strong/emphasis/delete/link/image/thematicBreak/break/text` 全部节点类型 → 输出带内联 CSS 的 HTML 片段（标签/属性严格落在 `html-vocabulary.ts` 白名单内）。
- [ ] **Step 2:** 渲染时按 `theme.styles` 逐元素拼 `style`；`themeColor` 覆盖 `palette.primary`；`galleryMode`（`collage`/`grid`/`single`）决定连续图片的拼装（阶段 3 才实现画廊，本阶段先单列）。
- [ ] **Step 3:** 图片槽位仍输出 `data-ai-assistant-image-slot` 的空 section（沿用现有 `applyArticleImageManifestToHtml` 回填契约，阶段 3 再改画廊回填）。
- [ ] **Step 4:** `render.test.ts` 覆盖：各节点类型输出正确标签+内联 CSS；主题切换产出不同 CSS；可见文字与 Markdown 一致（`articleWorkflowVisibleTextFromHtml(渲染结果) === articleWorkflowVisibleTextFromMarkdown(markdown)`）；白名单内（无 position/float/transform/fixed height/负 margin）。
- [ ] **Step 5:** 包测试 + typecheck 全绿（用例数 +≥8）。Commit `feat(article-workflow): 确定性 HTML 渲染器`

## 阶段 2：主题模板扩展（约 0.5–1 天）

**Files:** Modify `packages/article-workflow/src/themes.ts` + `themes.test.ts`

- [ ] **Step 1:** `ArticleWorkflowTheme` 加 `styles` 字段（见上方结构），5 套主题各补全 `styles`（极简/商务/暖阳/清新/杂志，每套的 heading/段落/引用/表格/代码/链接/图注逐一定制，色值沿用已有 palette）。
- [ ] **Step 2:** `themes.test.ts` 补断言：每套主题 `styles` 各节点规则齐全非空。
- [ ] **Step 3:** 包测试 + typecheck 全绿。Commit `feat(article-workflow): 主题模板扩展为完整渲染规则`

## 阶段 3：画廊布局（约 1–1.5 天）

**Files:** Create `packages/article-workflow/src/gallery.ts` + `gallery.test.ts`

- [ ] **Step 1:** `gallery.ts` 落 `renderArticleWorkflowGallery(images, mode)`：`single`（逐张）、`collage`（2 图左右、3 图一大两小、4 图一横三竖、5–6 图分块，白名单内用 flex/table 实现底边齐平）、`grid`（同宽行，1:1/4:5/3:4 裁切）。
- [ ] **Step 2:** 渲染器 `render.ts` 的图片分支接入画廊（连续 inline 图拼成画廊，cover 仍单列）。
- [ ] **Step 3:** 前端预览画廊交互（阶段 5 一起做，本阶段先出静态布局）。`gallery.test.ts` 覆盖 2/3/4/5/6 图各布局的结构与白名单合规。
- [ ] **Step 4:** 包测试 + typecheck 全绿。Commit `feat(article-workflow): 多图画廊拼贴与网格布局`

## 阶段 4：改造 layout 链路（约 1–1.5 天）

**Files:** Modify `apps/api/src/workflow/article-workflow-runner.ts`、`article-workflow-llm.ts`、`article-workflow-schema.ts`、`article-workflow-serializer.ts`、`article-workflow-shared.ts`

- [ ] **Step 1:** `MaterializedArticle` 增 `bodyMarkdown: string`（公众号填正文 markdown，caption 填空）；`commitReadyArticleProject` 落库（`ArticleWorkflowProject` 加 `bodyMarkdown` 列，阶段 4.5 迁移）。
- [ ] **Step 2:** `materializeHtmlFragmentArticle` 里：`theme === "auto"` 走原 LLM layout（逐行不动）；非 auto 走 `renderArticleWorkflowHtml({ markdown: bodyMarkdown, theme, themeColor, galleryMode })` + `applyArticleImageManifestToHtml` 回填，**不再调 `renderArticleWorkflowBodyHtml`**。
- [ ] **Step 3:** `article-workflow-llm.ts` 的 `renderArticleWorkflowBodyHtml` 与 `buildArticleWorkflowLayoutSystemPrompt` 的非 auto 分支标记为 auto-only（或移除主题注入参数，因为非 auto 已不走它）。
- [ ] **Step 4:** `serializeArticleWorkflowProject` 输出 `bodyMarkdown`（前端换肤用）。
- [ ] **Step 5:** article 测试补「非 auto 主题走确定性渲染、auto 走 LLM」分叉用例；既有 130 用例（全 auto）原样通过。Commit `feat(api): 公众号排版按主题走确定性渲染`

### Task 4.5: DB 加 bodyMarkdown 列

- [ ] **Step 1:** `ArticleWorkflowProject` 加 `bodyMarkdown String @default("")`；手写迁移 `20260818XXXXXX_add_article_body_markdown`；应用 + generate。
- [ ] **Step 2:** 读写层带 `bodyMarkdown`（shared/serializer/test-helpers）。Commit `feat(db): ArticleWorkflowProject bodyMarkdown 列`

## 阶段 5：实时换肤（前端渲染，约 1–1.5 天）

**Files:** Modify `apps/web/src/workflowArticleApi.ts`、`ArticleWorkflowEditor.tsx`、`useArticleWorkflowStudio.ts`、新建 `articleWorkflowPreview.ts`（前端渲染 hook/纯函数）

- [ ] **Step 1:** `workflowArticleApi.ts` 的 `ArticleWorkflowProject` 加 `bodyMarkdown`。
- [ ] **Step 2:** 前端引入共享渲染器（`@ai-assistant/article-workflow` 的 `renderArticleWorkflowHtml`），公众号预览改用「bodyMarkdown + 当前主题」本地渲染，替代直接 `dangerouslySetInnerHTML` bodyHtml。
- [ ] **Step 3:** 主题切换即时生效（输入面板主题卡片 + 预览联动）；悬停主题卡片**实时试看**（这次顺带做上，因为本地渲染让试看零成本）。
- [ ] **Step 4:** 保存时后端仍是 authority：前端渲染只是预览，落库仍由后端按选中主题渲染（两端同渲染器保证一致）。
- [ ] **Step 5:** web 测试 + typecheck 全绿。Commit `feat(web): 公众号预览本地实时换肤与主题试看`

## 阶段 6：preserve-text 校验前移 + guard 瘦身（约 0.5 天）

**Files:** Modify `apps/api/src/workflow/article-workflow-runner.ts`、`article-workflow-html-guard.ts`

- [ ] **Step 1:** 非 auto 确定性渲染下，preserve-text 校验前移到 plan 阶段（对比 `bodyMarkdown` 可见文字 vs 原文，已有 `bodyVisibleText !== expectedVisibleText` 逻辑）；HTML 层不再做「可见文字完全一致」。
- [ ] **Step 2:** `html-guard.ts` 的 `assertArticleWorkflowHtmlFragment` 去掉「可见文字一致」与「禁止解释性文案」，保留白名单校验；`assertArticleWorkflowBodyNotDestroyed`（保存时防毁稿）保留不动。
- [ ] **Step 3:** article 测试 + typecheck 全绿（断言可见文字校验的用例迁移到 plan 阶段语义）。Commit `feat(api): 确定性排版下校验前移与 guard 瘦身`

## 阶段 7：前端主题 UI 增强（约 0.5 天）

**Files:** Modify `ArticleWorkflowThemePicker.tsx`、`ArticleWorkflowInputPanel.tsx`

- [ ] **Step 1:** 主题卡片从「迷你色块预览」升级为「真实缩略渲染」（用主题渲染一段固定示例 Markdown 的 mini HTML）。
- [ ] **Step 2:** 主题选择加「画廊模式」开关（拼贴/网格/单列，公众号专用）。
- [ ] **Step 3:** web 测试 + typecheck 全绿。Commit `feat(web): 主题缩略试看与画廊模式选择`

---

## 里程碑与工作量

| 阶段 | 内容 | 估时 | 交付判据 |
| --- | --- | --- | --- |
| 1 | 确定性渲染器 | 1–1.5 天 | mdast → 内联 CSS HTML，主题参数化，白名单内 |
| 2 | 主题模板扩展 | 0.5–1 天 | 5 套主题补全逐元素 styles |
| 3 | 画廊布局 | 1–1.5 天 | 拼贴/网格/单列，2–6 图布局 |
| 4 | 改造 layout 链路 | 1–1.5 天 | auto 走 LLM、非 auto 走确定性渲染，分叉 |
| 5 | 实时换肤 | 1–1.5 天 | 前端本地渲染 + 悬停试看 |
| 6 | 校验前移 + guard 瘦身 | 0.5 天 | preserve-text 前移，guard 减负 |
| 7 | 前端主题 UI 增强 | 0.5 天 | 主题缩略试看 + 画廊开关 |

合计约 **5–8 天**。阶段 1–4 可先交付后端（curl 验证），5–7 依赖阶段 1 的渲染器与阶段 4 的 `bodyMarkdown` 出参。

## 风险与已知残留

- **`auto` 双链路并存**：auto 走 LLM、非 auto 走确定性渲染，两套链路并存一段时间。灰度期 auto 保持默认，确定性主题通过前端「选主题」触发，风险可控；稳定后可考虑把 auto 也改成确定性（独立决策）。
- **画廊白名单合规**：拼贴布局要在禁 position/float 的前提下实现底边齐平，需用 flex/table 实测公众号能否存活（md-wechat 已验证可行，但仍需本项目真机回归）。
- **渲染器 bug 面**：自写渲染器覆盖全部节点类型，遗漏某个节点（如深层嵌套）会丢内容。缓解：渲染器单测逐节点覆盖 + `render.test.ts` 里「可见文字 = Markdown 可见文字」的硬断言锁死不丢字。
- **bodyMarkdown 落库**：多存一份正文 Markdown，storage 略增（正文 markdown 通常 < 20KB，可接受）。
- **preserve-text 前移的等价性**：确定性渲染下 Markdown 可见文字 = HTML 可见文字，但需渲染器保证「图片 alt、代码块文字」等边界不丢，靠阶段 1 的单测锁定。

## 待确认决策（开工前拍板）

1. **主题套数**：沿用 5 套（极简/商务/暖阳/清新/杂志）+ auto，还是扩到 8–10 套（主题模板成本低，扩套数主要在设计）。
2. **画廊交互**：拖拽边界 + 自动吸附 + 双击恢复（md-wechat 全套），还是 v1 先只做「三种模式切换、不做拖拽微调」？拖拽吸附工作量大，建议 v1 只做模式切换，拖拽后续再上。
3. **auto 的去留**：方案 A 里保留 `auto`（AI 自由排版）作为默认，还是直接把「确定性主题」设为默认（auto 降级为历史兼容）？
