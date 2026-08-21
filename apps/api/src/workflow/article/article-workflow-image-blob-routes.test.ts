import { describe, expect, it, vi } from "vitest";
import {
  buildArticleWorkflowApp,
  createArticleWorkflowPrismaMock,
} from "./article-workflow-test-helpers.js";
import {
  articleWorkflowSignedImageBlobUrl,
  ARTICLE_WORKFLOW_IMAGE_BLOB_TTL_MS,
} from "./article-workflow-image-url.js";

const SECRET = "s".repeat(48);

function imageAssetRow(patch: Partial<{
  id: string;
  userId: string;
  objectKey: string | null;
  mime: string;
}> = {}) {
  return {
    id: "asset-1",
    userId: "u1",
    requestId: "article:article-1:cover:req",
    requestIndex: 0,
    prompt: "cover prompt",
    model: "image-model",
    size: "1536x864",
    originalUrl: "data:image/png;base64,ZmFrZQ==",
    thumbnailUrl: "data:image/png;base64,ZmFrZQ==",
    objectKey: "workflow/images/u1/article-1/cover.png",
    mime: "image/png",
    createdAt: new Date("2026-07-08T06:02:00.000Z"),
    ...patch,
  };
}

describe("article-workflow 配图取图", () => {
  it("按 assetId 从对象存储取字节，带上 mime 与私有缓存", async () => {
    const bytes = Buffer.from("fake-png-bytes");
    const loadImageBlob = vi.fn(async () => bytes);
    const { app } = await buildArticleWorkflowApp({
      prisma: createArticleWorkflowPrismaMock({ imageAssets: [imageAssetRow()] }),
      loadImageBlob,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/workflow/article-workflow/images/asset-1/blob",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/png");
    expect(response.headers["cache-control"]).toBe("private, max-age=86400");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.rawPayload.equals(bytes)).toBe(true);
    expect(loadImageBlob).toHaveBeenCalledWith("workflow/images/u1/article-1/cover.png");
  });

  it("别人的配图取不到：查询按 userId 收口，不是先查后比", async () => {
    const loadImageBlob = vi.fn(async () => Buffer.from("nope"));
    const { app } = await buildArticleWorkflowApp({
      prisma: createArticleWorkflowPrismaMock({ imageAssets: [imageAssetRow({ userId: "u2" })] }),
      loadImageBlob,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/workflow/article-workflow/images/asset-1/blob",
    });

    expect(response.statusCode).toBe(404);
    expect(loadImageBlob).not.toHaveBeenCalled();
  });

  it("没上传到对象存储的资产按不存在处理", async () => {
    const { app } = await buildArticleWorkflowApp({
      prisma: createArticleWorkflowPrismaMock({ imageAssets: [imageAssetRow({ objectKey: null })] }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/workflow/article-workflow/images/asset-1/blob",
    });

    expect(response.statusCode).toBe(404);
  });

  it("对象存储读失败回 502，不把内部错误抛给前端", async () => {
    const { app } = await buildArticleWorkflowApp({
      prisma: createArticleWorkflowPrismaMock({ imageAssets: [imageAssetRow()] }),
      loadImageBlob: vi.fn(async () => {
        throw new Error("s3 down");
      }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/workflow/article-workflow/images/asset-1/blob",
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "配图加载失败" });
  });

  it("非 image/* 的 mime 一律按 png 送出，避免拿存储里的值当 content-type 用", async () => {
    const { app } = await buildArticleWorkflowApp({
      prisma: createArticleWorkflowPrismaMock({
        imageAssets: [imageAssetRow({ mime: "text/html" })],
      }),
      loadImageBlob: vi.fn(async () => Buffer.from("fake")),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/workflow/article-workflow/images/asset-1/blob",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/png");
    expect(response.headers["content-type"]).not.toContain("text/html");
  });

  it("带签名的地址不需要会话就能取图——页面里的 <img> 带不上 Authorization 头", async () => {
    const bytes = Buffer.from("fake-png-bytes");
    const { app } = await buildArticleWorkflowApp({
      prisma: createArticleWorkflowPrismaMock({ imageAssets: [imageAssetRow()] }),
      loadImageBlob: vi.fn(async () => bytes),
      envPatch: { SESSION_SECRET: SECRET },
      anonymous: true,
    });

    const response = await app.inject({
      method: "GET",
      url: articleWorkflowSignedImageBlobUrl({
        assetId: "asset-1",
        env: { SESSION_SECRET: SECRET } as unknown as NodeJS.ProcessEnv,
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/png");
    expect(response.rawPayload.equals(bytes)).toBe(true);
  });

  it("签名不对就退回会话鉴权：没有会话时是 401，不是拿签名当通行证", async () => {
    const loadImageBlob = vi.fn(async () => Buffer.from("fake"));
    const { app } = await buildArticleWorkflowApp({
      prisma: createArticleWorkflowPrismaMock({ imageAssets: [imageAssetRow()] }),
      loadImageBlob,
      envPatch: { SESSION_SECRET: SECRET },
      anonymous: true,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/workflow/article-workflow/images/asset-1/blob?exp=9999999999999&sig=forged",
    });

    expect(response.statusCode).toBe(401);
    expect(loadImageBlob).not.toHaveBeenCalled();
  });

  it("签名过期后退回会话鉴权", async () => {
    const loadImageBlob = vi.fn(async () => Buffer.from("fake"));
    const { app } = await buildArticleWorkflowApp({
      prisma: createArticleWorkflowPrismaMock({ imageAssets: [imageAssetRow()] }),
      loadImageBlob,
      envPatch: { SESSION_SECRET: SECRET },
      anonymous: true,
    });
    const expired = articleWorkflowSignedImageBlobUrl({
      assetId: "asset-1",
      env: { SESSION_SECRET: SECRET } as unknown as NodeJS.ProcessEnv,
      nowMs: Date.now() - ARTICLE_WORKFLOW_IMAGE_BLOB_TTL_MS - 1000,
    });

    const response = await app.inject({ method: "GET", url: expired });

    expect(response.statusCode).toBe(401);
    expect(loadImageBlob).not.toHaveBeenCalled();
  });

  it("给 A 签的名取不到 B 的图", async () => {
    const loadImageBlob = vi.fn(async () => Buffer.from("fake"));
    const { app } = await buildArticleWorkflowApp({
      prisma: createArticleWorkflowPrismaMock({
        imageAssets: [imageAssetRow(), imageAssetRow({ id: "asset-2" })],
      }),
      loadImageBlob,
      envPatch: { SESSION_SECRET: SECRET },
      anonymous: true,
    });
    const params = new URL(
      articleWorkflowSignedImageBlobUrl({
        assetId: "asset-1",
        env: { SESSION_SECRET: SECRET } as unknown as NodeJS.ProcessEnv,
      }),
      "http://x.test",
    ).search;

    const response = await app.inject({
      method: "GET",
      url: `/api/workflow/article-workflow/images/asset-2/blob${params}`,
    });

    expect(response.statusCode).toBe(401);
    expect(loadImageBlob).not.toHaveBeenCalled();
  });

  it("images 这一段不会被当成项目 id 吞掉", async () => {
    const { app } = await buildArticleWorkflowApp({
      prisma: createArticleWorkflowPrismaMock({ imageAssets: [imageAssetRow()] }),
      loadImageBlob: vi.fn(async () => Buffer.from("fake")),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/workflow/article-workflow/images/asset-1/blob",
    });

    // 命中项目详情路由的话会是 404 + JSON「项目不存在」
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/png");
  });
});
