# Phase 8 执行提示词（重写剩余上游代码）

> 这份文件就是提示词本体。**新开一个窗口，把「## 提示词正文」整节原样贴进去即可**，
> 它是自包含的，不需要先读别的文档。
> 上游：`docs/superpowers/plans/2026-09-03-decouple-from-yun-claude.md`（Phase 1~7+9 的执行记录在那里）。

---

## 提示词正文

**目标**：把本仓 HEAD 上剩余的 **35,340 行**逐字节原样来自上游导入 commit 的代码重写掉，
分批进行、每批独立可发布，保留的 7 个模块（对话、知识库、素材库、生图、小说、codex 桌宠、
多平台图文工作流）功能不变、CI 全绿。

### 先读这些既成事实，别重新推导

- 背景与决策：`docs/decisions.md` 的 **ADR-012**。判定标准只有一个：**逐字节原样的上游行数**，
  用 `git blame`（跟随重命名）判定，不是「看起来像不像」。改名、重排、洗 history 一律不算，也一律不做。
- Phase 1~7 + 9 已于 2026-09-04 全部完成（分支 `chore/retire-legacy-modules`，13 个 commit）：
  上游行 **122,213 → 42,027**，已删掉 billing（Go 服务 + 独立库）、桌面端、connector/device/
  本机工具挂载，以及 agent 团队 / 微信 / 定时任务 / 配音 / AI 视频 / 电商图 / 漫剧 /
  本地商家宣传 / AI 报告 / 写真 / 试衣 / 工具市场共 12 条业务线。
- **统计口令已入库**：`scripts/count-upstream-lines.sh`（全仓逐文件 blame，12 并发约 13 秒）。
  `-o out.tsv` 出每文件明细。**每批收尾都跑一次，实测值写回本文件的「进度」表。**
- **`pnpm-lock.yaml` 的 6,687 行不算在 35,340 里，也不要试图动它。** 已实测：`git blame` 认内容，
  把 lockfile 删掉从零重生成，产物与 `pnpm install --lockfile-only` **逐字节一致**，
  所以那些行只能靠真改依赖版本才会变 —— 那是升级，不是解耦。
  （A8 清扫批删掉 `react-use-measure` 之后是 **6,669**：真的少用一个依赖会动 lockfile，
  这跟被禁的「洗 lockfile」不是一回事。）
- **基线口径差 551 行**：方案正文写 121,662，同一条口令在同一棵树实测 122,213。引用方案里的
  任何门槛数字时按「方案值 + 551」看。

### 优先级：按「正在被分发」排，不按行数排

`apps/web/src` 与 `apps/admin/src` 的构建产物会被打包发到每一个用户的浏览器 —— 那就是分发，
已经在发生。所以**批次 A 优先，与行数多少无关**。

### 批次

| 批次 | 范围 | 上游行（2026-09-04 实测） | 为什么这个顺序 |
|---|---|---|---|
| **A** | `apps/web/src` + `apps/admin/src` 全部 | **11,667** | 正在被分发；做完浏览器里再无上游代码 |
| **B** | `apps/api/src/agents/presets.md` | **6,288** | 纯文本、不碰构建、**可与任何批次并行** |
| **C** | api 的保留模块后端 | **13,807** | 随迭代做，无死线 |
| **D** | `packages/db`（schema + 迁移） | **1,960** | 最后动，且历史迁移不许改 |
| — | `pnpm-lock.yaml` | 6,687 | **不做**，见上 |

测试文件占 9,064 行，**不单独立项** —— 跟着各自模块走（改哪块就把那块的测试按目标行为重写）。

#### 批次 A：分发面（11,667 → 0）

按这个子顺序做，每个子批次一个 commit：

| # | 范围 | 上游行 | 备注 |
|---|---|---|---|
| A1 | `apps/admin/src/index.css` + `ui.tsx` | 1,374 | 后台样式与基础组件，改动面最独立，先做当热身 |
| A2 | `apps/web/src/components/shell/` + `components/` 顶层散文件 + `components/ui/` | 2,435 | **这批与「UI 改版」是同一批文件，合起来做** |
| A3 | `apps/web/src/` 顶层散文件（`api.ts` `memoryGalaxy.ts` `workflowState.ts` `chatState.ts` …） | 2,372 | `api.ts` 是机械活但量大 |
| A4 | `apps/web/src/components/memory/` + `pages/Memory.tsx` | 1,615 | 记忆前端；后端在批次 C |
| A5 | `apps/web/src/pages/Knowledge.tsx` + `apps/admin/src/pages/Knowledge.tsx` | 1,012 | 两个知识库页，一起改口径才不会漂 |
| A6 | `apps/admin/src/pages/` 其余 + `admin/src` 顶层其余 | 1,704 | 用户 / 公告 / 审计 / 菜单 / 管理员 |
| A7 | `apps/web/src/pages/` 其余 + `components/workflow/` | 1,120+ | 生图 / 图文 / 小说 / 桌宠的 studio 残余 |

**A2 是唯一「产品需求和解耦目标完全重合」的一批**：要改 UI 就得动 `shell/` 与那批顶层散文件，
反正要改，顺手就解耦了。`components/ui/` 只有 266 行、但被 29 个文件引用，所以放在 A2 一起动，
不要单独改它。

