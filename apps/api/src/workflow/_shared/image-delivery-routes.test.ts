import { Buffer } from "node:buffer";
import type { PrismaClient } from "@prisma/client";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createImageUrlSigner } from "../../storage/cos-image-url.js";
import { imageWorkflowRoutes } from "../image/image-routes.js";
import { imageBlobUrl } from "../image/image-route-helpers.js";
import { portraitBlobUrl, portraitWorkflowRoutes } from "../portrait/portrait-routes.js";
import { tryOnBlobUrl, tryOnWorkflowRoutes } from "../try-on/try-on-routes.js";

const secret = "image-delivery-test-secret-32-characters";
const apps: FastifyInstance[] = [];
const variants = [
  { module: "image", kind: "output", table: "imageAsset", path: "images", filename: undefined },
  {
    module: "portrait",
    kind: "reference",
    table: "portraitReferenceAsset",
    path: "portraits/references",
    filename: undefined,
  },
  {
    module: "portrait",
    kind: "output",
    table: "portraitOutput",
    path: "portraits/outputs",
    filename: "portrait-2.png",
  },
  {
    module: "try-on",
    kind: "reference",
    table: "tryOnReferenceAsset",
    path: "try-ons/references",
    filename: undefined,
  },
  { module: "try-on", kind: "output", table: "tryOnOutput", path: "try-ons/outputs", filename: "try-on-2.png" },
] as const;
type Variant = (typeof variants)[number];

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", secret);
  vi.stubEnv("PORTRAIT_BLOB_SIGNING_SECRET", secret);
  vi.stubEnv("TRY_ON_BLOB_SIGNING_SECRET", secret);
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function setup(variant: Variant, mode: "proxy" | "cos" | "cdn" = "cos") {
  const row = {
    id: "asset-1",
    userId: "u1",
    objectKey: `workflow/${variant.path}/u1/request-1/0.png`,
    mime: "image/png",
    requestIndex: 1,
    deletedAt: null as Date | null,
  };
  const other = { ...row, id: "asset-2", userId: "u2", objectKey: row.objectKey.replace("/u1/", "/u2/") };
  const findUnique = vi.fn(async ({ where }: { where: { id: string } }) =>
    where.id === row.id ? row : where.id === other.id ? other : null,
  );
  const table = { findUnique, findMany: vi.fn(async () => []) };
  const prisma = {
    [variant.table]: table,
    ...(variant.module === "portrait" ? { portraitReferenceAsset: { ...table, findMany: vi.fn(async () => []) } } : {}),
    ...(variant.module === "try-on" ? { tryOnReferenceAsset: { ...table, findMany: vi.fn(async () => []) } } : {}),
  } as unknown as PrismaClient;
  const signImageUrl = vi.fn(
    createImageUrlSigner({
      WORKFLOW_IMAGE_DELIVERY: mode,
      WORKFLOW_IMAGE_CDN_BASE_URL: "https://images.example.com",
      WORKFLOW_IMAGE_CDN_SIGNING_KEY: "0123456789abcdef0123456789abcdef",
      S3_ENDPOINT: "https://cos.ap-guangzhou.myqcloud.com",
      S3_REGION: "ap-guangzhou",
      S3_BUCKET: "test-images-1234567890",
      S3_ACCESS_KEY: "test-secret-id",
      S3_SECRET_KEY: "test-secret-key-not-real",
    }),
  );
  const loadStoredImage = vi.fn(async () => Buffer.from("test-image-bytes"));
  const app = Fastify();
  apps.push(app);
  const deps = { prisma, signImageUrl, loadStoredImage };
  if (variant.module === "image") await app.register(imageWorkflowRoutes, deps);
  else if (variant.module === "portrait") await app.register(portraitWorkflowRoutes, deps);
  else await app.register(tryOnWorkflowRoutes, deps);
  await app.ready();
  const urlFor = () =>
    variant.module === "image"
      ? imageBlobUrl(row.id, row.objectKey)
      : variant.module === "portrait"
        ? portraitBlobUrl(variant.kind, row.id, row.objectKey)
        : tryOnBlobUrl(variant.kind, row.id, row.objectKey);
  return { app, row, findUnique, signImageUrl, loadStoredImage, urlFor };
}

