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
| Knob | `--color-knob` | `knob` | `#ffffff` | 同浅色 | 开关（`ui/Switch`）的旋钮：无论主题、无论开关状态都是白的 |

`scrim` / `console` / `console-ink` / `knob` 是四个**故意不随主题翻转**的角色，所以暗色块里不重新声明：
遮罩的职责是压暗背后内容，两种模式下都该压暗；控制台面板是一套自洽的深色配色，翻成浅色就不是控制台了；
旋钮是「轨道上那颗滑块」，靠与轨道的对比说明开没开 —— 跟着主题翻成深色，关着的开关在暗色下就看不见了
（原来用 `surface`，暗色下与关态轨道 `hairline` 只差 1.5:1）。
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

唯一来源是 `apps/web/tailwind.config.js` 的 `fontFamily.sans`，全部走系统字体，**不加载任何 web font**（仓库里没有 Inter，也没有 `@font-face`）：

```
SF Pro Text, SF Pro Display, system-ui, -apple-system, BlinkMacSystemFont,
Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif, Apple Color Emoji, …
```

- Mono 用 Tailwind 的 `font-mono` 默认栈（`ui-monospace, SFMono-Regular, …`），只在展示 ID / 日志 / 码值时用。

### Rules

- 以系统字体为唯一正文体系；要换字体改 `tailwind.config.js` 一处，别在组件里写 `style={{ fontFamily }}`。
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

### 圆角

不要在组件里写 `8 / 10 / 14px` 这类具体数值：`.apple-shell` / `.auth-shell` 会**改写** Tailwind 的圆角类（`index.css`），所以同一个类在壳内外不是同一个值。

| 写法 | 壳内实际值 | 用途 |
|------|-----------|------|
| `rounded-full` | 9999px | 按钮（`Button` 默认 pill）、Badge、胶囊开关 |
| `rounded-[10px]` | 10px（不被改写） | 输入控件（base 层已统一）、`Button shape="rounded"`、`Alert size="sm"` |
| `rounded-xl` | **11px**（Tailwind 原值 12px） | `Card radius="md"`、`Alert size="md"`、列表行 |
| `rounded-2xl` / `rounded-3xl` | **18px**（原值 16 / 24px） | `Card radius="lg"`（默认）、面板 |

- 只用上表这四种；要改全站圆角观感，改 `.apple-shell` 的改写规则，别去改调用点。
- 桌面主内容优先 `h-full / min-h-0 / overflow-hidden`，避免整页滚动。

## 5. Components

### 基元层（`apps/web/src/components/ui/`）

四个高频基元。**真身是 `xxxClass()` 类名工厂，`<Xxx>` 组件只是它 + 对应标签的薄壳** —— 因为站内大量按钮实际是 `motion/RippleButton`（样式全靠 `className` 传入），只给组件不给工厂的话这些地方没法接入；反过来，把动效焊进 `<Button>` 又会让普通按钮被强塞 spring。两种写法等价：

```tsx
<Button variant="primary">保存</Button>
<RippleButton className={buttonClass({ variant: "primary" })}>保存</RippleButton>
```

