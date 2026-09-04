import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@ai-assistant/db";
import { requireUser } from "../../auth/require-user.js";
import { createNovelGenerator, type NovelGenerator } from "./novel-generation.js";
import { visibleCharCount } from "./novel-billable.js";
import { buildNovelChapterPostprocessPayload } from "./novel-postprocess.js";
import { buildNovelReviewPayload, estimateNovelModificationRate } from "./novel-review.js";
import { syncNovelContinuityAssetsForChapter } from "../../novel/continuity-assets.js";
import { syncNovelNarrativeLedgersForChapter } from "../../novel/narrative-ledger.js";
import { dispatchNovelOutboxBatch } from "../../novel/outbox.js";
import { NOVEL_TASK_STATUS } from "./novel-types.js";
import { getNovelWorkbench, serializeNovelWorkbenchChapter } from "./novel-workbench.js";
import { withNovelWritingModel } from "./novel-models.js";
import {
  getProjectDetail,
  nextChapterIndex,
  refreshNovelVectorMemoryBestEffort,
  reserveAndCreateTask,
  runNovelTask,
  serializeTask,
  type NovelTaskRow,
} from "./novel-task-runner.js";

type ScheduleTask = (work: () => Promise<void>) => void;

interface NovelWorkflowRouteDeps {
  readonly prisma?: PrismaClient;
  readonly generator?: NovelGenerator;
  readonly scheduleTask?: ScheduleTask;
}

const projectParamsSchema = z.object({ projectId: z.string().trim().min(1) });
const taskParamsSchema = z.object({ taskId: z.string().trim().min(1) });
const setupParamsSchema = projectParamsSchema.extend({
  setupKind: z.enum(["bible", "characters", "locations", "plot"]),
});
const setupGenerateSchema = z.object({ prompt: z.string().trim().max(5000).optional().default("") });
const chapterParamsSchema = projectParamsSchema.extend({
  chapterIndex: z.coerce.number().int().min(1).max(9999),
});
const chapterVersionParamsSchema = chapterParamsSchema.extend({ versionId: z.string().trim().min(1) });
const createProjectSchema = z.object({
  title: z.string().trim().min(1).max(80),
  premise: z.string().trim().min(10).max(20_000),
  genre: z.string().trim().max(120).optional().default(""),
  worldPreset: z.string().trim().max(10_000).optional().default(""),
  storyStructure: z.string().trim().max(10_000).optional().default(""),
  pacingControl: z.string().trim().max(10_000).optional().default(""),
  writingStyle: z.string().trim().max(10_000).optional().default(""),
  specialRequirements: z.string().trim().max(10_000).optional().default(""),
  targetChapters: z.number().int().min(1).max(9999).default(100),
  targetCharsPerChapter: z.number().int().min(500).max(20_000).default(3000),
});
const updateProjectSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  genre: z.string().trim().max(40).optional(),
  writingModel: z.string().trim().max(128).optional(),
});
const chapterGenerateSchema = z.object({
  chapterIndex: z.number().int().min(1).max(9999).optional(),
  title: z.string().trim().max(80).optional().default(""),
  summary: z.string().trim().max(3000).optional().default(""),
  targetChars: z.number().int().min(500).max(12000).optional().default(3000),
});
const saveChapterSchema = z.object({
  title: z.string().trim().max(80).optional().default(""),
  summary: z.string().trim().max(3000).optional().default(""),
  outline: z.string().max(20_000).optional(),
  generationHint: z.string().max(20_000).optional(),
  executionPlan: z.unknown().optional(),
  microBeats: z.array(z.unknown()).max(100).optional(),
  content: z.string().max(500_000).optional().default(""),
});
const rewriteChapterSelectionSchema = z.object({
  selectedText: z.string().min(1).max(12_000),
  selectionStart: z.number().int().min(0).max(500_000),
  selectionEnd: z.number().int().min(1).max(500_000),
  instruction: z.string().trim().min(1).max(2000),
});
const reviewChapterSchema = z.object({
  status: z.enum(["pending", "approved", "revise"]).optional(),
  reviewNotes: z.string().max(20_000).optional(),
  regenerateAi: z.boolean().optional().default(false),
});

async function findOwnedProject(prisma: PrismaClient, userId: string, projectId: string) {
  return prisma.novelProject.findFirst({ where: { id: projectId, userId } });
}

