import { describe, it, expect, vi } from "vitest";
import { isBlockedAddress, fetchRemoteToBuffer } from "./safe-fetch.js";

describe("isBlockedAddress", () => {
  it("拦截私网/环回/链路本地/保留", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.0.1", "169.254.1.1", "0.0.0.0", "::1", "fc00::1", "fe80::1"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });
  it("放行公网", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "203.0.100.5"]) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });
  it("拦截十进制/八进制/十六进制编码 IP", () => {
    expect(isBlockedAddress("2852039166")).toBe(true);       // = 169.254.254.94 十进制
    expect(isBlockedAddress("0x7f.0.0.1")).toBe(true);        // 127.0.0.1 十六进制段
    expect(isBlockedAddress("0177.0.0.1")).toBe(true);        // 127.0.0.1 八进制段
  });
  it("拦截 CGNAT 100.64/10", () => {
    expect(isBlockedAddress("100.64.0.1")).toBe(true);
    expect(isBlockedAddress("100.127.255.255")).toBe(true);
    expect(isBlockedAddress("100.63.0.1")).toBe(false);       // 边界外放行
    expect(isBlockedAddress("100.128.0.1")).toBe(false);
  });
});

describe("fetchRemoteToBuffer", () => {
  const okBody = () => {
    const chunks = [new Uint8Array([1, 2, 3, 4])];
    return new ReadableStream<Uint8Array>({
      start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); },
    });
  };

  it("拒绝非 http(s)", async () => {
    await expect(fetchRemoteToBuffer("ftp://x/y", { maxBytes: 100, timeoutMs: 1000 })).rejects.toThrow();
  });

  it("拒绝解析到私网的 host", async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    await expect(
      fetchRemoteToBuffer("http://evil.internal/x", { maxBytes: 100, timeoutMs: 1000 }, { lookup }),
    ).rejects.toThrow(/内网|禁止|blocked/i);
  });

  it("公网成功返回 buffer 与 mime", async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(okBody(), { status: 200, headers: { "content-type": "video/mp4", "content-length": "4" } }),
    );
    const r = await fetchRemoteToBuffer("https://cdn.example.com/a.mp4", { maxBytes: 100, timeoutMs: 1000 }, { lookup, fetchFn });
    expect(r.buffer.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
    expect(r.mime).toBe("video/mp4");
  });

  it("超过 maxBytes 抛错", async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(okBody(), { status: 200, headers: { "content-type": "video/mp4" } }),
    );
    await expect(
      fetchRemoteToBuffer("https://cdn.example.com/a.mp4", { maxBytes: 2, timeoutMs: 1000 }, { lookup, fetchFn }),
    ).rejects.toThrow(/过大|too large|超/i);
  });

  it("字面编码 IP 的 host 直接拦截（不依赖 DNS）", async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
    await expect(
      fetchRemoteToBuffer("http://2852039166/x", { maxBytes: 100, timeoutMs: 1000 }, { lookup }),
    ).rejects.toThrow(/内网|禁止|blocked/i);
  });
});
