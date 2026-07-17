import { loadSession, clearSession, type Session } from "./auth.js";

export class UnauthorizedError extends Error {}
export class ForbiddenError extends Error {}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const s = loadSession();
  const headers: Record<string, string> = {};
  if (s) headers.authorization = `Bearer ${s.token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status === 401) {
    clearSession();
    throw new UnauthorizedError("登录已过期，请重新登录");
  }
  if (r.status === 403) throw new ForbiddenError("无权限执行该操作");
  if (!r.ok) {
    let msg = `请求失败 (${r.status})`;
    try { msg = (await r.json()).error ?? msg; } catch { /* 忽略 */ }
    throw new Error(msg);
  }
  return (await r.json()) as T;
}

// —— 鉴权 ——
export async function login(username: string, password: string): Promise<Session> {
  return req<Session>("POST", "/api/admin/login", { username, password });
}

// —— 用户 ——
export interface AdminUser {
  id: string;
  uid: string;
  username: string;
  bannedAt: string | null;
  createdAt: string;
  balance: number | null;
}
export async function listUsers(q?: string): Promise<AdminUser[]> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  return (await req<{ data: AdminUser[] }>("GET", `/api/admin/users${qs}`)).data;
}
export async function createUser(username: string, password: string): Promise<void> {
  await req("POST", "/api/admin/users", { username, password });
}
export async function banUser(id: string): Promise<void> {
  await req("POST", `/api/admin/users/${id}/ban`);
}
export async function unbanUser(id: string): Promise<void> {
  await req("POST", `/api/admin/users/${id}/unban`);
}
export async function adjustBalance(
  id: string,
  delta: number,
  reason: string,
  idempotencyKey: string,
  accountType: "points" | "video" = "points"
): Promise<{ before: number; after: number }> {
  return (await req<{ data: { before: number; after: number } }>("POST", `/api/admin/users/${id}/balance`, { delta, reason, accountType, idempotencyKey })).data;
}

export interface OrderUser {
  id: string;
  uid: string;
  username: string;
}
export interface OrderRow {
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
  user: OrderUser | null;
}
export interface OrderSummary {
  total: number;
  successCount: number;
  pendingCount: number;
  closedCount: number;
  successAmountFen: number;
  successPoints: number;
  payingUsers: number;
}
export interface OrderListParams {
  user?: string;
  userId?: string;
  tradeNo?: string;
  status?: string;
  kind?: string;
  paymentMethod?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}
export interface OrderListResult {
  data: OrderRow[];
  total: number;
  summary: OrderSummary;
}
export async function listOrders(params: OrderListParams = {}): Promise<OrderListResult> {
  const sp = new URLSearchParams();
  if (params.user) sp.set("user", params.user);
  if (params.userId) sp.set("userId", params.userId);
  if (params.tradeNo) sp.set("tradeNo", params.tradeNo);
  if (params.status) sp.set("status", params.status);
  if (params.kind) sp.set("kind", params.kind);
  if (params.paymentMethod) sp.set("paymentMethod", params.paymentMethod);
  if (params.from) sp.set("from", params.from);
  if (params.to) sp.set("to", params.to);
  if (params.limit) sp.set("limit", String(params.limit));
  if (params.offset) sp.set("offset", String(params.offset));
  const qs = sp.toString();
  return req("GET", `/api/admin/orders${qs ? `?${qs}` : ""}`);
}

// —— 兑换码 ——
export interface CodeRow {
  code: string;
  grantType: string;
  grantPayload: string;
  points: number;
  status: string;
  batchID: string;
  usedBy: string;
  expiresAt: string | null;
  createdAt: string;
  usedAt: string | null;
}
export async function listCodes(params: { status?: string; grantType?: string } = {}): Promise<CodeRow[]> {
  const sp = new URLSearchParams();
  if (params.status) sp.set("status", params.status);
  if (params.grantType) sp.set("grantType", params.grantType);
  const qs = sp.toString();
  return (await req<{ data: CodeRow[] }>("GET", `/api/admin/codes${qs ? `?${qs}` : ""}`)).data;
}
export interface GenCodesArgs {
  grantType: string;
  grantPayload: string;
  points?: number;
  count: number;
  expiresAt?: number;
}
export async function generateCodes(a: GenCodesArgs): Promise<string[]> {
  return (await req<{ data: { codes: string[] } }>("POST", "/api/admin/codes", a)).data.codes;
}
export async function disableCode(code: string): Promise<void> {
  await req("POST", "/api/admin/codes/disable", { code });
}

// —— 模型 ——
export interface ModelRow {
  model: string;
  displayName: string;
  modelRatio?: number;
  completionRatio?: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  cacheInputPricePerMillion: number;
  cacheOutputPricePerMillion: number;
  inputPriceRmbPerMillion: number;
  outputPriceRmbPerMillion: number;
  cacheInputPriceRmbPerMillion: number;
  cacheOutputPriceRmbPerMillion: number;
  description: string;
  tags: string;
  contextLength: number;
  maxOutputTokens: number;
  useCases: string;
  sortOrder: number;
  showInMarketplace: boolean;
  enabled: boolean;
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
export async function listModels(): Promise<ModelRow[]> {
  return (await req<{ data: ModelRow[] }>("GET", "/api/admin/models")).data;
}
export type UpsertModelRow = Pick<
  ModelRow,
  | "model"
  | "displayName"
  | "enabled"
  | "inputPriceRmbPerMillion"
  | "outputPriceRmbPerMillion"
  | "cacheInputPriceRmbPerMillion"
  | "cacheOutputPriceRmbPerMillion"
> & Partial<Pick<ModelRow, "description" | "tags" | "contextLength" | "maxOutputTokens" | "useCases" | "sortOrder" | "showInMarketplace">>;
export async function upsertModel(a: UpsertModelRow): Promise<void> {
  await req("POST", "/api/admin/models", a);
}
export async function updateModelPricing(
  model: string,
  pricing: Pick<ModelRow, "inputPriceRmbPerMillion" | "outputPriceRmbPerMillion" | "cacheInputPriceRmbPerMillion" | "cacheOutputPriceRmbPerMillion">
): Promise<void> {
  await req("PATCH", "/api/admin/models/pricing", { model, ...pricing });
}
export type ModelMarketplacePatch = Partial<Pick<ModelRow, "description" | "tags" | "contextLength" | "maxOutputTokens" | "useCases" | "sortOrder" | "showInMarketplace">>;
export async function updateModelDisplay(model: string, displayName: string, enabled: boolean, patch: ModelMarketplacePatch = {}): Promise<void> {
  await req("PATCH", "/api/admin/models/display", { model, displayName, enabled, ...patch });
}
export async function updateModelIdentity(a: { model: string; newModel: string; displayName: string; enabled: boolean }): Promise<void> {
  await req("PATCH", "/api/admin/models/identity", a);
}
export async function deleteModel(model: string): Promise<void> {
  await req("POST", "/api/admin/models/delete", { model });
}
export async function getModelStats(model: string): Promise<ModelStatsRow> {
  const qs = new URLSearchParams({ model });
  return (await req<{ data: ModelStatsRow }>("GET", `/api/admin/models/stats?${qs}`)).data;
}

// —— 公告 ——
export interface Announcement {
  id: string;
  title: string;
  body: string;
  active: boolean;
  startAt: string | null;
  endAt: string | null;
  createdAt: string;
}
export async function listAnnouncements(): Promise<Announcement[]> {
  return (await req<{ data: Announcement[] }>("GET", "/api/admin/announcements")).data;
}
export async function createAnnouncement(a: { title: string; body: string; active: boolean }): Promise<void> {
  await req("POST", "/api/admin/announcements", a);
}
export async function updateAnnouncement(id: string, a: Partial<{ title: string; body: string; active: boolean }>): Promise<void> {
  await req("PATCH", `/api/admin/announcements/${id}`, a);
}
export async function deleteAnnouncement(id: string): Promise<void> {
  await req("DELETE", `/api/admin/announcements/${id}`);
}

// —— 管理员（超管）——
export interface AdminRow {
  id: string;
  username: string;
  role: string;
  permissions: string[];
  disabled: boolean;
  createdAt: string;
}
export async function listAdmins(): Promise<AdminRow[]> {
  return (await req<{ data: AdminRow[] }>("GET", "/api/admin/admins")).data;
}
export async function createAdminAccount(a: { username: string; password: string; permissions: string[] }): Promise<void> {
  await req("POST", "/api/admin/admins", a);
}
export async function updateAdminAccount(id: string, a: Partial<{ permissions: string[]; disabled: boolean }>): Promise<void> {
  await req("PATCH", `/api/admin/admins/${id}`, a);
}

// —— 审计 ——
export interface AuditRow {
  id: string;
  adminId: string;
  action: string;
  target: string | null;
  detail: unknown;
  createdAt: string;
}
export async function listAudit(limit = 100): Promise<AuditRow[]> {
  return (await req<{ data: AuditRow[] }>("GET", `/api/admin/audit?limit=${limit}`)).data;
}

// —— 数据分析 ——
export interface AnalyticsOverview {
  totalRegistered: number;
  dau: number;
  wau: number;
  mau: number;
  payingTotal: number;
  paymentRate: number;
  totalRevenueYuan: number;
  arpu: number;
  arppu: number;
  totalBalance: number | null;
  usersWithBalance: number | null;
  videoPointsBalance: number | null;
  onlineDevices: number;
  onlineSecondsToday: number;
  imageTasksToday: number;
  imageTasksMonth: number;
  imageTasksTotal: number;
  generatedImagesToday: number;
  generatedImagesMonth: number;
  generatedImagesTotal: number;
  kbUploadsToday: number;
  kbUploadsMonth: number;
  kbUploadsTotal: number;
  kbUploadBytesTotal: number;
}
export interface DailyRow {
  date: string;
  registered: number;
  dau: number;
  wau: number;
  mau: number;
  revenueYuan: number;
  grantedPoints: number;
  consumedPoints: number;
  newPayingUsers: number;
  topupCount: number;
  payingUsers: number;
  rechargeUsageRatio: number | null;
}
export interface RankingRow {
  key: string;
  points: number;
  tokens: number;
  count: number;
}
export interface RankingsSummary {
  users: RankingRow[];
  models: RankingRow[];
  features: RankingRow[];
}
export interface SalesRow {
  key: string;
  name: string;
  orders: number;
  users: number;
  revenueFen: number;
  points: number;
}
export interface SalesSummary {
  memberships: SalesRow[];
  rechargePackages: SalesRow[];
}
export interface CohortMatrix {
  offsets: number[];
  cohorts: { cohortDate: string; cohortSize: number; cells: Record<number, number | null> }[];
}
export async function analyticsOverview(): Promise<{ data: AnalyticsOverview | null; lastRolledAt: string | null }> {
  return req("GET", "/api/admin/analytics/overview");
}
export async function analyticsDaily(days = 30): Promise<DailyRow[]> {
  return (await req<{ data: DailyRow[] }>("GET", `/api/admin/analytics/daily?days=${days}`)).data;
}
export async function analyticsRetention(): Promise<CohortMatrix> {
  return (await req<{ data: CohortMatrix }>("GET", "/api/admin/analytics/retention")).data;
}
export async function analyticsLtv(): Promise<CohortMatrix> {
  return (await req<{ data: CohortMatrix }>("GET", "/api/admin/analytics/ltv")).data;
}
export async function analyticsRankings(days = 30): Promise<RankingsSummary> {
  return (await req<{ data: RankingsSummary }>("GET", `/api/admin/analytics/rankings?days=${days}`)).data;
}
export async function analyticsSales(days = 30): Promise<SalesSummary> {
  return (await req<{ data: SalesSummary }>("GET", `/api/admin/analytics/sales?days=${days}`)).data;
}
export async function analyticsRebuild(from: string, to: string): Promise<{ metricDays: number; cohorts: number }> {
  return (await req<{ data: { metricDays: number; cohorts: number } }>("POST", "/api/admin/analytics/rebuild", { from, to })).data;
}

export interface UserActivityPeriod {
  key: string;
  sessions: number;
  messages: number;
  agents: number;
  knowledgeBases: number;
  kbDocuments: number;
  imageTasks: number;
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
export interface UserConsumptionRecord {
  operationId: string;
  type: string;
  model: string;
  displayName: string;
  status: string;
  reservedPoints: number;
  actualPoints: number;
  originalPoints: number;
  vipLevelName: string;
  vipDiscountBps: number;
  vipSavedPoints: number;
  vipGrowthPoints: number;
  inputTokens: number;
  outputTokens: number;
  cacheInputTokens: number;
  cacheOutputTokens: number;
  createdAt: string;
  settledAt: string | null;
}
export interface UserDetail {
  user: Omit<AdminUser, "balance">;
  kpis: {
    onlineToday: boolean;
    onlineDevices: number;
    loginCountToday: number;
    todayToken: number;
    todayAgent: number;
    totalToken: number;
    todayRechargeYuan: number;
    todayConsumptionPoints: number;
    totalRechargeYuan: number;
    totalConsumptionPoints: number;
    balance: number | null;
    currentMemberships: unknown[];
  };
  activity: UserActivityPeriod[];
  devices: Array<{
    id: string;
    name: string | null;
    platform: string;
    appVersion: string;
    online: boolean;
    lastSeenAt: string | null;
    createdAt: string;
    onlineSecondsToday: number;
  }>;
  vipSummary: VipSummary | null;
  consumptionRecords: UserConsumptionRecord[];
  rechargeEvents: Array<{ paidAtDate: string; amountFen: number; points: number }>;
  timeline: Array<{ type: string; title: string; at: string; meta: string }>;
}
export interface UserBillingLog {
  user: Omit<AdminUser, "balance">;
  vipSummary: VipSummary | null;
  consumptionRecords: UserConsumptionRecord[];
}
export async function getUserDetail(id: string): Promise<UserDetail> {
  return (await req<{ data: UserDetail }>("GET", `/api/admin/users/${id}/detail`)).data;
}
export async function getUserBillingLog(id: string): Promise<UserBillingLog> {
  return (await req<{ data: UserBillingLog }>("GET", `/api/admin/users/${id}/billing-log`)).data;
}

// —— 知识库管理 ——
export interface KnowledgeBase {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
export interface KbDocument {
  id: string;
  kbId: string;
  name: string;
  status: string;
  chunkCount: number;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}
export async function adminListKb(): Promise<KnowledgeBase[]> {
  return (await req<{ data: KnowledgeBase[] }>("GET", "/api/admin/kb")).data;
}
export async function createKb(name: string): Promise<KnowledgeBase> {
  return (await req<{ data: KnowledgeBase }>("POST", "/api/admin/kb", { name })).data;
}
export async function updateKb(id: string, name: string): Promise<void> {
  await req("PATCH", `/api/admin/kb/${id}`, { name });
}
export async function deleteKb(id: string): Promise<void> {
  await req("DELETE", `/api/admin/kb/${id}`);
}
export async function listKbDocs(kbId: string): Promise<KbDocument[]> {
  return (await req<{ data: KbDocument[] }>("GET", `/api/admin/kb/${kbId}/documents`)).data;
}
export async function addKbDoc(kbId: string, file: File): Promise<KbDocument> {
  const form = new FormData();
  form.append("file", file);
  const s = loadSession();
  const headers: Record<string, string> = {};
  if (s) headers.authorization = `Bearer ${s.token}`;
  const r = await fetch(`/api/admin/kb/${kbId}/documents`, { method: "POST", headers, body: form });
  if (r.status === 401) {
    clearSession();
    throw new UnauthorizedError("登录已过期，请重新登录");
  }
  if (r.status === 403) throw new ForbiddenError("无权限执行该操作");
  if (!r.ok) {
    let msg = `请求失败 (${r.status})`;
    try { msg = (await r.json()).error ?? msg; } catch { /* 忽略 */ }
    throw new Error(msg);
  }
  return ((await r.json()) as { data: KbDocument }).data;
}
export async function deleteKbDoc(kbId: string, docId: string): Promise<void> {
  await req("DELETE", `/api/admin/kb/${kbId}/documents/${docId}`);
}

export async function grantUserKbQuota(userId: string, a: { bytes: number; expiresAt?: string; note?: string }): Promise<void> {
  await req("POST", `/api/admin/users/${userId}/kb-quota`, a);
}

// —— 月卡管理 ——
export interface MembershipCardRow {
  id: number;
  name: string;
  priceFen: number;
  durationDays: number;
  cadence: string;
  grantPoints: number;
  kbQuotaBytes?: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
export async function listMembershipCards(): Promise<MembershipCardRow[]> {
  return (await req<{ data: MembershipCardRow[] }>("GET", "/api/admin/membership-cards")).data;
}
export async function upsertMembershipCard(a: { id?: number; name: string; priceFen: number; durationDays: number; cadence: string; grantPoints: number; kbQuotaBytes?: number; enabled: boolean }): Promise<void> {
  await req("POST", "/api/admin/membership-cards", a);
}
export async function deleteMembershipCard(id: number): Promise<void> {
  await req("POST", "/api/admin/membership-cards/delete", { id });
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
export async function listVipLevels(): Promise<VipLevelRow[]> {
  return (await req<{ data: VipLevelRow[] }>("GET", "/api/admin/vip-levels")).data;
}
export async function upsertVipLevel(a: UpsertVipLevelArgs): Promise<void> {
  await req("POST", "/api/admin/vip-levels", a);
}
export async function deleteVipLevel(id: number): Promise<void> {
  await req("POST", "/api/admin/vip-levels/delete", { id });
}

// —— 资源计价 ——
export interface ResourcePriceRow {
  resourceKey: string;
  displayName: string;
  pricingType: "PER_CALL" | "PER_UNIT" | "VIDEO_IO";
  rate: number;
  outputRate?: number;
  perUnits: number;
  enabled: boolean;
}
export async function listResourcePrices(): Promise<ResourcePriceRow[]> {
  return (await req<{ data: ResourcePriceRow[] }>("GET", "/api/admin/resource-prices")).data;
}
export async function upsertResourcePrice(a: ResourcePriceRow): Promise<void> {
  await req("POST", "/api/admin/resource-prices", a);
}
export async function deleteResourcePrice(resourceKey: string): Promise<void> {
  await req("POST", "/api/admin/resource-prices/delete", { resourceKey });
}
export async function getRechargeRatio(): Promise<number> {
  return (await req<{ ratio: number }>("GET", "/api/admin/config/recharge-ratio")).ratio;
}
export async function setRechargeRatio(ratio: number): Promise<void> {
  await req("PUT", "/api/admin/config/recharge-ratio", { ratio });
}
export interface RechargePackageRow {
  id: string;
  name: string;
  amountFen: number;
  points: number;
  enabled: boolean;
  sortOrder: number;
}
export async function listRechargePackages(): Promise<RechargePackageRow[]> {
  return (await req<{ data: RechargePackageRow[] }>("GET", "/api/admin/config/recharge-packages")).data;
}
export async function setRechargePackages(packages: RechargePackageRow[]): Promise<void> {
  await req("PUT", "/api/admin/config/recharge-packages", { packages });
}

// —— 分销代理（总台）——
export interface ResellerRow {
  channelId: string; code: string; commissionRate: number; enabled: boolean;
  resellerId: string | null; username: string | null; disabled: boolean | null; createdAt: string;
}
export interface ChannelSummary { totalUsers: number; totalRechargeFen: number; commissionFen: number; }
export interface ResellerVisibility { showRecharge: boolean; showConsumption: boolean; showMembership: boolean; showLastActive: boolean; }

export async function listResellers(): Promise<ResellerRow[]> {
  return (await req<{ data: ResellerRow[] }>("GET", "/api/admin/resellers")).data;
}
export async function createReseller(b: { username: string; password: string; code: string; commissionRate: number }): Promise<void> {
  await req("POST", "/api/admin/resellers", b);
}
export async function updateReseller(channelId: string, b: { commissionRate?: number; enabled?: boolean }): Promise<void> {
  await req("PATCH", `/api/admin/resellers/${channelId}`, b);
}
export async function resellerSummary(channelId: string): Promise<ChannelSummary> {
  return (await req<{ data: ChannelSummary }>("GET", `/api/admin/resellers/${channelId}/summary`)).data;
}
export async function getResellerVisibility(): Promise<ResellerVisibility> {
  return (await req<{ data: ResellerVisibility }>("GET", "/api/admin/reseller-visibility")).data;
}
export async function setResellerVisibility(b: Partial<ResellerVisibility>): Promise<ResellerVisibility> {
  return (await req<{ data: ResellerVisibility }>("PUT", "/api/admin/reseller-visibility", b)).data;
}

// —— 代理自助 ——
export async function myChannelSummary(): Promise<ChannelSummary> {
  return (await req<{ data: ChannelSummary }>("GET", "/api/reseller/summary")).data;
}
export interface MyChannelUsers { rows: Record<string, unknown>[]; total: number; page: number; pageSize: number; }
export async function myChannelUsers(page = 1, pageSize = 20): Promise<MyChannelUsers> {
  return (await req<{ data: MyChannelUsers }>("GET", `/api/reseller/users?page=${page}&pageSize=${pageSize}`)).data;
}
