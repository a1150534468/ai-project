/**
 * codex-pet-visual 拆分后的模型客户端层:选模型 → 校验路由 → 建 Anthropic 客户端 →
 * 带重试地发消息 → 校验响应出处 → 把响应裁成文本 / JSON。所有"与视觉模型对话"的
 * 管道都在这里,QA 与方向两侧只管拼 prompt 和解释结果。
 *
 * 这里刻意不复用共享 LLM 客户端的主 provider 兜底:桌宠是可选模型工作流,兜底会把
 * 选中的模型名发到不匹配的端点上。`loadCodexPetVisualQaRoute` 宁可在接活之前就抛。
 *
 * `CODEX_PET_ROUTE_ERROR_MESSAGES` 的三条消息文本运维按字符串排障,必须逐字保留;
 * 映射靠 `LlmRouteError.code` 而不是透传 `error.message`,否则会丢掉 model 前缀与
 * 「for the Codex pet workflow」后缀。
 *
 * `responseModel` 只在注入测试客户端时才允许响应不报模型 —— 真实路由上响应没有
 * model 字段就是合同违规,不能放过。
 *
 * 依赖方向:types → 本文件 → qa / direction。不 import image / seedream。
 */

import Anthropic from "@anthropic-ai/sdk";
import { jsonrepair } from "jsonrepair";
import {
  LlmRouteError,
  configuredChatgptModelList,
  defaultRetryableLlmError,
  resolveBailianCredentials,
  resolveChatgptCredentials,
  withLlmRetry,
  type LlmRouteCredentials,
  type LlmRouteErrorCode,
} from "@ai-assistant/llm";
import {
  CodexPetModelContractError,
  CODEX_PET_VISUAL_QA_MODEL,
  codexPetVisualQaRouteForModel,
  isAllowedCodexPetVisualModel,
  type CodexPetVisualQaRoute,
} from "./codex-pet-model-contract.js";
import type { CodexPetVisualModelProvenance } from "./codex-pet-visual-types.js";

export const DEFAULT_CODEX_PET_VISUAL_QA_MODEL = CODEX_PET_VISUAL_QA_MODEL;

/** Resolve and validate the project-selected visual reasoning model. */
export function resolveCodexPetVisualQaModel(env: NodeJS.ProcessEnv, requestedModel?: string): string {
  const model = requestedModel?.trim()
    || env.PET_VISUAL_QA_MODEL?.trim()
    || DEFAULT_CODEX_PET_VISUAL_QA_MODEL;
  if (!isAllowedCodexPetVisualModel(model)) {
    throw new CodexPetModelContractError("PET_VISUAL_QA_MODEL must be an enabled non-qwen3.7 marketplace model");
  }
  return model;
}

/**
 * The shared LLM client intentionally falls back to its primary provider when
 * a model route is missing. That is useful for ordinary chat, but unsafe for
 * this selectable-model workflow because the primary provider may not match
 * the frozen model route. Fail before accepting work instead of sending a
 * selected model name to the wrong endpoint.
 */
export function assertCodexPetVisualQaRoute(env: NodeJS.ProcessEnv = process.env, requestedModel?: string): {
  readonly model: string;
  readonly baseURL: string;
} {
  const { model, baseURL } = loadCodexPetVisualQaRoute(env, requestedModel);
  return { model, baseURL };
}

/**
 * 路由解析收敛到 `@ai-assistant/llm` 的 routes 之后，这里只保留 codex-pet 自己
 * 的三件事：合同错误的消息文本（带 `${model}` 前缀与「for the Codex pet
 * workflow」后缀，运维按这些字符串排障，必须逐字保留）、`CHATGPT_MODELS` 的成员
 * 检查、以及 `assertHttpModelRoute` 的协议校验。
 *
 * 映射靠 `LlmRouteError.code` 而不是透传 `error.message`：包里的消息是
 * provider 视角的（`BAILIAN_API_KEY or DASHSCOPE_API_KEY is required`），直接透
 * 传会丢掉 model 前缀与工作流后缀。非 `LlmRouteError`（例如 `BAILIAN_REGION`
 * 配成空串时 `buildBailianBaseURL` 抛的普通 Error）继续原样冒泡——那是配置写错，
 * 不是「这条路由没启用」。
 */
const CODEX_PET_ROUTE_ERROR_MESSAGES: Readonly<Record<LlmRouteErrorCode, (model: string) => string>> = {
  bailian_base_url_missing: (model) => `${model} requires BAILIAN_WORKSPACE_ID or BAILIAN_BASE_URL`,
  bailian_api_key_missing: (model) => `${model} requires BAILIAN_API_KEY or DASHSCOPE_API_KEY`,
  chatgpt_api_key_missing: (model) => `${model} requires CHATGPT_API_KEY or GPT_IMAGE_API_KEY for the Codex pet workflow`,
};

function resolveCodexPetRouteCredentials(
  model: string,
  resolve: () => LlmRouteCredentials,
): LlmRouteCredentials {
  try {
    return resolve();
  } catch (error) {
    if (error instanceof LlmRouteError) {
      throw new CodexPetModelContractError(CODEX_PET_ROUTE_ERROR_MESSAGES[error.code](model));
    }
    throw error;
  }
}

