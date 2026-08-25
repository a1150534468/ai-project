# AI 助手 Design System

## 1. Atmosphere & Identity

轻量、克制、可维护的浅色 AI 工作台，同时提供成对的暗色主题。核心体验是把复杂 AI 能力收束进清晰的层级中，让品牌蓝只在关键交互与状态上发光。记忆管理的签名是“表格优先的信息工作台”：用高信息密度表格承载长期记忆，右侧详情负责编辑与整理。

## 2. Color

### 唯一来源

色值只在 `apps/web/src/index.css` 的 `:root` / `html[data-theme="dark"]` 里定义为 `--color-*` 的 `R G B` 三元组，
再由 `apps/web/tailwind.config.js` 暴露成语义类。组件里**只写语义类**（`text-ink`、`border-hairline`、`bg-surface`），
不写 `text-[#1d1d1f]` 这类字面色值 —— 字面色值不会跟随暗色模式切换。

三元组格式是为了让透明度写法直接可用：`text-ink/70`、`bg-danger/10`、`border-hairline/60`。
手写 CSS（`index.css` 内部、内联 style）用派生别名 `var(--apple-ink)` 等，值同源。

暗色模式的实现方式：**只翻 `html[data-theme="dark"]` 里的三元组**。P2.3 之前是另一套 ——
`index.css` 里有一份 60 多条的白名单（`html[data-theme="dark"] .bg-white { … !important }`），
靠逐个字面色值改写伪造暗色。那份白名单有两个结构性缺陷，也是这次收敛的直接动因：
`[class~="bg-white"]` 只匹配裸类名，`hover:` / `disabled:` / `group-hover:` 变体从来没被覆盖；
以及任何新写的字面色值默认就在暗色下坏掉，除非有人记得回去加一行。现在白名单已清空。

同期删掉的还有另一份补丁：`index.css` 里 40 多条 brand 工具类覆盖
（`.bg-brand`、`[class~="border-brand/20"]` …… 全带 `!important`），注释说是为了绕过 Vite 缓存里 Tailwind 的旧色值。
`tailwind.config.js` 现在直接读 `--color-*`，这份覆盖不但多余，还在偷偷改渲染结果：
`.bg-brand` 的 `!important` 压过同一元素上的 `disabled:` 变体，14 个主按钮的禁用态和可用态长得一样；
`border-brand/20`~`/70` 共 93 处被一律改写成 `0.45`，组件写的档位全部失效；`text-brand-ink/70|80` 被改成不透明。
**结论是一条规则：组件里写的档位就是最终值，不要在 `index.css` 里再加一层覆盖，更不要用 `!important` 改颜色。**

**不要新增 `dark:` 变体。** 全站 0 处 `dark:`，主题切换完全由三元组承担；
需要在暗色下换个值，就去 `html[data-theme="dark"]` 改 token，而不是在组件里写第二套类。
`index.css` 末尾剩三条手写暗色规则，都不是白名单：`input/textarea::placeholder` 与 `option`
是没有 class 可挂的原生元素；`html[data-theme="dark"] .text-brand` 是唯一一条类级换档
—— `text-brand` 当文字用时，`#0066cc` 落在暗色面上只有 2.6:1，在暗色下取 `brand-ink`。
新写代码请直接用 `text-brand-ink` 表达「品牌色的文字」，别依赖这条兜底。

### Palette

