import type { MemoryDraft, MemoryGalaxyData, MemoryNode } from "./memoryTypes";
import type { NovelRunEvent, NovelRunSnapshot } from "@ai-assistant/novel-workflow/contracts";

export async function register(username: string, password: string, channelCode: string): Promise<string> {
  const r = await fetch("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, channelCode }),
  });
  if (r.status === 409) throw new Error("用户名已被占用");
  if (!r.ok) {
    const err = (await r.json()) as { error?: string };
    throw new Error(err.error || "注册失败");
  }
  return (await r.json()).token as string;
}

function unwrapData<T>(resp: T | { data: T }): T {
  return resp && typeof resp === "object" && "data" in resp ? resp.data : (resp as T);
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({})) as { error?: string };
  return body.error || fallback;
}

export async function login(identifier: string, password: string): Promise<string> {
  const r = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  if (!r.ok) throw new Error("登录失败");
  return (await r.json()).token as string;
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
  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ message, sessionId, model, agentId, kbIds, attachAllOwn, attachments, toolIds, deviceId }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error || "发送失败");
  }
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
  const r = await fetch("/api/tool-market", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "获取工具市场失败"), r.status);
  const resp = (await r.json()) as { data: ToolMarketCategory[] };
  return resp.data ?? [];
}

export async function listToolMarketSkills(token: string, categoryKey: string): Promise<ToolMarketCategoryDetail> {
  const r = await fetch(`/api/tool-market/${encodeURIComponent(categoryKey)}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "获取工具列表失败"), r.status);
  const resp = (await r.json()) as { data: ToolMarketCategoryDetail };
  return resp.data;
}

export async function listInstalledTools(token: string): Promise<InstalledToolsResponse> {
  const r = await fetch("/api/tools/installed", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "获取已安装工具失败"), r.status);
  const resp = (await r.json()) as {
    data?: {
      currentDeviceOnline?: boolean;
      builtin?: InstalledToolPayload[];
      installed?: InstalledToolPayload[];
    };
  };
  return {
    currentDeviceOnline: resp.data?.currentDeviceOnline ?? false,
    builtin: (resp.data?.builtin ?? []).map(normalizeInstalledTool),
    installed: (resp.data?.installed ?? []).map(normalizeInstalledTool),
  };
}

export async function installMarketTool(
  token: string,
  payload: { categoryKey: string; marketId: string },
): Promise<InstalledTool> {
  const r = await fetch("/api/tools/install", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "安装工具失败"), r.status);
  const resp = (await r.json()) as { data: InstalledToolPayload };
  return normalizeInstalledTool(resp.data);
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
  const r = await fetch("/api/billing/recharge-packages", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("获取充值套餐失败");
  const resp = (await r.json()) as { data: RechargePackage[] };
  return resp.data ?? [];
}

export async function getRechargeRatio(token: string): Promise<number> {
  const r = await fetch("/api/billing/recharge-ratio", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("获取充值汇率失败");
  return ((await r.json()) as { ratio: number }).ratio;
}

export async function listUsage(token: string, limit = 20): Promise<UsageRow[]> {
  const r = await fetch(`/api/billing/usage?limit=${limit}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("获取消耗明细失败");
  const resp = (await r.json()) as { data: UsageRow[] };
  return resp.data ?? [];
}

export async function topup(
  token: string,
  payload: { amountFen?: number; packageId?: string; method: PaymentMethod; accountType?: "points" | "video" },
): Promise<TopupResponse> {
  const r = await fetch("/api/billing/topup", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error("充值失败");
  return (await r.json()) as TopupResponse;
}

export async function getTopupOrder(token: string, tradeNo: string): Promise<TopupOrder> {
  const r = await fetch(`/api/billing/topup/${encodeURIComponent(tradeNo)}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("获取支付订单失败");
  const resp = (await r.json()) as { data: TopupOrder };
  return resp.data;
}

export async function redeem(token: string, code: string): Promise<RedeemResponse> {
  const r = await fetch("/api/billing/redeem", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ code }),
  });
  if (!r.ok) throw new Error("兑换失败");
  return (await r.json()) as RedeemResponse;
}

export async function getBalance(token: string): Promise<BalanceResponse> {
  const r = await fetch("/api/billing/balance", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("获取余额失败");
  return (await r.json()) as BalanceResponse;
}

export async function getPointsDetail(token: string): Promise<PointsDetail> {
  const r = await fetch("/api/billing/points-detail", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("获取积分详情失败");
  return (await r.json()) as PointsDetail;
}

export async function getVipSummary(token: string): Promise<VipSummary> {
  const r = await fetch("/api/vip/me", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("获取 VIP 信息失败");
  const resp = (await r.json()) as { data: VipSummary };
  return resp.data;
}

export async function listModelMarketplace(token: string): Promise<ModelMarketplaceResponse> {
  const r = await fetch("/api/model-marketplace", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("获取模型广场失败");
  const resp = (await r.json()) as ModelMarketplaceResponse;
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
  model: "qwen-image-2.0-pro-2026-04-22" | "gpt-image-2";
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
  const r = await fetch("/api/workflow/images", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "获取生图历史失败"), r.status);
  const resp = (await r.json()) as { data: WorkflowImageAsset[] };
  return resp.data ?? [];
}

export async function uploadWorkflowImageReference(
  token: string,
  image: { readonly b64: string; readonly mime?: string },
): Promise<WorkflowImageAsset> {
  const r = await fetch("/api/workflow/images/references", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ image }),
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "上传参考图失败"), r.status);
  const resp = (await r.json()) as { data: { asset: WorkflowImageAsset } };
  return resp.data.asset;
}

export async function getWorkflowImageState(token: string): Promise<WorkflowImageState> {
  const r = await fetch("/api/workflow/images/state", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "获取生图任务失败"), r.status);
  const resp = (await r.json()) as { data: WorkflowImageState };
  return {
    images: resp.data?.images ?? [],
    tasks: resp.data?.tasks ?? [],
  };
}

export async function generateWorkflowImages(
  token: string,
  payload: GenerateWorkflowImagesPayload,
): Promise<GenerateWorkflowImagesResult> {
  const r = await fetch("/api/workflow/images/generate", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "生成图片失败"), r.status);
  const resp = (await r.json()) as { data: GenerateWorkflowImagesResult };
  return resp.data;
}

export async function cancelWorkflowImageTask(token: string, requestId: string): Promise<WorkflowImageTask> {
  const r = await fetch(`/api/workflow/images/tasks/${encodeURIComponent(requestId)}/cancel`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "取消生图任务失败"), r.status);
  const resp = (await r.json()) as { data: { task: WorkflowImageTask } };
  return resp.data.task;
}

export async function optimizeWorkflowPrompt(token: string, prompt: string): Promise<string> {
  const r = await fetch("/api/workflow/images/optimize-prompt", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ prompt }),
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "优化提示词失败"), r.status);
  const resp = (await r.json()) as { data: { prompt: string } };
  return resp.data.prompt;
}

export interface NovelWorkflowResourcePrice {
  resourceKey: string;
  displayName: string;
  pricingType: "PER_CALL" | "PER_UNIT";
  rate: number;
  perUnits: number;
  enabled: boolean;
}

export interface NovelWorkflowPricing {
  novelText: NovelWorkflowResourcePrice;
  cover: NovelWorkflowResourcePrice;
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

export async function getImageWorkflowPricing(token: string): Promise<ImageWorkflowPricing> {
  const r = await fetch("/api/workflow/images/pricing", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "获取生图计价失败"), r.status);
  const resp = (await r.json()) as { data: ImageWorkflowPricing };
  return resp.data;
}

export interface NovelProjectSummary {
  id: string;
  title: string;
  genre: string;
  premise: string;
  status: string;
  setupStage: number;
  setupCompleted: boolean;
  targetChapters: number;
  chapterCount: number;
  totalWords: number;
  updatedAt: string;
}

export interface NovelChapter {
  id: string;
  volumeIndex: number;
  chapterIndex: number;
  title: string;
  summary: string;
  outline?: string;
  generationHint?: string;
  content: string;
  rawContent?: string;
  openThreads?: string[];
  contextSnapshot?: unknown;
  generationMeta?: unknown;
  consistencyJson?: unknown;
  status: string;
  reviewStatus?: "pending" | "approved" | "revise";
  reviewNotes?: string;
  aiReview?: string;
  aiActionItems?: string[];
  modificationRate?: number;
  reviewedAt?: string | null;
  billableChars: number;
  tensionScore?: number;
  plotTension?: number;
  emotionalTension?: number;
  pacingTension?: number;
  qualityScore?: number;
  lastTaskId: string | null;
  updatedAt: string;
}

export interface NovelTask {
  id: string;
  projectId: string;
  targetKind: "setupBible" | "setupCharacters" | "setupLocations" | "setupPlot" | "chapter" | "chapterRewrite" | string;
  targetId: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progressPercent: number;
  progressStage: string;
  progressMessage: string | null;
  progressPreview: string;
  streamedChars: number;
  requestPayload: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
}

export interface NovelProjectDetail {
  project: {
    id: string;
    title: string;
    genre: string;
    premise: string;
    settings: Record<string, unknown>;
    generationPrefs: Record<string, unknown>;
    targetChapters: number;
    targetCharsPerChapter: number;
    setupStage: number;
    setupCompleted: boolean;
    storyPhase: string;
    autopilotStatus: string;
    currentBranch: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  };
  bible: null | {
    id: string;
    premiseLock: string;
    genreLock: string;
    worldPresetLock: string;
    version: number;
    worldDimensions: Array<Record<string, unknown>>;
    styleNotes: Array<Record<string, unknown>>;
    updatedAt: string;
  };
  chapters: NovelChapter[];
  tasks: NovelTask[];
}

export interface NovelWorkbenchStats {
  totalWords: number;
  finishedChapters: number;
  completionRate: number;
  averageWords: number;
  lastUpdate: string | null;
}

export interface NovelWorkbenchPayload {
  project: { id: string; title: string; genre: string; status: string; createdAt: string; updatedAt: string };
  stats: NovelWorkbenchStats;
  chapters: NovelChapter[];
  knowledgeFacts: Array<Record<string, unknown>>;
  foreshadowItems: Array<Record<string, unknown>>;
  workbenchHighlights: Record<string, unknown>;
}

export interface CreateNovelInitialSettings {
  channel?: string;
  coreRequirement?: string;
  platforms?: string[];
  topics?: string[];
  perspective?: string;
  styleMode?: string;
  era?: string;
  hasCheat?: boolean;
  styleTags?: string[];
  language?: string;
  chapterCount?: number;
  chapterChars?: number;
}

export interface CreateNovelProjectPayload {
  title: string;
  premise: string;
  genre: string;
  worldPreset?: string;
  storyStructure?: string;
  pacingControl?: string;
  writingStyle?: string;
  specialRequirements?: string;
  targetChapters: number;
  targetCharsPerChapter: number;
}

export async function getNovelWorkflowPricing(token: string): Promise<NovelWorkflowPricing> {
  const r = await fetch("/api/workflow/novels/pricing", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "获取小说计价失败"), r.status);
  const resp = (await r.json()) as { data: NovelWorkflowPricing };
  return resp.data;
}

export async function listNovelProjects(token: string): Promise<NovelProjectSummary[]> {
  const r = await fetch("/api/workflow/novels/projects", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "获取小说项目失败"), r.status);
  const resp = (await r.json()) as { data: NovelProjectSummary[] };
  return resp.data ?? [];
}

export async function createNovelProject(token: string, payload: CreateNovelProjectPayload): Promise<NovelProjectDetail> {
  const r = await fetch("/api/workflow/novels/projects", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "创建小说项目失败"), r.status);
  const resp = (await r.json()) as { data: NovelProjectDetail };
  return resp.data;
}

export type NovelSetupKind = "bible" | "characters" | "locations" | "plot";

export interface NovelSetupPayload {
  project: { id: string; setupStage: number; setupCompleted: boolean };
  bible: null | Record<string, unknown>;
  characters: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
  locations: Array<Record<string, unknown>>;
  storylines: Array<Record<string, unknown>>;
  structure: NovelStructureNode[];
  chapters: NovelChapter[];
  activeTask: NovelTask | null;
  latestTask: NovelTask | null;
}

export async function getNovelSetup(token: string, projectId: string): Promise<NovelSetupPayload> {
  return novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/setup`);
}

export async function generateNovelSetup(token: string, projectId: string, setupKind: NovelSetupKind, prompt = ""): Promise<NovelTask> {
  const data = await novelEngineRequest<{ task: NovelTask }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/setup/${setupKind}/generate`, { method: "POST", body: JSON.stringify({ prompt }) });
  return data.task;
}

export async function saveNovelSetup(token: string, projectId: string, setupKind: NovelSetupKind, data: unknown): Promise<void> {
  await novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/setup/${setupKind}`, { method: "PUT", body: JSON.stringify({ data }) });
}

export async function completeNovelSetup(token: string, projectId: string): Promise<{ id: string; setupStage: number; setupCompleted: boolean }> {
  const data = await novelEngineRequest<{ project: { id: string; setupStage: number; setupCompleted: boolean } }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/setup/complete`, { method: "POST" });
  return data.project;
}

export async function getNovelProject(token: string, projectId: string): Promise<NovelProjectDetail> {
  const r = await fetch(`/api/workflow/novels/projects/${encodeURIComponent(projectId)}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "获取小说项目失败"), r.status);
  const resp = (await r.json()) as { data: NovelProjectDetail };
  return resp.data;
}