#### 批次 B：`presets.md`（6,288 → 0）

`apps/api/src/agents/presets.md` 是提示词库，**100% 原样**。纯文本、不碰前端、不用跑构建，
所以**可以和任何批次并行**，也是唯一一块「不重写就永远归不了零」的自有核心资产。
重写时注意：它是各内置 Agent 的系统提示词来源，改完要跑一遍 `apps/api/src/agents/` 的测试，
并手工验一次「新建对话 → 选内置 Agent → 发一条」的行为没变味。

#### 批次 C：后端保留模块（13,807 → 0）

| 范围 | 上游行 | 备注 |
|---|---|---|
| `apps/api/src/kb/` | 4,233 | 知识库，最大一块，是核心模块 |
| `apps/api/src/workflow/` | 3,074 | article / codex-pet / image / novel 四条线的残余 |
| `apps/api/src/memory/` | 2,134 | 与 A4 的前端配对做更省 |
| `apps/api/src/admin/` | 1,663 | 公告 / 操作日志 / 知识库 / 菜单 / 权限 / token |
| `apps/api/src/chat/` | 1,279 | 对话主链 |
| `apps/api/src/agent/` | 907 | `run.ts` 的 runTurn 循环 |
| `apps/api/src/auth/` + `storage/` | 551 | 基础设施层，动了影响面最广，**放最后** |

#### 批次 D：schema + 迁移（1,960 → 0）

`packages/db/prisma/schema.prisma` 现在还有 282 行上游、`migrations/` 里约 1,678 行。
**`migrations/` 里的 81 个历史迁移一个字都不许改** —— 它们是线上库的真实演化记录，
改了 `migrate deploy` 会对不上。所以这批实际只能重写 `schema.prisma` 那 282 行
（改注释与字段排布不算重写，要真的换写法），迁移那 1,678 行是**刻意留着的代价**，写进 ADR 即可。

### 什么算「重写完成」

> **判据已于 2026-09-05 按批次 A 的七组实测改写进 `docs/decisions.md` 的 ADR-012**：
> 验收不是「blame 归零」，而是「没有一行有语义的表达归属上游」，附六类地板清单。
> 下面这段是原始判据与推导过程，保留作记录。

**逐字节原样的那些行必须真的不一样了**，而不是改了个变量名。可操作的判据：

- 改完对该文件跑 `git blame --line-porcelain HEAD -- <file> | grep -c '^491de0f'`，数字降到 0；
- **不接受**：批量改缩进 / 换引号 / 重排 import / 改变量名 / 加空行 —— 衍生作品不因为改了变量名
  就不是衍生作品，这种活白干（方案「明确不做的事」第 2 条）。
- **接受**：换数据结构、换控制流、换算法、拆分或合并函数、换库、按自己的口径重新表达同一行为。
  先把这段代码在做什么读懂，然后**关掉原文件自己写一遍**，比逐行改更快也更彻底。

#### 实测：blame 归零做不到，A1 已经触到地板（方案第三个量化错误）

A1 两个文件都是关掉原文件重写的，不是改名重排，blame 也只降到 **531**
（`index.css` 444 / `ui.tsx` 87），不是 0。把 444 行拆开看：**190 行是纯语法**
（111 行空行 + 79 行只有一个右花括号的行），其余 254 行**全是单条声明**。
最长的连续非平凡段只有 **6 行**（第 33~38 行，就是 `--good`~`--badbg` 六个色值），
≥3 行的段一共 38 段，无一例外属于下面三类：

- 颜色 token 清单（`--bg: #f6f5f2;` 这种，一行一个十六进制值）；
- 选择器加上它唯一可能的拼法（`display: grid;` / `grid-template-columns: 212px 1fr;`）；
- 设计常量本身（`150px 80px 1fr`、`max-height: 80vh`、`32px`）。

要让这些行「不一样」只有两条路：**改掉产品的颜色和布局**（那不是解耦，是改设计），
或者把 `#f6f5f2` 重写成 `rgb(246 245 242)`（跟本文件明令禁止的「换引号」是同一类美化 pass）。
两条都不走，所以 A1 到此为止。

**建议把判据从「blame 归零」改成「没有一行有语义的表达归属上游」**：空行、右花括号、
十六进制色值、`display: flex;` 这类只有一种写法的单条声明本来就不构成可著作权的表达。
A2~D 会撞同一块地板（`.tsx` 上是 `import` 行、`}` 行、`return (` 行），按老判据永远验收不了。

**A2 实测印证了这条地板。** 22 个文件全部关掉原文件重写，范围内仍剩 **825 行**归属上游
（本批净消 1,645 行：41,184 → 39,539）。残留最多的三个是 `Shell.tsx` 94 /
`AgentRail.tsx` 90 / `NavRail.tsx` 84 —— 把 Shell 那 94 行摊开：**24 行纯语法**
（空行、单独的 `}` / `)` / `</main>`、`return (`），**53 行是 props 声明或逐个转发**
（`onNewSession?: (agentId: string) => void;`、`currentSessionId={currentSessionId}`
这种一行一个），剩下十几行是 `import { Icon } from "@iconify/react";` 和 6 行
`toggleCollapsed`。这些行要「不一样」，只能改 props 名 —— 那就是改契约（`App.tsx` 与
测试都按名字调），而且正是本文件禁止的「改名降低相似度」。**结论与 A1 同：到此为止。**

