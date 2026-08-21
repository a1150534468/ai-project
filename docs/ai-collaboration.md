# AI 协作标准

本项目与 AI（Claude Code / Codex 等）协作的统一规范。**目标不是限制 AI，而是让"好模式被复用、坏模式不扩散"有机制保障** —— 本项目已经积累了不少高质量模式（reaper 兜底、模型硬合同、租约抢占），问题一直是它们没被横向推开。

> **激活方式**：本文件若要被 Claude Code 自动加载，需复制或软链到仓库根的 `CLAUDE.md`。**2026-08-17 起 `docs/*` 已解除 gitignore、全部入库**（整治计划 P1.4 Step 3 完成），新成员和新会话可读到此标准；`CLAUDE.md` 软链是否建立仍待项目所有者决定。

---

## 0. 已定的决策，不要重开讨论

AI 每次新会话都没有记忆，最容易犯的错就是重新提议已经被否掉的方案。以下是已拍板的：

| 决策 | 内容 | 出处 |
|---|---|---|
| **编排框架** | 存量工作流（codex-pet / novel / article 等）**不迁框架**，只做代码优化；**新工作流**才走框架选型（倾向 Inngest 类轻量 durable 引擎，定型前需再调研） | `docs/orchestration.md`，2026-07-27 拍板。该决策推翻了 `docs/decisions.md` 的 ADR-004 |
| **计费语义** | `reserve → work → 写终态 → settle`，失败走 `refundResource`（按 `operationId` 幂等）。次序与幂等口径不动 | 阶段 4 执行记录 |
| **钱在 Go 侧** | `services/billing` 独立管账，TS 侧 `packages/billing` 只做瘦客户端（446 行）。不要在 TS 侧重新实现计费逻辑 | 现状即约定 |
| **不做 history rewrite** | `.cc-tmp` 的 220MB 已在 git 历史里，只阻止继续增长，不重写历史 | 整治计划 P1.3 |

**讨论存量工作流改动时不要再建议迁框架。新工作流立项时主动提示走框架选型。**

---

## 1. 开工前（每次会话，无例外）

### 1.1 必须先 source `.env`

```bash
cd "/Users/z/code/ai project" && set -a && . .env && set +a
```

不做这一步，测试结果**不可信**。本项目有两种截然不同的失效方式，已实测确认：

- **响亮失败**：`admin/*` 等在缺 `DATABASE_URL` 时 Prisma 初始化报错，一眼可见。
- **静默跳过 = 假绿（危险）**：**12 个测试文件**用 `describe.skipIf(!databaseEnabled)` 守卫，缺 env 时**静默消失且退出码 0**。实测两个 codex-pet 文件在无 env 下报 `2 passed | 4 skipped` —— 只看"绿不绿"会误报成功。

### 1.2 确认绿基线

先跑一次再动手，区分"我改坏了"和"本来就坏"。**当前 `main` 是绿的**（2026-08-22 最近一次 CI：`passed 2542 / failed 0 / skipped 23`，workspaces 10/10，基线下限 2411）—— 早前 P0.1 记的两处红（`apps/web` `codexPetApi.test.ts`、`codex-pet-routes.integration.test.ts`）已修完。

本地全量跑会有 **12 例稳定失败**，是本地环境造成的假红，不要去"修"：`admin/resource-routes` 7 例、`admin/membership-routes` 3 例、`admin/code-routes` 1 例期望计费服务不可达而本地 `BILLING_BASE_URL` 指着活的 :8093；`agents/routes` 1 例同理（本地 minio 活着）。CI 上这 12 例是绿的。

### 1.3 读三份文档

- `docs/pitfalls.md` —— 踩坑库。**改任何涉及上游模型调用的代码前必读**，里面记着 60s 中继读超时、模型静默回退、embedding 维度迁移这类会浪费半天的坑。
- `docs/overview.md` —— 系统全貌。
- 对应域的文档 —— `docs/codex-pet.md` / `novel.md` / `dub.md` / `image.md` / `ecom.md` / `billing.md` / `chat.md` / `wechat.md`。

---

## 2. 计划先行

**超过"改几行"的任务，先写计划文档，评审通过再动手。**

位置：`docs/superpowers/plans/YYYY-MM-DD-<主题>.md`。格式照抄现有两份（`2026-07-27-legacy-workflow-optimization.md`、`2026-08-03-architecture-remediation.md`），它们已经定型：

1. **Architecture 段**：一句话说清阶段划分与递进逻辑
2. **范围边界（明确不做什么）** —— 防 scope creep 最有效的一节
3. **全局验证纪律** —— 具体命令，不是"跑测试"
4. **任务 → Step，全部 `- [ ]` 可勾选**，每步给到文件名 + 行号 + 具体符号名
5. **每任务一 commit**，附 commit message
6. **门面兼容契约**（重构类任务）—— 明确列出"哪些文件一行都不能改"作为成功判据
7. **风险与回滚**
8. **执行记录** —— 完成后回写实际偏差（见 §7）

**计划要写到"另一个 AI 不需要重新调研就能执行"的粒度。** 判据：如果执行者需要再花一小时搜代码才知道改哪儿，计划就不够细。

