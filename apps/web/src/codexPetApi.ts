import { uploadWorkflowImageReference, type WorkflowImageAsset } from "./api";
import { ApiError, readErrorMessage } from "./apiError";

export const CODEX_PET_API_BASE = "/api/workflow/codex-pets";

/**
 * Keep desktop-pet model defaults independent from general chat/image
 * defaults. The selected visual model is frozen per run and routed to Pixel
 * or Bailian according to the model marketplace.
 */
export const CODEX_PET_IMAGE_MODEL = "gpt-image-2" as const;
export const CODEX_PET_IMAGE_MODELS = [
  "qwen-image-2.0-pro-2026-04-22",
  CODEX_PET_IMAGE_MODEL,
  "doubao-seedream-4-5-251128",
] as const;
export type CodexPetImageModel = typeof CODEX_PET_IMAGE_MODELS[number];
export const CODEX_PET_VISUAL_QA_MODEL = "gpt-5.6-sol" as const;
export const CODEX_PET_MODEL_CONTRACT_VERSION = "selectable-visual-v2" as const;
export const CODEX_PET_IMAGE_ACTUAL_MODELS = [
  "qwen-image-2.0-pro-2026-04-22",
  CODEX_PET_IMAGE_MODEL,
  "gpt-image-2-codex",
] as const;
export const CODEX_PET_VISUAL_QA_ACTUAL_MODELS = [CODEX_PET_VISUAL_QA_MODEL, "qwen3.6-flash"] as const;
export const CODEX_PET_VISUAL_QA_ROUTES = ["chatgpt_model_route", "bailian_model_route"] as const;

export type CodexPetStylePreset =
  | "auto"
  | "pixel"
  | "plush"
  | "clay"
  | "sticker"
  | "flat-illustration"
  | "3d-toy"
  | "painterly";

export type CodexPetProjectStatus =
  | "draft"
  | "queued"
  | "base_generating"
  | "awaiting_base_review"
  | "awaiting_direction_review"
  | "standard_generating"
  | "direction_generating"
  | "validating"
  | "repairing"
  | "packaging"
  | "archiving"
  | "ready"
  | "failed"
  | "cancelled"
  /** Internal project-only tombstone used by soft-deleted project records. */
  | "deleting";

export type CodexPetRunStatus = Exclude<CodexPetProjectStatus, "draft" | "deleting">;

export interface CodexPetPricing {
  readonly resourceKey: string;
  readonly displayName: string;
  readonly pricingType: "PER_CALL";
  readonly rate: number;
  readonly perUnits: number;
  readonly enabled: boolean;
  readonly includedBaseCandidates?: number;
  readonly includedRepairAttempts?: number;
}

export interface CodexPetProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly stylePreset: CodexPetStylePreset;
  readonly status: CodexPetProjectStatus;
  readonly latestRunId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CodexPetProject extends CodexPetProjectSummary {
  readonly prompt: string;
  readonly styleNotes: string;
  readonly referenceAssetIds: readonly string[];
  readonly referenceAssets?: readonly CodexPetReferenceAsset[];
  readonly autoContinue: boolean;
  readonly imageModel?: CodexPetImageModel;
  readonly visualQaModel?: string;
}

export interface CodexPetModelOption {
  readonly model: string;
  readonly displayName: string;
}

export interface CodexPetModelOptions {
  readonly visualModels: readonly CodexPetModelOption[];
  readonly imageModels: readonly CodexPetModelOption[];
}

export interface CodexPetReferenceAsset extends Pick<WorkflowImageAsset, "id" | "mime" | "originalUrl" | "thumbnailUrl" | "createdAt"> {
  readonly name?: string;
}

export interface CodexPetProviderUsage {
  readonly inputTokens?: number;
  readonly imageInputTokens?: number;
  readonly textInputTokens?: number;
  readonly outputTokens?: number;
  readonly imageOutputTokens?: number;
  readonly totalTokens?: number;
}

