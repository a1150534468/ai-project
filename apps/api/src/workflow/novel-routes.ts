import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createBillingClient, InsufficientBalanceError } from "@yc/billing";
import { getPrisma } from "@yc/db";
import { createNovelGenerator, type NovelGenerator } from "./novel-generation.js";
import { visibleCharCount } from "./novel-billable.js";
import { NOVEL_COVER_RESOURCE_KEY, NOVEL_RESOURCE_KEY, NOVEL_STAGE_KINDS, NOVEL_TASK_STATUS } from "./novel-types.js";
import type { NovelStageKind } from "./novel-types.js";
import {
  ensureProjectSections,
  estimateReserveChars,
  getProjectDetail,
  nextChapterIndex,
  refreshNovelLongMemory,
  refreshNovelVectorMemoryBestEffort,
  reserveAndCreateTask,
  runNovelTask,
  serializeTask,
  type BillingForNovels,
  type NovelTaskRow,
} from "./novel-task-runner.js";

type ScheduleTask = (work: () => Promise<void>) => void;

interface NovelResourcePriceRow {
  readonly resourceKey: string;
  readonly displayName: string;
  readonly pricingType: "PER_CALL" | "PER_UNIT" | "VIDEO_IO";
  readonly rate: number;
  readonly perUnits: number;
  readonly enabled: boolean;
}

type NovelWorkflowBilling = BillingForNovels & {
  readonly listResourcePrices?: () => Promise<{ data: NovelResourcePriceRow[] }>;
};

interface NovelWorkflowRouteDeps {
  readonly prisma?: PrismaClient;
  readonly billing?: NovelWorkflowBilling;
  readonly generator?: NovelGenerator;
  readonly scheduleTask?: ScheduleTask;
}

const DEFAULT_NOVEL_TEXT_PRICE: NovelResourcePriceRow = {
  resourceKey: NOVEL_RESOURCE_KEY,
  displayName: "小说文字生成",
  pricingType: "PER_UNIT",
  rate: 1,
  perUnits: 1000,
  enabled: true,
};

const DEFAULT_NOVEL_COVER_PRICE: NovelResourcePriceRow = {
  resourceKey: NOVEL_COVER_RESOURCE_KEY,
  displayName: "小说封面生成",
  pricingType: "PER_CALL",
  rate: 10,
  perUnits: 1,
  enabled: true,
};

const projectParamsSchema = z.object({ projectId: z.string().trim().min(1) });
const taskParamsSchema = z.object({ taskId: z.string().trim().min(1) });
const stageParamsSchema = projectParamsSchema.extend({
  kind: z.enum(NOVEL_STAGE_KINDS),
});
const chapterParamsSchema = projectParamsSchema.extend({
  chapterIndex: z.coerce.number().int().min(1).max(9999),
});
const textListSchema = z.array(z.string().trim().max(40)).max(120).optional().default([]);
const initialSettingsSchema = z.object({
  channel: z.string().trim().max(40).optional().default(""),
  coreRequirement: z.string().trim().max(3000).optional().default(""),
  platforms: textListSchema,
  topics: textListSchema,
  perspective: z.string().trim().max(40).optional().default(""),
  styleMode: z.string().trim().max(40).optional().default(""),
  era: z.string().trim().max(40).optional().default(""),
  hasCheat: z.boolean().optional(),
  styleTags: z.array(z.string().trim().max(40)).max(5).optional().default([]),
  language: z.string().trim().max(20).optional().default(""),
  chapterCount: z.number().int().min(1).max(9999).optional(),
  chapterChars: z.number().int().min(500).max(50000).optional(),
});
const createProjectSchema = z.object({
  title: z.string().trim().min(1).max(80),
  genre: z.string().trim().max(40).optional().default(""),
  initialSettings: initialSettingsSchema.optional(),
});
const updateProjectSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  genre: z.string().trim().max(40).optional(),
});
const saveSectionSchema = z.object({
  displayText: z.string().max(200_000).default(""),
});
const stageGenerateSchema = z.object({
  prompt: z.string().trim().max(3000).optional().default(""),
  targetCount: z.number().int().min(1).max(500).optional(),
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
  content: z.string().max(500_000).optional().default(""),
});

