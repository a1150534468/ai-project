import { describe, expect, it } from "vitest";
import type { ArticleWorkflowProjectSummary } from "../../workflowArticleApi";
import {
  articleWorkflowBatchProgress,
  groupArticleWorkflowHistory,
  resolveActiveArticleWorkflowProject,
  shortPlatformLabel,
} from "./articleWorkflowBatchModel";
import { articleWorkflowDraftHash } from "./articleWorkflowStudioModel";

function summary(overrides: Partial<ArticleWorkflowProjectSummary> & { id: string }): ArticleWorkflowProjectSummary {
  return {
    title: "标题",
    summary: "摘要",
    generationMode: "polish-text",
    creationMode: "source",
    platform: "wechat",
    batchId: null,
    status: "ready",
    progressStage: "ready",
    progressPercent: 100,
    progressMessage: null,
    error: null,
    createdAt: "2026-07-08T05:00:00.000Z",
    updatedAt: "2026-07-08T05:00:00.000Z",
    ...overrides,
  };
}

describe("articleWorkflowBatchModel", () => {
  it("groups three platforms of one import into a single entry", () => {
    const entries = groupArticleWorkflowHistory([
      summary({ id: "p-2", platform: "xiaohongshu", batchId: "b-1", title: "小红书标题" }),
      summary({ id: "p-1", platform: "wechat", batchId: "b-1", title: "公众号标题" }),
      summary({ id: "p-3", platform: "douyin", batchId: "b-1", title: "抖音标题" }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.platforms).toEqual(["wechat", "xiaohongshu", "douyin"]);
    // 标题优选公众号行
    expect(entries[0]?.title).toBe("公众号标题");
    expect(entries[0]?.projectId).toBe("p-1");
    expect(entries[0]?.status).toBe("ready");
  });

  it("keeps legacy rows without a batch id as separate entries", () => {
    const entries = groupArticleWorkflowHistory([
      summary({ id: "p-1", title: "老项目一", updatedAt: "2026-07-08T05:00:00.000Z" }),
      summary({ id: "p-2", title: "老项目二", updatedAt: "2026-07-08T06:00:00.000Z" }),
    ]);

    expect(entries.map((entry) => entry.key)).toEqual(["project:p-2", "project:p-1"]);
    expect(entries.every((entry) => entry.batchId === null)).toBe(true);
  });

  it("reports busy when any platform in the batch is still generating", () => {
    const entries = groupArticleWorkflowHistory([
      summary({ id: "p-1", platform: "wechat", batchId: "b-1", status: "ready" }),
      summary({ id: "p-2", platform: "xiaohongshu", batchId: "b-1", status: "generating" }),
      summary({ id: "p-3", platform: "douyin", batchId: "b-1", status: "failed" }),
    ]);

    expect(entries[0]?.status).toBe("busy");
  });

  it("reports failed when no platform is busy but some did not finish", () => {
    const entries = groupArticleWorkflowHistory([
      summary({ id: "p-1", platform: "wechat", batchId: "b-1", status: "ready" }),
      summary({ id: "p-2", platform: "xiaohongshu", batchId: "b-1", status: "failed" }),
    ]);

    expect(entries[0]?.status).toBe("failed");
    // 标题行跳过空标题，公众号行仍优先
    expect(entries[0]?.projectId).toBe("p-1");
  });

  it("falls back to a ready row when the batch has no wechat platform", () => {
    const entries = groupArticleWorkflowHistory([
      summary({ id: "p-1", platform: "xiaohongshu", batchId: "b-1", title: "", status: "generating" }),
      summary({ id: "p-2", platform: "douyin", batchId: "b-1", title: "抖音标题", status: "ready" }),
    ]);

    expect(entries[0]?.title).toBe("抖音标题");
    expect(entries[0]?.projectId).toBe("p-2");
  });

  it("sorts entries by the newest row in each batch", () => {
    const entries = groupArticleWorkflowHistory([
      summary({ id: "p-1", batchId: "b-1", updatedAt: "2026-07-08T05:00:00.000Z" }),
      summary({
        id: "p-2",
        platform: "xiaohongshu",
        batchId: "b-1",
        updatedAt: "2026-07-08T09:00:00.000Z",
      }),
      summary({ id: "p-9", batchId: "b-2", updatedAt: "2026-07-08T07:00:00.000Z" }),
    ]);

    expect(entries.map((entry) => entry.batchId)).toEqual(["b-1", "b-2"]);
    expect(entries[0]?.updatedAt).toBe("2026-07-08T09:00:00.000Z");
  });

  it("counts batch progress by finished platforms", () => {
    expect(articleWorkflowBatchProgress([
      summary({ id: "p-1", status: "ready" }),
      summary({ id: "p-2", status: "generating" }),
      summary({ id: "p-3", status: "failed" }),
    ])).toEqual({ completed: 2, total: 3, percent: 67 });
    expect(articleWorkflowBatchProgress([])).toEqual({ completed: 0, total: 0, percent: 0 });
  });

  it("picks the active project by platform, then any ready one", () => {
    const projects = [
      { ...summary({ id: "p-1", platform: "wechat", status: "generating" }), creationConfig: { mode: "source" as const, generateImages: true }, sourceFormat: "plain-text" as const, sourceText: "", bodyHtml: "", captionText: "", tags: [], imageManifestJson: [] },
      { ...summary({ id: "p-2", platform: "xiaohongshu", status: "ready" }), creationConfig: { mode: "source" as const, generateImages: true }, sourceFormat: "plain-text" as const, sourceText: "", bodyHtml: "", captionText: "", tags: [], imageManifestJson: [] },
    ];

    expect(resolveActiveArticleWorkflowProject(projects, "wechat")?.id).toBe("p-1");
    expect(resolveActiveArticleWorkflowProject(projects, null)?.id).toBe("p-2");
    expect(resolveActiveArticleWorkflowProject([], "wechat")).toBeNull();
  });

  it("shortens platform labels for tabs", () => {
    expect(shortPlatformLabel("wechat")).toBe("公众号");
    expect(shortPlatformLabel("xiaohongshu")).toBe("小红书");
    expect(shortPlatformLabel("douyin")).toBe("抖音");
  });

  it("makes the draft hash sensitive to caption text and tags", () => {
    const base = { title: "标题", summary: "摘要", bodyHtml: "" };
    const withCaption = articleWorkflowDraftHash({ ...base, captionText: "文案", tags: ["咖啡"] });

    expect(articleWorkflowDraftHash(base)).not.toBe(withCaption);
    expect(articleWorkflowDraftHash({ ...base, captionText: "文案", tags: ["咖啡", "居家"] }))
      .not.toBe(withCaption);
    // 只是空白差异不算改动
    expect(articleWorkflowDraftHash({ ...base, captionText: " 文案 ", tags: [" 咖啡 "] }))
      .toBe(withCaption);
  });

  it("配图地址上的短期签名不算内容改动", () => {
    const bodyOf = (query: string) => '<h1>标题</h1><section data-ai-assistant-image-slot="hero">'
      + `<img src="/api/workflow/article-workflow/images/a1/blob${query}" alt="封面" />`
      + "</section><p>正文</p>";
    const base = { title: "标题", summary: "摘要" };

    const stable = articleWorkflowDraftHash({ ...base, bodyHtml: bodyOf("") });
    // 服务端每次出参都换一份签名，编辑器不能因此认为用户改了东西
    expect(articleWorkflowDraftHash({ ...base, bodyHtml: bodyOf("?exp=1&sig=aaa") })).toBe(stable);
    expect(articleWorkflowDraftHash({ ...base, bodyHtml: bodyOf("?exp=2&sig=bbb") })).toBe(stable);
    expect(articleWorkflowDraftHash({ ...base, bodyHtml: bodyOf("?exp=1&amp;sig=aaa") })).toBe(stable);
    // 换了 assetId 就是真改动
    expect(articleWorkflowDraftHash({
      ...base,
      bodyHtml: bodyOf("").replace("/a1/", "/a2/"),
    })).not.toBe(stable);
  });
});
