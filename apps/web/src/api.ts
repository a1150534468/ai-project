/**
 * 前端 API 客户端的门面 + 尚未分域的接口。P2.4 批次二 Step 2 把三个最大的域整块搬走了：
 * 小说 → `novelApi.ts`（68 个导出）、知识库 → `kbApi.ts`（12 个）、记忆 → `memoryApi.ts`（9 个）。
 * 这里用 `export *` 原样转发，纯粹是为了让 68 个调用方和全部测试文件一行都不用改；
 * **新代码请直接从域文件 import**，也不要再往本文件加小说 / 知识库 / 记忆的接口。
 *
 * 留在这里的是还没独立成域的几块：auth、`streamChat`、生图工作流、微信绑定、模型列表、
 * 会话、智能体。`streamChat` 刻意不搬 —— 它是聊天页唯一的流式入口，拆出去会把 auth 的
 * token 语义和会话状态切成两个文件读。
 */
import { ApiError } from "./apiError";
import { request, requestResponse } from "./http";

export * from "./novelApi";
export * from "./kbApi";
export * from "./memoryApi";

// ── 四个反复出现的形状收在这里，下面的接口就只剩「路径 + 文案」 ────────────────

/** 列表接口：后端偶尔把空列表写成 null，一律当空数组，免得每个调用方各写一遍 `?? []`。 */
async function getList<T>(path: string, token: string, fallback: string): Promise<T[]> {
  return (await request<T[] | undefined>(path, { token, fallback })) ?? [];
}

/** DELETE 一律不看响应体，成功与否已经由状态码说完了。 */
async function remove(path: string, token: string, fallback: string): Promise<void> {
  await request(path, { method: "DELETE", token, fallback });
}

/**
 * 有些状态码的后端原文不能直接摆到界面上：登录失败的原文会泄露账号存不存在，限流的
 * 原文全是内部术语。命中就换成自己的一句话；`status` 省略表示只要是 ApiError 就换。
 * 非 ApiError（断网、CORS）原样抛出去 —— 那是另一类问题，不该被这层话术盖掉。
 */
async function rephrase<T>(pending: Promise<T>, message: string, status?: number): Promise<T> {
  try {
    return await pending;
  } catch (failure) {
    if (failure instanceof ApiError && (status === undefined || failure.status === status)) {
      throw new Error(message);
    }
    throw failure;
  }
}

// ── auth ─────────────────────────────────────────────────────────────────────

/**
 * 注册与登录显式传 `token: null`：这两个页面不该把 localStorage 里可能残留的旧 token
 * 带上（后端会按那个旧身份处理请求）。
 */
export async function register(username: string, password: string): Promise<string> {
  const pending = request<{ token: string }>("/api/auth/register", {
    method: "POST",
    token: null,
    body: { username, password },
    fallback: "注册失败",
  });
  return (await rephrase(pending, "用户名已被占用", 409)).token;
}

export async function login(identifier: string, password: string): Promise<string> {
  const pending = request<{ token: string }>("/api/auth/login", {
    method: "POST",
    token: null,
    body: { identifier, password },
  });
  // 凭据错误统一提示，不把后端原文回显到登录界面
  return (await rephrase(pending, "登录失败")).token;
}

export interface MeResponse {
  userId: string;
  uid: string;
  username: string;
}

export function getMe(token: string): Promise<MeResponse> {
  return request<MeResponse>("/api/auth/me", { token, fallback: "获取账号信息失败" });
}

// ── 聊天流 ───────────────────────────────────────────────────────────────────

/**
 * 把字节流切成一段段 SSE 事件文本（空行分隔）。最后那段可能只到一半，留在缓冲里
 * 等下一片字节 —— 一个事件被 TCP 切成两片是常态，不等就会漏。
 */
async function* sseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    yield* parts;
  }
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
): Promise<void> {
  // 不走 request<T>()：那个读完整个 body 再 JSON.parse，流式接口要的正是边收边读
  const response = await requestResponse("/api/chat", {
    method: "POST",
    token,
    body: { message, sessionId, model, agentId, kbIds, attachAllOwn, attachments },
    fallback: "发送失败",
  });
  if (!response.body) throw new Error("连接失败");

  for await (const chunk of sseChunks(response.body)) {
    const event = chunk.match(/^event: (.+)$/m)?.[1];
    const payload = chunk.match(/^data: (.+)$/m)?.[1];
    if (event === undefined || payload === undefined) continue;
    try {
      onEvent(event, JSON.parse(payload));
    } catch {
      // 畸形数据与事件处理里抛出的错都咽掉：一个坏事件不该把整条流带停
    }
  }
}

// ── 生图工作流 ───────────────────────────────────────────────────────────────

export type ImageGenerationIntent = "new" | "variation" | "edit";

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

/** 生图页一次要两样东西：出过的图和还在跑的任务。 */
export interface WorkflowImageState {
  images: WorkflowImageAsset[];
  tasks: WorkflowImageTask[];
}

