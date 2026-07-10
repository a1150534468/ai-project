import { lookup } from "dns/promises";
import ipaddr from "ipaddr.js";

/**
 * SSRF (Server-Side Request Forgery) 防护异常
 */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

/**
 * 判定 IP 是否属于危险范围（内网、回环、保留、云元数据等）
 */
function isDangerousIp(ip: string): boolean {
  try {
    let addr = ipaddr.process(ip);

    // 显式检查云元数据端点
    if (ip === "169.254.169.254" || ip === "169.254.169.253") {
      return true;
    }

    // ipaddr.js range() 方法判定
    // 注意：避免使用 "reserved" 因为它包含测试地址，我们手动定义具体的危险段
    const dangerousRanges = [
      "private",       // 10/8, 172.16/12, 192.168/16, fc00::/7
      "loopback",      // 127/8, ::1
      "linkLocal",     // 169.254.0.0/16, fe80::/10
      "uniqueLocal",   // fc00::/7 (IPv6 ULA)
      "unspecified",   // 0.0.0.0/8, ::/128
      "broadcast",     // 255.255.255.255
      "carrierGradeNat", // 100.64.0.0/10
      "multicast",     // 224.0.0.0/4
    ];

    const range = addr.range();
    if (dangerousRanges.includes(range)) {
      return true;
    }

    // IPv4 0.0.0.0/8（不够具体的情况）
    if (addr.kind() === "ipv4") {
      const parts = ip.split(".");
      if (parts[0] === "0") {
        return true; // 0.x.x.x
      }
      if (parts[0] === "255" && parts[1] === "255" && parts[2] === "255") {
        return true; // 255.255.255.x
      }
    }

    return false;
  } catch {
    // 解析失败时视为危险
    return true;
  }
}

/**
 * DNS lookup 函数的类型定义（便于测试注入）
 */
type LookupFn = (
  hostname: string,
  options?: { all?: boolean }
) => Promise<Array<{ address: string; family: number }>>;

/**
 * 校验 URL 是否安全（防 SSRF）
 *
 * 执行步骤：
 * 1. 解析 URL，校验 protocol 必须是 http/https
 * 2. 解析 hostname 对应的所有 IP（A/AAAA）
 * 3. 对每个 IP 进行危险范围判定
 *
 * 注意：存在 TOCTOU 风险。本 MVP 接受"先校验再 fetch"的时间窗口内
 * DNS 重绑定攻击的残余风险。后续可通过"绑定已校验 IP"加固。
 *
 * @param raw 原始 URL 字符串
 * @param lookupFn 可选的 DNS lookup 函数（用于测试注入），默认使用 node:dns/promises
 * @returns 解析到的所有安全 IP 列表
 * @throws SsrfError 如果 URL 不安全
 */
export async function assertSafeUrl(
  raw: string,
  lookupFn?: LookupFn
): Promise<string[]> {
  const dnsLookup = (lookupFn ?? lookup) as LookupFn;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError(`Invalid URL: ${raw}`);
  }

  // 只允许 http/https
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new SsrfError(
      `Unsupported protocol: ${url.protocol}. Only http: and https: allowed.`
    );
  }

  let hostname = url.hostname;
  const ips: string[] = [];

  // URL.hostname 对于 IPv6 地址会保留方括号，需要去掉后再判定
  // 例如 http://[::1]/ 的 hostname 是 "[::1]"
  const ipToCheck = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  // 如果 hostname 已是 IP 字面量，直接判定
  if (ipaddr.isValid(ipToCheck)) {
    if (isDangerousIp(ipToCheck)) {
      throw new SsrfError(
        `Access to ${ipToCheck} is blocked (dangerous IP range)`
      );
    }
    ips.push(ipToCheck);
  } else {
    // 否则做 DNS lookup 获取所有 A/AAAA 记录
    try {
      const records = await dnsLookup(ipToCheck, { all: true });

      if (records.length === 0) {
        throw new SsrfError(`DNS lookup for ${ipToCheck} returned no records`);
      }

      for (const record of records) {
        if (isDangerousIp(record.address)) {
          throw new SsrfError(
            `DNS ${ipToCheck} resolves to blocked IP: ${record.address}`
          );
        }
        ips.push(record.address);
      }
    } catch (err) {
      if (err instanceof SsrfError) {
        throw err;
      }
      // DNS 查询失败也按危险处理（安全第一）
      throw new SsrfError(`DNS lookup failed for ${ipToCheck}: ${err}`);
    }
  }

  return ips;
}

