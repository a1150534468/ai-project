import { describe, expect, it, vi } from "vitest";
import { billableEmbed, estimateEmbeddingTokens } from "../embedding-billing.js";

describe("billableEmbed", () => {
  it("按查询文本预扣，并在上游缺 token 用量时用估算 token 结算", async () => {
    const billing = {
      reserve: vi.fn(async () => ({ reserved: 1 })),
      settle: vi.fn(async () => ({ settled: 1 })),
    };
    const embedFn = vi.fn(async () => ({ vector: [0.1, 0.2], tokens: 0 }));
    const input = "用户使用知识库检索法律资料";
    const cfg = { baseURL: "http://embedding.test", apiKey: "k", model: "embedding-model" };

    const result = await billableEmbed({
      billing,
      cfg,
      userId: "u1",
      operationId: "turn:s1:1:embedding",
      input,
      embedFn,
    });

    expect(result.vector).toEqual([0.1, 0.2]);
    expect(billing.reserve).toHaveBeenCalledWith({
      operationId: "turn:s1:1:embedding",
      userId: "u1",
      type: "embedding",
      model: "embedding-model",
      inputTokens: estimateEmbeddingTokens(input),
      maxOutputTokens: 0,
    });
    expect(billing.settle).toHaveBeenCalledWith({
      operationId: "turn:s1:1:embedding",
      userId: "u1",
      model: "embedding-model",
      inputTokens: estimateEmbeddingTokens(input),
      outputTokens: 0,
    });
  });

  it("embedding 调用失败时退回预扣", async () => {
    const billing = {
      reserve: vi.fn(async () => ({ reserved: 1 })),
      settle: vi.fn(async () => ({ settled: 0 })),
    };
    const embedFn = vi.fn(async () => {
      throw new Error("embedding failed");
    });

    await expect(billableEmbed({
      billing,
      cfg: { baseURL: "http://embedding.test", apiKey: "k", model: "embedding-model" },
      userId: "u1",
      operationId: "turn:s1:1:embedding",
      input: "检索",
      embedFn,
    })).rejects.toThrow("embedding failed");

    expect(billing.settle).toHaveBeenCalledWith({
      operationId: "turn:s1:1:embedding",
      userId: "u1",
      model: "embedding-model",
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});