| Role | Token | Tailwind 类 | Light | Dark | Usage |
|------|-------|-------------|-------|------|-------|
| Brand | `--color-brand` | `brand` | `#0066cc` | `#0066cc` | 品牌蓝，主按钮、链接、选中态 |
| Brand/soft | `--color-brand-soft` | `brand-soft` | `#e8f3ff` | `#142c46` | 品牌弱强调底色 |
| Brand/ink | `--color-brand-ink` | `brand-ink` | `#0056b3` | `#5bafff` | 品牌色上的文字、暗色下的品牌文字 |
| Accent | `--color-accent` | `accent` | `#0066cc` | `#2997ff` | 交互强调：开关、勾选、进度；暗色下提亮 |
| Text/primary | `--color-ink` | `ink` | `#1d1d1f` | `#f5f5f7` | 标题、正文 |
| Text/secondary | `--color-ink-secondary` | `ink-secondary` | `#6e6e73` | `#c7c7cc` | 说明文案 |
| Text/tertiary | `--color-ink-tertiary` | `ink-tertiary` | `#8a8a8f` | `#aeaeb2` | 元信息、占位符 |
| Text/inverse | `--color-ink-inverse` | `ink-inverse` | `#f5f5f7` | `#1d1d1f` | 深色块上的文字 |
| Border/default | `--color-hairline` | `hairline` | `#d2d2d7` | `#424245` | 面板边框、输入框 |
| Border/subtle | `--color-hairline-subtle` | `hairline-subtle` | `#e8e8ed` | `#424245` | 分隔线、弱轮廓 |
| Surface/canvas | `--color-canvas` | `canvas` | `#f5f5f7` | `#000000` | 应用工作台底色 |
| Surface/base | `--color-surface` | `surface` | `#ffffff` | `#1d1d1f` | 卡片、侧栏、详情面板 |
| Surface/subtle | `--color-surface-subtle` | `surface-subtle` | `#f7f8fa` | `#1d1d1f` | 次级分组、节点底色 |
| Surface/muted | `--color-surface-muted` | `surface-muted` | `#f5f5f7` | `#242426` | 输入框底、禁用态、标签底 |
| Surface/raised | `--color-surface-raised` | `surface-raised` | `#fafafc` | `#2c2c2e` | 浮层、弹窗、下拉 |
| Surface/inverse | `--color-surface-inverse` | `surface-inverse` | `#1d1d1f` | `#f5f5f7` | 浅色模式下本身就深的块 |
| Danger | `--color-danger` | `danger` | `#dc2626` | `#ff453a` | 删除、错误：实底按钮、图标、状态点 |
| Danger/ink | `--color-danger-ink` | `danger-ink` | `#b91c1c` | `#ff8a80` | `bg-danger/10` 上的错误文案 |
| Warning | `--color-warning` | `warning` | `#d97706` | `#ff9f0a` | 提示、重要度、会员金色 |
| Warning/ink | `--color-warning-ink` | `warning-ink` | `#b45309` | `#ffc46b` | `bg-warning/10` 上的提示文案 |
| Info | `--color-info` | `info` | `#2563eb` | `#0a84ff` | 进行中、辅助状态 |
| Info/ink | `--color-info-ink` | `info-ink` | `#1d4ed8` | `#7ab8ff` | `bg-info/10` 上的状态文案 |
| Success | `--color-success` | `success` | `#16a34a` | `#30d158` | 完成、成功反馈 |
| Success/ink | `--color-success-ink` | `success-ink` | `#15803d` | `#6ee7a0` | `bg-success/10` 上的完成文案 |
| Scrim | `--color-scrim` | `scrim` | `#101615` | 同浅色 | 压暗层：模态/抽屉遮罩 `bg-scrim/20`~`/30`，图片上的角标 `bg-scrim/55`~`/70` |
| Console | `--color-console` | `console` | `#111418` | 同浅色 | 固定深色面板：流式输出、脚本预览、视频信箱底 |
| Console/ink | `--color-console-ink` | `console-ink` | `#d7e0e8` | 同浅色 | 深色面板上的字与描边（`/70` 次要、`/15` 描边） |

`scrim` / `console` / `console-ink` 是三个**故意不随主题翻转**的角色，所以暗色块里不重新声明：
遮罩的职责是压暗背后内容，两种模式下都该压暗；控制台面板是一套自洽的深色配色，翻成浅色就不是控制台了。
反过来说，**深色块只要内容会跟着主题翻，就不能用它们** —— 那种块用 `surface-inverse` + `ink-inverse`。

已知的两处暗色扁平化，是既有行为不是遗漏：`hairline` 与 `hairline-subtle`、`surface` 与 `surface-subtle`
在暗色下取同值。要让它们在暗色下也分层属于独立的设计改动。

### 状态色的三件套

每个状态色都是 `X` / `X/10` / `X-ink` 三件套，和 `brand` / `brand-soft` / `brand-ink` 同一套路：

| 用途 | 写法 | 例 |
|------|------|----|
| 实底、图标、状态点 | `X` | `bg-danger`、`text-warning`（会员星标） |
| 弱底色 | `X/10`（更强用 `/15`，更弱用 `/5`） | `bg-danger/10`、`bg-warning/15` |
| 描边 | `X/20`~`X/30` | `border-danger/30`、`ring-danger/20` |
| 弱底上的文字 | `X-ink` | `bg-warning/10 text-warning-ink` |

