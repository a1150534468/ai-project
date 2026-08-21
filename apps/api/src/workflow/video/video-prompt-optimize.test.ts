import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLlm = vi.hoisted(() => ({
  create: vi.fn(async () => ({
    content: [{ type: "text", text: "参考 @视频1 的运镜，生成小猫跳舞的优化后的提示词。" }],
    usage: { input_tokens: 120, output_tokens: 80 },
  })),
}));

vi.mock("@ai-assistant/llm", () => ({
  loadLlmConfig: () => ({ baseURL: "http://llm", apiKey: "k" }),
  createLlmClient: () => ({ messages: { create: mockLlm.create } }),
}));

import { optimizeVideoPrompt } from "./video-prompt-optimize.js";

function billingMock() {
  return {
    reserve: vi.fn(async () => ({ reserved: 5 })),
    settle: vi.fn(async () => ({ settled: 3 })),
  };
}

describe("optimizeVideoPrompt 计费", () => {
  beforeEach(() => {
    mockLlm.create.mockClear();
    mockLlm.create.mockResolvedValue({
      content: [{ type: "text", text: "参考 @视频1 的运镜，生成小猫跳舞的优化后的提示词。" }],
      usage: { input_tokens: 120, output_tokens: 80 },
    });
  });

  it("先预扣再按实际 token 结算（按 chat / MiniMax-M3 计费）", async () => {
    const billing = billingMock();
    const text = await optimizeVideoPrompt({ prompt: "让小猫跳舞", userId: "u1", materials: { image: 0, video: 1, audio: 0 }, billing });
    expect(text).toContain("优化后的提示词");
    expect(billing.reserve).toHaveBeenCalledTimes(1);
    expect(billing.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", type: "chat", model: "MiniMax-M3", maxOutputTokens: 2200 }),
    );
    expect(billing.settle).toHaveBeenCalledTimes(1);
    expect(billing.settle).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", model: "MiniMax-M3", inputTokens: 120, outputTokens: 80 }),
    );
  });

  it("模型调用失败时按 0 结算退回预扣", async () => {
    mockLlm.create.mockRejectedValueOnce(new Error("boom"));
    const billing = billingMock();
    await expect(optimizeVideoPrompt({ prompt: "x", userId: "u2", billing })).rejects.toThrow();
    expect(billing.reserve).toHaveBeenCalledTimes(1);
    expect(billing.settle).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u2", model: "MiniMax-M3", inputTokens: 0, outputTokens: 0 }),
    );
  });
});
