/**
 * 后端把失败写成 `{ error, data }`：`error` 是给人看的一句话，`data` 是造成失败的那个状态。
 *
 * `data` 一定要留着 —— 有些接口靠它回答「为什么不行」，比如桌宠的 409 会带上剩余的
 * 补修额度。只记 message 与 status 的调用方就没法告诉用户超了多少。
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /**
   * 从一个非 2xx 响应造错误。响应体只能读一次，所以 message 与 data 必须在这里一起取；
   * 读不出 JSON（网关吐 HTML、或者压根是空 body）就拿调用方的 fallback 顶上。
   */
  static async fromResponse(response: Response, fallback: string): Promise<ApiError> {
    const body = (await response.json().catch(() => null)) as { error?: string; data?: unknown } | null;
    const payload = body?.data;
    // 数组也算结构化 data，所以只排除 null 与非对象
    const data = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
    return new ApiError(body?.error || fallback, response.status, data);
  }
}

/**
 * 后端抛什么、网络抛什么，最后都得落到一句能给人看的话上。
 *
 * 这句话原来在 `apps/web` 里有七份各自的实现、四个名字（`errorMessage` / `messageOf` /
 * `codexPetErrorMessage` / `failureText`），另有七处直接写成内联三元。其中三份漏了
 * 「message 是空串」这一档：`fetch` 被 `AbortController` 掐断、或服务端回 `{ error: "" }`
 * 经 `fromResponse` 造出来的，都是 message 为空的 `Error` —— 那三处会弹一条空 toast，
 * 或者拼出「发送失败: 」这种断句。空串一律当没话说，走 fallback。
 */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}
