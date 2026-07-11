import Fastify from "fastify";
import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InsufficientBalanceError } from "@yc/billing";
import type { NovelGenerator } from "./novel-generation.js";
import { novelWorkflowRoutes } from "./novel-routes.js";

interface ProjectRow {
  id: string;
  userId: string;
  title: string;
  genre: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

interface SectionRow {
  id: string;
  projectId: string;
  kind: string;
  status: string;
  displayText: string;
  structuredJson: unknown;
  billableChars: number;
  lastTaskId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ChapterRow {
  id: string;
  projectId: string;
  volumeIndex: number;
  chapterIndex: number;
  title: string;
  summary: string;
  content: string;
  rawContent?: string;
  openThreads?: unknown;
  contextSnapshot?: unknown;
  generationMeta?: unknown;
  consistencyJson?: unknown;
  status: string;
  reviewStatus?: string;
  reviewNotes?: string;
  aiReview?: string;
  aiActionItems?: unknown;
  modificationRate?: number;
  reviewedAt?: Date | null;
  billableChars: number;
  lastTaskId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface TaskRow {
  id: string;
  projectId: string;
  userId: string;
  kind: string;
  targetKind: string;
  targetId: string | null;
  status: string;
  requestPayload: unknown;
  resultPayload: unknown;
  operationId: string;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
}

interface NovelVectorMemoryRow {
  id: string;
  projectId: string;
  sourceType: string;
  sourceId: string;
  sourceKind: string;
  title: string;
  content: string;
  contentHash: string;
  embedding: number[];
  createdAt: Date;
  updatedAt: Date;
}

interface KnowledgeFactRow {
  id: string;
  projectId: string;
  chapterId: string | null;
  chapterIndex: number | null;
  subject: string;
  predicate: string;
  object: string;
  sourceExcerpt: string;
  confidence: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

interface ForeshadowRow {
  id: string;
  projectId: string;
  introducedInChapterId: string | null;
  introducedInChapterIndex: number | null;
  title: string;
  description: string;
  expectedPayoffChapter: number;
  status: string;
  relatedCharacter: string;
  createdAt: Date;
  updatedAt: Date;
}

function now(): Date {
  return new Date("2026-07-01T08:00:00.000Z");
}

function createPrismaMock(seedProjects: ProjectRow[] = []) {
  const projects: ProjectRow[] = [...seedProjects];
  const sections: SectionRow[] = [];
  const chapters: ChapterRow[] = [];
  const tasks: TaskRow[] = [];
  const vectorMemories: NovelVectorMemoryRow[] = [];
  const knowledgeFacts: KnowledgeFactRow[] = [];
  const foreshadowItems: ForeshadowRow[] = [];
  const db: any = {
    novelProject: {
      create: vi.fn(async (args: { data: { userId: string; title: string; genre: string } }) => {
        const row = { ...args.data, id: `project-${projects.length + 1}`, status: "active", createdAt: now(), updatedAt: now() };
        projects.push(row);
        return row;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Partial<ProjectRow> }) => {
        const row = projects.find((item) => item.id === args.where.id);
        if (!row) throw new Error("project not found");
        Object.assign(row, args.data, { updatedAt: now() });
        return row;
      }),
      findMany: vi.fn(async (args: { where: { userId: string } }) =>
        projects.filter((project) => project.userId === args.where.userId)
      ),
      findFirst: vi.fn(async (args: { where: { id?: string; userId?: string }; include?: unknown }) => {
        const project = projects.find((row) =>
          (!args.where.id || row.id === args.where.id) &&
          (!args.where.userId || row.userId === args.where.userId)
        );
        if (!project) return null;
        if (!args.include) return project;
        return {
          ...project,
          sections: sections.filter((row) => row.projectId === project.id),
          chapters: chapters.filter((row) => row.projectId === project.id).sort((a, b) => a.chapterIndex - b.chapterIndex),
          tasks: tasks.filter((row) => row.projectId === project.id).slice(0, 20),
        };
      }),
      findUnique: vi.fn(async (args: { where: { id: string } }) =>
        projects.find((row) => row.id === args.where.id) ?? null
      ),
    },
    novelSection: {
      upsert: vi.fn(async (args: { where: { projectId_kind: { projectId: string; kind: string } }; create: Partial<SectionRow>; update: Partial<SectionRow> }) => {
        const key = args.where.projectId_kind;
        let row = sections.find((item) => item.projectId === key.projectId && item.kind === key.kind);
        if (!row) {
          row = {
            id: `section-${sections.length + 1}`,
            projectId: key.projectId,
            kind: key.kind,
            status: "empty",
            displayText: "",
            structuredJson: null,
            billableChars: 0,
            lastTaskId: null,
            createdAt: now(),
            updatedAt: now(),
            ...args.create,
          } as SectionRow;
          sections.push(row);
        } else {
          Object.assign(row, args.update, { updatedAt: now() });
        }
        return row;
      }),
      findMany: vi.fn(async (args: { where: { projectId: string } }) =>
        sections.filter((row) => row.projectId === args.where.projectId)
      ),
    },
    novelSectionVersion: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "section-version-1", ...args.data })),
    },
    novelChapter: {
      create: vi.fn(async (args: { data: Partial<ChapterRow> }) => {
        const row = {
          id: `chapter-${chapters.length + 1}`,
          projectId: "",
          volumeIndex: 1,
          chapterIndex: chapters.length + 1,
          title: "",
          summary: "",
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
          createdAt: now(),
          updatedAt: now(),
          ...args.data,
        } as ChapterRow;
        chapters.push(row);
        return row;
      }),
      findMany: vi.fn(async (args: { where: { projectId: string }; orderBy?: { chapterIndex?: "asc" | "desc" }; take?: number }) => {
        const rows = chapters.filter((row) => row.projectId === args.where.projectId);
        const ordered = args.orderBy?.chapterIndex === "desc"
          ? rows.sort((a, b) => b.chapterIndex - a.chapterIndex)
          : rows.sort((a, b) => a.chapterIndex - b.chapterIndex);
        return typeof args.take === "number" ? ordered.slice(0, args.take) : ordered;
      }),
      findFirst: vi.fn(async (args: { where: { projectId: string } }) =>
        chapters.filter((row) => row.projectId === args.where.projectId).sort((a, b) => b.chapterIndex - a.chapterIndex)[0] ?? null
      ),
      upsert: vi.fn(async (args: { where: { projectId_chapterIndex: { projectId: string; chapterIndex: number } }; create: Partial<ChapterRow>; update: Partial<ChapterRow> }) => {
        const key = args.where.projectId_chapterIndex;
        let row = chapters.find((item) => item.projectId === key.projectId && item.chapterIndex === key.chapterIndex);
        if (!row) {
          row = {
            id: `chapter-${chapters.length + 1}`,
            projectId: key.projectId,
            volumeIndex: 1,
            chapterIndex: key.chapterIndex,
            title: "",
            summary: "",
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
            createdAt: now(),
            updatedAt: now(),
            ...args.create,
          } as ChapterRow;
          chapters.push(row);
        } else {
          Object.assign(row, args.update, { updatedAt: now() });
        }
        return row;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Partial<ChapterRow> }) => {
        const row = chapters.find((item) => item.id === args.where.id);
        if (!row) throw new Error("chapter not found");
        Object.assign(row, args.data, { updatedAt: now() });
        return row;
      }),
    },
    novelChapterVersion: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "chapter-version-1", ...args.data })),
    },
    novelTask: {
      create: vi.fn(async (args: { data: Omit<TaskRow, "id" | "createdAt" | "updatedAt" | "completedAt" | "cancelledAt" | "error" | "resultPayload"> }) => {
        const row = {
          ...args.data,
          id: `task-${tasks.length + 1}`,
          error: null,
          resultPayload: null,
          createdAt: now(),
          updatedAt: now(),
          completedAt: null,
          cancelledAt: null,
        };
        tasks.push(row);
        return row;
      }),
      findUnique: vi.fn(async (args: { where: { id: string } }) =>
        tasks.find((row) => row.id === args.where.id) ?? null
      ),
      findFirst: vi.fn(async (args: { where: { id?: string; userId?: string } }) =>
        tasks.find((row) =>
          (!args.where.id || row.id === args.where.id) &&
          (!args.where.userId || row.userId === args.where.userId)
        ) ?? null
      ),
      findMany: vi.fn(async (args: { where: { projectId?: string; userId?: string } }) =>
        tasks.filter((row) =>
          (!args.where.projectId || row.projectId === args.where.projectId) &&
          (!args.where.userId || row.userId === args.where.userId)
        )
      ),
      update: vi.fn(async (args: { where: { id: string }; data: Partial<TaskRow> }) => {
        const row = tasks.find((item) => item.id === args.where.id);
        if (!row) throw new Error("task not found");
        Object.assign(row, args.data, { updatedAt: now() });
        return row;
      }),
    },
    novelKnowledgeFact: {
      upsert: vi.fn(async (args: any) => {
        const key = args.where.projectId_chapterIndex_subject_predicate_object;
        let row = knowledgeFacts.find((item) =>
          item.projectId === key.projectId &&
          item.chapterIndex === key.chapterIndex &&
          item.subject === key.subject &&
          item.predicate === key.predicate &&
          item.object === key.object
        );
        if (!row) {
          const next: KnowledgeFactRow = {
            id: `fact-${knowledgeFacts.length + 1}`,
            chapterId: null,
            chapterIndex: null,
            sourceExcerpt: "",
            confidence: 0.7,
            status: "confirmed",
            createdAt: now(),
            updatedAt: now(),
            ...args.create,
          };
          knowledgeFacts.push(next);
          row = next;
        } else {
          Object.assign(row, args.update, { updatedAt: now() });
        }
        return row;
      }),
      findMany: vi.fn(async (args: { where?: { projectId?: string } }) =>
        knowledgeFacts.filter((row) => !args.where?.projectId || row.projectId === args.where.projectId)
      ),
    },
    novelForeshadowItem: {
      upsert: vi.fn(async (args: any) => {
        const key = args.where.projectId_title;
        let row = foreshadowItems.find((item) => item.projectId === key.projectId && item.title === key.title);
        if (!row) {
          const next: ForeshadowRow = {
            id: `foreshadow-${foreshadowItems.length + 1}`,
            introducedInChapterId: null,
            introducedInChapterIndex: null,
            description: "",
            expectedPayoffChapter: 0,
            status: "open",
            relatedCharacter: "",
            createdAt: now(),
            updatedAt: now(),
            ...args.create,
          };
          foreshadowItems.push(next);
          row = next;
        } else {
          Object.assign(row, args.update, { updatedAt: now() });
        }
        return row;
      }),
      findMany: vi.fn(async (args: { where?: { projectId?: string } }) =>
        foreshadowItems.filter((row) => !args.where?.projectId || row.projectId === args.where.projectId)
      ),
    },
    $queryRawUnsafe: vi.fn(async (sql: string, ...args: unknown[]) => {
      if (sql.includes('"contentHash"')) {
        return vectorMemories
          .filter((row) => row.projectId === args[0])
          .map((row) => ({
            id: row.id,
            sourceType: row.sourceType,
            sourceId: row.sourceId,
            contentHash: row.contentHash,
          }));
      }
      if (sql.includes("embedding <=>")) {
        return vectorMemories
          .filter((row) => row.projectId === args[1] && row.content.includes("银铃秘契"))
          .map((row) => ({
            id: row.id,
            sourceType: row.sourceType,
            sourceId: row.sourceId,
            sourceKind: row.sourceKind,
            title: row.title,
            content: row.content,
            score: 0.92,
          }));
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async (sql: string, ...args: unknown[]) => {
      if (sql.includes('INSERT INTO "NovelVectorMemory"')) {
        const existing = vectorMemories.find((row) => row.projectId === args[1] && row.sourceType === args[2] && row.sourceId === args[3]);
        const next = {
          id: String(args[0]),
          projectId: String(args[1]),
          sourceType: String(args[2]),
          sourceId: String(args[3]),
          sourceKind: String(args[4]),
          title: String(args[5]),
          content: String(args[6]),
          contentHash: String(args[7]),
          embedding: [0.1, 0.2],
          createdAt: now(),
          updatedAt: now(),
        };
        if (existing) {
          Object.assign(existing, next, { id: existing.id, createdAt: existing.createdAt, updatedAt: now() });
        } else {
          vectorMemories.push(next);
        }
      }
      return 1;
    }),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    _rows: { projects, sections, chapters, tasks, vectorMemories, knowledgeFacts, foreshadowItems },
  };
  return db;
}

