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
| **B** | `apps/api/src/agents/presets.md` | ~~6,288~~ **5,107**（实测） | 纯文本、不碰构建、**可与任何批次并行**；✅ `d736746`，剩 732 行地板 |
| **C** | api 的保留模块后端 | **13,807** | 随迭代做，无死线 |
| **D** | `packages/db`（运行时 + schema + 迁移） | **1,960** | ✅ `96dd725` + `fa7847c`，剩 1,948 行地板；历史迁移不改 |
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

#### 批次 B：`presets.md`（5,107 → 732，✅ 已完成）

`apps/api/src/agents/presets.md` 是提示词库，**100% 原样**。纯文本、不碰前端、不用跑构建，
所以**可以和任何批次并行**，也是唯一一块「不重写就永远归不了零」的自有核心资产。
重写时注意：它是各内置 Agent 的系统提示词来源，改完要跑一遍 `apps/api/src/agents/` 的测试，
并手工验一次「新建对话 → 选内置 Agent → 发一条」的行为没变味。

> 上表写的 6,288 也是错的（跟基线差 551 是两回事，这条是单独一处）：
> 收尾前实测 `HEAD~1` 该文件 **5,107 行 / 5,107 行上游**。差的 1,181 行不知道从哪来的，
> 引用批次表的 B 行时按 5,107 看。

**改完后 732 行仍归属上游，这是判据允许的地板，不是没做完。** 逐行分类（实测）：

| 还归属上游的行 | 行数 | 为什么动不了 |
|---|---|---|
| 空行 | 488 | 没有表达 |
| ` ```text ` 围栏开头 | 81 | 解析器认这个标记（`presets.ts` 的 ` /```text\s*([\s\S]*?)```/ `） |
| `---` 小节分隔 | 81 | Markdown 语法 |
| ` ``` ` 围栏结尾 | 1 | 同上（另外 80 个被 diff 判成新增了，纯属匹配巧合） |
| `## 序号. 名字` 标题 | 81 | **运行时契约**：序号进了 `Session.agentId`，`preset-1` 是 `shellState.ts` 的默认值，图标按小节顺序发。改名字要连带迁移历史会话数据，那是另一件事，不是重写 |

这 81 个标题是唯一有讨论空间的一类 —— 它们是用户可见的标识符而非表达。要归零就得改名 +
迁库，需要的话单独立项。


#### 批次 C：后端保留模块（~~13,807~~ **15,139**，✅ C1~C12 已完成）

> **上面这个 13,807 是错的，开工时才发现** —— 它连自己表内那七行都对不上（相加是 13,841）。
> 漏掉的是 `apps/api/src/agents/` 的 12 个 `.ts` **1,181 行**（那张表只把同目录的 `presets.md`
> 划给了批次 B，另外 12 个文件谁都没管），加上 `server.ts` 123 + `env.ts` 29 = 152 行，
> 共 **1,333 行**。再算上 `kb/` 实测比表里少 35 行（4,198 而非 4,233），
> `13,841 + 1,333 − 35 = 15,139`，与下面这张实测表相加的结果一致。
> 另外把 `auth/` + `storage/` 笼统的 551 拆成实测的 291 + 260。

拆成 12 个子批，每批一个能单独 `git revert` 的 commit：

| # | 范围 | 上游行 | 备注 |
|---|---|---|---|
| **C1** | `apps/api/src/agents/` 的 12 个 `.ts` | **1,181** | ✅ `18de8b2`，剩 658 行地板。`presets.md` 归批次 B，不混提 |
| **C2** | `apps/api/src/agent/` | **907** | ✅ `4ea475b`，剩 218 行地板；`runTurn` 工具循环 |
| **C3** | `apps/api/src/chat/` | **1,279** | ✅ `e858bd2`，剩 229 行地板；对话主链、会话锁与附件边界 |
| **C4** | `apps/api/src/memory/` | **2,134** | ✅ `492b90c` + `6fff0dd`，剩 588 行地板；长期记忆抽取、事务与路由 |
| **C5** | `apps/api/src/kb/` 检索 | **658** | ✅ `8626db1`，剩 121 行地板；权限集合、向量检索、分块与组合根 |
| **C6** | `apps/api/src/kb/` 入库 | **2,183** | ✅ `0e60de7` + `29d8ba4` + `b534c39` + `9c36e50`，剩 287 行地板；摄取、解析、SSRF、索引租约与 reaper |
| **C7** | `apps/api/src/kb/` routes + service + 测试 | **1,357** | ✅ `b2e72b7`，剩 204 行地板；权限写谓词、删库顺序与窄路由测试 |
| **C8** | `apps/api/src/workflow/article/` | **1,433** | ✅ `adcafc5`，剩 1,052 行地板；图文状态 CAS、事务边界与生成链路拆分 |
| **C9** | `apps/api/src/workflow/image/` + `_shared/` | **915** | ✅ `f48fbb4`，剩 701 行地板；路由拆分、尺寸映射与任务终态竞争 |
| **C10** | `apps/api/src/workflow/novel/` | **726** | ✅ `eb684a9`，剩 507 行地板；向量文档/存储拆分与生成回调顺序 |
| **C11** | `apps/api/src/admin/` | **1,663** | ✅ `fb30138`，剩 947 行地板；后台数据、知识库路由与权限边界 |
| **C12** | `auth/` 291 + `storage/` 260 + `server.ts` 123 + `env.ts` 29 | **703** | ✅ `0bb44da`，剩 327 行地板；鉴权、S3、环境配置与服务生命周期 |

**批次 C 之外新发现的一处**，不归 C 也不归 D：`apps/api/assets/workflow/local-business-promo-bgm/`
四个 `.mp3` 共 146 行「上游行」。那是二进制资产被 blame 按字节块数出来的，不是表达，
重写判据管不着它 —— 但它确实是从上游带过来的文件。要么重新生成四段 BGM，要么当第三方素材
写进 `NOTICE`。**先记在这里，不在 C 里顺手处理。**

#### 批次 D：db 运行时 + schema + 迁移（1,960 → 1,948，✅ 已完成）

`1,960` 原数是准确的：schema 282 + 迁移 SQL 1,630 + `migration_lock.toml` 3 + `package.json` 20 +
`src/index.ts` / `src/redis.ts` 20 + `tsconfig.json` 5。两份运行时文件里的重复懒单例控制流已提成第二个
调用方真实存在的 `lazySingleton`，20 → 8；剩下的是 import、导出、空行和固定错误契约。

`schema.prisma` 的 282 行逐行分类后全部是声明式契约：44 行空行、48 行 generator/datasource/model
块头与闭合、3 行 provider/url、151 行字段/关系/default、36 行 unique/index。这里没有可另写的算法或
控制流；改字段/模型会改变 Prisma Client 和数据库结构，加 `@map`、改名或重排只是在洗表达。因此 schema
保持逐字节不变，不再沿用「实际只能重写 282 行」这个错误假设。

**`migrations/` 的 81 个历史 SQL 与 `migration_lock.toml` 一个字都不改**。它们是线上库的真实演化记录；
改动会让 `migrate deploy` 与已应用迁移对不上。`96dd725` 新增确定性 SHA-256 门禁，保护截至
`20260904080000` 的 82 个文件，同时允许新增更晚迁移；这 1,633 行上游归属是刻意保留的历史地板。

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
| **B** | `apps/api/src/agents/presets.md`：81 份内置 Agent 提示词全部重写 | ✅ `d736746` |
| **C1** | `apps/api/src/agents/` 的 12 个 `.ts` 全部重写，顺带修 4 个真 bug | ✅ `18de8b2` |
| **C2** | `apps/api/src/agent/` 三个文件全部重写，修正 reset 后正文丢失 | ✅ `4ea475b` |
| **C3** | `apps/api/src/chat/` 对话主链全部重写，补齐锁续租、历史顺序与附件边界 | ✅ `e858bd2` |
| **C4** | `apps/api/src/memory/` 长期记忆后端全部重写，补齐事务、CAS 与向量边界 | ✅ `492b90c` + `6fff0dd` |
| **C5** | `apps/api/src/kb/` 检索、分块与索引组合根全部重写 | ✅ `8626db1` |

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

