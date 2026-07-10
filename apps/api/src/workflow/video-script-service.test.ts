import { describe, it, expect, vi } from "vitest";
import { generateScript } from "./video-script-service.js";

describe("generateScript", () => {
  it("reserve+settle 且结算 token 翻倍、type=video-script", async () => {
    const reserve = vi.fn().mockResolvedValue({ reserved: 10 });
    const settle = vi.fn().mockResolvedValue({ settled: 20 });
    const client = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "0-3s 开场…" }],
          usage: { input_tokens: 100, output_tokens: 80 },
        }),
      },
    } as never;
    const res = await generateScript({
      userId: "u1",
      payload: {
        insight: { productName: "洗发水", category: "", features: [], sellingPoints: [], audience: [], scenes: [] },
        business: "电商带货",
        language: "中文",
        contentType: "智能匹配",
        shootType: "智能匹配",
        note: "",
        durationSec: 15,
      },
      client,
      billing: { reserve, settle } as never,
    });
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ type: "video-script", model: "MiniMax-M3" }));
    // token×2
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 200, outputTokens: 160, model: "MiniMax-M3" }));
    expect(res.script).toContain("开场");
  });
});
