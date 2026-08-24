import { ApiError, readErrorBody } from "./apiError";

/**
 * 统一 HTTP 客户端（P1.2）。
 *
 * 存在的理由是「改一次鉴权只动一处」：迁移前 13 个 API 模块各自手拼
 * `authorization: Bearer ${token}` 与 `content-type`、各自判 `!response.ok`、
 * 各自解 `{ success, data }` 外壳，同一件事写了 124 遍。
 *
 * 错误与外壳都复用已有实现，不另造一套：`ApiError` / `readErrorBody` 来自
 * `./apiError`，`unwrapData` 从 `api.ts` 搬过来并在此导出。
 *
 * 流式接口（SSE、`getReader()`）不要用 `request<T>()` —— 它读完整个 body 再
 * `JSON.parse`。走 `requestResponse()`：鉴权头与错误处理照样复用，body 留给调用方自己流式读。
 */

/** token 在 localStorage 里的键；App.tsx 与本模块共用，避免两处各写一份字符串。 */
export const AUTH_TOKEN_STORAGE_KEY = "ai_assistant_token";

let currentToken: string | null = null;

/** 由 App.tsx 在 token 状态变化时调用，让没有 token 参数的调用方也能取到。 */
export function setAuthToken(token: string | null): void {
  currentToken = token && token.length > 0 ? token : null;
}

function readStoredToken(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || null;
  } catch {
    // Safari 隐私模式下 localStorage 可能直接抛，读不到就当没登录。
    return null;
  }
}

/** 集中处的 token：内存优先，其次 localStorage（首屏 App.tsx 还没挂载时也能取到）。 */
export function getAuthToken(): string | null {
  return currentToken ?? readStoredToken();
}

/**
 * `undefined`（调用方没传）走集中处；显式 `null` 表示公开接口，不带鉴权头。
 * 存量调用一律显式传 token，签名收敛是后续独立任务。
 */
function resolveToken(explicit: string | null | undefined): string | null {
  if (explicit === undefined) return getAuthToken();
  return explicit && explicit.length > 0 ? explicit : null;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RequestOptions = {
  readonly method?: HttpMethod;
  /** `FormData` 原样发送（浏览器自己带 boundary，不能手设 content-type），其余 JSON 序列化。 */
  readonly body?: unknown;
  readonly token?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** 上游没给 `error` 文案时的兜底文案。 */
  readonly fallback?: string;
  readonly credentials?: RequestCredentials;
};

/** 后端多数接口是 `{ success, data }` 外壳，少数（登录/`/auth/me`）直接返回裸对象，两种都要吃。 */
export function unwrapData<T>(resp: T | { data: T }): T {
  return resp && typeof resp === "object" && "data" in resp ? resp.data : (resp as T);
}

/** 发请求并校验状态码，body 不动 —— 流式读取与 blob 下载用这个。 */
export async function requestResponse(path: string, options: RequestOptions = {}): Promise<Response> {
  const { method = "GET", body, token, headers, signal, fallback = "请求失败", credentials } = options;
  const resolvedToken = resolveToken(token);
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  const finalHeaders: Record<string, string> = { ...headers };
  if (resolvedToken) finalHeaders.authorization = `Bearer ${resolvedToken}`;
  if (body !== undefined && !isForm) finalHeaders["content-type"] = "application/json";

  const response = await fetch(path, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    signal,
    credentials,
  });
  if (!response.ok) {
    const failure = await readErrorBody(response, fallback);
    throw new ApiError(failure.message, response.status, failure.data);
  }
  return response;
}

/** 发请求 → 校验状态码 → 解 JSON → 脱 `{ data }` 外壳。 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await requestResponse(path, options);
  return unwrapData((await response.json()) as T | { data: T });
}
