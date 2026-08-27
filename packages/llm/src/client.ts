import Anthropic from "@anthropic-ai/sdk";
import {
  LlmRouteError,
  type LlmRouteCredentials,
  buildBailianBaseURL,
  parseChatgptModelList,
  resolveChatgptCredentials,
} from "./routes.js";

// CHATGPT_MODELS / buildBailianBaseURL 现在定义在 routes.ts（依赖方向只留
// client → routes 一条边），这里 re-export 保持公开 API 不变。
export { CHATGPT_DEFAULT_BASE_URL, CHATGPT_MODELS, buildBailianBaseURL } from "./routes.js";

export type LlmProvider = "bailian" | "anthropic";

export interface LlmModelRoute {
  readonly model: string;
  readonly baseURL: string;
  readonly apiKey: string;
}

export interface LlmConfig {
  provider: LlmProvider;
  baseURL: string;
  apiKey: string;
  defaultModel: string;
  modelRoutes?: readonly LlmModelRoute[];
}

const BAILIAN_DEFAULT_MODEL = "qwen3.7-plus";
const ANTHROPIC_DEFAULT_MODEL = "GLM-5.2";

type ToolCapableMessageParams = {
  readonly tools?: readonly unknown[];
  readonly thinking?: Anthropic.ThinkingConfigParam;
};

/**
 * Bailian thinking-mode models do not reliably auto-select Anthropic tools, and
 * reject forced tool_choice values while thinking is enabled. Keep callers on
 * the native Anthropic shape and apply the provider-specific default here.
 */
export function withBailianMessageDefaults<T extends object>(
  params: T,
): T & ToolCapableMessageParams {
  const messageParams = params as T & ToolCapableMessageParams;
  if (!messageParams.tools?.length || messageParams.thinking !== undefined) return messageParams;
  return { ...messageParams, thinking: { type: "disabled" } };
}

function applyBailianMessageDefaults(client: Anthropic): void {
  type Create = Anthropic["messages"]["create"];
  type Stream = Anthropic["messages"]["stream"];
  const create = client.messages.create.bind(client.messages);
  const stream = client.messages.stream.bind(client.messages);

  client.messages.create = ((
    body: Parameters<Create>[0],
    options?: Parameters<Create>[1],
  ) => create(withBailianMessageDefaults(body), options)) as Create;
  client.messages.stream = ((
    body: Parameters<Stream>[0],
    options?: Parameters<Stream>[1],
  ) => stream(withBailianMessageDefaults(body), options)) as Stream;
}

function loadModelRoutes(env: NodeJS.ProcessEnv): LlmModelRoute[] {
  let credentials: LlmRouteCredentials;
  try {
    credentials = resolveChatgptCredentials(env);
  } catch (error) {
    // 现状语义：没有 ChatGPT key 就静默返回空路由表——那不是配置错误，只是没启
    // 用这条旁路。缺 key 之外的异常（例如 region 配成空串）仍要冒泡。
    if (error instanceof LlmRouteError) return [];
    throw error;
  }
  return parseChatgptModelList(env).map((model) => ({ model, ...credentials }));
}

function withModelRoutes(config: LlmConfig, env: NodeJS.ProcessEnv): LlmConfig {
  const modelRoutes = loadModelRoutes(env);
  return modelRoutes.length > 0 ? { ...config, modelRoutes } : config;
}

function applyModelRoutes(client: Anthropic, routes: readonly LlmModelRoute[]): void {
  if (routes.length === 0) return;
  type Create = Anthropic["messages"]["create"];
  type Stream = Anthropic["messages"]["stream"];
  const primaryCreate = client.messages.create.bind(client.messages);
  const primaryStream = client.messages.stream.bind(client.messages);
  const routeClients = new Map(routes.map((route) => [
    route.model,
    new Anthropic({ baseURL: route.baseURL, apiKey: route.apiKey }),
  ]));

  client.messages.create = ((
    body: Parameters<Create>[0],
    options?: Parameters<Create>[1],
  ) => {
    const routed = routeClients.get(body.model);
    return routed ? routed.messages.create(body, options) : primaryCreate(body, options);
  }) as Create;
  client.messages.stream = ((
    body: Parameters<Stream>[0],
    options?: Parameters<Stream>[1],
  ) => {
    const routed = routeClients.get(body.model);
    return routed ? routed.messages.stream(body, options) : primaryStream(body, options);
  }) as Stream;
}

function normalizedProvider(env: NodeJS.ProcessEnv): LlmProvider {
  const raw = env.LLM_PROVIDER?.trim().toLowerCase();
  if (raw === "bailian" || raw === "aliyun") return "bailian";
  if (raw === "anthropic" || raw === "newapi") return "anthropic";
  if (raw) throw new Error(`unsupported LLM_PROVIDER: ${env.LLM_PROVIDER}`);
  return env.BAILIAN_API_KEY || env.DASHSCOPE_API_KEY || env.BAILIAN_WORKSPACE_ID
    ? "bailian"
    : "anthropic";
}

export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const provider = normalizedProvider(env);
  if (provider === "bailian") {
    const baseURL = env.BAILIAN_BASE_URL?.trim()
      || (env.BAILIAN_WORKSPACE_ID
        ? buildBailianBaseURL(env.BAILIAN_WORKSPACE_ID, env.BAILIAN_REGION ?? "cn-beijing")
        : env.LLM_BASE_URL?.trim());
    const apiKey = env.BAILIAN_API_KEY?.trim()
      || env.DASHSCOPE_API_KEY?.trim();
    const defaultModel = env.LLM_DEFAULT_MODEL?.trim() || BAILIAN_DEFAULT_MODEL;
    if (!baseURL) {
      throw new Error("BAILIAN_WORKSPACE_ID or BAILIAN_BASE_URL is required when LLM_PROVIDER=bailian");
    }
    if (!apiKey) {
      throw new Error("BAILIAN_API_KEY or DASHSCOPE_API_KEY is required when LLM_PROVIDER=bailian");
    }
    return withModelRoutes({ provider, baseURL, apiKey, defaultModel }, env);
  }

  const baseURL = env.LLM_BASE_URL?.trim();
  const apiKey = env.LLM_API_KEY?.trim();
  const defaultModel = env.LLM_DEFAULT_MODEL?.trim() || ANTHROPIC_DEFAULT_MODEL;
  if (!baseURL) throw new Error("LLM_BASE_URL is required when LLM_PROVIDER=anthropic");
  if (!apiKey) throw new Error("LLM_API_KEY is required when LLM_PROVIDER=anthropic");
  return withModelRoutes({ provider, baseURL, apiKey, defaultModel }, env);
}

export function createLlmClient(cfg: LlmConfig): Anthropic {
  const client = new Anthropic({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  if (cfg.provider === "bailian") applyBailianMessageDefaults(client);
  applyModelRoutes(client, cfg.modelRoutes ?? []);
  return client;
}