export interface CodexPetRun {
  readonly id: string;
  readonly projectId: string;
  readonly status: CodexPetRunStatus;
  readonly progressStage: string;
  readonly progressPercent: number;
  readonly progressMessage: string | null;
  readonly autoContinue: boolean;
  readonly colorKey: string | null;
  readonly billingPoints: number;
  readonly billingChargeStatus?: string;
  readonly billingChargeAttemptCount?: number;
  readonly billingChargeError?: string | null;
  readonly billingChargeNextRetryAt?: string | null;
  readonly billingChargedAt?: string | null;
  readonly billingActivatedAt?: string | null;
  readonly billingRefundedAt: string | null;
  readonly billingRefundStatus?: string;
  readonly cancelRequested: boolean;
  readonly hasSuccessfulImage: boolean;
  readonly selectedBaseArtifactId: string | null;
  readonly spritesheetArtifactId: string | null;
  readonly packageArtifactId: string | null;
  readonly previewArtifactId: string | null;
  readonly validationReport: unknown;
  readonly requestedModel: string;
  readonly imageGenerationCallCount?: number;
  readonly imageGenerationApprovalBudget?: number;
  readonly pendingImageJobKey?: string | null;
  readonly modelContractVersion: string;
  readonly visualQaModel: string;
  readonly visualQaActualModels: readonly string[];
  readonly visualQaRoutes: readonly string[];
  readonly actualModels: readonly string[];
  readonly usage: CodexPetProviderUsage | null;
  readonly knowledgeDocumentId: string | null;
  readonly lastEventSequence: number;
  readonly error: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CodexPetArtifact {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string;
  readonly jobId?: string | null;
  readonly kind: string;
  readonly name: string;
  readonly status: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly metadata: Record<string, unknown>;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  /** Short-lived authenticated/signed preview URL returned by the API. */
  readonly url?: string | null;
  readonly previewUrl?: string | null;
  readonly thumbnailUrl?: string | null;
}

export interface CodexPetJob {
  readonly id: string;
  readonly key: string;
  readonly kind: string;
  readonly status: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CodexPetEvent {
  readonly id?: string;
  readonly sequence: number;
  readonly type: string;
  readonly stage: string;
  readonly jobKey: string | null;
  readonly message: string | null;
  readonly progress: number;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface CodexPetProjectDetail {
  readonly project: CodexPetProject;
  readonly latestRun: CodexPetRun | null;
  readonly runs: readonly CodexPetRun[];
  readonly artifacts: readonly CodexPetArtifact[];
  readonly jobs: readonly CodexPetJob[];
}

export interface CodexPetCreatePayload {
  readonly name: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly stylePreset?: CodexPetStylePreset;
  readonly styleNotes?: string;
  readonly referenceAssetIds?: readonly string[];
  readonly autoContinue?: boolean;
  readonly imageModel?: CodexPetImageModel;
  readonly visualQaModel?: string;
  readonly idempotencyKey?: string;
}

export type CodexPetUpdatePayload = Omit<CodexPetCreatePayload, "idempotencyKey">;

export interface CodexPetStartResult {
  readonly project: CodexPetProject;
  readonly run: CodexPetRun;
}

export type CodexPetBaseSelection =
  | { readonly artifactId: string }
  | { readonly autoSelect: true }
  | { readonly regenerate: true };

export interface CodexPetInstallLink {
  readonly installUrl: string;
  readonly imageUrl?: string;
  readonly expiresAt?: string;
}

export interface CodexPetDownload {
  readonly blob: Blob;
  readonly filename: string;
}

type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE";

function unwrapData<T>(body: T | { readonly data: T }): T {
  return body && typeof body === "object" && "data" in body ? body.data : body as T;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

async function requestCodexPet<T>(args: {
  readonly token: string;
  readonly path: string;
  readonly method?: ApiMethod;
  readonly body?: unknown;
  readonly fallback: string;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${args.token}`,
  };
  if (args.body !== undefined) headers["content-type"] = "application/json";
  if (args.idempotencyKey) headers["idempotency-key"] = args.idempotencyKey;
  const response = await fetch(`${CODEX_PET_API_BASE}${args.path}`, {
    method: args.method ?? "GET",
    headers,
    body: args.body === undefined ? undefined : JSON.stringify(args.body),
    signal: args.signal,
  });
  if (!response.ok) throw new ApiError(await readErrorMessage(response, args.fallback), response.status);
  if (response.status === 204) return undefined as T;
  return unwrapData(await response.json() as T | { readonly data: T });
}

export async function getCodexPetPricing(token: string): Promise<CodexPetPricing> {
  const data = await requestCodexPet<CodexPetPricing | { readonly pricing: CodexPetPricing }>({
    token,
    path: "/pricing",
    fallback: "获取桌宠套餐价格失败",
  });
  return "pricing" in data ? data.pricing : data;
}

export async function getCodexPetModelOptions(token: string): Promise<CodexPetModelOptions> {
  return requestCodexPet<CodexPetModelOptions>({
    token,
    path: "/models",
    fallback: "获取桌宠模型列表失败",
  });
}

export async function listCodexPetProjects(token: string): Promise<readonly CodexPetProjectSummary[]> {
  const data = await requestCodexPet<readonly CodexPetProjectSummary[] | { readonly projects: readonly CodexPetProjectSummary[] }>({
    token,
    path: "/projects",
    fallback: "获取桌宠项目失败",
  });
  return Array.isArray(data)
    ? data as readonly CodexPetProjectSummary[]
    : (data as { readonly projects: readonly CodexPetProjectSummary[] }).projects ?? [];
}

export async function createCodexPetProject(token: string, payload: CodexPetCreatePayload): Promise<CodexPetProject> {
  const data = await requestCodexPet<CodexPetProject | { readonly project: CodexPetProject }>({
    token,
    path: "/projects",
    method: "POST",
    body: payload,
    idempotencyKey: payload.idempotencyKey,
    fallback: "创建桌宠草稿失败",
  });
  return "project" in data ? data.project : data;
}

export async function getCodexPetProject(token: string, projectId: string, signal?: AbortSignal): Promise<CodexPetProjectDetail> {
  const data = await requestCodexPet<CodexPetProjectDetail | { readonly detail: CodexPetProjectDetail }>({
    token,
    path: `/projects/${encodeURIComponent(projectId)}`,
    fallback: "获取桌宠项目详情失败",
    signal,
  });
  const detail = "detail" in data ? data.detail : data;
  return {
    project: detail.project,
    latestRun: detail.latestRun ?? null,
    runs: detail.runs ?? (detail.latestRun ? [detail.latestRun] : []),
    artifacts: detail.artifacts ?? [],
    jobs: detail.jobs ?? [],
  };
}

export async function updateCodexPetProject(
  token: string,
  projectId: string,
  payload: CodexPetUpdatePayload,
): Promise<CodexPetProject> {
  const data = await requestCodexPet<CodexPetProject | { readonly project: CodexPetProject }>({
    token,
    path: `/projects/${encodeURIComponent(projectId)}`,
    method: "PATCH",
    body: payload,
    fallback: "保存桌宠草稿失败",
  });
  return "project" in data ? data.project : data;
}

export async function deleteCodexPetProject(token: string, projectId: string): Promise<void> {
  await requestCodexPet<void>({
    token,
    path: `/projects/${encodeURIComponent(projectId)}`,
    method: "DELETE",
    fallback: "删除桌宠项目失败",
  });
}

export async function startCodexPetRun(
  token: string,
  projectId: string,
  idempotencyKey: string,
): Promise<CodexPetStartResult> {
  const data = await requestCodexPet<CodexPetStartResult | { readonly run: CodexPetRun; readonly project?: CodexPetProject }>({
    token,
    path: `/projects/${encodeURIComponent(projectId)}/start`,
    method: "POST",
    body: { idempotencyKey },
    idempotencyKey,
    fallback: "启动桌宠制作失败",
  });
  if (!("project" in data) || !data.project) {
    throw new Error("启动成功，但接口未返回项目状态");
  }
  return { project: data.project, run: data.run };
}

export async function selectCodexPetBase(
  token: string,
  projectId: string,
  runId: string,
  selection: CodexPetBaseSelection,
): Promise<CodexPetRun> {
  const data = await requestCodexPet<CodexPetRun | { readonly run: CodexPetRun }>({
    token,
    path: `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/base-selection`,
    method: "POST",
    body: selection,
    fallback: "确认主形象失败",
  });
  return "run" in data ? data.run : data;
}

export async function approveCodexPetNextImage(
  token: string,
  projectId: string,
  runId: string,
): Promise<CodexPetRun> {
  const data = await requestCodexPet<CodexPetRun | { readonly run: CodexPetRun }>({
    token,
    path: `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/approve-next-image`,
    method: "POST",
    fallback: "批准下一次真实生图失败",
  });
  return "run" in data ? data.run : data;
}

export async function cancelCodexPetRun(token: string, projectId: string, runId: string): Promise<CodexPetRun> {
  const data = await requestCodexPet<CodexPetRun | { readonly run: CodexPetRun }>({
    token,
    path: `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/cancel`,
    method: "POST",
    fallback: "取消桌宠制作失败",
  });
  return "run" in data ? data.run : data;
}

export async function listCodexPetEvents(
  token: string,
  projectId: string,
  runId: string,
  after = 0,
  signal?: AbortSignal,
): Promise<{ readonly events: readonly CodexPetEvent[]; readonly cursor: number }> {
  const data = await requestCodexPet<readonly CodexPetEvent[] | { readonly events: readonly CodexPetEvent[]; readonly cursor?: number }>({
    token,
    path: `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/events?after=${Math.max(0, after)}`,
    fallback: "获取桌宠进度事件失败",
    signal,
  });
  const isArrayResponse = Array.isArray(data);
  const envelope = isArrayResponse
    ? null
    : data as { readonly events: readonly CodexPetEvent[]; readonly cursor?: number };
  const events = isArrayResponse ? data as readonly CodexPetEvent[] : envelope?.events ?? [];
  const cursor = isArrayResponse ? (events.at(-1)?.sequence ?? after) : (envelope?.cursor ?? events.at(-1)?.sequence ?? after);
  return { events, cursor };
}

function normalizeStreamEvent(eventName: string, eventId: string, raw: unknown): CodexPetEvent | null {
  const object = asObject(raw);
  const sequence = Number(object.sequence ?? eventId);
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || eventName === "heartbeat") return null;
  const payload = asObject(object.payload ?? object.data ?? raw);
  return {
    id: typeof object.id === "string" ? object.id : eventId || undefined,
    sequence,
    type: typeof object.type === "string" ? object.type : eventName || "message",
    stage: typeof object.stage === "string" ? object.stage : "",
    jobKey: typeof object.jobKey === "string" ? object.jobKey : null,
    message: typeof object.message === "string" ? object.message : null,
    progress: Number.isFinite(Number(object.progress)) ? Number(object.progress) : 0,
    payload,
    createdAt: typeof object.createdAt === "string" ? object.createdAt : new Date().toISOString(),
  };
}

function consumeSseBlock(block: string, onEvent: (event: CodexPetEvent) => void): void {
  let eventName = "message";
  let eventId = "";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") eventName = value;
    else if (field === "id") eventId = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return;
  try {
    const normalized = normalizeStreamEvent(eventName, eventId, JSON.parse(data.join("\n")));
    if (normalized) onEvent(normalized);
  } catch {
    // Ignore malformed events. The persisted event endpoint fills any sequence gap.
  }
}

export async function streamCodexPetEvents(args: {
  readonly token: string;
  readonly projectId: string;
  readonly runId: string;
  readonly after?: number;
  readonly signal?: AbortSignal;
  readonly onEvent: (event: CodexPetEvent) => void;
}): Promise<void> {
  const after = Math.max(0, args.after ?? 0);
  const headers: Record<string, string> = {
    accept: "text/event-stream",
    authorization: `Bearer ${args.token}`,
  };
  if (after > 0) headers["last-event-id"] = String(after);
  const response = await fetch(
    `${CODEX_PET_API_BASE}/projects/${encodeURIComponent(args.projectId)}/runs/${encodeURIComponent(args.runId)}/events/stream?after=${after}`,
    { headers, signal: args.signal },
  );
  if (!response.ok) throw new ApiError(await readErrorMessage(response, "连接桌宠实时进度失败"), response.status);
  if (!response.body) throw new Error("桌宠实时进度流不可用");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Normalize after appending so a network chunk split between `\r` and
    // `\n` cannot leave an undetectable CRLF event boundary in the buffer.
    buffer = buffer.replace(/\r\n/g, "\n");
    let splitAt = buffer.indexOf("\n\n");
    while (splitAt >= 0) {
      consumeSseBlock(buffer.slice(0, splitAt), args.onEvent);
      buffer = buffer.slice(splitAt + 2);
      splitAt = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  buffer = buffer.replace(/\r\n/g, "\n");
  if (buffer.trim()) consumeSseBlock(buffer, args.onEvent);
}

function deliveryRunQuery(runId?: string): string {
  return runId ? `?runId=${encodeURIComponent(runId)}` : "";
}

export async function createCodexPetInstallLink(token: string, projectId: string, runId?: string): Promise<CodexPetInstallLink> {
  const data = await requestCodexPet<CodexPetInstallLink | { readonly url: string; readonly expiresAt?: string }>({
    token,
    path: `/projects/${encodeURIComponent(projectId)}/install-link${deliveryRunQuery(runId)}`,
    method: "POST",
    fallback: "生成 Codex 安装链接失败",
  });
  if ("installUrl" in data) return data;
  return { installUrl: data.url, expiresAt: data.expiresAt };
}

function filenameFromDisposition(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf8) {
    try { return decodeURIComponent(utf8); } catch { return utf8; }
  }
  return disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? fallback;
}

export async function downloadCodexPetPackage(token: string, projectId: string, runId?: string): Promise<CodexPetDownload> {
  const response = await fetch(`${CODEX_PET_API_BASE}/projects/${encodeURIComponent(projectId)}/download${deliveryRunQuery(runId)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new ApiError(await readErrorMessage(response, "下载桌宠兼容包失败"), response.status);
  return {
    blob: await response.blob(),
    filename: filenameFromDisposition(response.headers.get("content-disposition"), "codex-pet.zip"),
  };
}

/** Reuses the existing image-workflow upload endpoint and ownership checks. */
export async function uploadCodexPetReferenceAsset(
  token: string,
  image: { readonly b64: string; readonly mime?: string },
): Promise<CodexPetReferenceAsset> {
  return uploadWorkflowImageReference(token, image);
}
