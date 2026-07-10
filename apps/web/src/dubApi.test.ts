import { describe, it, expect, vi, afterEach } from "vitest";
import { getDubPricing, listAvatars, createProject, patchProject, generateTts, rewriteScript, createAvatar } from "./dubApi";

function ok(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { "content-type": "application/json" } }));
}
/** 给 mock 显式签名，否则 mock.calls 被推断为空元组，取 [0][1] 会 tsc 报错 */
function mockFetch(data: unknown) {
  return vi.fn((_url: string, _init?: RequestInit) => ok(data));
}
afterEach(() => vi.restoreAllMocks());

describe("dubApi", () => {
  it("getDubPricing 解出 data", async () => {
    vi.stubGlobal("fetch", mockFetch({ ttsChar: { rate: 1, perUnits: 1, enabled: true } }));
    const r = await getDubPricing("t");
    expect(r.ttsChar.enabled).toBe(true);
  });

  it("listAvatars 带 Authorization", async () => {
    const f = mockFetch([]);
    vi.stubGlobal("fetch", f);
    await listAvatars("tok");
    expect(f.mock.calls[0][1]?.headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("createProject POST body 带 title", async () => {
    const f = mockFetch({ id: "p1" });
    vi.stubGlobal("fetch", f);
    const p = await createProject("t", "标题");
    expect(p.id).toBe("p1");
    expect(JSON.parse(f.mock.calls[0][1]?.body as string)).toEqual({ title: "标题" });
  });

  it("patchProject PATCH 到 /projects/:id", async () => {
    const f = mockFetch(null);
    vi.stubGlobal("fetch", f);
    await patchProject("t", "p1", { script: "s" });
    expect(f.mock.calls[0][0]).toBe("/api/workflow/dub/projects/p1");
    expect(f.mock.calls[0][1]?.method).toBe("PATCH");
  });

  it("非 2xx 抛 ApiError 带后端 error 文案", async () => {
    vi.stubGlobal("fetch", vi.fn((_u: string, _i?: RequestInit) => Promise.resolve(new Response(JSON.stringify({ error: "算力点不足" }), { status: 402 }))));
    await expect(generateTts("t", { mode: "preset", text: "x", voice: "冰糖" })).rejects.toMatchObject({ name: "ApiError", status: 402, message: "算力点不足" });
  });

  it("rewriteScript 传 kbIds 与 injectHighlights", async () => {
    const f = mockFetch({ script: "洗后" });
    vi.stubGlobal("fetch", f);
    const s = await rewriteScript("t", { text: "原", kbIds: ["k1"], injectHighlights: true, highlights: ["卖点"] });
    expect(s).toBe("洗后");
    expect(JSON.parse(f.mock.calls[0][1]?.body as string)).toMatchObject({ kbIds: ["k1"], injectHighlights: true });
  });

  it("createAvatar 把 title 放 query，文件走 FormData", async () => {
    const f = mockFetch({ taskId: "t1" });
    vi.stubGlobal("fetch", f);
    const file = new File([new Uint8Array([1, 2])], "a.mp4", { type: "video/mp4" });
    const r = await createAvatar("tok", file, "我的形象");
    expect(r.taskId).toBe("t1");
    expect(f.mock.calls[0][0]).toBe(`/api/workflow/dub/avatars?title=${encodeURIComponent("我的形象")}`);
    expect(f.mock.calls[0][1]?.body).toBeInstanceOf(FormData);
  });
});
