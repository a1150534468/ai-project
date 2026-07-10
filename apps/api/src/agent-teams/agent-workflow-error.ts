import { InsufficientBalanceError } from "@yc/billing";

// 从上游 AI 服务错误(如 Anthropic APIError)中读取 HTTP 状态码
function upstreamStatus(error: unknown): number | null {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && status >= 100 && status <= 599) return status;
  }
  return null;
}

// 上游 SDK 报错常以 "402 {...}" 开头，从消息前缀兜底提取状态码
function statusFromMessage(message: string): number | null {
  const match = /^\s*(\d{3})\b/.exec(message);
  if (!match) return null;
  const status = Number(match[1]);
  return status >= 100 && status <= 599 ? status : null;
}

// 内部控制标识不应展示给用户
const INTERNAL_CODE = /^(AGENT_WORKFLOW_|AGENT_TEAM_|CHAT_MODEL_|BILLING_)/;

/**
 * 将执行期错误转成用户可读的中文提示，避免把上游原始报文(含账户余额、request id 等)
 * 透传到前端，造成信息泄露与误导(上游中转账户额度 ≠ 用户算力点)。
 */
export function formatAgentWorkflowError(error: unknown, fallback: string): string {
  if (error instanceof InsufficientBalanceError) return "算力点余额不足，请充值后重试";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const status = upstreamStatus(error) ?? statusFromMessage(message);
  const looksLikeUpstreamBalance = /insufficient\s+account\s+balance/i.test(message);
  if (status !== null || looksLikeUpstreamBalance) {
    if (status === 402 || looksLikeUpstreamBalance) return "AI 服务额度暂时不可用，请稍后重试或联系客服";
    if (status === 401 || status === 403) return "AI 服务鉴权失败，请联系客服";
    if (status === 429) return "AI 服务繁忙，请稍后重试";
    if (status !== null && status >= 500) return "AI 服务暂时不可用，请稍后重试";
    return "AI 服务调用失败，请稍后重试";
  }
  if (INTERNAL_CODE.test(message)) return fallback;
  return message.trim() ? message : fallback;
}