**A3 第三次撞同一块地板，这次连「地板由什么构成」都数清了。** 22 个文件重写 + 6 个文件删除，
范围内从 2,372 降到 **991**（净消 1,381 行：39,539 → 38,158），消掉 58%。残留最多的是
`api.ts` 171 / `index.css` 81 / `chatAttachments.ts` 60。把 `motion/Toast.tsx` 那 36 行全列出来看
（这个文件是彻底重写的，连状态结构都从 `{ items }` 拍平成数组了）：4 行空行、
2 行 `import`、6 行是 JSX 属性各占一行（`initial="initial"` / `animate="animate"` /
`exit="exit"` / `className="glass-card"`）、11 行是 `}` `)` `);` `</motion.div>`
`</ToastCtx.Provider>` 这类收尾符号，剩下的是 `export function useToast(): ToastApi {` 起头那
4 行 —— 那 4 行里的错误文案 `useToast 必须在 ToastProvider 内使用` 是对外契约，测试按它断言。
`api.ts` 的 171 行同理：`streamChat(` 的 9 个参数一行一个、`export interface WorkflowImageAsset {`
这种头行、`}` 收尾。`index.css` 的 81 行里有 `@tailwind base;` 三条指令和
`height: 100%;` / `-webkit-font-smoothing: antialiased;` 这种只有一种写法的声明。

**三批实测（A1 531 / A2 825 / A3 991）足够定案了**：地板 = 空行 + 收尾符号 + import +
一行一个的 props/参数/属性/声明 + 契约字符串。这些行不构成可著作权的表达，
判据必须改成「没有一行有语义的表达归属上游」，否则 A4~D 一样验收不了，
而且再往下压只有两条路：改契约（props 名、错误文案、API 参数名）或做美化 pass，两条本文件都禁止。

**A4 补上一条地板之外的教训：「照着原来的树逐行换属性」不算重写，得把结构本身拆开。**
本批 9 个文件重写 + 1 个删除，范围内从 1,615 降到 **478**（净消 1,137 行：38,158 → 37,021），
消掉 70%。第一遍提交后逐行核对，发现 `MemoryFilters.tsx` 135 行里有 84 行归属上游 ——
JSX 树跟原文件一模一样，只有 `className` / `aria-*` 这些属性行是新写的，等于打了两个补丁。
第二遍把它按职责拆成搜索框 / 计数 / 开关 / 类型 chip 四块（开关提成
`components/ui/Switch.tsx`，全站本来手写了三遍），同一个组件的残留从 84 掉到 **28**，
渲染结果不变、13 条用例一条没改。**判断一个文件有没有真重写，看的是「树/控制流是不是自己搭的」，
不是行数差多少** —— 属性行本来就在地板里，换掉它们对残留几乎没有影响。

剩下残留最多的是 `pages/Memory.tsx` 107 / `MemoryDetailPanel.tsx` 94 /
`useMemoryGalaxyState.ts` 66。`pages/Memory.tsx` 那 107 行摊开：9 行 import、
21 行是 hook 返回值一行一个的解构、31 行是子组件 props 一行一个地转发
（`selectedId={selectedId}` 这种）、其余是 `<div className="…">` 与收尾符号 ——
类名字符串本身就是版面设计，改它等于改设计稿；这个页面的抽屉与页头在全站都只有一处，
提成公共组件没有第二个调用方，那就纯粹是美化 pass 了。**到此为止，与 A1~A3 同。**

**A5 第一次把范围内的残留压到三位数以下：1,012 → 162（净消 903 行：37,021 → 36,118）。**
本批 18 个文件：web `pages/Knowledge.tsx` 585 → 152 行、拆出 `components/knowledge/` 6 个源文件
+ 6 个测试文件，admin `pages/Knowledge.tsx` 重写 + 新增测试，另退役 `motion/Stagger.tsx`
（已无调用方，用例 −2）。web 侧拆出的 6 个组件文件**全部为 0**，整页只剩 20 行：
7 行空行、11 行收尾符号与 `return (`、1 行 import、1 行 interface 头行，
**没有一行有语义**，最长连续段 2 行。admin 侧剩 142 行：22 行空行、47 行纯收尾符号、
2 行 import，其余 71 行是块头、一行一个的 JSX 属性、四个 `<th>` 列名、产品文案
（「删除知识库」「批量上传文档」「+ 新建库」「例：产品文档」）、confirm 选项
（`confirmText: "删除"` / `danger: true`）、inline style 常量、一行一个的 interface 字段；
最长连续段 11 / 8 / 7 / 6 / 5 行，全是 `</…>` 堆和 `<th>` 列名 —— 与 A1~A4 的地板同一种成分。

**A5 给 A4 那条教训补一个正面例子：有第二个调用方时，「拆公共组件」是真重写而不是美化 pass。**
原来「我的库」和「官方库」是两段各自展开的 JSX，重写时收成一个 `KbList`（`official` 决定角标、
`onEdit`/`onDelete` 缺省即不渲染），树是按「一份实现两处用」重新搭的，残留直接归零 ——
对照 A4 里「抽屉与页头全站只有一处，提出去没有第二个调用方」的判断，两者的分界就是**调用方个数**。

