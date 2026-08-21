import { describe, it, expect, vi } from "vitest";
import { loadMimoConfig, synthesizeTts } from "./dub-mimo-client.js";

const cfg = { apiKey: "k", baseUrl: "https://mimo.test/v1" };
function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("dub-mimo-client", () => {
  it("synthesizeTts 解出 base64 音频 data 与 format", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ choices: [{ message: { audio: { data: "QUJD" } } }] }));
    const r = await synthesizeTts(cfg, fetchFn, { model: "mimo-v2.5-tts", messages: [{ role: "assistant", content: "你好" }], audio: { format: "wav", voice: "冰糖" } });
    expect(r).toEqual({ data: "QUJD", format: "wav" });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://mimo.test/v1/chat/completions");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("k");
    expect(JSON.parse(init.body as string).audio.voice).toBe("冰糖");
  });

  it("非 200 抛 MimoError", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("bad", { status: 400 }));
    await expect(synthesizeTts(cfg, fetchFn, { model: "m", messages: [], audio: { format: "wav" } }))
      .rejects.toMatchObject({ name: "MimoError" });
  });

  it("缺 audio.data 抛 MimoError", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ choices: [{ message: {} }] }));
    await expect(synthesizeTts(cfg, fetchFn, { model: "m", messages: [], audio: { format: "wav" } }))
      .rejects.toMatchObject({ name: "MimoError" });
  });

  it("loadMimoConfig 缺 key 抛错", () => {
    expect(() => loadMimoConfig({} as NodeJS.ProcessEnv)).toThrow(/MIMO_API_KEY/);
  });
});