### 批次 B 实测与取舍（2026-09-06 收尾）

**实测：34,454 → 30,079（净消 4,375 行）。** 单文件 5,107 → 2,983 行，其中上游 5,107 → **732**，
`5,107 − 732 = 4,375`，与全仓净消对得上。`pnpm-lock.yaml` 仍 6,669。
这是 A 批之后第一批数字动得大的 —— 因为这批是真删真写，不是收敛。

**为什么 5,107 行能压到 2,983 行：原文是套印，不是 81 份提示词。** 81 个 Agent 共用同一副
63 行骨架，逐字相同的部分有：「核心能力」后四条、「工作流程」六步、「输出要求」里那份
5 段默认格式建议、「禁止事项」前四条、「通用规则」八条。每份里真正按角色写的只有四五句
（`主要负责` / 核心能力首条 / `适合处理以下任务` / 输出要求首行）。
新版按「职责 / 接什么活 / 怎么干 / 交什么 / 底线」五段写，**「怎么干」和「交什么」按角色写实**，
底线只留角色专属红线加按类型选的地板条，13 行重复压到 3~5 行。

**运行时契约一行没动**（`presets.ts` / `presets.test.ts` / `icons.ts` 都归批次 C，不许跨批混提）：

- 81 个 `## 序号. 名字` 标题**逐字未变、顺序未变** —— `git show HEAD~1:… | grep '^## [0-9]'`
  与新版 diff 结果为空。顺序不能动，图标是 `presetIconAt(idx)` 按小节序号发的。
- `主要负责：<枚举>。` 与 `你适合处理以下任务：<枚举>。` 两行的**枚举内容原样保留**。
  前者经 `summarizePrompt` 就是助手列表里那句简介 —— 那是用户可见契约，改了等于改 UI 文案。
  这两行**周围的句子全部重写**，所以归属照样离开上游（实测该文件已无一行散文归上游）。
- 实测 81 条 `id` / `name` / `description` 与改前**逐条相同**，**无一条**退到「通用智能体」兜底。

**顺手修掉三类套模板带来的真缺陷**（这才是这批除计数器以外的产出）：

- 要求「只输出结果」的 Agent 被通用格式要求「先给结论再列风险」，输出格式和职责直接打架 ——
  Linux 终端（模拟模式只该吐一个终端代码块）、Unicode 字符转换、表情符号翻译。
- 多轮互动的 Agent 套了一次性交付格式，没有每轮该输出什么的口径 ——
  面试模拟、面试官、英语口语练习和改进者、角色扮演。
- 保真类活儿（翻译成中文、英文润色、文章总结、会议摘要、观点提炼）原来没有
  「原文没有的不许添」这条，现在补上。

**用例一条没动**（2,126 passed / 23 skipped，与 A11 收尾完全一致）。
`presets.test.ts` 的两条本来就是按契约写的：`parseAgentPresets` 那条用的是自带的 2 个 Agent 内联夹具
（所以 `presets.md` 不必保留「你现在扮演」这句），`loads all bundled presets` 那条盯的是
`>= 80` 条 / `presets[0].name === "默认助手"` / 前 20 个图标互不相同 / 有一条叫「前端工程师」——
全部照过。

**手工验「新建对话 → 选内置 Agent → 发一条」**：预设解析不碰 prisma，所以直接跑真模块验的是
链路本身 —— `publicPresetAgents()` 出 81 条、无空简介、无超 160 字、前 20 个图标互不相同；
`resolveAgent` 对 `preset-1` / `preset-14` / `preset-63` / `preset-81` 出对应提示词，
对 `preset-999` 和空串都落回 `preset-1`；图标仍然对得上语义
（前端工程师 `mdi:language-javascript`、以太坊开发人员 `mdi:ethereum`、宠物行为专家 `mdi:paw-outline`）。
提示词长度从原来的 1,400+ 字降到 558~776 字。

**一件要记账的事：已有会话不会变味。** `chat/routes.ts` 建会话时把 `agentPrompt` 快照进库，
之后每轮都用库里那份，所以**旧会话继续用旧提示词，只有新建会话走新的**。
这既是好事（不会有人的对话中途换人格），也意味着想看到新提示词必须新建对话 ——
外加 `presets.ts` 有模块级缓存，改完 `.md` 要重启进程。

**留给以后的一条：安全地板在 81 份里仍然重复 81 次。** 「不编造 / 信息不足要说 / 中文回答」
这类每份都得有，因为每个围栏必须是一份自洽的系统提示词。这批只是把 13 行压到 3~5 行。
真要去重就得改成「公共底座 + 角色片段」，由 `presets.ts` 在解析时拼 ——
那要动解析器，与本批「纯文本、不碰构建」的定位冲突，也让这个资产不再自洽。**记着，别顺手做。**

### 批次 C1 实测与取舍（2026-09-06 收尾）

**实测：30,079 → 29,556（净消 523 行）。** 12 个文件的上游行 1,181 → **658**，
`1,181 − 658 = 523`，与全仓净消对得上。`pnpm-lock.yaml` 仍 6,669。
文件本身 1374 插入 / 556 删除 —— 行数是涨的，涨在注释上：这批的取舍是**把「为什么」写进代码**，
上游那版几乎不解释动机，而这个目录里有好几处「看着多余、其实不能删」的写法。

**剩下的 658 行地板分类**（`git blame` 逐行核对，不是估算）：

| 类别 | 行数 | 为什么动不了 |
|---|---|---|
| 空行 | 110 | 没有表达 |
| 纯语法行（`}` `});` `try {` `} catch {` 等） | 146 | 唯一拼法 |
| 块注释分隔符（`/**` `*/` `*`） | 14 | **注释正文一行都没剩**，只是这三种符号 |
| `import` | 18 | 依赖名与导出名是契约 |
| 其余 | 370 | 见下 |

那 370 行全部落在 ADR-012 的地板类里，抽样核对过每一类：

- **运行时契约标识符**：`name: row.name,` / `id: row.id,` / `createdAt: row.createdAt.toISOString(),`
  这类 DB 列 → API 字段的映射，两头的名字都是契约，中间没有第三种写法；
  `select: { id: true, name: true, … }` 同理。
- **外部强制的调用形状**：`return { success: true, data: … }`（全仓响应信封）、
  `app.post<{ Params: { id: string } }>("/api/agents/:id/avatar/upload", …)`（Fastify + 路由路径）、
  `if (!parsed.success) return reply.code(400).send({ error: "参数不合法" })`（Zod + 用户可见文案）。
- **格式规范决定的字面量**：三处 magic bytes 判断（PNG 的 `0x89 0x50 0x4e 0x47`、
  JPEG 的 `0xff 0xd8 0xff`、RIFF/WEBP 的 8~12 字节偏移）—— 字节值是文件格式定的。
- **刻意保留的用户可见字符串**：`"图片解析失败"` / `"只支持 PNG / JPEG / WEBP"` /
  `"智能体创建失败，请稍后重试"`，以及测试里断言这些常量的行。