| 基元 | 参数 | 档位 |
|------|------|------|
| `Button` / `buttonClass` | `variant` | `primary`（品牌实底）/ `danger` / `secondary`（弱底）/ `outline` / `ghost` |
| | `size` | `sm` 32px / `md` 36px（默认）/ `lg` 40px / `xl` 44px |
| | `shape` | `pill`（默认）/ `rounded`（10px，与输入控件对齐，弹窗用） |
| | `block` | 撑满父容器 |
| `Card` / `cardClass` | `padding` | `none` / `sm` 12 / `md` 16 / `lg` 20（默认）/ `xl` 24px |
| | `tone` | `surface`（默认）/ `subtle` / `muted` / `raised` |
| | `radius` | `md`（11px）/ `lg`（18px，默认） |
| | `bordered` | 默认 `true`，走 `hairline-subtle` |
| `Badge` / `badgeClass` | `tone` | `brand` / `danger` / `warning` / `info` / `success` / `neutral` |
| | `variant` | `soft`（默认，弱底）/ `solid`（实底）/ `outline` |
| | `size` | `xs` / `sm` / `md`（默认） |
| `Alert` / `alertClass` | `tone` | `danger`（默认）/ `warning` / `info` / `success` / `brand` |
| | `size` | `sm`（10px 圆角）/ `md`（默认） |
| | `bordered` | 默认 `false`，开了走 `X/20` 描边 |
| `PageHeader` / `pageHeaderClass` | `title` | 页名，14px/600。字号收小了但仍是本屏唯一的 `h1` |
| | `meta` | 页名右侧一行 12px 弱信息（计数、来源），没有就不给 |
| | `children` | 右侧就地控件（计数、开关、动作），靠 `ml-auto` 顶到另一头 |
| | `maxWidth` | 与正文同一个 `max-w-*`；正文通栏的页面不要传 |
| `SegmentedControl` | `value` / `options` / `onChange` | 一组互斥选项，选中项下面压一块会滑的白底板（`spring.smooth`） |
| | `ariaLabel` | 整组名（`role="group"`，不是 `tablist` —— 它是筛选器，不切换面板） |
| | 选项 | `value` / `label` / `icon` / `title` / `testId` / `disabled` |

### 分段控件（`components/ui/SegmentedControl.tsx`）

「在几个里选一个」全站只有这一种控件。**落地前有三种长相**：素材库是两排圆角胶囊、知识库是上下两个同名小节、工作流顶栏是实心品牌色胶囊 —— 同一件事三副长相，换页要重新认。现在统一到原型的那条带滑动底板的分段控件，落点：素材库的分区与类型筛选、知识库的「我的 / 官方」、工作流顶栏的模块切换。

- **几何**（抄原型）：轨 3px 内距 / 圆角 11px / `surface-subtle` 底 + hairline 描边；选项高 28px、圆角 8px、13px 字；底板 `surface` 白 + hairline 描边 + 1px 投影。
- **底板是量出来的，不是算出来的**：选项宽度由文案决定（「我的」和「官方知识库」不一样宽），均分格子会让短选项撑出空白。挂载后读 `getBoundingClientRect()` 拿选中项的 left/width，`x` + `width` 动画过去；轨可滚时两边一起滚，差值不变。
- **底板只画量出来之后那一帧**（`initial={false}`），否则首次挂载会从 x=0 滑一段。
- **语义是 `role="group"` + `aria-pressed`，不是 `role="tablist"`**：选项之间不切换面板，报成「选项卡 1 / 共 4」与真实交互不符。
- **取消筛选是另一项，不是再点一次选中项**（素材库的「全部」）。分段控件没有「空选」态。

尺寸档位不是拍的，取的是全站实测最高频值：按钮高度 `h-9` 117 处 / `h-10` 91 / `h-8` 74 / `h-11` 34；`cardClass()` 的默认输出 `rounded-2xl border border-hairline-subtle bg-surface p-5` 正是全站 23 处逐字重复的那串 className。

### 基元层的规则

- **能用参数表达的就用参数，`className` 只加工厂没碰过的属性**（布局、间距、动画）。className 里出现同属性的第二个 utility，谁生效取决于两条规则在**构建产物**里的先后，而那个顺序是 Tailwind 自己排的、跟字符串顺序无关 —— 传 `p-6` 去盖工厂的 `p-4` 属于赌运气。同理 `ui/cx.ts` 故意不做 tailwind-merge 式冲突消解。
- 颜色只允许出现 §2 的语义 token。`ui.test.tsx` 里 16 条测试会遍历所有 variant × size 组合断言这一点，也断言 `X/10` 弱底必须配 `X-ink` 文字、实底档不拿 `X-ink` 当底色、每个按钮只产出一种圆角。
- `Button` 的 `BASE` 刻意**不设** `flex-none`：弹窗底部 `flex-1` 平分宽度的按钮行很常见，而产物里 `.flex-1` 排在 `.flex-none` 之前，工厂一设调用方就永远赢不了。需要不收缩时自己加。
- 实底档（primary / danger）的禁用态用 `bg-hairline` + `ink-tertiary`（灰底灰字 4.6:1）而不是调透明度 —— `bg-brand/50` 上的白字只有 2.2:1，过不了 AA。弱强调三档对比度余量大，继续用 `opacity-50`。
- hover 用同色 `/90` 而不是换到 `-ink` 档：`-ink` 在暗色下是提亮值（`brand-ink` #5bafff），白字落上去只剩 2.3:1。
- `Badge variant="solid"` 的 warning / success 用 `text-scrim` 而不是白字（3.1:1 / 3.4:1 不达标），`scrim` 是唯一不随主题翻转的深色 token。
- 浅色主题下 `surface-muted` 与 `canvas` 同值（`245 245 247`），所以 `Button variant="secondary"` 和 `Badge tone="neutral" variant="soft"` 直接放在页面画布上会「看不见底」—— 它们的位置是卡片（白面）之内。
- 语义上该是 `<article>` / `<section>` 的地方直接 `className={cardClass(...)}`，别为了用组件把标签改成 `div`。
- 特殊处理（segmented control、虚线空态、品牌浅色渐变价格块等）保持显式手写，不硬塞进工厂 —— 工厂只覆盖默认情形。

