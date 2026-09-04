import { describe, expect, it } from "vitest";
import { parseModelCatalogEnv, resolveModelCatalog } from "./routes.js";
import type { LlmConfig } from "@ai-assistant/llm";

function cfg(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "bailian",
    baseURL: "https://example.test",
    apiKey: "k",
    defaultModel: "qwen3.7-plus",
    ...overrides,
  };
}

describe("parseModelCatalogEnv", () => {
  it("没配就是空表（回落逻辑在 resolveModelCatalog 里，不在这里）", () => {
    expect(parseModelCatalogEnv(undefined)).toEqual([]);
    expect(parseModelCatalogEnv("   ")).toEqual([]);
    expect(parseModelCatalogEnv(",, ,")).toEqual([]);
  });

  it("`id:展示名` 与裸 id 混着配都认，省略展示名就用 id 本身", () => {
    expect(parseModelCatalogEnv("qwen-max:通义千问 Max, gpt-4o , glm-5.2:GLM 5.2")).toEqual([
      { model: "qwen-max", displayName: "通义千问 Max" },
      { model: "gpt-4o", displayName: "gpt-4o" },
      { model: "glm-5.2", displayName: "GLM 5.2" },
    ]);
  });

  it("模型 id 自带冒号时按最后一个冒号切，前半段整体当 id", () => {
    expect(parseModelCatalogEnv("relay:gpt-4o:中转 GPT-4o")).toEqual([
      { model: "relay:gpt-4o", displayName: "中转 GPT-4o" },
    ]);
    // 没有展示名时整串都是 id，不能把 `gpt-4o` 误当成展示名切掉
    expect(parseModelCatalogEnv("relay:gpt-4o:")).toEqual([
      { model: "relay:gpt-4o", displayName: "relay:gpt-4o" },
    ]);
  });
});

describe("resolveModelCatalog", () => {
  it("配了 LLM_MODELS 就只认它，顺序与配置一致", () => {
    const got = resolveModelCatalog({ LLM_MODELS: "b:B,a:A" } as NodeJS.ProcessEnv, cfg());
    expect(got).toEqual([
      { model: "b", displayName: "B" },
      { model: "a", displayName: "A" },
    ]);
  });

  it("重复的模型 id 只保留第一次出现的位置与展示名", () => {
    const got = resolveModelCatalog({ LLM_MODELS: "a:第一次,b:B,a:第二次" } as NodeJS.ProcessEnv, cfg());
    expect(got).toEqual([
      { model: "a", displayName: "第一次" },
      { model: "b", displayName: "B" },
    ]);
  });

  it("没配 LLM_MODELS 时回落到默认模型，且列表非空（前端下拉不能是空的）", () => {
    expect(resolveModelCatalog({} as NodeJS.ProcessEnv, cfg())).toEqual([
      { model: "qwen3.7-plus", displayName: "qwen3.7-plus" },
    ]);
  });

  it("回落时把已配好凭据的旁路模型接在默认模型后面", () => {
    const got = resolveModelCatalog({} as NodeJS.ProcessEnv, cfg({
      modelRoutes: [
        { model: "gpt-4o", baseURL: "https://x.test", apiKey: "k2" },
        // 与默认模型重名的那条不该出现两次
        { model: "qwen3.7-plus", baseURL: "https://x.test", apiKey: "k2" },
      ],
    }));
    expect(got.map((entry) => entry.model)).toEqual(["qwen3.7-plus", "gpt-4o"]);
  });
});