- **唯一拼法的签名**：`export async function listCustomAgents(prisma: PrismaClient, userId: string)`
  这类 —— 函数名是模块的对外接口，参数就那两个。

换句话说，**动这 370 行的唯一办法就是改名换结构**，那正是本文件禁的美化 pass。

**顺手修掉 4 个真 bug**（这批除计数器以外的产出）：

1. **`ratelimit.ts` 会把用户永久锁死。** 原来只在 `n === 1` 时 `EXPIRE`。进程在 INCR 与
   EXPIRE 之间死掉，这个 key 就再也没有过期时间，那个用户的头像额度永久归零，且无任何日志。
   改成一次 `MULTI(INCR, TTL)` 后按 `ttl < 0` 补挂：round trip 数不变，还能修好老代码
   已经留在线上的无 TTL key。**没用 `EXPIRE key sec NX`** —— 那要 Redis ≥ 7.0，而 k8s 那套的
   Redis 版本在仓库里查不到（`infra/k8s/base/` 没有任何 REDIS 引用），不赌版本。
2. **`image.ts` 把部署故障报成用户的错。** `loadSharp()` 原来在 try 里，原生模块装不上时
   异常被包成 `AvatarImageError` → 前端 400「图片解析失败」→ 用户对着一台坏机器反复换图。
   挪到 try 外面，照实变成 500。
3. **`avatar.ts` 拆非法标签壳会吐畸形 XML。** 原来构造 `[existing, v]`，而 `v` 自己就可能是
   数组，于是「数组套数组」，XMLBuilder 拿到它会输出畸形标签。
4. **`avatar.ts` 会静默丢线条（本批新发现）。** 合法标签那条分支无条件 `result[key] = …`，
   所以 `<a><path d="M1 1"/></a><path d="M2 2"/>` 会把刚从壳里提上来的第一个 path 顶掉。
   3 和 4 现在共用一个 `appendChildren()`，一次修好。

