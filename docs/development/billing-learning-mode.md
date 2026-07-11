# Billing learning mode

本地 `.env` 设置：

```dotenv
BILLING_PRICING_MODE=learning
```

重启 Go billing 服务后，启动日志必须出现：

```text
billing pricing mode: learning
```

## 给本地用户发 10,000 普通积分和 10,000 视频点

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

## 预期行为

- 每个新的 `operationId` 从原有账户扣 1 点。
- 相同 `operationId` 重放不重复扣点。
- 普通功能退款返还 1 个普通积分。
- 视频调用扣 1 个视频点，普通积分不变化；视频退款返还 1 个视频点。
- 对应账户余额为 0 时，普通积分或视频点消费接口都返回 HTTP 402 和 `INSUFFICIENT_BALANCE`。
- 切回 `BILLING_PRICING_MODE=standard` 并重启即可恢复现有真实计价。

## 自动化验证

```bash
docker compose -f docker-compose.dev.yml up -d billing-postgres
(cd services/billing && go test ./... -count=1)
pnpm --filter @yc/billing test
pnpm --filter @yc/billing typecheck
pnpm --filter @yc/api typecheck
```
