import Fastify from "fastify";
import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { novelWorkflowRoutes } from "./novel-routes.js";

const fixedNow = new Date("2026-07-14T08:00:00.000Z");

function createPrismaMock() {
  const projects: any[] = [];
  const bibles: any[] = [];
  const worldDimensions: any[] = [];
  const styleNotes: any[] = [];
  const chapters: any[] = [];
  const versions: any[] = [];
  const tasks: any[] = [];

  const prisma: any = {
    novelProject: {
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: `project-${projects.length + 1}`,
          userId: data.userId,
          title: data.title,
          genre: data.genre,
          premise: data.premise,
          settings: data.settings,
          generationPrefs: {},
          narrativeContract: {},
          targetChapters: data.targetChapters,
          targetCharsPerChapter: data.targetCharsPerChapter,
          setupStage: data.setupStage,
          setupCompleted: data.setupCompleted,
          storyPhase: "opening",
          autopilotStatus: "idle",
          currentBranch: "main",
          status: "active",
          createdAt: fixedNow,
          updatedAt: fixedNow,
        };
        projects.push(row);
        if (data.bible?.create) bibles.push({ id: `bible-${bibles.length + 1}`, projectId: row.id, version: 1, createdAt: fixedNow, updatedAt: fixedNow, ...data.bible.create });
        return row;
      }),
      findFirst: vi.fn(async ({ where, include }: any) => {
        const row = projects.find((item) => item.id === where.id && item.userId === where.userId);
        if (!row || !include) return row ?? null;
        return { ...row, tasks: tasks.filter((item) => item.projectId === row.id), bible: bibles.find((item) => item.projectId === row.id) ?? null };
      }),
      findUnique: vi.fn(async ({ where }: any) => projects.find((item) => item.id === where.id) ?? null),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => {
        const row = projects.find((item) => item.id === where.id);
        if (!row) throw new Error("project not found");
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = projects.find((item) => item.id === where.id);
        if (!row) throw new Error("project not found");
        Object.assign(row, data, { updatedAt: fixedNow });
        return row;
      }),
    },
    novelBible: {
      findUnique: vi.fn(async ({ where }: any) => {
        const bible = bibles.find((item) => item.projectId === where.projectId);
        return bible ? {
          ...bible,
          worldDimensions: worldDimensions.filter((item) => item.projectId === where.projectId),
          styleNotes: styleNotes.filter((item) => item.projectId === where.projectId),
        } : null;
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        let bible = bibles.find((item) => item.projectId === where.projectId);
        if (!bible) {
          bible = { id: `bible-${bibles.length + 1}`, projectId: where.projectId, version: 1, createdAt: fixedNow, updatedAt: fixedNow, ...create };
          bibles.push(bible);
        } else {
          Object.assign(bible, update, { version: bible.version + 1, updatedAt: fixedNow });
        }
        return bible;
      }),
    },
    novelWorldDimension: {
      deleteMany: vi.fn(async ({ where }: any) => {
        const kept = worldDimensions.filter((item) => item.projectId !== where.projectId);
        const count = worldDimensions.length - kept.length;
        worldDimensions.splice(0, worldDimensions.length, ...kept);
        return { count };
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `world-${worldDimensions.length + 1}`, createdAt: fixedNow, updatedAt: fixedNow, ...data };
        worldDimensions.push(row);
        return row;
      }),
    },
    novelStyleNote: {
      deleteMany: vi.fn(async ({ where }: any) => {
        const kept = styleNotes.filter((item) => item.projectId !== where.projectId);
        const count = styleNotes.length - kept.length;
        styleNotes.splice(0, styleNotes.length, ...kept);
        return { count };
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `style-${styleNotes.length + 1}`, createdAt: fixedNow, updatedAt: fixedNow, ...data };
        styleNotes.push(row);
        return row;
      }),
    },
    novelChapter: {
      findMany: vi.fn(async ({ where }: any) => chapters.filter((item) => item.projectId === where.projectId).sort((a, b) => a.chapterIndex - b.chapterIndex)),
      findFirst: vi.fn(async ({ where }: any) => chapters.filter((item) => item.projectId === where.projectId).sort((a, b) => b.chapterIndex - a.chapterIndex)[0] ?? null),
      findUnique: vi.fn(async ({ where }: any) => {
        const key = where.projectId_chapterIndex;
        return chapters.find((item) => item.projectId === key.projectId && item.chapterIndex === key.chapterIndex) ?? null;
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const key = where.projectId_chapterIndex;
        let row = chapters.find((item) => item.projectId === key.projectId && item.chapterIndex === key.chapterIndex);
        if (!row) {
          row = {
            id: `chapter-${chapters.length + 1}`,
            projectId: key.projectId,
            volumeIndex: 1,
            chapterIndex: key.chapterIndex,
            title: "",
            summary: "",
            outline: "",
            generationHint: "",
            executionPlan: null,
            microBeats: [],
            content: "",
            rawContent: "",
            openThreads: [],
            contextSnapshot: null,
            generationMeta: null,
            consistencyJson: null,
            status: "draft",
            reviewStatus: "pending",
            reviewNotes: "",
            aiReview: "",
            aiActionItems: [],
            modificationRate: 0,
            reviewedAt: null,
            billableChars: 0,
            lastTaskId: null,
            createdAt: fixedNow,
            updatedAt: fixedNow,
            ...create,
          };
          chapters.push(row);
        } else {
          Object.assign(row, update, { updatedAt: fixedNow });
        }
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = chapters.find((item) => item.id === where.id);
        if (!row) throw new Error("chapter not found");
        Object.assign(row, data, { updatedAt: fixedNow });
        return row;
      }),
    },
    novelChapterVersion: {
      create: vi.fn(async ({ data }: any) => { const row = { id: `version-${versions.length + 1}`, createdAt: fixedNow, operationId: null, ...data }; versions.push(row); return row; }),
      findMany: vi.fn(async ({ where }: any) => versions.filter((item) => item.chapterId === where.chapterId)),
      findFirst: vi.fn(async ({ where }: any) => versions.find((item) => item.id === where.id && item.chapterId === where.chapterId) ?? null),
    },
    novelTask: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `task-${tasks.length + 1}`, error: null, resultPayload: null, completedAt: null, cancelledAt: null, createdAt: fixedNow, updatedAt: fixedNow, ...data };
        tasks.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: any) => tasks.find((item) => item.id === where.id) ?? null),
      findFirst: vi.fn(async ({ where }: any) => tasks.find((item) => (!where.projectId || item.projectId === where.projectId) && (!where.targetKind || item.targetKind === where.targetKind) && (!where.id || item.id === where.id)) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const row = tasks.find((item) => item.id === where.id);
        if (!row) throw new Error("task not found");
        Object.assign(row, data, { updatedAt: fixedNow });
        return row;
      }),
    },
    novelPromptTemplate: { findUnique: vi.fn(async () => null) },
    $queryRawUnsafe: vi.fn(async () => []),
    $executeRawUnsafe: vi.fn(async () => 0),
  };
  prisma.$transaction = vi.fn(async (input: ((tx: any) => Promise<unknown>) | Promise<unknown>[]) => Array.isArray(input) ? Promise.all(input) : input(prisma));
  return { prisma: prisma as PrismaClient, rows: { projects, bibles, worldDimensions, styleNotes, chapters, versions, tasks } };
}

