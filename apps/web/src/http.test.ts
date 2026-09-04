import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_TOKEN_STORAGE_KEY, request, requestResponse, setAuthToken, unwrapData } from "./http";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** 显式签名，否则 mock.calls 被推断成空元组，取 [0][1] 会 tsc 报错（照抄 dubApi.test.ts）。 */
function mockFetch(response: Response) {
  return vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(response));
}

afterEach(() => {
  vi.restoreAllMocks();
  setAuthToken(null);
});

describe("http", () => {
  it("GET 带鉴权头，且没有 body 时不设 content-type", async () => {
    const f = mockFetch(json({ success: true, data: { ok: 1 } }));
    vi.stubGlobal("fetch", f);
    const r = await request<{ ok: number }>("/api/x", { token: "tok" });
    expect(r).toEqual({ ok: 1 });
    expect(f.mock.calls[0][1]?.method).toBe("GET");
    expect(f.mock.calls[0][1]?.headers).toEqual({ authorization: "Bearer tok" });
  });

  it("带 body 时序列化成 JSON 并补 content-type", async () => {
    const f = mockFetch(json({ success: true, data: null }));
    vi.stubGlobal("fetch", f);
    await request("/api/x", { method: "POST", token: "tok", body: { a: 1 } });
    expect(f.mock.calls[0][1]?.headers).toEqual({ authorization: "Bearer tok", "content-type": "application/json" });
    expect(f.mock.calls[0][1]?.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("FormData 原样发送，绝不手设 content-type（否则浏览器带不上 boundary）", async () => {
    const f = mockFetch(json({ success: true, data: null }));
    vi.stubGlobal("fetch", f);
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2])], "a.mp3", { type: "audio/mpeg" }));
    await request("/api/upload", { method: "POST", token: "tok", body: form });
    expect(f.mock.calls[0][1]?.headers).toEqual({ authorization: "Bearer tok" });
    expect(f.mock.calls[0][1]?.body).toBe(form);
  });

  it("token 显式传 null 表示公开接口，不带鉴权头", async () => {
    const f = mockFetch(json({ token: "jwt" }));
    vi.stubGlobal("fetch", f);
    setAuthToken("集中处的-token");
    await request("/api/auth/login", { method: "POST", token: null, body: { username: "u" } });
    expect(f.mock.calls[0][1]?.headers).toEqual({ "content-type": "application/json" });
  });

  it("省略 token 时取集中处的 token", async () => {
    const f = mockFetch(json({ success: true, data: null }));
    vi.stubGlobal("fetch", f);
    setAuthToken("集中处");
    await request("/api/x");
    expect(f.mock.calls[0][1]?.headers).toEqual({ authorization: "Bearer 集中处" });
  });

  it("集中处为空时回落 localStorage，读不到就不带头", async () => {
    const stored = mockFetch(json({ success: true, data: null }));
    vi.stubGlobal("fetch", stored);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === AUTH_TOKEN_STORAGE_KEY ? "存起来的" : null),
    });
    await request("/api/x");
    expect(stored.mock.calls[0][1]?.headers).toEqual({ authorization: "Bearer 存起来的" });

    const empty = mockFetch(json({ success: true, data: null }));
    vi.stubGlobal("fetch", empty);
    vi.stubGlobal("localStorage", { getItem: () => null });
    await request("/api/x");
    expect(empty.mock.calls[0][1]?.headers).toEqual({});
  });

  it("非 2xx 抛 ApiError，带上后端文案、状态码与结构化 data", async () => {
    vi.stubGlobal("fetch", mockFetch(json({ error: "额外重画次数已用尽", data: { remaining: 3 } }, 409)));
    await expect(request("/api/x", { token: "t" })).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      message: "额外重画次数已用尽",
      data: { remaining: 3 },
    });
  });

  it("后端没给 error 文案时用调用方的兜底文案", async () => {
    vi.stubGlobal("fetch", mockFetch(new Response("", { status: 500 })));
    await expect(request("/api/x", { token: "t", fallback: "生成失败" })).rejects.toMatchObject({
      status: 500,
      message: "生成失败",
    });
  });

  it("requestResponse 不碰 body，留给调用方流式读或取 blob", async () => {
    const response = json({ success: true, data: { ok: 1 } });
    vi.stubGlobal("fetch", mockFetch(response));
    const r = await requestResponse("/api/stream", { token: "t" });
    expect(r.bodyUsed).toBe(false);
    expect(await r.json()).toEqual({ success: true, data: { ok: 1 } });
  });

  it("unwrapData 只在有 data 键时脱壳，裸响应原样返回", () => {
    const shell = { success: true, data: { id: "a" } };
    expect(unwrapData<{ id: string }>(shell)).toEqual({ id: "a" });
    expect(unwrapData({ token: "jwt" })).toEqual({ token: "jwt" });
    expect(unwrapData<null>(null)).toBeNull();
    expect(unwrapData([1, 2])).toEqual([1, 2]);
  });
});