export async function deleteNovelProject(token: string, projectId: string): Promise<void> {
  const response = await fetch(`/api/workflow/novels/projects/${encodeURIComponent(projectId)}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new ApiError(await readErrorMessage(response, "删除小说项目失败"), response.status);
}

export async function getNovelWorkbench(token: string, projectId: string): Promise<NovelWorkbenchPayload> {
  const r = await fetch(`/api/workflow/novels/projects/${encodeURIComponent(projectId)}/workbench`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "获取小说工作台失败"), r.status);
  const resp = (await r.json()) as { data: NovelWorkbenchPayload };
  return resp.data;
}

export async function updateNovelProject(token: string, projectId: string, payload: { title?: string; genre?: string; writingModel?: string }): Promise<NovelProjectDetail> {
  const r = await fetch(`/api/workflow/novels/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "保存小说项目失败"), r.status);
  const resp = (await r.json()) as { data: NovelProjectDetail };
  return resp.data;
}

export async function generateNovelChapter(
  token: string,
  projectId: string,
  payload: { chapterIndex?: number; title: string; summary: string; targetChars: number },
): Promise<NovelTask> {
  const r = await fetch(`/api/workflow/novels/projects/${encodeURIComponent(projectId)}/chapters/generate`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "创建章节任务失败"), r.status);
  const resp = (await r.json()) as { data: { task: NovelTask } };
  return resp.data.task;
}

