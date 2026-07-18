type JsonSchema = Record<string, unknown>;
type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

interface BillingRouteDefinition {
  method: HttpMethod;
  path: string;
  summary: string;
  tag: "Billing · 账户" | "Billing · 资源计费" | "Billing · 管理" | "Billing · 支付回调";
  body?: JsonSchema;
  query?: Record<string, JsonSchema>;
  public?: boolean;
}

const stringField = (description: string, extra: JsonSchema = {}): JsonSchema => ({
  type: "string",
  description,
  ...extra,
});

const integerField = (description: string, extra: JsonSchema = {}): JsonSchema => ({
  type: "integer",
  description,
  ...extra,
});

const objectBody = (
  properties: Record<string, JsonSchema> = {},
  required: string[] = [],
): JsonSchema => ({
  type: "object",
  additionalProperties: true,
  properties,
  ...(required.length ? { required } : {}),
});

const operationFields = {
  operationId: stringField("调用方生成的全局幂等操作 ID"),
  userId: stringField("用户 ID"),
};

const resourceFields = {
  ...operationFields,
  resourceKey: stringField("资源计价键"),
  units: integerField("资源用量", { minimum: 0 }),
};

const genericBody = objectBody();

const routes: BillingRouteDefinition[] = [
  {
    method: "post",
    path: "/reserve",
    summary: "预留模型调用算力点",
    tag: "Billing · 账户",
    body: objectBody(
      {
        ...operationFields,
        type: stringField("调用类型"),
        model: stringField("模型名称"),
        inputTokens: integerField("输入 Token 数", { minimum: 0 }),
        maxOutputTokens: integerField("最大输出 Token 数", { minimum: 0 }),
      },
      ["operationId", "userId", "type", "model"],
    ),
  },
  { method: "post", path: "/settle", summary: "结算模型调用", tag: "Billing · 账户", body: genericBody },
  { method: "get", path: "/balance/{userId}", summary: "查询用户余额", tag: "Billing · 账户" },
  { method: "get", path: "/points-detail/{userId}", summary: "查询用户算力点明细", tag: "Billing · 账户" },
  {
    method: "get",
    path: "/usage/{userId}",
    summary: "查询用户用量记录",
    tag: "Billing · 账户",
    query: { limit: integerField("返回条数", { minimum: 1, maximum: 100, default: 20 }) },
  },
  { method: "get", path: "/vip/me/{userId}", summary: "查询用户 VIP 摘要", tag: "Billing · 账户" },
  { method: "get", path: "/vip/summary/{userId}", summary: "查询用户 VIP 等级摘要", tag: "Billing · 账户" },
  { method: "get", path: "/model-marketplace/{userId}", summary: "查询用户模型市场与 VIP 价格", tag: "Billing · 账户" },
  {
    method: "post",
    path: "/topup",
    summary: "创建充值订单",
    tag: "Billing · 账户",
    body: objectBody(
      {
        userId: operationFields.userId,
        amountFen: integerField("充值金额，单位：分", { minimum: 1 }),
        packageId: stringField("充值套餐 ID；与 amountFen 二选一"),
        method: stringField("支付方式", { enum: ["alipay", "wxpay"] }),
        accountType: stringField("账户类型", { enum: ["points", "video"], default: "points" }),
      },
      ["userId", "method"],
    ),
  },
  { method: "get", path: "/topup/{userId}/{tradeNo}", summary: "查询充值订单状态", tag: "Billing · 账户" },
  { method: "get", path: "/recharge-packages", summary: "查询充值套餐", tag: "Billing · 账户" },
  {
    method: "post",
    path: "/membership/buy",
    summary: "购买会员卡",
    tag: "Billing · 账户",
    body: objectBody(
      {
        userId: operationFields.userId,
        cardId: integerField("会员卡 ID", { minimum: 1 }),
        method: stringField("支付方式", { enum: ["alipay", "wxpay"] }),
      },
      ["userId", "cardId", "method"],
    ),
  },
  {
    method: "post",
    path: "/redeem",
    summary: "兑换权益码",
    tag: "Billing · 账户",
    body: objectBody({ userId: operationFields.userId, code: stringField("兑换码") }, ["userId", "code"]),
  },
  { method: "post", path: "/subscription/apply", summary: "应用订阅变更", tag: "Billing · 账户", body: genericBody },
  { method: "post", path: "/charge-points", summary: "直接扣减算力点", tag: "Billing · 账户", body: genericBody },
  {
    method: "post",
    path: "/resource/charge",
    summary: "按资源用量直接计费",
    tag: "Billing · 资源计费",
    body: objectBody(
      {
        ...resourceFields,
        inputUnits: integerField("输入资源用量；视频复合计价时使用", { minimum: 0 }),
        accountType: stringField("扣费账户", { enum: ["points", "video"], default: "points" }),
      },
      ["operationId", "userId", "resourceKey", "units"],
    ),
  },
  {
    method: "post",
    path: "/resource/reserve",
    summary: "预留资源费用",
    tag: "Billing · 资源计费",
    body: objectBody(resourceFields, ["operationId", "userId", "resourceKey"]),
  },
  {
    method: "post",
    path: "/resource/settle",
    summary: "结算资源费用",
    tag: "Billing · 资源计费",
    body: objectBody(
      { operationId: operationFields.operationId, resourceKey: resourceFields.resourceKey, units: resourceFields.units },
      ["operationId", "resourceKey"],
    ),
  },
  {
    method: "post",
    path: "/resource/settle-video",
    summary: "结算视频输入输出资源费用",
    tag: "Billing · 资源计费",
    body: objectBody(
      {
        operationId: operationFields.operationId,
        resourceKey: resourceFields.resourceKey,
        units: integerField("实际输出秒数", { minimum: 0 }),
        inputUnits: integerField("输入视频秒数", { minimum: 0 }),
      },
      ["operationId", "resourceKey"],
    ),
  },
  { method: "post", path: "/resource/refund", summary: "退回资源费用", tag: "Billing · 资源计费", body: genericBody },
  { method: "get", path: "/membership/cards", summary: "查询可购买会员卡", tag: "Billing · 账户" },
  { method: "get", path: "/membership/mine/{userId}", summary: "查询用户会员记录", tag: "Billing · 账户" },
  {
    method: "get",
    path: "/user-kb-quota",
    summary: "查询用户知识库配额",
    tag: "Billing · 账户",
    query: { userId: stringField("用户 ID") },
  },
  { method: "get", path: "/internal/models", summary: "查询启用的模型", tag: "Billing · 管理" },
  {
    method: "post",
    path: "/api/billing/epay/notify",
    summary: "接收易支付异步通知",
    tag: "Billing · 支付回调",
    body: genericBody,
    public: true,
  },
  {
    method: "get",
    path: "/api/billing/epay/notify",
    summary: "接收易支付同步通知",
    tag: "Billing · 支付回调",
    public: true,
  },
];

