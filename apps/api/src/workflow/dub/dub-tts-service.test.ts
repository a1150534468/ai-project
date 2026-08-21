import { describe, it, expect, vi } from "vitest";
import { buildTtsRequest, generateTts } from "./dub-tts-service.js";

describe("buildTtsRequest", () => {
  it("preset：model=mimo-v2.5-tts，assistant 放文案，audio.voice=音色", () => {
    const r = buildTtsRequest({ mode: "preset", text: "你好", voice: "冰糖", format: "wav" });
    expect(r.model).toBe("mimo-v2.5-tts");
    expect(r.audio).toMatchObject({ format: "wav", voice: "冰糖" });
    expect(r.messages.find((m) => m.role === "assistant")?.content).toBe("你好");
  });
  it("design：model=voicedesign，user 放音色描述，assistant 放文案", () => {
    const r = buildTtsRequest({ mode: "design", text: "晚安", description: "温柔治愈女声", format: "wav" });
    expect(r.model).toBe("mimo-v2.5-tts-voicedesign");
    expect(r.messages.find((m) => m.role === "user")?.content).toBe("温柔治愈女声");
    expect(r.messages.find((m) => m.role === "assistant")?.content).toBe("晚安");
  });
  it("clone：model=voiceclone，audio.voice=data URI", () => {
    const r = buildTtsRequest({ mode: "clone", text: "测试", refAudioDataUri: "data:audio/mpeg;base64,QUJD", format: "wav" });
    expect(r.model).toBe("mimo-v2.5-tts-voiceclone");
    expect(r.audio.voice).toBe("data:audio/mpeg;base64,QUJD");
  });
});

describe("generateTts", () => {
  function deps() {
    const billing = { chargeResource: vi.fn().mockResolvedValue({ charged: 5 }), refundResource: vi.fn().mockResolvedValue({ success: true }) };
    const synth = vi.fn().mockResolvedValue({ data: Buffer.from("audio").toString("base64"), format: "wav" });
    const storeAudio = vi.fn().mockResolvedValue({ url: "https://our/a.wav", objectKey: "k" });
    const probe = vi.fn().mockResolvedValue(3);
    return { billing: billing as any, synth, storeAudio, probe };
  }

  it("按输入字符收费·算力点，返回 audioUrl/duration", async () => {
    const d = deps();
    const r = await generateTts({ cfg: {} as any, fetchFn: vi.fn(), billing: d.billing, userId: "u1", mode: "preset", text: "你好世界", voice: "冰糖", format: "wav", synth: d.synth, storeAudio: d.storeAudio, probeDurationSec: d.probe });
    expect(d.billing.chargeResource).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "dub_tts_char", units: 4, accountType: "points" }));
    expect(r).toMatchObject({ audioUrl: "https://our/a.wav", durationSec: 3 });
  });

  it("合成失败：退款并抛错", async () => {
    const d = deps();
    d.synth.mockRejectedValue(new Error("mimo down"));
    await expect(generateTts({ cfg: {} as any, fetchFn: vi.fn(), billing: d.billing, userId: "u1", mode: "preset", text: "你好", voice: "冰糖", format: "wav", synth: d.synth, storeAudio: d.storeAudio, probeDurationSec: d.probe })).rejects.toThrow(/mimo down/);
    expect(d.billing.refundResource).toHaveBeenCalled();
  });

  it("空文案抛错，不收费", async () => {
    const d = deps();
    await expect(generateTts({ cfg: {} as any, fetchFn: vi.fn(), billing: d.billing, userId: "u1", mode: "preset", text: "  ", voice: "冰糖", format: "wav", synth: d.synth, storeAudio: d.storeAudio, probeDurationSec: d.probe })).rejects.toThrow(/文案/);
    expect(d.billing.chargeResource).not.toHaveBeenCalled();
  });
});
