import { describe, it, expect, vi } from "vitest";
import { analyzeDubVideo, parseDubAnalysis } from "./dub-analyze-service.js";

const good = JSON.stringify({
  spokenScript: "大家好，今天聊聊这款耳机。",
  shotScript: "镜头1：特写耳机；镜头2：主播出镜。",
  structure: "钩子→卖点→CTA",
  highlights: ["降噪强", "续航久", "白领通勤"],
});

describe("parseDubAnalysis", () => {
  it("解析 4 板块", () => {
    const r = parseDubAnalysis(good);
    expect(r.spokenScript).toContain("耳机");
    expect(r.highlights).toEqual(["降噪强", "续航久", "白领通勤"]);
  });
  it("缺字段用默认值兜底", () => {
    const r = parseDubAnalysis(JSON.stringify({ spokenScript: "x" }));
    expect(r.shotScript).toBe("");
    expect(r.highlights).toEqual([]);
  });
});

describe("analyzeDubVideo", () => {
  function deps() {
    const billing = { chargeResource: vi.fn().mockResolvedValue({ charged: 10 }), refundResource: vi.fn().mockResolvedValue({ success: true }) };
    const callVisionFn = vi.fn().mockResolvedValue({ text: good, usage: { inputTokens: 1795, outputTokens: 100 } });
    const compressFn = vi.fn().mockImplementation(async (b: Buffer) => b);
    return { billing: billing as any, callVisionFn, compressFn };
  }
  const base = { userId: "u1", requestId: "r1", videoBuffer: Buffer.from("video"), mime: "video/mp4", cfg: { baseUrl: "b", apiKey: "k", model: "gemini-2.5-flash" } };

  it("按秒收费·算力点，返回 4 板块", async () => {
    const d = deps();
    const r = await analyzeDubVideo({ ...base, durationSec: 30, ...d });
    expect(d.billing.chargeResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "video_analyze_video_sec", units: 30, accountType: "points" }));
    expect(r.spokenScript).toContain("耳机");
  });

  it("先压缩再送模型（gemini inline_data 有体积上限）", async () => {
    const d = deps();
    await analyzeDubVideo({ ...base, durationSec: 10, ...d });
    expect(d.compressFn).toHaveBeenCalledWith(base.videoBuffer);
    const sent = d.callVisionFn.mock.calls[0][0];
    expect(sent.media[0]).toEqual({ mime: "video/mp4", base64: Buffer.from("video").toString("base64") });
  });

  it("时长为 0 抛错且不收费", async () => {
    const d = deps();
    await expect(analyzeDubVideo({ ...base, durationSec: 0, ...d })).rejects.toThrow(/时长/);
    expect(d.billing.chargeResource).not.toHaveBeenCalled();
  });

  it("模型失败：退款并抛错", async () => {
    const d = deps();
    d.callVisionFn.mockRejectedValue(new Error("vision down"));
    await expect(analyzeDubVideo({ ...base, durationSec: 10, ...d })).rejects.toThrow(/vision down/);
    expect(d.billing.refundResource).toHaveBeenCalled();
  });

  it("压缩失败（视频过大）：退款并抛错，且不再调模型", async () => {
    const d = deps();
    d.compressFn.mockRejectedValue(new Error("视频过大"));
    await expect(analyzeDubVideo({ ...base, durationSec: 10, ...d })).rejects.toThrow(/视频过大/);
    expect(d.billing.refundResource).toHaveBeenCalled();
    expect(d.callVisionFn).not.toHaveBeenCalled();
  });

  it("秒数向上取整", async () => {
    const d = deps();
    await analyzeDubVideo({ ...base, durationSec: 10.2, ...d });
    expect(d.billing.chargeResource).toHaveBeenCalledWith(expect.objectContaining({ units: 11 }));
  });
});