export async function saveNovelChapter(
  token: string,
  projectId: string,
  chapterIndex: number,
  payload: { title: string; summary: string; content: string; outline?: string; generationHint?: string },
): Promise<NovelChapter> {
  const r = await fetch(`/api/workflow/novels/projects/${encodeURIComponent(projectId)}/chapters/${chapterIndex}`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "保存章节失败"), r.status);
  const resp = (await r.json()) as { data: { chapter: NovelChapter } };
  return resp.data.chapter;
}

export async function rewriteNovelChapterSelection(
  token: string,
  projectId: string,
  chapterIndex: number,
  payload: { selectedText: string; selectionStart: number; selectionEnd: number; instruction: string },
): Promise<NovelTask> {
  const r = await fetch(`/api/workflow/novels/projects/${encodeURIComponent(projectId)}/chapters/${chapterIndex}/rewrite`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "创建局部改写任务失败"), r.status);
  const resp = (await r.json()) as { data: { task: NovelTask } };
  return resp.data.task;
}

export async function saveNovelChapterReview(
  token: string,
  projectId: string,
  chapterIndex: number,
  payload: { status?: "pending" | "approved" | "revise"; reviewNotes?: string; regenerateAi?: boolean },
): Promise<NovelChapter> {
  const r = await fetch(`/api/workflow/novels/projects/${encodeURIComponent(projectId)}/chapters/${chapterIndex}/review`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "保存章节审阅失败"), r.status);
  const resp = (await r.json()) as { data: { chapter: NovelChapter } };
  return resp.data.chapter;
}