const adminRoutes: Array<[HttpMethod, string, string, JsonSchema?]> = [
  ["post", "/internal/admin/codes", "批量生成兑换码"],
  ["get", "/internal/admin/codes", "查询兑换码"],
  ["post", "/internal/admin/codes/disable", "禁用兑换码", objectBody({ code: stringField("兑换码") }, ["code"])],
  ["post", "/internal/admin/balance-adjust", "调整用户余额"],
  ["post", "/internal/admin/balances", "批量查询用户余额", objectBody({ userIds: { type: "array", items: { type: "string" } } }, ["userIds"])],
  ["get", "/internal/admin/orders", "查询充值订单"],
  ["get", "/internal/admin/models", "查询模型计价配置"],
  ["post", "/internal/admin/models", "新增或更新模型配置"],
  ["patch", "/internal/admin/models/pricing", "更新模型价格"],
  ["patch", "/internal/admin/models/display", "更新模型展示配置"],
  ["patch", "/internal/admin/models/identity", "更新模型标识"],
  ["post", "/internal/admin/models/delete", "删除模型配置"],
  ["get", "/internal/admin/models/stats", "查询模型统计"],
  ["get", "/internal/admin/analytics/daily", "查询每日计费分析"],
  ["post", "/internal/admin/analytics/revenue-by-users", "按用户汇总收入"],
  ["post", "/internal/admin/analytics/summary-by-users", "按用户汇总计费数据"],
  ["get", "/internal/admin/analytics/rankings", "查询用量排行"],
  ["get", "/internal/admin/analytics/sales", "查询销售分析"],
  ["get", "/internal/admin/analytics/balances", "查询余额分析"],
  ["get", "/internal/admin/analytics/user-summary", "查询用户计费摘要"],
  ["get", "/internal/admin/resource-prices", "查询资源价格"],
  ["post", "/internal/admin/resource-prices", "新增或更新资源价格"],
  ["post", "/internal/admin/resource-prices/delete", "删除资源价格"],
  ["get", "/internal/admin/config/recharge-ratio", "查询充值比例"],
  ["put", "/internal/admin/config/recharge-ratio", "更新充值比例"],
  ["get", "/internal/admin/config/recharge-packages", "查询充值套餐配置"],
  ["put", "/internal/admin/config/recharge-packages", "更新充值套餐配置"],
  ["get", "/internal/admin/config/kb-default-quota", "查询知识库默认配额"],
  ["put", "/internal/admin/config/kb-default-quota", "更新知识库默认配额"],
  ["get", "/internal/admin/membership-cards", "查询会员卡配置"],
  ["post", "/internal/admin/membership-cards", "新增或更新会员卡"],
  ["post", "/internal/admin/membership-cards/delete", "删除会员卡"],
  ["get", "/internal/admin/vip-levels", "查询 VIP 等级"],
  ["post", "/internal/admin/vip-levels", "新增或更新 VIP 等级"],
  ["post", "/internal/admin/vip-levels/delete", "删除 VIP 等级"],
];

