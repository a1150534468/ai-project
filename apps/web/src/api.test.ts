import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeNovelChapter,
  generateNovelChapter,
  generateNovelSetup,
  getNovelProject,
  getNovelWorkbench,
  rewriteNovelChapterSelection,
  saveNovelChapter,
  saveNovelChapterReview,
} from "./api";

describe("novel workflow API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a setup generation command to the novel worker", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: {
        task: {
          id: "task-1",
          projectId: "project-1",
          targetKind: "setupCharacters",
          targetId: null,
          status: "queued",
          requestPayload: { prompt: "补充反派" },
          error: null,
          createdAt: "2026-07-01T08:00:00.000Z",
          updatedAt: "2026-07-01T08:00:00.000Z",
          completedAt: null,
          cancelledAt: null,
        },
      },
    }), { status: 202 }));

    await generateNovelSetup("token", "project-1", "characters", "补充反派");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workflow/novels/projects/project-1/setup/characters/generate",
      expect.objectContaining({
        body: JSON.stringify({ prompt: "补充反派" }),
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

  it("submits an exact prose selection for worker-backed local rewrite", async () => {
    const task = { id: "task-rewrite", projectId: "project-1", targetKind: "chapterRewrite", targetId: "chapter-1", status: "queued", requestPayload: {}, error: null, createdAt: "", updatedAt: "", completedAt: null, cancelledAt: null };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { task } }), { status: 202 }));
    const payload = { selectedText: "她推开门", selectionStart: 4, selectionEnd: 8, instruction: "增强动作张力" };

    await rewriteNovelChapterSelection("token", "project-1", 3, payload);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workflow/novels/projects/project-1/chapters/3/rewrite",
      expect.objectContaining({ method: "POST", body: JSON.stringify(payload) }),
    );
  });

  it("reads the locked story Bible from project detail", async () => {
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
        bible: { id: "bible-1", premiseLock: "长夜将尽", genreLock: "玄幻", worldPresetLock: "", version: 1, worldDimensions: [], styleNotes: [], updatedAt: "2026-07-01T08:00:00.000Z" },
        chapters: [],
        tasks: [],
      },
    }), { status: 200 }));

    const detail = await getNovelProject("token", "project-1");

    expect(detail.bible?.premiseLock).toContain("长夜将尽");
  });

  it("fetches novel workbench payload", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: {
        project: { id: "project-1", title: "长夜纪元", genre: "玄幻", status: "active", createdAt: "2026-07-01T08:00:00.000Z", updatedAt: "2026-07-01T08:00:00.000Z" },
        stats: { totalWords: 10, finishedChapters: 1, completionRate: 8, averageWords: 10, lastUpdate: "2026-07-01T08:00:00.000Z" },
        chapters: [],
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
