/**
 * 前端 API 客户端的门面 + 尚未分域的接口。P2.4 批次二 Step 2 把三个最大的域整块搬走了：
 * 小说 → `novelApi.ts`（71 个导出）、知识库 → `kbApi.ts`（14 个）、记忆 → `memoryApi.ts`（9 个）。
 * 这里用 `export *` 原样转发，纯粹是为了让 68 个调用方和全部测试文件一行都不用改；
 * **新代码请直接从域文件 import**，也不要再往本文件加小说 / 知识库 / 记忆的接口。
 *
 * 留在本文件的是还没独立成域的部分：auth、`streamChat`、工具市场、点数 / 充值 / 分销、
 * 生图工作流及其计价、月卡、微信绑定、模型列表、会话、智能体。
 * `streamChat` 是刻意不搬的 —— 它是聊天页唯一的流式入口，拆出去会把 auth 的 token 语义
 * 和会话状态切成两个文件读。
 */
import { ApiError } from "./apiError";
import { request, requestResponse } from "./http";

export * from "./novelApi";
export * from "./kbApi";
export * from "./memoryApi";

export async function register(username: string, password: string, channelCode: string): Promise<string> {
  try {
    // 注册/登录显式传 token: null——这两个页面不该把 localStorage 里可能残留的旧 token 带上。
    const data = await request<{ token: string }>("/api/auth/register", {
      method: "POST",
      token: null,
      body: { username, password, channelCode },
      fallback: "注册失败",
    });
    return data.token;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) throw new Error("用户名已被占用");
    throw error;
  }
}

export async function login(identifier: string, password: string): Promise<string> {
  try {
    const data = await request<{ token: string }>("/api/auth/login", {
      method: "POST",
      token: null,
      body: { identifier, password },
    });
    return data.token;
  } catch (error) {
    // 凭据错误统一提示，不把后端原文回显到登录界面。
    if (error instanceof ApiError) throw new Error("登录失败");
    throw error;
  }
}

export interface MeResponse {
  userId: string;
  uid: string;
  username: string;
}

export async function getMe(token: string): Promise<MeResponse> {
  return request<MeResponse>("/api/auth/me", { token, fallback: "获取账号信息失败" });
}

export async function streamChat(
  token: string,
  message: string,
  sessionId: string | undefined,
  onEvent: (event: string, data: unknown) => void,
  model?: string,
  agentId?: string,
  kbIds?: string[],
  attachAllOwn?: boolean,
  attachments?: ChatAttachmentPayload[],
  toolIds?: string[],
): Promise<void> {
  // 桌面 app 会把「当前这台连接器」的 deviceId 暴露到 window.aiAssistantDesktop.deviceId，
  // 带上它后端就能把工具派给用户正在操作的这台（多设备登录同一账号时不再派错机器）。
  const deviceId =
    typeof window !== "undefined"
      ? (window as unknown as { aiAssistantDesktop?: { deviceId?: string } }).aiAssistantDesktop?.deviceId
      : undefined;
  // 不走 request<T>()：这是 SSE 流，body 要整个留给下面的 reader。
  const r = await requestResponse("/api/chat", {
    method: "POST",
    token,
    body: { message, sessionId, model, agentId, kbIds, attachAllOwn, attachments, toolIds, deviceId },
    fallback: "发送失败",
  });
  if (!r.body) throw new Error("连接失败");
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    buf = chunks.pop() ?? "";
    for (const c of chunks) {
      const ev = c.match(/^event: (.+)$/m)?.[1];
      const dt = c.match(/^data: (.+)$/m)?.[1];
      if (ev && dt) {
        try {
          onEvent(ev, JSON.parse(dt));
        } catch {
          // 忽略畸形 SSE 数据，避免整条流崩溃
        }
      }
    }
  }
}

export interface ToolMarketCategory {
  key: string;
  label: string;
  total: number;
}

export interface MarketSkill {
  id: string;
  name: string;
}

export interface ToolMarketCategoryDetail extends ToolMarketCategory {
  skills: MarketSkill[];
}

export interface InstalledTool {
  id: string;
  name: string;
  toolName: string;
  description: string;
  categoryKey?: string;
  marketId?: string;
  status?: string;
  builtin: boolean;
  installed: boolean;
  availableOnCurrentDevice: boolean;
}

