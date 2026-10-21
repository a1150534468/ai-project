/**
 * 轻量状态端点（批次轮询专用）：只回状态行不带正文，鉴权与归属校验与全量接口一致。
 */
import { describe, expect, it } from "vitest";
import {
  buildArticleWorkflowApp,
  createArticleWorkflowPrismaMock,
  type ArticleProjectRowSeed,
} from "./article-workflow-test-helpers.js";

const NOW = new Date("2026-07-08T06:00:00.000Z");
const BIG_BODY = `<p>${"正文".repeat(5000)}</p>`;

function seed(overrides: Partial<ArticleProjectRowSeed> & { id: string }): ArticleProjectRowSeed {
  return {
    userId: "u1",
    sourceFormat: "plain-text",
    sourceText: "原文",
    batchId: "batch-1",
    bodyHtml: BIG_BODY,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("article-workflow 轻量状态端点", () => {
  it("批次状态只回状态行：无正文字段，响应体远小于全量", async () => {
    const prisma = createArticleWorkflowPrismaMock({
      projects: [
        seed({ id: "a1", platform: "wechat", status: "generating" }),
        seed({ id: "a2", platform: "xiaohongshu", status: "ready", error: "配图上游 429" }),
      ],
    });
    const { app } = await buildArticleWorkflowApp({ prisma });
    const response = await app.inject({ method: "GET", url: "/api/workflow/article-workflow/batch/batch-1/status" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      data: { batchId: string; projects: Record<string, unknown>[] };
    };
    expect(body.success).toBe(true);
    expect(body.data.projects).toHaveLength(2);
    expect(body.data.projects[0]).toEqual({
      id: "a1",
      platform: "wechat",
      status: "generating",
      error: null,
      updatedAt: NOW.toISOString(),
    });
    expect(body.data.projects[1]?.error).toBe("配图上游 429");
    expect(response.body).not.toContain("bodyHtml");
    expect(response.body.length).toBeLessThan(1024);
    await app.close();
  });

  it("他人批次 → 404；不存在的批次 → 404", async () => {
    const prisma = createArticleWorkflowPrismaMock({
      projects: [seed({ id: "a1", userId: "someone-else" })],
    });
    const { app } = await buildArticleWorkflowApp({ prisma });
    const foreign = await app.inject({ method: "GET", url: "/api/workflow/article-workflow/batch/batch-1/status" });
    expect(foreign.statusCode).toBe(404);
    const missing = await app.inject({ method: "GET", url: "/api/workflow/article-workflow/batch/nope/status" });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("未登录 → 401", async () => {
    const prisma = createArticleWorkflowPrismaMock({ projects: [seed({ id: "a1" })] });
    const { app } = await buildArticleWorkflowApp({ prisma, anonymous: true });
    const response = await app.inject({ method: "GET", url: "/api/workflow/article-workflow/batch/batch-1/status" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("单项目状态：本人可读、他人 404，同样不带正文", async () => {
    const prisma = createArticleWorkflowPrismaMock({
      projects: [
        seed({ id: "a1", status: "failed", error: "403 model denied", batchId: null }),
        seed({ id: "a2", userId: "someone-else", batchId: null }),
      ],
    });
    const { app } = await buildArticleWorkflowApp({ prisma });
    const own = await app.inject({ method: "GET", url: "/api/workflow/article-workflow/a1/status" });
    expect(own.statusCode).toBe(200);
    expect(own.json().data).toEqual({
      id: "a1",
      platform: "wechat",
      status: "failed",
      error: "403 model denied",
      updatedAt: NOW.toISOString(),
    });
    expect(own.body).not.toContain("bodyHtml");
    const foreign = await app.inject({ method: "GET", url: "/api/workflow/article-workflow/a2/status" });
    expect(foreign.statusCode).toBe(404);
    await app.close();
  });
});
