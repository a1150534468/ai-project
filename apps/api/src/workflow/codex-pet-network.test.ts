import type { LookupFunction } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { codexPetUpstreamAllowH2, createCodexPetUpstreamDnsOverride, createCodexPetUpstreamFetch } from "./codex-pet-network.js";

describe("Codex pet upstream DNS override", () => {
  it("keeps h2 by default and permits an explicit fresh h1 transport", () => {
    expect(codexPetUpstreamAllowH2({})).toBe(true);
    expect(codexPetUpstreamAllowH2({ CODEX_PET_UPSTREAM_ALLOW_H2: "1" })).toBe(true);
    expect(codexPetUpstreamAllowH2({ CODEX_PET_UPSTREAM_ALLOW_H2: "0" })).toBe(false);
  });

  it("overrides only the configured endpoint hostname", async () => {
    const fallback = vi.fn<LookupFunction>((_hostname, _options, callback) => callback(null, "127.0.0.1", 4));
    const override = createCodexPetUpstreamDnsOverride(
      "https://api.ai-pixel.online/v1/images/generations",
      "159.195.12.14",
      fallback,
    );

    const matching = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      override.lookup("api.ai-pixel.online", { all: false }, (error, address, family) => {
        if (error || typeof address !== "string") reject(error ?? new Error("missing address"));
        else resolve({ address, family: family ?? 0 });
      });
    });
    expect(matching).toEqual({ address: "159.195.12.14", family: 4 });
    expect(fallback).not.toHaveBeenCalled();

    await new Promise<void>((resolve, reject) => {
      override.lookup("localhost", { all: false }, (error) => error ? reject(error) : resolve());
    });
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("returns an address list when the caller requests all results", async () => {
    const override = createCodexPetUpstreamDnsOverride(
      "https://api.ai-pixel.online/v1/images/generations",
      "159.195.12.14",
    );
    const addresses = await new Promise<unknown>((resolve, reject) => {
      override.lookup("API.AI-PIXEL.ONLINE", { all: true }, (error, result) => error ? reject(error) : resolve(result));
    });
    expect(addresses).toEqual([{ address: "159.195.12.14", family: 4 }]);
  });

  it("rejects non-IP override values before installing a dispatcher", () => {
    expect(() => createCodexPetUpstreamDnsOverride(
      "https://api.ai-pixel.online/v1/images/generations",
      "proxy.invalid",
    )).toThrow("must be a literal IPv4 or IPv6 address");
  });

  it("uses an isolated dispatcher for the configured Pixel host", async () => {
    const fallback = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(init).toHaveProperty("dispatcher");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "request-1" },
      });
    }) as unknown as typeof fetch;
    const isolatedFetch = createCodexPetUpstreamFetch(
      "https://api.ai-pixel.online/v1/images/generations",
      { CODEX_PET_UPSTREAM_RESOLVE_IP: "159.195.12.14" },
      fallback,
    );

    const response = await isolatedFetch("https://api.ai-pixel.online/v1/images/edits", { method: "POST" });

    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("x-request-id")).toBe("request-1");
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("uses a plain fresh dispatcher instead of reusing a stale Pixel socket", async () => {
    const fallback = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(init).toHaveProperty("dispatcher");
      expect(new Headers(init?.headers).get("connection")).toBeNull();
      return new Response("ok");
    }) as unknown as typeof fetch;
    const isolatedFetch = createCodexPetUpstreamFetch(
      "https://speed.ai-pixel.online/v1/images/generations",
      { CODEX_PET_UPSTREAM_FRESH_AGENT: "1" },
      fallback,
    );

    await expect(isolatedFetch("https://speed.ai-pixel.online/v1/images/edits", {
      method: "POST",
      headers: { authorization: "Bearer test" },
    }).then((response) => response.text())).resolves.toBe("ok");
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("delegates other hosts without attaching the Pixel dispatcher", async () => {
    const fallback = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;
    const isolatedFetch = createCodexPetUpstreamFetch(
      "https://api.ai-pixel.online/v1/images/generations",
      { CODEX_PET_UPSTREAM_RESOLVE_IP: "159.195.12.14" },
      fallback,
    );

    await expect(isolatedFetch("https://cdn.example.test/image.png")).resolves.toBeInstanceOf(Response);
    expect(fallback).toHaveBeenCalledWith("https://cdn.example.test/image.png", undefined);
  });
});
