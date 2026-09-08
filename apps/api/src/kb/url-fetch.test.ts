import { describe, it, expect, vi } from "vitest";
import { assertSafeUrl, fetchUrl, SsrfError } from "./url-fetch.js";

// 辅助函数：创建返回指定 IP 的 fake lookup
const lookupTo =
  (ip: string) =>
  async () => [{ address: ip, family: ip.includes(":") ? 6 : 4 }];

// 辅助函数：创建 fake Response
const createMockResponse = (
  status: number,
  body: string = "",
  headers: Record<string, string> = {}
): Response => {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...headers,
    },
  });
};

describe("assertSafeUrl", () => {
  describe("拒绝字面量危险 IP", () => {
    it.each([
      "http://127.0.0.1/",
      "http://127.0.0.5/",
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://[::]/",
    ])("拒绝回环地址: %s", async (u) => {
      await expect(assertSafeUrl(u, lookupTo("93.184.216.34"))).rejects.toBeInstanceOf(SsrfError);
    });

    it.each([
      "http://10.0.0.1/",
      "http://10.255.255.255/",
      "http://192.168.0.1/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
    ])("拒绝私网地址: %s", async (u) => {
      await expect(assertSafeUrl(u, lookupTo("93.184.216.34"))).rejects.toBeInstanceOf(SsrfError);
    });

    it.each([
      "http://169.254.169.254/latest/meta-data/",
      "http://169.254.169.253/",
      "http://169.254.0.1/",
    ])("拒绝链路本地/云元数据: %s", async (u) => {
      await expect(assertSafeUrl(u, lookupTo("93.184.216.34"))).rejects.toBeInstanceOf(SsrfError);
    });

    it.each([
      "http://[fc00::1]/",
      "http://[fe80::1]/",
    ])("拒绝 IPv6 本地/链路本地: %s", async (u) => {
      await expect(assertSafeUrl(u, lookupTo("2001:db8::1"))).rejects.toBeInstanceOf(SsrfError);
    });

    it.each([
      "http://224.0.0.1/",
      "http://239.255.255.255/",
    ])("拒绝组播地址: %s", async (u) => {
      await expect(assertSafeUrl(u, lookupTo("93.184.216.34"))).rejects.toBeInstanceOf(SsrfError);
    });
  });

  describe("拒绝非 http(s) 协议", () => {
    it.each([
      "ftp://example.com/",
      "file:///etc/passwd",
      "gopher://x/",
      "data:text/html,<h1>xss</h1>",
    ])("拒绝协议: %s", async (u) => {
      await expect(assertSafeUrl(u, lookupTo("93.184.216.34"))).rejects.toBeInstanceOf(SsrfError);
    });
  });

  describe("拒绝 DNS 解析到内网", () => {
    it("域名解析到回环", async () => {
      await expect(
        assertSafeUrl("http://evil.example.com/", lookupTo("127.0.0.1"))
      ).rejects.toBeInstanceOf(SsrfError);
    });

    it("域名解析到私网", async () => {
      await expect(
        assertSafeUrl("http://internal.local/", lookupTo("192.168.1.1"))
      ).rejects.toBeInstanceOf(SsrfError);
    });

    it("域名解析到云元数据 IP", async () => {
      await expect(
        assertSafeUrl("http://malicious.example.com/", lookupTo("169.254.169.254"))
      ).rejects.toBeInstanceOf(SsrfError);
    });

    it("localhost 解析失败也拒绝", async () => {
      await expect(
        assertSafeUrl("http://localhost/", lookupTo("127.0.0.1"))
      ).rejects.toBeInstanceOf(SsrfError);
    });
  });

  describe("放行安全公网 URL", () => {
    it("公网 https 域名", async () => {
      const ips = await assertSafeUrl("https://example.com/", lookupTo("93.184.216.34"));
      expect(ips).toEqual(["93.184.216.34"]);
    });

    it("公网 http 域名", async () => {
      const ips = await assertSafeUrl("http://google.com/path", lookupTo("142.251.32.46"));
      expect(ips).toEqual(["142.251.32.46"]);
    });

    it("字面公网 IPv4", async () => {
      const ips = await assertSafeUrl("https://93.184.216.34/");
      expect(ips).toEqual(["93.184.216.34"]);
    });

    it("字面公网 IPv6", async () => {
      const ips = await assertSafeUrl("https://[2606:4700:4700::1111]/");
      expect(ips).toEqual(["2606:4700:4700::1111"]);
    });
  });

  describe("对无效或恶意 URL 拒绝", () => {
    it("无效 URL 格式", async () => {
      await expect(
        assertSafeUrl("not a url", lookupTo("93.184.216.34"))
      ).rejects.toBeInstanceOf(SsrfError);
    });
  });
});