for (const [method, path, summary, body] of adminRoutes) {
  routes.push({ method, path, summary, tag: "Billing · 管理", body: body ?? (method === "get" ? undefined : genericBody) });
}

function pathParameters(path: string): Array<Record<string, unknown>> {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    description: `${match[1]} 路径参数`,
    schema: { type: "string" },
  }));
}

function queryParameters(query: Record<string, JsonSchema> | undefined): Array<Record<string, unknown>> {
  if (!query) return [];
  return Object.entries(query).map(([name, schema]) => ({
    name,
    in: "query",
    required: false,
    description: typeof schema.description === "string" ? schema.description : `${name} 查询参数`,
    schema,
  }));
}

function operationId(method: HttpMethod, path: string): string {
  return `billing_${method}_${path}`
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function buildBillingOpenApiPaths(baseUrl: string): Record<string, Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const parameters = [...pathParameters(route.path), ...queryParameters(route.query)];
    const operation: Record<string, unknown> = {
      tags: [route.tag],
      summary: route.summary,
      description: route.public
        ? "Billing 服务公开回调；请求真实性由支付签名校验。"
        : "Billing 内部服务接口，只允许受信任的主 API 或运维工具调用。",
      operationId: operationId(route.method, route.path),
      servers: [{ url: baseUrl, description: "Billing 服务" }],
      security: route.public ? [] : [{ billingInternalToken: [] }],
      responses: {
        "200": { description: "请求成功", content: { "application/json": { schema: objectBody() } } },
        "400": { $ref: "#/components/responses/BadRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "500": { $ref: "#/components/responses/InternalError" },
      },
    };
    if (parameters.length) operation.parameters = parameters;
    if (route.body) {
      operation.requestBody = {
        required: true,
        content: { "application/json": { schema: route.body } },
      };
    }
    paths[route.path] = { ...(paths[route.path] ?? {}), [route.method]: operation };
  }
  return paths;
}

export const billingTagDefinitions = [
  { name: "Billing · 账户", description: "Billing 服务的余额、充值、会员和 VIP 内部接口" },
  { name: "Billing · 资源计费", description: "资源预留、结算、扣费与退款接口" },
  { name: "Billing · 管理", description: "Billing 服务管理配置和统计接口" },
  { name: "Billing · 支付回调", description: "第三方支付平台回调" },
];
