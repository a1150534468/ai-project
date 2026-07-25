import { lookup as dnsLookup } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent, setGlobalDispatcher } from "undici";

const systemLookup = dnsLookup as unknown as LookupFunction;

export interface CodexPetUpstreamDnsOverride {
  readonly hostname: string;
  readonly family: 4 | 6;
  readonly lookup: LookupFunction;
}

export function codexPetUpstreamAllowH2(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODEX_PET_UPSTREAM_ALLOW_H2?.trim() !== "0";
}

export function createCodexPetUpstreamDnsOverride(
  endpoint: string,
  address: string,
  fallbackLookup: LookupFunction = systemLookup,
): CodexPetUpstreamDnsOverride {
  const hostname = new URL(endpoint).hostname.toLowerCase();
  const normalizedAddress = address.trim();
  const family = isIP(normalizedAddress);
  if (family !== 4 && family !== 6) {
    throw new Error("CODEX_PET_UPSTREAM_RESOLVE_IP must be a literal IPv4 or IPv6 address");
  }

  const lookup: LookupFunction = (requestedHostname, options, callback) => {
    if (requestedHostname.toLowerCase() !== hostname) {
      fallbackLookup(requestedHostname, options, callback);
      return;
    }
    if (options.all) callback(null, [{ address: normalizedAddress, family }]);
    else callback(null, normalizedAddress, family);
  };
  return { hostname, family, lookup };
}

export function installCodexPetUpstreamDnsOverride(
  endpoint: string,
  env: NodeJS.ProcessEnv = process.env,
): CodexPetUpstreamDnsOverride | null {
  const address = env.CODEX_PET_UPSTREAM_RESOLVE_IP?.trim();
  if (!address) return null;
  const override = createCodexPetUpstreamDnsOverride(endpoint, address);
  // Pixel's long-running image edits are served over HTTP/2 on the primary
  // endpoint. Undici otherwise advertises HTTP/1.1 only, and the relay can
  // close that connection near the one-minute mark before response headers
  // arrive. Prefer h2 while retaining Undici's HTTP/1.1 fallback for hosts
  // that do not advertise it.
  setGlobalDispatcher(new Agent({ allowH2: codexPetUpstreamAllowH2(env), connect: { lookup: override.lookup } }));
  return override;
}

/**
 * Use a fresh Pixel connection for each Codex pet request. Pixel's primary
 * endpoint supports HTTP/2, but long-lived h2 session reuse can leave a later
 * image edit waiting on a half-closed stream until the application timeout.
 * Buffering the bounded image response lets us close the dispatcher before
 * handing a normal Response back to the existing image adapter.
 */
export function createCodexPetUpstreamFetch(
  endpoint: string,
  env: NodeJS.ProcessEnv = process.env,
  fallbackFetch: typeof fetch = fetch,
): typeof fetch {
  const address = env.CODEX_PET_UPSTREAM_RESOLVE_IP?.trim();
  const useFreshAgent = env.CODEX_PET_UPSTREAM_FRESH_AGENT?.trim() === "1";
  if (!address && !useFreshAgent) return fallbackFetch;
  const hostname = new URL(endpoint).hostname.toLowerCase();
  const override = address ? createCodexPetUpstreamDnsOverride(endpoint, address) : null;

  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname.toLowerCase() !== hostname) return fallbackFetch(input, init);

    // A plain Agent matches Node's working default H1 transport while giving
    // each image request an isolated pool. The configured variant remains for
    // deployments that explicitly need fixed DNS or H2.
    const dispatcher = override
      ? new Agent({
          allowH2: codexPetUpstreamAllowH2(env),
          connections: 1,
          maxConcurrentStreams: 1,
          connect: { lookup: override.lookup },
        })
      : new Agent();
    try {
      const response = await fallbackFetch(input, { ...init, dispatcher } as RequestInit);
      const body = await response.arrayBuffer();
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } finally {
      await dispatcher.close();
    }
  }) as typeof fetch;
}
