/**
 * api.ts 的用例。mock 用真的 `Response`：
 * 上一版的假响应只有 `{ ok, status, json }`，而客户端读 body 走的是 `text()` 再 `JSON.parse`
 * —— 用假对象等于把解析那一段完全绕过去，而空 body / HTML 错误页恰恰是最容易出事的输入。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api.js";
import { loadSession, saveSession } from "./auth.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** 记下这一次请求，并按给定状态码与 body 回一个真 Response。 */
function stubFetch(status: number, body?: string, contentType = "application/json"): () => Call {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body,
    });
    // 204 不许带 body，用 null 表示「没有可读内容」
    return new Response(body ?? null, { status, headers: { "content-type": contentType } });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return () => {
    const call = calls.at(-1);
    if (!call) throw new Error("没有发出任何请求");
    return call;
  };
}

const SESSION = { token: "tk", adminId: "a1", role: "admin", permissions: [] } as const;

beforeEach(() => {
  sessionStorage.clear();
});

describe("请求组装", () => {
  it("登录：POST + JSON content-type，没会话就不带 authorization", async () => {
    const lastCall = stubFetch(200, JSON.stringify({ token: "tk", adminId: "a1", role: "admin", permissions: [] }));
    const session = await api.login("u", "p");
    expect(session.token).toBe("tk");
    const call = lastCall();
    expect(call.url).toBe("/api/admin/login");
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers.authorization).toBeUndefined();
    expect(call.body).toBe(JSON.stringify({ username: "u", password: "p" }));
  });

  it("有会话就带 Bearer token", async () => {
    saveSession({ ...SESSION, permissions: [] });
    const lastCall = stubFetch(200, JSON.stringify({ data: [] }));
    await api.listAnnouncements();
    expect(lastCall().headers.authorization).toBe("Bearer tk");
  });

  it("没有 payload 的请求不写 content-type", async () => {
    const lastCall = stubFetch(200, JSON.stringify({ data: null }));
    await api.banUser("u1");
    expect(lastCall().headers["content-type"]).toBeUndefined();
  });

  it("FormData 不写 content-type：multipart 的 boundary 得留给浏览器", async () => {
    const lastCall = stubFetch(200, JSON.stringify({ data: { id: "d1" } }));
    await api.addKbDoc("kb1", new File(["x"], "a.txt"));
    const call = lastCall();
    expect(call.headers["content-type"]).toBeUndefined();
    expect(call.body).toBeInstanceOf(FormData);
  });

  it("路径里的 id 一律编码", async () => {
    const lastCall = stubFetch(200, JSON.stringify({ data: null }));
    await api.deleteKbDoc("kb/1", "doc 2");
    expect(lastCall().url).toBe("/api/admin/kb/kb%2F1/documents/doc%202");
  });

  it("列表参数按服务端口径拼查询串", async () => {
    const lastCall = stubFetch(200, JSON.stringify({ data: [], total: 0, page: 1, pageSize: 20 }));
    await api.listUsers("张三", 3, 50);
    const url = new URL(lastCall().url, "http://x");
    expect(url.pathname).toBe("/api/admin/users");
    expect(url.searchParams.get("q")).toBe("张三");
    expect(url.searchParams.get("page")).toBe("3");
    expect(url.searchParams.get("pageSize")).toBe("50");
  });

  it("搜索词为空时不带 q", async () => {
    const lastCall = stubFetch(200, JSON.stringify({ data: [], total: 0, page: 1, pageSize: 20 }));
    await api.listUsers();
    expect(new URL(lastCall().url, "http://x").searchParams.has("q")).toBe(false);
  });
});

describe("响应处理", () => {
  it("envelope 只把 data 交出去", async () => {
    stubFetch(200, JSON.stringify({ success: true, data: [{ id: "k1", name: "库" }] }));
    await expect(api.adminListKb()).resolves.toEqual([{ id: "k1", name: "库" }]);
  });

  it("用户分页：data 改叫 rows，页码取服务端夹好的值", async () => {
    stubFetch(200, JSON.stringify({ data: [{ id: "u1" }], total: 61, page: 4, pageSize: 20 }));
    await expect(api.listUsers(undefined, 9)).resolves.toEqual({
      rows: [{ id: "u1" }],
      total: 61,
      page: 4,
      pageSize: 20,
    });
  });

  it("空 body 的成功响应不算失败", async () => {
    stubFetch(204);
    await expect(api.deleteKb("k1")).resolves.toBeUndefined();
  });

  it("401：抛 UnauthorizedError，并就地清掉死 token", async () => {
    saveSession({ ...SESSION, permissions: [] });
    stubFetch(401, JSON.stringify({ error: "expired" }));
    await expect(api.listAudit()).rejects.toBeInstanceOf(api.UnauthorizedError);
    // 不清的话下一个请求还会带着它再撞一次 401
    expect(loadSession()).toBeNull();
  });

  it("403：抛 ForbiddenError", async () => {
    stubFetch(403, JSON.stringify({ error: "no perm" }));
    await expect(api.listAdmins()).rejects.toBeInstanceOf(api.ForbiddenError);
  });

  it("其他失败取 body 里的 error 文案", async () => {
    stubFetch(422, JSON.stringify({ error: "用户名已存在" }));
    await expect(api.createUser("u", "p")).rejects.toThrow("用户名已存在");
  });

  it("网关回 HTML 错误页时报状态码，不是 JSON 解析异常", async () => {
    stubFetch(502, "<html><body>Bad Gateway</body></html>", "text/html");
    await expect(api.listAnnouncements()).rejects.toThrow("请求失败 (502)");
  });

  it("失败且 body 里没有 error 字段，也报状态码", async () => {
    stubFetch(500, JSON.stringify({ message: "boom" }));
    await expect(api.listClientMenus()).rejects.toThrow("请求失败 (500)");
  });
});
