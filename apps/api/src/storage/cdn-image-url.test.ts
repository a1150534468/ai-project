import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createImageUrlSigner } from "./cos-image-url.js";

const now = 1_800_000_000_000;
const env = {
  WORKFLOW_IMAGE_DELIVERY: "cdn",
  WORKFLOW_IMAGE_CDN_BASE_URL: "https://images.example.com",
  WORKFLOW_IMAGE_CDN_SIGNING_KEY: "0123456789abcdef0123456789abcdef",
};
const request = {
  objectKey: "workflow/images/u1/run-1/0.png",
  mime: "image/png",
  expiresAt: now + 900_000,
  contentDisposition: 'inline; filename="image.png"',
};
afterEach(() => vi.restoreAllMocks());

function verifyEdge(url: URL, nowSeconds: number): boolean {
  const timestamp = url.searchParams.get("t")!;
  const expected = createHash("sha256")
    .update(env.WORKFLOW_IMAGE_CDN_SIGNING_KEY + url.pathname + timestamp)
    .digest("hex");
  return url.searchParams.get("sign") === expected && Number(timestamp) + 300 >= nowSeconds;
}

describe("CDN TypeD SHA256 image signing (local, no cloud credentials)", () => {
  it("matches a Python hashlib known-answer vector and signs only path + time", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const url = new URL((await createImageUrlSigner(env)(request))!);
    expect(url.origin).toBe(env.WORKFLOW_IMAGE_CDN_BASE_URL);
    expect(url.pathname).toBe(`/${request.objectKey}`);
    expect(url.searchParams.get("t")).toBe("1799999999");
    expect(url.searchParams.get("sign")).toBe("fca2427321ff4b763f201a75669fbc81fd3b31cb2ab2423a3f7c9b2b1608f19c");
    expect([...url.searchParams.keys()]).toEqual(["sign", "t"]);
    expect(url.href).not.toContain(env.WORKFLOW_IMAGE_CDN_SIGNING_KEY);
    expect(verifyEdge(url, now / 1_000)).toBe(true);
    expect(verifyEdge(url, now / 1_000 + 300)).toBe(false);
    url.pathname = url.pathname.replace("u1", "u2");
    expect(verifyEdge(url, now / 1_000)).toBe(false);
  });

  it.each([2_000, 12_500, 60_000, 300_000, 900_000])("caps the edge grant to app expiry +%s ms", async (remaining) => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const url = new URL((await createImageUrlSigner(env)({ ...request, expiresAt: now + remaining }))!);
    const end = (Number(url.searchParams.get("t")) + 300) * 1_000;
    expect(end).toBeLessThan(now + remaining);
    expect(end).toBeLessThanOrEqual(now + 300_000);
    expect(verifyEdge(url, now / 1_000)).toBe(true);
    expect(verifyEdge(url, Math.ceil((now + remaining) / 1_000))).toBe(false);
  });

  it.each([now - 1, now, now + 1_999, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects bad expiry %s",
    async (expiresAt) => {
      vi.spyOn(Date, "now").mockReturnValue(now);
      await expect(createImageUrlSigner(env)({ ...request, expiresAt })).rejects.toThrow("expired");
    },
  );

  it.each(["", "/a", "a//b", "a/../b", "a/./b", "a/", "a\\b", "a\nb"])("rejects unsafe key %j", async (objectKey) => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    await expect(createImageUrlSigner(env)({ ...request, objectKey })).rejects.toThrow("object key");
  });

  it.each(["workflow/a?b.png", "workflow/a#b.png", "workflow/%2e%2e/a.png", "workflow/a%20b.png", "workflow/\ud800.png"])(
    "preserves proxy for unsupported legacy key %j",
    async (objectKey) => {
      vi.spyOn(Date, "now").mockReturnValue(now);
      expect(await createImageUrlSigner(env)({ ...request, objectKey })).toBeNull();
    },
  );

  it.each([
    ["workflow/图片.png", "/workflow/%E5%9B%BE%E7%89%87.png"],
    ["workflow/a b.webp", "/workflow/a%20b.webp"],
    ["workflow/最终 · 预览.webp", "/workflow/%E6%9C%80%E7%BB%88%20%C2%B7%20%E9%A2%84%E8%A7%88.webp"],
    ["workflow/e\u0301.png", "/workflow/e%CC%81.png"],
    ["workflow/é.png", "/workflow/%C3%A9.png"],
  ])("signs the exact encoded path without normalizing %j", async (objectKey, path) => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const url = new URL((await createImageUrlSigner(env)({ ...request, objectKey }))!);
    expect(url.pathname).toBe(path);
    expect(decodeURIComponent(url.pathname)).toBe(`/${objectKey}`);
    expect(verifyEdge(url, now / 1_000)).toBe(true);
    expect([...url.searchParams.keys()]).toEqual(["sign", "t"]);
  });

  it("keeps non-raster and attachment responses on proxy, rejects injected headers", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const sign = createImageUrlSigner(env);
    expect(await sign({ ...request, mime: "image/svg+xml" })).toBeNull();
    expect(await sign({ ...request, contentDisposition: 'attachment; filename="a.png"' })).toBeNull();
    await expect(sign({ ...request, mime: "text/html" })).rejects.toThrow("headers");
    await expect(sign({ ...request, contentDisposition: "inline\r\nX-Evil: 1" })).rejects.toThrow("headers");
  });

  it.each([
    "",
    "http://images.example.com",
    "https://images.example.com/path",
    "https://images.example.com?key=1",
    "https://images.example.com/#hash",
    "https://user:secret@images.example.com",
    "https://images.example.com:8443",
    "https://127.0.0.1",
  ])("rejects invalid CDN origin %j", (base) => {
    expect(() => createImageUrlSigner({ ...env, WORKFLOW_IMAGE_CDN_BASE_URL: base })).toThrow(
      "WORKFLOW_IMAGE_CDN_BASE_URL",
    );
  });

  it.each(["", "short", "x".repeat(33), "a".repeat(31) + "!", " " + "a".repeat(32)])(
    "fails closed on invalid signing key (#%#)",
    (key) => {
      expect(() => createImageUrlSigner({ ...env, WORKFLOW_IMAGE_CDN_SIGNING_KEY: key })).toThrow(
        "WORKFLOW_IMAGE_CDN_SIGNING_KEY",
      );
    },
  );

  it("never needs CDN settings when proxy mode is selected", async () => {
    expect(
      await createImageUrlSigner({ ...env, WORKFLOW_IMAGE_DELIVERY: "proxy", WORKFLOW_IMAGE_CDN_SIGNING_KEY: "" })(
        request,
      ),
    ).toBeNull();
  });

  it.each([6, 31, 32])("accepts a Tencent-supported %s-character key without changing it", async (length) => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const key = "a".repeat(length);
    const sign = createImageUrlSigner({ ...env, WORKFLOW_IMAGE_CDN_SIGNING_KEY: key });
    const url = new URL((await sign(request))!);
    expect(url.searchParams.get("sign")).toBe(
      createHash("sha256").update(key + url.pathname + url.searchParams.get("t")).digest("hex"),
    );
  });
});
