# 计费系统（billing）

> 自包含模块文档：Go 独立计费服务的架构、语义、客户端用法、学习模式运维。

## 一、为什么独立成服务

整个 monorepo 里唯一的非 TypeScript 服务：**Go + Gin**，端口 8093，独立 PostgreSQL。

- **账本独立**：钱的记录与业务数据物理隔离，业务库出问题不影响对账。
- **语义集中**：reserve/settle/refund 的幂等与并发控制只在一处实现，所有业务线复用。
- **技术自由**：Go 的并发模型适合账本这种强一致小接口集。

API 通过内部 token 以 HTTP 调用，TS 侧薄客户端在 `packages/billing/`。

## 二、核心语义

### Token 计费（对话类）

```
reserve(operationId, userId, type, model, inputTokens, maxOutputTokens)  # 按最大输出预扣
→ 调模型
→ settle(operationId, userId, model, inputTokens, outputTokens, cache*)  # 按实际用量结算，多退少补
```

### 资源计费（生图/视频/配音等按次资源）

`/resource/charge`、`/resource/reserve`、`/resource/settle`、`/resource/settle-video`、`/resource/refund`。失败必须 refund，且 finalize 要幂等。

- `operationId` 是幂等键，重复调用不重复扣款。
- 双账户体系：`points`（算力点）与 `video`（视频点）。
- 余额不足返回专用错误，TS 客户端抛 `InsufficientBalanceError`，前端据此弹充值引导。


## 计费服务（services/billing）

整个 monorepo 里唯一的非 TypeScript 服务：Go + Gin，端口 8093，独立 PostgreSQL。API 通过内部 token 以 HTTP 调用，TS 侧客户端在 `packages/billing`。

### 为什么独立成服务

- **账本独立**：钱的记录与业务数据物理隔离，业务库出问题不影响对账。
- **语义集中**：reserve/settle/refund 的幂等与并发控制只在一处实现，所有业务线复用。
- **技术自由**：Go 的并发模型适合账本这种强一致小接口集。

启动时自举默认数据：模型注册表 SeedDefault、资源价格 EnsureDefaultResourcePrices、VIP 等级 EnsureDefaultLevels（`main.go`）。

### 核心语义

**Token 计费**（对话类）：

```
reserve(operationId, userId, type, model, inputTokens, maxOutputTokens)  # 按最大输出预扣
→ 调模型
→ settle(operationId, userId, model, inputTokens, outputTokens, cache*)  # 按实际用量结算，多退少补
```

