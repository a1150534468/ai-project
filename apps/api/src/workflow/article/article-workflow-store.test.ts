import { describe, expect, it } from "vitest";
import { articleProjectRow, createArticleWorkflowPrismaMock } from "./article-workflow-test-helpers.js";
import {
  ArticleWorkflowLeaseLostError,
  updateArticleWorkflowProjectState,
  writeArticleWorkflowRunState,
} from "./article-workflow-store.js";

const version = new Date("2026-07-08T05:00:00.000Z");

function store() {
  const prisma = createArticleWorkflowPrismaMock({
    projects: [articleProjectRow({
      id: "p-1",
      userId: "u1",
      sourceFormat: "plain-text",
      sourceText: "正文",
      status: "generating",
      updatedAt: version,
      createdAt: version,
    })],
  });
  return { prisma, row: prisma.__state.projects[0]! };
}

describe("article workflow state CAS", () => {
  it("只在状态与版本都匹配时写入，并返回新版本", async () => {
    const { prisma, row } = store();

    const updated = await updateArticleWorkflowProjectState(prisma as never, "p-1", {
      progressStage: "drafting",
      progressPercent: 12,
    }, { statuses: ["generating"], updatedAt: version });

    expect(updated?.progressStage).toBe("drafting");
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(version.getTime());
    expect(row.progressPercent).toBe(12);
  });

  it("旧版本不能覆盖新任务，即使状态又回到同一值", async () => {
    const { prisma, row } = store();
    const current = await writeArticleWorkflowRunState(prisma as never, "p-1", version, { progressStage: "first" });

    row.status = "revising";
    row.status = "generating";
    await expect(writeArticleWorkflowRunState(prisma as never, "p-1", version, { progressStage: "stale" }))
      .rejects.toBeInstanceOf(ArticleWorkflowLeaseLostError);
    expect(row.progressStage).toBe("first");
    expect(current.getTime()).toBe(row.updatedAt.getTime());
  });

  it("无版本 guard 仍支持读写层的普通条件更新", async () => {
    const { prisma } = store();

    const updated = await updateArticleWorkflowProjectState(prisma as never, "p-1", {
      tags: [],
      imageManifestJson: [],
    });

    expect(updated?.tagsJson).toEqual([]);
    expect(updated?.imageManifestJson).toEqual([]);
  });
});
