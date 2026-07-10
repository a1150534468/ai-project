import { describe, it, expect, vi } from "vitest";
import { buildBlocks, callMiniMaxMessages } from "./video-multimodal.js";

describe("buildBlocks", () => {
  it("data URI 图片直接转 image block；视频转 video block；文本追加", async () => {
    const blocks = await buildBlocks(
      [
        { url: "data:image/jpeg;base64,AAAA", mime: "image/jpeg" },
        { url: "data:video/mp4;base64,BBBB", mime: "video/mp4" },
      ],
      "描述",
      { fetchFn: vi.fn() },
    );
    expect(blocks[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } });
    expect(blocks[1]).toEqual({ type: "video", source: { type: "base64", media_type: "video/mp4", data: "BBBB" } });
    expect(blocks[2]).toEqual({ type: "text", text: "描述" });
  });

  it("非 data URI 走 fetch 拉流转 base64", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    const blocks = await buildBlocks([{ url: "https://x/a.png", mime: "image/png" }], "t", { fetchFn: fetchFn as unknown as typeof fetch });
    expect(fetchFn).toHaveBeenCalledWith("https://x/a.png");
    expect(blocks[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") } });
  });
});

describe("callMiniMaxMessages", () => {
  it("拼装 system+blocks 调 client 并返回纯文本", async () => {
    const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "结果" }], usage: { input_tokens: 5, output_tokens: 3 } });
    const res = await callMiniMaxMessages({ client: { messages: { create } } as never, system: "S", blocks: [{ type: "text", text: "hi" }], maxTokens: 100 });
    expect(create).toHaveBeenCalled();
    expect(res.text).toBe("结果");
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
  });

  it("兼容返回 JSON 字符串的消息响应", async () => {
    const create = vi.fn().mockResolvedValue(JSON.stringify({
      content: [{ type: "text", text: "字符串结果" }],
      usage: { input_tokens: 2, output_tokens: 1 },
    }));
    const res = await callMiniMaxMessages({ client: { messages: { create } } as never, system: "S", blocks: [{ type: "text", text: "hi" }], maxTokens: 100 });
    expect(res.text).toBe("字符串结果");
    expect(res.usage).toEqual({ inputTokens: 2, outputTokens: 1 });
  });
});
