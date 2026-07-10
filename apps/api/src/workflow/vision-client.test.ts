import { describe, it, expect, vi } from "vitest";
import { loadVisionConfig, callVision, VisionError, MIN_MEDIA_PROMPT_TOKENS } from "./vision-client.js";

const cfg = { baseUrl: "https://gw.test", apiKey: "k", model: "gemini-2.5-flash" };
function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function okBody(text: string, promptTokens: number) {
  return { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: 7 } };
}
const media = [{ mime: "video/mp4", base64: "QUJD" }];

describe("loadVisionConfig", () => {
  it("默认模型 gemini-2.5-flash，回退到 LLM_* 配置", () => {
    const c = loadVisionConfig({ LLM_BASE_URL: "https://x.com/", LLM_API_KEY: "kk" } as unknown as NodeJS.ProcessEnv);
    expect(c).toEqual({ baseUrl: "https://x.com", apiKey: "kk", model: "gemini-2.5-flash" });
  });
  it("VIDEO_ANALYZE_MODEL 可覆盖", () => {
    const c = loadVisionConfig({ LLM_BASE_URL: "https://x.com", LLM_API_KEY: "kk", VIDEO_ANALYZE_MODEL: "gemini-3.5-flash" } as unknown as NodeJS.ProcessEnv);
    expect(c.model).toBe("gemini-3.5-flash");
  });
  it("缺 key 抛错", () => {
    expect(() => loadVisionConfig({ LLM_BASE_URL: "https://x.com" } as unknown as NodeJS.ProcessEnv)).toThrow(/API_KEY/);
  });
});

describe("callVision", () => {
  it("打 gemini 原生端点，媒体走 inline_data，system 走 systemInstruction", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes(okBody("转写结果", 1795)));
    const r = await callVision({ cfg, fetchFn, system: "SYS", media, text: "请转写", maxTokens: 400 });
    expect(r.text).toBe("转写结果");
    expect(r.usage).toEqual({ inputTokens: 1795, outputTokens: 7 });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://gw.test/v1beta/models/gemini-2.5-flash:generateContent");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
    const body = JSON.parse(init.body as string);
    expect(body.systemInstruction.parts[0].text).toBe("SYS");
    expect(body.contents[0].parts[0].inline_data).toEqual({ mime_type: "video/mp4", data: "QUJD" });
    expect(body.contents[0].parts[1].text).toBe("请转写");
  });

  it("【核心防线】带媒体但 promptTokenCount 过低 → 判定媒体被网关丢弃，抛错而非返回幻觉", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes(okBody("我们这个项目是一个非常好的项目。", 51)));
    await expect(callVision({ cfg, fetchFn, system: "SYS", media, text: "请转写", maxTokens: 400 }))
      .rejects.toMatchObject({ name: "VisionError" });
    expect(MIN_MEDIA_PROMPT_TOKENS).toBeGreaterThan(51);
  });

  it("无媒体时不做 token 校验（纯文本调用允许低 token）", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes(okBody("好的", 6)));
    const r = await callVision({ cfg, fetchFn, system: "SYS", media: [], text: "hi", maxTokens: 10 });
    expect(r.text).toBe("好的");
  });

  it("非 200 抛 VisionError 带状态码", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("bad", { status: 429 }));
    await expect(callVision({ cfg, fetchFn, system: "S", media, text: "t", maxTokens: 10 }))
      .rejects.toMatchObject({ name: "VisionError", status: 429 });
  });

  it("响应无文本抛 VisionError", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ candidates: [{ content: { parts: [] } }], usageMetadata: { promptTokenCount: 2000 } }));
    await expect(callVision({ cfg, fetchFn, system: "S", media, text: "t", maxTokens: 10 }))
      .rejects.toMatchObject({ name: "VisionError" });
  });
});

describe("VisionError", () => {
  it("带 name 与可选 status", () => {
    const e = new VisionError("boom", 500);
    expect(e.name).toBe("VisionError");
    expect(e.status).toBe(500);
  });
});