describe.each(variants)("$path signed image delivery", (variant) => {
  it("uses the real CDN signer after authorization without reading bytes", async () => {
    const { app, row, signImageUrl, loadStoredImage, urlFor } = await setup(variant, "cdn");
    const url = urlFor();
    const result = await app.inject({ method: "GET", url });
    expect(result.statusCode).toBe(302);
    const location = new URL(result.headers.location!);
    expect(location.origin).toBe("https://images.example.com");
    expect(location.pathname).toBe(`/${row.objectKey}`);
    expect(location.searchParams.get("sign")).toMatch(/^[a-f0-9]{64}$/);
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(loadStoredImage).not.toHaveBeenCalled();
    signImageUrl.mockClear();
    expect((await app.inject({ url: url.split("?")[0] })).statusCode).not.toBe(302);
    expect(signImageUrl).not.toHaveBeenCalled();
  });

  it("redirects legacy Unicode filenames using the encoded CDN path", async () => {
    const { app, row, loadStoredImage, urlFor } = await setup(variant, "cdn");
    row.objectKey = row.objectKey.replace("0.png", "图片 · 预览.png");
    const result = await app.inject({ url: urlFor() });
    expect(result.statusCode).toBe(302);
    expect(new URL(result.headers.location!).pathname).toBe(
      `/${row.objectKey.split("/").map(encodeURIComponent).join("/")}`,
    );
    expect(loadStoredImage).not.toHaveBeenCalled();
  });

  it("redirects an existing bearer URL without a login cookie or reading image bytes", async () => {
    const { app, row, signImageUrl, loadStoredImage, urlFor } = await setup(variant);
    const url = urlFor();
    const result = await app.inject({ method: "GET", url });
    expect(result.statusCode).toBe(302);
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(result.headers["referrer-policy"]).toBe("no-referrer");
    expect(loadStoredImage).not.toHaveBeenCalled();
    const location = new URL(result.headers.location!);
    expect(location.hostname).toBe("test-images-1234567890.cos.ap-guangzhou.myqcloud.com");
    expect(decodeURIComponent(location.pathname)).toBe(`/${row.objectKey}`);
    expect(location.searchParams.get("response-content-type")).toBe(row.mime);
    expect(location.searchParams.get("response-cache-control")).toBe("private, no-store");
    expect(location.searchParams.get("response-content-disposition")).toBe(
      variant.filename ? `inline; filename="${variant.filename}"` : null,
    );
    const originalExp = Number(new URL(url, "https://api.example.com").searchParams.get("exp"));
    const expiresAt = variant.module === "image" ? originalExp : originalExp * 1000;
    expect(signImageUrl).toHaveBeenCalledWith(expect.objectContaining({ objectKey: row.objectKey, expiresAt }));
    const signedEnd = Number(location.searchParams.get("q-sign-time")!.split(";")[1]) * 1000;
    expect(signedEnd).toBeLessThanOrEqual(expiresAt);
    expect(signedEnd).toBeGreaterThan(Date.now() + 295_000);
    expect(result.rawPayload.length).toBeLessThan(1024);
  });

  it("preserves byte responses, MIME and filenames when disabled", async () => {
    const { app, loadStoredImage, urlFor } = await setup(variant, "proxy");
    const result = await app.inject({ method: "GET", url: urlFor() });
    expect(result.statusCode).toBe(200);
    expect(result.payload).toBe("test-image-bytes");
    expect(result.headers["content-type"]).toBe("image/png");
    expect(result.headers["cache-control"]).toBe("private, max-age=300");
    expect(result.headers["content-disposition"]).toBe(
      variant.filename ? `inline; filename="${variant.filename}"` : undefined,
    );
    expect(result.headers.location).toBeUndefined();
    expect(loadStoredImage).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "tampered", "expired", "other-user-id", "not-found"])(
    "does not sign or load unauthorized requests: %s",
    async (failure) => {
      const { app, signImageUrl, loadStoredImage, urlFor } = await setup(variant);
      const url = new URL(urlFor(), "https://api.example.com");
      if (failure === "missing") url.search = "";
      if (failure === "tampered") url.searchParams.set("sig", "invalid-signature");
      if (failure === "expired") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
      if (failure === "other-user-id") url.pathname = url.pathname.replace("asset-1", "asset-2");
      if (failure === "not-found") url.pathname = url.pathname.replace("asset-1", "missing-asset");
      const result = await app.inject({ method: "GET", url: `${url.pathname}${url.search}` });
      expect([400, 401, 404]).toContain(result.statusCode);
      expect(result.headers.location).toBeUndefined();
      expect(signImageUrl).not.toHaveBeenCalled();
      expect(loadStoredImage).not.toHaveBeenCalled();
    },
  );

  it("does not silently proxy bytes when signing fails", async () => {
    const { app, signImageUrl, loadStoredImage, urlFor } = await setup(variant);
    signImageUrl.mockRejectedValue(new Error("test signing failure"));
    const result = await app.inject({ method: "GET", url: urlFor() });
    expect(result.statusCode).toBe(502);
    expect(result.headers.location).toBeUndefined();
    expect(result.json()).toEqual({ error: "图片加载失败" });
    expect(loadStoredImage).not.toHaveBeenCalled();
  });

  if (variant.module !== "image") {
    it("rejects an object key belonging to another user even with a correctly signed URL", async () => {
      const { app, row, signImageUrl, loadStoredImage, urlFor } = await setup(variant);
      row.objectKey = row.objectKey.replace("/u1/", "/u2/");
      const result = await app.inject({ method: "GET", url: urlFor() });
      expect(result.statusCode).toBe(404);
      expect(signImageUrl).not.toHaveBeenCalled();
      expect(loadStoredImage).not.toHaveBeenCalled();
    });
  }

  if (variant.kind === "reference") {
    it("does not issue a new grant after a reference has been deleted", async () => {
      const { app, row, signImageUrl, loadStoredImage, urlFor } = await setup(variant);
      const url = urlFor();
      row.deletedAt = new Date();
      const result = await app.inject({ method: "GET", url });
      expect(result.statusCode).toBe(404);
      expect(signImageUrl).not.toHaveBeenCalled();
      expect(loadStoredImage).not.toHaveBeenCalled();
    });
  }
});
