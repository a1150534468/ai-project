import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createImageUrlSigner } from "./cos-image-url.js";

const env = {
  WORKFLOW_IMAGE_DELIVERY: "cos",
  S3_ENDPOINT: "https://cos.ap-guangzhou.myqcloud.com",
  S3_REGION: "ap-guangzhou",
  S3_BUCKET: "test-images-1234567890",
  S3_ACCESS_KEY: "test-secret-id",
  S3_SECRET_KEY: "test-secret-key-not-real",
};
const now = 1_800_000_000_000;
const request = {
  objectKey: "workflow/images/u1/request-1/图片 +#?%&.png",
  mime: "image/png",
  expiresAt: now + 900_000,
  contentDisposition: 'inline; filename="portrait-1.png"',
};

afterEach(() => vi.restoreAllMocks());

describe("COS private image URL signing (no cloud requests)", () => {
  it("defaults to proxy without needing any storage configuration", async () => {
    expect(await createImageUrlSigner({})(request)).toBeNull();
    expect(await createImageUrlSigner({ WORKFLOW_IMAGE_DELIVERY: "proxy" })(request)).toBeNull();
  });

  it("signs GET, the exact encoded key, host and response headers using the official SDK", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const url = new URL((await createImageUrlSigner(env)(request))!);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("test-images-1234567890.cos.ap-guangzhou.myqcloud.com");
    expect(decodeURIComponent(url.pathname)).toBe(`/${request.objectKey}`);
    expect(url.searchParams.get("response-content-type")).toBe("image/png");
    expect(url.searchParams.get("response-content-disposition")).toBe(request.contentDisposition);
    expect(url.searchParams.get("response-cache-control")).toBe("private, no-store");
    expect(url.searchParams.get("q-header-list")).toBe("host");
    expect(url.searchParams.get("q-ak")).toBe(env.S3_ACCESS_KEY);
    const [start, end] = url.searchParams.get("q-sign-time")!.split(";").map(Number);
    expect(end! - start!).toBe(300);
    expect(end! * 1000).toBeLessThanOrEqual(now + 300_000);
    expect(end! * 1000).toBeGreaterThan(now + 295_000);

    // Independent recomputation ensures query/host/key are actually signed, not just appended.
    const encode = (value: string) =>
      encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const keys = ["response-cache-control", "response-content-disposition", "response-content-type"];
    expect(url.searchParams.get("q-url-param-list")).toBe(keys.join(";"));
    const query = keys.map((key) => `${key}=${encode(url.searchParams.get(key)!)}`).join("&");
    const httpString = `get\n/${request.objectKey}\n${query}\nhost=${url.hostname}\n`;
    const keyTime = url.searchParams.get("q-key-time")!;
    const signKey = createHmac("sha1", env.S3_SECRET_KEY).update(keyTime).digest("hex");
    const stringToSign = `sha1\n${url.searchParams.get("q-sign-time")}\n${createHash("sha1").update(httpString).digest("hex")}\n`;
    expect(url.searchParams.get("q-signature")).toBe(createHmac("sha1", signKey).update(stringToSign).digest("hex"));
    expect(url.href).not.toContain(env.S3_SECRET_KEY);
  });

  it("caps the grant to the remaining application URL lifetime", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const url = new URL((await createImageUrlSigner(env)({ ...request, expiresAt: now + 12_500 }))!);
    const [start, end] = url.searchParams.get("q-sign-time")!.split(";").map(Number);
    expect(end! - start!).toBe(12);
    expect(end! * 1000).toBeLessThanOrEqual(now + 12_500);
  });

  it.each([now - 1, now, now + 999, now + 1_999, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects expired, near-expiry or invalid expiry %s",
    async (expiresAt) => {
      vi.spyOn(Date, "now").mockReturnValue(now);
      await expect(createImageUrlSigner(env)({ ...request, expiresAt })).rejects.toThrow("expired");
    },
  );

  it.each(["", "/a", "a/../b", "a/./b", "a//b", "a/", "a\\b", "a\nb", "a\x7fb"])(
    "rejects unsafe object key %j",
    async (objectKey) => {
      await expect(createImageUrlSigner(env)({ ...request, objectKey })).rejects.toThrow("object key");
    },
  );

  it.each([
    { S3_ENDPOINT: "http://cos.ap-guangzhou.myqcloud.com" },
    { S3_ENDPOINT: "https://cos.ap-guangzhou.myqcloud.com.attacker.test" },
    { S3_ENDPOINT: "http://localhost:9000" },
    { S3_ENDPOINT: "https://cos.ap-guangzhou.myqcloud.com/prefix" },
    { S3_ENDPOINT: "https://user:pass@cos.ap-guangzhou.myqcloud.com" },
    { S3_ENDPOINT: "https://cos.ap-guangzhou.myqcloud.com?query=1" },
    { S3_ENDPOINT: "https://cos.ap-guangzhou.myqcloud.com:8443" },
    { S3_REGION: "ap-beijing" },
    { S3_BUCKET: "invalid-bucket" },
  ])("fails closed on incompatible COS configuration %j", (override) => {
    expect(() => createImageUrlSigner({ ...env, ...override })).toThrow("standard HTTPS COS");
  });

  it("ignores public URL aliases rather than replacing the signed host", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const sign = createImageUrlSigner({
      ...env,
      S3_ENDPOINT: `https://${env.S3_BUCKET}.cos.ap-guangzhou.myqcloud.com`,
      S3_PUBLIC_BASE_URL: "https://cdn.example.com",
      IMAGE_S3_PUBLIC_BASE_URL: "https://images.example.com",
    });
    expect(new URL((await sign(request))!).hostname).toBe(`${env.S3_BUCKET}.cos.ap-guangzhou.myqcloud.com`);
  });

  it("fails on unknown delivery mode or missing credentials", () => {
    expect(() => createImageUrlSigner({ WORKFLOW_IMAGE_DELIVERY: "unknown" })).toThrow("proxy, cos or cdn");
    expect(() => createImageUrlSigner({ ...env, S3_SECRET_KEY: "" })).toThrow("S3_SECRET_KEY required");
  });

  it("rejects unsafe response headers", async () => {
    const sign = createImageUrlSigner(env);
    await expect(sign({ ...request, mime: "text/html" })).rejects.toThrow("response headers");
    await expect(sign({ ...request, contentDisposition: "inline\r\nX-Injected: 1" })).rejects.toThrow(
      "response headers",
    );
  });

  it("preserves legitimate content type parameters from existing stored images", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const mime = "image/png; charset=utf-8";
    const url = new URL((await createImageUrlSigner(env)({ ...request, mime }))!);
    expect(url.searchParams.get("response-content-type")).toBe(mime);
  });

  it("keeps percent-encoded dot-like names as literal object key characters", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const objectKey = "workflow/images/u1/run/%2e%2e/file.png";
    const url = new URL((await createImageUrlSigner(env)({ ...request, objectKey }))!);
    expect(url.pathname).toContain("%252e%252e");
    expect(decodeURIComponent(url.pathname)).toBe(`/${objectKey}`);
  });
});
