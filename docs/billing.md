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
