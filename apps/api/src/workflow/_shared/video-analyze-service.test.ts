import { describe, it, expect, vi } from "vitest";
import { analyzeMaterials, analyzeReference } from "./video-analyze-service.js";

const baseInsight = {
  materials: [{ index: 1, description: "一栋欧式洋房" }],
  insight: {
    productName: "洗发水",
    category: "个人护理",
    features: ["半透明瓶身"],
    sellingPoints: ["复古质感"],
    audience: ["白领"],
    scenes: ["卫浴"],
  },
};

const VISION_CFG = { baseUrl: "https://gw.test", apiKey: "k", model: "gemini-2.5-flash" } as const;

/** 模型换成 gemini 原生 vision 调用后，mock 的是 callVision 而非 Anthropic client */
function fakeVision(text: string) {
  return vi.fn().mockResolvedValue({ text, usage: { inputTokens: 1795, outputTokens: 50 } });
}
/** 视频素材在送模型前会先过 ffmpeg 压缩，测试里直通即可 */
const passthroughCompress = vi.fn().mockImplementation(async (b: Buffer) => b);

describe("analyzeMaterials", () => {
  it("按图片张数+视频秒数各扣一次拆解费并返回洞察", async () => {
    const charge = vi.fn().mockResolvedValue({ charged: 3 });
    const refund = vi.fn();
    const durationByUrl = new Map([["v1", 8]]);
    const res = await analyzeMaterials({
      userId: "u1",
      requestId: "req-12345678",
      materials: [
        { url: "data:image/jpeg;base64,AAAA", mime: "image/jpeg" },
        { url: "v1", mime: "video/mp4" },
      ],
      cfg: VISION_CFG,
      callVisionFn: fakeVision(JSON.stringify(baseInsight)),
      billing: { chargeResource: charge, refundResource: refund } as never,
      resolveVideoSeconds: async () => durationByUrl,
      // 非 data URI 的视频素材会走 fetch 拉流，mock 返回合法字节。
      fetchFn: vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) as unknown as typeof fetch,
    });
    expect(charge).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceKey: "video_analyze_image",
        units: 1,
        accountType: "points",
      })
    );
    expect(charge).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceKey: "video_analyze_video_sec",
        units: 8,
        accountType: "points",
      })
    );
    expect(res.insight.productName).toBe("洗发水");
  });

  it("首次坏 JSON 自动重试，第二次好 JSON 则成功", async () => {
    const charge = vi.fn().mockResolvedValue({ charged: 3 });
    const call = vi.fn()
      .mockResolvedValueOnce({ text: "这不是JSON", usage: { inputTokens: 1795, outputTokens: 5 } })
      .mockResolvedValueOnce({ text: JSON.stringify(baseInsight), usage: { inputTokens: 1795, outputTokens: 50 } });
    const res = await analyzeMaterials({
      userId: "u1", requestId: "req-12345678",
      materials: [{ url: "data:image/jpeg;base64,AAAA", mime: "image/jpeg" }],
      cfg: VISION_CFG,
      callVisionFn: call,
      billing: { chargeResource: charge, refundResource: vi.fn() } as never,
      resolveVideoSeconds: async () => new Map(),
      fetchFn: vi.fn(),
    });
    expect(call).toHaveBeenCalledTimes(2);
    expect(res.insight.productName).toBe("洗发水");
  });

  it("M3 中文串含未转义引号(坏JSON)时 jsonrepair 修复后成功", async () => {
    const charge = vi.fn().mockResolvedValue({ charged: 3 });
    // description 里有未转义的双引号：...深棕色"复古"瓶身... —— 原生 JSON.parse 会失败。
    const badJson = '{"materials":[{"index":1,"description":"深棕色"复古"瓶身"}],"insight":{"productName":"洗发水","category":"个护","features":[],"sellingPoints":[],"audience":[],"scenes":[]}}';
    const res = await analyzeMaterials({
      userId: "u1", requestId: "req-12345678",
      materials: [{ url: "data:image/jpeg;base64,AAAA", mime: "image/jpeg" }],
      cfg: VISION_CFG,
      callVisionFn: fakeVision(badJson),
      billing: { chargeResource: charge, refundResource: vi.fn() } as never,
      resolveVideoSeconds: async () => new Map(),
      fetchFn: vi.fn(),
    });
    expect(res.insight.productName).toBe("洗发水");
  });

  it("M3 返回非法 JSON 抛错并退款", async () => {
    const charge = vi.fn().mockResolvedValue({ charged: 3 });
    const refund = vi.fn().mockResolvedValue({ success: true });
    await expect(
      analyzeMaterials({
        userId: "u1",
        requestId: "req-12345678",
        materials: [
          { url: "data:image/jpeg;base64,AAAA", mime: "image/jpeg" },
        ],
        cfg: VISION_CFG,
      callVisionFn: fakeVision("这不是JSON"),
        billing: { chargeResource: charge, refundResource: refund } as never,
        resolveVideoSeconds: async () => new Map(),
        fetchFn: vi.fn(),
      })
    ).rejects.toThrow();
    expect(refund).toHaveBeenCalled();
  });
});

describe("analyzeReference", () => {
  it("按视频秒数扣费并返回 script+highlights", async () => {
    const charge = vi.fn().mockResolvedValue({ charged: 5 });
    const callRef = fakeVision(JSON.stringify({ script: "0-3s 开场…", highlights: ["强钩子", "节奏快"] }));
    const res = await analyzeReference({
      userId: "u1",
      requestId: "ref-12345678",
      videoBuffer: Buffer.from("AAAA"),
      compressFn: passthroughCompress,
      mime: "video/mp4",
      durationSec: 12,
      cfg: VISION_CFG,
      callVisionFn: callRef,
      billing: { chargeResource: charge, refundResource: vi.fn() } as never,
    });
    expect(charge).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "video_analyze_video_sec", units: 12 }));
    expect(res.script).toContain("开场");
    expect(res.highlights).toContain("强钩子");
  });
});