---

## 3. 提交与回滚

- **一个任务一个 commit**，任何一步变红即 `git revert` 单个提交，不影响已完成部分。
- **不要一次性全仓机械替换。** 按域/按模块逐个提交（`refactor(auth): novel 域鉴权收敛`），不要 `refactor: 全站鉴权收敛`。
- Commit message 用中文，`type(scope): 说明` 格式，与现有历史一致（`fix(codex-pet): 按次计费下不再花钱不出图`）。
- **不代为提交无关改动。** 工作区常有他人未提交的文件，开工前若发现，请项目所有者自行处理，不要顺手 `git add .`。
- 除非明确要求，**不 push、不建 PR**。

## 4. 验证分层

```bash
pnpm typecheck                                  # 秒级，基线 11/11，改完立刻跑
cd apps/api && pnpm vitest run src/workflow/<域>  # 定向，改哪跑哪
pnpm test                                       # 全量，仅阶段收尾
```

### 报告纪律（硬性）

- **必须同时报 passed / failed / skipped 三个数字。** 只报 passed 的视为无效报告 —— 见 §1.1 的假绿陷阱。
- **不许把环境问题说成通过，也不许说成代码缺陷。** 缺 `DATABASE_URL` 导致的失败要明确标注为环境问题。
- **没跑就说没跑。** 禁止用"应该可以"代替执行结果。
- **改动涉及计费的，必须跑计费相关测试并贴出结果。**

---

## 5. 代码边界规则

### 5.1 新代码放哪

| 情况 | 位置 |
|---|---|
| 某个业务域独有 | `apps/api/src/workflow/<域>/`（P2.1 已完成目录化，根目录只剩 13 个域子目录）。**域外只能从 `<域>/index.ts` 门面 import，不许直接引内部实现文件** |
| 跨域共用（后端） | `workflow/_shared/`（判据是**实测有 ≥2 个域消费且属基建**，不看文件名前缀）或 `apps/api/src/shared/` |
| 前后端共用的**类型契约** | `packages/<域>-workflow/`。这是本项目已验证有效的模式（`article-workflow` / `novel-workflow` / `connector-protocol` 三个包确实双端消费） |
| 前端基础组件 | `apps/web/src/components/ui/`（当前仅 2 文件 198 行，急需加厚） |
| 前端 HTTP 调用 | 走统一 `http.ts`，不要新建第 14 个 API 模块 |

### 5.2 不要轻易提新 package

`packages/codex-pet-pipeline` 是反例：3781 行、**只被 `apps/api/src/workflow` 一个目录消费**，独立成包没带来复用，只带来构建依赖和 import 绕行。

**提包的判据：确实有 ≥2 个 app 消费。** 只是"想把代码分开"就用目录，不用包。

### 5.3 禁止跨域 import 内部实现

`dub` 不许 import `codex-pet` 的内部文件。域间只走 `<域>/index.ts` 门面或 `_shared/`。

---

## 6. 红线（违反即 review 打回）

### 6.1 计费红线

- **任何 `reserve` 扣费的新流程，必须同时交付超时兜底**（reaper 或等价机制）。这是本项目最贵的教训：进程重启 → 任务卡死 → 用户已扣费但拿不到货。
- **`operationId` 必须可重建或落库**。可重建更好（image 的 `image:${requestId}` 就是好例子，天然幂等）；不可重建就必须有 `billingOperationId` 列。
- **reaper 一律照抄 `article-workflow-reaper.ts`**：`updatedAt` 当心跳 → 按原状态条件 `updateMany` 抢占 → `count === 1` 才退款 → Redis `SET NX EX 55` 互斥 → `setInterval` 60s、**不加 `void tick()`**。不要另创设计。
- **外部异步任务（有 `providerTaskId` 那类）不能简单"超期即置 failed"** —— 会把还在上游正常跑的长任务误杀退款。必须先核对上游真实状态。
- **不在重构提交里顺手改计费口径。** 发现口径不一致 → 停下来报告。

### 6.2 类型红线

- **禁止 `as unknown as { ... }` 绕过类型**。当前 `apps/api` 有 166 处 `as unknown as`，其中 69 处是同一个 `(req as unknown as { userId: string })` —— 等于在类型系统上挖了 69 个洞。正确做法是扩展 `FastifyRequest` 接口。
- **保持 `any` 的低水位。** 107K 行 `apps/api` 目前仅 232 处、零 `@ts-ignore`，这是项目的强项，别破坏。
- **路由入参用 zod `safeParse`，不用手工 `as { ... }` 断言**。当前 416 处手工断言意味着那些路径的请求体完全未校验。

### 6.3 复制粘贴红线

**同一段逻辑出现第三次就抽取。**

本项目已经付出代价：`isRecord` **7 份**且**语义漂移**（有的排除数组有的不排除 → 同名函数行为相反）、`safeErrorMessage` 7 份（截断 500/300/不截断）、`estimateInputTokens` **6 份且涉及计费口径**。