### 对话列表滑入面板（`components/shell/AgentRail.tsx` + `Shell.tsx`）

- **是什么**：`AgentRail` 从「常驻第二栏」改成**左侧滑入面板**。原型 `layout1` 的结论：会话列表大多数时候只是「待选」，常驻会白占 220px。现在 `fixed inset-y-0 left-0 z-50 w-[312px]`，不占文档流，宽度全还给对话流。
- **Structure**：面板本体（`motion.aside`）+ 遮罩（`fixed inset-0 z-40 bg-scrim/25`）+ 对话页左上角的开关按钮（`Chat.tsx`，`aria-expanded` 跟着状态走）。
- **进出场**：打开 360ms 阻尼（`ease: [0.22, 1, 0.36, 1]`，与 `spring.smooth` 同源的 cubic-bezier）/ 关闭 240ms `easeIn` —— **离开比进入快**，元素已经在往外走，再慢慢滑只会显得黏。关状 `x: -102%` 而不是 `-100%`：留 2% 在屏幕外，关闭过程不会有一帧「刚好贴边」的停顿感。
- **Rules**:
  - 「用完即走」：选会话、开新对话、挑完 Agent 都关面板（`onRequestClose`），不把「开着」当常态存起来。
  - 遮罩与面板**一起**进 `AnimatePresence`：少了它，面板退场时遮罩先一步消失，中间闪一下空背景。
  - `Esc` 关面板，监听挂 `window`（焦点在面板里的搜索框/列表项上，事件照样冒泡上来）。遮罩接点击，键盘用户没有「点遮罩」这个动作。
  - 面板内部仍是两个子面板互切（Agent 列表 / 该 Agent 的对话），`AnimatePresence mode="wait"` + 左右滑动，这套没动。
  - 宽度 312px 取自原型 `.slideover`，且要放得下「头像 + 标题 + 元信息」一行与底部主按钮。

### 页面上下文条

- **是什么**：`components/ui/PageHeader.tsx`。一条 56px 高、通栏、底色 `surface`、下沿一条 `hairline-subtle` 的条带，里面是页名 + 右侧就地控件。取代了原来每个功能页各自的「`H1` + 一句灰色说明句」页头带。
- **为什么不是大标题**：左侧导航已经把「你在哪」说清楚了，页面上再喊一遍是后台的语法；改版前五个页面的标题用了 28 / 24 / 24 / 30 / 30 五种字号，一种都不在 §3 的 H1 档上。现在页名统一 14px/600。
- **Structure**: `h1.title` + 可选 `meta` + 可选右侧控件区
- **Variants**: 只有页名（设置、记忆）/ 页名 + 计数（模型广场、素材库）/ 页名 + 动作（知识库的「返回对话」）
- **Rules**:
  - **一个字号档、一个左起点**：正文用 `mx-auto max-w-* px-*` 的页面，必须把同一个 `max-w-*` 传给 `maxWidth`。注意内距与宽度上限要落在**同一个元素**上，否则同一段 max-width 会在页头与正文之间算出两个不同的左起点（设置页原来整体偏右 146px 就是这个成因）。
  - 页面上**只说一遍**计数：数字落在你要对它做动作的那一行。模型广场把它放在条带右侧；记忆放在筛选条里（那里才是筛的对象）。两处都写就是重复。
  - 条带里不放**说明句**。页面不解释自己。
  - 不再给页面配 `H1` 之上的英文大写眉标。

