import { lookup as dnsLookup } from "node:dns/promises";

export interface FetchLimit { maxBytes: number; timeoutMs: number; maxRedirects?: number }
export interface FetchedRemote { buffer: Buffer; mime: string; finalUrl: string }
type LookupFn = (host: string) => Promise<Array<{ address: string; family: number }>>;

// 私网/环回/链路本地/保留段拦截（IPv4 含十进制/八进制/十六进制编码 + 常见 IPv6）。
// 注：DNS rebinding（校验与 fetch 之间两次解析可能不一致）为已接受风险——
// 威胁模型：半可信 CDN 直链、已鉴权、已限流、按次计费。
export function isBlockedAddress(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v.includes(":")) { // IPv6
    if (v === "::1") return true;
    if (v.startsWith("::ffff:")) return isBlockedAddress(v.slice(7)); // IPv4-mapped
    if (/^f[cd]/u.test(v)) return true;   // fc00::/7 ULA
    if (/^fe[89ab]/u.test(v)) return true; // fe80::/10 link-local
    return false;
  }
  const octets = normalizeIpv4(v);
  if (!octets) return false; // 非 IPv4 文本，交由 DNS 解析结果兜底
  const [a, b] = octets;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;              // link-local
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;    // RFC6598 CGNAT
  if (a >= 224) return true;                            // 组播/保留
  return false;
}

// 归一化 IPv4：支持点分十进制、单一十进制整数、以及每段的八进制(0..)/十六进制(0x..)。
function normalizeIpv4(v: string): [number, number, number, number] | null {
  const parseNum = (s: string): number | null => {
    let n: number;
    if (/^0x[0-9a-f]+$/u.test(s)) n = parseInt(s, 16);
    else if (/^0[0-7]+$/u.test(s)) n = parseInt(s, 8);
    else if (/^\d+$/u.test(s)) n = parseInt(s, 10);
    else return null;
    return Number.isFinite(n) ? n : null;
  };
  const parts = v.split(".");
  if (parts.length === 4) {
    const nums = parts.map(parseNum);
    if (nums.some((n) => n === null || (n as number) > 255)) return null;
    return nums as [number, number, number, number];
  }
  if (parts.length === 1) {
    const n = parseNum(parts[0]);
    if (n === null || n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  }
  return null;
}

async function assertHostAllowed(url: URL, lookup: LookupFn): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("仅允许 http(s) 链接");
  const host = url.hostname.replace(/^\[|\]$/gu, ""); // 去掉 IPv6 方括号
  if (isBlockedAddress(host)) throw new Error("禁止访问内网地址（blocked）"); // 字面编码 IP 先拦
  const addrs = await lookup(host);
  if (addrs.length === 0) throw new Error("域名无法解析");
  for (const a of addrs) if (isBlockedAddress(a.address)) throw new Error("禁止访问内网地址（blocked）");
}

export async function fetchRemoteToBuffer(
  input: string,
  limit: FetchLimit,
  deps: { fetchFn?: typeof fetch; lookup?: LookupFn } = {},
): Promise<FetchedRemote> {
  const fetchFn = deps.fetchFn ?? fetch;
  const lookup = deps.lookup ?? ((h: string) => dnsLookup(h, { all: true }));
  const maxRedirects = limit.maxRedirects ?? 3;

  let current = new URL(input);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertHostAllowed(current, lookup);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), limit.timeoutMs);
    try {
      const res = await fetchFn(current.toString(), { redirect: "manual", signal: ctrl.signal });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error("重定向缺少 Location");
        current = new URL(loc, current); // 相对跳转也支持；下一轮循环复检 host
        continue;
      }
      if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > limit.maxBytes) throw new Error("文件过大（too large）");
      const buffer = await readCapped(res, limit.maxBytes);
      return { buffer, mime: res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream", finalUrl: current.toString() };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("重定向次数过多");
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error("文件过大（too large）"); }
      parts.push(value);
    }
  }
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}