export async function analyzeNovelChapter(token: string, projectId: string, chapterIndex: number): Promise<NovelChapter> {
  const r = await fetch(`/api/workflow/novels/projects/${encodeURIComponent(projectId)}/chapters/${chapterIndex}/analyze`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "分析章节失败"), r.status);
  const resp = (await r.json()) as { data: { chapter: NovelChapter } };
  return resp.data.chapter;
}

export async function cancelNovelTask(token: string, taskId: string): Promise<NovelTask> {
  const r = await fetch(`/api/workflow/novels/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "取消小说任务失败"), r.status);
  const resp = (await r.json()) as { data: { task: NovelTask } };
  return resp.data.task;
}

export type NovelEngineRun = NovelRunSnapshot;
export type NovelEngineEvent = NovelRunEvent;

export interface NovelEngineStep {
  id: string;
  runId: string;
  sequence: number;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  chapterNumber: number | null;
  attempt: number;
  progress: number;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  taskProgress: {
    status: string;
    percent: number;
    stage: string;
    message: string | null;
    streamedChars: number;
    updatedAt: string;
  } | null;
}

async function novelEngineRequest<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) throw new ApiError(await readErrorMessage(response, "小说引擎请求失败"), response.status);
  const body = await response.json() as { data: T };
  return body.data;
}

export async function startNovelAssistedRun(token: string, projectId: string, payload: {
  chapterIndex: number;
  title?: string;
  summary?: string;
  targetChars: number;
}): Promise<NovelEngineRun> {
  const data = await novelEngineRequest<{ run: NovelEngineRun }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/runs/assisted`, { method: "POST", body: JSON.stringify(payload) });
  return data.run;
}

export async function startNovelAutopilotRun(token: string, projectId: string, payload: {
  targetChapters: number;
  targetCharsPerChapter: number;
  startChapter?: number;
  autoReview?: boolean;
}): Promise<NovelEngineRun> {
  const data = await novelEngineRequest<{ run: NovelEngineRun }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/runs/autopilot`, { method: "POST", body: JSON.stringify(payload) });
  return data.run;
}

export async function listNovelEngineRuns(token: string, projectId: string): Promise<NovelEngineRun[]> {
  const data = await novelEngineRequest<{ runs: NovelEngineRun[] }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/runs`);
  return data.runs;
}

export async function getNovelEngineRun(token: string, projectId: string, runId: string): Promise<{ run: NovelEngineRun; steps: NovelEngineStep[] }> {
  return novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`);
}

export async function controlNovelEngineRun(token: string, projectId: string, runId: string, action: "pause" | "resume" | "cancel" | "revise"): Promise<NovelEngineRun> {
  const data = await novelEngineRequest<{ run: NovelEngineRun }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/${action}`, { method: "POST" });
  return data.run;
}

