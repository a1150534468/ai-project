import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createBillingClient, InsufficientBalanceError } from "@ai-assistant/billing";
import { getPrisma } from "@ai-assistant/db";
import { createNovelGenerator, type NovelGenerator } from "./novel-generation.js";
import { visibleCharCount } from "./novel-billable.js";
import { buildNovelChapterPostprocessPayload } from "./novel-postprocess.js";
import { buildNovelReviewPayload, estimateNovelModificationRate } from "./novel-review.js";
import { NOVEL_COVER_RESOURCE_KEY, NOVEL_RESOURCE_KEY, NOVEL_STAGE_KINDS, NOVEL_TASK_STATUS } from "./novel-types.js";
import type { NovelStageKind } from "./novel-types.js";
import { getNovelWorkbench, serializeNovelWorkbenchChapter } from "./novel-workbench.js";
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
const reviewChapterSchema = z.object({
  status: z.enum(["pending", "approved", "revise"]).optional(),
  reviewNotes: z.string().max(20_000).optional().default(""),
  regenerateAi: z.boolean().optional().default(false),
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

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function extractKnownNamesFromSections(sections: readonly { kind: string; displayText: string }[]): { characters: string[]; locations: string[] } {
  const chars = sections.find((section) => section.kind === "chars")?.displayText ?? "";
  const world = sections.find((section) => section.kind === "world")?.displayText ?? "";
  const names = (text: string) => Array.from(new Set((text.match(/[\u4e00-\u9fff]{2,8}/gu) ?? []).slice(0, 30)));
  return { characters: names(chars), locations: names(world) };
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

  app.get("/api/workflow/novels/projects/:projectId/workbench", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const parsed = projectParamsSchema.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const workbench = await getNovelWorkbench(prisma, userId, parsed.data.projectId);
    if (!workbench) return reply.code(404).send({ error: "项目不存在" });
    return { success: true, data: workbench };
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
    return { success: true, data: { chapter: serializeNovelWorkbenchChapter(saved) } };
  });

  app.post("/api/workflow/novels/projects/:projectId/chapters/:chapterIndex/review", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
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
    const regenerated = body.data.regenerateAi ? buildNovelReviewPayload({
      rawContent: rawContent || current.content,
      finalContent: current.content,
      summary: current.summary,
      openThreads,
      consistencyRisks,
    }) : null;
    const saved = await prisma.novelChapter.update({
      where: { id: current.id },
      data: {
        reviewStatus: body.data.status ?? ("reviewStatus" in current && typeof current.reviewStatus === "string" ? current.reviewStatus : "pending"),
        reviewNotes: body.data.reviewNotes,
        reviewedAt: new Date(),
        modificationRate: estimateNovelModificationRate(rawContent || current.content, current.content),
        ...(regenerated ? { aiReview: regenerated.aiReview, aiActionItems: regenerated.aiActionItems } : {}),
      },
    });
    return { success: true, data: { chapter: serializeNovelWorkbenchChapter(saved) } };
  });

  app.post("/api/workflow/novels/projects/:projectId/chapters/:chapterIndex/analyze", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const params = chapterParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const [sections, chapters] = await Promise.all([
      prisma.novelSection.findMany({ where: { projectId: project.id } }),
      prisma.novelChapter.findMany({ where: { projectId: project.id }, orderBy: { chapterIndex: "asc" } }),
    ]);
    const current = chapters.find((chapter) => chapter.chapterIndex === params.data.chapterIndex);
    if (!current) return reply.code(404).send({ error: "章节不存在" });
    const knownNames = extractKnownNamesFromSections(sections);
    const postprocess = buildNovelChapterPostprocessPayload({
      projectTitle: project.title,
      chapterIndex: current.chapterIndex,
      title: current.title,
      content: current.content,
      knownCharacters: knownNames.characters,
      knownLocations: knownNames.locations,
    });
    const rawContent = "rawContent" in current && typeof current.rawContent === "string" && current.rawContent ? current.rawContent : current.content;
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
        novelForeshadowItem?: { upsert: (args: unknown) => Promise<unknown> };
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
      await Promise.all(postprocess.foreshadowItems.map((item) => txWithAssets.novelForeshadowItem?.upsert({
        where: { projectId_title: { projectId: project.id, title: item.title } },
        create: {
          projectId: project.id,
          introducedInChapterId: current.id,
          introducedInChapterIndex: item.introducedInChapterIndex ?? current.chapterIndex,
          title: item.title,
          description: item.description,
          expectedPayoffChapter: item.expectedPayoffChapter,
          status: item.status,
          relatedCharacter: item.relatedCharacter,
        },
        update: {
          description: item.description,
          expectedPayoffChapter: item.expectedPayoffChapter,
          status: item.status,
          relatedCharacter: item.relatedCharacter,
        },
      }) ?? Promise.resolve()));
      return chapter;
    });
    return { success: true, data: { chapter: serializeNovelWorkbenchChapter(saved) } };
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
