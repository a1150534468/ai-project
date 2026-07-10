import Anthropic from "@anthropic-ai/sdk";

export interface LlmConfig {
  baseURL: string;
  apiKey: string;
  defaultModel: string;
}

export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const baseURL = env.LLM_BASE_URL;
  const apiKey = env.LLM_API_KEY;
  const defaultModel = env.LLM_DEFAULT_MODEL ?? "GLM-5.2";
  if (!baseURL) throw new Error("LLM_BASE_URL is required");
  if (!apiKey) throw new Error("LLM_API_KEY is required");
  return { baseURL, apiKey, defaultModel };
}

// baseURL 指向 NewAPI 的 Anthropic 兼容端点（如 https://llm-gateway.example.com，勿带 /v1）；模型名是 NewAPI 渠道名（如 GLM-5.2）
export function createLlmClient(cfg: LlmConfig): Anthropic {
  return new Anthropic({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
}
