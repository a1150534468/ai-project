import { describe, it, expect, vi } from "vitest";
import {
  BAILIAN_EMBEDDING_BASE_URL,
  DEFAULT_EMBEDDING_DIMENSION,
  DEFAULT_EMBEDDING_MODEL,
  embed,
  embeddingEndpoint,
  loadEmbeddingConfig,
} from "../embedding-client.js";

describe("embed()", () => {
  it("未显式配置 EMBEDDING_MODEL 时使用统一默认向量模型", () => {
    const cfg = loadEmbeddingConfig({
      EMBEDDING_BASE_URL: "http://embedding.test",
      EMBEDDING_API_KEY: "test-key",
    } as NodeJS.ProcessEnv);
    expect(cfg.model).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(cfg.dimension).toBe(DEFAULT_EMBEDDING_DIMENSION);
  });

  it("百炼直接复用业务空间 API Key 和官方向量地址", () => {
    const cfg = loadEmbeddingConfig({
      LLM_PROVIDER: "bailian",
      BAILIAN_WORKSPACE_ID: "ws-1",
      BAILIAN_API_KEY: "sk-test",
      LLM_BASE_URL: "http://127.0.0.1:9999",
      LLM_API_KEY: "legacy-key",
    } as NodeJS.ProcessEnv);

    expect(cfg).toEqual({
      baseURL: BAILIAN_EMBEDDING_BASE_URL,
      apiKey: "sk-test",
      model: DEFAULT_EMBEDDING_MODEL,
      dimension: DEFAULT_EMBEDDING_DIMENSION,
    });
  });

  it("百炼缺少可用 API Key 时返回明确错误", () => {
    expect(() => loadEmbeddingConfig({
      LLM_PROVIDER: "bailian",
      BAILIAN_WORKSPACE_ID: "ws-1",
    } as NodeJS.ProcessEnv)).toThrow("BAILIAN_API_KEY, DASHSCOPE_API_KEY or EMBEDDING_API_KEY");
  });

  it("不会在显式包含 /v1 的向量地址后重复拼接 /v1", () => {
    expect(embeddingEndpoint("https://embedding.example.com/v1"))
      .toBe("https://embedding.example.com/v1/embeddings");
    expect(embeddingEndpoint("https://legacy.example.com"))
      .toBe("https://legacy.example.com/v1/embeddings");
  });

  it("返回 vector 与 token", async () => {
    const fake = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2] }],
        usage: { total_tokens: 7 },
      }),
    })) as unknown as typeof fetch;

    const result = await embed(
      { baseURL: "x", apiKey: "y", model: "m", dimension: 2 },
      "hi",
      fake,
    );

    expect(result.vector).toEqual([0.1, 0.2]);
    expect(result.tokens).toBe(7);
    expect(JSON.parse(String(vi.mocked(fake).mock.calls[0][1]?.body))).toMatchObject({
      model: "m",
      input: "hi",
      dimensions: 2,
      encoding_format: "float",
    });
  });

  it("usage 缺失时 tokens 为 0", async () => {
    const fake = (async () => ({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1] }],
      }),
    })) as unknown as typeof fetch;

    const result = await embed(
      { baseURL: "x", apiKey: "y", model: "m", dimension: 1 },
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
      { baseURL: "x", apiKey: "y", model: "m", dimension: 1 },
      "hi",
      fake,
    );

    expect(result.tokens).toBe(0);
  });

  it("拒绝与数据库配置不一致的向量维度", async () => {
    const fake = (async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }),
    })) as unknown as typeof fetch;

    await expect(embed(
      { baseURL: "x", apiKey: "y", model: "m", dimension: 3 },
      "hi",
      fake,
    )).rejects.toThrow("expected 3 dimensions, got 2");
  });
});
