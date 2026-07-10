import { describe, it, expect, vi } from "vitest";
import { parseShareToStored } from "./dub-parse-service.js";

function makeDeps(over: any = {}) {
  const billing = {
    chargeResource: vi.fn().mockResolvedValue({ charged: 100 }),
    refundResource: over.refundResource ?? vi.fn().mockResolvedValue({ success: true }),
  };
  const { refundResource, onError, ...rest } = over;
  return {
    billing,
    onError,
    parseConfig: { baseUrl: "http://apis.ppt6.top", clientId: "c", secretKey: "s" },
    parseShareUrlFn: vi.fn().mockResolvedValue({ kind: "video", desc: "标题", cover: "http://c/1.jpg", playAddr: "http://v/1.mp4" }),
    fetchRemoteFn: vi.fn().mockResolvedValue({ buffer: Buffer.from([1, 2, 3]), mime: "video/mp4", finalUrl: "http://v/1.mp4" }),
    probeDurationSec: vi.fn().mockResolvedValue(30),
    storeToS3: vi.fn().mockImplementation(async (a: { ext: string }) =>
      a.ext === "mp4" ? { url: "https://s3/v.mp4", objectKey: "dub/parsed/u1/v.mp4" } : { url: "https://s3/c.jpg", objectKey: "dub/parsed/u1/c.jpg" }),
    ...rest,
  };
}

describe("parseShareToStored", () => {
  it("视频帖成功：扣费一次，返回稳定 URL 与时长", async () => {
    const deps = makeDeps();
    const r = await parseShareToStored({ userId: "u1", requestId: "req1", text: "看 https://v.douyin.com/x 很燃", deps });
    expect(deps.billing.chargeResource).toHaveBeenCalledTimes(1);
    expect(deps.billing.refundResource).not.toHaveBeenCalled();
    expect(r.video.url).toBe("https://s3/v.mp4");
    expect(r.video.durationSec).toBe(30);
    expect(r.chargedPoints).toBe(100);
  });

  it("抽不到 URL：不扣费直接抛错", async () => {
    const deps = makeDeps();
    await expect(parseShareToStored({ userId: "u1", requestId: "req1", text: "没有链接", deps })).rejects.toThrow(/未识别|链接/);
    expect(deps.billing.chargeResource).not.toHaveBeenCalled();
  });

  it("图文帖：退款并抛错", async () => {
    const deps = makeDeps({ parseShareUrlFn: vi.fn().mockResolvedValue({ kind: "image", desc: "", cover: "", playAddr: "" }) });
    await expect(parseShareToStored({ userId: "u1", requestId: "req1", text: "https://v.douyin.com/x", deps })).rejects.toThrow(/图文|图集/);
    expect(deps.billing.refundResource).toHaveBeenCalledWith("dub-parse:req1");
  });

  it("下载失败：退款并抛错", async () => {
    const deps = makeDeps({ fetchRemoteFn: vi.fn().mockRejectedValue(new Error("下载失败")) });
    await expect(parseShareToStored({ userId: "u1", requestId: "req1", text: "https://v.douyin.com/x", deps })).rejects.toThrow();
    expect(deps.billing.refundResource).toHaveBeenCalledWith("dub-parse:req1");
  });

  it("非视频（时长0）：退款并抛错", async () => {
    const deps = makeDeps({ probeDurationSec: vi.fn().mockResolvedValue(0) });
    await expect(parseShareToStored({ userId: "u1", requestId: "req1", text: "https://v.douyin.com/x", deps })).rejects.toThrow();
    expect(deps.billing.refundResource).toHaveBeenCalledWith("dub-parse:req1");
  });

  it("退款失败：仍抛原始错误且通过 onError 暴露", async () => {
    const onError = vi.fn();
    const deps = makeDeps({
      parseShareUrlFn: vi.fn().mockResolvedValue({ kind: "image", desc: "", cover: "", playAddr: "" }),
      refundResource: vi.fn().mockRejectedValue(new Error("退款服务不可用")),
      onError,
    });
    await expect(parseShareToStored({ userId: "u1", requestId: "req1", text: "https://v.douyin.com/x", deps }))
      .rejects.toThrow(/图文|图集/); // 仍是原始错误
    expect(deps.billing.refundResource).toHaveBeenCalledWith("dub-parse:req1");
    expect(onError).toHaveBeenCalled();
  });

  it("封面下载失败：视频照常返回、cover 为空、不退款", async () => {
    const deps = makeDeps({
      fetchRemoteFn: vi.fn()
        .mockResolvedValueOnce({ buffer: Buffer.from([1, 2, 3]), mime: "video/mp4", finalUrl: "http://v/1.mp4" }) // 视频成功
        .mockRejectedValueOnce(new Error("封面失败")), // 封面失败
    });
    const r = await parseShareToStored({ userId: "u1", requestId: "req1", text: "https://v.douyin.com/x", deps });
    expect(r.video.url).toBe("https://s3/v.mp4");
    expect(r.cover.url).toBe("");
    expect(deps.billing.refundResource).not.toHaveBeenCalled();
  });
});
