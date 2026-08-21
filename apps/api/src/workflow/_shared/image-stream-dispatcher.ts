import { Agent } from "undici";

/**
 * 出图上游的单次尝试截止时间应当只有一个来源：image-service 里
 * `fetchWithTimeout` 的 AbortController（IMAGE_ATTEMPT_TIMEOUT_MS，默认 600s）。
 *
 * 但 undici 自带两道超时会先于它触发：
 *   - headersTimeout 默认 300s —— 实测响应头到达时间在 15s 到 76.5s 之间大幅波动；
 *   - bodyTimeout   默认 300s —— 计的是**两个 chunk 之间的间隔**，不是总时长。
 * 两者触发时抛的是 `terminated`（UND_ERR_HEADERS_TIMEOUT / UND_ERR_BODY_TIMEOUT），
 * 与中继侧断连的 `other side closed` 不是一回事，排查时极易混淆（见 docs/image.md 6.8/6.9）。
 *
 * 这里把 undici 两侧超时都置 0，让截止时间回归单一来源。
 */

let cached: Agent | null = null;

export function imageStreamDispatcherEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.IMAGE_UPSTREAM_DISPATCHER?.trim() !== "0";
}

function agent(): Agent {
  cached ??= new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  return cached;
}

/**
 * 给 https 上游请求挂上关掉超时的 dispatcher。
 * - 本地 http（minio / 回环）保持默认，不受影响；
 * - init 里已显式带 dispatcher 时不覆盖，保留测试注入的能力。
 */
export function withImageStreamDispatcher(
  url: string,
  init: RequestInit,
  env: NodeJS.ProcessEnv = process.env,
): RequestInit {
  if (!imageStreamDispatcherEnabled(env)) return init;
  if ((init as { dispatcher?: unknown }).dispatcher) return init;
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return init;
  }
  if (protocol !== "https:") return init;
  return { ...init, dispatcher: agent() } as RequestInit;
}