describe("fetchUrl 重定向防护", () => {
  describe("拒绝重定向到内网", () => {
    it("302 重定向到云元数据 IP 应拒绝", async () => {
      const fakeFetch = vi.fn(async (url: string) => {
        // 首次请求返回 302
        if (url === "https://example.com/") {
          return createMockResponse(302, "", {
            location: "http://169.254.169.254/latest/meta-data/",
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as any;

      await expect(
        fetchUrl("https://example.com/", {
          fetchFn: fakeFetch,
          lookupFn: lookupTo("93.184.216.34"),
        })
      ).rejects.toThrow("Redirect target blocked");

      // 应该只请求了第一个 URL，不应该跟进到内网
      expect(fakeFetch).toHaveBeenCalledTimes(1);
      expect(fakeFetch).toHaveBeenCalledWith("https://example.com/", expect.any(Object));
    });

    it("302 重定向到私网 IP 应拒绝", async () => {
      const fakeFetch = vi.fn(async (url: string) => {
        if (url === "https://example.com/") {
          return createMockResponse(302, "", {
            location: "http://192.168.1.1/admin",
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as any;

      await expect(
        fetchUrl("https://example.com/", {
          fetchFn: fakeFetch,
          lookupFn: lookupTo("93.184.216.34"),
        })
      ).rejects.toThrow("Redirect target blocked");

      expect(fakeFetch).toHaveBeenCalledTimes(1);
    });

    it("302 重定向到通过 DNS 解析到内网的域名应拒绝", async () => {
      const fakeFetch = vi.fn(async (url: string) => {
        if (url === "https://example.com/") {
          return createMockResponse(302, "", {
            location: "https://internal.local/data",
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as any;

      // internal.local 解析到私网 IP
      const lookupFn = vi.fn(async (hostname: string) => {
        if (hostname === "internal.local") {
          return [{ address: "192.168.1.1", family: 4 }];
        }
        return [{ address: "93.184.216.34", family: 4 }];
      }) as any;

      await expect(
        fetchUrl("https://example.com/", {
          fetchFn: fakeFetch,
          lookupFn,
        })
      ).rejects.toThrow("Redirect target blocked");

      expect(fakeFetch).toHaveBeenCalledTimes(1);
      expect(lookupFn).toHaveBeenCalledWith("internal.local", { all: true });
    });
  });

  describe("允许重定向到公网", () => {
    it("相对 Location 会先解析成绝对 URL 再复验", async () => {
      const fakeFetch = vi.fn(async (url: string) => url.endsWith("/start")
        ? createMockResponse(302, "", { location: "/next" })
        : createMockResponse(200, "done")) as any;
      const result = await fetchUrl("https://example.com/start", {
        fetchFn: fakeFetch,
        lookupFn: lookupTo("93.184.216.34"),
      });
      expect(result.finalUrl).toBe("https://example.com/next");
      expect(fakeFetch.mock.calls.map((call: unknown[]) => call[0])).toEqual([
        "https://example.com/start",
        "https://example.com/next",
      ]);
    });

    it("302 重定向到公网 URL 应正常跟进并读取内容", async () => {
      const responseBody = "Hello from redirected page";

      const fakeFetch = vi.fn(async (url: string) => {
        if (url === "https://example.com/") {
          // 第一个请求：302 重定向
          return createMockResponse(302, "", {
            location: "https://redirect.example.com/page",
          });
        }
        if (url === "https://redirect.example.com/page") {
          // 第二个请求：200 OK 并返回内容
          return createMockResponse(200, responseBody);
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as any;

      const result = await fetchUrl("https://example.com/", {
        fetchFn: fakeFetch,
        lookupFn: lookupTo("93.184.216.34"),
      });

      expect(result.buf.toString()).toBe(responseBody);
      expect(result.finalUrl).toBe("https://redirect.example.com/page");
      expect(result.contentType).toBe("text/html; charset=utf-8");

      // 应该请求了两个 URL
      expect(fakeFetch).toHaveBeenCalledTimes(2);
    });

    it("多次重定向（都到公网）应正常跟进直到 200", async () => {
      const responseBody = "Final content";

      const fakeFetch = vi.fn(async (url: string) => {
        if (url === "https://example.com/") {
          return createMockResponse(302, "", {
            location: "https://example.com/redirect1",
          });
        }
        if (url === "https://example.com/redirect1") {
          return createMockResponse(302, "", {
            location: "https://example.com/redirect2",
          });
        }
        if (url === "https://example.com/redirect2") {
          return createMockResponse(200, responseBody);
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as any;

      const result = await fetchUrl("https://example.com/", {
        fetchFn: fakeFetch,
        lookupFn: lookupTo("93.184.216.34"),
      });

      expect(result.buf.toString()).toBe(responseBody);
      expect(result.finalUrl).toBe("https://example.com/redirect2");
      expect(fakeFetch).toHaveBeenCalledTimes(3);
    });

    it("304 不是重定向，按 HTTP 错误处理", async () => {
      const fakeFetch = vi.fn(async () => new Response(null, { status: 304, headers: { location: "/wrong" } })) as any;
      await expect(fetchUrl("https://example.com/", {
        fetchFn: fakeFetch,
        lookupFn: lookupTo("93.184.216.34"),
      })).rejects.toThrow("HTTP 304");
      expect(fakeFetch).toHaveBeenCalledOnce();
    });

    it("超过最大重定向次数应拒绝", async () => {
      const fakeFetch = vi.fn(async (url: string) => {
        // 每次都返回 302，无限循环
        return createMockResponse(302, "", {
          location: `https://example.com/redirect${Math.random()}`,
        });
      }) as any;

      await expect(
        fetchUrl("https://example.com/", {
          fetchFn: fakeFetch,
          lookupFn: lookupTo("93.184.216.34"),
          maxRedirects: 3,
        })
      ).rejects.toThrow("Too many redirects");
    });
  });

  describe("总期限与字节上限", () => {
    it("初始 DNS 不返回时也按总期限结束", async () => {
      const pendingLookup = () => new Promise<Array<{ address: string; family: number }>>(() => undefined);
      await expect(fetchUrl("https://example.com/", { lookupFn: pendingLookup, timeoutMs: 5 }))
        .rejects.toThrow("timeout");
    });

    it("恰好 maxBytes 可收，第一个超限字节拒绝", async () => {
      const opts = { lookupFn: lookupTo("93.184.216.34"), maxBytes: 3 };
      await expect(fetchUrl("https://example.com/", {
        ...opts,
        fetchFn: (async () => createMockResponse(200, "abc")) as any,
      })).resolves.toMatchObject({ buf: Buffer.from("abc") });
      await expect(fetchUrl("https://example.com/", {
        ...opts,
        fetchFn: (async () => createMockResponse(200, "abcd")) as any,
      })).rejects.toThrow("exceeds max size");
    });
  });

  describe("初始 URL 校验", () => {
    it("初始 URL 是内网 IP 应立即拒绝，不发送请求", async () => {
      const fakeFetch = vi.fn();

      await expect(
        fetchUrl("http://192.168.1.1/", {
          fetchFn: fakeFetch as any,
          lookupFn: lookupTo("93.184.216.34"),
        })
      ).rejects.toBeInstanceOf(Error);

      // 根本不应该发送 HTTP 请求
      expect(fakeFetch).not.toHaveBeenCalled();
    });

    it("初始 URL 域名解析到内网应立即拒绝", async () => {
      const fakeFetch = vi.fn();

      const lookupFn = vi.fn(async (hostname: string) => {
        if (hostname === "internal.local") {
          return [{ address: "10.0.0.1", family: 4 }];
        }
        return [{ address: "93.184.216.34", family: 4 }];
      }) as any;

      await expect(
        fetchUrl("https://internal.local/", {
          fetchFn: fakeFetch as any,
          lookupFn,
        })
      ).rejects.toBeInstanceOf(Error);

      expect(fakeFetch).not.toHaveBeenCalled();
      expect(lookupFn).toHaveBeenCalledWith("internal.local", { all: true });
    });
  });
});