function createBillingMock(overrides: Record<string, unknown> = {}) {
  return {
    reserveResource: vi.fn(async () => ({ reserved: 6 })),
    settleResource: vi.fn(async () => ({ settled: 1 })),
    refundResource: vi.fn(async () => ({ success: true })),
    listResourcePrices: vi.fn(async () => ({
      data: [
        { resourceKey: "novel_text_output", displayName: "小说文字生成", pricingType: "PER_UNIT", rate: 2, perUnits: 1000, enabled: true },
        { resourceKey: "novel_cover_generation", displayName: "小说封面生成", pricingType: "PER_CALL", rate: 15, perUnits: 1, enabled: true },
      ],
    })),
    ...overrides,
  };
}

async function createApp(options: {
  readonly prisma: ReturnType<typeof createPrismaMock>;
  readonly billing: ReturnType<typeof createBillingMock>;
  readonly generator?: ReturnType<typeof vi.fn>;
  readonly scheduled?: Promise<void>[];
}) {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    (req as unknown as { userId: string }).userId = "u1";
  });
  await app.register(novelWorkflowRoutes, {
    prisma: options.prisma as unknown as PrismaClient,
    billing: options.billing as any,
    generator: options.generator ?? vi.fn(async () => ({ text: "内容", model: "server-model" })),
    scheduleTask: (work: () => Promise<void>) => {
      options.scheduled?.push(work());
    },
  });
  await app.ready();
  return app;
}