export async function listNovelEngineEvents(token: string, projectId: string, runId: string, after = 0): Promise<{ events: NovelEngineEvent[]; cursor: number }> {
  return novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/events?after=${after}`);
}

export async function streamNovelEngineEvents(args: {
  token: string;
  projectId: string;
  runId: string;
  after?: number;
  signal?: AbortSignal;
  onEvent: (event: NovelEngineEvent) => void;
}): Promise<void> {
  const response = await fetch(`/api/workflow/novels/projects/${encodeURIComponent(args.projectId)}/runs/${encodeURIComponent(args.runId)}/events/stream?after=${args.after ?? 0}`, {
    headers: { authorization: `Bearer ${args.token}` },
    signal: args.signal,
  });
  if (!response.ok) throw new ApiError(await readErrorMessage(response, "连接小说运行流失败"), response.status);
  if (!response.body) throw new Error("小说运行流不可用");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let split = buffer.indexOf("\n\n");
    while (split >= 0) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const data = block.split("\n").filter((line) => line.startsWith("data:"));
      if (data.length) {
        try {
          args.onEvent(JSON.parse(data.map((line) => line.slice(5).trimStart()).join("\n")) as NovelEngineEvent);
        } catch {
          // Ignore malformed or partial server events and continue the stream.
        }
      }
      split = buffer.indexOf("\n\n");
    }
  }
}

export interface NovelNarrativeDashboard {
  project: { storyPhase: string; autopilotStatus: string; currentBranch: string };
  stats: { chapters: number; totalChars: number; openForeshadows: number; storylines: number; debts: number; facts: number; characters: number };
  tensionCurve: Array<{ chapterIndex: number; title: string; tensionScore: number; plotTension: number; emotionalTension: number; pacingTension: number; qualityScore: number; billableChars: number }>;
}

export async function getNovelNarrativeDashboard(token: string, projectId: string): Promise<NovelNarrativeDashboard> {
  return novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/narrative-dashboard`);
}

export interface NovelStructureNode {
  id: string;
  projectId: string;
  parentId: string | null;
  nodeType: "book" | "volume" | "act" | "chapter";
  title: string;
  description: string;
  number: number;
  startChapter: number | null;
  endChapter: number | null;
  outline: string;
  metadata: Record<string, unknown>;
}

export async function getNovelStructure(token: string, projectId: string): Promise<NovelStructureNode[]> {
  const data = await novelEngineRequest<{ nodes: NovelStructureNode[] }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/structure`);
  return data.nodes;
}

export type NovelEditableResource = "structure" | "characters" | "locations" | "storylines" | "storyline-milestones" | "props" | "timeline" | "foreshadows" | "narrative-debts";

export async function createNovelResource<T extends Record<string, unknown>>(token: string, projectId: string, resource: NovelEditableResource, payload: Record<string, unknown>): Promise<T> {
  const data = await novelEngineRequest<Record<string, T>>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/${resource}`, { method: "POST", body: JSON.stringify(payload) });
  return Object.values(data)[0]!;
}

export async function updateNovelResource<T extends Record<string, unknown>>(token: string, projectId: string, resource: NovelEditableResource, entityId: string, payload: Record<string, unknown>): Promise<T> {
  const data = await novelEngineRequest<Record<string, T>>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/${resource}/${encodeURIComponent(entityId)}`, { method: "PATCH", body: JSON.stringify(payload) });
  return Object.values(data)[0]!;
}

export async function deleteNovelResource(token: string, projectId: string, resource: NovelEditableResource | "character-relations", entityId: string): Promise<void> {
  await novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/${resource}/${encodeURIComponent(entityId)}`, { method: "DELETE" });
}

export async function createNovelStorylineMilestone(token: string, projectId: string, storylineId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const data = await novelEngineRequest<{ milestone: Record<string, unknown> }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/storylines/${encodeURIComponent(storylineId)}/milestones`, { method: "POST", body: JSON.stringify(payload) });
  return data.milestone;
}

export async function createNovelCharacterRelation(token: string, projectId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const data = await novelEngineRequest<{ relation: Record<string, unknown> }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/character-relations`, { method: "POST", body: JSON.stringify(payload) });
  return data.relation;
}

export interface NovelNarrativeAssets {
  timeline: Array<Record<string, unknown>>;
  foreshadows: Array<Record<string, unknown>>;
  debts: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  causalEdges: Array<Record<string, unknown>>;
  facts: Array<Record<string, unknown>>;
  foreshadowEvents: Array<Record<string, unknown>>;
}

export async function getNovelNarrativeAssets(token: string, projectId: string): Promise<NovelNarrativeAssets> {
  return novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/narrative-assets`);
}

export interface NovelContinuityBackfillResult {
  chapters: number;
  timelineEvents: number;
  props: number;
  propEvents: number;
  foreshadows: number;
  foreshadowEvents: number;
  debts: number;
  reinforced: number;
  resolved: number;
  rescoredChapters: number;
}

export async function backfillNovelNarrativeAssets(token: string, projectId: string): Promise<NovelContinuityBackfillResult> {
  return novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/narrative-assets/backfill`, { method: "POST" });
}

export interface NovelChapterVersion {
  id: string;
  chapterId: string;
  title: string;
  content: string;
  billableChars: number;
  operationId: string | null;
  createdAt: string;
}

