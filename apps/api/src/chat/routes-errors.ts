/**
 * chat/routes.ts 拆分后的上游错误翻译层:把模型服务抛出来的东西译成一句能给用户看的中文,
 * 外加百炼侧的模型 ID 别名映射。
 *
 * `chatModelErrorMessage` 的分支顺序是有意义的:两个 `instanceof`(超时 / 空响应)必须排在最前,
 * 因为它们是本仓自己抛的类型化错误,一旦落到后面的正则匹配上就会被误译成"API Key 无效"。
 *
 * `upstreamErrorDetails` 同时看 `value.code / value.error.code / value.cause.code` 三层 —— 各家
 * SDK 把错误码埋在不同深度,少看一层就会退化成兜底文案"生成失败,请重试",线上排障时等于没有信息。
 *
 * 兜底分支永远返回通用文案,不要把 `details.message` 直接透给前端:那里面可能带上游返回的
 * request id、账号信息甚至 key 片段。
 *
 * `BAILIAN_MODEL_ALIASES` 只在 provider === "bailian" 时生效,anthropic 走原名。新增别名往这里加,
 * 不要在路由里就地改 model 字符串 —— `session` 事件与消息落库记的都是别名前的模型名,两边一混,
 * 库里存的模型就跟实际调用的对不上。
 *
 * 依赖方向:本文件是叶子,只依赖 ../agent/run.js 的两个错误类。
 */

import { ChatModelEmptyResponseError, ChatModelStreamTimeoutError } from "../agent/run.js";

function upstreamErrorDetails(error: unknown): { status?: number; code: string; message: string } {
  if (!error || typeof error !== "object") {
    return { code: "", message: error instanceof Error ? error.message : String(error ?? "") };
  }
  const value = error as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
    error?: { code?: unknown; message?: unknown };
    cause?: { code?: unknown; message?: unknown };
  };
  const status = typeof value.status === "number" ? value.status : undefined;
  const code =
    [value.code, value.error?.code, value.cause?.code].find((item): item is string => typeof item === "string") ?? "";
  const message =
    [value.message, value.error?.message, value.cause?.message].find(
      (item): item is string => typeof item === "string",
    ) ?? "";
  return { status, code, message };
}

export type ChatErrorProvider = "bailian" | "anthropic" | "ai-pixel";

export function chatModelErrorMessage(error: unknown, provider: ChatErrorProvider): string {
  if (error instanceof ChatModelStreamTimeoutError) return "模型响应超时，请重试";
  if (error instanceof ChatModelEmptyResponseError) return "模型未返回内容，请重试";

  const details = upstreamErrorDetails(error);
  const searchable = `${details.code} ${details.message}`;
  const providerName = provider === "bailian" ? "百炼" : provider === "ai-pixel" ? "AI Pixel" : "模型服务";
  if (details.status === 401 || /invalid[_ .-]?api[_ .-]?key|authentication/i.test(searchable)) {
    return `${providerName} API Key 无效或已失效`;
  }
  if (/Model\.AccessDenied|access.?denied|permission/i.test(searchable)) {
    return `${providerName}业务空间未授权该模型，请检查 Workspace ID、API Key 与模型权限`;
  }
  if (details.status === 404 || /model.*(not found|不存在)|invalid.*model/i.test(searchable)) {
    return `${providerName}中不存在该模型或当前地域不可用`;
  }
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|connection/i.test(searchable)) {
    return `无法连接${providerName}，请检查接入地址与网络`;
  }
  return "生成失败，请重试";
}

const BAILIAN_MODEL_ALIASES = new Map<string, string>([["GLM-5.2", "glm-5.2"]]);

export function providerModelId(model: string, provider: "bailian" | "anthropic"): string {
  return provider === "bailian" ? (BAILIAN_MODEL_ALIASES.get(model) ?? model) : model;
}
