/** 默认截断长度：上游报文常带整段 JSON，直接塞进 DB 的 error 列或响应体没有意义。 */
const DEFAULT_MAX_LENGTH = 500;

/**
 * 把任意 catch 到的东西转成「能直接发给用户 / 写进 DB」的一句话。
 *
 * 各域原先各写一份，差异只有两处：兜底文案、截断长度。文案是用户可见的，所以做成参数
 * 而不是在这里挑一个 —— 统一成一句「操作失败」等于把各域的语境全抹掉。
 *
 * 三条统一口径（原先各域略有出入，这里收敛掉）：
 * - 非 Error（含 undefined / 字符串 / 上游返回的裸对象）一律走 fallback，**不做**
 *   `String(err)` —— 那会把任意值原样漏进响应体。
 * - message 为空白同样走 fallback；原先部分调用点靠 `safeErrorMessage(e) || "xxx"`
 *   补这个洞，现在把 "xxx" 直接当 fallback 传进来即可。
 * - 截断只作用于 message，fallback 文案本身不截。
 *
 * 注意与 `agent-teams/agent-workflow-error.ts` 的 `formatAgentWorkflowError` 不是一回事：
 * 那个会按上游状态码**改写**报文以防泄露中转账户信息，是更强的一层；这里只做截断透传。
 */
export function errorMessageOrFallback(error: unknown, fallback: string, maxLength = DEFAULT_MAX_LENGTH): string {
  const message = error instanceof Error ? error.message : "";
  return message.trim() ? message.slice(0, maxLength) : fallback;
}
