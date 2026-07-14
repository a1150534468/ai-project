import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNovelGenerator } from "./novel-generation.js";

const messagesCreate = vi.hoisted(() => vi.fn());

vi.mock("@ai-assistant/llm", () => ({
  loadLlmConfig: vi.fn(() => ({ defaultModel: "server-default" })),
  createLlmClient: vi.fn(() => ({
    messages: {
      create: messagesCreate,
    },
  })),
}));

describe("novel generation", () => {
  beforeEach(() => {
    messagesCreate.mockReset();
    messagesCreate.mockResolvedValue({
      content: [{ type: "text", text: "{\"ok\":true}" }],
    });
  });

  it("allocates enough completion tokens for counted volume planning", async () => {
    const generator = createNovelGenerator({});

    await generator({
      targetKind: "volumes",
      projectTitle: "寒泉烬",
      targetCount: 6,
    });

    expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
      max_tokens: expect.any(Number),
    }));
    expect(messagesCreate.mock.calls[0]?.[0].max_tokens).toBeGreaterThanOrEqual(6000);
  });

  it("allocates enough completion tokens for counted chapter outlines", async () => {
    const generator = createNovelGenerator({});

    await generator({
      targetKind: "outline",
      projectTitle: "寒泉烬",
      targetCount: 12,
    });

    expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
      max_tokens: expect.any(Number),
    }));
    expect(messagesCreate.mock.calls[0]?.[0].max_tokens).toBeGreaterThanOrEqual(10000);
  });
});
