import Anthropic from "@anthropic-ai/sdk";

export type LlmProvider = "bailian" | "anthropic";

export interface LlmConfig {
  provider: LlmProvider;
  baseURL: string;
  apiKey: string;
  defaultModel: string;
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

function normalizedProvider(env: NodeJS.ProcessEnv): LlmProvider {
  const raw = env.LLM_PROVIDER?.trim().toLowerCase();
  if (raw === "bailian" || raw === "aliyun") return "bailian";
  if (raw === "anthropic" || raw === "newapi") return "anthropic";
  if (raw) throw new Error(`unsupported LLM_PROVIDER: ${env.LLM_PROVIDER}`);
  return env.BAILIAN_API_KEY || env.DASHSCOPE_API_KEY || env.BAILIAN_WORKSPACE_ID
    ? "bailian"
    : "anthropic";
}

export function buildBailianBaseURL(workspaceId: string, region = "cn-beijing"): string {
  const normalizedWorkspaceId = workspaceId.trim();
  const normalizedRegion = region.trim();
  if (!normalizedWorkspaceId) throw new Error("BAILIAN_WORKSPACE_ID is required");
  if (!normalizedRegion) throw new Error("BAILIAN_REGION is required");
  return `https://${normalizedWorkspaceId}.${normalizedRegion}.maas.aliyuncs.com/apps/anthropic`;
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
    return { provider, baseURL, apiKey, defaultModel };
  }

  const baseURL = env.LLM_BASE_URL?.trim();
  const apiKey = env.LLM_API_KEY?.trim();
  const defaultModel = env.LLM_DEFAULT_MODEL?.trim() || ANTHROPIC_DEFAULT_MODEL;
  if (!baseURL) throw new Error("LLM_BASE_URL is required when LLM_PROVIDER=anthropic");
  if (!apiKey) throw new Error("LLM_API_KEY is required when LLM_PROVIDER=anthropic");
  return { provider, baseURL, apiKey, defaultModel };
}

export function createLlmClient(cfg: LlmConfig): Anthropic {
  const client = new Anthropic({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  if (cfg.provider === "bailian") applyBailianMessageDefaults(client);
  return client;
}