export interface NovelGenerationRequest {
  id: string;
  projectId: string;
  chapterId: string | null;
  chapterIndex: number | null;
  taskId: string;
  runId: string | null;
  stepId: string | null;
  targetKind: string;
  attempt: number;
  systemPrompt: string;
  userPrompt: string;
  model: string;
  temperature: number | null;
  maxTokens: number;
  templateId: string | null;
  templateVersion: number | null;
  requestHash: string;
  status: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listNovelGenerationRequests(token: string, projectId: string, chapterIndex: number): Promise<NovelGenerationRequest[]> {
  const data = await novelEngineRequest<{ requests: NovelGenerationRequest[] }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/chapters/${chapterIndex}/generation-requests`);
  return data.requests;
}

export async function listNovelChapterVersions(token: string, projectId: string, chapterIndex: number): Promise<NovelChapterVersion[]> {
  const data = await novelEngineRequest<{ versions: NovelChapterVersion[] }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/chapters/${chapterIndex}/versions`);
  return data.versions;
}

export async function restoreNovelChapterVersion(token: string, projectId: string, chapterIndex: number, versionId: string): Promise<NovelChapter> {
  const data = await novelEngineRequest<{ chapter: NovelChapter }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/chapters/${chapterIndex}/versions/${encodeURIComponent(versionId)}/restore`, { method: "POST" });
  return data.chapter;
}

export async function listNovelCharacters(token: string, projectId: string): Promise<{ characters: Array<Record<string, unknown>>; relations: Array<Record<string, unknown>> }> {
  return novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/characters`);
}

export async function listNovelStorylines(token: string, projectId: string): Promise<Array<Record<string, unknown>>> {
  const data = await novelEngineRequest<{ storylines: Array<Record<string, unknown>> }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/storylines`);
  return data.storylines;
}

export async function listNovelProps(token: string, projectId: string): Promise<Array<Record<string, unknown>>> {
  const data = await novelEngineRequest<{ props: Array<Record<string, unknown>> }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/props`);
  return data.props;
}

export async function listNovelCheckpoints(token: string, projectId: string): Promise<Array<Record<string, unknown>>> {
  const data = await novelEngineRequest<{ checkpoints: Array<Record<string, unknown>> }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/checkpoints`);
  return data.checkpoints;
}

export async function createNovelCheckpoint(token: string, projectId: string, label: string): Promise<Record<string, unknown>> {
  const data = await novelEngineRequest<{ checkpoint: Record<string, unknown> }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/checkpoints`, { method: "POST", body: JSON.stringify({ label, branchName: "main" }) });
  return data.checkpoint;
}

export async function rollbackNovelCheckpoint(token: string, projectId: string, checkpointId: string): Promise<void> {
  await novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/checkpoints/${encodeURIComponent(checkpointId)}/rollback`, { method: "POST" });
}

export async function createNovelBranch(token: string, projectId: string, checkpointId: string, branchName: string): Promise<Record<string, unknown>> {
  const data = await novelEngineRequest<{ checkpoint: Record<string, unknown> }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/checkpoints/${encodeURIComponent(checkpointId)}/branch`, { method: "POST", body: JSON.stringify({ branchName }) });
  return data.checkpoint;
}

export interface NovelPromptTemplate {
  id: string;
  nodeKey: string;
  name: string;
  category: string;
  content: string;
  variables: string[];
  model: string;
  temperature: number;
  activeVersion: number;
  versions: Array<{ id: string; version: number; content: string; changeNote: string; createdAt: string }>;
}

export async function listNovelPrompts(token: string, projectId: string): Promise<NovelPromptTemplate[]> {
  const data = await novelEngineRequest<{ templates: NovelPromptTemplate[] }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/prompts`);
  return data.templates;
}

export async function saveNovelPrompt(token: string, projectId: string, payload: {
  nodeKey: string;
  name: string;
  category: string;
  content: string;
  variables?: string[];
  model?: string;
  temperature?: number;
  changeNote?: string;
}): Promise<NovelPromptTemplate> {
  const data = await novelEngineRequest<{ template: NovelPromptTemplate }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/prompts`, { method: "POST", body: JSON.stringify(payload) });
  return data.template;
}