**资源计费**（生图/视频/配音等按次资源）：`/resource/charge`、`/resource/reserve`、`/resource/settle`、`/resource/settle-video`、`/resource/refund`。失败必须 refund，且 finalize 要幂等（见 [异步任务架构](#异步任务架构) 的计费包裹范式）。

- `operationId` 是幂等键，重复调用不会重复扣款。
- 双账户体系：`points`（算力点）与 `video`（视频点）。
- 余额不足返回专用错误，TS 客户端抛 `InsufficientBalanceError`，前端据此弹充值引导。
- **`Settle` 用结算时传入的 `resourceKey` 重新报价**（`resource.Service.Settle`），不是预留时那个；`wallet.settlePricedUsage` 退回 `预留 − 实收`。因此「按请求档预留、按交付档结算」不需要任何新原语——生图各线就是靠这一条按上游实际交付像素退差额的，见 [image.md](./image.md) 6.11。

<a id="内部分包servicesbillinginternal"></a>
### 内部分包（services/billing/internal/）

`wallet`（钱包核心）、`bucket`（点数桶）、`topup`（充值，支付宝/微信）、`pay`（支付渠道）、`membership` + `sub`（月卡与订阅，按北京时区锚定日界发点）、`vip`（等级）、`redeem`（兑换码）、`registry` + `model`（模型注册与定价）、`resource`（资源价格）、`billingmode`（定价模式）、`videopoint`（视频点）、`pointsdetail`（明细）、`adjust`(人工调整）、`recon`（对账）、`api`（HTTP 层，全部接口挂内部 token 鉴权）、`store`（存储）、`config`。

### 商业化接口一览

充值套餐 `recharge-packages`、月卡 `membership/buy`、兑换码 `redeem`、订阅申请 `subscription/apply`、VIP 概要 `vip/me`、模型市场定价 `model-marketplace`、用量与明细 `usage` / `points-detail`。运营侧对应 Admin 的 Orders / ResourcePricing / Membership / Models 页面。

<a id="学习模式learning-mode"></a>
### 学习模式（learning mode）

`BILLING_PRICING_MODE=learning` 时每个 operation 只扣 1 点，用于本地/演示环境防止真实定价干扰联调，本地 K8s overlay 默认开启。激活、初始发点、重置的 runbook 见 [../lessons/billing-learning-mode.md](./billing.md)，设计过程见 [../plans/2026-07-11-billing-learning-mode.md](./billing.md)。

<a id="ts-客户端packagesbilling"></a>
### TS 客户端（packages/billing）

薄 HTTP 客户端：`BillingClientOpts { baseUrl, token, fetchFn }`——`fetchFn` 可注入，测试不需要起真服务。错误类型只有两个：`InsufficientBalanceError`（业务语义）和 `BillingHttpError`（携带 path 与 status）。



## 三、内部分包（services/billing/internal/）

`wallet`（钱包核心）、`bucket`（点数桶）、`topup`（充值）、`pay`（支付渠道）、`membership`+`sub`（月卡与订阅）、`vip`（等级）、`redeem`（兑换码）、`registry`+`model`（模型定价）、`resource`（资源价格）、`billingmode`（定价模式）、`videopoint`（视频点）、`pointsdetail`（明细）、`adjust`（人工调整）、`recon`（对账）、`api`（HTTP 层）、`store`、`config`。

## 四、商业化接口

充值套餐 `recharge-packages`、月卡 `membership/buy`、兑换码 `redeem`、订阅申请 `subscription/apply`、VIP 概要 `vip/me`、模型市场定价 `model-marketplace`、用量与明细 `usage`/`points-detail`。

## 五、TS 客户端（packages/billing）

薄 HTTP 客户端：`BillingClientOpts { baseUrl, token, fetchFn }`——`fetchFn` 可注入，测试不需要起真服务。错误只有两个：`InsufficientBalanceError` 和 `BillingHttpError`（携带 path 与 status）。

## 六、学习模式（本地开发）


# Billing learning mode

本地 `.env` 设置：

```dotenv
BILLING_PRICING_MODE=learning
```

重启 Go billing 服务后，启动日志必须出现：

```text
billing pricing mode: learning
```

### 给本地用户发 10,000 普通积分和 10,000 视频点

学习模式不会绕过余额检查。使用现有内部余额调整接口一次性发点；重复使用同一 `operationId` 不会重复发放：

```bash
USER_ID='<本地用户 UUID>'
curl --fail-with-body \
  -X POST "${BILLING_BASE_URL:-http://localhost:8093}/internal/admin/balance-adjust" \
  -H 'content-type: application/json' \
  -H "x-internal-token: ${BILLING_INTERNAL_TOKEN}" \
  --data "{\"operationId\":\"learning-seed:points:${USER_ID}\",\"userId\":\"${USER_ID}\",\"delta\":10000,\"reason\":\"local learning points\",\"adminId\":\"local-dev\",\"accountType\":\"points\"}"

curl --fail-with-body \
  -X POST "${BILLING_BASE_URL:-http://localhost:8093}/internal/admin/balance-adjust" \
  -H 'content-type: application/json' \
  -H "x-internal-token: ${BILLING_INTERNAL_TOKEN}" \
  --data "{\"operationId\":\"learning-seed:video:${USER_ID}\",\"userId\":\"${USER_ID}\",\"delta\":10000,\"reason\":\"local learning video points\",\"adminId\":\"local-dev\",\"accountType\":\"video\"}"
```

查询余额：

```bash
curl --fail-with-body \
  -H "x-internal-token: ${BILLING_INTERNAL_TOKEN}" \
  "${BILLING_BASE_URL:-http://localhost:8093}/balance/${USER_ID}"
```

### 预期行为

- 每个新的 `operationId` 从原有账户扣 1 点。
- 相同 `operationId` 重放不重复扣点。
- 普通功能退款返还 1 个普通积分。
- 视频调用扣 1 个视频点，普通积分不变化；视频退款返还 1 个视频点。
- 对应账户余额为 0 时，普通积分或视频点消费接口都返回 HTTP 402 和 `INSUFFICIENT_BALANCE`。
- 切回 `BILLING_PRICING_MODE=standard` 并重启即可恢复现有真实计价。

### 自动化验证

```bash
docker compose -f docker-compose.dev.yml up -d billing-postgres
(cd services/billing && go test ./... -count=1)
pnpm --filter @yc/billing test
pnpm --filter @yc/billing typecheck
pnpm --filter @yc/api typecheck
```


## 七、配置与环境变量

详见 [setup.md 中的模型网关配置](./overview.md)（`BILLING_PRICING_MODE`、`BILLING_INTERNAL_TOKEN`、`BILLING_DATABASE_URL` 等）。

## 八、预留有效期与结算侧哨兵（2026-08-28/29）

> 一次真实的静默漏计费，从根因到补收的完整记录。样本是桌宠 run `cpr_2defdce20f99dd1a8dd3477f774de2f8`：**8 张图已交付，1600 点从头到尾没收到，两个库都显示「成功」，没有任何一条报错。**

### 8.1 机制：为什么「有真实用量却结算 0 点」全程没人报错

三处各自都合理的设计串成了一条静默通道：

1. **兜底会提前关账**：`recon.Reconcile`（`services/billing/internal/recon/recon.go`）每 5 分钟扫一次，把仍是 `reserved` 的 `usage_records` 按 `actual=0` 强行关掉。它原本只认一个**全局 10 分钟** TTL——而桌宠一笔预留天生要跨越「运行 + 等用户授权（7 天）+ 失败结算宽限（24 小时）」。
2. **`wallet.Settle` 对非 reserved 记录静默返回 nil**：`if rec.Status != "reserved" { return nil }`。这是为幂等重放写的，但一笔**已被兜底关掉**的记录走的是同一条分支，于是「结算一笔早就被关掉的预留」和「重放一笔已结算的预留」在返回值上完全无法区分。
3. **`resource.Settle` 重读记录返回 `ActualPoints`**：兜底写进去的是 0，所以调用方拿到 `{ settled: 0 }` + HTTP 200 + 无 error。

业务侧只能把它当「这次不该收钱」写进库——**漏计费在数据层不留任何痕迹**，只能靠人肉比对 `CodexPetImageCall` 与 `usage_records` 才能发现。两种失效方式的代价严重不对称：TTL 偏短 = 静默漏钱；TTL 偏长 = 真被遗弃的预留晚一点退款（而各域 reaper 约一分钟内就会给终态行结算/退款，能撑到 TTL 的只有「确实还在跑」的行）。所以一切窗口推导**一律往长的方向取整**。

### 8.2 修法一：预留可以声明自己的有效期（`5be026d` + `20684ef`）

- **Go 侧**：`/resource/reserve` 新增可选 `reservationTtlSeconds`，上限 `maxReservationTTLSeconds = 30 天`（超出直接 400，防一次笔误把用户算力点永久冻结）；`wallet.ReservePricedUntil` 把到期时刻落到 `usage_records.reservation_expires_at`；`recon` 的扫描条件改成「**声明了有效期的按有效期算，没声明的才退回全局 TTL**」：
  ```sql
  status = 'reserved' AND ((reservation_expires_at IS NULL AND created_at < now()-ttl)
                        OR (reservation_expires_at IS NOT NULL AND reservation_expires_at < now()))
  ```
  兜底从此只回收**真正过期**的预留，不再去关一笔调用方仍合法持有的预留。
- **TS 侧**：窗口口径收敛成叶子模块 [`_shared/reservation-window.ts`](../apps/api/src/workflow/_shared/reservation-window.ts)（纯算术，不 import 任何东西）+ 各域 `*-shared.ts` 提供该域的超时/重试常量；桌宠另有 [`codex-pet-reservation-window.ts`](../apps/api/src/workflow/codex-pet/codex-pet-reservation-window.ts)（授权 7 天 + 宽限 24 小时 + 12 小时余量）。两条硬性约定：
  - **声明 TTL 只能延长窗口，绝不能比不声明还短**（`reservationTtlSeconds` 保证下界不低于全局兜底）。
  - 余量给两个扫描间隔（兜底是周期扫描不是到点即触发，再叠两个进程的时钟偏差），续跑域另加心跳余量；**不续跑的域显式传 0，不要凭空加**。
- **覆盖面**：`reserveResource` 的 11 个非测试调用点全部声明（桌宠 2、试衣 2、形象照 2、电商 2、图文 1、生图 1、小说 1）。**新增任何 `reserveResource` 调用点都必须同时决定 TTL**——这是不能省的一步。注意 `ecom-routes.ts` 那一处是解构后的 `reserveResource!(...)`，按 `reserveResource(` 搜会漏掉。

### 8.3 修法二：结算侧哨兵（`49e90f8` + `870cbec`）

修好 TTL 只能阻止**这一个**成因复发。哨兵解决的是另一件事：**下一次不管什么原因导致「有用量却结算 0 点」，都必须自己报出来**。

- **判据**（[`packages/billing/src/index.ts`](../packages/billing/src/index.ts) `isSilentSettlement`）：`max(units, inputUnits ?? 0) > 0 && !(settled > 0)`。
  - 用 `!(settled > 0)` 而不是 `settled <= 0`，一并盖住 0、负数、`NaN` 和**字段缺失**——不让响应形状变化绕开哨兵。
  - 视频复合计价里输入量也是真实用量，所以取 `units` 与 `inputUnits` 的较大者。
- **为什么几乎不会误报**：`Quote` 对每种定价类型都走 `math.Ceil`，学习模式归一到 1 点，所以任何 `units > 0` 的计价资源结算结果**必然 ≥ 1 点**。唯一的良性 0 是运营把某资源单价配成 0。
- **幂等重放不是噪声**：`resource.Settle` 返回记录里**已记下的** `ActualPoints`，所以重放一笔真正结算过的记录拿回的是原来那个非 0 值，不会触发哨兵。
- **接在客户端层**：包在 `createBillingClient` 的 `settleResource` / `settleVideoResource` 里，一次改动覆盖 `apps/api` 全部 43 个 `createBillingClient(` 调用点（仓库里没有共享工厂，逐点改必然漏）。落点可通过 `onSilentSettlement` 换成 fastify `app.log` 或 worker 指标，缺省 `console.warn`；**但不要传空实现——那等于把唯一的报警关掉**。
- **哨兵自身出错不许影响结算**：`try { ... } catch {}` 包住落点。让一笔已经成功的结算因为报警失败而变成异常，会引发调用方去退款或重试，比漏计费更糟。
- **桌宠三条 settle 路径必须写逐字相同的诊断**（[`codexPetUnderSettledDiagnostic`](../apps/api/src/workflow/codex-pet/codex-pet-billing.ts)）：runner 的 `settlePerImageRunBilling`、worker 的 `reconcilePerImageBillingSettlements`、取消路由的 `settleCancellationRefund`。后两条原来**无条件写 `billingChargeError: null`**——不仅不报错，还会把上一次留下的诊断擦掉。口径分叉的代价很具体：补收工具靠这段文本判断该不该补，措辞不一致就会漏掉从取消进来的那一半。
  - `49e90f8` 只改了前两条，第三条（取消路由）是**按图预留最常见的收口路径**，也正是本次事故那笔运行要走的路——补在 `870cbec`。

### 8.4 事故复盘：`cpr_2def…` 丢掉的 1600 点

| 时间（UTC） | 事件 |
| --- | --- |
| 08-27 10:58:30 | `reserve` 14 单位 / 2800 点，`reservation_expires_at = NULL` → 兜底按 10 分钟算 |
| 08-27 10:58:30 ~ 11:13:05 | 8 张 planned 图**全部成功交付**（其中 4 张在 11:09:38 之后） |
| 08-27 11:09:38 | `recon` 把这笔预留按 `actual_points = 0` 关账，**无人报错** |
| 08-27 11:30 ~ 11:39 | 4 次 extra 调用各自独立 charge 200 点，**这部分收对了** |
| 08-27 11:41:21 | 运行停在 `awaiting_regeneration_approval`（卡在 `row-failed`，即 [codex-pet.md 6.13](./codex-pet.md) 的切图网格错位） |
| 08-29 05:57:01 | 走应用自己的取消接口收口：settle 8 单位 → 拿回 `settled: 0` → **诊断落库**（`870cbec` 的路径生效） |
| 08-29 06:00:27 | 补收脚本 charge 8 单位 = **1600 点**，余额 5200 → 3600 |

- **谁传了 `units: 0`？没有人。** 全程没有任何调用方传 0，是兜底提前关账 + `Settle` 静默成功造成的。这一点必须先证伪，否则会去改一堆没病的调用点。
- **TS 侧与 Go 侧长期不一致而无人发现**：TS 的运行行显示 `reserved` / 2800，Go 的记录已是 `settled` / `actual_points = 0`。
- **全库复查**：按「已交付 planned 调用 × 200 > 运行已结算点数」扫描，另有 16 行命中，但**都不是第二起事故**——billing 库在 2026-08-27 重建过（整库只有 12 条 `usage_records`，最早 08-27），这 16 行是 `dev` 账号与 `pet-route-*` 测试夹具用户的历史运行，在现库里**没有对应账本记录**，既不可补也不涉及真实用户。**唯一有账本可查的按图预留就是这一笔，现已补齐。**

### 8.5 补收 runbook（不重新出图，修被提前结算的运行）

```bash
# 1. 先看清楚：运行是否终态、已交付 planned 调用几次、是否已补收过
npx tsx src/scripts/correct-codex-pet-per-image-billing.ts --check <run-id> 200
# 2. 补收（幂等：operationId 含目标点数，重放返回 already_corrected 且不重复扣）
npx tsx src/scripts/correct-codex-pet-per-image-billing.ts --apply <run-id> 200
```

- 脚本**先校验线上单价**（`PER_UNIT` / `perUnits=1` / `enabled` / `ceil(rate)` 等于传入值）才动手，价目改过就直接拒绝——避免用今天的价补昨天的账。
- `correctCodexPetPerImageBilling` 只认「按图计费 + 终态 + `settled` + 无 worker」的运行，补收后写 `usage.perImageBillingCorrection` + `billing.settlement.corrected` 事件，并**清掉 `billingChargeError`**：补收正是那条「需要按图补收」诊断的解除条件，留着不清等于让修好的运行一直挂假报警，下次真出事没人当真。
- **`cancelRequested` 曾把整条取消路径挡在门外**（本次修）：取消收口时一定会留下 `cancelRequested = true`，旧判据把它当活跃信号，于是这个工具**永远修不了取消路径**——而那恰恰是按图预留最常见的收口、也是哨兵写诊断的那一条。现在活跃性只认 `workerId`；`cancelled + workerId=null` 是确定的静止态，`ready` / `failed` 上的 `cancelRequested` 仍然拦住（状态机没走完，先查清再补收）。

### 8.6 已知盲区（尚未修）

- **Token/LLM 结算路径对哨兵免疫**：`services/billing/internal/api/api.go:360-387` 的 settle 返回的是**当场重新算出来的报价**，不是记录里的 `ActualPoints`，所以同样的静默关账在对话类计费上拿到的是非 0 值，哨兵看不见。修它需要改 Go 并重启计费服务。
- **运营把资源单价配成 0** 会让哨兵持续误报——目前判据没有「这个资源本来就免费」的白名单。


