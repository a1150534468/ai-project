/**
 * `codex-pet-visual.ts` 里有两套形状相同的重试循环：QA 文本调用
 * （`createCodexPetVisualMessage`）与图片生成（`generateCodexPetVisual`）。这里
 * 把「可重试判定 + 3 倍指数退避 + 可取消等待 + 循环骨架」抽成通用原语，行为逐字
 * 取自 QA 那套（`retryableCodexPetVisualError` / `codexPetVisualRetryDelayMs` /
 * `wait`），图片那套有 dispatch cooldown、onRetry 回调、模型错配直抛等额外语义，
 * 不在本原语的范围内。
 *
 * 领域错误的白/黑名单（例如 `CodexPetModelContractError` 一律不可重试）不进这
 * 里，改由调用方用 `retryable` 选项组合——原语只认 HTTP 状态码与网络错误码这些
 * 与 provider 无关的信号。
 */
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 5_000;
const DEFAULT_CAP_DELAY_MS = 30_000;
const DEFAULT_FACTOR = 3;

const RETRYABLE_STATUS = new Set([408, 409, 429]);
const RETRYABLE_CODES = new Set(["econnreset", "econnrefused", "enotfound", "eai_again"]);

/**
 * 有数字 `status` 就只看状态码，不再看 name/code——与现存实现一致：上游返回了
 * HTTP 响应时，状态码就是权威判定，401 不该因为 name 里带 "timeout" 被重试。
 */
export function defaultRetryableLlmError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; status?: unknown; code?: unknown };
  const status = typeof record.status === "number" ? record.status : null;
  if (status !== null) return RETRYABLE_STATUS.has(status) || status >= 500;
  const name = typeof record.name === "string" ? record.name.toLowerCase() : "";
  const code = typeof record.code === "string" ? record.code.toLowerCase() : "";
  return name.includes("connection")
    || name.includes("timeout")
    || code.includes("timeout")
    || RETRYABLE_CODES.has(code);
}

export interface LlmRetryDelayOptions {
  readonly baseDelayMs?: number;
  readonly capDelayMs?: number;
  readonly factor?: number;
}

/**
 * 非有限值与负数都回退缺省，调用方因此可以直接把 `Number(env.X)` 传进来（现存
 * 两处都是先 `Number.isFinite(...) && >= 0 ? ... : 5_000` 再算），无需在调用点
 * 复刻这段守卫。`Math.max(0, attempt - 1)` 也照抄：attempt 为 0/负数时取 base，
 * 不会算出比 base 更短的退避。
 */
function normalizedDelayMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function llmRetryDelayMs(attempt: number, options: LlmRetryDelayOptions = {}): number {
  const cap = normalizedDelayMs(options.capDelayMs, DEFAULT_CAP_DELAY_MS);
  const base = Math.min(cap, normalizedDelayMs(options.baseDelayMs, DEFAULT_BASE_DELAY_MS));
  const factor = normalizedDelayMs(options.factor, DEFAULT_FACTOR);
  return Math.min(cap, base * factor ** Math.max(0, attempt - 1));
}

/**
 * 逐字取自 `codex-pet-visual.ts` 的 `wait`：抛的是 `signal.reason` 本身，调用方
 * 靠它区分 lease 丢失与取消。保留 `async`——已 abort 时是 reject 而不是同步
 * throw，未 await 的调用点行为才和现状一致。
 */
export async function waitCancellable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export interface LlmRetryOptions extends LlmRetryDelayOptions {
  /** 非正整数（含 NaN）回退缺省 3——直接传 `Number(env.X)` 不会退化成无限重试。 */
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
  readonly retryable?: (error: unknown) => boolean;
}

/**
 * 判定顺序（次数用尽 → 已取消 → 不可重试）与现存实现逐字一致。退避期间被 abort
 * 时抛出的是 `signal.reason`，而不是上一次的业务错误：现存实现就是这样，取消的
 * 原因比被取消时手里那个错误更能说明发生了什么。
 */
export async function withLlmRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: LlmRetryOptions = {},
): Promise<T> {
  const maxAttempts = Number.isInteger(options.maxAttempts) && (options.maxAttempts as number) >= 1
    ? options.maxAttempts as number
    : DEFAULT_MAX_ATTEMPTS;
  const retryable = options.retryable ?? defaultRetryableLlmError;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= maxAttempts || options.signal?.aborted || !retryable(error)) throw error;
      await waitCancellable(llmRetryDelayMs(attempt, options), options.signal);
    }
  }
}