export async function rollbackNovelPrompt(token: string, projectId: string, templateId: string, version: number): Promise<NovelPromptTemplate> {
  const data = await novelEngineRequest<{ template: NovelPromptTemplate }>(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/prompts/${encodeURIComponent(templateId)}/rollback`, { method: "POST", body: JSON.stringify({ version }) });
  return data.template;
}

export async function exportNovelProject(token: string, projectId: string, format: "markdown" | "docx" | "epub" | "pdf"): Promise<Blob> {
  const response = await fetch(`/api/workflow/novels/projects/${encodeURIComponent(projectId)}/export?format=${format}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new ApiError(await readErrorMessage(response, "导出小说失败"), response.status);
  return response.blob();
}

export async function importNovelProject(token: string, projectId: string, payload: { format: "markdown" | "text"; content: string; mode: "replace" | "append"; filename?: string }): Promise<{ importedChapters: number; mode: string; title: string }> {
  return novelEngineRequest(token, `/api/workflow/novels/projects/${encodeURIComponent(projectId)}/import`, { method: "POST", body: JSON.stringify(payload) });
}

export type Memory = MemoryNode;

export type MemorySearchHit = MemoryNode & {
  readonly score: number;
};

export interface MemorySearchResponse {
  success: boolean;
  data: {
    hits: MemorySearchHit[];
  };
}

export interface MemoriesListResponse {
  success: boolean;
  data: MemoryNode[];
}

export interface MemoryGalaxyResponse {
  success: boolean;
  data: MemoryGalaxyData;
}

export interface UpdateMemoryResponse {
  success: boolean;
  data: MemoryNode;
}

export interface MemoryToggleResponse {
  success: boolean;
  data: { memoryEnabled?: boolean; enabled?: boolean };
}

export async function getMemorySettings(token: string): Promise<{ memoryEnabled: boolean }> {
  const r = await fetch("/api/memory/settings", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("获取记忆设置失败");
  const resp = (await r.json()) as MemoryToggleResponse;
  return { memoryEnabled: resp.data.memoryEnabled ?? resp.data.enabled ?? true };
}

export async function listMemory(token: string): Promise<MemoryNode[]> {
  const r = await fetch("/api/memory", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("获取记忆列表失败");
  const resp = (await r.json()) as MemoriesListResponse;
  return resp.data;
}

export async function getMemoryGalaxy(token: string): Promise<MemoryGalaxyData> {
  const r = await fetch("/api/memory/galaxy", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("获取记忆星河失败");
  const resp = (await r.json()) as MemoryGalaxyResponse;
  return resp.data;
}

export async function searchMemory(token: string, q: string): Promise<MemorySearchHit[]> {
  const r = await fetch(`/api/memory/search?q=${encodeURIComponent(q)}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("搜索记忆失败");
  const resp = (await r.json()) as MemorySearchResponse;
  return resp.data.hits;
}

export async function updateMemory(token: string, id: string, payload: MemoryDraft): Promise<MemoryNode> {
  const r = await fetch(`/api/memory/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error("保存记忆失败");
  const resp = (await r.json()) as UpdateMemoryResponse;
  return resp.data;
}

export async function deleteMemory(token: string, id: string): Promise<void> {
  const r = await fetch(`/api/memory/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("删除记忆失败");
}

export async function toggleMemory(token: string, enabled: boolean): Promise<void> {
  const r = await fetch("/api/memory/toggle", {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error("更新记忆设置失败");
}

export interface MembershipCardResponse {
  data: Array<{
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
  }>;
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

export interface MyMembershipsResponse {
  data: UserMembership[];
}

export async function listMembershipCards(token: string): Promise<Array<{
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
}>> {
  const r = await fetch("/api/membership/cards", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("获取月卡列表失败");
  const resp = (await r.json()) as MembershipCardResponse;
  return resp.data;
}

export async function buyMembership(token: string, cardId: number, method: PaymentMethod = "alipay"): Promise<BuyMembershipResponse> {
  const r = await fetch("/api/membership/buy", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ cardId, method }),
  });
  if (!r.ok) throw new Error("购买月卡失败");
  return (await r.json()) as BuyMembershipResponse;
}

export async function myMemberships(token: string): Promise<UserMembership[]> {
  const r = await fetch("/api/membership/mine", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("获取我的会员失败");
  const resp = (await r.json()) as MyMembershipsResponse;
  return resp.data;
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
  const r = await fetch("/api/wechat/bindings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ deviceId, targetType: "agent", targetId, model }),
  });
  if (!r.ok) throw new Error("绑定失败");
  const resp = (await r.json()) as { data: { id: string } };
  return resp.data;
}

export async function listWechatBindings(token: string): Promise<WechatBinding[]> {
  const r = await fetch("/api/wechat/bindings", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("获取绑定列表失败");
  const resp = (await r.json()) as { data: WechatBinding[] };
  return resp.data ?? [];
}

export async function deleteWechatBinding(token: string, id: string): Promise<void> {
  const r = await fetch(`/api/wechat/bindings/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("删除绑定失败");
}

export async function listModels(): Promise<{ model: string; displayName: string }[]> {
  const r = await fetch("/api/models");
  if (!r.ok) return [];
  const models = ((await r.json()).data ?? []) as { model: string; displayName: string }[];
  return models.filter((m) => !m.model.toLowerCase().includes("embedding"));
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
  const r = await fetch("/api/sessions", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("获取会话列表失败");
  const resp = await r.json();
  return Array.isArray(resp) ? resp : (resp?.data ?? []);
}

export interface SessionMessage {
  role: string;
  content: string;
  model?: string;
  createdAt: string;
}

export async function getSessionMessages(token: string, sessionId: string): Promise<SessionMessage[]> {
  const r = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("获取会话消息失败");
  const resp = await r.json();
  return Array.isArray(resp) ? resp : (resp?.data ?? []);
}

export async function deleteSession(token: string, sessionId: string): Promise<void> {
  const r = await fetch(`/api/sessions/${sessionId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("删除会话失败");
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
  const r = await fetch("/api/agents", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("获取智能体失败");
  const resp = await r.json();
  return resp.data ?? { presets: [], custom: [] };
}

export async function generateAgent(token: string, requirement: string): Promise<AgentOption & { modelUsed: string }> {
  const r = await fetch("/api/agents/generate", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ requirement }),
  });
  if (!r.ok) throw new Error("创建智能体失败");
  const resp = await r.json();
  return resp.data;
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;
  ownerType: string;
  systemKey?: string;
  latticeCount?: number;
}

export interface KnowledgeBasesResponse {
  success: boolean;
  data: KnowledgeBase[];
}

export async function listKb(token: string): Promise<KnowledgeBase[]> {
  const r = await fetch("/api/kb", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("获取知识库列表失败");
  const resp = await r.json();
  return Array.isArray(resp) ? resp : (resp?.data ?? []);
}

export async function createKb(token: string, name: string, description?: string): Promise<KnowledgeBase> {
  const r = await fetch("/api/kb", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, description }),
  });
  if (!r.ok) throw new Error("创建知识库失败");
  const resp = (await r.json()) as KnowledgeBase | { data: KnowledgeBase };
  return unwrapData(resp);
}

export async function renameKb(token: string, id: string, name?: string, description?: string): Promise<void> {
  const r = await fetch(`/api/kb/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, description }),
  });
  if (!r.ok) throw new Error("更新知识库失败");
}

export async function deleteKb(token: string, id: string): Promise<void> {
  const r = await fetch(`/api/kb/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("删除知识库失败");
}

export interface KbDocument {
  id: string;
  name: string;
  status: "pending" | "indexing" | "indexed" | "failed";
  sizeBytes: number;
  chunkCount: number;
  error?: string;
  sourceType?: string;
  sourceUri?: string;
  mime?: string;
  sourceModule?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface KbDocumentsResponse {
  success: boolean;
  data: KbDocument[];
}

export interface KbDocumentResponse {
  success: boolean;
  data: KbDocument;
}

export async function listKbDocuments(token: string, kbId: string): Promise<KbDocument[]> {
  const r = await fetch(`/api/kb/${kbId}/documents`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("获取文档列表失败");
  const resp = (await r.json()) as KbDocument[] | KbDocumentsResponse;
  return unwrapData(resp);
}

export async function getKbDocument(token: string, kbId: string, docId: string): Promise<KbDocument> {
  const r = await fetch(`/api/kb/${kbId}/documents/${docId}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("获取文档信息失败");
  const resp = (await r.json()) as KbDocument | KbDocumentResponse;
  return unwrapData(resp);
}

export async function addKbText(token: string, kbId: string, text: string, name?: string): Promise<KbDocument> {
  const r = await fetch(`/api/kb/${kbId}/documents`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ text, name }),
  });
  if (!r.ok) throw new Error("添加文本失败");
  const resp = (await r.json()) as KbDocument | { data: KbDocument };
  return unwrapData(resp);
}

export async function addKbUrl(token: string, kbId: string, url: string): Promise<KbDocument> {
  const r = await fetch(`/api/kb/${kbId}/documents`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ url }),
  });
  if (!r.ok) throw new Error("添加URL失败");
  const resp = (await r.json()) as KbDocument | { data: KbDocument };
  return unwrapData(resp);
}

