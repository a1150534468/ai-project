import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildNovelPreparedRequest, createNovelGenerator } from "./novel-generation.js";

const messagesCreate = vi.hoisted(() => vi.fn());
const messagesStream = vi.hoisted(() => vi.fn());

vi.mock("@ai-assistant/llm", () => ({
  loadLlmConfig: vi.fn(() => ({ defaultModel: "server-default" })),
  createLlmClient: vi.fn(() => ({
    messages: {
      create: messagesCreate,
      stream: messagesStream,
    },
  })),
}));

describe("novel generation", () => {
  beforeEach(() => {
    messagesCreate.mockReset();
    messagesCreate.mockResolvedValue({
      content: [{ type: "text", text: "{\"ok\":true}" }],
    });
    messagesStream.mockReset();
  });

  it("allocates the full completion budget for PlotPilot story-tree planning", async () => {
    const generator = createNovelGenerator({});

    await generator({
      targetKind: "setupPlot",
      projectTitle: "寒泉烬",
    });

    expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
      max_tokens: expect.any(Number),
    }));
    expect(messagesCreate.mock.calls[0]?.[0].max_tokens).toBe(16000);
  });

  it("allocates enough completion tokens for Bible generation", async () => {
    const generator = createNovelGenerator({});

    await generator({
      targetKind: "setupBible",
      projectTitle: "寒泉烬",
    });

    expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
      max_tokens: expect.any(Number),
    }));
    expect(messagesCreate.mock.calls[0]?.[0].max_tokens).toBe(10000);
  });

  it("applies a validated project prompt model, temperature, and rendered content", async () => {
    const generator = createNovelGenerator({});
    await generator({
      targetKind: "chapter",
      projectTitle: "寒泉烬",
      promptOverride: "项目级章节提示词",
      modelOverride: "platform-novel-model",
      temperatureOverride: 0.55,
    });
    expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: "platform-novel-model",
      temperature: 0.55,
      messages: [{ role: "user", content: "项目级章节提示词" }],
    }));
  });

  it("persists exactly the request that is sent to the model", async () => {
    const onRequestPrepared = vi.fn(async () => undefined);
    await createNovelGenerator({})({
      targetKind: "chapter",
      projectTitle: "寒泉烬",
      chapterIndex: 3,
      chapterTitle: "夜门",
      promptOverride: "不可变的实际提示词",
      modelOverride: "audit-model",
      temperatureOverride: 0.4,
      onRequestPrepared,
    });
    const prepared = buildNovelPreparedRequest({ targetKind: "chapter", projectTitle: "寒泉烬", chapterIndex: 3, chapterTitle: "夜门", promptOverride: "不可变的实际提示词", temperatureOverride: 0.4 }, "audit-model");
    expect(onRequestPrepared).toHaveBeenCalledWith(prepared);
    expect(messagesCreate).toHaveBeenCalledWith({
      model: prepared.model,
      max_tokens: prepared.maxTokens,
      temperature: prepared.temperature,
      system: prepared.systemPrompt,
      messages: [{ role: "user", content: prepared.userPrompt }],
    });
  });

  it("forwards streamed chapter chunks before returning the final message", async () => {
    const listeners: Array<(chunk: string) => void> = [];
    messagesStream.mockReturnValue({
      on: vi.fn((_event: string, listener: (chunk: string) => void) => { listeners.push(listener); }),
      finalMessage: vi.fn(async () => {
        listeners.forEach((listener) => listener("第一段"));
        listeners.forEach((listener) => listener("第二段"));
        return { content: [{ type: "text", text: "第一段第二段" }] };
      }),
    });
    const onChunk = vi.fn(async (_chunk: string) => undefined);
    const result = await createNovelGenerator({})({ targetKind: "chapter", projectTitle: "寒泉烬", onChunk });
    expect(onChunk.mock.calls.map(([chunk]) => chunk)).toEqual(["第一段", "第二段"]);
    expect(result.text).toBe("第一段第二段");
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("aborts the upstream stream when a chunk callback detects cancellation", async () => {
    const listeners: Array<(chunk: string) => void> = [];
    const abort = vi.fn();
    messagesStream.mockReturnValue({
      abort,
      on: vi.fn((_event: string, listener: (chunk: string) => void) => { listeners.push(listener); }),
      finalMessage: vi.fn(async () => {
        listeners.forEach((listener) => listener("不应继续保存"));
        return { content: [{ type: "text", text: "不应继续保存" }] };
      }),
    });
    const stopped = new Error("任务已取消");
    await expect(createNovelGenerator({})({
      targetKind: "chapter",
      projectTitle: "寒泉烬",
      onChunk: vi.fn(async () => { throw stopped; }),
    })).rejects.toBe(stopped);
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