async function createApp(options: {
  prisma: PrismaClient;
  generator?: ReturnType<typeof vi.fn>;
  scheduled?: Promise<void>[];
  userId?: string;
}) {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (request) => { request.userId = options.userId ?? "user-1"; });
  await app.register(novelWorkflowRoutes, {
    prisma: options.prisma,
    generator: options.generator ?? vi.fn(async () => ({ text: "正文", model: "server-model" })),
    scheduleTask: (work: () => Promise<void>) => options.scheduled?.push(work()),
  });
  return app;
}

describe("PlotPilot novel workflow routes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("serves a compact directory and loads one owned chapter on demand", async () => {
    const state = createPrismaMock();
    const app = await createApp({ prisma: state.prisma });
    const created = await app.inject({ method: "POST", url: "/api/workflow/novels/projects", payload: { title: "减量测试", premise: "一部用于验证长篇小说传输体积的作品。" } });
    const id = created.json().data.project.id;
    for (let index = 1; index <= 34; index += 1) {
      state.rows.chapters.push({ id: `c-${index}`, projectId: id, chapterIndex: index, volumeIndex: 1, title: `第${index}章`, summary: "摘要", content: "正文".repeat(1500), rawContent: "原文".repeat(1500), contextSnapshot: { source: "上下文".repeat(5000) }, generationMeta: { trace: "内部".repeat(1000) }, status: "draft", billableChars: 3000, qualityScore: 88, tensionScore: 70, lastTaskId: null, updatedAt: fixedNow });
    }
    Object.assign(state.prisma, {
      novelStoryline: { findMany: vi.fn(async () => []) },
      novelCharacter: { findMany: vi.fn(async () => []) },
      novelLocation: { findMany: vi.fn(async () => []) },
    });
    const fullWorkbench = await app.inject({ url: `/api/workflow/novels/projects/${id}/workbench` });
    const compactWorkbench = await app.inject({ url: `/api/workflow/novels/projects/${id}/workbench?view=compact` });
    expect(compactWorkbench.statusCode).toBe(200);
    expect(compactWorkbench.json().data.chapters).toEqual([]);
    expect(compactWorkbench.json().data.stats).toEqual(fullWorkbench.json().data.stats);
    expect(compactWorkbench.json().data.stats.finishedChapters).toBe(34);
    expect(compactWorkbench.json().data.workbenchHighlights).toEqual(fullWorkbench.json().data.workbenchHighlights);
    expect(Buffer.byteLength(compactWorkbench.body)).toBeLessThan(Buffer.byteLength(fullWorkbench.body) * 0.05);
    const full = await app.inject({ url: `/api/workflow/novels/projects/${id}` });
    const compact = await app.inject({ url: `/api/workflow/novels/projects/${id}?view=compact` });
    expect(compact.statusCode).toBe(200);
    const first = compact.json().data.chapters[0];
    expect(first).toMatchObject({ detailLoaded: false, hasContent: true, wordCount: 3000, qualityScore: 88 });
    for (const key of ["content", "rawContent", "contextSnapshot", "generationMeta"]) expect(first).not.toHaveProperty(key);
    expect(Buffer.byteLength(compact.body)).toBeLessThan(Buffer.byteLength(full.body) * 0.05);
    const chapter = await app.inject({ url: `/api/workflow/novels/projects/${id}/chapters/2` });
    expect(chapter.json().data.chapter).toMatchObject({ id: "c-2", content: state.rows.chapters[1].content, rawContent: state.rows.chapters[1].rawContent, contextSnapshot: state.rows.chapters[1].contextSnapshot, qualityScore: 88 });
    expect((await app.inject({ url: `/api/workflow/novels/projects/${id}/chapters/999` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/workflow/novels/projects/${id}/chapters/not-a-number` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/workflow/novels/projects/${id}?view=invalid` })).statusCode).toBe(400);
    console.info("NOVEL_PAYLOAD_BYTES", JSON.stringify({ full: Buffer.byteLength(full.body), compact: Buffer.byteLength(compact.body), singleChapter: Buffer.byteLength(chapter.body), fullWorkbench: Buffer.byteLength(fullWorkbench.body), compactWorkbench: Buffer.byteLength(compactWorkbench.body) }));
    await app.close();
    const stranger = await createApp({ prisma: state.prisma, userId: "other-user" });
    expect((await stranger.inject({ url: `/api/workflow/novels/projects/${id}?view=compact` })).statusCode).toBe(404);
    expect((await stranger.inject({ url: `/api/workflow/novels/projects/${id}/chapters/2` })).statusCode).toBe(404);
    await stranger.close();
    const anonymous = await createApp({ prisma: state.prisma, userId: "" });
    expect((await anonymous.inject({ url: `/api/workflow/novels/projects/${id}/chapters/2` })).statusCode).toBe(401);
    await anonymous.close();
  });

  it("creates a premise-first project and its locked Bible without legacy sections", async () => {
    const state = createPrismaMock();
    const app = await createApp({ prisma: state.prisma });
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/novels/projects",
      payload: {
        title: "寒泉烬",
        premise: "沈氏后人困于废院，循着锁灵坠追查家族覆灭真相。",
        genre: "东方玄幻",
        worldPreset: "宗门与王朝并立",
        targetChapters: 120,
        targetCharsPerChapter: 3200,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.project).toMatchObject({ setupStage: 1, setupCompleted: false, targetChapters: 120 });
    expect(response.json().data.bible).toMatchObject({ premiseLock: "沈氏后人困于废院，循着锁灵坠追查家族覆灭真相。", worldPresetLock: "宗门与王朝并立" });
    expect(response.json().data.sections).toBeUndefined();
    expect((state.prisma as any).novelSection).toBeUndefined();
    await app.close();
  });

  it("stores the chosen writing model in generation prefs", async () => {
    const state = createPrismaMock();
    state.rows.projects.push({ id: "project-1", userId: "user-1", title: "寒泉烬", genre: "东方玄幻", premise: "沈氏后人追查家族旧案。", settings: {}, generationPrefs: { temperature: 0.7 }, narrativeContract: {}, targetChapters: 100, targetCharsPerChapter: 3000, setupStage: 5, setupCompleted: true, storyPhase: "opening", autopilotStatus: "idle", currentBranch: "main", status: "active", createdAt: fixedNow, updatedAt: fixedNow });
    const app = await createApp({ prisma: state.prisma });

    const selected = await app.inject({ method: "PATCH", url: "/api/workflow/novels/projects/project-1", payload: { writingModel: "qwen3.7-plus" } });
    expect(selected.statusCode).toBe(200);
    expect(selected.json().data.project.generationPrefs).toEqual({ temperature: 0.7, writingModel: "qwen3.7-plus" });
    await app.close();
  });

  it("runs Bible setup in the worker path and writes five world dimensions plus style notes", async () => {
    const state = createPrismaMock();
    state.rows.projects.push({ id: "project-1", userId: "user-1", title: "寒泉烬", genre: "东方玄幻", premise: "沈氏后人追查家族旧案。", settings: { worldPreset: "宗门世界" }, generationPrefs: {}, narrativeContract: {}, targetChapters: 100, targetCharsPerChapter: 3000, setupStage: 1, setupCompleted: false, storyPhase: "opening", autopilotStatus: "idle", currentBranch: "main", status: "active", createdAt: fixedNow, updatedAt: fixedNow });
    state.rows.bibles.push({ id: "bible-1", projectId: "project-1", premiseLock: "沈氏后人追查家族旧案。", genreLock: "东方玄幻", worldPresetLock: "宗门世界", version: 1, createdAt: fixedNow, updatedAt: fixedNow });
    let progressDuringStream: Record<string, unknown> | undefined;
    const generatedText = JSON.stringify({
        styleGuide: { narrativeVoice: "第三人称限知", sentenceRhythm: "短句推进", dialogue: "潜台词优先", sensory: "触觉优先", avoid: ["空泛抒情"], sample: "雪落在断剑上。" },
        worldbuilding: {
          coreRules: { summary: "灵力守恒", details: ["越阶必付代价"] },
          geography: { summary: "北境宗门群" },
          society: { summary: "宗门与王朝共治" },
          culture: { summary: "血契记名" },
          dailyLife: { summary: "灵票交易" },
        },
      });
    const generator = vi.fn(async (input: any) => {
      await input.onChunk?.(generatedText);
      progressDuringStream = { ...state.rows.tasks[0] };
      return { model: "server-model", text: generatedText };
    });
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma: state.prisma, generator, scheduled });
    const modelSwitch = await app.inject({ method: "PATCH", url: "/api/workflow/novels/projects/project-1", payload: { writingModel: "qwen3.7-plus" } });
    expect(modelSwitch.statusCode).toBe(200);
    const response = await app.inject({ method: "POST", url: "/api/workflow/novels/projects/project-1/setup/bible/generate", payload: { prompt: "冷峻克制" } });
    expect(response.statusCode).toBe(202);
    await scheduled[0];
    expect(generator).toHaveBeenCalledWith(expect.objectContaining({ targetKind: "setupBible", modelOverride: "qwen3.7-plus" }));
    expect(state.rows.worldDimensions).toHaveLength(5);
    expect(state.rows.styleNotes.map((item) => item.title)).toContain("叙事声音");
    expect(state.rows.projects[0].setupStage).toBe(2);
    expect(progressDuringStream).toMatchObject({ progressStage: "streaming", streamedChars: generatedText.length });
    expect(Number(progressDuringStream?.progressPercent)).toBeGreaterThan(35);
    expect(state.rows.tasks[0].status).toBe("succeeded");
    expect(state.rows.tasks[0]).toMatchObject({ progressPercent: 100, progressStage: "completed" });
    await app.close();
  });

  it("persists execution plan and micro-beats with an edited chapter", async () => {
    const state = createPrismaMock();
    state.rows.projects.push({ id: "project-1", userId: "user-1", title: "寒泉烬", genre: "东方玄幻", premise: "沈氏后人追查家族旧案。", settings: {}, generationPrefs: {}, narrativeContract: {}, targetChapters: 100, targetCharsPerChapter: 3000, setupStage: 5, setupCompleted: true, storyPhase: "opening", autopilotStatus: "idle", currentBranch: "main", status: "active", createdAt: fixedNow, updatedAt: fixedNow });
    const app = await createApp({ prisma: state.prisma });
    const response = await app.inject({
      method: "PUT",
      url: "/api/workflow/novels/projects/project-1/chapters/1",
      payload: { title: "寒泉院", summary: "发现锁灵坠", outline: "危机中取得线索", generationHint: "结尾留钩子", executionPlan: { mission: "活下去" }, microBeats: [{ label: "落位" }], content: "雪夜里，她推开了门。" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.chapter).toMatchObject({ outline: "危机中取得线索", generationHint: "结尾留钩子", executionPlan: { mission: "活下去" }, microBeats: [{ label: "落位" }] });
    const versions = await app.inject({ method: "GET", url: "/api/workflow/novels/projects/project-1/chapters/1/versions" });
    expect(versions.statusCode).toBe(200);
    expect(versions.json().data.versions).toHaveLength(1);
    await app.close();
  });

  it("rewrites only the selected prose, snapshots the old chapter, and records visible output chars", async () => {
    const state = createPrismaMock();
    state.rows.projects.push({ id: "project-1", userId: "user-1", title: "寒泉烬", genre: "东方玄幻", premise: "沈氏后人追查家族旧案。", settings: {}, generationPrefs: {}, narrativeContract: {}, targetChapters: 100, targetCharsPerChapter: 3000, setupStage: 5, setupCompleted: true, storyPhase: "opening", autopilotStatus: "idle", currentBranch: "main", status: "active", createdAt: fixedNow, updatedAt: fixedNow });
    state.rows.chapters.push({ id: "chapter-1", projectId: "project-1", volumeIndex: 1, chapterIndex: 1, title: "寒泉院", summary: "入院", content: "雪夜里，她推开门。风从院中扑来。", rawContent: "雪夜里，她推开门。风从院中扑来。", openThreads: [], reviewStatus: "approved", reviewedAt: fixedNow, billableChars: 16, updatedAt: fixedNow });
    const generator = vi.fn(async () => ({ text: "她用肩膀撞开腐朽的木门", model: "server-model" }));
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma: state.prisma, generator, scheduled });
    const content = state.rows.chapters[0].content as string;
    const selectedText = "她推开门";
    const selectionStart = content.indexOf(selectedText);
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/novels/projects/project-1/chapters/1/rewrite",
      payload: { selectedText, selectionStart, selectionEnd: selectionStart + selectedText.length, instruction: "增强动作张力" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().data.task).toMatchObject({ targetKind: "chapterRewrite", targetId: "chapter-1", status: "queued" });
    await scheduled[0];
    expect(generator).toHaveBeenCalledWith(expect.objectContaining({ targetKind: "chapterRewrite", chapterSummary: selectedText, userPrompt: "增强动作张力", contextText: expect.stringContaining("选区后文：\n。风从院中扑来。") }));
    expect(state.rows.chapters[0].content).toBe("雪夜里，她用肩膀撞开腐朽的木门。风从院中扑来。");
    expect(state.rows.chapters[0]).toMatchObject({ reviewStatus: "pending", reviewedAt: null, lastTaskId: "task-1" });
    expect(state.rows.versions).toHaveLength(1);
    expect(state.rows.versions[0].content).toBe(content);
    expect(state.rows.tasks[0].status).toBe("succeeded");
    expect(state.rows.tasks[0].resultPayload).toMatchObject({ billableChars: 11 });
    await app.close();
  });

  it("fails a rewrite instead of overwriting prose that changed while the worker was generating", async () => {
    const state = createPrismaMock();
    state.rows.projects.push({ id: "project-1", userId: "user-1", title: "寒泉烬", genre: "东方玄幻", premise: "沈氏后人追查家族旧案。", settings: {}, generationPrefs: {}, narrativeContract: {}, targetChapters: 100, targetCharsPerChapter: 3000, setupStage: 5, setupCompleted: true, storyPhase: "opening", autopilotStatus: "idle", currentBranch: "main", status: "active", createdAt: fixedNow, updatedAt: fixedNow });
    state.rows.chapters.push({ id: "chapter-1", projectId: "project-1", volumeIndex: 1, chapterIndex: 1, title: "寒泉院", summary: "入院", content: "她推开门。", rawContent: "她推开门。", openThreads: [], reviewStatus: "pending", reviewedAt: null, billableChars: 5, updatedAt: fixedNow });
    let finishGeneration: ((value: { text: string; model: string }) => void) | undefined;
    const generator = vi.fn(() => new Promise<{ text: string; model: string }>((resolve) => { finishGeneration = resolve; }));
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma: state.prisma, generator, scheduled });
    const response = await app.inject({ method: "POST", url: "/api/workflow/novels/projects/project-1/chapters/1/rewrite", payload: { selectedText: "她推开门", selectionStart: 0, selectionEnd: 4, instruction: "增强动作" } });
    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => expect(generator).toHaveBeenCalledOnce());
    state.rows.chapters[0].content = "作者已经重写了整段。";
    finishGeneration?.({ text: "她撞开门", model: "server-model" });
    await scheduled[0];
    expect(state.rows.chapters[0].content).toBe("作者已经重写了整段。");
    expect(state.rows.versions).toHaveLength(0);
    expect(state.rows.tasks[0]).toMatchObject({ status: "failed", error: "章节正文已变化，请重新选择需要改写的内容" });
    await app.close();
  });

  it("does not expose the removed eight-stage API", async () => {
    const state = createPrismaMock();
    const app = await createApp({ prisma: state.prisma });
    const response = await app.inject({ method: "POST", url: "/api/workflow/novels/projects/project-1/stages/world/generate", payload: {} });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  /**
   * P1.1 把这 17 个路由的内联 401 守卫换成了插件级 requireUser preHandler。
   * 本文件此前 401 断言数为 0 —— 守卫删掉也是全绿。这条钉住它。
   */
  it("未登录时返回 401，且不碰数据库", async () => {
    const state = createPrismaMock();
    const app = await createApp({ prisma: state.prisma, userId: "" });
    const cases = [
      { method: "GET" as const, url: "/api/workflow/novels/projects" },
      { method: "POST" as const, url: "/api/workflow/novels/projects" },
      { method: "GET" as const, url: "/api/workflow/novels/projects/project-1" },
      { method: "PATCH" as const, url: "/api/workflow/novels/projects/project-1" },
      { method: "DELETE" as const, url: "/api/workflow/novels/projects/project-1" },
      { method: "POST" as const, url: "/api/workflow/novels/projects/project-1/chapters/generate" },
      { method: "POST" as const, url: "/api/workflow/novels/projects/project-1/setup/characters/generate" },
      { method: "POST" as const, url: "/api/workflow/novels/tasks/task-1/cancel" },
    ];
    for (const one of cases) {
      const response = await app.inject({ ...one, payload: {} });
      expect(response.statusCode, `${one.method} ${one.url}`).toBe(401);
      expect(response.json(), `${one.method} ${one.url}`).toEqual({ error: "未登录" });
    }
    expect(state.rows.tasks).toHaveLength(0);
    await app.close();
  });
});
