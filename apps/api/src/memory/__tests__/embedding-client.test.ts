import { describe, it, expect } from "vitest";
import { DEFAULT_EMBEDDING_MODEL, embed, loadEmbeddingConfig } from "../embedding-client.js";

describe("embed()", () => {
  it("未显式配置 EMBEDDING_MODEL 时使用统一默认向量模型", () => {
    const cfg = loadEmbeddingConfig({
      EMBEDDING_BASE_URL: "http://embedding.test",
      EMBEDDING_API_KEY: "test-key",
    } as NodeJS.ProcessEnv);
    expect(cfg.model).toBe(DEFAULT_EMBEDDING_MODEL);
  });

  it("返回 vector 与 token", async () => {
    const fake = (async () => ({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2] }],
        usage: { total_tokens: 7 },
      }),
    })) as unknown as typeof fetch;

    const result = await embed(
      { baseURL: "x", apiKey: "y", model: "m" },
      "hi",
      fake,
    );

    expect(result.vector).toEqual([0.1, 0.2]);
    expect(result.tokens).toBe(7);
  });

  it("usage 缺失时 tokens 为 0", async () => {
    const fake = (async () => ({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1] }],
      }),
    })) as unknown as typeof fetch;

    const result = await embed(
      { baseURL: "x", apiKey: "y", model: "m" },
      "hi",
      fake,
    );

    expect(result.tokens).toBe(0);
  });

  it("usage.total_tokens 缺失时 tokens 为 0", async () => {
    const fake = (async () => ({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1] }],
        usage: {},
      }),
    })) as unknown as typeof fetch;

    const result = await embed(
      { baseURL: "x", apiKey: "y", model: "m" },
      "hi",
      fake,
    );

    expect(result.tokens).toBe(0);
  });
});