describe("novel workflow routes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("creates a project with default planning sections", async () => {
    const prisma = createPrismaMock();
    const app = await createApp({ prisma, billing: createBillingMock() });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/novels/projects",
      payload: { title: "长夜纪元", genre: "玄幻" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.sections).toHaveLength(8);
    expect(response.json().data.sections.map((section: { kind: string }) => section.kind)).toContain("world");
    expect(response.json().data.sections.map((section: { kind: string }) => section.kind)).not.toContain("roleplay");
    await app.close();
  });

  it("returns novel workflow pricing from configured resource prices", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock();
    const app = await createApp({ prisma, billing });

    const response = await app.inject({
      method: "GET",
      url: "/api/workflow/novels/pricing",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.novelText).toMatchObject({
      resourceKey: "novel_text_output",
      rate: 2,
      perUnits: 1000,
      enabled: true,
    });
    expect(response.json().data.cover).toMatchObject({
      resourceKey: "novel_cover_generation",
      pricingType: "PER_CALL",
      rate: 15,
    });
    expect(billing.listResourcePrices).toHaveBeenCalledOnce();
    await app.close();
  });

  it("creates a project with initial settings without charging resource points", async () => {
    const prisma = createPrismaMock();
    const billing = createBillingMock();
    const app = await createApp({ prisma, billing });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/novels/projects",
      payload: {
        title: "剑来",
        genre: "男频长篇 · 玄幻",
        initialSettings: {
          channel: "男频长篇",
          coreRequirement: "视角：第三人称；每章约 5000 字；语言：中文",
          platforms: ["番茄", "起点"],
          topics: ["玄幻", "武侠"],
          perspective: "第三人称",
          styleMode: "强爽点",
          era: "古代",
          hasCheat: false,
          styleTags: ["无CP", "升级流"],
          language: "中文",
          chapterCount: 12,
          chapterChars: 5000,
        },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(billing.reserveResource).not.toHaveBeenCalled();
    const settings = prisma._rows.sections.find((section: SectionRow) => section.kind === "settings");
    expect(settings.status).toBe("draft");
    expect(settings.displayText).toContain("【核心要求】\n视角：第三人称；每章约 5000 字；语言：中文");
    expect(settings.displayText).toContain("【频道】\n男频长篇");
    expect(settings.displayText).toContain("【题材】\n玄幻 / 武侠");
    expect(settings.displayText).toContain("【是否金手指】\n否");
    expect(settings.displayText).toContain("【章节规划】\n章节数：12\n每章字数：5000");
    await app.close();
  });

  it("saves a planning section without charging resource points", async () => {
    const prisma = createPrismaMock([{ id: "project-1", userId: "u1", title: "长夜纪元", genre: "玄幻", status: "active", createdAt: now(), updatedAt: now() }]);
    const billing = createBillingMock();
    const app = await createApp({ prisma, billing });

    const response = await app.inject({
      method: "PUT",
      url: "/api/workflow/novels/projects/project-1/stages/settings",
      payload: { displayText: "【卖点】\n治愈异能搭配乡村种田。" },
    });

    expect(response.statusCode).toBe(200);
    expect(billing.reserveResource).not.toHaveBeenCalled();
    const settings = prisma._rows.sections.find((section: SectionRow) => section.kind === "settings");
    expect(settings.displayText).toContain("治愈异能");
    expect(settings.status).toBe("draft");
    await app.close();
  });

  it("generates a world stage and settles only displayed JSON values", async () => {
    const prisma = createPrismaMock([{ id: "project-1", userId: "u1", title: "长夜纪元", genre: "玄幻", status: "active", createdAt: now(), updatedAt: now() }]);
    const billing = createBillingMock();
    const generator = vi.fn(async () => ({
      text: "{\"title\":\"世界观\",\"geo\":{\"overview\":\"灵气复苏\"},\"rules\":[\"门派争斗\"]}",
      model: "server-model",
    }));
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, generator, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/novels/projects/project-1/stages/world/generate",
      payload: { prompt: "强调宗门冲突", model: "user-model" },
    });

    expect(response.statusCode).toBe(202);
    expect(billing.reserveResource).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1",
      resourceKey: "novel_text_output",
      units: 6000,
    }));
    await scheduled[0];
    expect(generator).toHaveBeenCalledWith(expect.not.objectContaining({ model: "user-model" }));
    expect(billing.settleResource).toHaveBeenCalledWith(expect.objectContaining({
      resourceKey: "novel_text_output",
      units: 8,
    }));
    const world = prisma._rows.sections.find((section: SectionRow) => section.kind === "world");
    expect(world.displayText).toContain("灵气复苏");
    expect(world.displayText).toContain("【世界手册】");
    expect(world.displayText).not.toContain("{");
    expect(world.displayText).not.toContain("title");
    expect(prisma._rows.tasks[0].status).toBe("succeeded");
    await app.close();
  });

  it("passes stage target count through the task payload and generator input", async () => {
    const prisma = createPrismaMock([{ id: "project-1", userId: "u1", title: "长夜纪元", genre: "玄幻", status: "active", createdAt: now(), updatedAt: now() }]);
    const billing = createBillingMock();
    const generator = vi.fn(async () => ({
      text: JSON.stringify({ 角色: [{ 名: "沈九泠", 动机: "求生。" }] }),
      model: "server-model",
    }));
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, generator, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/novels/projects/project-1/stages/chars/generate",
      payload: { prompt: "多给反派", targetCount: 8 },
    });

    expect(response.statusCode).toBe(202);
    expect(prisma._rows.tasks[0].requestPayload).toMatchObject({ prompt: "多给反派", targetCount: 8 });
    await scheduled[0];
    expect(generator).toHaveBeenCalledWith(expect.objectContaining({ targetKind: "chars", targetCount: 8 }));
    await app.close();
  });

  it("fails and preserves the previous section when counted stage JSON is truncated", async () => {
    const prisma = createPrismaMock([{ id: "project-1", userId: "u1", title: "长夜纪元", genre: "玄幻", status: "active", createdAt: now(), updatedAt: now() }]);
    prisma._rows.sections.push({
      id: "section-outline",
      projectId: "project-1",
      kind: "outline",
      status: "ready",
      displayText: "【章节列表】\n旧章节",
      structuredJson: { 章节列表: [{ 章号: 1, 标题: "旧章节" }] },
      billableChars: 3,
      lastTaskId: "task-old",
      createdAt: now(),
      updatedAt: now(),
    });
    const billing = createBillingMock();
    const generator = vi.fn(async () => ({
      text: "{\"章节列表\":[{\"章号\":1,\"标题\":\"寒泉院\"",
      model: "server-model",
    }));
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, generator, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/novels/projects/project-1/stages/outline/generate",
      payload: { prompt: "拆 12 章", targetCount: 12 },
    });

    expect(response.statusCode).toBe(202);
    await scheduled[0];
    expect(billing.settleResource).not.toHaveBeenCalled();
    expect(billing.refundResource).toHaveBeenCalledWith(prisma._rows.tasks[0].operationId);
    expect(prisma._rows.tasks[0].status).toBe("failed");
    expect(prisma._rows.tasks[0].error).toContain("JSON");
    const outline = prisma._rows.sections.find((section: SectionRow) => section.kind === "outline");
    expect(outline?.displayText).toBe("【章节列表】\n旧章节");
    expect(outline?.lastTaskId).toBe("task-old");
    await app.close();
  });

  it("materializes chapter drafts from the generated chapter outline", async () => {
    const prisma = createPrismaMock([{ id: "project-1", userId: "u1", title: "长夜纪元", genre: "玄幻", status: "active", createdAt: now(), updatedAt: now() }]);
    prisma._rows.sections.push({
      id: "section-outline",
      projectId: "project-1",
      kind: "outline",
      status: "ready",
      displayText: "【章节列表】\n序号：1\n标题：寒泉院\n摘要：沈九泠被困寒泉院。\n本章目标：建立危机\n\n序号：2\n标题：锁灵坠\n摘要：女主拿到关键线索。",
      structuredJson: null,
      billableChars: 20,
      lastTaskId: "task-outline",
      createdAt: now(),
      updatedAt: now(),
    });
    const app = await createApp({ prisma, billing: createBillingMock() });

    const response = await app.inject({
      method: "GET",
      url: "/api/workflow/novels/projects/project-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.chapters).toMatchObject([
      { chapterIndex: 1, title: "寒泉院", summary: "沈九泠被困寒泉院。\n本章目标：建立危机", content: "" },
      { chapterIndex: 2, title: "锁灵坠", summary: "女主拿到关键线索。", content: "" },
    ]);
    await app.close();
  });

  it("backfills long-form memory when opening a project with completed chapters", async () => {
    const prisma = createPrismaMock([{ id: "project-1", userId: "u1", title: "长夜纪元", genre: "玄幻", status: "active", createdAt: now(), updatedAt: now() }]);
    prisma._rows.chapters.push(
      {
        id: "chapter-1",
        projectId: "project-1",
        volumeIndex: 1,
        chapterIndex: 1,
        title: "寒泉院",
        summary: "",
        content: "第一章正文：沈九泠在寒泉院濒死，锁灵坠第一次出现。",
        status: "ready",
        billableChars: 27,
        lastTaskId: "task-chapter-1",
        createdAt: now(),
        updatedAt: now(),
      },
      {
        id: "chapter-2",
        projectId: "project-1",
        volumeIndex: 1,
        chapterIndex: 2,
        title: "锁灵坠",
        summary: "",
        content: "第二章正文：沈九泠拿到锁灵坠，确认它能保住心脉。",
        status: "ready",
        billableChars: 26,
        lastTaskId: "task-chapter-2",
        createdAt: now(),
        updatedAt: now(),
      },
    );
    const app = await createApp({ prisma, billing: createBillingMock() });

    const response = await app.inject({
      method: "GET",
      url: "/api/workflow/novels/projects/project-1",
    });

    expect(response.statusCode).toBe(200);
    const draft = response.json().data.sections.find((section: { kind: string }) => section.kind === "draft");
    expect(draft.displayText).toContain("已记忆至第 2 章");
    expect(draft.displayText).toContain("第 1 章 寒泉院");
    expect(draft.displayText).toContain("第 2 章 锁灵坠");
    expect(draft.displayText).toContain("确认它能保住心脉");
    await app.close();
  });

  it("updates long-form memory after generated chapters and reuses it for the next chapter", async () => {
    const prisma = createPrismaMock([{ id: "project-1", userId: "u1", title: "长夜纪元", genre: "玄幻", status: "active", createdAt: now(), updatedAt: now() }]);
    prisma._rows.chapters.push({
      id: "chapter-1",
      projectId: "project-1",
      volumeIndex: 1,
      chapterIndex: 1,
      title: "寒泉院",
      summary: "女主困在寒泉院。",
      content: "第一章正文：沈九泠在寒泉院濒死，锁灵坠第一次出现。",
      status: "ready",
      billableChars: 27,
      lastTaskId: "task-chapter-1",
      createdAt: now(),
      updatedAt: now(),
    });
    const billing = createBillingMock();
    const generator = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({ title: "锁灵坠", content: "第二章正文：沈九泠拿到锁灵坠，确认它能保住心脉。" }),
        model: "server-model",
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ title: "隐息", content: "第三章正文：沈九泠按长篇记忆继续隐藏锁灵坠。" }),
        model: "server-model",
      });
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, generator, scheduled });

    const firstResponse = await app.inject({
      method: "POST",
      url: "/api/workflow/novels/projects/project-1/chapters/generate",
      payload: { chapterIndex: 2, title: "锁灵坠", summary: "女主取得保命线索。", targetChars: 3000 },
    });

    expect(firstResponse.statusCode).toBe(202);
    await scheduled[0];
    const memory = prisma._rows.sections.find((section: SectionRow) => section.kind === "draft");
    if (!memory) throw new Error("draft long-form memory section was not created");
    expect(memory.displayText).toContain("【长篇记忆】");
    expect(memory.displayText).toContain("已记忆至第 2 章");
    expect(memory.displayText).toContain("第 1 章 寒泉院");
    expect(memory.displayText).toContain("锁灵坠第一次出现");
    expect(memory.displayText).toContain("第 2 章 锁灵坠");
    expect(memory.displayText).toContain("确认它能保住心脉");

    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/workflow/novels/projects/project-1/chapters/generate",
      payload: { chapterIndex: 3, title: "隐息", summary: "女主隐藏新能力。", targetChars: 3000 },
    });

    expect(secondResponse.statusCode).toBe(202);
    await scheduled[1];
    expect(generator.mock.calls[1]?.[0]).toMatchObject({
      targetKind: "chapter",
      chapterIndex: 3,
    });
    expect(generator.mock.calls[1]?.[0].contextText).toContain("已记忆至第 2 章");
    expect(generator.mock.calls[1]?.[0].contextText).toContain("第 2 章 锁灵坠");
    await app.close();
  });

  it("post-processes generated chapter into review and workbench assets", async () => {
    const prisma = createPrismaMock([{ id: "project-1", userId: "u1", title: "长夜纪元", genre: "玄幻", status: "active", createdAt: now(), updatedAt: now() }]);
    prisma._rows.sections.push({
      id: "section-chars",
      projectId: "project-1",
      kind: "chars",
      status: "ready",
      displayText: "【角色】\n沈九泠\n赵虎",
      structuredJson: null,
      billableChars: 6,
      lastTaskId: null,
      createdAt: now(),
      updatedAt: now(),
    });
    const billing = createBillingMock();
    const generator = vi.fn(async () => ({
      text: JSON.stringify({ title: "锁灵坠", content: "沈九泠在寒泉院发现锁灵坠。赵虎为何提前知道此物？" }),
      model: "server-model",
    }));
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing, generator, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/novels/projects/project-1/chapters/generate",
      payload: { chapterIndex: 2, title: "锁灵坠", summary: "取得保命线索。", targetChars: 3000 },
    });

    expect(response.statusCode).toBe(202);
    await scheduled[0];
    const chapter = prisma._rows.chapters.find((row: ChapterRow) => row.chapterIndex === 2);
    expect(chapter.summary).toContain("锁灵坠");
    expect(chapter.openThreads).toContain("赵虎为何提前知道此物？");
    expect((chapter.consistencyJson as any).quality.score).toBeLessThanOrEqual(100);
    expect(chapter.aiReview).toContain("诊断");
    expect(chapter.reviewStatus).toBe("pending");
    expect(prisma._rows.knowledgeFacts.length).toBeGreaterThan(0);
    expect(prisma._rows.foreshadowItems.length).toBeGreaterThan(0);
    await app.close();
  });

  it("uses vectorized novel context when generating later chapters", async () => {
    vi.stubEnv("EMBEDDING_BASE_URL", "http://embedding.test");
    vi.stubEnv("EMBEDDING_API_KEY", "embedding-key");
    vi.stubEnv("EMBEDDING_MODEL", "embedding-model");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ embedding: [0.1, 0.2] }],
      usage: { total_tokens: 4 },
    }), { status: 200 })));
    const prisma = createPrismaMock([{ id: "project-1", userId: "u1", title: "长夜纪元", genre: "玄幻", status: "active", createdAt: now(), updatedAt: now() }]);
    prisma._rows.sections.push({
      id: "section-world",
      projectId: "project-1",
      kind: "world",
      status: "ready",
      displayText: "世界观：冷铁铃只能由沈氏血脉启动。",
      structuredJson: null,
      billableChars: 16,
      lastTaskId: "task-world",
      createdAt: now(),
      updatedAt: now(),
    });
    for (let chapterIndex = 1; chapterIndex <= 12; chapterIndex += 1) {
      prisma._rows.chapters.push({
        id: `chapter-${chapterIndex}`,
        projectId: "project-1",
        volumeIndex: 1,
        chapterIndex,
        title: `前情 ${chapterIndex}`,
        summary: `第 ${chapterIndex} 章摘要。`,
        content: `第 ${chapterIndex} 章正文。`,
        status: "ready",
        billableChars: 10,
        lastTaskId: `task-${chapterIndex}`,
        createdAt: now(),
        updatedAt: now(),
      });
    }
    prisma._rows.chapters.push({
      id: "chapter-13",
      projectId: "project-1",
      volumeIndex: 1,
      chapterIndex: 13,
      title: "银铃秘契",
      summary: "银铃秘契第一次显影。",
      content: "第十三章正文：银铃秘契会在寒泉雾里显影，铃声会暴露持有人真实血脉。",
      status: "ready",
      billableChars: 36,
      lastTaskId: "task-13",
      createdAt: now(),
      updatedAt: now(),
    });
    const generator = vi.fn(async (_input: Parameters<NovelGenerator>[0]) => ({
      text: JSON.stringify({ title: "血脉回响", content: "第二十章正文。" }),
      model: "server-model",
    }));
    const scheduled: Promise<void>[] = [];
    const app = await createApp({ prisma, billing: createBillingMock(), generator, scheduled });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/novels/projects/project-1/chapters/generate",
      payload: { chapterIndex: 20, title: "血脉回响", summary: "回收银铃秘契伏笔。", targetChars: 3000 },
    });

    expect(response.statusCode).toBe(202);
    await scheduled[0];
    const firstCall = generator.mock.calls[0];
    if (!firstCall) throw new Error("chapter generator was not called");
    const contextText = firstCall[0].contextText;
    expect(contextText).toContain("向量记忆召回");
    expect(contextText).toContain("第 13 章 银铃秘契");
    expect(contextText).toContain("铃声会暴露持有人真实血脉");
    await app.close();
  });

  it("saves edited chapter content without changing the last generation task", async () => {
    const prisma = createPrismaMock([{ id: "project-1", userId: "u1", title: "长夜纪元", genre: "玄幻", status: "active", createdAt: now(), updatedAt: now() }]);
    prisma._rows.chapters.push({
      id: "chapter-1",
      projectId: "project-1",
      volumeIndex: 1,
      chapterIndex: 1,
      title: "寒泉院",
      summary: "旧摘要",
      content: "旧正文",
      status: "ready",
      billableChars: 3,
      lastTaskId: "task-old",
      createdAt: now(),
      updatedAt: now(),
    });
    const app = await createApp({ prisma, billing: createBillingMock() });

    const response = await app.inject({
      method: "PUT",
      url: "/api/workflow/novels/projects/project-1/chapters/1",
      payload: { title: "寒泉院·改", summary: "新摘要", content: "新正文\n第二段" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.chapter).toMatchObject({
      chapterIndex: 1,
      title: "寒泉院·改",
      summary: "新摘要",
      content: "新正文\n第二段",
      status: "ready",
      lastTaskId: "task-old",
    });
    expect(prisma._rows.chapters[0].billableChars).toBe(6);
    await app.close();
  });

  it("returns a novel workbench payload for an owned project", async () => {
    const prisma = createPrismaMock([{ id: "project-1", userId: "u1", title: "长夜纪元", genre: "玄幻", status: "active", createdAt: now(), updatedAt: now() }]);
    prisma._rows.chapters.push({
      id: "chapter-1",
      projectId: "project-1",
      volumeIndex: 1,
      chapterIndex: 1,
      title: "寒泉院",
      summary: "沈九泠发现锁灵坠。",
      content: "正文",
      rawContent: "正文",
      openThreads: ["锁灵坠是谁留下的？"],
      contextSnapshot: null,
      generationMeta: null,
      consistencyJson: { status: "warning", risks: ["章节字数偏低"], quality: { score: 70, styleRisk: "medium" } },
      status: "ready",
      reviewStatus: "pending",
      reviewNotes: "",
      aiReview: "诊断：质量分 70 /100",
      aiActionItems: ["补足场景"],
      modificationRate: 0,
      reviewedAt: null,
      billableChars: 2,
      lastTaskId: null,
      createdAt: now(),
      updatedAt: now(),
    });
    const app = await createApp({ prisma, billing: createBillingMock() });

    const response = await app.inject({ method: "GET", url: "/api/workflow/novels/projects/project-1/workbench" });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.stats.finishedChapters).toBe(1);
    expect(response.json().data.workbenchHighlights.focusChapterNumber).toBe(2);
    expect(response.json().data.chapters[0].reviewStatus).toBe("pending");
    await app.close();
  });

  it("saves chapter review status and notes", async () => {
    const prisma = createPrismaMock([{ id: "project-1", userId: "u1", title: "长夜纪元", genre: "玄幻", status: "active", createdAt: now(), updatedAt: now() }]);
    prisma._rows.chapters.push({
      id: "chapter-1",
      projectId: "project-1",
      volumeIndex: 1,
      chapterIndex: 1,
      title: "寒泉院",
      summary: "旧摘要",
      content: "人工润色后的正文",
      rawContent: "AI正文",
      openThreads: [],
      contextSnapshot: null,
      generationMeta: null,
      consistencyJson: null,
      status: "ready",
      reviewStatus: "pending",
      reviewNotes: "",
      aiReview: "",
      aiActionItems: [],
      modificationRate: 0,
      reviewedAt: null,
      billableChars: 8,
      lastTaskId: null,
      createdAt: now(),
      updatedAt: now(),
    });
    const app = await createApp({ prisma, billing: createBillingMock() });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/novels/projects/project-1/chapters/1/review",
      payload: { status: "approved", reviewNotes: "已补强结尾。" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.chapter.reviewStatus).toBe("approved");
    expect(response.json().data.chapter.reviewNotes).toBe("已补强结尾。");
    expect(response.json().data.chapter.reviewedAt).not.toBeNull();
    await app.close();
  });

  it("returns 402 when resource reservation is insufficient", async () => {
    const prisma = createPrismaMock([{ id: "project-1", userId: "u1", title: "长夜纪元", genre: "", status: "active", createdAt: now(), updatedAt: now() }]);
    const billing = createBillingMock({
      reserveResource: vi.fn(async () => {
        throw new InsufficientBalanceError();
      }),
    });
    const app = await createApp({ prisma, billing });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/novels/projects/project-1/chapters/generate",
      payload: { targetChars: 3000 },
    });

    expect(response.statusCode).toBe(402);
    expect(prisma._rows.tasks).toHaveLength(0);
    await app.close();
  });
});
