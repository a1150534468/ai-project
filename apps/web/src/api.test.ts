import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeNovelChapter,
  buyMembership,
  generateNovelChapter,
  generateNovelStage,
  getNovelProject,
  getNovelWorkbench,
  getTopupOrder,
  saveNovelChapter,
  saveNovelChapterReview,
} from "./api";

describe("novel workflow API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends target count when generating a novel stage", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: {
        task: {
          id: "task-1",
          projectId: "project-1",
          targetKind: "chars",
          targetId: null,
          status: "queued",
          requestPayload: { prompt: "补充反派", targetCount: 8 },
          error: null,
          createdAt: "2026-07-01T08:00:00.000Z",
          updatedAt: "2026-07-01T08:00:00.000Z",
          completedAt: null,
          cancelledAt: null,
        },
      },
    }), { status: 202 }));

    await generateNovelStage("token", "project-1", "chars", "补充反派", 8);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workflow/novels/projects/project-1/stages/chars/generate",
      expect.objectContaining({
        body: JSON.stringify({ prompt: "补充反派", targetCount: 8 }),
      }),
    );
  });

  it("sends the selected chapter index when generating chapter content", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: {
        task: {
          id: "task-1",
          projectId: "project-1",
          targetKind: "chapter",
          targetId: null,
          status: "queued",
          requestPayload: { chapterIndex: 3, title: "寒泉院", summary: "危机升级", targetChars: 3000 },
          error: null,
          createdAt: "2026-07-01T08:00:00.000Z",
          updatedAt: "2026-07-01T08:00:00.000Z",
          completedAt: null,
          cancelledAt: null,
        },
      },
    }), { status: 202 }));

    await generateNovelChapter("token", "project-1", { chapterIndex: 3, title: "寒泉院", summary: "危机升级", targetChars: 3000 });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workflow/novels/projects/project-1/chapters/generate",
      expect.objectContaining({
        body: JSON.stringify({ chapterIndex: 3, title: "寒泉院", summary: "危机升级", targetChars: 3000 }),
      }),
    );
  });

  it("saves edited chapter content", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: {
        chapter: {
          id: "chapter-1",
          volumeIndex: 1,
          chapterIndex: 1,
          title: "寒泉院",
          summary: "危机升级",
          content: "新正文",
          status: "ready",
          billableChars: 3,
          lastTaskId: "task-old",
          updatedAt: "2026-07-01T08:00:00.000Z",
        },
      },
    }), { status: 200 }));

    await saveNovelChapter("token", "project-1", 1, { title: "寒泉院", summary: "危机升级", content: "新正文" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workflow/novels/projects/project-1/chapters/1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ title: "寒泉院", summary: "危机升级", content: "新正文" }),
      }),
    );
  });

  it("reads generated long-form memory from the draft section", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: {
        project: {
          id: "project-1",
          title: "长夜纪元",
          genre: "玄幻",
          status: "active",
          createdAt: "2026-07-01T08:00:00.000Z",
          updatedAt: "2026-07-01T08:00:00.000Z",
        },
        sections: [{
          id: "section-draft",
          kind: "draft",
          label: "正文",
          status: "ready",
          displayText: "【长篇记忆】\n已记忆至第 2 章。",
          billableChars: 16,
          lastTaskId: "task-2",
          updatedAt: "2026-07-01T08:00:00.000Z",
        }],
        chapters: [],
        tasks: [],
      },
    }), { status: 200 }));

    const detail = await getNovelProject("token", "project-1");

    expect(detail.sections.find((section) => section.kind === "draft")?.displayText).toContain("已记忆至第 2 章");
  });

  it("fetches novel workbench payload", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: {
        project: { id: "project-1", title: "长夜纪元", genre: "玄幻", status: "active", createdAt: "2026-07-01T08:00:00.000Z", updatedAt: "2026-07-01T08:00:00.000Z" },
        stats: { totalWords: 10, finishedChapters: 1, completionRate: 8, averageWords: 10, lastUpdate: "2026-07-01T08:00:00.000Z" },
        chapters: [],
        sections: [],
        knowledgeFacts: [],
        foreshadowItems: [],
        workbenchHighlights: { focusChapterNumber: 2, recommendedFocus: "", dueForeshadowItems: [], continuityAlerts: [], microBeats: [], focusCard: null, qualitySnapshot: { consistencyStatus: "ok", consistencyRisks: [], styleRisk: "low", styleTone: "" }, workflowGate: null },
      },
    }), { status: 200 }));

    await getNovelWorkbench("token", "project-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workflow/novels/projects/project-1/workbench",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("saves novel chapter review", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: { chapter: { id: "chapter-1", chapterIndex: 1, reviewStatus: "approved", reviewNotes: "已改。" } },
    }), { status: 200 }));

    await saveNovelChapterReview("token", "project-1", 1, { status: "approved", reviewNotes: "已改。" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workflow/novels/projects/project-1/chapters/1/review",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ status: "approved", reviewNotes: "已改。" }),
      }),
    );
  });

  it("requests chapter analysis refresh", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: { chapter: { id: "chapter-1", chapterIndex: 1 } },
    }), { status: 200 }));

    await analyzeNovelChapter("token", "project-1", 1);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workflow/novels/projects/project-1/chapters/1/analyze",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("web api billing helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("buyMembership sends the selected payment method", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ payUrl: "http://pay.url", tradeNo: "yc_mem" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await buyMembership("token", 1, "wxpay");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/membership/buy",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ cardId: 1, method: "wxpay" }),
      }),
    );
  });

  it("getTopupOrder reads the current payment order status", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: {
        tradeNo: "yc123",
        userId: "u1",
        amountFen: 10,
        points: 10,
        provider: "epay",
        paymentMethod: "alipay",
        status: "success",
        kind: "points",
        cardId: 0,
        createdAt: "2026-07-02T08:45:36Z",
        paidAt: "2026-07-02T08:45:47Z",
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const order = await getTopupOrder("token", "yc123");

    expect(order.status).toBe("success");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/billing/topup/yc123",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