**A6 的范围实测只有 1,159 行，不是表里的 1,704** —— 表里那 545 行的差额是
`index.css` 444 + `ui.tsx` 87，它们是 **A1 收尾留下的地板**，不属于 A6 的范围。
本批 11 个文件（`App.tsx` 226 / `pages/Admins.tsx` 200 / `api.ts` 179 /
`pages/Announcements.tsx` 170 / `pages/UserDetailModal.tsx` 117 / `pages/Audit.tsx` 86 /
`pages/Users.tsx` 82 / `auth.ts` 36 / `api.test.ts` 35 / `auth.test.ts` 18 / `main.tsx` 10）
压到 **531**（净消 633 行：36,118 → 35,485，`index.css` 顺手又降 5 行）。残留成分与 A1~A5 同：
空行、纯收尾符号、`import`、一行一个的 interface 字段与 JSX 属性、产品文案与 confirm 选项
（「新增公告」`confirmText: "删除"` `show("已删除")`）、`const { show, node } = useToast()`
这类必须照写的 hook 解构、`let cancelled = false` / `return () => { cancelled = true }` 的
清理惯用法 —— **没有一行有语义的表达归属上游**，最长连续段是 `</td>`/`</div>` 堆。

**A6 是第一批「重写本身把功能性 bug 端出来」的批次**，而不是只把归属清掉：
审计页那张动作码表从来没对上过服务端（库里写 `USER_BAN` / `KB_DOC_CREATE`，表里查
`create`/`update`/`login`，于是每行都落 fallback，全站审计只看得到灰徽标 + 原始码，
而表里那条 `login` 压根没有生产者）；审计「详情」的展开状态没有 setter，`<pre>` 是死代码、
长 detail 永远截在 50 字符；管理员页手抄的可授权限少了 `KNOWLEDGE_MANAGE`，服务端收、后台勾不出来；
`Audit.tsx` 与 `Admins.tsx` 的权限门禁都写在 `useState` 之前；用户页「初始密码」没有
`type="password"`；用户详情弹窗把服务端给的 80 条时间线又切成 16 条，且 `onError` 闭包进了
effect 依赖 —— 父组件每渲染一次就重拉一次详情；登录表单的空值判断只写在按钮 `disabled` 上，
回车照样发请求。**共同点是「前端手抄了一份服务端的词表/规则」**：动作码、可授权限两处都改成
从单一来源出（服务端真实动作码、`auth.ts` 的权限目录），照抄的那份删掉。
测试从 32 条加到 109 条（新增 `App` 11 / `Users` 13 / `Admins` 11 / `Announcements` 10 /
`Audit` 8，重写 `auth` 3→15、`api` 3→15），**一条没删**；`api.test.ts` 原来用
`{ok,status,json}` 假冒 `Response`，客户端真正的读 body 路径（空 body / HTML 错误页 / 非 JSON）
一次都没跑过，换成真 `Response` 才算测到。

**A7 收掉批次 A 的最后一块：1,665 → 762（净消 903 行：35,485 → 34,582）。**
表里写「1,120+」，实测范围 1,665 —— 差额里有 127 行**不属于本批**（`pages/Memory.tsx` 107 是
A4 的地板、`pages/Knowledge.tsx` 20 是 A5 的地板，两个文件本批一个字没动），其余是估算时
没把三个工作台的测试文件和 `useArticleWorkflowStudio.ts` 算进去。本批 24 个文件重写 + 7 个新文件
（`components/chat/ChatTranscript.tsx`、`app/useModelCatalog.ts`，加 5 个测试文件）。

残留最多的是 `useArticleWorkflowStudio.ts` 83 / `NovelWorkflowStudio.tsx` 76 /
`ImageWorkflowStudio.test.tsx` 49 / `ImageWorkflowStudio.tsx` 48 / `Chat.tsx` 46，成分与 A1~A6 同，
另外冒出三种以前没记的：**一行一个的具名 import 成员**（`useArticleWorkflowStudio.ts` 那 83 行里
12 行是 `createArticleWorkflowProject,` 这种，名字是 API 契约）、**hook 返回对象里一行一个的字段转发**
（`bootstrapping,` `history,` `titleDraft,`）、**测试夹具里一行一个的 JSX 属性**
（`ImageWorkflowStudio.test.tsx` 那 49 行里 20 行是 `onDownloadAll={vi.fn()}`，props 名是被测组件的契约）。
再补一条：**API 规定的调用形状也是地板** —— `new ClipboardItem({ "text/html": …, "text/plain": … })`
那四行只有一种写法。

**A6 那条「重写把功能性 bug 端出来」在 A7 上换了一类：A7 抓到的多是时序与身份链上的 bug，
这类只有把状态结构重搭一遍才看得见，逐行读原文件读不出来。**
`NovelWorkflowStudio` 的 `saveStatus` 从打开一本书起就卡在 `"saving"`（章节列表一到就置位、没人清），
顺带把 `NovelChapterDesk` 的「局部改写」按钮永久禁用了 —— 改成 `ChapterEditor { chapterId, draft }`
一起换之后才浮出来；五处章节合并里有四处没有 project-id 守卫，切书时晚到的响应会把章节写进另一本书；
图文工作台的 `activePlatform` 挂在 `hydrateProjects → loadBatch → 轮询` 这条身份链上，
切一次平台就把 2.5 秒的定时器重建一次（改走 `batchRef` 才断开）；`Chat` 每次渲染都把视图拽到底，
用户往上翻历史，下一次状态更新立刻被拽回去。另有一类是「状态机里到不了的分支」：
`ModelMarketplace` 三个布尔 flag 的 `: null` 分支、`Workflow.tsx` 的化石 tab 状态机、
`ImageWorkflowStudio` 的 `workspaceMode` 回退分支 —— 换掉状态表示的同时它们自己就没了。