export function listWorkflowImages(token: string): Promise<WorkflowImageAsset[]> {
  return getList<WorkflowImageAsset>("/api/workflow/images", token, "获取生图历史失败");
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

/** 整份状态可能连壳都没有（刚注册的账号），两个列表各自兜底成空。 */
export async function getWorkflowImageState(token: string): Promise<WorkflowImageState> {
  const state = await request<WorkflowImageState | undefined>("/api/workflow/images/state", {
    token,
    fallback: "获取生图任务失败",
  });
  return { images: state?.images ?? [], tasks: state?.tasks ?? [] };
}

export function generateWorkflowImages(
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
  const path = `/api/workflow/images/tasks/${encodeURIComponent(requestId)}/cancel`;
  const data = await request<{ task: WorkflowImageTask }>(path, { method: "POST", token, fallback: "取消生图任务失败" });
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

// ── 微信绑定 ─────────────────────────────────────────────────────────────────

export interface WechatBinding {
  id: string;
  deviceId: string;
  targetType: string;
  targetId: string;
  online: boolean;
}

/** 目前只能把设备绑到智能体上，`targetType` 因此写死。 */
export function createWechatBinding(
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

export function listWechatBindings(token: string): Promise<WechatBinding[]> {
  return getList<WechatBinding>("/api/wechat/bindings", token, "获取绑定列表失败");
}

export function deleteWechatBinding(token: string, id: string): Promise<void> {
  return remove(`/api/wechat/bindings/${encodeURIComponent(id)}`, token, "删除绑定失败");
}

// ── 模型列表 ─────────────────────────────────────────────────────────────────

export interface ModelOption {
  model: string;
  displayName: string;
}

/**
 * 公开接口，显式 `token: null` 不带登录态。
 * 服务端报错时静默回空列表 —— 模型下拉空着还能用默认模型发消息，整页崩掉就没得救了；
 * 断网这类非 ApiError 仍旧抛出去。
 */
export async function listModels(): Promise<ModelOption[]> {
  const models = await request<ModelOption[] | undefined>("/api/models", {
    token: null,
    fallback: "获取模型列表失败",
  }).catch((failure: unknown) => {
    if (failure instanceof ApiError) return [];
    throw failure;
  });
  // embedding 模型不是拿来聊天的，别出现在下拉里
  return (models ?? []).filter((option) => !option.model.toLowerCase().includes("embedding"));
}

// ── 会话 ─────────────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  title: string;
  agentId?: string | null;
  agentName?: string | null;
  agentIcon?: string | null;
  updatedAt: string;
}

export interface SessionMessage {
  role: string;
  content: string;
  model?: string;
  createdAt: string;
}

export function listSessions(token: string): Promise<Session[]> {
  return getList<Session>("/api/sessions", token, "获取会话列表失败");
}

export function getSessionMessages(token: string, sessionId: string): Promise<SessionMessage[]> {
  return getList<SessionMessage>(`/api/sessions/${sessionId}/messages`, token, "获取会话消息失败");
}

export function deleteSession(token: string, sessionId: string): Promise<void> {
  return remove(`/api/sessions/${sessionId}`, token, "删除会话失败");
}

// ── 智能体 ───────────────────────────────────────────────────────────────────

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

/** 预设是所有人共享的，custom 是本账号自建的。 */
export interface AgentCatalog {
  presets: AgentOption[];
  custom: AgentOption[];
}

export interface ChatAttachmentPayload {
  name: string;
  mime: string;
  sizeBytes: number;
  kind: "image" | "file";
  dataBase64: string;
}

const NO_AGENTS: AgentCatalog = { presets: [], custom: [] };

/** 限流的提示语要盖掉后端原文，两个头像接口共用一句。 */
const TOO_OFTEN = "操作过于频繁，请稍后再试";

export async function listAgents(token: string): Promise<AgentCatalog> {
  const catalog = await request<AgentCatalog | undefined>("/api/agents", { token, fallback: "获取智能体失败" });
  return catalog ?? NO_AGENTS;
}

export function generateAgent(token: string, requirement: string): Promise<AgentOption & { modelUsed: string }> {
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

export function deleteAgent(token: string, id: string): Promise<void> {
  return remove(`/api/agents/${id}`, token, "删除失败");
}

export function regenerateAgentAvatar(token: string, id: string): Promise<{ avatarSvg: string | null }> {
  const pending = request<{ avatarSvg: string | null }>(`/api/agents/${id}/avatar/regenerate`, {
    method: "POST",
    token,
    fallback: "生成头像失败",
  });
  return rephrase(pending, TOO_OFTEN, 429);
}

export function uploadAgentAvatar(token: string, id: string, file: File): Promise<{ avatarUrl: string }> {
  const form = new FormData();
  form.append("file", file);
  const pending = request<{ avatarUrl: string }>(`/api/agents/${id}/avatar/upload`, {
    method: "POST",
    token,
    body: form,
    fallback: "上传失败",
  });
  return rephrase(pending, TOO_OFTEN, 429);
}