### 工作流设置栏（生图 / 小说 / 桌宠 / 图文）

四个工作流模块的「你要填什么」那一栏共用同一套语言。真身在 `apps/web/src/components/workflow/SettingsSlots.tsx`，**只有三个层级和一组几何，没有任何布局**：

| 常量 / 组件 | 值 | 用途 |
|------|-----|------|
| `SETTINGS_GROUP` | 12px / 600 / `ink-secondary` | 分组小标题。四个模块用同一套词：输入、参数、基本信息、外观与动作、生成选项、发布平台… |
| `SETTINGS_LABEL` | 14px / 500 / `ink` | 字段名。**不再往下掉**（改版前桌宠 / 图文有 11px、10px、9px 三档） |
| `SETTINGS_HINT` | 12px / `ink-tertiary` | 计数、上限、「可多选」这类辅助信息 |
| `SETTINGS_CONTROL` / `SETTINGS_TEXTAREA` | `h-10` / `rounded-[10px]` / `border-hairline` / `bg-surface-subtle` | 单行与多行控件，与 `InAppSelect` 触发器同一副几何 |
| `SETTINGS_DROPZONE` / `_TILE` | 同上但虚线边 | 上传位（整行 / 方形格子） |
| `SETTINGS_SLOT` | `rounded-[10px]` / `bg-surface-subtle` | 只读槽位（模型名、配额说明） |
| `SETTINGS_SEGMENT` + `_ON` / `_OFF` | 相邻格 + `border-r`，选中 `bg-brand-soft` | 分段选择（批量张数、创作方式、公众号生成方式） |

- ⚠️ **栏头只有一份**：`WF_PANEL_HEAD`（见下一节）。原来左栏另有一份 `SETTINGS_PANEL_HEAD`，
  两份只差 `gap` 与底色，同一屏里三区栏头就高矮不一 —— 已删掉，设置栏直接 import `WF_PANEL_HEAD`。

- **分组用 `SettingsGroup`，字段用 `SettingsField`**。`SettingsField` 的 `hint` 刻意是 `<label>` 的**兄弟节点**：写进 label 会让可访问名变成「写作风格 0/500」，`getByLabelText("写作风格")` 与读屏一起失效。要 label 关联控件就传 `htmlFor` + 控件 `id`。
- 三个层级以外的东西（卡片、栏宽、滚动、按钮位置）各模块自己定：A 形态（生图 / 桌宠 / 图文）= 设置左置 + 产出并存，主按钮在栏底；B 形态（小说创建）= 设置主导居中，主按钮在表单末尾。见 `prototype/说明.md` 的规范 v2。

**三区骨架与栏宽**（左=设置、中=工作区、右=历史，不许串位）。**几何只此一份**，真身在
`apps/web/src/components/workflow/workflowLayout.ts`：

| 常量 | 用途 |
|------|------|
| `wfShell(left, right)` | A 形态外壳的**唯一**入口。列宽按开关组出去：`minmax(280px,22%)_minmax(0,1fr)_minmax(260px,20.5%)` / 收左 / 收右 / 全收，外加共同的 `flex-col gap-3.5 p-3.5` + `xl:grid xl:h-full xl:grid-rows-1 xl:overflow-hidden`（窄屏纵向堆叠，横排从 `xl` 起）。**没有常量版** —— 左右两栏的显隐由顶栏「面板开关」决定，收起的那一列连缝一起从栅格里消失，所以列数只有运行时才知道。曾经有个 `WF_SHELL` 常量写着三栏全展开，它和这个函数就是「同一副几何的两个来源」，已删 |
| `WF_SHELL_FORM` | B 形态外壳（小说创建）：公共部分 + `xl:grid-cols-[minmax(0,1fr)_280px]` |
| `WF_PANEL` / `WF_WORKSPACE` | 三区共用的卡壳：`rounded-2xl` + 一条 `hairline-subtle` + `overflow-hidden`；工作区底色再弱一档 |
| `WF_PANEL_HEAD` | 三个区共用的 56px 栏头 |