export interface FetchResult {
  buf: Buffer;
  contentType: string;
  finalUrl: string;
}

/**
 * Fetch 函数的类型定义（便于测试注入）
 */
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * 安全地抓取 URL 内容（带 SSRF 防护）
 *
 * 特性：
 * - 手动跟随重定向，每跳前校验目标 URL 的安全性
 * - 支持字节数和超时限制
 * - 流式读取，超过 maxBytes 立即中断
 *
 * @param raw 原始 URL
 * @param opts 选项，包括：
 *   - maxBytes: 最大下载字节数（默认 10MB）
 *   - timeoutMs: 超时时间（默认 15s）
 *   - maxRedirects: 最大重定向次数（默认 3）
 *   - fetchFn: 可选的 fetch 实现（用于测试注入）
 *   - lookupFn: 可选的 DNS lookup 函数（用于测试注入）
 * @returns 包含内容、Content-Type 和最终 URL 的结果
 * @throws SsrfError 如果 URL 不安全
 * @throws Error 如果超过限制或网络错误
 */
export async function fetchUrl(
  raw: string,
  opts?: {
    maxBytes?: number;
    timeoutMs?: number;
    maxRedirects?: number;
    fetchFn?: FetchFn;
    lookupFn?: LookupFn;
  }
): Promise<FetchResult> {
  const maxBytes = opts?.maxBytes ?? 10 * 1024 * 1024; // 10MB
  const timeoutMs = opts?.timeoutMs ?? 15 * 1000; // 15s
  const maxRedirects = opts?.maxRedirects ?? 3;
  const doFetch = (opts?.fetchFn ?? fetch) as FetchFn;

  // 初始 URL 也要校验
  await assertSafeUrl(raw, opts?.lookupFn);

  let currentUrl = raw;
  let redirectCount = 0;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // 跟随重定向的循环
    while (redirectCount <= maxRedirects) {
      const response = await doFetch(currentUrl, {
        redirect: "manual", // 手动处理重定向
        signal: controller.signal,
      });

      // 重定向处理（3xx 状态码）
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`Redirect without Location header: ${response.status}`);
        }

        // 每个重定向目标也要校验安全性
        try {
          await assertSafeUrl(location, opts?.lookupFn);
        } catch (err) {
          throw new Error(
            `Redirect target blocked: ${err instanceof Error ? err.message : String(err)}`
          );
        }

        currentUrl = location;
        redirectCount++;

        // 超过重定向次数限制
        if (redirectCount > maxRedirects) {
          throw new Error(
            `Too many redirects (max ${maxRedirects})`
          );
        }

        continue;
      }

      // 非 2xx 也视为错误
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // 成功响应，读取内容
      const contentType = response.headers.get("content-type") ?? "";

      if (!response.body) {
        throw new Error("Response has no body");
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const reader = response.body.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          totalBytes += value.length;
          if (totalBytes > maxBytes) {
            throw new Error(
              `Response exceeds max size ${maxBytes} bytes`
            );
          }

          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }

      return {
        buf: Buffer.concat(chunks),
        contentType,
        finalUrl: currentUrl,
      };
    }

    throw new Error("Unreachable");
  } finally {
    clearTimeout(timeoutHandle);
    controller.abort();
  }
}
