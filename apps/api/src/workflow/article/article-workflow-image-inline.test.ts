import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 对象存储整体替身：配上 S3 后走的是「上传 + 代理地址」这条路，
 * 这里只需要 putObject 不炸、loadS3Config 能过校验。
 */
const putObject = vi.fn(async () => undefined);

vi.mock("../../storage/s3.js", () => ({
  putObject,
  putObjectFile: vi.fn(async () => undefined),
  getObject: vi.fn(async () => Buffer.from("stored-bytes")),
  deleteObject: vi.fn(async () => undefined),
  listObjects: vi.fn(async () => []),
  makeS3: vi.fn(() => ({ client: {}, bucket: "test-bucket" })),
  loadS3Config: vi.fn(() => ({
    endpoint: "http://localhost:9000",
    region: "us-east-1",
    bucket: "test-bucket",
    accessKey: "key",
    secretKey: "secret",
    forcePathStyle: true,
  })),
  publicObjectUrl: vi.fn(() => "http://localhost:9000/test-bucket/key"),
}));

const { buildArticleWorkflowApp } = await import("./article-workflow-test-helpers.js");

/** 生成链路真实产出的那种大图：本体够大，混进正文一眼能看出来 */
const FAKE_PNG_B64 = Buffer.alloc(4096, 7).toString("base64");

describe("配图字节不进正文", () => {
  beforeEach(() => {
    putObject.mockClear();
  });

  it("配了对象存储时，正文与 manifest 里都是代理地址，没有 base64", async () => {
    let scheduledTask: (() => Promise<void>) | null = null;
    const { app, prisma } = await buildArticleWorkflowApp({
      scheduleTask: (work) => {
        scheduledTask = work;
      },
      fetchFn: (vi.fn(async () => new Response(JSON.stringify({
        data: [{ b64_json: FAKE_PNG_B64, mime_type: "image/png" }],
      }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/article-workflow",
      payload: {
        sourceFormat: "plain-text",
        sourceText: "开头第一段。\n\n第二段继续说明。",
        generationMode: "preserve-text",
      },
    });
    expect(response.statusCode).toBe(201);
    await scheduledTask!();

    const row = prisma.__state.projects[0]!;
    expect(row.status).toBe("ready");

    // 这条是本次线上事故的回归点：正文里出现 base64 就是 10MB 起的行
    expect(row.bodyHtml).not.toContain("data:image");
    expect(row.bodyHtml).not.toContain(FAKE_PNG_B64.slice(0, 64));
    expect(row.bodyHtml).toContain("/api/workflow/article-workflow/images/");
    expect(row.bodyHtml.length).toBeLessThan(4096);

    const manifest = JSON.stringify(row.imageManifestJson);
    expect(manifest).not.toContain("data:image");
    expect(manifest).toContain("/api/workflow/article-workflow/images/");

    // 字节确实进了对象存储，而不是被丢掉
    expect(putObject).toHaveBeenCalled();
  });

  it("代理地址指向真实的 assetId，取图路由能按它取到字节", async () => {
    let scheduledTask: (() => Promise<void>) | null = null;
    const { app, prisma } = await buildArticleWorkflowApp({
      scheduleTask: (work) => {
        scheduledTask = work;
      },
      loadImageBlob: vi.fn(async () => Buffer.from("stored-bytes")),
      fetchFn: (vi.fn(async () => new Response(JSON.stringify({
        data: [{ b64_json: FAKE_PNG_B64, mime_type: "image/png" }],
      }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch),
    });

    await app.inject({
      method: "POST",
      url: "/api/workflow/article-workflow",
      payload: {
        sourceFormat: "plain-text",
        sourceText: "开头第一段。\n\n第二段继续说明。",
        generationMode: "preserve-text",
      },
    });
    await scheduledTask!();

    const row = prisma.__state.projects[0]!;
    const assetIds = prisma.__state.imageAssets.map((asset) => asset.id);
    expect(assetIds.length).toBeGreaterThan(0);
    for (const assetId of assetIds) {
      expect(row.bodyHtml).toContain(`/api/workflow/article-workflow/images/${assetId}/blob`);
      const blob = await app.inject({
        method: "GET",
        url: `/api/workflow/article-workflow/images/${assetId}/blob`,
      });
      expect(blob.statusCode).toBe(200);
      expect(blob.headers["content-type"]).toContain("image/png");
    }
  });

  /**
   * 页面能不能显示出图，全看这条：库里存稳定地址、出参给签名地址、保存再还原回稳定地址。
   * 少了任何一环，要么页面碎图（`<img>` 带不上登录态），要么库里存下一批会过期的死链。
   */
  it("库里存稳定地址，详情出参是签名地址，保存后库里还是稳定地址", async () => {
    let scheduledTask: (() => Promise<void>) | null = null;
    const { app, prisma } = await buildArticleWorkflowApp({
      envPatch: { SESSION_SECRET: "e".repeat(48) },
      scheduleTask: (work) => {
        scheduledTask = work;
      },
      loadImageBlob: vi.fn(async () => Buffer.from("stored-bytes")),
      fetchFn: (vi.fn(async () => new Response(JSON.stringify({
        data: [{ b64_json: FAKE_PNG_B64, mime_type: "image/png" }],
      }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch),
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/workflow/article-workflow",
      payload: {
        sourceFormat: "plain-text",
        sourceText: "开头第一段。\n\n第二段继续说明。",
        generationMode: "preserve-text",
      },
    });
    await scheduledTask!();
    const projectId = created.json().data.projectId as string;

    const stored = prisma.__state.projects[0]!;
    expect(stored.bodyHtml).toContain("/blob\"");
    expect(stored.bodyHtml).not.toContain("sig=");

    const detail = await app.inject({ method: "GET", url: `/api/workflow/article-workflow/${projectId}` });
    expect(detail.statusCode).toBe(200);
    const served = detail.json().data.bodyHtml as string;
    expect(served).toContain("&amp;sig=");
    expect(served).not.toContain("&sig=");
    expect(detail.json().data.imageManifestJson[0].imageUrl).toContain("sig=");

    // 出参地址不带登录态也能取到图——这就是页面上 <img> 的处境
    const src = /<img[^>]+src="([^"]+)"/.exec(served)?.[1]?.replace(/&amp;/g, "&");
    expect(src).toBeTruthy();
    const anonymous = await buildArticleWorkflowApp({
      envPatch: { SESSION_SECRET: "e".repeat(48) },
      anonymous: true,
      prisma,
      loadImageBlob: vi.fn(async () => Buffer.from("stored-bytes")),
    });
    const blob = await anonymous.app.inject({ method: "GET", url: src! });
    expect(blob.statusCode).toBe(200);
    expect(blob.headers["content-type"]).toContain("image/png");

    // 编辑器把带签名的正文原样回传，落库必须还原成稳定地址
    const saved = await app.inject({
      method: "PATCH",
      url: `/api/workflow/article-workflow/${projectId}`,
      payload: { title: stored.title, summary: stored.summary, bodyHtml: served },
    });
    expect(saved.statusCode).toBe(200);
    expect(prisma.__state.projects[0]!.bodyHtml).not.toContain("sig=");
    expect(prisma.__state.projects[0]!.bodyHtml).toContain("/blob\"");
  });
});
