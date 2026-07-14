import Fastify from "fastify";
import { InsufficientBalanceError } from "@ai-assistant/billing";
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

function createBillingMock(overrides: Record<string, unknown> = {}) {
  return {
    reserveResource: vi.fn(async () => ({ reserved: 10_000 })),
    settleResource: vi.fn(async () => ({ settled: 10 })),
    refundResource: vi.fn(async () => ({ success: true })),
    ...overrides,
  };
}

async function createApp(options: {
  prisma: PrismaClient;
  billing: ReturnType<typeof createBillingMock>;
  generator?: ReturnType<typeof vi.fn>;
  scheduled?: Promise<void>[];
}) {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (request) => { (request as typeof request & { userId: string }).userId = "user-1"; });
  await app.register(novelWorkflowRoutes, {
    prisma: options.prisma,
    billing: options.billing as never,
    generator: options.generator ?? vi.fn(async () => ({ text: "正文", model: "server-model" })),
    scheduleTask: (work: () => Promise<void>) => options.scheduled?.push(work()),
  });
  return app;
}

describe("PlotPilot novel workflow routes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates a premise-first project and its locked Bible without legacy sections", async () => {
    const state = createPrismaMock();
    const app = await createApp({ prisma: state.prisma, billing: createBillingMock() });
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

  it("runs Bible setup in the worker path and writes five world dimensions plus style notes", async () => {
    const state = createPrismaMock();
    state.rows.projects.push({ id: "project-1", userId: "user-1", title: "寒泉烬", genre: "东方玄幻", premise: "沈氏后人追查家族旧案。", settings: { worldPreset: "宗门世界" }, generationPrefs: {}, narrativeContract: {}, targetChapters: 100, targetCharsPerChapter: 3000, setupStage: 1, setupCompleted: false, storyPhase: "opening", autopilotStatus: "idle", currentBranch: "main", status: "active", createdAt: fixedNow, updatedAt: fixedNow });
    state.rows.bibles.push({ id: "bible-1", projectId: "project-1", premiseLock: "沈氏后人追查家族旧案。", genreLock: "东方玄幻", worldPresetLock: "宗门世界", version: 1, createdAt: fixedNow, updatedAt: fixedNow });
    const generator = vi.fn(async () => ({
      model: "server-model",
      text: JSON.stringify({
        styleGuide: { narrativeVoice: "第三人称限知", sentenceRhythm: "短句推进", dialogue: "潜台词优先", sensory: "触觉优先", avoid: ["空泛抒情"], sample: "雪落在断剑上。" },
        worldbuilding: {
          coreRules: { summary: "灵力守恒", details: ["越阶必付代价"] },
          geography: { summary: "北境宗门群" },
          society: { summary: "宗门与王朝共治" },
          culture: { summary: "血契记名" },
          dailyLife: { summary: "灵票交易" },
        },
      }),
    }));
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma: state.prisma, billing: createBillingMock(), generator, scheduled });
    const response = await app.inject({ method: "POST", url: "/api/workflow/novels/projects/project-1/setup/bible/generate", payload: { prompt: "冷峻克制" } });
    expect(response.statusCode).toBe(202);
    await scheduled[0];
    expect(generator).toHaveBeenCalledWith(expect.objectContaining({ targetKind: "setupBible" }));
    expect(state.rows.worldDimensions).toHaveLength(5);
    expect(state.rows.styleNotes.map((item) => item.title)).toContain("叙事声音");
    expect(state.rows.projects[0].setupStage).toBe(2);
    expect(state.rows.tasks[0].status).toBe("succeeded");
    await app.close();
  });

  it("persists execution plan and micro-beats with an edited chapter", async () => {
    const state = createPrismaMock();
    state.rows.projects.push({ id: "project-1", userId: "user-1", title: "寒泉烬", genre: "东方玄幻", premise: "沈氏后人追查家族旧案。", settings: {}, generationPrefs: {}, narrativeContract: {}, targetChapters: 100, targetCharsPerChapter: 3000, setupStage: 5, setupCompleted: true, storyPhase: "opening", autopilotStatus: "idle", currentBranch: "main", status: "active", createdAt: fixedNow, updatedAt: fixedNow });
    const app = await createApp({ prisma: state.prisma, billing: createBillingMock() });
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

  it("rewrites only the selected prose, snapshots the old chapter, and settles visible output chars", async () => {
    const state = createPrismaMock();
    state.rows.projects.push({ id: "project-1", userId: "user-1", title: "寒泉烬", genre: "东方玄幻", premise: "沈氏后人追查家族旧案。", settings: {}, generationPrefs: {}, narrativeContract: {}, targetChapters: 100, targetCharsPerChapter: 3000, setupStage: 5, setupCompleted: true, storyPhase: "opening", autopilotStatus: "idle", currentBranch: "main", status: "active", createdAt: fixedNow, updatedAt: fixedNow });
    state.rows.chapters.push({ id: "chapter-1", projectId: "project-1", volumeIndex: 1, chapterIndex: 1, title: "寒泉院", summary: "入院", content: "雪夜里，她推开门。风从院中扑来。", rawContent: "雪夜里，她推开门。风从院中扑来。", openThreads: [], reviewStatus: "approved", reviewedAt: fixedNow, billableChars: 16, updatedAt: fixedNow });
    const generator = vi.fn(async () => ({ text: "她用肩膀撞开腐朽的木门", model: "server-model" }));
    const billing = createBillingMock();
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma: state.prisma, billing, generator, scheduled });
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
    expect(billing.settleResource).toHaveBeenCalledWith(expect.objectContaining({ units: 11 }));
    expect(state.rows.tasks[0].status).toBe("succeeded");
    await app.close();
  });

  it("refunds a rewrite instead of overwriting prose that changed while the worker was generating", async () => {
    const state = createPrismaMock();
    state.rows.projects.push({ id: "project-1", userId: "user-1", title: "寒泉烬", genre: "东方玄幻", premise: "沈氏后人追查家族旧案。", settings: {}, generationPrefs: {}, narrativeContract: {}, targetChapters: 100, targetCharsPerChapter: 3000, setupStage: 5, setupCompleted: true, storyPhase: "opening", autopilotStatus: "idle", currentBranch: "main", status: "active", createdAt: fixedNow, updatedAt: fixedNow });
    state.rows.chapters.push({ id: "chapter-1", projectId: "project-1", volumeIndex: 1, chapterIndex: 1, title: "寒泉院", summary: "入院", content: "她推开门。", rawContent: "她推开门。", openThreads: [], reviewStatus: "pending", reviewedAt: null, billableChars: 5, updatedAt: fixedNow });
    let finishGeneration: ((value: { text: string; model: string }) => void) | undefined;
    const generator = vi.fn(() => new Promise<{ text: string; model: string }>((resolve) => { finishGeneration = resolve; }));
    const billing = createBillingMock();
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma: state.prisma, billing, generator, scheduled });
    const response = await app.inject({ method: "POST", url: "/api/workflow/novels/projects/project-1/chapters/1/rewrite", payload: { selectedText: "她推开门", selectionStart: 0, selectionEnd: 4, instruction: "增强动作" } });
    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => expect(generator).toHaveBeenCalledOnce());
    state.rows.chapters[0].content = "作者已经重写了整段。";
    finishGeneration?.({ text: "她撞开门", model: "server-model" });
    await scheduled[0];
    expect(state.rows.chapters[0].content).toBe("作者已经重写了整段。");
    expect(state.rows.versions).toHaveLength(0);
    expect(state.rows.tasks[0]).toMatchObject({ status: "failed", error: "章节正文已变化，请重新选择需要改写的内容" });
    expect(billing.refundResource).toHaveBeenCalledWith(state.rows.tasks[0].operationId);
    await app.close();
  });

  it("does not expose the removed eight-stage API", async () => {
    const state = createPrismaMock();
    const app = await createApp({ prisma: state.prisma, billing: createBillingMock() });
    const response = await app.inject({ method: "POST", url: "/api/workflow/novels/projects/project-1/stages/world/generate", payload: {} });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns 402 before creating a generation task when balance is insufficient", async () => {
    const state = createPrismaMock();
    state.rows.projects.push({ id: "project-1", userId: "user-1", title: "寒泉烬", genre: "东方玄幻", premise: "沈氏后人追查家族旧案。", settings: {}, setupCompleted: false, status: "active", createdAt: fixedNow, updatedAt: fixedNow });
    const billing = createBillingMock({ reserveResource: vi.fn(async () => { throw new InsufficientBalanceError(); }) });
    const app = await createApp({ prisma: state.prisma, billing });
    const response = await app.inject({ method: "POST", url: "/api/workflow/novels/projects/project-1/setup/characters/generate", payload: {} });
    expect(response.statusCode).toBe(402);
    expect(state.rows.tasks).toHaveLength(0);
    await app.close();
  });
});