**不要用 `X` 当弱底上的文字**：`text-warning` 落在 `bg-warning/10` 上只有 2.9:1，`text-danger` 是 4.1:1，都过不了 AA；
换成 `-ink` 分别是 4.9:1 / 6.0:1。反过来，`X-ink` 当实底也别用 —— 实底上是白字，用 `X` 才够亮。

浅色值刻意对齐 Tailwind 调色板：`X` = 600 档、`X-ink` = 700 档。所以历史代码里
`text-red-600`→`text-danger`、`text-red-700`→`text-danger-ink` 这类替换在浅色模式下是零漂移的。

### 状态色归并对照

| 归并到 | 旧调色板类 |
|--------|-----------|
| `danger` / `danger-ink` | `red-50` `red-100` `red-200` `red-300` `red-400` `red-500` `red-600` `red-700` `red-800` `rose-*` |
| `warning` / `warning-ink` | `amber-50` `amber-100` `amber-200` `amber-500` `amber-600` `amber-700` `amber-800` `amber-900` `yellow-50` `yellow-600` `orange-50` `orange-700` |
| `info` / `info-ink` | `blue-50` `blue-100` `blue-200` `blue-600` `blue-700` `blue-800` `sky-100` `sky-700`（非记忆类型色的那些） |
| `success` / `success-ink` | `emerald-50` `emerald-700` |
| `ink` / `ink-secondary` / `ink-tertiary` | `gray-300`~`gray-900`、`slate-400`~`slate-900`（非记忆类型色的那些） |
| `hairline` / `hairline-subtle` | `gray-50`~`gray-300`、`slate-200` `slate-300`（作 border 用时） |
| `surface-subtle` / `surface-muted` | `gray-50` / `gray-100`（作 bg 用时） |

`indigo` / `violet` / `rose` 三族整族删除：`WorkflowPipeline` 里那份彩虹 `className` 是从没被 render 读过的死数据；
`ModelMarketplace` 的紫色「生图」标签与生图价格块并回 `brand` 家族（同一张卡上它和 token 价格块互斥出现，
本来就该长一样）；`CurrentPlanCard` 的紫点是「视频点 · 会员」，跟着会员金色走 `warning`。

### 历史色值归并对照

组件里曾散落 200+ 个手写色值（大量是同一角色的漂移变体，如 `#1d1d1f` / `#303936` / `#26302d` 都是主文字）。
收敛规则如下，遇到旧代码或旧分支照此对号入座：

| 归并到 | 主要旧色值 |
|--------|-----------|
| `ink` | `#1d1d1f` `#303936` `#26302d` `#202725` `#34343a` `#25302d` `#3f3f45` |
| `ink-secondary` | `#6e6e73` `#424245` `#5a5a60` `#65706c` `#4b4b52` `#4b5652` |
| `ink-tertiary` | `#8a8a8f` `#89928f` `#7a8380` `#86868b` `#b6b6bd` `#c7c7cc` |
| `hairline` | `#d2d2d7` `#d9dfdd` `#cfd5d3` |
| `hairline-subtle` | `#e8e8ed` `#e1e6e4` `#ececf0` `#e2e7e5` `#dfe1e6` `#e1e5e3` `#e5e7eb` |
| `surface` | `#ffffff` `bg-white` |
| `surface-subtle` | `#f7faf9` `#f7f8fa` `#f7f7f9` `#fafafa` `#fafbfb` `#fbfcfc` |
| `surface-muted` | `#f5f5f7` `#f5f7fa` `#eef2f0` `#f5f7f6` `#f1f3f2` |
| `surface-inverse` | `#1d1d1f` `#101615` `#111418` `#20252b`（作 bg/border 用时） |

归并依据是 `index.css` 里那份已被删掉的 `html[data-theme="dark"]` 白名单 —— 它记录了每个旧色值当初被当作哪个角色，
是暗色行为的既有真相，不是我重新分类的（要考古看 P2.3 之前的 `index.css`）。两处是按亮度补拆的：描边以 `#e0e0e0`（luma 224）为界拆成
`hairline` / `hairline-subtle`，近白面把纯白留给 `surface`、带色偏的归 `surface-subtle`。
这两拆在暗色下同值，所以不改变任何既有表现。