测试从 698 条加到 803 条（新增 `ChatTranscript` / `NovelCreatePage` / `Settings` / 剪贴板 /
复制动作五个文件 56 条，其余 49 条补在五个已有文件里）。**删的只有 10 条永远不会红的
`not.toContain` 断言**（NovelWorkflowStudio / ImageWorkflowStudio 里查的字符串压根不在渲染结果里），
用例本身都还在；`ArticleWorkflowStudio` 那 4 条 `renderToStaticMarkup + toContain` 换成 10 条 RTL 用例
—— 前者渲染的是静态字符串，事件与 effect 一条都没跑过。

**A7 刻意留了两件跨批的合并没做**：`apps/web` 里「unknown → 人话」这个助手有四份（该收进 `apiError.ts`）、
`copyViaTextarea` 有两份（另一份在 `components/AssistantMessageActions.tsx`，无测试）。
两件都跨出 A7 的范围，混进来这一批就没法整块 `git revert` 了，留给单独一批做。

**批次 A 收尾对账：11,667 → 4,257（`apps/web/src` 3,058 + `apps/admin/src` 1,199），消掉 63%。**
批次表里那句「做完浏览器里再无上游代码」按老判据没做到、也做不到 —— 七批全是关掉原文件重写的，
剩下的按批摊开是 A1 531 / A2 825 / A3 991 / A4 478 / A5 162 / A6 531 / A7 762
（合计比 4,257 多出二十几行，是后面几批顺手又削掉了前面文件里的几行），
**没有一行有语义的表达归属上游**。那句话的正确说法是：
**浏览器里再无上游的表达，剩的是空行、收尾符号、`import` 与契约字符串。**

### 批次 A 之后的清扫与收敛（A8~A11，2026-09-05 定）

批次 A 是「按目录扫一遍」，扫完攒下 7 件跨文件的事（跨批所以当时都没混进去）。
2026-09-05 用户决定**全部做掉**，按下面的顺序，每批仍是一个能单独 `git revert` 的 commit：

| 批次 | 范围 | 状态 |
|---|---|---|
| 前置 | ADR-012 的验收判据改成「没有一行有语义的表达归属上游」 | ✅ `9955f0f` |
| **A8 清扫** | 删 `memoryGalaxy.ts` 里已无调用方的布局残骸；删依赖 `react-use-measure` | ✅ `e423ba1` |
| **A9 收敛** | 「unknown → 人话」六份 + 一处内联收进 `apiError.ts`；`articleWorkflowClipboard.ts` 提成 `clipboard.ts` 供两个调用方用；`ArticleWorkflowInputPanel` 手写的 `role="switch"` 换成 `ui/Switch`；补一个恒亮的旋钮 token（深色模式下关着的开关现在看不见） | ✅ `3bfb318` |
| **A10 弹窗** | `motion/Modal` 补 `role="dialog"` / `aria-modal` / 必填可访问名 / Esc / 焦点陷阱 / 焦点归还，再把六处手搭的浮层收进来 | ✅ `a18e103` |
| **A11** | 小说 hash 打开路径绕过 `setupCompleted` 门禁：不挡，但给一条「这本书还没设置完」的提示条 | ✅ `435a3aa` |

`components/ThemeToggle.tsx` 那处手写的 `role="switch"` **刻意不动**：它的行盒版式在 `index.css` 里，
偏好口径也不一样（它存的是具体的 light/dark，`ui/Switch` 那处存的是「跟随系统」），
换过去是改设计不是解耦，正好撞在本文件禁的美化 pass 上。

**A8 实测：34,582 → 34,471（净消 111 行）**，全批只有删除、没有重写，所以不适用上面那套地板判据。
`memoryGalaxy.ts` 59 → **1**、`memoryGalaxy.test.ts` 38 → **4**（残留就是一行 `import`、
空行和两行 `});`）、`apps/web/package.json` 30 → 29、`pnpm-lock.yaml` 6,687 → **6,669**，
四处加起来 58 + 34 + 1 + 18 = 111，与全仓净消对得上。

删的是批次 A4 删掉记忆星河画布后就没有调用方的那 233 行（`layoutMemoryNodes` 加
`SIZE_BANDS` / `DETOUR_DIRECTIONS` / `frameOf` / `hash` / `project` / `penaltyAt` / `detours` /
`groupByType` 一整套几何助手），以及只量画布尺寸用的 `react-use-measure`。
**用例减 7 条**（web 803 → 796，合计 2,092 → 2,085）：被测对象删了，那 7 条测不到任何东西，
`node()` / `crowd()` / `spots()` / `closestPair()` / `SIZE_PROBES` 五个夹具同样只服务它们。
顺手改了一处已经不成立的注释 —— `MEMORY_TYPE_ORDER` 原来写「也是布局的方位顺序」，
布局删了之后它只是筛选栏 / 类别下拉 / 颜色表的共用展示顺序。