function jsonValue(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null || value === undefined ? Prisma.JsonNull : value as Prisma.InputJsonValue;
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export async function novelWorkflowRoutes(app: FastifyInstance, deps: NovelWorkflowRouteDeps = {}) {
  // 本文件 17 个路由全部必须登录，挂插件级。
  app.addHook("preHandler", requireUser);

  const prisma = deps.prisma ?? getPrisma();
  const generator = deps.generator ?? createNovelGenerator();
  const scheduleTask = deps.scheduleTask;
  const taskDelivery = scheduleTask ? "inline" as const : "worker-outbox" as const;

  function enqueue(task: NovelTaskRow): void {
    if (scheduleTask) {
      scheduleTask(() => runNovelTask({ prisma, generator, task }));
      return;
    }
    void dispatchNovelOutboxBatch(prisma).catch((error) => app.log.error(error));
  }

  app.get("/api/workflow/novels/projects", async (req, reply) => {
    const userId = req.userId;
    const rows = await prisma.novelProject.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: 30,
      include: { chapters: { select: { billableChars: true } } },
    });
    return { success: true, data: rows.map((project) => ({
      id: project.id,
      title: project.title,
      genre: project.genre,
      premise: project.premise,
      status: project.status,
      setupStage: project.setupStage,
      setupCompleted: project.setupCompleted,
      targetChapters: project.targetChapters,
      chapterCount: project.chapters.length,
      totalWords: project.chapters.reduce((sum, chapter) => sum + chapter.billableChars, 0),
      updatedAt: project.updatedAt.toISOString(),
    })) };
  });

  app.post("/api/workflow/novels/projects", async (req, reply) => {
    const userId = req.userId;
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "请输入小说标题" });
    const project = await prisma.novelProject.create({
      data: {
        userId,
        title: parsed.data.title,
        genre: parsed.data.genre,
        premise: parsed.data.premise,
        targetChapters: parsed.data.targetChapters,
        targetCharsPerChapter: parsed.data.targetCharsPerChapter,
        setupStage: 1,
        setupCompleted: false,
        settings: {
          worldPreset: parsed.data.worldPreset,
          storyStructure: parsed.data.storyStructure,
          pacingControl: parsed.data.pacingControl,
          writingStyle: parsed.data.writingStyle,
          specialRequirements: parsed.data.specialRequirements,
        },
        bible: {
          create: {
            premiseLock: parsed.data.premise,
            genreLock: parsed.data.genre,
            worldPresetLock: parsed.data.worldPreset,
          },
        },
      },
    });
    await refreshNovelVectorMemoryBestEffort(prisma, project.id);
    const detail = await getProjectDetail(prisma, userId, project.id);
    return reply.code(201).send({ success: true, data: detail });
  });

  app.get("/api/workflow/novels/projects/:projectId", async (req, reply) => {
    const userId = req.userId;
    const parsed = projectParamsSchema.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const detail = await getProjectDetail(prisma, userId, parsed.data.projectId);
    if (!detail) return reply.code(404).send({ error: "项目不存在" });
    return { success: true, data: detail };
  });

  app.get("/api/workflow/novels/projects/:projectId/workbench", async (req, reply) => {
    const userId = req.userId;
    const parsed = projectParamsSchema.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const workbench = await getNovelWorkbench(prisma, userId, parsed.data.projectId);
    if (!workbench) return reply.code(404).send({ error: "项目不存在" });
    return { success: true, data: workbench };
  });

  app.patch("/api/workflow/novels/projects/:projectId", async (req, reply) => {
    const userId = req.userId;
    const params = projectParamsSchema.safeParse(req.params);
    const body = updateProjectSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    await prisma.novelProject.update({
      where: { id: project.id },
      data: {
        ...(body.data.title !== undefined ? { title: body.data.title } : {}),
        ...(body.data.genre !== undefined ? { genre: body.data.genre } : {}),
        ...(body.data.writingModel !== undefined ? { generationPrefs: jsonValue(withNovelWritingModel(project.generationPrefs, body.data.writingModel)) } : {}),
      },
    });
    const detail = await getProjectDetail(prisma, userId, project.id);
    return { success: true, data: detail };
  });

  app.delete("/api/workflow/novels/projects/:projectId", async (req, reply) => {
    const userId = req.userId;
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const activeRun = await prisma.novelRun.findFirst({ where: { projectId: project.id, status: { in: ["queued", "planning", "writing", "validating", "postprocessing", "awaitingReview", "paused", "failed"] } }, select: { id: true } });
    const activeTask = await prisma.novelTask.findFirst({ where: { projectId: project.id, status: { in: ["queued", "running"] } }, select: { id: true } });
    if (activeRun || activeTask) return reply.code(409).send({ error: "请先停止当前小说运行和生成任务，再删除作品" });
    await prisma.novelProject.delete({ where: { id: project.id } });
    return { success: true };
  });

  app.get("/api/workflow/novels/projects/:projectId/tasks", async (req, reply) => {
    const userId = req.userId;
    const parsed = projectParamsSchema.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(prisma, userId, parsed.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const tasks = await prisma.novelTask.findMany({
      where: { projectId: project.id, userId },
      orderBy: { updatedAt: "desc" },
      take: 20,
    });
    return { success: true, data: tasks.map(serializeTask) };
  });

  app.post("/api/workflow/novels/projects/:projectId/setup/:setupKind/generate", async (req, reply) => {
    const userId = req.userId;
    const params = setupParamsSchema.safeParse(req.params);
    const body = setupGenerateSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    if (project.setupCompleted) return reply.code(409).send({ error: "新书设置已完成，请在作品工作台中修改资料" });
    const targetKind = ({ bible: "setupBible", characters: "setupCharacters", locations: "setupLocations", plot: "setupPlot" } as const)[params.data.setupKind];
    const active = await prisma.novelTask.findFirst({ where: { projectId: project.id, targetKind, status: { in: ["queued", "running"] } } });
    if (active) return reply.code(409).send({ error: "该设置步骤正在生成" });
    const task = await reserveAndCreateTask({ prisma, userId, projectId: project.id, targetKind, payload: { prompt: body.data.prompt, ...(targetKind === "setupPlot" ? { targetCount: project.targetChapters } : {}) }, delivery: taskDelivery });
    enqueue(task);
    return reply.code(202).send({ success: true, data: { task: serializeTask(task) } });
  });

  app.post("/api/workflow/novels/projects/:projectId/chapters/generate", async (req, reply) => {
    const userId = req.userId;
    const params = projectParamsSchema.safeParse(req.params);
    const body = chapterGenerateSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const chapterIndex = body.data.chapterIndex ?? await nextChapterIndex(prisma, project.id);
    const task = await reserveAndCreateTask({
      prisma,
      userId,
      projectId: project.id,
      targetKind: "chapter",
      payload: { ...body.data, chapterIndex },
      delivery: taskDelivery,
    });
    enqueue(task);
    return reply.code(202).send({ success: true, data: { task: serializeTask(task) } });
  });

  app.put("/api/workflow/novels/projects/:projectId/chapters/:chapterIndex", async (req, reply) => {
    const userId = req.userId;
    const params = chapterParamsSchema.safeParse(req.params);
    const body = saveChapterSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const existing = await prisma.novelChapter.findUnique({
      where: { projectId_chapterIndex: { projectId: project.id, chapterIndex: params.data.chapterIndex } },
    });
    const saved = await prisma.$transaction(async (tx) => {
      const content = body.data.content;
      const contentChanged = existing?.content !== content;
      const modificationRate = estimateNovelModificationRate(existing?.rawContent ?? "", content);
      const chapter = await tx.novelChapter.upsert({
        where: { projectId_chapterIndex: { projectId: project.id, chapterIndex: params.data.chapterIndex } },
        create: {
          projectId: project.id,
          chapterIndex: params.data.chapterIndex,
          title: body.data.title || `第 ${params.data.chapterIndex} 章`,
          summary: body.data.summary,
          outline: body.data.outline ?? body.data.summary,
          generationHint: body.data.generationHint ?? "",
          executionPlan: body.data.executionPlan === undefined ? undefined : jsonValue(body.data.executionPlan),
          microBeats: body.data.microBeats === undefined ? undefined : jsonValue(body.data.microBeats),
          content,
          status: content.trim() ? "ready" : "draft",
          reviewStatus: "pending",
          modificationRate,
          reviewedAt: null,
          billableChars: visibleCharCount(content),
        },
        update: {
          title: body.data.title,
          summary: body.data.summary,
          ...(body.data.outline !== undefined ? { outline: body.data.outline } : {}),
          ...(body.data.generationHint !== undefined ? { generationHint: body.data.generationHint } : {}),
          ...(body.data.executionPlan !== undefined ? { executionPlan: jsonValue(body.data.executionPlan) } : {}),
          ...(body.data.microBeats !== undefined ? { microBeats: jsonValue(body.data.microBeats) } : {}),
          content,
          status: content.trim() ? "ready" : "draft",
          ...(contentChanged ? { reviewStatus: "pending", modificationRate, reviewedAt: null } : {}),
          billableChars: visibleCharCount(content),
        },
      });
      if (contentChanged) {
        await tx.novelChapterVersion.create({
          data: { chapterId: chapter.id, title: chapter.title, content: chapter.content, billableChars: chapter.billableChars },
        });
      }
      return chapter;
    });
    await refreshNovelVectorMemoryBestEffort(prisma, project.id);
    return { success: true, data: { chapter: serializeNovelWorkbenchChapter(saved) } };
  });

  app.post("/api/workflow/novels/projects/:projectId/chapters/:chapterIndex/rewrite", async (req, reply) => {
    const userId = req.userId;
    const params = chapterParamsSchema.safeParse(req.params);
    const body = rewriteChapterSelectionSchema.safeParse(req.body);
    if (!params.success || !body.success || body.data.selectionEnd <= body.data.selectionStart) {
      return reply.code(400).send({ error: "请选择需要改写的正文，并填写改写要求" });
    }
    const project = await findOwnedProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const chapter = await prisma.novelChapter.findUnique({
      where: { projectId_chapterIndex: { projectId: project.id, chapterIndex: params.data.chapterIndex } },
    });
    if (!chapter) return reply.code(404).send({ error: "章节不存在" });
    const { selectedText, selectionStart, selectionEnd, instruction } = body.data;
    if (chapter.content.slice(selectionStart, selectionEnd) !== selectedText) {
      return reply.code(409).send({ error: "章节正文已变化，请重新选择需要改写的内容" });
    }
    const active = await prisma.novelTask.findFirst({
      where: {
        projectId: project.id,
        targetKind: "chapterRewrite",
        targetId: chapter.id,
        status: { in: [NOVEL_TASK_STATUS.queued, NOVEL_TASK_STATUS.running] },
      },
    });
    if (active) return reply.code(409).send({ error: "该章节已有局部改写任务正在运行" });
    const targetChars = Math.max(200, Math.min(visibleCharCount(selectedText), 6000));
    const task = await reserveAndCreateTask({
      prisma,
      userId,
      projectId: project.id,
      targetKind: "chapterRewrite",
      targetId: chapter.id,
      payload: {
        chapterIndex: chapter.chapterIndex,
        title: chapter.title,
        summary: selectedText,
        selectedText,
        selectionStart,
        selectionEnd,
        selectionBefore: chapter.content.slice(Math.max(0, selectionStart - 1500), selectionStart),
        selectionAfter: chapter.content.slice(selectionEnd, selectionEnd + 1500),
        prompt: instruction,
        targetChars,
      },
      delivery: taskDelivery,
    });
    enqueue(task);
    return reply.code(202).send({ success: true, data: { task: serializeTask(task) } });
  });

  app.get("/api/workflow/novels/projects/:projectId/chapters/:chapterIndex/versions", async (req, reply) => {
    const userId = req.userId;
    const params = chapterParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const chapter = await prisma.novelChapter.findUnique({ where: { projectId_chapterIndex: { projectId: project.id, chapterIndex: params.data.chapterIndex } } });
    if (!chapter) return reply.code(404).send({ error: "章节不存在" });
    const versions = await prisma.novelChapterVersion.findMany({ where: { chapterId: chapter.id }, orderBy: { createdAt: "desc" }, take: 100 });
    return { success: true, data: { versions } };
  });

  app.get("/api/workflow/novels/projects/:projectId/chapters/:chapterIndex/generation-requests", async (req, reply) => {
    const userId = req.userId;
    const params = chapterParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const chapter = await prisma.novelChapter.findUnique({
      where: { projectId_chapterIndex: { projectId: project.id, chapterIndex: params.data.chapterIndex } },
      select: { id: true },
    });
    if (!chapter) return reply.code(404).send({ error: "章节不存在" });
    const requests = await prisma.novelGenerationRequest.findMany({
      where: { projectId: project.id, chapterIndex: params.data.chapterIndex },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return { success: true, data: { requests: requests.map((request) => ({
      ...request,
      createdAt: request.createdAt.toISOString(),
      updatedAt: request.updatedAt.toISOString(),
    })) } };
  });

  app.post("/api/workflow/novels/projects/:projectId/chapters/:chapterIndex/versions/:versionId/restore", async (req, reply) => {
    const userId = req.userId;
    const params = chapterVersionParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const chapter = await prisma.novelChapter.findUnique({ where: { projectId_chapterIndex: { projectId: project.id, chapterIndex: params.data.chapterIndex } } });
    if (!chapter) return reply.code(404).send({ error: "章节不存在" });
    const version = await prisma.novelChapterVersion.findFirst({ where: { id: params.data.versionId, chapterId: chapter.id } });
    if (!version) return reply.code(404).send({ error: "章节版本不存在" });
    const restored = await prisma.$transaction(async (tx) => {
      await tx.novelChapterVersion.create({ data: { chapterId: chapter.id, title: chapter.title, content: chapter.content, billableChars: chapter.billableChars } });
      return tx.novelChapter.update({
        where: { id: chapter.id },
        data: { title: version.title, content: version.content, billableChars: version.billableChars, reviewStatus: "pending", reviewedAt: null },
      });
    });
    await refreshNovelVectorMemoryBestEffort(prisma, project.id);
    return { success: true, data: { chapter: serializeNovelWorkbenchChapter(restored) } };
  });

  app.post("/api/workflow/novels/projects/:projectId/chapters/:chapterIndex/review", async (req, reply) => {
    const userId = req.userId;
    const params = chapterParamsSchema.safeParse(req.params);
    const body = reviewChapterSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const chapters = await prisma.novelChapter.findMany({ where: { projectId: project.id }, orderBy: { chapterIndex: "asc" } });
    const current = chapters.find((chapter) => chapter.chapterIndex === params.data.chapterIndex);
    if (!current) return reply.code(404).send({ error: "章节不存在" });
    const rawContent = "rawContent" in current && typeof current.rawContent === "string" ? current.rawContent : "";
    const openThreads = jsonStringArray("openThreads" in current ? current.openThreads : []);
    const consistency = "consistencyJson" in current && typeof current.consistencyJson === "object" && current.consistencyJson !== null ? current.consistencyJson as { risks?: unknown } : null;
    const consistencyRisks = jsonStringArray(consistency?.risks);
    const modificationRate = estimateNovelModificationRate(rawContent, current.content);
    const regenerated = body.data.regenerateAi ? buildNovelReviewPayload({
      rawContent,
      finalContent: current.content,
      summary: current.summary,
      openThreads,
      consistencyRisks,
    }) : null;
    const currentReviewStatus = "reviewStatus" in current && typeof current.reviewStatus === "string" ? current.reviewStatus : "pending";
    const currentReviewNotes = "reviewNotes" in current && typeof current.reviewNotes === "string" ? current.reviewNotes : "";
    const nextReviewStatus = body.data.status ?? currentReviewStatus;
    const nextReviewNotes = body.data.reviewNotes ?? currentReviewNotes;
    const reviewChanged = body.data.status !== undefined || body.data.reviewNotes !== undefined;
    const saved = await prisma.novelChapter.update({
      where: { id: current.id },
      data: {
        reviewStatus: nextReviewStatus,
        reviewNotes: nextReviewNotes,
        reviewedAt: nextReviewStatus === "pending" && !nextReviewNotes.trim()
          ? null
          : reviewChanged ? new Date() : current.reviewedAt,
        modificationRate,
        ...(regenerated ? { aiReview: regenerated.aiReview, aiActionItems: regenerated.aiActionItems } : {}),
      },
    });
    return { success: true, data: { chapter: serializeNovelWorkbenchChapter(saved) } };
  });

  app.post("/api/workflow/novels/projects/:projectId/chapters/:chapterIndex/analyze", async (req, reply) => {
    const userId = req.userId;
    const params = chapterParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const [knownCharacters, knownLocations, chapters] = await Promise.all([
      prisma.novelCharacter.findMany({ where: { projectId: project.id }, select: { name: true }, take: 50 }),
      prisma.novelLocation.findMany({ where: { projectId: project.id }, select: { name: true }, take: 50 }),
      prisma.novelChapter.findMany({ where: { projectId: project.id }, orderBy: { chapterIndex: "asc" } }),
    ]);
    const current = chapters.find((chapter) => chapter.chapterIndex === params.data.chapterIndex);
    if (!current) return reply.code(404).send({ error: "章节不存在" });
    const postprocess = buildNovelChapterPostprocessPayload({
      projectTitle: project.title,
      chapterIndex: current.chapterIndex,
      title: current.title,
      content: current.content,
      knownCharacters: knownCharacters.map((item) => item.name),
      knownLocations: knownLocations.map((item) => item.name),
    });
    const rawContent = "rawContent" in current && typeof current.rawContent === "string" ? current.rawContent : "";
    const review = buildNovelReviewPayload({
      rawContent,
      finalContent: current.content,
      summary: postprocess.summary.summary,
      openThreads: postprocess.summary.openThreads,
      consistencyRisks: postprocess.consistencyStatus.risks,
    });
    const saved = await prisma.$transaction(async (tx) => {
      const chapter = await tx.novelChapter.update({
        where: { id: current.id },
        data: {
          summary: postprocess.summary.summary,
          openThreads: postprocess.summary.openThreads,
          consistencyJson: postprocess.consistencyStatus as any,
          aiReview: review.aiReview,
          aiActionItems: review.aiActionItems,
          modificationRate: review.modificationRate,
        },
      });
      const txWithAssets = tx as typeof tx & {
        novelKnowledgeFact?: { upsert: (args: unknown) => Promise<unknown> };
      };
      await Promise.all(postprocess.facts.map((fact) => txWithAssets.novelKnowledgeFact?.upsert({
        where: {
          projectId_chapterIndex_subject_predicate_object: {
            projectId: project.id,
            chapterIndex: fact.chapterIndex ?? current.chapterIndex,
            subject: fact.subject,
            predicate: fact.predicate,
            object: fact.object,
          },
        },
        create: {
          projectId: project.id,
          chapterId: current.id,
          chapterIndex: fact.chapterIndex ?? current.chapterIndex,
          subject: fact.subject,
          predicate: fact.predicate,
          object: fact.object,
          sourceExcerpt: fact.sourceExcerpt,
          confidence: fact.confidence,
          status: fact.status,
        },
        update: {
          sourceExcerpt: fact.sourceExcerpt,
          confidence: fact.confidence,
          status: fact.status,
        },
      }) ?? Promise.resolve()));
      await syncNovelNarrativeLedgersForChapter({
        store: tx,
        projectId: project.id,
        chapterId: current.id,
        chapterIndex: current.chapterIndex,
        content: current.content,
        foreshadowItems: postprocess.foreshadowItems,
      });
      await syncNovelContinuityAssetsForChapter({
        store: tx,
        projectId: project.id,
        chapterIndex: current.chapterIndex,
        title: current.title,
        content: current.content,
        eventCards: postprocess.consistencyStatus.chapterAssets.eventCards,
        knownCharacters: knownCharacters.map((item) => item.name),
        knownLocations: knownLocations.map((item) => item.name),
      });
      return chapter;
    });
    return { success: true, data: { chapter: serializeNovelWorkbenchChapter(saved) } };
  });

  app.post("/api/workflow/novels/tasks/:taskId/cancel", async (req, reply) => {
    const userId = req.userId;
    const parsed = taskParamsSchema.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const task = await prisma.novelTask.findFirst({ where: { id: parsed.data.taskId, userId } });
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    if (task.status !== NOVEL_TASK_STATUS.queued && task.status !== NOVEL_TASK_STATUS.running) {
      return reply.code(409).send({ error: "任务已结束，无法取消" });
    }
    const updated = await prisma.novelTask.update({
      where: { id: task.id },
      data: { status: NOVEL_TASK_STATUS.cancelled, error: "用户已取消", cancelledAt: new Date() },
    });
    return { success: true, data: { task: serializeTask(updated) } };
  });
}