另外三处不影响行为：「14 个几何/描边属性」的注释与实际的 20 个对不上（已改正并按元素分组
说明为什么排除 `fill` / `stroke` / `style` / `class` / `id`）；`generateAvatarSvg` 里第二次
````.replace(/```/g, "")```` 永远匹配不到（第一次是全局正则）；GET 处理器有个没用到的 `reply`。

**结构上只动了两处，都是为了让测试不再靠猜：**

- `AVATAR_SYSTEM` 改成导出。`routes.test.ts` 要在假网关里区分「画头像」和「生成配置」两次
  `messages.create`，原来拿 `system.includes("SVG")` 猜子串 —— 提示词一改措辞，那条分支就
  静默失效、每条用例都还是绿的。现在按常量相等判断。
- `DRAWING_TAGS` 抽成单一来源，白名单、`HAS_DRAWING_TAG` 正则、写进 `AVATAR_PROMPT` 的标签清单
  都从它派生。原来三处各写一遍，改一处漏两处不会有任何报错。

**用例 53 → 73（全仓 2,126 → 2,146 passed，skipped 23 不变）。一条没删。** 新增 20 条分两类：

- 钉住上面 4 个 bug：丢了 TTL 会被补挂、`EXEC` 返回 null 时放行（限流器故障不该锁住功能）、
  sharp 装不上时抛的**不是** `AvatarImageError`、两个拆壳合并的回归例。
- 把原来靠模糊断言守着的东西钉死：`presets.test.ts` 现在直接读 `presets.md` 数 `## N.` 标题，
  再断言「Agent 数 == 标题数」「图标数 == Agent 数」「逐位对齐」三者同时成立。
  `icons.ts` 那份靠下标和 markdown 对齐的名单**此前没有任何守卫**，运行时越界只会静默落到
  兜底图标；往 `presets.md` 中间插一个 Agent 会让后面 80 个图标整体错位一格，而以前
  `>= 80` 那条断言看不出来。同理 `routes.test.ts` 的列表用例改成断言 `presets[0]` 是
  `preset-1` 且**没有一条内置 Agent 带 `prompt` 字段**（提示词不出仓）。

`sharp 装不上` 那条用不了普通 mock —— 整个文件其余用例要真的编解码器。用
`vi.hoisted` 造一个可变开关，配 `vi.mock(…, async (importOriginal) => …)` 只替掉 `loadSharp`
一个导出，其余照用真模块。**没用 `vi.doMock` + `vi.resetModules()`**：那会造出第二份模块图，
`AvatarImageError` 变成两个不同的类，`toBeInstanceOf` 直接失去意义。

### 批次 C2 实测与取舍（2026-09-07 收尾）

**实测：29,556 → 28,867（净消 689 行）。** 本批三个文件的上游行 **907 → 218**：
run.ts 312 → 102、tools.ts 19 → 11、run.test.ts 576 → 105。
907 − 218 = 689，与全仓净消、代码提交的 689 行删除三边完全一致；pnpm-lock.yaml 仍 6,669。

**这次不是把大循环搬成几个同义函数。** runTurn 现在只管状态推进，流读取、双超时、重试、
可见文本对齐、工具执行和结果收口各自有明确边界；模型客户端依赖从整个 Anthropic 类收窄成
RunTurnClient / RunTurnMessageStream 两个实际需要的端口。测试因此能用一份小型假流直接实现契约，
不再靠双重类型断言把缺了二十多个成员的对象硬塞进类型系统。

**修掉的是同一个 reset 语义缺口的三种表现：**

1. 第一段因 max_tokens 已经流到界面，续写轮先说一句工具前说明再发 tool_use；
   原实现发 reset 会把第一段和说明一起删掉，最终界面只剩工具后的第二段，但数据库存的是
   「第一段 + 第二段」。
2. 第一段之后的续写流出半截再断线也一样：重试前的 reset 会删掉第一段，成功重试只重发本次片段。
3. 某些兼容网关的 finalMessage() 比 text 事件多最后一截；原实现只在 **零个** delta 时补发，
   有 delta 但少尾巴时，界面仍比入库文本短。

现在所有需要作废草稿的路径都执行「reset → 重放已确认正文」，最终消息比已流文本多出的尾巴则只补差值。
路由本来就同时提供 onText 与 onResetText，所以不改 SSE 协议；若调用方只提供 onText，
不会擅自重放，避免把正文追加两遍。

**既有契约逐项保留：** 默认 256 轮工具循环、4096 单次输出 token、20 次续写、60s 空闲 /
180s 总超时、失败重试 1 次；环境变量的小数取整和非法值回退；附加工具按名字覆盖内置工具；
assistant → tool_result 的消息顺序；工具失败前缀、事件状态和 token 累加口径都没改。

**剩下 218 行地板逐行分类：** 空行 71，纯分隔符与控制流语法 70，其余 77 行是依赖 import、
公开接口字段、两个错误类的稳定名称、Anthropic 工具 schema、固定测试参数与 SDK 强制调用形状。
抽样里出现最多的是 12 行 model: "glm-5.2"；再往下就是 super(message)、公开字段签名、
messages.push({ role: "user", content: results }) 这类契约。没有一行注释正文或自有算法表达归属上游。

**用例 16 → 25（全仓 2,146 → 2,155 passed，skipped 23 不变）。** 新增 9 条覆盖：
续写后工具调用、续写时断流重试、最终 delta 补齐、独立总超时、工具抛错、同名工具覆盖和两个内置工具。
两轮全仓验证都通过；第二轮按 CI 口径强制执行，7/7 workspace、0 cached、
**2,155 passed / 0 failed / 23 skipped**。

### 批次 C3 实测与取舍（2026-09-07 收尾）

**实测：28,867 → 27,817（净消 1,050 行）。** 本批原有八个文件的上游行 **1,279 → 229**：
sessions.test.ts 462 → 57、routes.ts 397 → 51、routes.empty-response.test.ts 165 → 0（用例并入
routes.test.ts 后删除）、attachments.ts 142 → 77、attachments.test.ts 49 → 23、
routes.test.ts 24 → 7、lock.test.ts 22 → 7、lock.ts 18 → 7。新拆的 sse.ts / session-routes.ts
均为 0；原先已经归零的 routes-errors、routes-runtime、routes-schemas 及其测试仍为 0。
1,279 − 229 = 1,050，与全仓净消完全一致；pnpm-lock.yaml 仍为 6,669。

**路由不再同时承担四条 API、SSE 连接管理和全部上下文拼装。** 三条会话读写路由进
session-routes.ts，SSE 头、心跳、断连和收尾进 sse.ts；routes.ts 留下单轮聊天编排。
这不是平移旧代码：主链顺序改成「校验用户与封禁 → 获取会话 → 加锁 → 解析附件与 KB 权限
→ 读取旧历史 → 事务写当前消息并 touch Session → 显式追加当前多模态消息 → 检索与生成」，
每一步的副作用边界现在能由测试单独钉住。

**修掉七组真实问题：**

1. 旧锁用 GET 后 DEL，两条命令之间租约过期时会误删新持有者；现在释放用 Lua compare-and-delete，
   token 改为 randomUUID，并用 compare-and-PEXPIRE 每 1/3 TTL 续租。release 清定时器、等待在途续租，
   并让并发调用共享同一个 Promise。
2. 封禁检查移到新建 Session 之前，封禁或已删除用户不再留下空会话。
3. 当前消息不再先落库再混入 createdAt 单字段排序；锁内先按 createdAt + id 读取旧历史，
   再事务写当前消息，并把当前多模态内容显式 append 到模型历史。
4. 写 Message 不会触发 Session 的 @updatedAt；现在每轮用户消息在同一事务里显式 touch，
   普通续聊会回到会话列表顶部。
5. KB 挂载只保存 resolveEffectiveKbIds 权限过滤后的 ID；权限解析失败不覆盖旧挂载，
   请求没带选择时会复用 Session 已保存的挂载。
6. Base64 改为线性严格校验并核对真实字节数，杜绝 Buffer.from 宽松吞掉畸形尾部；截断提示本身
   计入 12,000/24,000 字符配额，单文件 10MB 与整轮 20MB 都按解码后字节执行。
7. 工具轮次到上限时，提示现在追加到已流正文并按同一完整文本落库；释放 Redis 锁失败也不会阻止
   SSE 收尾，界面与消息库不再出现两份答案。

**剩下 229 行地板逐行分类：** 空行 70，纯括号、闭合符和分隔符 74，其余 85 行是依赖 import、
公开请求/结果字段、模型与 MIME 固定标识、Anthropic 内容块、Prisma/Fastify 调用形状及固定测试断言。
最大的 attachments.ts 77 行里，前 20 行就是公开附件契约，后面集中在视觉模型标识和 Anthropic
image source 结构；sessions.test.ts 的 57 行则以空行与 `});` 为主。没有一行注释正文或自有算法表达
归属上游。

**chat 用例 26 → 45（全仓 2,155 → 2,174 passed，skipped 23 不变）。** 测试文件从 6 个收成 5 个：
只删除了单场景的 routes.empty-response.test.ts，该场景并入 16 条主路由用例，没有删行为覆盖。
新增覆盖原子锁释放/续租、严格 Base64 与精确配额、封禁无副作用、409、SSE 首事件与 finally、
旧历史顺序、Session touch、视觉模型回退、KB 过滤/复用、记忆 citation、流式/落库对齐，以及真实数据库
上的空标题、稳定排序、50 条上限、权限和级联删除。四条常规闸门全过；强制测试 7/7 workspace、
0 cached、**2,174 passed / 0 failed / 23 skipped**。changed-files lint 按 CI 完整参数检查 361 个文件通过。

### 批次 C4 实测与取舍（2026-09-08 收尾）

**实测：27,817 → 26,271（净消 1,546 行）。** 本批 13 个文件的上游行 **2,134 → 588**，
`2,134 − 588 = 1,546`，与全仓净消完全一致；`pnpm-lock.yaml` 仍为 6,669。代码主体在
`492b90c`，收尾复核中发现 6 个未提交的同批重写文件，完成类型拆分、补一条标签边界回归后以
`6fff0dd` 收进 C4；没有混入 C5 文件。

**这批不是给 CRUD 换皮，而是把记忆写入改成可证明的一致性事务：** 抽取器只允许操作它实际看到的
前 30 条记忆；UPDATE/DELETE 带旧快照做 CAS；职业事实替换在同一个 PostgreSQL transaction-scoped
advisory lock 内完成，锁内重新查重，插入、更新、删除任一步失败都回滚。PATCH 不再先读全表、
异步算向量再伪造一个成功对象，而是按 id 读取、按五个公开字段做 CAS，并从 `UPDATE RETURNING`
返回数据库真实行；正文变化时 embedding 失败就整次拒绝，避免新正文继续挂着旧向量。

**修掉六组数据一致性和边界问题：**

1. 模型 UPDATE 只给 text 时，旧代码会把没给的 title/type/importance/tags 重置成缺省值；现在先与
   模型看过的快照合并，缺失字段就是保持。
2. UPDATE id 幻觉、越权或并发删除导致 SQL 更新 0 行时，旧代码仍会删除同类职业事实；现在 CAS
   成功后才允许清理兄弟行。DELETE 同样带快照，迟到动作不会删掉用户刚改过的新版。
3. 职业替换原来是多条自动提交语句：先删旧再插新，插入失败就永久丢旧事实；并发 addTurn 还能
   同时通过查重各插一条。现在按用户串行化，锁内复查，事务失败全回滚。
4. 搜索的三秒期限原来没有完整覆盖 embedding 与数据库查询；现在两段共用一个总期限，超时会 abort
   fetch，计时器在 finally 清掉，预计算向量也不能绕过数据库阶段期限。
5. embedding 在配置、provider 返回和 SQL 边界三层固定为真实的 1024 维，拒绝 NaN/Infinity/字符串
   坐标与非法 topK；字符上限按 Unicode code point 计算，不再把边界上的 emoji 劈成半个代理项。
6. 路由现在确认 token 对应用户仍存在且未封禁；重复 `q` 参数返回 400，不会在 try 外对数组调用 trim
   变成 500。PATCH 的 404（记录消失）与 409（并发修改）不再撒谎。

**抽取结果不再用贪婪正则猜 JSON。** 新扫描器识别 JSON 字符串与反斜杠转义，只接受唯一一个平衡数组；
两个合法数组算歧义并拒绝，`max_tokens` / refusal 的半截内容也不落库。失败日志只记 request / stop /
framing / schema 四种无内容原因，不把用户对话或 provider body 打进日志。每轮仍最多六个动作，旧字符串
数组仍兼容为 ADD，UPDATE/DELETE id 仍受可见清单约束。

**剩下 588 行地板逐行分类：** 空行 116，纯括号、闭合符、分隔符 97，依赖 import 23，其余 352 行是
公开函数/记录字段、Prisma/Fastify/Anthropic 调用形状、SQL 列名与参数占位、pgvector 的 1024 维契约、
HTTP 路径/状态码/用户可见错误字符串，以及对应固定断言。**没有一行注释正文归属上游。** 最大的
memory-store.ts 101 行集中在数据库列名、`$queryRawUnsafe` 签名、`MemoryRecord` 字段映射和 SQL 形状；
动它们只能改 API/数据库契约或做本文件禁止的改名换结构。

**用例 40 passed / 1 skipped → 49 passed / 1 skipped，全仓 2,174 → 2,183 passed，23 skipped 不变。**
一条行为覆盖没删：`memory-routes-settings.test.ts` 的两个场景并入主路由套件后才删文件；pgvector 测试
移除全表 TRUNCATE，没 DATABASE_URL 时在创建 Prisma 前跳过，有库时只删自身 randomUUID 前缀用户，
并新增真实事务回滚。收尾复核另补「标签收满八项后不再读取第九项」：一版 `filter().reduce()` 会让
最多 30 MiB 的认证 PATCH 在已有八个有效标签后仍遍历并复制数百万项，现恢复单循环提前终止。

验证：四条常规闸门全过（typecheck 8/8、build 2/2、test 7/7、k8s:validate）；最终强制测试
7/7 workspace、0 cached、**2,183 passed / 0 failed / 23 skipped**，基线通过。Biome 对本批 7 个最终
改动文件与此前 6 个文件复核均通过；`git diff --check HEAD~1..HEAD` 通过。全分支
`git diff --check origin/main...HEAD` 仍会报 16 个**此前批次**留下的 EOF 空行，其中包括本方案明令不动的
历史迁移；本批没有新增任何一条，所以没有跨批顺手改。

### 批次 C5 实测与取舍（2026-09-09 收尾）

**实测：26,271 → 25,734（净消 537 行）。** 计划里的 658 行不是 `retrieve.*` 两文件的 514 行，
而是五个文件的精确归属和：retrieve.ts 197 + retrieve.test.ts 317 + chunk.ts 44 + chunk.test.ts 51 +
deps.ts 49。五文件最终 **658 → 121**，`658 − 121 = 537`，与全仓净消完全一致；lockfile 仍 6,669。

**范围为什么包括 `chunk.*` 和 `deps.ts`：** 分块窗口直接决定检索 ordinal，`deps.ts` 则是索引器把
S3/URL → parse → chunk → embed 串起来的组合根；两者都在本批基线的 658 行里。C6 才拥有 ingest、
parse、url-fetch、indexer、reaper 及测试，C7 拥有 routes/service 及测试，本批没有碰它们。

**权限集合改成可审计的两层边界。** attach-all 只展开 `ownerType=USER && userId=当前认证用户` 的自有库；
显式 id 查询在数据库谓词上只放当前用户的 USER 与 OFFICIAL；不存在、重复、他人 USER 都不进结果。
为了保持已有 Session 数组稳定，自有 id 始终先于官方 id。无选择仍读取一次 own 集，因此数据库故障继续
透传，不能伪装成合法空选择；生产 chat 自己已有真正空选择的零查询 fast path。

**检索仍是 pgvector cosine HNSW 友好的形状：** `ORDER BY c.embedding <=> $1::vector` 原样保留，
只检索选择的 Chunk 且 joined Document 必须是 indexed，SQL 值全部走占位参数。新增的防线发生在 SQL 前：
向量必须正好 1024 个有限坐标且不能全零；topK 必须是正安全整数。没有把上限硬写成 50 —— chat 的
`KB_TOPK` 接受任意正整数，私自设 50 会让合法的 51 在 best-effort catch 里静默失去全部 KB 上下文。
原始 cosine score 合法范围按数学事实记录为 **[-1, 1]**，不再用只含正向共线向量的 fixture 误称 [0, 1]。

**修掉两处可复现缺陷：**

1. `filterRelevantChunks` 原来先 push 再检查全局上限，所以 `maxChunks=0` 仍返回第一条；现在进入循环先判容量，
   非正全局或单文档容量都返回空。
2. `deps.ts` 的整数环境变量原来直接 `parseInt`：`KB_CHUNK_TOKENS=abc` 会把窗口变成 NaN，所有非空文档
   得到零块并被永久标记失败；URL 的 maxBytes=NaN 还会关闭大小限制。现在非正、NaN、非安全整数回落默认值。

另外登记三条**不在 C5 顺手修**的既有风险：同名不同 Document 因公共 citation 没有 documentId，会共享配额
并折叠角标；chat 的三秒 `Promise.race` 不会取消正在 PostgreSQL 中执行的查询；全局 HNSW 叠加 KB/status
过滤，在大量更近的未选择行下可能召回不足。后两项要动 chat/事务/GUC 或部署 pgvector 版本，第一项要改
SQL → SSE → 前端契约，全部跨批。

**测试从 19 条改成 44 条（本批净增 25，全仓 2,183 → 2,208 passed，23 skipped 不变），一条行为覆盖没删。**
旧的“多 KB”用例第二个库没有 chunk 且只断言 `length >= 0`，topK 只断言 `<=`，overlap 只检查一个字符
可能出现 —— 三条逻辑全坏也能绿。新版用窄 fake 锁权限谓词、集合与 own-before-official；精确锁查询门控、
阈值等号、两层容量、顺序/对象身份、citation 首见；SQL fake 锁占位参数与零查询拒绝；分块按窗口、重叠、
步长与 UTF-16 边界精确断言。真实 pgvector 套件用 non-collinear 1024 维向量验证 1/0/-1 排序、topK、
indexed-only 与多 KB 隔离；fixture 全用 randomUUID 且只删自己造的行。

验证：C5 + chat 专项 **60 passed / 0 failed**；四条常规闸门全过（typecheck 8/8、build 2/2、
test 7/7、k8s:validate）；强制测试 7/7 workspace、0 cached、**2,208 passed / 0 failed / 23 skipped**，
基线通过。post-commit Biome 按 `origin/main` 检查 377 个文件通过，C5 commit 的 `diff --check` 通过。

**剩下 121 行地板逐行分类：** 空行 37、纯括号/闭合符 18、import 5、块注释分隔符 6、其余 55。
其余集中在公开类型/函数签名、`ChunkOpts`/`RetrievedChunk` 字段、SQL 的 KB/status 条件与 cosine ORDER BY、
调用者固定的 `"indexed"` 和测试 import。没有上游注释正文或自有算法表达；动这些只能改公共契约、索引查询
形状或做本文件禁止的改名美化。

### 批次 C6 实测与取舍（2026-09-11 收尾）

**实测：25,734 → 23,838（净消 1,896 行）。** C6 十个文件的计划基线 **2,183 → 287**：
ingest.ts 235→57、ingest.test.ts 32→8、parse.ts 179→21、parse.test.ts 109→23、
url-fetch.ts 288→53、url-fetch.test.ts 328→21、indexer.ts 219→41、indexer.test.ts 376→26、
reaper.ts 93→28、reaper.test.ts 324→9。`2,183 − 287 = 1,896`，与全仓净消完全一致；
lockfile 仍为 6,669。

这批因长会话和连接中断，生产代码、URL 测试、reaper 测试分别落在 `0e60de7`、`29d8ba4`、
`b534c39`，最终审查修复落在 `9c36e50`。没有为了形式上的单 commit 去 rebase 或改写历史；回退整个 C6
需按相反顺序回退这四个提交。最后一轮审查发现并补掉两处遗漏：索引器在租约已经丢失且仍有下一批
embedding 时提前返回却不清心跳定时器；URL 抓取只拒绝部分特殊地址，且重定向目标被拒绝时未显式取消
当前响应体。现在 SSRF 边界只允许公网单播，保留、文档、隧道、基准、私网、链路本地、组播等地址全部拒绝；
响应体取消和 dispatcher 销毁也受总期限约束。

**摄取与解析边界：** FILE/TEXT 写入 S3 后若建 Document 失败，会只补删本次 UUID key；文件名统一取
basename、NFC 归一并清理控制字符。扩展名与已知 MIME 建立双向矩阵，畸形 URL 稳定返回 400，非法 UTF-8、
扩展名/MIME 冲突和不支持格式成为永久失败。XLSX 保留稀疏列坐标和日期，PPTX 优先按 presentation
relationship 排序，关系缺失才按数字文件名回退。

**SSRF 与索引状态机：** 每次请求及每一跳重定向都重新解析 DNS，并把本跳全部已验证地址钉进独立
undici dispatcher，关闭校验后 fetch 的 DNS rebinding 窗口；相对重定向、标准 redirect status、总字节数和
覆盖 DNS/fetch/body 的总期限都有精确回归。每次索引用 `workerId:UUID` fencing token 抢占，租约心跳续期；
旧 worker 发布前必须在事务中按 token 锁住 Document，删除旧 Chunk、插入新 Chunk 与 indexed 元数据同事务
提交。确定性解析/向量/4xx 失败直接终态化，瞬时错误回 pending；最终尝试崩溃留下的过期 indexing 由 reaper
显式置 failed，不再永久卡在候选集合外。reaper 周期不重叠，stop 后在文档边界收手。

**C6 专项最终 62 passed / 0 failed。** C5 快照的这五份测试是 68 条，最终是 62 条：indexer 11→8、
ingest 3→10、parse 8→11、reaper 8→6、url-fetch 38→27，净减 6。删减来自把同类字面 IP、三种 claim、
瞬时失败/耗尽和候选/计数拆分用例合并成表格或单一状态机断言；reaper 的重试分类改由 indexer 专项负责，
没有删除对应行为分支。新增覆盖包括 S3 补偿、严格 UTF-8、MIME 冲突、PPTX 顺序、DNS 地址绑定、总期限、
响应体/dispatcher 清理、fencing 发布、错维向量、耗尽租约收尸和心跳丢租约清理。

验证：干净 `HEAD` worktree 上 typecheck 8/8、build 2/2、常规 test 7/7、k8s:validate 全过；最终强制测试
7/7 workspace、0 cached、**2,202 passed / 0 failed / 23 skipped**，基线通过。第一次强制测试有一条 C6
之外的 `codex-pet-generated-board-recovery.test.ts` 在并发压力下超过 5 秒；该文件单独复跑 705ms 通过，
随后完全相同、未放宽超时或并发的强制命令全绿。Biome 按 `origin/main` 检查 382 个文件通过，
`git diff --check 46480e7..HEAD` 通过。

**剩下 287 行地板逐行分类：** 空行 89、纯括号/闭合符/分隔符 106、依赖 import 4、块注释分隔符 2，
其余 86 行是公开函数/类型字段、Prisma/SQL 状态字段、HTTP/URL 协议、用户可见错误和对应固定断言。
没有一行上游注释正文；继续降低只能改公共契约、数据库形状或做本文件禁止的改名换结构。

### 批次 C7 实测与取舍（2026-09-11 收尾）

**实测：23,838 → 22,685（净消 1,153 行）。** C7 四个文件的计划基线 **1,357 → 204**：
routes.ts 220→71、routes.test.ts 614→52、service.ts 173→48、service.test.ts 350→33。
`1,357 − 204 = 1,153`，与全仓净消完全一致；四文件最终共 831 行，lockfile 仍为 6,669。

**权限不再靠先查后写。** 用户列表的数据库谓词固定为「自己的 USER 或任意 OFFICIAL」，带当前 userId
但 ownerType 异常的遗留行不会混入。改名在同一事务内用 `updateMany(id + ownerType=USER + userId)` 判定
属主，零行才报 403；删库同样按条件 `deleteMany`，`userId=null` 只代表管理端删 OFFICIAL，不能误删
`userId=null` 的其他类型。管理端官方库 CRUD 联动 12 条实测通过。

**删除先保证数据库真相，再清对象。** 整库先提交 KnowledgeBase 删除，由外键级联 Document/Chunk，随后
尽力清理 `kb/{id}/`；S3 失败不再留下「数据库记录仍在、文件已经没了」的半残状态，也不会把已经提交的
删除响应伪装成失败。单文档删除也在事务里校验 USER 属主并条件删除 Document，不再手写重复的 Chunk 删除；
路由拿到已删文档的对象位置后才尽力清 S3。真实 pgvector fixture 验证了两层级联，路由 fake 精确锁住
database→S3 顺序及 S3 失败仍返回 204。

**路由测试不再启动完整 server。** 裸 Fastify 只注册 multipart 与本文件插件，窄 mock 数据库/service/S3/
ingest/indexer，因此 C7 专项不再连接 Redis，也不依赖共享数据库中的「第一个用户/官方库」。8 个路由仍由
插件级 `requireUser` 全覆盖，原状态码和中文错误不变；文档列表与详情共用 10 个公开字段的 select，详情不再
返回 tokensUsed、lockedBy、lockedAt、attempts 等内部状态。三种 TEXT/URL/FILE 请求适配和后台 best-effort
索引均有路由级回归，摄取校验与索引算法继续由 C6 专项负责。

**C7 专项 37 → 39 passed / 0 failed。** service 12→10：属主/可读权限和 USER/OFFICIAL 删除改为矩阵式
断言，合并了逐个重复建用户的用例，同时新增严格列表谓词、空列表零聚合、原子 updateMany、S3 失败和文档
级联；routes 25→29：8 条未登录路径改为表驱动，新增 Zod、字段投影、删除顺序和后台失败回归。旧路由里
「文本超长、SSRF、exe 后缀、txt/pdf 各自成功」这些重复穿透真实摄取层的场景不再在路由套件再跑，等价行为
已由 C6 的 ingest/url-fetch/parse 测试覆盖；路由保留三种来源的适配与 `IngestError` 状态码映射，没有删掉
行为覆盖。

验证：typecheck 8/8、build 2/2、常规 test 7/7、k8s:validate 全过；常规 test 因根 `.env` 开启
`codex-pet-runner.integration.test.ts` 的 32 条长图像用例，前两次 120/300 秒只是工具超时，给足时限后
**2,213 passed / 0 failed / 23 skipped**、约 5 分 10 秒完成。最终强制测试 7/7 workspace、0 cached，
同样 **2,213 / 0 / 23**，报告防护通过。该工作区总数包含用户另行开发、未纳入 C7 提交的体验账号测试
9 条（API 6 + Web 3）；C7 自身相对 C6 的 2,202 基线净增 2 条，即提交态对应 2,204。Biome 按
`origin/main` 检查 382 个文件通过，`git diff --check HEAD^..HEAD` 通过。

**剩下 204 行地板逐行分类：** 空行 57、纯括号/闭合符/分隔符 73、依赖 import/export 8，其余 66。
其余集中在 Fastify 路径与状态码、中文错误、Prisma 字段/谓词、公开函数签名和对应固定断言；没有上游注释
正文。继续压低只能改 HTTP/数据库契约、删除必要断言或做禁止的改名换结构。

### 批次 C8 实测与取舍（2026-09-12 收尾）

**实测：22,685 → 22,304（净消 381 行）。** C8 计划基线的 15 个含上游行文件为 **1,433 → 1,052**；
其余本批改动没有改变这个基线之外的上游归属。lockfile 仍为 6,669。

| 文件 | C8 前 | C8 后 |
|---|---:|---:|
| `article-workflow-routes.test.ts` | 270 | 269 |
| `article-workflow-routes.ts` | 156 | 95 |
| `article-workflow-test-helpers.ts` | 135 | 130 |
| `article-workflow-image-manifest.ts` | 115 | 56 |
| `article-workflow-llm.ts` | 112 | 61 |
| `article-workflow-runner.ts` | 97 | 55 |
| `article-workflow-html-guard.ts` | 95 | 69 |
| `article-workflow-prompt.ts` | 82 | 61 |
| `article-workflow-images.ts` | 70 | 35 |
| `article-workflow-html-visible-text.ts` | 70 | 26 |
| `article-workflow-serializer.ts` | 63 | 51 |
| `article-workflow-shared.ts` | 62 | 62 |
| `article-workflow-schema.ts` | 59 | 42 |
| `article-workflow-html-guard.test.ts` | 29 | 29 |
| `article-workflow-store.ts` | 18 | 11 |
| **合计** | **1,433** | **1,052** |

**状态写入收敛为基于 `updatedAt` 的 CAS/租约。** runner、重试、改稿、重生图和补图在发布结果时都带上
自己读取到的版本时间；旧任务的条件更新为零行时不再覆盖新状态。reaper 同样把 `updatedAt` 放进回收条件，
避免把已经被新 worker 恢复的任务误判为过期。这个边界覆盖了正常生成和恢复路径，解决的是异步任务完成顺序
与数据库最终状态不一致的问题。

**批次和删除改为原子事务。** 多平台批次创建在同一事务中完成，任一平台不能创建时不留下半批记录；批次
删除也在事务内按状态与版本条件执行，避免并发请求造成部分删除或旧请求清掉新状态。相关数据库操作先提交
真相，再执行后续副作用，失败时不会把已经提交的状态伪装成未完成。

**生成链路按职责拆分。** 读路由、路由动作、HTML runner、LLM 响应解析、模型 schema，以及 HTML policy/
repair 各自收敛到独立模块；原有 runner 和 routes 保留编排职责。拆分后的入口仍保持原 HTTP 契约、平台
输出和错误映射，降低单文件修改的竞态影响面，也让状态条件更新集中在 store 层。

**C8 专项测试覆盖竞态与事务回归。** 新增 store 回归测试，补齐旧状态不能覆盖新状态、版本条件删除和批次
原子性的断言；routes 测试合并重复搭建并保留三平台主流程，reaper 测试锁住时间条件。专项共 **15 个测试
文件、133 passed / 0 failed**，没有以删减行为断言换取行数下降。

验证：`pnpm typecheck` **8/8**、`pnpm build` **2/2**、常规 `pnpm test` **7/7**、`pnpm k8s:validate`
全过；常规测试为 **2,221 passed / 0 failed / 23 skipped**。按 CI 口径禁用缓存的强制测试为 **7/7
workspace、0 cached、2,221 passed / 0 failed / 23 skipped**，`check-test-report.mjs` 与基线一致。
Biome 按 `origin/main` 检查 **393 个文件**通过，C8 提交的 `diff --check` 通过。

本批提交新增 **8 个文件、568 行**，分别承载 HTML policy/repair、LLM 响应与 schema、读路由/动作、HTML
runner 和 store 测试；这些行均不是导入 commit 的上游归属。其余 16 个既有文件按现有职责完成收敛，未改写
git history、未触碰迁移目录，也未混入体验账号改动。

**剩下 1,052 行地板逐行核对：** 其中包含未参与 C8 结构变更但仍属于 article workflow 公共契约的 shared、
HTML guard 测试，以及拆分后保留的空行、语法闭合、公开类型/函数字段、Prisma/状态字段、HTTP/URL 协议和
固定行为断言；没有可直接删除的上游注释正文。继续压低只能改变公共契约、数据库状态形状或做硬边界禁止的
改名换结构。

### 批次 C9 实测与取舍（2026-09-15 收尾）

**实测：22,304 → 22,090（净消 214 行）。** C9 计划范围 **915 → 701**；剩余 701 行中，
`image-routes.test.ts` 460、`image-service.test.ts` 215，两份既有行为测试占 675 行；生产代码只剩
`image-upstream-options.ts` 18 与组合入口 `image-routes.ts` 8 行。

**路由和配置按职责重组。** 原 428 行路由拆成资源路由、任务路由、共享上下文三个模块，入口只保留注册顺序
和 reaper 生命周期；宽高比/分辨率从逐尺寸平铺表改为「宽高比 → 三档尺寸」并反向生成索引，模型专属与通用
计费 key 仍保持原契约。任务发布改用 `id + running` 条件更新，取消已经胜出时旧 worker 会停止发布，不能再
把 `cancelled` 覆盖成 `completed` 或 `failed`。

最终 C9 范围专项 **9 files / 123 passed**；整仓最终强制测试也覆盖该提交。剩余生产行都是公开尺寸、状态与
组合入口契约，其余为固定测试夹具和断言，没有上游算法表达。

### 批次 C10 实测与取舍（2026-09-15 收尾）

**实测：22,090 → 21,871（净消 219 行）。** C10 计划范围 **726 → 507**。向量记忆从单文件拆为文档快照、
数据库存储、公开类型与编排四层：按 `(sourceType, sourceId)` 对齐内容哈希，只重算变化项，显式删除当前项目的
陈旧行；检索限制最多 8 条并把数据库分数归一为 number，正文裁剪按 Unicode 字符而不是 UTF-16 单元。

生成器保持非流式/流式请求契约，同时把 chunk 回调串行化；回调失败会中止上游流并优先回抛真实回调错误。
章节标题推导、JSON 提取、token 预算和提示词结构也重新组织，但没有改变已有业务入口。最终 C10 专项
**10 files / 40 passed**；剩余 507 行集中在未改 HTTP 契约的 routes、对应测试、公开字段和固定生成文案。

### 批次 C11 实测与取舍（2026-09-15 收尾）

**实测：21,871 → 21,155（净消 716 行）。** C11 计划范围 **1,663 → 947**。官方知识库路由拆成库、文档和
共享上下文，S3 继续懒加载；用户详情拆为 activity 与 timeline 并并行读取，服务层只返回明确投影，不外泄
`passwordHash`。公告、用户和知识库对不存在资源稳定返回 404。

管理员 guard 改为可判别结果，严格区分 401 与 403；普通管理员不能通过显式 permissions 获得
`ADMIN_MANAGE`，管理员 token 拒绝非法 ID、非数字/不安全过期时间和多余字段。C11 专项
**11 files / 54 passed**；提交时四条常规闸门全过，API **1,145 passed / 18 skipped**。
剩余 947 行以 11 份路由/服务测试、HTTP 路径、Prisma 字段和中文契约文案为主。

### 批次 C12 实测与取舍（2026-09-15 收尾）

**实测：21,155 → 20,779（净消 376 行）。** C12 计划范围 **703 → 327**。33 个 API 文件提交为
`0bb44da`：auth 拆成账号、体验账号与共享上下文，storage 拆成配置、对象、文件流和类型，env 拆成文件加载与
校验，server 拆成鉴权、基础插件、路由、后台任务、健康检查、错误边界和生命周期，原入口均保留兼容导出或
编排职责。

**鉴权与存储竞态收口。** 普通注册直接依赖数据库唯一约束，username 冲突返回 409、UID 冲突换号重试；体验
账号同样区分 username/UID 并发，复用胜出账号前必须验密码。用户 token 拒绝非数字/不安全过期时间，以及
空 ID 或含分隔符的 ID。`deletePrefix` 遍历全部 S3 分页并拒绝重复 token；流下载校验上限和
Content-Length，提前拒绝时释放响应体，失败只删除本次新建的半成品，不会误删原有目标文件。

**启动和关闭顺序明确化。** `listen()` 失败会清理 Fastify 与共享连接；收到信号时先等待 `app.close()` 完成
全部 `onClose`（包括两个 reaper），再并行断开 PostgreSQL/Redis。body/upload limit 只接受正安全整数，
OpenAPI、业务路由和 UI 的注册顺序保持不变。C12 同时纳入此前工作区已有的体验账号 API 后端改动，因为 auth
组合入口已依赖它；Web、`.env.example` 与部署文档未混入本提交。

C12 专项 **10 files / 67 passed / 1 skipped**，唯一跳过项是真实 S3 往返。最终四条常规闸门通过：
typecheck **8/8**、build **2/2**、test **7/7**、k8s:validate；强制 CI 口径 **7/7 workspace、0 cached、
2,252 passed / 0 failed / 23 skipped**，报告基线通过。Biome 按 `origin/main` 检查 **453 个文件**通过，
提交与文档 diff 均通过 `diff --check`。

**剩下 327 行地板：** 五份既有测试占 279 行（S3 91、auth routes 86、UID 49、public URL 34、token 19）；
生产入口和兼容文件共 48 行（UID 15、public URL 13、server 10、token 9、auth routes 1）。新增的拆分模块均为
0 行上游归属。残留内容是测试夹具/固定断言、公开函数签名、协议字段、错误文案和组合入口，没有可继续重写的
上游算法表达。

**批次 C 总账：15,139 → 5,839 行地板，净消 9,300 行；全仓从 C 开始前的 30,079 降至 20,779。**
C1~C12 均已有独立可回退提交和实测记录，批次 C 至此完成；5,839 行残留已在各子批逐项归类，不以改契约或
改名换结构的方式继续压数。

### 批次 D 实测与取舍（2026-09-16 收尾）

**实测：批次范围 1,960 → 1,948（净消 12 行），全仓 20,779 → 20,767。** 开工复核发现，原计划的
1,960 不只是 schema + 迁移：还包含 `packages/db/package.json` 20 行、`src/` 20 行和 `tsconfig.json`
5 行。前一版交接只统计 1,915 行 schema/迁移，漏掉这 45 行；逐文件审计后，真正需要重写的是 Prisma 与
Redis 两份重复的懒加载单例控制流。`fa7847c` 将它们收敛到两处调用的 `lazySingleton`，公开的
`getPrisma()` / `getRedis(url?)` 契约以及「首次参数生效、后续复用」语义不变。

**剩余 1,948 行全部是地板：** schema 282；81 个历史 `migration.sql` 1,630；
`migration_lock.toml` 3；包清单与 tsconfig 25；运行时残留 8（两个外部 import、三个空行、两个公开导出和
`REDIS_URL is required` 错误契约）。新 `lazy-singleton.ts` 为 0 行上游归属。schema 的 282 行分类为
空行 44、块头/闭合 48、provider/url 3、字段/关系/default 151、unique/index 36；其中两条字段带行内契约
注释，但不另加计数。

**历史迁移改为机器门禁。** `96dd725` 新增 `pnpm db:migrations:verify`，对截至
`20260904080000` 的 81 个 SQL 与 `migration_lock.toml` 按排序后的相对路径和原始字节计算聚合 SHA-256
`34839a95a12053710d5a820ece70630bb63bddc51f9774f3db021bdb7011fe0b`，并在根 `pnpm typecheck`
最先执行。新增更晚迁移不会触发，删除、改名或改动任一历史文件都会失败。

数据库实测：`prisma validate` 通过，`prisma migrate status` 识别 81 个迁移且数据库为最新。schema 与
数据库的已知差异仍只有 `Memory_embedding_hnsw_idx`、`Chunk_embedding_hnsw_idx`、
`NovelVectorMemory_embedding_hnsw_idx` 三个 Prisma datamodel 无法表达的 pgvector HNSW 索引，未生成
删除迁移。最终四条常规闸门通过；强制 CI 口径 **7/7 workspace、0 cached、2,252 passed / 0 failed /
23 skipped**，报告基线通过；Biome 按 `origin/main` 检查 **457 个文件**通过。

**Phase 8 A~D 至此全部完成。** 完成判据是「没有一行有语义的表达归属上游」，不是数字归零；D 的
声明式 schema、不可变迁移和包契约与 A~C 已逐项归类的残留一样，不通过改契约或美化 pass 继续压数。

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
8. **改完 `presets.md` 看不到变化是正常的，有两层缓存**：`presets.ts` 有模块级 `cache`
   （要重启进程），`chat/routes.ts` 建会话时把 `agentPrompt` 快照进 `Session` 表
   （旧会话永远用旧提示词，必须**新建对话**才走新的）。别以为是没生效。
   验证时别去建会话发消息，直接跑 `resolveAgent` / `publicPresetAgents` 更快也更准。

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
| 批次 B（`presets.md` 81 份提示词重写） | `d736746` | **30,079** | 6,669 |
| 批次 C1（`agents/` 的 12 个 `.ts`） | `18de8b2` | **29,556** | 6,669 |
| 批次 C2（`agent/` 工具循环） | `4ea475b` | **28,867** | 6,669 |
| 批次 C3（`chat/` 对话主链） | `e858bd2` | **27,817** | 6,669 |
| 批次 C4（`memory/` 长期记忆） | `492b90c` + `6fff0dd` | **26,271** | 6,669 |
| 批次 C5（`kb/` 检索） | `8626db1` | **25,734** | 6,669 |
| 批次 C6（`kb/` 入库） | `0e60de7` + `29d8ba4` + `b534c39` + `9c36e50` | **23,838** | 6,669 |
| 批次 C7（`kb/` routes + service） | `b2e72b7` | **22,685** | 6,669 |
| 批次 C8（图文工作流） | `adcafc5` | **22,304** | 6,669 |
| 批次 C9（生图工作流） | `f48fbb4` | **22,090** | 6,669 |
| 批次 C10（小说工作流） | `eb684a9` | **21,871** | 6,669 |
| 批次 C11（后台模块） | `fb30138` | **21,155** | 6,669 |
| 批次 C12（基础设施，批次 C 收尾） | `0bb44da` | **20,779** | 6,669 |
| 批次 D1（历史迁移完整性门禁） | `96dd725` | **20,779** | 6,669 |
| 批次 D2（db 运行时，Phase 8 收尾） | `fa7847c` | **20,767** | 6,669 |
| Phase 8 A~D 全部完成 | `fa7847c` | **20,767**（lockfile + 各文件地板） | 6,669 |

**终点不是 0，也不只是 6,669；Phase 8 收尾实测是 20,767。** 其中 lockfile 6,669 行洗不掉，
理由见上：它是版本与哈希清单，方案自己也写着「无版权意义」。原来写的是 6,687，A8 删掉
`react-use-measure` 这个真的没人用的依赖后降到 6,669；以后再删依赖还会降，但那要有「这个依赖
没人用了」的实据，不能为了压数字去动它。

**除 lockfile 外还有一层地板：逐行重写过的文件里那些「只有一种拼法」的行，以及不可改的历史迁移。**
`Modal.tsx` 28 行、`clipboard.ts` 20 行、`presets.md` **732 行**都是这种。
`presets.md` 那 732 行占比大得扎眼（占该文件的 24.5%），是因为 Markdown 的语法行密度本来就高
（488 个空行 + 81 个 ` ```text ` + 81 个 `---`），加上 81 个属于运行时契约的名字标题。
批次 D 另有历史迁移 1,633 行、schema 声明 282 行、包/编译契约 25 行和运行时契约 8 行。
**判 ADR-012 达标要看「有没有一行有语义的表达归属上游」，不能拿总数除总行数当指标。**