export interface InstalledToolsResponse {
  currentDeviceOnline: boolean;
  builtin: InstalledTool[];
  installed: InstalledTool[];
}

type InstalledToolPayload = Omit<InstalledTool, "availableOnCurrentDevice"> & {
  availableOnCurrentDevice?: boolean;
};

function normalizeInstalledTool(tool: InstalledToolPayload): InstalledTool {
  return {
    ...tool,
    availableOnCurrentDevice: tool.availableOnCurrentDevice ?? tool.installed,
  };
}

export async function listToolMarketCategories(token: string): Promise<ToolMarketCategory[]> {
  const rows = await request<ToolMarketCategory[]>("/api/tool-market", { token, fallback: "获取工具市场失败" });
  return rows ?? [];
}

export async function listToolMarketSkills(token: string, categoryKey: string): Promise<ToolMarketCategoryDetail> {
  return request<ToolMarketCategoryDetail>(`/api/tool-market/${encodeURIComponent(categoryKey)}`, {
    token,
    fallback: "获取工具列表失败",
  });
}

export async function listInstalledTools(token: string): Promise<InstalledToolsResponse> {
  const data = await request<{
    currentDeviceOnline?: boolean;
    builtin?: InstalledToolPayload[];
    installed?: InstalledToolPayload[];
  } | undefined>("/api/tools/installed", { token, fallback: "获取已安装工具失败" });
  return {
    currentDeviceOnline: data?.currentDeviceOnline ?? false,
    builtin: (data?.builtin ?? []).map(normalizeInstalledTool),
    installed: (data?.installed ?? []).map(normalizeInstalledTool),
  };
}

export async function installMarketTool(
  token: string,
  payload: { categoryKey: string; marketId: string },
): Promise<InstalledTool> {
  const data = await request<InstalledToolPayload>("/api/tools/install", {
    method: "POST",
    token,
    body: payload,
    fallback: "安装工具失败",
  });
  return normalizeInstalledTool(data);
}

export interface TopupResponse {
  payUrl: string;
  tradeNo: string;
}

export type PaymentMethod = "alipay" | "wxpay";