新增颜色挑 token 时**先按用途分家族**（文字 / 描边 / 面），再按 luma（`0.2126R + 0.7152G + 0.0722B`）落档。
下面的区间是从 203 个活跃旧色值实测出来的，不是拍的：

| 家族 | Token | 实测 luma 区间 |
|------|-------|---------------|
| 文字 | `ink` / `ink-secondary` / `ink-tertiary` | 29~77 / 66~122 / 120~208 |
| 描边 | `hairline` / `hairline-subtle` | 210~222 / 225~240 |
| 面 | `surface-muted` / `surface-subtle` / `surface` | 229~247 / 245~252 / 255 |

`canvas`（工作台底）与 `surface-raised`（浮层、弹窗）按用途选，跟亮度无关。
文字三档的边界有重叠（`#3f3f45` luma 63 归 `ink`，`#424245` luma 66 归 `ink-secondary`），
这是白名单当初的分法，旧代码照抄；新色落在重叠区时按语义选，别按数字硬套。

绿偏系（`#f7faf9` `#d9dfdd` `#89928f` `#65706c` …）与中性灰系（`#f5f5f7` `#d2d2d7` `#8a8a8f` `#6e6e73` …）
是两套漂移出来的家族，**以中性灰系为准** —— 它与 `--color-*` 的现行值一致，且用量占多数。

### Memory Semantic Palette

记忆类型色不进 `--color-*`，直接用 Tailwind 调色板类，唯一来源是
`apps/web/src/components/memory/memoryStyles.ts` 的 `MEMORY_TYPE_STYLES`。

| Memory Type | Accent | Soft Surface | Usage |
|-------------|--------|--------------|-------|
| Core | `amber-500` | `amber-50 / amber-100` | 核心记忆节点、筛选、移动卡片左边线 |
| Permanent | `sky-500` | `sky-50 / sky-100` | 常驻记忆节点、筛选、移动卡片左边线 |
| Temporary | `brand` | `brand-soft` | 临时记忆节点、筛选、移动卡片左边线 |
| Knowledge | `violet-500` | `violet-50 / violet-100` | 知识星云节点、筛选、移动卡片左边线 |
| Other | `slate-500` | `slate-100` | 其他记忆节点、筛选、移动卡片左边线 |
| Table Highlight | `brand/[0.08]`（选中）/ `brand/5`（命中） | n/a | 表格选中行、搜索命中 |

这几档**不随主题翻转**（暗色下仍是浅底 + 深字的高对比药丸），这是既有行为：
旧白名单里从来没有 `amber-*` / `sky-*` / `violet-*` / `slate-*`，删白名单没有改变它们的表现。
要让记忆类型色也跟着暗色走，属于独立的设计改动，得先在这张表里定暗色值。

### Rules

- 只允许 `brand #0066cc` 作为主强调色，不引入第二主色系。
- **组件里不写字面色值**：不写 `text-[#1d1d1f]`、不写 `border-gray-200`、不写 `bg-red-50`，一律用上表的语义类。
  Tailwind 自带调色板（gray/slate/red/amber/blue/…）在 `apps/web/src` 里只剩两处合法出口：
  上面那份 Memory Semantic Palette（唯一来源 `memoryStyles.ts`），以及下面这份**装饰色白名单**
  （全站仅 11 处，改动需在 PR 里说明）：

  | 位置 | 色值 | 是什么 |
  |------|------|--------|
  | `HelpWriteWizard.tsx` | `bg-[#20202a]`、`from-[#3a3a44] to-[#20202a]` | 素材占位缩略图（恒深底 + 白图标） |
  | `VideoGenerationStudio.tsx` | `from-[#3a3a44] to-[#20202a]`、`from-[#7d8ea8] to-[#5c6b84]`、`from-[#caa46a] to-[#a8823f]` | 视频/图片/音频三类任务的品类渐变 |
  | `NovelLibraryPage.tsx` | `bg-[#557b95]`、`bg-[#8a7297]` | 书脊色带（与 `bg-brand` 三色轮换） |

  判断标准：**它是不是在表达某个语义角色**。是（文字/描边/面/状态）就必须用 token；
  纯装饰、且两种主题下都该保持原样的一次性视觉，才进这份白名单。