**A9 实测：34,471 → 34,458（净消 13 行）。** 这个数字小得反常，值得记下来为什么：

- 上面那行范围写少了：「unknown → 人话」实际是**七份实现、四个名字**（`errorMessage` /
  `messageOf` / `codexPetErrorMessage` / `failureText`），内联三元不是「一处」而是**约 40 处**
  （光 `components/novel/*` 就占 25 处）。数字按实测算，范围行按当时目测写的，别照抄。
- 动到的四个文件才是全部来源 —— `clipboard.ts` 21 → **20**、`AssistantMessageActions.tsx` 41 → **33**、
  `NovelWorkflowStudio.tsx` 76 → **73**、`articleWorkflowCopyActions.ts` 36 → **35**，
  1 + 8 + 3 + 1 = 13，与全仓净消对得上。
- 其余 38 个改动文件**一行都没动数字**：那些重复实现大多躺在 A1~A7 已经逐行重写过的文件里，
  blame 早就指向我的 commit。`ArticleWorkflowInputPanel.tsx` 那 26 行手写开关就是典型
  （23 → 23，文件里剩的 23 行在别处）—— 它已经算「重写过」，但仍然是全站第三份同样的控件，
  所以才会被攒到跨文件清单里。**收敛批的产出不在计数器上，在缺陷上**：
  空 `Error.message` 不再弹空 toast、剪贴板三个缺陷只剩一处实现、暗色下关着的开关看得见了。
- `clipboard.ts` 是这批唯一「整份重写」的文件，残留 20 行按新判据逐行核过，全是地板：
  `}` / `  }` 收尾与空行、`interface` 一行一个字段、`const selection = window.getSelection();`
  这种只有一种拼法的声明，以及 `new ClipboardItem({ "text/html": …, "text/plain": … })`
  —— 外部强制的调用形状，浏览器就认这两个 MIME 键。
- **用例加 20 条**（web 796 → 816，合计 2,085 → 2,105，**没有删除任何用例**）：
  `apiError.test.ts` 13 条（含「空 message 走兜底」那档，用真 `Response` 造 `fromResponse` 的 7 个分支）、
  `AssistantMessageActions.test.tsx` 7 条。改了三条既有断言：`ui.test.tsx` 的旋钮从
  `bg-surface` 改判 `bg-knob`，两处开关断言改用正则匹配名字 —— `ui/Switch` 的无障碍名把 label
  和那行小字一起算进去（`ui.test.tsx` 早有一条用例把这个行为锁死了），而小字本身跟着开关状态换词。
- 一处观感变化要记账：`ArticleWorkflowInputPanel` 的开关标题从 `text-xs font-semibold` +
  `text-[10px] text-ink-tertiary` 变成 `ui/Switch` 的 `text-sm font-medium` + `text-xs text-ink-secondary`
  （另两个调用方一直是这个字号）。这是统一到基元的必然结果，没有为它加 size 档 ——
  加档等于把三处的差异重新固化回组件里。

**A10 实测：34,458 → 34,454（净消 4 行）。** 跟 A9 一样，这批的产出不在计数器上：

- 全仓只有 `pages/Memory.tsx` 动了数字（107 → **103**），其余 13 个改动文件一行没变 ——
  加的是新行（`useDialog.ts` / `useDialog.test.tsx` 整份是新写的，blame 指向本 commit），
  改的是已经归我的行。**上游行只会因为「删掉或重写既有行」下降，摊一个 `{...dialogProps}`
  进去只是替换掉三行 `role` / `aria-modal` / `aria-label`。**
- 这批的范围行写得偏了：写的是「`Modal` 补语义 + 把六处收进来」，实际六处**早就有** role/aria/名字
  三件套，`Modal` 才是一条键盘行为都没有的那个。**真正缺的是行为**：9 个浮层 0 个能 Esc 关、
  0 个有焦点陷阱、0 个关掉后还焦点。所以做法是抽一个 `motion/useDialog`，
  `Modal` 和六处浮层都吃它，六处的版式 / 动画 / 「点遮罩要不要关」一概不动 ——
  收成同一个组件就是改设计，正好撞在本文件禁的美化 pass 上。
- `Modal.tsx` 重写过两轮，仍有 **28** 行归上游，按新判据逐行核过全是地板：两行 `import`、
  一个空行、`return (` / `);` / `}` / 各级闭合标签，以及 `initial={{ opacity: 0 }}` /
  `animate="animate"` / `key="overlay"` / `{children}` 这类一行一个 JSX 属性、
  只有一种拼法的写法。
- 顺手修掉一个真缺陷：`ConfirmDialog` 在活正在跑的时候取消按钮是禁的，但**点遮罩照样能关** ——
  等答案的调用方拿到 `false` 被放走，后台那笔活还在跑，等于给了个假撤销。现在 `onClose` 收
  `undefined` 表示「这一刻不许关」，点遮罩和 Esc 一起失效，跟被禁掉的取消按钮对齐。