❗**四条列宽必须是完整的类名字面量，不能拼**。早先的写法是把 `grid-cols-[` 留在公共前缀、运行时再拼列宽 ——
Tailwind 只扫源码里的完整字面量，拼出来的类名它不认识 ⇒ `xl:grid` 生成了、列定义没生成 ⇒
`display:grid` 但没有 `grid-template-columns`，栅格退化成单列、**宽屏下三区全部纵向堆叠**。
`tsc` 不看类名、jsdom 不套 CSS、dev server 还留着上一轮产物，三层检查全绿 —— 是用户在界面上发现的。
`workflowLayout.test.ts` 现在有一条守卫：断言每种组合的候选类都**逐字**出现在源码里。**改宽度时四条一起改。**

❗**两侧是「百分比 + 像素下限」，不是死像素**。原型 `layout3` 给的 300 / 280 是 1440 下的绝对值；
写死它的话，多出来的宽度**全归中间** —— 2560 的屏上设置栏还是 300px（只占 11.7%），被挤得读不动，
中间却空一大片。`minmax(280px, 22%)` 两头都占：1440 下 ≈298 / 278（与原型差 2px 以内），
窗口越宽两侧越宽，窄到 1330 以下由 280 / 260 兜住。⚠️ 百分比是对**栅格容器的内容宽**算的
（≈ 视口 − 84px），调比例时按 `比例 × (视口 − 84)` 估。

❗**外壳还需要「父级高度确定」**，两处缺一不可：

1. 行要锁住 —— `xl:grid-rows-1`（落到 `grid-template-rows: repeat(1, minmax(0,1fr))`）。只给列不给行，
   隐式 `auto` 行会被**最高的一栏**（设置）撑到两三千像素，三张卡一起变高：工作区明明只有一张占位图，
   却长成跟设置栏一样高、底边还被裁掉。锁住之后三栏各自内部滚动（每栏 body 本来就是
   `min-h-0 flex-1 overflow-y-auto`，只是过去没人约束它们）。
2. 内容槽要能把高度传下来 —— `components/shell/Shell.tsx` 的 `contentScroll()`：
   **靠 `flex-1` / `xl:h-full` 填满视口的模块**（三区：生图 / 图文 / 桌宠；单栏：录音转文字）
   走 `page-wide` = **`flex flex-col overflow-y-auto xl:overflow-hidden`**。
   ⚠️ **前面那个 `flex flex-col` 不能省**：内容槽原来是 `display:block`，页面里所有
   `flex-1 / h-full / min-h-0` 都会解析成 `auto`，外壳的 `xl:h-full` 跟着失效。
   症状看起来在 studio（工作台高度跟着设置栏走），根因却在外壳槽里。

- **哪些页面落哪副骨架**：生图（**模块内 6 个场景全部**：通用生图 / 电商图 / 商品提取 / 形象照 /
  万物试穿 / 试甲台）、图文、桌宠 = `wfShell(true, true)`（桌宠右栏是「一叠卡」，间距同为 `gap-3.5`）；
  小说创建 = `WF_SHELL_FORM`（小说工作台自带全屏外壳，不接面板开关，所以这里留常量）。
- ⚠️ **生图模块内 6 个场景是同一份骨架**。改版前只有「通用生图」是留缝圆角卡三区，
  其余 5 个场景仍是 `minmax(360px,30%)_1fr` 的**通栏直角两栏**、历史还贴在内容底部 ——
  同一个生图模块里切个场景，圆角变直角、历史条从右栏掉到底部。新增场景一律从
  `ImageWorkflowStudio` 抄骨架，别从 `ecomWorkflowStudioView` 抄（它已经是新骨架了，但
  它的中间工作区是三段 `border-b` 竖排，抄的时候留意）。
