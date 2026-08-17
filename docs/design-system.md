# AI 助手 Design System

## 1. Atmosphere & Identity

轻量、克制、可维护的浅色 AI 工作台。核心体验是把复杂 AI 能力收束进清晰的层级中，让品牌青色只在关键交互与状态上发光。记忆管理的签名是“表格优先的信息工作台”：用高信息密度表格承载长期记忆，右侧详情负责编辑与整理。

## 2. Color

### Palette

| Role | Token | Light | Dark | Usage |
|------|-------|-------|------|-------|
| Surface/base | `--surface-base` | `#f5f5f7` | n/a | 应用工作台底色 |
| Surface/panel | `--surface-panel` | `#ffffff` | n/a | 卡片、侧栏、详情面板 |
| Surface/subtle | `--surface-subtle` | `#f7faf9` | n/a | 次级分组、节点底色 |
| Surface/tonal | `--surface-tonal` | `#eaf8f6` | n/a | 品牌弱强调背景 |
| Text/primary | `--text-primary` | `#1d1d1f` | n/a | 标题、正文 |
| Text/secondary | `--text-secondary` | `#6e6e73` | n/a | 说明文案 |
| Text/tertiary | `--text-tertiary` | `#8a8a8f` | n/a | 元信息、占位 |
| Border/default | `--border-default` | `#d2d2d7` | n/a | 面板边框、输入框 |
| Border/subtle | `--border-subtle` | `#e8e8ed` | n/a | 分隔线、弱轮廓 |
| Accent/primary | `--accent-primary` | `#00b8a9` | n/a | 主按钮、选中、开关 |
| Accent/hover | `--accent-hover` | `#00a096` | n/a | 主按钮 hover |
| Accent/soft | `--accent-soft` | `#e6f7f5` | n/a | 弱强调底色 |
| Danger | `--danger` | `#dc2626` | n/a | 删除、错误 |
| Warning | `--warning` | `#d97706` | n/a | 提示、重要度 |
| Info | `--info` | `#2563eb` | n/a | 搜索命中、辅助状态 |

### Memory Semantic Palette

| Memory Type | Token | Accent | Soft Surface | Usage |
|-------------|-------|--------|--------------|-------|
| Core | `--memory-core` | `amber-500` | `amber-50 / amber-100` | 核心记忆节点、筛选、移动卡片左边线 |
| Permanent | `--memory-permanent` | `sky-500` | `sky-50 / sky-100` | 常驻记忆节点、筛选、移动卡片左边线 |
| Temporary | `--memory-temporary` | `teal-500` | `teal-50 / teal-100` | 临时记忆节点、筛选、移动卡片左边线 |
| Knowledge | `--memory-knowledge` | `violet-500` | `violet-50 / violet-100` | 知识星云节点、筛选、移动卡片左边线 |
| Other | `--memory-other` | `slate-500` | `slate-50 / slate-100` | 其他记忆节点、筛选、移动卡片左边线 |
| Table Highlight | `--memory-table-highlight` | `rgba(0,184,169,0.08)` | n/a | 表格选中行、搜索命中 |

### Rules

- 只允许 `brand #00b8a9` 作为主强调色，不引入第二主色系。
- 记忆管理页优先使用表格、筛选条和右侧详情，不使用装饰性可视化背景。
- 记忆类型色统一来自 `apps/web/src/components/memory/memoryStyles.ts`，组件不得各自复制色板。
- 新增颜色必须先写入本文件再进入组件。

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
| Border/default | `1px solid #d2d2d7` | 面板、输入、卡片 |
| Border/subtle | `1px solid #e8e8ed` | 分组与弱分隔 |
| Shadow/subtle | `0 10px 30px rgba(15, 23, 42, 0.05)` | 详情面板、移动端底板 |
| Shadow/hover | `0 12px 32px rgba(0, 184, 169, 0.10)` | 命中节点、主交互卡片 |

### Rules

- 阴影要轻，不能抢掉浅色 Apple-like 的干净感。
- 记忆管理的层次优先靠表格分组、弱边框和 tonal surface，而不是重阴影。
