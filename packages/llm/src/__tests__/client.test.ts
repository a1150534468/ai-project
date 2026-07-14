import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildBailianBaseURL,
  createLlmClient,
  loadLlmConfig,
  withBailianMessageDefaults,
} from "../client.js";

describe("loadLlmConfig", () => {
  it("builds the official Bailian Beijing Anthropic-compatible endpoint", () => {
    const config = loadLlmConfig({
      LLM_PROVIDER: "bailian",
      BAILIAN_WORKSPACE_ID: "ws-123",
      BAILIAN_API_KEY: "sk-test",
    } as NodeJS.ProcessEnv);

    expect(config).toEqual({
      provider: "bailian",
      baseURL: "https://ws-123.cn-beijing.maas.aliyuncs.com/apps/anthropic",
      apiKey: "sk-test",
      defaultModel: "qwen3.7-plus",
    });
  });

  it("prefers Bailian variables over legacy LLM gateway variables", () => {
    const config = loadLlmConfig({
      BAILIAN_WORKSPACE_ID: "ws-new",
      DASHSCOPE_API_KEY: "sk-bailian",
      LLM_BASE_URL: "http://127.0.0.1:9999",
      LLM_API_KEY: "sk-old",
      LLM_DEFAULT_MODEL: "qwen3.7-max",
    } as NodeJS.ProcessEnv);

    expect(config.provider).toBe("bailian");
    expect(config.baseURL).toContain("ws-new.cn-beijing.maas.aliyuncs.com");
    expect(config.apiKey).toBe("sk-bailian");
    expect(config.defaultModel).toBe("qwen3.7-max");
  });

  it("keeps the legacy Anthropic-compatible gateway as an explicit fallback", () => {
    expect(loadLlmConfig({
      LLM_PROVIDER: "anthropic",
      LLM_BASE_URL: "https://legacy.example.com",
      LLM_API_KEY: "legacy-key",
    } as NodeJS.ProcessEnv)).toMatchObject({
      provider: "anthropic",
      baseURL: "https://legacy.example.com",
      defaultModel: "GLM-5.2",
    });
  });

  it("rejects missing Bailian workspace configuration with an actionable error", () => {
    expect(() => loadLlmConfig({
      LLM_PROVIDER: "bailian",
      BAILIAN_API_KEY: "sk-test",
    } as NodeJS.ProcessEnv)).toThrow("BAILIAN_WORKSPACE_ID or BAILIAN_BASE_URL");
  });

  it("does not reuse a legacy gateway key for Bailian", () => {
    expect(() => loadLlmConfig({
      LLM_PROVIDER: "bailian",
      BAILIAN_WORKSPACE_ID: "ws-123",
      LLM_API_KEY: "legacy-key",
    } as NodeJS.ProcessEnv)).toThrow("BAILIAN_API_KEY or DASHSCOPE_API_KEY");
  });

  it("does not accept OpenAI as a provider alias", () => {
    expect(() => loadLlmConfig({
      LLM_PROVIDER: "openai",
      BAILIAN_WORKSPACE_ID: "ws-123",
      BAILIAN_API_KEY: "sk-test",
    } as NodeJS.ProcessEnv)).toThrow("unsupported LLM_PROVIDER: openai");
  });
});

describe("buildBailianBaseURL", () => {
  it("supports an explicitly selected region", () => {
    expect(buildBailianBaseURL("ws-1", "ap-southeast-1"))
      .toBe("https://ws-1.ap-southeast-1.maas.aliyuncs.com/apps/anthropic");
  });
});

describe("createLlmClient", () => {
  it("uses the Anthropic SDK directly for Bailian", () => {
    const client = createLlmClient({
      provider: "bailian",
      baseURL: "https://ws-123.cn-beijing.maas.aliyuncs.com/apps/anthropic",
      apiKey: "sk-test",
      defaultModel: "qwen3.7-plus",
    });

    expect(client).toBeInstanceOf(Anthropic);
    expect(client.baseURL).toBe("https://ws-123.cn-beijing.maas.aliyuncs.com/apps/anthropic");
  });
});

describe("withBailianMessageDefaults", () => {
  it("disables thinking for native Anthropic tool requests", () => {
    const params = withBailianMessageDefaults({
      tools: [{ name: "get_time" }],
      messages: [],
    });

    expect(params.thinking).toEqual({ type: "disabled" });
  });

  it("preserves an explicit thinking choice and non-tool requests", () => {
    const explicit = { tools: [{ name: "get_time" }], thinking: { type: "enabled" as const, budget_tokens: 1024 } };
    const noTools = { messages: [] };

    expect(withBailianMessageDefaults(explicit)).toBe(explicit);
    expect(withBailianMessageDefaults(noTools)).toBe(noTools);
  });
});