- `text-white` / `bg-black` 是允许的字面色，但只限两种位置：
  **固定填充上的白字**（`bg-brand`、`bg-danger`、`bg-scrim/65` 上的文字与图标，共 143 处 `text-white`），
  以及 **`<video>` 的信箱底**（3 处 `bg-black`，视频信箱要真黑，不能用 `#101615` 的 `scrim`）。
  只要那块底色本身会跟主题翻（浅色下深、暗色下浅），就不能写 `text-white` —— 用 `surface-inverse` + `ink-inverse`。
- 需要压暗背后内容时一律 `bg-scrim/NN`，不写 `bg-black/NN`。透明底棋盘格用 `index.css` 的 `.bg-checkerboard`，
  不要再逐处复制那四条 `linear-gradient`。
- 新增颜色必须先写入本文件、再落到 `index.css` 的 `--color-*` 与 `tailwind.config.js`，最后才进组件。
- 暗色值与浅色值必须同时给出。只给浅色的色值等于在暗色模式下坏掉。
  内联 `style` 同样受这条约束：写 `rgb(var(--color-danger))` 或 `var(--apple-ink-secondary)`，别写 `#dc2626`。
- 记忆管理页优先使用表格、筛选条和右侧详情，不使用装饰性可视化背景。
- 记忆类型色统一来自 `apps/web/src/components/memory/memoryStyles.ts`，组件不得各自复制色板。


## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Tracking | Usage |
|-------|------|--------|-------------|----------|-------|
| H1 | 32px | 700 | 1.15 | -0.03em | 页面主标题 |
| H2 | 24px | 600 | 1.2 | -0.02em | 大区块标题 |
| H3 | 18px | 600 | 1.3 | -0.01em | 卡片标题、面板标题 |
| Body/lg | 16px | 400 | 1.6 | 0 | 主要正文 |
| Body | 14px | 400 | 1.55 | 0 | 默认文本 |
| Caption | 12px | 500 | 1.45 | 0.01em | 标签、元信息 |
| Overline | 11px | 600 | 1.35 | 0.06em | 分组说明、统计标签 |

### Font Stack