function loadCodexPetVisualQaRoute(env: NodeJS.ProcessEnv, requestedModel?: string): {
  readonly model: string;
  readonly baseURL: string;
  readonly apiKey: string;
  readonly route: CodexPetVisualQaRoute;
} {
  const model = resolveCodexPetVisualQaModel(env, requestedModel);
  const route = codexPetVisualQaRouteForModel(model, env);
  if (route === "bailian_model_route") {
    const { baseURL, apiKey } = resolveCodexPetRouteCredentials(model, () => resolveBailianCredentials(env));
    assertHttpModelRoute(baseURL, "Bailian visual model route");
    return { model, baseURL, apiKey, route };
  }
  // 只有显式配了 CHATGPT_MODELS 才做成员检查：没配时 marketplace 是可选模型的真
  // 相，`gpt-` 前缀的新模型不该因为不在内置名单里就被拒。
  const configuredModels = configuredChatgptModelList(env);
  if (configuredModels && !configuredModels.includes(model)) {
    throw new CodexPetModelContractError(`${model} must be present in CHATGPT_MODELS for the Codex pet workflow`);
  }
  const { baseURL, apiKey } = resolveCodexPetRouteCredentials(model, () => resolveChatgptCredentials(env));
  assertHttpModelRoute(baseURL, "CHATGPT_BASE_URL");
  return { model, baseURL, apiKey, route };
}

function assertHttpModelRoute(baseURL: string, label: string): void {
  let parsed: URL;
  try { parsed = new URL(baseURL); } catch {
    throw new CodexPetModelContractError(`${label} is invalid for the Codex pet workflow`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new CodexPetModelContractError(`${label} must use HTTP(S) for the Codex pet workflow`);
  }
}

export function codexPetVisualClient(env: NodeJS.ProcessEnv, injected?: Anthropic): {
  readonly client: Anthropic;
  readonly requestedModel: string;
  readonly route: CodexPetVisualModelProvenance["route"];
} {
  const requestedModel = resolveCodexPetVisualQaModel(env);
  if (injected) return { client: injected, requestedModel, route: "injected_test_client" };
  const route = loadCodexPetVisualQaRoute(env, requestedModel);
  return {
    // Use the exact selected route directly. The shared LLM client intentionally
    // owns a primary-provider fallback; that behavior is useful for ordinary
    // chat but is forbidden by the desktop-pet contract.
    client: new Anthropic({ baseURL: route.baseURL, apiKey: route.apiKey }),
    requestedModel,
    route: route.route,
  };
}

function responseModel(message: Anthropic.Message | string, requestedModel: string, allowMissing = false): string {
  let parsed: unknown = message;
  if (typeof message === "string") {
    try { parsed = JSON.parse(message) as unknown; } catch { parsed = null; }
  }
  const actualModel = parsed && typeof parsed === "object" && typeof (parsed as { model?: unknown }).model === "string"
    ? (parsed as { model: string }).model.trim()
    : "";
  if (!actualModel) {
    if (allowMissing) return requestedModel;
    throw new CodexPetModelContractError(`Codex pet visual response did not report its model for requested ${requestedModel}`);
  }
  if (!isAllowedCodexPetVisualModel(requestedModel)
    || !isAllowedCodexPetVisualModel(actualModel)
    || actualModel !== requestedModel) {
    throw new CodexPetModelContractError(`Codex pet visual model mismatch: requested ${requestedModel}, received ${actualModel || "unknown"}`);
  }
  return actualModel;
}

export function modelProvenance(
  message: Anthropic.Message | string,
  requestedModel: string,
  route: CodexPetVisualModelProvenance["route"],
): CodexPetVisualModelProvenance {
  return {
    requestedModel,
    actualModel: responseModel(message, requestedModel, route === "injected_test_client"),
    route,
  };
}

/**
 * 两个 env 旋钮的解析留在调用点：`withLlmRetry` 刻意不读 env，而 `Math.min(3,
 * …)` 的硬上限是 codex-pet 自己的策略。`CODEX_PET_VISUAL_RETRY_BASE_MS` 直接把
 * `Number(...)` 交给 `llmRetryDelayMs`——非有限值与负数由它回退到 5s，与原本
 * `codexPetVisualRetryDelayMs` 里的守卫逐字等价。
 */
function codexPetVisualMaxAttempts(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.CODEX_PET_VISUAL_MAX_ATTEMPTS);
  return Number.isInteger(configured) && configured > 0 ? Math.min(3, configured) : 3;
}

export async function createCodexPetVisualMessage(
  visual: ReturnType<typeof codexPetVisualClient>,
  params: Parameters<Anthropic["messages"]["create"]>[0],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly timeout: number;
  },
): Promise<Anthropic.Message | string> {
  return withLlmRetry(async () => await visual.client.messages.create(params, {
    signal: options.signal,
    timeout: options.timeout,
    maxRetries: 0,
  }) as Anthropic.Message | string, {
    maxAttempts: codexPetVisualMaxAttempts(options.env),
    baseDelayMs: Number(options.env.CODEX_PET_VISUAL_RETRY_BASE_MS),
    capDelayMs: 30_000,
    signal: options.signal,
    // 模型合同违规不是瞬时故障，重试只会把同一个错误再撞一遍。
    retryable: (error) => !(error instanceof CodexPetModelContractError) && defaultRetryableLlmError(error),
  });
}

export function textFromMessage(message: Anthropic.Message | string): string {
  const parsed = typeof message === "string" ? JSON.parse(message) as Anthropic.Message : message;
  return parsed.content.filter((block): block is Anthropic.TextBlock => block.type === "text").map((block) => block.text).join("").trim();
}

export function parseJsonObject(text: string): unknown {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("visual QA returned no JSON object");
  return JSON.parse(jsonrepair(stripped.slice(start, end + 1)));
}