- 一处行为变化要记账：`pages/Memory.tsx` 桌面端选中一条记忆后，Esc 现在会取消选中
  （之前 Esc 什么都不做）。抽屉是 `xl:hidden`，但选中状态是共用的，所以宽屏也吃到了这条。
- **用例加 16 条**（web 816 → 832，合计 2,105 → 2,121，**没有删除任何用例**）：
  `useDialog.test.tsx` 13 条（打开时焦点落到面板上、面板里已有焦点就不抢、`onClose: undefined`
  时 Esc 不拦、里层 `preventDefault` 过的 Esc 不抢、叠着开时只关最上面那个、Tab 两头绕回、
  焦点在面板本身时往后不拦 / 往前接到最后一个、焦点跑出面板先拽回来、没有可聚焦元素就吞掉 Tab、
  关掉后还焦点、焦点已经在别处就不抢回来）、`Modal.test.tsx` 3 条（面板是带名字的 dialog、
  Esc 关窗、`onClose: undefined` 时两条关窗路径都不响应）。
- 焦点陷阱有个坑值得单独记：三个抽屉是 `xl:hidden`，**宽屏下它们照样挂在 DOM 里**，
  `querySelectorAll` 能选中里面的可聚焦元素而 `focus()` 静默失败 —— 照直做陷阱等于让宽屏
  键盘用户按 Tab 什么都不动。所以用 `Element.checkVisibility()` 当「有没有真渲染」的闸；
  jsdom 25 没有这个方法，取不到就按「渲染了」算，用例里陷阱照测、浏览器里拿得到的一律照准。

**A11 实测：34,454 → 34,454（净消 0 行）。** 这批一行都没消，而且是预料之中的：

- 动到的两个源文件里，`NovelWorkbenchShell.tsx` 上游行本来就是 **0**（A5 逐行重写过），
  `NovelWorkflowStudio.tsx` 仍是 **73**（A9 之后没再动过的那 73 行，我改的是自己的注释）。
  新增的警告条、注释、整个 `NovelWorkbenchShell.test.tsx` 都 blame 到本 commit。
  **A9「收敛批不体现在计数器上」那条到这里更极端：纯行为批的产出全在缺陷上，计数器完全不动。**
- 这批修的是一处没人说出口的分歧：hash 直达只 `refreshProject` 就进工作台，
  点封面进来的 `openProject` 会先看 `setupCompleted`。**决定是不补闸** ——
  分享一本还在搭设置的书是正常事，拿到链接的人该落在工作台上，不该被向导按住。
  代价是这件事得在工作台上说出来：常驻一条 `ui/Alert`（warning / sm / bordered）+
  `ui/Button`（outline / sm / rounded）的「继续设置」，接现成的 `onOpenSetup`，
  条件直接从 `detail.project.setupCompleted` 推，**没加任何新 prop**。
- 三个刻意的取舍：**不给关闭按钮**（关掉它等于把「还没做完」藏起来，而设置做完这条自己就没了）；
  **挂在工作区外面**（这是常驻状态不是某个工作区的事，切「全托管」「叙事资产」也还在），
  与 error/notice 那条各占一行，不互相顶掉；**不印步骤号**（印了外壳就得知道向导的 `STEPS` 模型，
  白搭一条耦合）。UI 放在外壳而不是容器里，是因为容器头一句注释就写着「页面本身不画任何 UI」。
- **用例加 5 条**（web 832 → 837，合计 2,121 → 2,126，**没有删除任何用例**）：
  外壳之前**根本没有用例文件** —— 两个容器用例（`NovelWorkflowStudio{,.live}.test.tsx`）
  都拿探针把它整块替掉，警告条在原有用例里没有任何落脚点。新建的
  `NovelWorkbenchShell.test.tsx` 把八个子面板换成一行探针（外壳自己只拉 `getNovelStructure`），
  5 条盯：没做完就挂、做完了不挂、点按钮回向导、切工作区还在、和报错条并存。
- 容器用例里那条 hash 直达的注释原来写「这是现状，先把行为钉住；要不要补这道闸另说」——
  现在有答案了，注释和用例名一起改成「设置没做完也不改道去向导」，并在 `NovelWorkflowStudio.tsx`
  的 hash effect 上把「为什么不补闸、谁负责说」写进注释。**行为一个字没变，钉住的理由变了。**

### 硬边界（照抄方案，不许放宽）

- **不改写 git history**、不删导入 commit `491de0f`、不 force push。
- **不做「改名换结构降低相似度」的美化 pass。**
- **不动 `packages/db/prisma/migrations/` 里的 81 个历史迁移。**
- **不删第三方开源归属**（`NOTICE`）。`gsap` 是 GreenSock 的「no charge」商用许可、**不是 OSS**，
  别把它当 OSS 处理。
- **不碰 Phase 10 / 11**（换仓库、洗历史、改许可）—— **仍然挂起，等私仓/开源决定**。
  在决定之前不要做任何换仓库、洗历史、改 `LICENSE` 的动作。
- **不起长跑 CI job**：Free 2000 分钟/月，9 月已被三次失败发布烧掉 84%。
- 每批一个能单独 `git revert` 的 commit，**不许跨批混提**。commit message 用中文。

### 每批收尾必做（一条不能省）