export interface TopupOrder {
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

export interface RechargePackage {
  id: string;
  name: string;
  amountFen: number;
  points: number;
  enabled: boolean;
  sortOrder: number;
}
export interface UsageRow {
  operationId: string;
  type: string;
  model: string;
  displayName: string;
  status: string;
  reservedPoints: number;
  actualPoints: number;
  originalPoints?: number;
  vipLevelName?: string;
  vipDiscountBps?: number;
  vipSavedPoints?: number;
  vipGrowthPoints?: number;
  createdAt: string;
  settledAt: string | null;
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

export interface ModelMarketplacePrice {
  original: number;
  discounted: number;
}

export interface ModelMarketplaceImagePrice {
  originalPoints: number;
  discountedPoints: number;
  resolution: string;
}

export interface ModelMarketplaceRow {
  model: string;
  displayName: string;
  enabled: boolean;
  description: string;
  tags: string;
  category: string;
  contextLength: number;
  useCases: string;
  sortOrder: number;
  showInMarketplace: boolean;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  cacheInputPricePerMillion: number;
  cacheOutputPricePerMillion: number;
  inputPriceRmbPerMillion: number;
  outputPriceRmbPerMillion: number;
  cacheInputPriceRmbPerMillion: number;
  cacheOutputPriceRmbPerMillion: number;
  vipInputPrice: ModelMarketplacePrice;
  vipOutputPrice: ModelMarketplacePrice;
  vipCacheInputPrice: ModelMarketplacePrice;
  vipCacheOutputPrice: ModelMarketplacePrice;
  imagePrice: ModelMarketplaceImagePrice | null;
}

export interface ModelMarketplaceResponse {
  data: ModelMarketplaceRow[];
  vip: VipSummary;
}

export interface RedeemResponse {
  success: boolean;
}

export interface BalanceResponse {
  balance: number;
  videoBalance: number;
}

export interface PointsPeriod {
  granted: number;
  remaining: number;
  used: number;
  expiresAt: string;
}
export interface PointsMembership {
  cardName: string;
  cadence: string;
  expiresAt: string;
}
export interface PointsDetail {
  totalPoints: number;
  permanentPoints: number;
  membershipPoints: number;
  videoBalance: number;
  currentPeriod: PointsPeriod | null;
  membership: PointsMembership | null;
}

export async function listRechargePackages(token: string): Promise<RechargePackage[]> {
  const rows = await request<RechargePackage[]>("/api/billing/recharge-packages", {
    token,
    fallback: "获取充值套餐失败",
  });
  return rows ?? [];
}

export async function getRechargeRatio(token: string): Promise<number> {
  const data = await request<{ ratio: number }>("/api/billing/recharge-ratio", {
    token,
    fallback: "获取充值汇率失败",
  });
  return data.ratio;
}

export async function listUsage(token: string, limit = 20): Promise<UsageRow[]> {
  const rows = await request<UsageRow[]>(`/api/billing/usage?limit=${limit}`, {
    token,
    fallback: "获取消耗明细失败",
  });
  return rows ?? [];
}

export async function topup(
  token: string,
  payload: { amountFen?: number; packageId?: string; method: PaymentMethod; accountType?: "points" | "video" },
): Promise<TopupResponse> {
  return request<TopupResponse>("/api/billing/topup", {
    method: "POST",
    token,
    body: payload,
    fallback: "充值失败",
  });
}

export async function getTopupOrder(token: string, tradeNo: string): Promise<TopupOrder> {
  return request<TopupOrder>(`/api/billing/topup/${encodeURIComponent(tradeNo)}`, {
    token,
    fallback: "获取支付订单失败",
  });
}

export async function redeem(token: string, code: string): Promise<RedeemResponse> {
  return request<RedeemResponse>("/api/billing/redeem", {
    method: "POST",
    token,
    body: { code },
    fallback: "兑换失败",
  });
}

export async function getBalance(token: string): Promise<BalanceResponse> {
  return request<BalanceResponse>("/api/billing/balance", { token, fallback: "获取余额失败" });
}

export async function getPointsDetail(token: string): Promise<PointsDetail> {
  return request<PointsDetail>("/api/billing/points-detail", { token, fallback: "获取积分详情失败" });
}

export async function getVipSummary(token: string): Promise<VipSummary> {
  return request<VipSummary>("/api/vip/me", { token, fallback: "获取 VIP 信息失败" });
}

export async function listModelMarketplace(token: string): Promise<ModelMarketplaceResponse> {
  // 不走 request<T>()：这个接口的 data 旁边还挂着 vip，unwrapData 会把兄弟字段吃掉。
  const response = await requestResponse("/api/model-marketplace", { token, fallback: "获取模型广场失败" });
  const resp = (await response.json()) as ModelMarketplaceResponse;
  return { data: resp.data ?? [], vip: resp.vip };
}

export interface WorkflowImageAsset {
  id: string;
  requestId: string;
  requestIndex: number;
  prompt: string;
  model: string;
  size: string;
  originalUrl: string;
  thumbnailUrl: string;
  mime: string;
  createdAt: string;
}

export interface WorkflowImageTask {
  id: string;
  requestId: string;
  prompt: string;
  model: string;
  size: string;
  referenceAssetIds: string[];
  sourceImageAssetId: string | null;
  generationIntent: ImageGenerationIntent;
  count: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  completedCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ImageGenerationIntent = "new" | "variation" | "edit";

export interface GenerateWorkflowImagesPayload {
  requestId: string;
  model: "qwen-image-2.0-pro-2026-04-22" | "gpt-image-2" | "doubao-seedream-4-5-251128";
  prompt: string;
  size: string;
  resolution?: "1K" | "2K";
  referenceAssetIds?: string[];
  sourceImageAssetId?: string;
  generationIntent?: ImageGenerationIntent;
  count: number;
}

export interface GenerateWorkflowImagesResult {
  task: WorkflowImageTask;
  recent: WorkflowImageAsset[];
}

export interface WorkflowImageState {
  images: WorkflowImageAsset[];
  tasks: WorkflowImageTask[];
}

export async function listWorkflowImages(token: string): Promise<WorkflowImageAsset[]> {
  const rows = await request<WorkflowImageAsset[]>("/api/workflow/images", {
    token,
    fallback: "获取生图历史失败",
  });
  return rows ?? [];
}

export async function uploadWorkflowImageReference(
  token: string,
  image: { readonly b64: string; readonly mime?: string },
): Promise<WorkflowImageAsset> {
  const data = await request<{ asset: WorkflowImageAsset }>("/api/workflow/images/references", {
    method: "POST",
    token,
    body: { image },
    fallback: "上传参考图失败",
  });
  return data.asset;
}

export async function getWorkflowImageState(token: string): Promise<WorkflowImageState> {
  const data = await request<WorkflowImageState | undefined>("/api/workflow/images/state", {
    token,
    fallback: "获取生图任务失败",
  });
  return {
    images: data?.images ?? [],
    tasks: data?.tasks ?? [],
  };
}

export async function generateWorkflowImages(
  token: string,
  payload: GenerateWorkflowImagesPayload,
): Promise<GenerateWorkflowImagesResult> {
  return request<GenerateWorkflowImagesResult>("/api/workflow/images/generate", {
    method: "POST",
    token,
    body: payload,
    fallback: "生成图片失败",
  });
}

export async function cancelWorkflowImageTask(token: string, requestId: string): Promise<WorkflowImageTask> {
  const data = await request<{ task: WorkflowImageTask }>(
    `/api/workflow/images/tasks/${encodeURIComponent(requestId)}/cancel`,
    { method: "POST", token, fallback: "取消生图任务失败" },
  );
  return data.task;
}

export async function optimizeWorkflowPrompt(token: string, prompt: string): Promise<string> {
  const data = await request<{ prompt: string }>("/api/workflow/images/optimize-prompt", {
    method: "POST",
    token,
    body: { prompt },
    fallback: "优化提示词失败",
  });
  return data.prompt;
}

export type ImageResolutionKey = "1K" | "2K" | "4K";

export interface WorkflowResourcePrice {
  resourceKey: string;
  displayName: string;
  pricingType: "PER_CALL" | "PER_UNIT" | "VIDEO_IO";
  rate: number;
  perUnits: number;
  enabled: boolean;
}

export type ImageWorkflowPricing = Record<ImageResolutionKey, WorkflowResourcePrice>;

/** 带上模型查询计价，预估与实际扣费保持同一条 model 感知价格解析链路 */
export async function getImageWorkflowPricing(token: string, model?: string): Promise<ImageWorkflowPricing> {
  const path = model
    ? `/api/workflow/images/pricing?model=${encodeURIComponent(model)}`
    : "/api/workflow/images/pricing";
  return request<ImageWorkflowPricing>(path, { token, fallback: "获取生图计价失败" });
}

export interface MembershipCard {
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

export interface BuyMembershipResponse {
  payUrl: string;
  tradeNo: string;
}

export interface UserMembership {
  id: number;
  userId: string;
  cardId: number;
  status: string;
  startAt: string;
  expiresAt: string;
  createdAt: string;
}

export async function listMembershipCards(token: string): Promise<MembershipCard[]> {
  return request<MembershipCard[]>("/api/membership/cards", { token, fallback: "获取月卡列表失败" });
}

export async function buyMembership(token: string, cardId: number, method: PaymentMethod = "alipay"): Promise<BuyMembershipResponse> {
  // 这个写接口回的是裸对象（不带 `{ data }` 壳），unwrapData 会原样放行。
  return request<BuyMembershipResponse>("/api/membership/buy", {
    method: "POST",
    token,
    body: { cardId, method },
    fallback: "购买月卡失败",
  });
}

export async function myMemberships(token: string): Promise<UserMembership[]> {
  return request<UserMembership[]>("/api/membership/mine", { token, fallback: "获取我的会员失败" });
}

export interface WechatBinding {
  id: string;
  deviceId: string;
  targetType: string;
  targetId: string;
  online: boolean;
}

export async function createWechatBinding(
  token: string,
  deviceId: string,
  targetId: string,
  model?: string,
): Promise<{ id: string }> {
  return request<{ id: string }>("/api/wechat/bindings", {
    method: "POST",
    token,
    body: { deviceId, targetType: "agent", targetId, model },
    fallback: "绑定失败",
  });
}

export async function listWechatBindings(token: string): Promise<WechatBinding[]> {
  const rows = await request<WechatBinding[] | undefined>("/api/wechat/bindings", {
    token,
    fallback: "获取绑定列表失败",
  });
  return rows ?? [];
}

export async function deleteWechatBinding(token: string, id: string): Promise<void> {
  await request(`/api/wechat/bindings/${encodeURIComponent(id)}`, {
    method: "DELETE",
    token,
    fallback: "删除绑定失败",
  });
}

export async function listModels(): Promise<{ model: string; displayName: string }[]> {
  // 显式 token: null——这是公开接口，不该带上登录态；服务端报错时静默回空列表，网络异常仍旧抛出。
  const models = await request<{ model: string; displayName: string }[] | undefined>("/api/models", {
    token: null,
    fallback: "获取模型列表失败",
  }).catch((error) => {
    if (error instanceof ApiError) return [];
    throw error;
  });
  return (models ?? []).filter((m) => !m.model.toLowerCase().includes("embedding"));
}

export interface Session {
  id: string;
  title: string;
  agentId?: string | null;
  agentName?: string | null;
  agentIcon?: string | null;
  updatedAt: string;
}

export async function listSessions(token: string): Promise<Session[]> {
  const rows = await request<Session[] | undefined>("/api/sessions", { token, fallback: "获取会话列表失败" });
  return rows ?? [];
}

export interface SessionMessage {
  role: string;
  content: string;
  model?: string;
  createdAt: string;
}

export async function getSessionMessages(token: string, sessionId: string): Promise<SessionMessage[]> {
  const rows = await request<SessionMessage[] | undefined>(`/api/sessions/${sessionId}/messages`, {
    token,
    fallback: "获取会话消息失败",
  });
  return rows ?? [];
}

export async function deleteSession(token: string, sessionId: string): Promise<void> {
  await request(`/api/sessions/${sessionId}`, { method: "DELETE", token, fallback: "删除会话失败" });
}

export interface AgentOption {
  id: string;
  name: string;
  description: string;
  icon: string;
  type: "preset" | "custom";
  createdAt?: string;
  avatarSvg?: string | null;
  avatarUrl?: string | null;
}

export interface ChatAttachmentPayload {
  name: string;
  mime: string;
  sizeBytes: number;
  kind: "image" | "file";
  dataBase64: string;
}

export async function listAgents(token: string): Promise<{ presets: AgentOption[]; custom: AgentOption[] }> {
  const data = await request<{ presets: AgentOption[]; custom: AgentOption[] } | undefined>("/api/agents", {
    token,
    fallback: "获取智能体失败",
  });
  return data ?? { presets: [], custom: [] };
}

export async function generateAgent(token: string, requirement: string): Promise<AgentOption & { modelUsed: string }> {
  return request<AgentOption & { modelUsed: string }>("/api/agents/generate", {
    method: "POST",
    token,
    body: { requirement },
    fallback: "创建智能体失败",
  });
}

export async function renameAgent(token: string, id: string, name: string): Promise<void> {
  await request(`/api/agents/${id}`, { method: "PATCH", token, body: { name }, fallback: "重命名失败" });
}

export async function deleteAgent(token: string, id: string): Promise<void> {
  await request(`/api/agents/${id}`, { method: "DELETE", token, fallback: "删除失败" });
}

export async function regenerateAgentAvatar(token: string, id: string): Promise<{ avatarSvg: string | null }> {
  return request<{ avatarSvg: string | null }>(`/api/agents/${id}/avatar/regenerate`, {
    method: "POST",
    token,
    fallback: "生成头像失败",
  }).catch((error) => {
    // 限流的提示语要盖掉后端原文。
    if (error instanceof ApiError && error.status === 429) throw new Error("操作过于频繁，请稍后再试");
    throw error;
  });
}

export async function uploadAgentAvatar(token: string, id: string, file: File): Promise<{ avatarUrl: string }> {
  const form = new FormData();
  form.append("file", file);
  return request<{ avatarUrl: string }>(`/api/agents/${id}/avatar/upload`, {
    method: "POST",
    token,
    body: form,
    fallback: "上传失败",
  }).catch((error) => {
    // 限流的提示语要盖掉后端原文。
    if (error instanceof ApiError && error.status === 429) throw new Error("操作过于频繁，请稍后再试");
    throw error;
  });
}