export async function addKbFile(token: string, kbId: string, file: File): Promise<KbDocument> {
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch(`/api/kb/${kbId}/documents`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!r.ok) throw new Error("上传文件失败");
  const resp = (await r.json()) as KbDocument | { data: KbDocument };
  return unwrapData(resp);
}

export async function deleteKbDocument(token: string, kbId: string, docId: string): Promise<void> {
  const r = await fetch(`/api/kb/${kbId}/documents/${docId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("删除文档失败");
}

export interface KbQuotaData {
  effective: number;
  used: number;
  breakdown: {
    defaultBytes: number;
    membershipBytes: number;
    grantBytes: number;
  };
}

export interface KbQuotaResponse {
  success: boolean;
  data: KbQuotaData;
}

export async function getKbQuota(token: string): Promise<KbQuotaData> {
  const r = await fetch("/api/kb/quota", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("获取配额失败");
  const resp = (await r.json()) as KbQuotaResponse;
  return resp.data;
}

export async function renameAgent(token: string, id: string, name: string): Promise<void> {
  const r = await fetch(`/api/agents/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error("重命名失败");
}

export async function deleteAgent(token: string, id: string): Promise<void> {
  const r = await fetch(`/api/agents/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("删除失败");
}

export async function regenerateAgentAvatar(token: string, id: string): Promise<{ avatarSvg: string | null }> {
  const r = await fetch(`/api/agents/${id}/avatar/regenerate`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (r.status === 429) throw new Error("操作过于频繁，请稍后再试");
  if (!r.ok) throw new Error("生成头像失败");
  return (await r.json()).data;
}

export async function uploadAgentAvatar(token: string, id: string, file: File): Promise<{ avatarUrl: string }> {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch(`/api/agents/${id}/avatar/upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  if (r.status === 429) throw new Error("操作过于频繁，请稍后再试");
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || "上传失败");
  return (await r.json()).data;
}
