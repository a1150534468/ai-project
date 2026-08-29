export class InsufficientBalanceError extends Error {
  constructor() { super("余额不足，请充值"); this.name = "InsufficientBalanceError"; }
}

export class BillingHttpError extends Error {
  constructor(public path: string, public status: number) {
    super(`billing ${path} ${status}`);
    this.name = "BillingHttpError";
  }
}

export interface BillingClientOpts {
  baseUrl: string;
  token: string;
  fetchFn?: typeof fetch;
  /**
   * 结算静默归零时的落点，缺省写 console.warn。传入可改接各自的结构化日志
   * （fastify 的 app.log、worker 的 metrics 等），但不要传空实现——那等于把
   * 唯一的报警关掉，回到 SilentSettlementReport 里描述的那种无人报错的漏计费。
   */
  onSilentSettlement?: (report: SilentSettlementReport) => void;
}
export type PaymentMethod = "alipay" | "wxpay";
export interface ReserveArgs {
  operationId: string; userId: string; type: string; model: string;
  inputTokens: number; maxOutputTokens: number;
}
export interface SettleArgs {
  operationId: string; userId: string; model: string;
  inputTokens: number; outputTokens: number;
  cacheInputTokens?: number; cacheOutputTokens?: number;
}
export type BillingAccountType = "points" | "video";
export interface CreateTopupArgs {
  userId: string; amountFen?: number; packageId?: string; method: PaymentMethod; accountType?: BillingAccountType;
}
export interface RedeemArgs {
  code: string; userId: string;
}
export interface GenerateCodesArgs {
  grantType: "BALANCE" | "MEMBERSHIP" | "FEATURE" | "PACKAGE";
  grantPayload: string;
  points?: number;
  count: number;
  expiresAt?: number;
}
export interface CodeRow {
  code: string; grantType: string; grantPayload: string; points: number;
  status: string; batchID: string; usedBy: string;
  expiresAt: string | null; createdAt: string; usedAt: string | null;
}
export interface AdjustBalanceArgs {
  operationId: string; userId: string; delta: number; reason: string; adminId: string; accountType?: "points" | "video";
}
export interface TokenPricing {
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  cacheInputPricePerMillion: number;
  cacheOutputPricePerMillion: number;
}
export interface RmbPricing {
  inputPriceRmbPerMillion: number;
  outputPriceRmbPerMillion: number;
  cacheInputPriceRmbPerMillion: number;
  cacheOutputPriceRmbPerMillion: number;
}
export interface VipPriceView {
  original: number;
  discounted: number;
}
export interface VipSummary {
  userId: string;
  levelId: number;
  levelName: string;
  discountBps: number;
  growthPoints: number;
  nextLevelId: number | null;
  nextLevelName: string;
  nextThreshold: number;
  pointsToNextLevel: number;
  highestLevel: boolean;
}
export interface ModelMarketplaceMeta {
  description?: string;
  tags?: string;
  category?: string;
  contextLength?: number;
  maxOutputTokens?: number;
  useCases?: string;
  sortOrder?: number;
  showInMarketplace?: boolean;
}
export interface ModelRow extends TokenPricing, RmbPricing {
  model: string; displayName: string; modelRatio?: number; completionRatio?: number; enabled: boolean;
  description: string; tags: string; category: string; contextLength: number; maxOutputTokens: number; useCases: string; sortOrder: number; showInMarketplace: boolean;
}
export interface ModelMarketplaceRow extends ModelRow {
  vipInputPrice: VipPriceView;
  vipOutputPrice: VipPriceView;
  vipCacheInputPrice: VipPriceView;
  vipCacheOutputPrice: VipPriceView;
}
export interface VipLevelRow {
  id: number;
  name: string;
  sortOrder: number;
  thresholdRmbFen: number;
  thresholdPoints: number;
  savedRechargeRatio: number;
  discountBps: number;
  enabled: boolean;
  upgradeEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface UpsertVipLevelArgs {
  id?: number;
  name: string;
  sortOrder: number;
  thresholdRmbFen: number;
  discountBps: number;
  enabled: boolean;
  upgradeEnabled: boolean;
}
export interface ModelStatsRow {
  model: string;
  displayName: string;
  totalPoints: number;
  usageCount: number;
  userCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheInputTokens: number;
  cacheOutputTokens: number;
}
export type UpsertModelArgs = {
  model: string; displayName: string; enabled: boolean;
} & ModelMarketplaceMeta & (TokenPricing | RmbPricing);
export interface AnalyticsDailyRow {
  date: string; revenueFen: number; topupCount: number;
  grantedPoints: number; consumedPoints: number; payingUsers: number; newPayingUsers: number;
}
export interface RevenueEvent {
  paidAtDate: string; amountFen: number; points: number;
}
export interface UserAggRow {
  totalRechargeFen: number;
  totalRechargeOrders: number;
  totalConsumptionPoints: number;
}
export interface RankingRow {
  key: string; points: number; tokens: number; count: number;
}
export interface RankingsSummary {
  users: RankingRow[]; models: RankingRow[]; features: RankingRow[];
}
export interface SalesRow {
  key: string; name: string; orders: number; users: number; revenueFen: number; points: number;
}
export interface SalesSummary {
  memberships: SalesRow[]; rechargePackages: SalesRow[];
}
export interface BalanceSummary {
  totalBalance: number; usersWithBalance: number; videoPointsBalance: number;
}
export interface AdminOrderRow {
  id: number;
  tradeNo: string;
  userId: string;
  amountFen: number;
  points: number;
  provider: string;
  paymentMethod: string;
  status: string;
  kind: string;
  cardId: number;
  createdAt: string;
  paidAt: string | null;
}
export interface TopupOrderRow {
  id?: number;
  tradeNo: string;
  userId: string;
  amountFen: number;
  points: number;
  provider: string;
  paymentMethod: string;
  status: string;
  kind: string;
  cardId: number;
  createdAt: string;
  paidAt: string | null;
}
export interface AdminOrderSummary {
  total: number;
  successCount: number;
  pendingCount: number;
  closedCount: number;
  successAmountFen: number;
  successPoints: number;
  payingUsers: number;
}
export interface ListAdminOrdersParams {
  userId?: string;
  userIds?: string[];
  tradeNo?: string;
  status?: string;
  kind?: string;
  provider?: string;
  paymentMethod?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}
export interface UserBillingSummary {
  todayRechargeFen: number; todayRechargeOrders: number;
  totalRechargeFen: number; totalRechargeOrders: number;
  todayConsumptionPoints: number; totalConsumptionPoints: number;
  todayTokens: number; totalTokens: number;
}
export interface ResourcePriceRow {
  resourceKey: string; displayName: string; pricingType: "PER_CALL" | "PER_UNIT" | "VIDEO_IO";
  rate: number; outputRate?: number; perUnits: number; enabled: boolean;
}
export interface UsageRow {
  operationId: string; type: string; model: string; displayName: string; status: string;
  reservedPoints: number; actualPoints: number; originalPoints: number;
  vipLevelName: string; vipDiscountBps: number; vipSavedPoints: number; vipGrowthPoints: number;
  inputTokens: number; outputTokens: number; cacheInputTokens: number; cacheOutputTokens: number;
  createdAt: string; settledAt: string | null;
}
export interface UpsertResourcePriceArgs {
  resourceKey: string; displayName: string; pricingType: "PER_CALL" | "PER_UNIT" | "VIDEO_IO";
  rate: number; outputRate?: number; perUnits: number; enabled: boolean;
}
export interface ChargeResourceArgs {
  operationId: string; userId: string; resourceKey: string; units: number;
  inputUnits?: number; accountType?: BillingAccountType;
}
export interface ReserveResourceArgs {
  operationId: string; userId: string; resourceKey: string; units: number;
  /**
   * 这笔预留可以合法持有多久（秒，0/省略 = 用 billing 侧 recon 的全局 TTL，默认 10 分钟）。
   * 生命周期本就超过全局 TTL 的工作流必须显式声明，否则运行途中预留就会被兜底按
   * actual=0 关账，之后每次真实用量都免费结算且无人报错。上限 30 天，超出 billing 返回 400。
   */
  reservationTtlSeconds?: number;
}
export interface SettleVideoResourceArgs {
  operationId: string; resourceKey: string; units: number; inputUnits?: number;
}
export interface SettleResourceArgs {
  operationId: string; resourceKey: string; units: number;
}

/**
 * 「有真实用量却结算到 0 点」的结算侧哨兵。
 *
 * billing 的 wallet.Settle 遇到已经不是 reserved 的记录会静默 return nil，
 * 调用方只拿到 settled=0：预留被兜底提前关账（recon 按 actual=0 关掉超期预留）、
 * 或者先退款后又来结算，都走这一条。成品照发、钱没收到、没人抛错、DB 里也不留痕——
 * cpr_2defdce20f99dd1a8dd3477f774de2f8 就是 8 次真实出图结算 0 点，全程无人报错。
 *
 * 判据只有「有量 && 没钱」：单价一律 ceil 取整（learning 模式恒为 1 点），
 * 所以正常结算只要有量就必然 >0 点。已知误报面只有一种——管理台把某个资源的
 * 费率配成了 0（真·免费资源），那种情况下这行告警是噪声，但不会改变任何行为。
 */
export interface SilentSettlementReport {
  /** resource=算力点预留结算，video=视频点结算；两条路径的静默归零成因相同。 */
  readonly kind: "resource" | "video";
  readonly operationId: string;
  readonly resourceKey: string;
  readonly units: number;
  readonly inputUnits?: number;
  readonly settled: number;
}

/** 结算是否静默归零。视频复合计价里输入量也是真实用量，任一侧有量就该有钱进账。 */
export function isSilentSettlement(report: {
  readonly units: number;
  readonly inputUnits?: number;
  readonly settled: number;
}): boolean {
  const billableUnits = Math.max(report.units, report.inputUnits ?? 0);
  // !(settled > 0) 一并盖住 0、负数、NaN 和字段缺失，别让响应形状变化绕开哨兵。
  return billableUnits > 0 && !(report.settled > 0);
}

export function formatSilentSettlement(report: SilentSettlementReport): string {
  const inputUnits = report.inputUnits === undefined ? "" : ` inputUnits=${report.inputUnits}`;
  return `[billing] 结算静默归零：${report.units} 单位真实用量只结算到 ${report.settled} 点`
    + ` kind=${report.kind} operationId=${report.operationId} resourceKey=${report.resourceKey}${inputUnits}`
    + "；这笔预留大概率已被兜底提前关账，需要按实际用量补收";
}
export interface RechargePackageRow {
  id: string; name: string; amountFen: number; points: number; enabled: boolean; sortOrder: number;
}
export interface MembershipCardRow {
  id: number; name: string; priceFen: number; durationDays: number;
  cadence: string; grantPoints: number; kbQuotaBytes: number; enabled: boolean;
  createdAt: string; updatedAt: string;
}
export interface UpsertCardArgs {
  id?: number; name: string; priceFen: number; durationDays: number;
  cadence: string; grantPoints: number; kbQuotaBytes?: number; enabled: boolean;
}
export interface PointsDetail {
  totalPoints: number;
  permanentPoints: number;
  membershipPoints: number;
  videoBalance: number;
  currentPeriod: { granted: number; remaining: number; used: number; expiresAt: string } | null;
  membership: { cardName: string; cadence: string; expiresAt: string } | null;
}

export function createBillingClient(opts: BillingClientOpts) {
  const f = opts.fetchFn ?? fetch;
  const reportSilentSettlement = opts.onSilentSettlement
    ?? ((report: SilentSettlementReport) => {
      console.warn(formatSilentSettlement(report));
    });
  const guardSettlement = (report: SilentSettlementReport): void => {
    if (!isSilentSettlement(report)) return;
    // 哨兵自身出错不能把一笔已经成功的结算变成失败——那会让调用方去退款或重试，
    // 比漏计费更糟。
    try {
      reportSilentSettlement(report);
    } catch {
      // 落点自己坏了就只能沉默，结算结果照常返回。
    }
  };
  const post = async (path: string, body: unknown) => {
    const r = await f(`${opts.baseUrl}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": opts.token },
      body: JSON.stringify(body),
    });
    if (r.status === 402) throw new InsufficientBalanceError();
    if (!r.ok) throw new BillingHttpError(path, r.status);
    return r.json();
  };
  const get = async (path: string) => {
    const r = await f(`${opts.baseUrl}/${path}`, {
      method: "GET",
      headers: { "x-internal-token": opts.token },
    });
    if (!r.ok) throw new BillingHttpError(path, r.status);
    return r.json();
  };
  const patch = async (path: string, body: unknown) => {
    const r = await f(`${opts.baseUrl}/${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-internal-token": opts.token },
      body: JSON.stringify(body),
    });
    if (r.status === 402) throw new InsufficientBalanceError();
    if (!r.ok) throw new BillingHttpError(path, r.status);
    return r.json();
  };
  const put = async (path: string, body: unknown) => {
    const r = await f(`${opts.baseUrl}/${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-internal-token": opts.token },
      body: JSON.stringify(body),
    });
    if (r.status === 402) throw new InsufficientBalanceError();
    if (!r.ok) throw new BillingHttpError(path, r.status);
    return r.json();
  };
  return {
    reserve: (a: ReserveArgs) => post("reserve", a) as Promise<{ reserved: number }>,
    settle: (a: SettleArgs) => post("settle", a) as Promise<{ settled: number }>,
    createTopup: (a: CreateTopupArgs) => post("topup", a) as Promise<{ payUrl: string; tradeNo: string }>,
    getTopupOrder: (userId: string, tradeNo: string) =>
      get(`topup/${encodeURIComponent(userId)}/${encodeURIComponent(tradeNo)}`) as Promise<{ data: TopupOrderRow }>,
    redeem: (a: RedeemArgs) => post("redeem", a) as Promise<{ success: boolean }>,
    getBalance: (userId: string) => get(`balance/${userId}`) as Promise<{ balance: number; videoBalance: number }>,
    pointsDetail: (userId: string) =>
      get(`points-detail/${encodeURIComponent(userId)}`) as Promise<PointsDetail>,
    getVipSummary: (userId: string) =>
      get(`vip/me/${encodeURIComponent(userId)}`) as Promise<{ data: VipSummary }>,
    listModelMarketplace: (userId: string) =>
      get(`model-marketplace/${encodeURIComponent(userId)}`) as Promise<{ data: ModelMarketplaceRow[]; vip: VipSummary }>,
    listUsage: (userId: string, limit = 20) =>
      get(`usage/${encodeURIComponent(userId)}?limit=${limit}`) as Promise<{ data: UsageRow[] }>,
    // —— admin 扩展 ——
    generateCodes: (a: GenerateCodesArgs) =>
      post("internal/admin/codes", a) as Promise<{ codes: string[] }>,
    listCodes: (q: { status?: string; grantType?: string; batchId?: string; limit?: number } = {}) => {
      const sp = new URLSearchParams();
      if (q.status) sp.set("status", q.status);
      if (q.grantType) sp.set("grantType", q.grantType);
      if (q.batchId) sp.set("batchId", q.batchId);
      if (q.limit) sp.set("limit", String(q.limit));
      const qs = sp.toString();
      return get(`internal/admin/codes${qs ? `?${qs}` : ""}`) as Promise<{ data: CodeRow[] }>;
    },
    disableCode: (code: string) =>
      post("internal/admin/codes/disable", { code }) as Promise<{ success: boolean }>,
    adjustBalance: (a: AdjustBalanceArgs) =>
      post("internal/admin/balance-adjust", a) as Promise<{ before: number; after: number }>,
    batchBalances: (userIds: string[]) =>
      post("internal/admin/balances", { userIds }) as Promise<{ balances: Record<string, number> }>,
    adminListVipLevels: () =>
      get("internal/admin/vip-levels") as Promise<{ data: VipLevelRow[] }>,
    adminUpsertVipLevel: (a: UpsertVipLevelArgs) =>
      post("internal/admin/vip-levels", a) as Promise<{ success: boolean; data: VipLevelRow }>,
    adminDeleteVipLevel: (id: number) =>
      post("internal/admin/vip-levels/delete", { id }) as Promise<{ success: boolean }>,
    listModels: () => get("internal/admin/models") as Promise<{ data: ModelRow[] }>,
    upsertModel: (a: UpsertModelArgs) =>
      post("internal/admin/models", a) as Promise<{ success: boolean }>,
    updateModelPricing: (a: { model: string } & (TokenPricing | RmbPricing)) =>
      patch("internal/admin/models/pricing", a) as Promise<{ success: boolean }>,
    updateModelDisplay: (a: { model: string; displayName: string; enabled: boolean } & ModelMarketplaceMeta) =>
      patch("internal/admin/models/display", a) as Promise<{ success: boolean }>,
    updateModelIdentity: (a: { model: string; newModel: string; displayName: string; enabled: boolean }) =>
      patch("internal/admin/models/identity", a) as Promise<{ success: boolean }>,
    deleteModel: (model: string) =>
      post("internal/admin/models/delete", { model }) as Promise<{ success: boolean }>,
    getModelStats: (model: string) =>
      get(`internal/admin/models/stats?model=${encodeURIComponent(model)}`) as Promise<{ data: ModelStatsRow }>,
    listEnabledModels: () =>
      get("internal/models") as Promise<{
        data: { model: string; displayName: string; maxOutputTokens: number; tags: string }[];
      }>,
    // —— BI 分析 ——
    analyticsDaily: (from: string, to: string) =>
      get(`internal/admin/analytics/daily?from=${from}&to=${to}`) as Promise<{ data: AnalyticsDailyRow[] }>,
    revenueByUsers: (userIds: string[]) =>
      post("internal/admin/analytics/revenue-by-users", { userIds }) as Promise<{ data: Record<string, RevenueEvent[]> }>,
    summaryByUsers: (userIds: string[]) =>
      post("internal/admin/analytics/summary-by-users", { userIds }) as Promise<{ data: Record<string, UserAggRow> }>,
    analyticsRankings: (from: string, to: string, limit = 10) =>
      get(`internal/admin/analytics/rankings?from=${from}&to=${to}&limit=${limit}`) as Promise<{ data: RankingsSummary }>,
    analyticsSales: (from: string, to: string) =>
      get(`internal/admin/analytics/sales?from=${from}&to=${to}`) as Promise<{ data: SalesSummary }>,
    analyticsBalances: () =>
      get("internal/admin/analytics/balances") as Promise<{ data: BalanceSummary }>,
    listAdminOrders: (q: ListAdminOrdersParams = {}) => {
      const sp = new URLSearchParams();
      if (q.userId) sp.set("userId", q.userId);
      if (q.userIds?.length) sp.set("userIds", q.userIds.join(","));
      if (q.tradeNo) sp.set("tradeNo", q.tradeNo);
      if (q.status) sp.set("status", q.status);
      if (q.kind) sp.set("kind", q.kind);
      if (q.provider) sp.set("provider", q.provider);
      if (q.paymentMethod) sp.set("paymentMethod", q.paymentMethod);
      if (q.from) sp.set("from", q.from);
      if (q.to) sp.set("to", q.to);
      if (q.limit) sp.set("limit", String(q.limit));
      if (q.offset) sp.set("offset", String(q.offset));
      const qs = sp.toString();
      return get(`internal/admin/orders${qs ? `?${qs}` : ""}`) as Promise<{
        data: AdminOrderRow[];
        total: number;
        summary: AdminOrderSummary;
      }>;
    },
    analyticsUserSummary: (userId: string, today: string) =>
      get(`internal/admin/analytics/user-summary?userId=${encodeURIComponent(userId)}&today=${today}`) as Promise<{ data: UserBillingSummary }>,
    // —— 资源价与汇率 ——
    listResourcePrices: () => get("internal/admin/resource-prices") as Promise<{ data: ResourcePriceRow[] }>,
    upsertResourcePrice: (a: UpsertResourcePriceArgs) =>
      post("internal/admin/resource-prices", a) as Promise<{ success: boolean }>,
    deleteResourcePrice: (resourceKey: string) =>
      post("internal/admin/resource-prices/delete", { resourceKey }) as Promise<{ success: boolean }>,
    getRechargeRatio: () => get("internal/admin/config/recharge-ratio") as Promise<{ ratio: number }>,
    setRechargeRatio: (ratio: number) =>
      put("internal/admin/config/recharge-ratio", { ratio }) as Promise<{ success: boolean }>,
    listRechargePackages: () =>
      get("recharge-packages") as Promise<{ data: RechargePackageRow[] }>,
    adminListRechargePackages: () =>
      get("internal/admin/config/recharge-packages") as Promise<{ data: RechargePackageRow[] }>,
    setRechargePackages: (packages: RechargePackageRow[]) =>
      put("internal/admin/config/recharge-packages", { packages }) as Promise<{ success: boolean }>,
    // —— 月卡管理 ——
    listMembershipCards: () =>
      get("internal/admin/membership-cards") as Promise<{ data: MembershipCardRow[] }>,
    upsertMembershipCard: (a: UpsertCardArgs) =>
      post("internal/admin/membership-cards", a) as Promise<{ success: boolean }>,
    deleteMembershipCard: (id: number) =>
      post("internal/admin/membership-cards/delete", { id }) as Promise<{ success: boolean }>,
    // —— 用户端月卡 ——
    buyMembership: (userId: string, cardId: number, method: PaymentMethod = "alipay") =>
      post("membership/buy", { userId, cardId, method }) as Promise<{ payUrl: string; tradeNo: string }>,
    listEnabledCards: () =>
      get("membership/cards") as Promise<{ data: MembershipCardRow[] }>,
    myMemberships: (userId: string) =>
      get(`membership/mine/${userId}`) as Promise<{ data: any[] }>,
    // —— 配额与点数 ——
    chargePoints: (a: { operationId: string; userId: string; points: number; kind: string }) =>
      post("charge-points", a) as Promise<{ charged: number }>,
    chargeResource: (a: ChargeResourceArgs) =>
      post("resource/charge", a) as Promise<{ charged: number }>,
    reserveResource: (a: ReserveResourceArgs) =>
      post("resource/reserve", a) as Promise<{ reserved: number }>,
    settleResource: async (a: SettleResourceArgs) => {
      const receipt = await post("resource/settle", a) as { settled: number };
      guardSettlement({ kind: "resource", ...a, settled: receipt?.settled });
      return receipt;
    },
    settleVideoResource: async (a: SettleVideoResourceArgs) => {
      const receipt = await post("resource/settle-video", a) as { settled: number };
      guardSettlement({ kind: "video", ...a, settled: receipt?.settled });
      return receipt;
    },
    refundResource: (operationId: string) =>
      post("resource/refund", { operationId }) as Promise<{ success: boolean }>,
    getUserKbQuota: (userId: string) =>
      get(`user-kb-quota?userId=${encodeURIComponent(userId)}`) as Promise<{ membershipBytes: number; defaultBytes: number }>,
    getKbDefaultQuota: () =>
      get("internal/admin/config/kb-default-quota") as Promise<{ bytes: number }>,
    setKbDefaultQuota: (bytes: number) =>
      put("internal/admin/config/kb-default-quota", { bytes }) as Promise<{ success: boolean }>,
  };
}