- **面板开关**：顶栏右侧两颗（`mdi:arrow-collapse-left|right` / `mdi:arrow-expand-left|right`），
  `aria-pressed` 报「当前是展开的」。可见性经 `PanelVisibilityProvider` 下发（`usePanelVisibility()`），
  不给 9 个 studio 串 props；只有三区模块（生图 / 图文 / 桌宠）配开关，小说与 ppt 不配。
  ⚠️ 收起那一栏用**条件渲染**而不是加 `hidden`：`hidden` 会被同元素的 `flex` 覆盖（`cx` 不做
  tailwind-merge），而且栅格里少一列才是「连缝一起消失」——留一列空白等于没收起。
- 电商图是「场景内再分档」（商品主图 / 商品详情图），它的二级切换做成**通栏胶囊行**放在
  `wfShell` 上面（与 `Workflow.tsx` 的场景 tab 同款），**不要**做成 `role="tab"`：
  `Workflow.image-hub.test.tsx` 锁死了页面里 `role="tab"` 的数量（6 个场景 tab），多一个就红。
- 内距只由外壳提供一层。`Workflow.tsx` 的工作区容器是 `A_SHAPE_STUDIO`，**只负责撑满不加内距**；
  两边都加就会叠成 38px。
- 三区里只有「历史」不许各写各的：统一叫「历史」，统一「＋ 新建 → 搜索 → 条目（缩略 + 名称 + 元信息）」，当前项品牌弱底高亮。
- ⚠️ 历史如果同时要有「宽屏右栏」与「窄屏底部/抽屉」两种位置，**只渲染一份 DOM**：宽屏是 grid 的第三列，窄屏顺序落到工作区下方。写成「两份 DOM + hidden 二选一」会让 `getByRole("region"/"dialog", …)` 取到两个。
- ⚠️ 右栏容器用 `<section aria-label>` 而不是 `<aside aria-label>`：`aside` 有可访问名时 role 是 `complementary`，按 `region` 取的断言会全红。
- ⚠️ 复用常量时**不要覆写同族 utility**（`SETTINGS_DROPZONE` 是 `text-sm`，要 `text-xs` 就用 `SETTINGS_DROPZONE_TILE`）——`cx` 不做冲突消解，谁生效看构建顺序。

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
| lift / press | -2 / 0.97 | hover 抬升 · 点击回弹（原型「按压 + 水波」一行的实测值） |
| hoverEase | 0.18s + `[.22,1,.36,1]` | hover 上浮专用：不用弹簧 —— 悬停要跟手，弹簧的 settling 尾巴会像在抖 |

### 惊艳时刻（仅关键节点，避免疲劳）

- **扣算力点**：粒子迸发 + `-n` 浮层 + 余额数字滚动脉冲（`SpendBurst`）。
- **成功反馈**：Toast 弹入 + 五彩纸屑（`Confetti`）。
- **列表/卡片/网格**：`Stagger` 依次入场（大列表只对首屏 ~20 项）。落点：模型广场卡片墙
  （`pages/ModelMarketplace.tsx`），每项 40ms 间隔、最多 7 项累加。
- **页面转场**：缩放 + 模糊淡入，方向滑出（`PageTransition`）。落点：`App.tsx` 的路由分派处，
  包在 `AnimatePresence mode="wait"` 里，`key={nav.view}`。
- **工作流模块内切换**：三区依次进场（`.wf-studio-in`，40ms 间隔，纯 CSS）。为什么不用
  motion 的 stagger —— 场景 tab 的 DOM 是**常驻挂载**的（切走再切回草稿还在），加 key 让
  React 卸了重装会把草稿一起卸掉；CSS 动画跟着 active 类走，`display:none` 的隐藏页不跑动画，
  正好是「只对可见的那一屏播」。
- **品牌 logo**：漂浮 + hover 眨眼。

### 两个实现位置（2026-10-14 落地）