function scheduledRunner(app: FastifyInstance): ScheduleTask {
  return (work) => {
    void work().catch((error) => app.log.error(error));
  };
}

async function findOwnedProject(prisma: PrismaClient, userId: string, projectId: string) {
  return prisma.novelProject.findFirst({ where: { id: projectId, userId } });
}

function billingUnavailable(app: FastifyInstance, error: unknown, message: string) {
  app.log.error(error);
  return { error: message };
}

function compactList(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function pushInitialBlock(blocks: string[], heading: string, value: string): void {
  const text = value.trim();
  if (text) blocks.push(`【${heading}】\n${text}`);
}

function composeInitialSettingsText(settings: z.infer<typeof initialSettingsSchema> | undefined): string {
  if (!settings) return "";
  const blocks: string[] = [];
  pushInitialBlock(blocks, "核心要求", settings.coreRequirement);
  pushInitialBlock(blocks, "频道", settings.channel);
  pushInitialBlock(blocks, "平台", compactList(settings.platforms).join(" / "));
  pushInitialBlock(blocks, "题材", compactList(settings.topics).join(" / "));
  pushInitialBlock(blocks, "视角", settings.perspective);
  pushInitialBlock(blocks, "文风模式", settings.styleMode);
  pushInitialBlock(blocks, "年代", settings.era);
  if (settings.hasCheat !== undefined) pushInitialBlock(blocks, "是否金手指", settings.hasCheat ? "是" : "否");
  pushInitialBlock(blocks, "风格标签", compactList(settings.styleTags).join(" / "));
  pushInitialBlock(blocks, "语言", settings.language);
  const chapterLines = [
    settings.chapterCount !== undefined ? `章节数：${settings.chapterCount}` : "",
    settings.chapterChars !== undefined ? `每章字数：${settings.chapterChars}` : "",
  ].filter(Boolean);
  pushInitialBlock(blocks, "章节规划", chapterLines.join("\n"));
  return blocks.join("\n\n");
}

function resourcePrice(rows: readonly NovelResourcePriceRow[], fallback: NovelResourcePriceRow): NovelResourcePriceRow {
  const found = rows.find((row) => row.resourceKey === fallback.resourceKey);
  return found ? { ...fallback, ...found, resourceKey: fallback.resourceKey } : fallback;
}

export async function novelWorkflowRoutes(app: FastifyInstance, deps: NovelWorkflowRouteDeps = {}) {
  const prisma = deps.prisma ?? getPrisma();
  const billing = deps.billing ?? createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });
  const generator = deps.generator ?? createNovelGenerator();
  const scheduleTask = deps.scheduleTask ?? scheduledRunner(app);

  function enqueue(task: NovelTaskRow): void {
    scheduleTask(() => runNovelTask({ prisma, billing, generator, task }));
  }

  app.get("/api/workflow/novels/pricing", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!billing.listResourcePrices) {
      return {
        success: true,
        data: {
          novelText: DEFAULT_NOVEL_TEXT_PRICE,
          cover: DEFAULT_NOVEL_COVER_PRICE,
        },
      };
    }
    try {
      const rows = (await billing.listResourcePrices()).data ?? [];
      return {
        success: true,
        data: {
          novelText: resourcePrice(rows, DEFAULT_NOVEL_TEXT_PRICE),
          cover: resourcePrice(rows, DEFAULT_NOVEL_COVER_PRICE),
        },
      };
    } catch (error) {
      return reply.code(502).send(billingUnavailable(app, error, "获取小说计价失败"));
    }
  });

  app.get("/api/workflow/novels/projects", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const rows = await prisma.novelProject.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: 30,
    });
    return { success: true, data: rows.map((project) => ({
      id: project.id,
      title: project.title,
      genre: project.genre,
      status: project.status,
      updatedAt: project.updatedAt.toISOString(),
    })) };
  });

  app.post("/api/workflow/novels/projects", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "请输入小说标题" });
    const project = await prisma.novelProject.create({
      data: { userId, title: parsed.data.title, genre: parsed.data.genre },
    });
    await ensureProjectSections(prisma, project.id);
    const initialSettingsText = composeInitialSettingsText(parsed.data.initialSettings);
    if (initialSettingsText) {
      const settings = await prisma.novelSection.upsert({
        where: { projectId_kind: { projectId: project.id, kind: "settings" } },
        create: {
          projectId: project.id,
          kind: "settings",
          status: "draft",
          displayText: initialSettingsText,
          billableChars: 0,
        },
        update: {
          status: "draft",
          displayText: initialSettingsText,
          billableChars: 0,
        },
      });
      await prisma.novelSectionVersion.create({
        data: {
          sectionId: settings.id,
          displayText: initialSettingsText,
          billableChars: 0,
        },
      });
    }
    await refreshNovelVectorMemoryBestEffort(prisma, project.id);
    const detail = await getProjectDetail(prisma, userId, project.id);
    return reply.code(201).send({ success: true, data: detail });
  });

  app.get("/api/workflow/novels/projects/:projectId", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const parsed = projectParamsSchema.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const detail = await getProjectDetail(prisma, userId, parsed.data.projectId);
    if (!detail) return reply.code(404).send({ error: "项目不存在" });
    return { success: true, data: detail };
  });

  app.patch("/api/workflow/novels/projects/:projectId", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
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
      },
    });
    const detail = await getProjectDetail(prisma, userId, project.id);
    return { success: true, data: detail };
  });

  app.get("/api/workflow/novels/projects/:projectId/tasks", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
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

  app.put("/api/workflow/novels/projects/:projectId/stages/:kind", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const params = stageParamsSchema.safeParse(req.params);
    const body = saveSectionSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const saved = await prisma.$transaction(async (tx) => {
      const section = await tx.novelSection.upsert({
        where: { projectId_kind: { projectId: project.id, kind: params.data.kind } },
        create: {
          projectId: project.id,
          kind: params.data.kind,
          status: "draft",
          displayText: body.data.displayText,
          billableChars: 0,
        },
        update: {
          status: "draft",
          displayText: body.data.displayText,
          billableChars: 0,
        },
      });
      await tx.novelSectionVersion.create({
        data: {
          sectionId: section.id,
          displayText: body.data.displayText,
          billableChars: 0,
        },
      });
      return section;
    });
    await refreshNovelVectorMemoryBestEffort(prisma, project.id);
    return { success: true, data: { section: {
      id: saved.id,
      kind: saved.kind,
      label: params.data.kind,
      status: saved.status,
      displayText: saved.displayText,
      billableChars: saved.billableChars,
      lastTaskId: saved.lastTaskId,
      updatedAt: saved.updatedAt.toISOString(),
    } } };
  });

  app.post("/api/workflow/novels/projects/:projectId/stages/:kind/generate", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const params = stageParamsSchema.safeParse(req.params);
    const body = stageGenerateSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    try {
      const task = await reserveAndCreateTask({
        prisma,
        billing,
        userId,
        projectId: project.id,
        targetKind: params.data.kind,
        payload: {
          prompt: body.data.prompt,
          ...(body.data.targetCount !== undefined ? { targetCount: body.data.targetCount } : {}),
        },
        estimateChars: estimateReserveChars(params.data.kind, undefined, body.data.targetCount),
      });
      enqueue(task);
      return reply.code(202).send({ success: true, data: { task: serializeTask(task) } });
    } catch (error) {
      if (error instanceof InsufficientBalanceError) return reply.code(402).send({ error: "积分不足，请充值" });
      return reply.code(502).send(billingUnavailable(app, error, "创建小说任务失败"));
    }
  });

  app.post("/api/workflow/novels/projects/:projectId/chapters/generate", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const params = projectParamsSchema.safeParse(req.params);
    const body = chapterGenerateSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const chapterIndex = body.data.chapterIndex ?? await nextChapterIndex(prisma, project.id);
    try {
      const task = await reserveAndCreateTask({
        prisma,
        billing,
        userId,
        projectId: project.id,
        targetKind: "chapter",
        payload: { ...body.data, chapterIndex },
        estimateChars: estimateReserveChars("chapter", body.data.targetChars),
      });
      enqueue(task);
      return reply.code(202).send({ success: true, data: { task: serializeTask(task) } });
    } catch (error) {
      if (error instanceof InsufficientBalanceError) return reply.code(402).send({ error: "积分不足，请充值" });
      return reply.code(502).send(billingUnavailable(app, error, "创建章节任务失败"));
    }
  });

  app.put("/api/workflow/novels/projects/:projectId/chapters/:chapterIndex", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const params = chapterParamsSchema.safeParse(req.params);
    const body = saveChapterSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const saved = await prisma.$transaction(async (tx) => {
      const content = body.data.content;
      const chapter = await tx.novelChapter.upsert({
        where: { projectId_chapterIndex: { projectId: project.id, chapterIndex: params.data.chapterIndex } },
        create: {
          projectId: project.id,
          chapterIndex: params.data.chapterIndex,
          title: body.data.title || `第 ${params.data.chapterIndex} 章`,
          summary: body.data.summary,
          content,
          status: content.trim() ? "ready" : "draft",
          billableChars: visibleCharCount(content),
        },
        update: {
          title: body.data.title,
          summary: body.data.summary,
          content,
          status: content.trim() ? "ready" : "draft",
          billableChars: visibleCharCount(content),
        },
      });
      await refreshNovelLongMemory({
        store: tx,
        projectId: project.id,
        sourceTaskId: chapter.lastTaskId,
        recordVersion: false,
      });
      return chapter;
    });
    await refreshNovelVectorMemoryBestEffort(prisma, project.id);
    return { success: true, data: { chapter: {
      id: saved.id,
      volumeIndex: saved.volumeIndex,
      chapterIndex: saved.chapterIndex,
      title: saved.title,
      summary: saved.summary,
      content: saved.content,
      status: saved.status,
      billableChars: saved.billableChars,
      lastTaskId: saved.lastTaskId,
      updatedAt: saved.updatedAt.toISOString(),
    } } };
  });

  app.post("/api/workflow/novels/projects/:projectId/outline/auto", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const reservedTasks: NovelTaskRow[] = [];
    try {
      for (const kind of NOVEL_STAGE_KINDS) {
        reservedTasks.push(await reserveAndCreateTask({
          prisma,
          billing,
          userId,
          projectId: project.id,
          targetKind: kind,
          payload: { prompt: "" },
          estimateChars: estimateReserveChars(kind as NovelStageKind),
        }));
      }
      scheduleTask(async () => {
        for (const task of reservedTasks) {
          await runNovelTask({ prisma, billing, generator, task });
        }
      });
      return reply.code(202).send({ success: true, data: { tasks: reservedTasks.map(serializeTask) } });
    } catch (error) {
      await Promise.all(reservedTasks.map((task) => billing.refundResource(task.operationId).catch(() => undefined)));
      if (error instanceof InsufficientBalanceError) return reply.code(402).send({ error: "积分不足，请充值" });
      return reply.code(502).send(billingUnavailable(app, error, "创建自动大纲任务失败"));
    }
  });

  app.post("/api/workflow/novels/tasks/:taskId/cancel", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
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
    await billing.refundResource(task.operationId).catch((error) => {
      app.log.warn({ err: error, taskId: task.id }, "novel task cancellation refund failed");
    });
    return { success: true, data: { task: serializeTask(updated) } };
  });
}