- Primary: `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- Mono: `ui-monospace, "SFMono-Regular", "SF Mono", monospace`

### Rules

- 以 Inter/system 为唯一正文体系。
- 正文不低于 14px；辅助信息可降到 12px。
- 标题控制在 2 行内，超出时缩小尺寸或截断。

## 4. Spacing & Layout

### Base Unit

所有间距遵循 **4px** 基准。

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | 4px | 图标与文案微间距 |
| `--space-2` | 8px | 紧凑行内组合 |
| `--space-3` | 12px | 默认控件内边距 |
| `--space-4` | 16px | 卡片常规内边距 |
| `--space-5` | 20px | 模块组装间距 |
| `--space-6` | 24px | 大卡片与面板内边距 |
| `--space-8` | 32px | 页面分组间距 |

### Grid

- Max content width: `1440px`
- Breakpoints: `sm 640`, `md 768`, `lg 1024`, `xl 1280`
- 桌面记忆页使用 `筛选工具栏 + 表格 + 右侧详情` 双栏；表格占据主要宽度。
- 移动端使用列表 + 底部详情面板，避免横向表格溢出。

### Rules

- 面板圆角只用 `8 / 10 / 14px` 三档。
- 桌面主内容优先 `h-full / min-h-0 / overflow-hidden`，避免整页滚动。

## 5. Components

### Shell Sidebar Item

- **Structure**: `Icon + label`
- **Variants**: default / active
- **Spacing**: `--space-2`, `--space-3`
- **States**: hover, active, focus-visible
- **Accessibility**: `button` 语义，清晰 focus ring

### Memory Filter Bar

- **Structure**: 搜索、类型 segmented control、长期记忆开关、轻量统计
- **Variants**: desktop / mobile stacked
- **Spacing**: `--space-3` ~ `--space-5`
- **States**: idle, loading, disabled, active, focus

### Memory Table

- **Structure**: 标题/摘要、类型、重要度、标签、使用次数、创建时间、操作入口。
- **Variants**: loading / empty / error / selected / highlighted。
- **Spacing**: 行高舒适，摘要最多 2 行，标签最多展示 2 个。
- **States**: hover, selected, highlighted, focus-visible。
- **Token Source**: `MEMORY_TYPE_STYLES` 提供类型标签与筛选样式，不在组件内重复写类型色。

### Memory Detail Panel

- **Structure**: 头部、元信息、只读内容或编辑表单、危险操作区
- **Variants**: empty / view / edit / mobile sheet
- **States**: hover, focus, disabled, saving, deleting, validation error
- **Mobile Motion**: `memory-sheet-enter` 使用 `transform: translateY(...)` 上滑进入。

### Memory Type Token Primitive

- **File**: `apps/web/src/components/memory/memoryStyles.ts`
- **Purpose**: 集中管理 `CORE / PERMANENT / TEMPORARY / KNOWLEDGE / OTHER` 的节点、筛选、编辑器与移动卡片样式。
- **Rule**: 新增或调整记忆类型视觉时，先更新本文件和上方 `Memory Semantic Palette`，再在组件中引用。

## 6. Motion & Interaction

方向为**「惊艳派」有物理感的品牌化动效**：在保持浅色克制底子的同时，让每个关键交互都有弹簧感与品牌记忆点。全部动效由单一来源 `apps/web/src/motion/` 驱动（`motion` / Framer Motion），**禁止**在组件内散写 keyframes 或魔法时长。

### Spring 预设（`motion/tokens.ts`）

| 预设 | 参数 | 用途 |
|------|------|------|
| `snappy` | stiffness 520 / damping 30 | 微交互：hover、按钮 press、开关、选中缩放 |
| `bouncy` | stiffness 380 / damping 22 | 入场：消息气泡、卡片、弹窗、stagger 项（受控回弹） |
| `smooth` | stiffness 260 / damping 32 | 页面转场、卡片 hover 抬升、导航指示器平移 |

### Duration / Easing / 位移

| Token | 值 | 说明 |
|-------|----|----|
| duration.micro / std / emph | 0.17s / 0.34s / 0.48s | 退出动画取进入的 ~75% |
| easing.outExpo | `[.16,1,.3,1]` | 缓动补充 |
| enterY / enterScale / enterBlur | 26 / 0.9 / 8px | 入场位移·缩放·模糊 |
| lift / press | -5 / 0.93 | hover 抬升 · 点击回弹 |

### 惊艳时刻（仅关键节点，避免疲劳）

- **扣算力点**：粒子迸发 + `-n` 浮层 + 余额数字滚动脉冲（`SpendBurst`）。
- **成功反馈**：Toast 弹入 + 五彩纸屑（`Confetti`）。
- **列表/卡片/网格**：`Stagger` 依次入场（大列表只对首屏 ~20 项）。
- **页面转场**：缩放 + 模糊淡入，方向滑出（`PageTransition`）。
- **品牌 logo**：漂浮 + hover 眨眼。

### Rules

- 只动画 `transform`、`opacity`、`filter`（含 `box-shadow`、`border-color` 的过渡）；不动 layout 属性（width/height/top/left）。
- 所有可交互元素必须具备 hover 和 `focus-visible`。
- **粒子 / 纸屑 / 光扫 / 漂浮 等装饰动效只用于扣点、成功等关键时刻**；数量克制，避免动画疲劳。
- **无障碍**：根部 `<MotionConfig reducedMotion="user">` 统一接管；装饰组件在 `prefers-reduced-motion` 下经 `shouldRenderDecoration` 短路不渲染；纯 CSS 动画由 `index.css` 的全局 `prefers-reduced-motion` 兜底收敛。
- 目标 60fps；退出动画短于进入。
- 新增/调整动效**先更新本节与 `motion/tokens.ts`**，再在组件中引用。

## 7. Depth & Surface

### Strategy

`mixed`，以 **边框 + tonal surface** 为主，阴影只用于轻微悬浮提示。

| Level | Value | Usage |
|------|-------|-------|
| Border/default | `border-hairline` | 面板、输入、卡片 |
| Border/subtle | `border-hairline-subtle` | 分组与弱分隔 |
| Shadow/subtle | `0 10px 30px rgba(15, 23, 42, 0.05)` | 详情面板、移动端底板 |
| Shadow/hover | `0 12px 32px rgba(15, 23, 42, 0.15)` | 命中节点、主交互卡片 |

### Rules

- 阴影要轻，不能抢掉浅色 Apple-like 的干净感。
- 记忆管理的层次优先靠表格分组、弱边框和 tonal surface，而不是重阴影。