| 动效 | 真身 | 参数来源 |
|------|------|---------|
| 页面转场 / 依次入场 | `motion/PageTransition.tsx`（`PageTransition` / `Stagger` / `staggerItem`） | `motion/tokens.ts` 的 `spring.smooth` / `spring.bouncy` |
| 工作流三区依次进场 | `index.css` 的 `.wf-studio-in` + `@keyframes studioItemIn` | 规范 340ms / 40ms 间隔 |
| 选中指示器（导航底板 / 分段控件底板） | `NavRail.tsx` 的 `ActivePill`（`layoutId` 共享）、`ui/SegmentedControl.tsx` 的 thumb | 都是 `spring.smooth`（规范 440ms smooth，即该弹簧的 settle 时长） |
| 滑入面板 | `shell/AgentRail.tsx` + `Shell.tsx` 的同一份 `AnimatePresence` | 开 360ms 阻尼 / 关 240ms / 遮罩 200ms |
| 浮层展开 | `shell/HoverPopover.tsx` | 220ms，scale .96→1 + 位移 4px，`[.22,1,.36,1]` |
| 按压 + 水波 | `motion/RippleButton.tsx` | hover 2px/180ms、press .97、水波 600ms |

⚠️ `PageTransition` 会按**能力**判断跑不跑动画：没有 `window.matchMedia`（jsdom，没有帧循环，
`AnimatePresence` 的 exit 永远等不到 `onComplete`）就退化成普通容器，`App.tsx` 也不包
`AnimatePresence`。这不是为测试开后门，是按环境能力分流 —— 别改成读 `NODE_ENV`，那会让生产
构建永远带着这条分支，而真实用户的「减少动效」偏好由 `MotionConfig reducedMotion="user"` 管。

⚠️ **面板收纳（顶栏「面板开关」收起设置/历史栏）目前仍是即时切换**，规范里「面板、抽屉
250–400ms」那一档**没落地**。原因是面板是**条件渲染**的：收起那一列连 DOM 一起从栅格里消失，
`grid-template-columns` 的轨道数变了，CSS 只能离散插值（同名轨道数不同的两个列表不可动画）。
要补这档过渡，得让两块侧栏**常驻挂载**、靠自身宽度动画收放（或给每个子项显式 `grid-column`），
那是跨 8 个 studio 的结构性改动，做之前先想清楚测试里「收起后查不到内容」的断言要不要跟着改。

### Rules

- 只动画 `transform`、`opacity`、`filter`（含 `box-shadow`、`border-color` 的过渡）；不动 layout 属性（width/height/top/left）。
- 所有可交互元素必须具备 hover 和 `focus-visible`。
- **粒子 / 纸屑 / 光扫 / 漂浮 等装饰动效只用于扣点、成功等关键时刻**；数量克制，避免动画疲劳。
- **无障碍**：根部 `<MotionConfig reducedMotion="user">` 统一接管；装饰组件在 `prefers-reduced-motion` 下经 `shouldRenderDecoration` 短路不渲染；纯 CSS 动画由 `index.css` 的全局 `prefers-reduced-motion` 兜底收敛。
- 目标 60fps；退出动画短于进入。
- 新增/调整动效**先更新本节与 `motion/tokens.ts`**，再在组件中引用。

## 7. Depth & Surface

### Strategy

`mixed`，以 **边框 + tonal surface** 为主。**壳内没有阴影**：`index.css` 的 `.apple-shell [class*="shadow-"] { box-shadow: none !important; }` 把主应用里所有 `shadow-*` 都清掉了，所以 `shadow-sm` 之类写在壳内的组件上是死样式（能编译、不生效）。

| Level | Value | Usage |
|------|-------|-------|
| Border/default | `border-hairline` | 面板、输入、卡片 |
| Border/subtle | `border-hairline-subtle` | 分组与弱分隔（`Card` 默认） |
| Surface 层叠 | `surface` → `surface-subtle` / `surface-muted` / `surface-raised` | 壳内表达「浮起」的唯一手段 |
| Shadow/subtle | `0 10px 30px rgba(15, 23, 42, 0.05)` | 仅壳外可用（登录页 `auth-shell` 之类） |
| Shadow/hover | `0 12px 32px rgba(15, 23, 42, 0.15)` | 仅壳外可用 |

### Rules

- 壳内要表达层次，用 `tone`（`Card tone="raised"`）或弱边框，别写 `shadow-*`。
- 暗色下 `surface` 与 `surface-subtle`、`hairline` 与 `hairline-subtle` 是**故意同值**的（纯黑画布上多一层灰只会显脏），所以层次感在暗色里主要靠 `surface-muted` / `surface-raised` 两档。
- 记忆管理的层次优先靠表格分组、弱边框和 tonal surface，而不是重阴影。