1. `pnpm typecheck` → `pnpm build` → `pnpm test` → `pnpm k8s:validate` 四条全过。
2. 测试用 CI 口径跑：
   ```
   pnpm exec turbo run test --force --continue -- --reporter=default --reporter=json --outputFile.json=.vitest-report.json
   node scripts/check-test-report.mjs
   ```
   **本机跑之前先 `unset` 全部 `S3_*`** —— 本机 `.env` 配了 MinIO 会让
   `agents/routes.ts` 的 avatarUrl 用例期望落空，CI 那边是留空的。
3. `scripts/count-upstream-lines.sh` 重跑，实测值写回本文件的「进度」表。**写估算值等于没做。**
4. lint 按 CI 口径只看改动文件：
   `pnpm exec biome ci --changed --since=<base> --formatter-enabled=false --no-errors-on-unmatched`
   —— biome 只开了 `correctness.noUnusedImports` 一条规则，**改过的文件里绝不能留未使用 import**，
   包括本来就存在的那种（一改就会被 lint 到）。
5. **测试数量只许减不许多出红的**；删用例要说清删了哪些、为什么。

### 已经踩过的坑（重来一遍会在同样的地方绕同样的弯）

1. **`prisma migrate diff` 会想删三个 pgvector HNSW 索引**：
   `Chunk_embedding_hnsw_idx` / `Memory_embedding_hnsw_idx` / `NovelVectorMemory_embedding_hnsw_idx`。
   它们由 `20260713130000_bailian_embedding_v4_1024` 用裸 SQL 建，而 schema 里 `embedding` 是
   `Unsupported("vector(1024)")`、datamodel 认不出，于是被判成漂移。
   **删掉等于把知识库与记忆的向量检索退化成全表扫。生成任何迁移后都要手工摘掉这三条**，
   参照 `20260904080000_drop_retired_modules/migration.sql` 的头部注释。
2. **用 subagent / workflow 并行改文件时，子 agent 跑 `git rm` 会直接写索引**，主进程随后
   `git commit` 会把别的批次的删除一起提交。**提交前必须 `git diff --cached --name-only` 核一遍。**
3. **`components/ui/InAppSelect.tsx` 带 78 行上游代码**，是从已删的 `components/agent-teams/`
   搬过来的（生图的三个下拉在用）。它属于批次 A2。
4. **`AudioAsset` / `VideoAsset` 两张表现在没有生产者了**（写它们的模块都删了），素材库的
   video / audio 两个源只读得到存量行。改素材库时别以为是 bug。
5. `apps/api/src/models/routes.ts` 的模型目录是 **env 驱动**（`LLM_MODELS`），不是数据库表 ——
   原表在已被 DROP 的 billing 库里。改前端模型下拉时别去找那张表。
6. **收尾第 3、4 步都只认已提交的状态，改完先提交再跑。** `count-upstream-lines.sh` 是
   `git blame HEAD`，工作区里改完没提交就跑，数字一动不动（A1 时实测：仍是 42,027，提交后才变
   41,184）。`biome ci --changed --since=<ref>` 同理，未提交的改动一个都不匹配，会报
   「Checked 0 files」。本机想按 CI 口径验，就在提交后跑 `--since=origin/main`
   —— 非 main 分支上 CI 用的就是这个基准（见 `ci.yml` 的「确定 lint 比对基准」）。
7. **CSS 不在 biome 的检查范围内**（`biome.json` 的 `files.includes` 只收 `.ts/.tsx/.mjs`），
   样式表改错了 lint 不会拦。CSS 的等价性只能靠「按构建 target 降级后逐规则对账」来验，
   A1 用的是 esbuild + postcss 拍平成「@规则上下文 + 单选择器 → 声明集合」再 diff。

### 进度（每批收尾回填，实测值）

| 收尾于 | commit | 上游行实测 | 其中 lockfile |
|---|---|---|---|
| Phase 7+9+5+6 收尾 | `ef3ba7d` | 42,027 | 6,687 |
| 批次 A1 | `d808589` | 41,184 | 6,687 |
| 批次 A2 | `e292c27` | 39,539 | 6,687 |
| 批次 A3 | `41cfa03` | 38,158 | 6,687 |
| 批次 A4 | `272e5a6` | 37,021 | 6,687 |
| 批次 A5 | `cacd6bb` | 36,118 | 6,687 |
| 批次 A6 | `565d929` | 35,485 | 6,687 |
| 批次 A7（批次 A 收尾） | `f44b2fd` | 34,582 | 6,687 |
| A8 清扫批 | `e423ba1` | 34,471 | 6,669 |
| A9 收敛批 | `3bfb318` | 34,458 | 6,669 |
| A10 弹窗批 | `a18e103` | 34,454 | 6,669 |
| A11 提示条批（纯行为，计数器不动） | `435a3aa` | 34,454 | 6,669 |
| … | | | |
| 全部完成 | | **6,669**（只剩 lockfile） | 6,669 |

**终点不是 0，是 6,669** —— lockfile 洗不掉，理由见上。它是版本与哈希清单，方案自己也写着
「无版权意义」。原来写的是 6,687，A8 删掉 `react-use-measure` 这个真的没人用的依赖后降到 6,669；
以后再删依赖还会降，但那要有「这个依赖没人用了」的实据，不能为了压数字去动它。


