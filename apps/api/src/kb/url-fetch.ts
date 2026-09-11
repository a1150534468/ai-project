import { lookup } from "node:dns/promises";
import { Agent, fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit } from "undici";
import ipaddr from "ipaddr.js";

export class SsrfError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SsrfError";
  }
}

type Address = { address: string; family: number };
type LookupFn = (hostname: string, options?: { all?: boolean }) => Promise<Address[]>;
type FetchFn = (input: string | URL | Request, init?: UndiciRequestInit) => Promise<Response>;
type DispatcherFactory = (addresses: readonly Address[]) => Dispatcher;

export interface FetchResult {
  buf: Buffer;
  contentType: string;
  finalUrl: string;
}

function blockedAddress(ip: string): boolean {
  try {
    const address = ipaddr.process(ip);
    // SSRF 边界只放行公网单播；保留、文档、隧道和基准网段都不需要由服务端访问。
    return address.range() !== "unicast";
  } catch {
    return true;
  }
}

function checkedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new SsrfError(`Invalid URL: ${raw}`, { cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`Unsupported protocol: ${url.protocol}. Only http: and https: allowed.`);
  }
  return url;
}

function hostnameOf(url: URL): string {
  return url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
}

async function safeAddresses(url: URL, lookupFn: LookupFn): Promise<Address[]> {
  const hostname = hostnameOf(url);
  const records = ipaddr.isValid(hostname)
    ? [{ address: hostname, family: hostname.includes(":") ? 6 : 4 }]
    : await lookupFn(hostname, { all: true }).catch((cause) => {
      throw new SsrfError(`DNS lookup failed for ${hostname}: ${cause}`, { cause });
    });
  if (records.length === 0) throw new SsrfError(`DNS lookup for ${hostname} returned no records`);
  for (const record of records) {
    if (blockedAddress(record.address)) {
      const detail = ipaddr.isValid(hostname)
        ? `Access to ${record.address} is blocked (dangerous IP range)`
        : `DNS ${hostname} resolves to blocked IP: ${record.address}`;
      throw new SsrfError(detail);
    }
  }
  return records;
}

export async function assertSafeUrl(raw: string, lookupFn: LookupFn = lookup as LookupFn): Promise<string[]> {
  return (await safeAddresses(checkedUrl(raw), lookupFn)).map(({ address }) => address);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) >= 0 ? value! : fallback;
}

function pinnedDispatcher(addresses: readonly Address[]): Dispatcher {
  let cursor = 0;
  return new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        const family = typeof options === "object" && "family" in options ? Number(options.family) : 0;
        const candidates = family === 4 || family === 6 ? addresses.filter((record) => record.family === family) : addresses;
        if (options.all) {
          callback(null, candidates.map((record) => ({ address: record.address, family: record.family })) as never, undefined as never);
          return;
        }
        const selected = candidates[cursor++ % candidates.length] ?? addresses[0];
        callback(null, selected.address, selected.family);
      },
    },
  });
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function withDeadline<T>(work: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const rejectOnAbort = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", rejectOnAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", rejectOnAbort));
  });
}

async function cancelBody(response: Response, signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (!response.body) return;
  await withDeadline(response.body.cancel(), signal, timeoutMs).catch(() => undefined);
}

/** 每一跳都把已验证 DNS 记录钉进连接器，系统 resolver 没有第二次改答案的机会。 */
export async function fetchUrl(
  raw: string,
  options: {
    maxBytes?: number;
    timeoutMs?: number;
    maxRedirects?: number;
    fetchFn?: FetchFn;
    lookupFn?: LookupFn;
    dispatcherFactory?: DispatcherFactory;
  } = {},
): Promise<FetchResult> {
  const maxBytes = positiveInteger(options.maxBytes, 10 * 1024 * 1024);
  const timeoutMs = positiveInteger(options.timeoutMs, 15_000);
  const maxRedirects = positiveInteger(options.maxRedirects, 3);
  const lookupFn = options.lookupFn ?? (lookup as LookupFn);
  const fetchFn: FetchFn = options.fetchFn ?? (undiciFetch as unknown as FetchFn);
  const makeDispatcher = options.dispatcherFactory ?? pinnedDispatcher;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`URL fetch timeout after ${timeoutMs}ms`)), timeoutMs);
  let current = checkedUrl(raw);

  try {
    for (let redirects = 0; ; redirects += 1) {
      const addresses = await withDeadline(safeAddresses(current, lookupFn), controller.signal, timeoutMs);
      const dispatcher = makeDispatcher(addresses);
      let response: Response;
      try {
        response = await withDeadline(fetchFn(current.href, {
          redirect: "manual",
          signal: controller.signal,
          dispatcher,
        } as UndiciRequestInit), controller.signal, timeoutMs);

        if (REDIRECT_STATUSES.has(response.status)) {
          await cancelBody(response, controller.signal, timeoutMs);
          const location = response.headers.get("location");
          if (!location) throw new Error(`Redirect without Location header: ${response.status}`);
          if (redirects >= maxRedirects) throw new Error(`Too many redirects (max ${maxRedirects})`);
          let next: URL;
          try {
            next = checkedUrl(new URL(location, current).href);
            await withDeadline(safeAddresses(next, lookupFn), controller.signal, timeoutMs);
          } catch (cause) {
            if (cause instanceof SsrfError) throw new SsrfError(`Redirect target blocked: ${cause.message}`, { cause });
            throw cause;
          }
          current = next;
          continue;
        }
        if (!response.ok) {
          await cancelBody(response, controller.signal, timeoutMs);
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        if (!response.body) throw new Error("Response has no body");

        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let total = 0;
        try {
          while (true) {
            const { done, value } = await withDeadline(reader.read(), controller.signal, timeoutMs);
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
              await withDeadline(reader.cancel(), controller.signal, timeoutMs).catch(() => undefined);
              throw new Error(`Response exceeds max size ${maxBytes} bytes`);
            }
            chunks.push(Buffer.from(value));
          }
        } finally {
          reader.releaseLock();
        }
        return { buf: Buffer.concat(chunks), contentType: response.headers.get("content-type") ?? "", finalUrl: current.href };
      } finally {
        await withDeadline(dispatcher.destroy(), controller.signal, timeoutMs).catch(() => undefined);
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
