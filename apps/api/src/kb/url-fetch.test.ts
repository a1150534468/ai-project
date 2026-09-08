import { describe, expect, it, vi } from "vitest";
import type { Dispatcher } from "undici";
import { assertSafeUrl, fetchUrl, SsrfError } from "./url-fetch.js";

const PUBLIC_V4 = "93.184.216.34";
const lookup = (...addresses: string[]) => vi.fn(async () =>
  addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
const response = (status: number, body: string | null = "", headers: Record<string, string> = {}) =>
  new Response(status === 204 || status === 304 ? null : body, { status, headers });

function inertDispatcher(): Dispatcher {
  return {
    close: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  } as unknown as Dispatcher;
}

describe("assertSafeUrl", () => {
  it.each([
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://224.0.0.1/",
    "http://0.0.0.1/",
  ])("拒绝危险字面地址 %s", async (url) => {
    await expect(assertSafeUrl(url, lookup(PUBLIC_V4))).rejects.toBeInstanceOf(SsrfError);
  });

  it.each(["file:///etc/passwd", "ftp://example.com/a", "data:text/plain,x", "not a url"])(
    "拒绝非 HTTP(S) 或畸形 URL %s",
    async (url) => {
      await expect(assertSafeUrl(url, lookup(PUBLIC_V4))).rejects.toBeInstanceOf(SsrfError);
    },
  );

  it("DNS 任一答案危险就整体拒绝，空答案和 resolver 错误也拒绝", async () => {
    await expect(assertSafeUrl("https://example.com", lookup(PUBLIC_V4, "127.0.0.1")))
      .rejects.toThrow("blocked IP");
    await expect(assertSafeUrl("https://example.com", lookup())).rejects.toThrow("no records");
    const failed = vi.fn().mockRejectedValue(new Error("dns down"));
    await expect(assertSafeUrl("https://example.com", failed)).rejects.toThrow("DNS lookup failed");
  });

  it("公网域名与字面 IPv4/IPv6 返回实际连接地址", async () => {
    await expect(assertSafeUrl("https://example.com", lookup(PUBLIC_V4))).resolves.toEqual([PUBLIC_V4]);
    await expect(assertSafeUrl(`https://${PUBLIC_V4}/`)).resolves.toEqual([PUBLIC_V4]);
    await expect(assertSafeUrl("https://[2606:4700:4700::1111]/")).resolves.toEqual(["2606:4700:4700::1111"]);
  });
});

describe("fetchUrl", () => {
  const base = {
    lookupFn: lookup(PUBLIC_V4),
    dispatcherFactory: vi.fn(() => inertDispatcher()),
  };

  it("相对与绝对公网重定向逐跳复验并返回最终 URL", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url === "https://example.com/start") return response(302, "", { location: "/next" });
      if (url === "https://example.com/next") return response(307, "", { location: "https://cdn.example/end" });
      return response(200, "done", { "content-type": "text/plain; charset=utf-8" });
    });
    const result = await fetchUrl("https://example.com/start", { ...base, fetchFn: fetchFn as never });
    expect(result).toEqual({
      buf: Buffer.from("done"),
      contentType: "text/plain; charset=utf-8",
      finalUrl: "https://cdn.example/end",
    });
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      "https://example.com/start",
      "https://example.com/next",
      "https://cdn.example/end",
    ]);
  });

  it("危险、非 HTTP 协议与无 Location 重定向不跟随", async () => {
    const privateLookup = vi.fn(async (hostname: string) => [{
      address: hostname === "internal.local" ? "10.0.0.1" : PUBLIC_V4,
      family: 4,
    }]);
    const privateRedirect = vi.fn(async () => response(302, "", { location: "http://internal.local/secret" }));
    await expect(fetchUrl("https://example.com/", {
      ...base,
      lookupFn: privateLookup,
      fetchFn: privateRedirect as never,
    })).rejects.toBeInstanceOf(SsrfError);
    expect(privateRedirect).toHaveBeenCalledOnce();

    for (const location of ["data:text/plain,secret", "file:///etc/passwd"]) {
      await expect(fetchUrl("https://example.com/", {
        ...base,
        fetchFn: (async () => response(302, "", { location })) as never,
      })).rejects.toThrow("Unsupported protocol");
    }
    await expect(fetchUrl("https://example.com/", {
      ...base,
      fetchFn: (async () => response(302)) as never,
    })).rejects.toThrow("Redirect without Location");
  });

  it("只跟随标准 redirect status，严格执行次数上限", async () => {
    const notRedirect = vi.fn(async () => response(304, null, { location: "/wrong" }));
    await expect(fetchUrl("https://example.com/", { ...base, fetchFn: notRedirect as never }))
      .rejects.toThrow("HTTP 304");
    expect(notRedirect).toHaveBeenCalledOnce();

    const loop = vi.fn(async () => response(302, "", { location: "/again" }));
    await expect(fetchUrl("https://example.com/", { ...base, fetchFn: loop as never, maxRedirects: 0 }))
      .rejects.toThrow("Too many redirects (max 0)");
    expect(loop).toHaveBeenCalledOnce();
  });

  it("恰好 maxBytes 可收，第一个超限字节拒绝", async () => {
    await expect(fetchUrl("https://example.com/", {
      ...base,
      maxBytes: 3,
      fetchFn: (async () => response(200, "abc")) as never,
    })).resolves.toMatchObject({ buf: Buffer.from("abc") });
    await expect(fetchUrl("https://example.com/", {
      ...base,
      maxBytes: 3,
      fetchFn: (async () => response(200, "abcd")) as never,
    })).rejects.toThrow("exceeds max size 3");
  });

  it("总期限覆盖初始 DNS 和忽略 signal 的 fetch", async () => {
    const never = new Promise<never>(() => undefined);
    await expect(fetchUrl("https://example.com/", {
      ...base,
      lookupFn: () => never,
      timeoutMs: 5,
    })).rejects.toThrow("timeout");
    await expect(fetchUrl("https://example.com/", {
      ...base,
      fetchFn: (() => never) as never,
      timeoutMs: 5,
    })).rejects.toThrow("timeout");
  });

  it("HTTP 错误与重定向显式取消响应 body，dispatcher 总会销毁", async () => {
    let cancels = 0;
    const body = new ReadableStream({ cancel() { cancels += 1; } });
    const dispatcher = inertDispatcher();
    await expect(fetchUrl("https://example.com/", {
      lookupFn: lookup(PUBLIC_V4),
      dispatcherFactory: () => dispatcher,
      fetchFn: (async () => new Response(body, { status: 500 })) as never,
    })).rejects.toThrow("HTTP 500");
    expect(cancels).toBe(1);
    expect(dispatcher.destroy).toHaveBeenCalledOnce();
  });

  it("生产连接器只接收本跳已经验证的地址", async () => {
    const dispatcherFactory = vi.fn(() => inertDispatcher());
    await fetchUrl("https://example.com/", {
      lookupFn: lookup("93.184.216.34", "2606:4700:4700::1111"),
      dispatcherFactory,
      fetchFn: (async () => response(200, "ok")) as never,
    });
    expect(dispatcherFactory).toHaveBeenCalledWith([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });
});