抽取时注意：**不要无脑统一成"最严格"或"任意一份"** —— 那会改变现有行为。逐个调用点核对，行为不同的拆成两个语义明确的函数。**用户可见的文案（错误提示等）保留为参数，不要统一掉。**

### 6.4 错误处理红线

- `.catch(() => null)` 只用于**真正的 best-effort 清理**（删对象、取消订阅）。当前 174 处里多数合理，但 `admin/user-detail.ts` / `admin/analytics-routes.ts` 把 billing 故障静默转成 `null`，导致**管理后台显示空白而非报错**，运维会误判成"这用户没数据"。**依赖外部服务的读取失败要能被区分出来。**
- 用 `app.log` / `request.log`（当前 142 处），不要用 `console.*`（当前仍有 54 处绕过结构化日志）。

---

## 7. 收尾（Definition of Done）

任务完成必须满足：

- [ ] `pnpm typecheck` 通过
- [ ] 相关域测试通过，**报告含 skipped 数**
- [ ] 新增/改动逻辑有测试覆盖。前端尤其注意：`apps/web` 测试比仅 0.25、`apps/admin` 0.11，**回归信号弱，必要时人眼验收**
- [ ] 若涉及 `reserve` 扣费 → **有超时兜底**（§6.1）
- [ ] 若踩到新坑 → **回写 `docs/pitfalls.md`**，按「现象 / 根因 / 修法 / 预防」四段式，与现有条目格式一致
- [ ] 若执行中偏离了计划 → **回写计划文档的「执行记录」段**，说明偏差与原因。阶段 4 的执行记录是范本：它记了 4 条偏差（未用 `migrate dev`、省掉 `void tick()`、改用回调而非返回值、跳过 settle 落成退款）+ 1 条已知残留，每条都说明了"为什么这样更安全"
- [ ] 若产生新的架构决策 → 更新 `docs/decisions.md`

### 数据库迁移特别注意

dev 库存在与业务无关的历史 drift（`LocalBusinessPromoRun`、`NovelKnowledgeFact` 的索引名）。**`prisma migrate dev` 会要求 reset 整个 schema，禁止执行。**

安全做法（阶段 4 已验证）：手写 `packages/db/prisma/migrations/<ts>_<name>/migration.sql` → `prisma db execute` → `prisma migrate resolve --applied` → `prisma generate` → `psql \d` 核对。**不执行任何 reset。**

---

## 8. AI 协作专项

### 8.1 给 AI 的上下文该包含什么

启动一个任务时，至少给：① 目标与验收标准；② 相关文件路径（不要让 AI 猜）；③ `docs/pitfalls.md` 里相关条目；④ 已定决策（§0）中相关的那条。

### 8.2 AI 必须遵守

- **先调研再动手**，不要基于猜测改代码。声称"某处如何工作"之前先读那个文件。
- **报告要给证据**：贴命令输出，不要只说结论。说"测试通过"要附 passed/failed/skipped。
- **不确定就说不确定**，不要用自信语气填补空白。
- **不顺手改无关代码**。发现别的问题 → 记下来单独报告，不塞进当前提交。
- **同一方法失败两次就停下换路子**，并说明根因，不要反复微调。
- **不要为了整齐而过度工程**。不扣费的域不需要 reaper；只有一个消费方的代码不需要提包；重复两次的代码还不到抽取时机。
- **区分"我改坏了"和"本来就坏"**，见 §1.2 的已知红灯清单。

### 8.3 多 Agent 并行

多个 AI 同时改同一批文件必然冲突。并行前先确认**文件级不重叠**（如"A 改 `workflow/dub/*`、B 改 `workflow/image/*`"可以；都改 `codex-pet-*` 不行）。整治计划里已标注阻塞关系（P2.1 必须等 P3 阶段 1）。

---

## 9. 文档地图

| 文件 | 内容 |
|---|---|
| `docs/overview.md` | 系统全貌 |
| `docs/pitfalls.md` | **踩坑库，改上游调用前必读** |
| `docs/decisions.md` | 架构决策记录（ADR）。注意 ADR-004 已被 2026-07-27 决策推翻，待改写 |
| `docs/orchestration.md` | 编排框架决策与分析 |
| `docs/design-system.md` | 设计系统规范。**新增颜色/动效 token 必须先更新此文件再进组件** |
| `docs/superpowers/plans/` | 执行计划 |
| 域文档 | `codex-pet.md` / `novel.md` / `dub.md` / `image.md` / `ecom.md` / `billing.md` / `chat.md` / `wechat.md` / `fanout.md` |

**注意**：`docs/*` 已于 2026-08-17 解除 gitignore，**23 份文档全部入库**（含 4204 行的 `dub.md`、3283 行的 `novel.md`），整治计划 P1.4 Step 3 完成。目录是扁平的，没有 `docs/setup/` `docs/reference/` `docs/lessons/` 这些子目录 —— 写链接前先 `git ls-files docs` 确认文件真的存在，仓库里曾经因此攒下 7 条死链（`DESIGN.md` 1 条、根 `README.md` 4 条、`infra/k8s/**` 2 条，已于 2026-08-22 清零）。
