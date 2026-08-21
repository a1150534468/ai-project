import { Prisma, type PrismaClient } from "@prisma/client";
import { createBillingClient } from "@ai-assistant/billing";
import { completedNovelChapterCount } from "@ai-assistant/novel-workflow";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { captureNovelStructuredSnapshot, restoreNovelStructuredSnapshot } from "./checkpoint-snapshot.js";
import { syncNovelSetupAssets } from "./structured-sync.js";
import { requireUser } from "../auth/require-user.js";
import { refreshNovelVectorMemoryBestEffort } from "../workflow/novel/index.js";
import { backfillNovelContinuityAssets } from "./continuity-assets.js";
import { backfillNovelNarrativeLedgers } from "./narrative-ledger.js";
import { recalculateNovelChapterScores } from "./score-backfill.js";

const projectParams = z.object({ projectId: z.string().min(1) });
const entityParams = projectParams.extend({ entityId: z.string().min(1) });
const promptParams = projectParams.extend({ templateId: z.string().min(1) });
const checkpointParams = projectParams.extend({ checkpointId: z.string().min(1) });
const setupParams = projectParams.extend({ setupKind: z.enum(["bible", "characters", "locations", "plot"]) });
const setupSaveSchema = z.object({ data: z.unknown() });

async function requireProject(prisma: PrismaClient, userId: string, projectId: string) {
  return prisma.novelProject.findFirst({ where: { id: projectId, userId } });
}

const structureSchema = z.object({
  parentId: z.string().nullable().optional(),
  nodeType: z.enum(["book", "volume", "act", "chapter"]),
  title: z.string().trim().min(1).max(120),
  description: z.string().max(20_000).default(""),
  number: z.number().int().min(1).max(9999),
  startChapter: z.number().int().min(1).nullable().optional(),
  endChapter: z.number().int().min(1).nullable().optional(),
  outline: z.string().max(50_000).default(""),
  metadata: z.record(z.unknown()).default({}),
});

const characterSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.string().max(80).default(""),
  gender: z.string().max(40).default(""),
  age: z.string().max(40).default(""),
  description: z.string().max(20_000).default(""),
  appearance: z.string().max(10_000).default(""),
  personality: z.string().max(10_000).default(""),
  publicProfile: z.string().max(10_000).default(""),
  coreBelief: z.string().max(5000).default(""),
  coreMotivation: z.string().max(5000).default(""),
  innerLack: z.string().max(5000).default(""),
  moralTaboos: z.array(z.string().max(200)).max(50).default([]),
  voiceStyle: z.string().max(5000).default(""),
  state: z.record(z.unknown()).default({}),
});

const relationSchema = z.object({
  fromCharacterId: z.string().min(1),
  toCharacterId: z.string().min(1),
  relationType: z.string().trim().min(1).max(80),
  description: z.string().max(5000).default(""),
  strength: z.number().min(0).max(1).default(0.5),
});

const locationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(20_000).default(""),
  rules: z.string().max(20_000).default(""),
  metadata: z.record(z.unknown()).default({}),
});

const storylineSchema = z.object({
  title: z.string().trim().min(1).max(120),
  storylineType: z.string().max(40).default("main"),
  status: z.string().max(40).default("active"),
  goal: z.string().max(10_000).default(""),
  conflict: z.string().max(10_000).default(""),
  promiseTags: z.array(z.string().max(120)).max(100).default([]),
  aliases: z.array(z.string().max(120)).max(100).default([]),
});

const propSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(10_000).default(""),
  owner: z.string().max(120).default(""),
  location: z.string().max(120).default(""),
  status: z.string().max(40).default("active"),
  metadata: z.record(z.unknown()).default({}),
});

const milestoneSchema = z.object({
  chapterNumber: z.number().int().min(1).max(9999),
  title: z.string().trim().min(1).max(120),
  description: z.string().max(10_000).default(""),
  status: z.enum(["planned", "active", "completed", "cancelled"]).default("planned"),
});

const timelineSchema = z.object({
  chapterNumber: z.number().int().min(1).max(9999).nullable().optional(),
  timeLabel: z.string().max(120).default(""),
  title: z.string().trim().min(1).max(120),
  description: z.string().max(20_000).default(""),
  participants: z.array(z.string().max(120)).max(100).default([]),
});

const foreshadowSchema = z.object({
  introducedInChapterIndex: z.number().int().min(1).max(9999).nullable().optional(),
  title: z.string().trim().min(1).max(120),
  description: z.string().max(20_000).default(""),
  expectedPayoffChapter: z.number().int().min(0).max(9999).default(0),
  status: z.enum(["open", "hinted", "resolved", "abandoned"]).default("open"),
  relatedCharacter: z.string().max(120).default(""),
});

const debtSchema = z.object({
  debtType: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(120),
  description: z.string().max(20_000).default(""),
  introducedChapter: z.number().int().min(1).max(9999).nullable().optional(),
  dueChapter: z.number().int().min(1).max(9999).nullable().optional(),
  status: z.enum(["open", "resolved", "abandoned"]).default("open"),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
});

const propEventSchema = z.object({
  chapterNumber: z.number().int().min(1).max(9999).nullable().optional(),
  eventType: z.string().trim().min(1).max(80),
  description: z.string().max(10_000).default(""),
  stateAfter: z.record(z.unknown()).default({}),
});

const promptSchema = z.object({
  nodeKey: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(80),
  content: z.string().min(1).max(200_000),
  variables: z.array(z.string().max(120)).max(200).default([]),
  model: z.string().max(128).default(""),
  temperature: z.number().min(0).max(2).default(0.7),
  changeNote: z.string().max(1000).default(""),
});

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

let enabledModelCache: { expiresAt: number; models: Set<string> } | null = null;

async function isEnabledPlatformModel(model: string): Promise<boolean> {
  if (!model) return true;
  if (!enabledModelCache || enabledModelCache.expiresAt < Date.now()) {
    const billing = createBillingClient({ baseUrl: process.env.BILLING_BASE_URL!, token: process.env.BILLING_INTERNAL_TOKEN! });
    const response = await billing.listModels();
    enabledModelCache = {
      expiresAt: Date.now() + 30_000,
      models: new Set(response.data.filter((item) => item.enabled && !item.model.toLowerCase().includes("embedding")).map((item) => item.model)),
    };
  }
  return enabledModelCache.models.has(model);
}

function snapshotRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function snapshotRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function snapshotNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null || value === undefined ? Prisma.JsonNull : json(value);
}

async function hasActiveNovelRun(prisma: PrismaClient, projectId: string): Promise<boolean> {
  return Boolean(await prisma.novelRun.findFirst({
    where: { projectId, status: { in: ["queued", "planning", "writing", "validating", "postprocessing", "awaitingReview", "paused", "failed"] } },
    select: { id: true },
  }));
}

async function restoreCheckpointSnapshot(args: {
  readonly tx: Prisma.TransactionClient;
  readonly projectId: string;
  readonly branchName: string;
  readonly snapshot: unknown;
}) {
  const snapshot = snapshotRecord(args.snapshot);
  const projectData = snapshotRecord(snapshot.project);
  const chapters = snapshotRows(snapshot.chapters);
  await args.tx.novelProject.update({
    where: { id: args.projectId },
    data: {
      title: String(projectData.title ?? "未命名作品"),
      genre: String(projectData.genre ?? ""),
      premise: String(projectData.premise ?? ""),
      settings: json(projectData.settings ?? {}),
      generationPrefs: json(projectData.generationPrefs ?? {}),
      narrativeContract: json(projectData.narrativeContract ?? {}),
      storyPhase: String(projectData.storyPhase ?? "opening"),
      currentBranch: args.branchName,
    },
  });
  await args.tx.novelChapter.deleteMany({ where: { projectId: args.projectId } });
  for (const [index, chapter] of chapters.entries()) {
    const chapterIndex = Math.max(1, Math.round(snapshotNumber(chapter.chapterIndex, index + 1)));
    await args.tx.novelChapter.create({
      data: {
        projectId: args.projectId,
        chapterIndex,
        volumeIndex: Math.max(1, Math.round(snapshotNumber(chapter.volumeIndex, 1))),
        title: String(chapter.title ?? `第 ${chapterIndex} 章`),
        summary: String(chapter.summary ?? ""),
        outline: String(chapter.outline ?? ""),
        generationHint: String(chapter.generationHint ?? ""),
        executionPlan: nullableJson(chapter.executionPlan),
        microBeats: json(chapter.microBeats ?? []),
        content: String(chapter.content ?? ""),
        rawContent: String(chapter.rawContent ?? chapter.content ?? ""),
        openThreads: json(chapter.openThreads ?? []),
        contextSnapshot: nullableJson(chapter.contextSnapshot),
        generationMeta: nullableJson(chapter.generationMeta),
        consistencyJson: nullableJson(chapter.consistencyJson),
        status: String(chapter.status ?? "draft"),
        reviewStatus: String(chapter.reviewStatus ?? "pending"),
        reviewNotes: String(chapter.reviewNotes ?? ""),
        aiReview: String(chapter.aiReview ?? ""),
        aiActionItems: json(chapter.aiActionItems ?? []),
        modificationRate: snapshotNumber(chapter.modificationRate),
        billableChars: Math.max(0, Math.round(snapshotNumber(chapter.billableChars))),
        tensionScore: snapshotNumber(chapter.tensionScore),
        plotTension: snapshotNumber(chapter.plotTension),
        emotionalTension: snapshotNumber(chapter.emotionalTension),
        pacingTension: snapshotNumber(chapter.pacingTension),
        qualityScore: snapshotNumber(chapter.qualityScore),
      },
    });
  }
  await restoreNovelStructuredSnapshot(args.tx, args.projectId, snapshot.structured);
}

export async function registerNovelResourceRoutes(app: FastifyInstance, options: { prisma: PrismaClient }) {
  const { prisma } = options;

  // 本文件 48 个路由全部必须登录，挂插件级。钩子和它保护的路由同文件，
  // 这样 `resource-routes.test.ts` 单独注册本文件时守卫不会凭空消失。
  app.addHook("preHandler", requireUser);

  app.get("/api/workflow/novels/projects/:projectId/setup", async (req, reply) => {
    const userId = req.userId;
    const params = projectParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await requireProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const [bible, characters, relations, locations, storylines, structure, chapters, activeTask, latestTask] = await Promise.all([
      prisma.novelBible.findUnique({ where: { projectId: project.id }, include: { worldDimensions: { orderBy: { position: "asc" } }, styleNotes: { orderBy: { position: "asc" } } } }),
      prisma.novelCharacter.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" } }),
      prisma.novelCharacterRelation.findMany({ where: { projectId: project.id } }),
      prisma.novelLocation.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" } }),
      prisma.novelStoryline.findMany({ where: { projectId: project.id }, include: { milestones: { orderBy: { chapterNumber: "asc" } } } }),
      prisma.novelStructureNode.findMany({ where: { projectId: project.id }, orderBy: [{ nodeType: "asc" }, { number: "asc" }] }),
      prisma.novelChapter.findMany({ where: { projectId: project.id }, orderBy: { chapterIndex: "asc" } }),
      prisma.novelTask.findFirst({ where: { projectId: project.id, targetKind: { in: ["setupBible", "setupCharacters", "setupLocations", "setupPlot"] }, status: { in: ["queued", "running"] } }, orderBy: { createdAt: "desc" } }),
      prisma.novelTask.findFirst({ where: { projectId: project.id, targetKind: { in: ["setupBible", "setupCharacters", "setupLocations", "setupPlot"] } }, orderBy: { createdAt: "desc" } }),
    ]);
    const serializeSetupTask = (task: typeof activeTask) => task ? { ...task, createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString(), completedAt: task.completedAt?.toISOString() ?? null, cancelledAt: task.cancelledAt?.toISOString() ?? null } : null;
    return { success: true, data: { project: { id: project.id, setupStage: project.setupStage, setupCompleted: project.setupCompleted }, bible, characters, relations, locations, storylines, structure, chapters, activeTask: serializeSetupTask(activeTask), latestTask: serializeSetupTask(latestTask) } };
  });

  app.put("/api/workflow/novels/projects/:projectId/setup/:setupKind", async (req, reply) => {
    const userId = req.userId;
    const params = setupParams.safeParse(req.params);
    const body = setupSaveSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await requireProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const targetKind = ({ bible: "setupBible", characters: "setupCharacters", locations: "setupLocations", plot: "setupPlot" } as const)[params.data.setupKind];
    await syncNovelSetupAssets({ prisma, projectId: project.id, targetKind, value: body.data.data });
    return { success: true, data: { saved: true } };
  });

  app.post("/api/workflow/novels/projects/:projectId/setup/complete", async (req, reply) => {
    const userId = req.userId;
    const params = projectParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await requireProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const [bible, characters, locations, chapters] = await Promise.all([
      prisma.novelBible.count({ where: { projectId: project.id } }),
      prisma.novelCharacter.count({ where: { projectId: project.id } }),
      prisma.novelLocation.count({ where: { projectId: project.id } }),
      prisma.novelChapter.count({ where: { projectId: project.id } }),
    ]);
    if (!bible || !characters || !locations || !chapters) return reply.code(409).send({ error: "请先完成 Bible、人物、地图和剧情总纲" });
    const updated = await prisma.novelProject.update({ where: { id: project.id }, data: { setupStage: 5, setupCompleted: true } });
    return { success: true, data: { project: { id: updated.id, setupStage: updated.setupStage, setupCompleted: updated.setupCompleted } } };
  });

  app.get("/api/workflow/novels/projects/:projectId/structure", async (req, reply) => {
    const userId = req.userId;
    const parsed = projectParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, parsed.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const nodes = await prisma.novelStructureNode.findMany({ where: { projectId: parsed.data.projectId }, orderBy: [{ parentId: "asc" }, { number: "asc" }] });
    return { success: true, data: { nodes } };
  });

  app.post("/api/workflow/novels/projects/:projectId/structure", async (req, reply) => {
    const userId = req.userId;
    const params = projectParams.safeParse(req.params);
    const body = structureSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const node = await prisma.novelStructureNode.create({ data: { projectId: params.data.projectId, ...body.data, metadata: json(body.data.metadata) } });
    return reply.code(201).send({ success: true, data: { node } });
  });

  app.patch("/api/workflow/novels/projects/:projectId/structure/:entityId", async (req, reply) => {
    const userId = req.userId;
    const params = entityParams.safeParse(req.params);
    const body = structureSchema.partial().safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const found = await prisma.novelStructureNode.findFirst({ where: { id: params.data.entityId, projectId: params.data.projectId } });
    if (!found) return reply.code(404).send({ error: "结构节点不存在" });
    const node = await prisma.novelStructureNode.update({
      where: { id: found.id },
      data: { ...body.data, ...(body.data.metadata ? { metadata: json(body.data.metadata) } : {}) } as Prisma.NovelStructureNodeUncheckedUpdateInput,
    });
    return { success: true, data: { node } };
  });

  app.delete("/api/workflow/novels/projects/:projectId/structure/:entityId", async (req, reply) => {
    const userId = req.userId;
    const params = entityParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const deleted = await prisma.novelStructureNode.deleteMany({ where: { id: params.data.entityId, projectId: params.data.projectId } });
    if (!deleted.count) return reply.code(404).send({ error: "结构节点不存在" });
    return { success: true };
  });

  app.get("/api/workflow/novels/projects/:projectId/characters", async (req, reply) => {
    const userId = req.userId;
    const parsed = projectParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, parsed.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const [characters, relations] = await Promise.all([
      prisma.novelCharacter.findMany({ where: { projectId: parsed.data.projectId }, orderBy: [{ role: "asc" }, { name: "asc" }] }),
      prisma.novelCharacterRelation.findMany({ where: { projectId: parsed.data.projectId } }),
    ]);
    return { success: true, data: { characters, relations } };
  });

  app.post("/api/workflow/novels/projects/:projectId/characters", async (req, reply) => {
    const userId = req.userId;
    const params = projectParams.safeParse(req.params);
    const body = characterSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const character = await prisma.novelCharacter.create({ data: { projectId: params.data.projectId, ...body.data, moralTaboos: body.data.moralTaboos, state: json(body.data.state) } });
    return reply.code(201).send({ success: true, data: { character } });
  });

  app.patch("/api/workflow/novels/projects/:projectId/characters/:entityId", async (req, reply) => {
    const userId = req.userId;
    const params = entityParams.safeParse(req.params);
    const body = characterSchema.partial().safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const found = await prisma.novelCharacter.findFirst({ where: { id: params.data.entityId, projectId: params.data.projectId } });
    if (!found) return reply.code(404).send({ error: "角色不存在" });
    const character = await prisma.novelCharacter.update({
      where: { id: found.id },
      data: { ...body.data, ...(body.data.state ? { state: json(body.data.state) } : {}) } as Prisma.NovelCharacterUncheckedUpdateInput,
    });
    return { success: true, data: { character } };
  });

  app.delete("/api/workflow/novels/projects/:projectId/characters/:entityId", async (req, reply) => {
    const userId = req.userId;
    const params = entityParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const deleted = await prisma.novelCharacter.deleteMany({ where: { id: params.data.entityId, projectId: params.data.projectId } });
    if (!deleted.count) return reply.code(404).send({ error: "角色不存在" });
    await refreshNovelVectorMemoryBestEffort(prisma, params.data.projectId);
    return { success: true };
  });

  app.post("/api/workflow/novels/projects/:projectId/character-relations", async (req, reply) => {
    const userId = req.userId;
    const params = projectParams.safeParse(req.params);
    const body = relationSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const count = await prisma.novelCharacter.count({ where: { projectId: params.data.projectId, id: { in: [body.data.fromCharacterId, body.data.toCharacterId] } } });
    if (count !== 2) return reply.code(400).send({ error: "关系角色不属于当前作品" });
    const relation = await prisma.novelCharacterRelation.upsert({
      where: { projectId_fromCharacterId_toCharacterId_relationType: { projectId: params.data.projectId, fromCharacterId: body.data.fromCharacterId, toCharacterId: body.data.toCharacterId, relationType: body.data.relationType } },
      create: { projectId: params.data.projectId, ...body.data },
      update: { description: body.data.description, strength: body.data.strength },
    });
    return reply.code(201).send({ success: true, data: { relation } });
  });

  app.delete("/api/workflow/novels/projects/:projectId/character-relations/:entityId", async (req, reply) => {
    const userId = req.userId;
    const params = entityParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const deleted = await prisma.novelCharacterRelation.deleteMany({ where: { id: params.data.entityId, projectId: params.data.projectId } });
    if (!deleted.count) return reply.code(404).send({ error: "人物关系不存在" });
    return { success: true };
  });

  app.get("/api/workflow/novels/projects/:projectId/locations", async (req, reply) => {
    const userId = req.userId;
    const parsed = projectParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, parsed.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    return { success: true, data: { locations: await prisma.novelLocation.findMany({ where: { projectId: parsed.data.projectId }, orderBy: { name: "asc" } }) } };
  });

  app.post("/api/workflow/novels/projects/:projectId/locations", async (req, reply) => {
    const userId = req.userId;
    const params = projectParams.safeParse(req.params);
    const body = locationSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const location = await prisma.novelLocation.create({ data: { projectId: params.data.projectId, ...body.data, metadata: json(body.data.metadata) } });
    return reply.code(201).send({ success: true, data: { location } });
  });

  app.patch("/api/workflow/novels/projects/:projectId/locations/:entityId", async (req, reply) => {
    const userId = req.userId;
    const params = entityParams.safeParse(req.params);
    const body = locationSchema.partial().safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const found = await prisma.novelLocation.findFirst({ where: { id: params.data.entityId, projectId: params.data.projectId } });
    if (!found) return reply.code(404).send({ error: "地点不存在" });
    const location = await prisma.novelLocation.update({ where: { id: found.id }, data: { ...body.data, ...(body.data.metadata ? { metadata: json(body.data.metadata) } : {}) } as Prisma.NovelLocationUncheckedUpdateInput });
    await refreshNovelVectorMemoryBestEffort(prisma, params.data.projectId);
    return { success: true, data: { location } };
  });

  app.delete("/api/workflow/novels/projects/:projectId/locations/:entityId", async (req, reply) => {
    const userId = req.userId;
    const params = entityParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const deleted = await prisma.novelLocation.deleteMany({ where: { id: params.data.entityId, projectId: params.data.projectId } });
    if (!deleted.count) return reply.code(404).send({ error: "地点不存在" });
    await refreshNovelVectorMemoryBestEffort(prisma, params.data.projectId);
    return { success: true };
  });

  app.get("/api/workflow/novels/projects/:projectId/storylines", async (req, reply) => {
    const userId = req.userId;
    const parsed = projectParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, parsed.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const storylines = await prisma.novelStoryline.findMany({ where: { projectId: parsed.data.projectId }, include: { milestones: { orderBy: { chapterNumber: "asc" } } }, orderBy: { createdAt: "asc" } });
    return { success: true, data: { storylines } };
  });

  app.post("/api/workflow/novels/projects/:projectId/storylines", async (req, reply) => {
    const userId = req.userId;
    const params = projectParams.safeParse(req.params);
    const body = storylineSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const storyline = await prisma.novelStoryline.create({ data: { projectId: params.data.projectId, ...body.data, promiseTags: body.data.promiseTags, aliases: body.data.aliases } });
    return reply.code(201).send({ success: true, data: { storyline } });
  });

  app.patch("/api/workflow/novels/projects/:projectId/storylines/:entityId", async (req, reply) => {
    const userId = req.userId;
    const params = entityParams.safeParse(req.params);
    const body = storylineSchema.partial().safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const found = await prisma.novelStoryline.findFirst({ where: { id: params.data.entityId, projectId: params.data.projectId } });
    if (!found) return reply.code(404).send({ error: "故事线不存在" });
    const storyline = await prisma.novelStoryline.update({ where: { id: found.id }, data: body.data });
    await refreshNovelVectorMemoryBestEffort(prisma, params.data.projectId);
    return { success: true, data: { storyline } };
  });

  app.delete("/api/workflow/novels/projects/:projectId/storylines/:entityId", async (req, reply) => {
    const userId = req.userId;
    const params = entityParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const deleted = await prisma.novelStoryline.deleteMany({ where: { id: params.data.entityId, projectId: params.data.projectId } });
    if (!deleted.count) return reply.code(404).send({ error: "故事线不存在" });
    await refreshNovelVectorMemoryBestEffort(prisma, params.data.projectId);
    return { success: true };
  });

  app.post("/api/workflow/novels/projects/:projectId/storylines/:entityId/milestones", async (req, reply) => {
    const userId = req.userId;
    const params = entityParams.safeParse(req.params);
    const body = milestoneSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const storyline = await prisma.novelStoryline.findFirst({ where: { id: params.data.entityId, projectId: params.data.projectId } });
    if (!storyline) return reply.code(404).send({ error: "故事线不存在" });
    const milestone = await prisma.novelStorylineMilestone.create({ data: { projectId: params.data.projectId, storylineId: storyline.id, ...body.data } });
    await refreshNovelVectorMemoryBestEffort(prisma, params.data.projectId);
    return reply.code(201).send({ success: true, data: { milestone } });
  });

  app.patch("/api/workflow/novels/projects/:projectId/storyline-milestones/:entityId", async (req, reply) => {
    const userId = req.userId;
    const params = entityParams.safeParse(req.params);
    const body = milestoneSchema.partial().safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const found = await prisma.novelStorylineMilestone.findFirst({ where: { id: params.data.entityId, projectId: params.data.projectId } });
    if (!found) return reply.code(404).send({ error: "故事线里程碑不存在" });
    const milestone = await prisma.novelStorylineMilestone.update({ where: { id: found.id }, data: body.data });
    await refreshNovelVectorMemoryBestEffort(prisma, params.data.projectId);
    return { success: true, data: { milestone } };
  });

  app.delete("/api/workflow/novels/projects/:projectId/storyline-milestones/:entityId", async (req, reply) => {
    const userId = req.userId;
    const params = entityParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const deleted = await prisma.novelStorylineMilestone.deleteMany({ where: { id: params.data.entityId, projectId: params.data.projectId } });
    if (!deleted.count) return reply.code(404).send({ error: "故事线里程碑不存在" });
    await refreshNovelVectorMemoryBestEffort(prisma, params.data.projectId);
    return { success: true };
  });

  app.get("/api/workflow/novels/projects/:projectId/props", async (req, reply) => {
    const userId = req.userId;
    const parsed = projectParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, parsed.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const props = await prisma.novelProp.findMany({ where: { projectId: parsed.data.projectId }, include: { events: { orderBy: { createdAt: "desc" } } }, orderBy: { name: "asc" } });
    return { success: true, data: { props } };
  });

  app.post("/api/workflow/novels/projects/:projectId/props", async (req, reply) => {
    const userId = req.userId;
    const params = projectParams.safeParse(req.params);
    const body = propSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const prop = await prisma.novelProp.create({ data: { projectId: params.data.projectId, ...body.data, metadata: json(body.data.metadata) } });
    return reply.code(201).send({ success: true, data: { prop } });
  });

  app.patch("/api/workflow/novels/projects/:projectId/props/:entityId", async (req, reply) => {
    const userId = req.userId;
    const params = entityParams.safeParse(req.params);
    const body = propSchema.partial().safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const found = await prisma.novelProp.findFirst({ where: { id: params.data.entityId, projectId: params.data.projectId } });
    if (!found) return reply.code(404).send({ error: "道具不存在" });
    const prop = await prisma.novelProp.update({ where: { id: found.id }, data: { ...body.data, ...(body.data.metadata ? { metadata: json(body.data.metadata) } : {}), source: "manual" } as Prisma.NovelPropUncheckedUpdateInput });
    return { success: true, data: { prop } };
  });

  app.delete("/api/workflow/novels/projects/:projectId/props/:entityId", async (req, reply) => {
    const userId = req.userId;
    const params = entityParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const deleted = await prisma.novelProp.deleteMany({ where: { id: params.data.entityId, projectId: params.data.projectId } });
    if (!deleted.count) return reply.code(404).send({ error: "道具不存在" });
    return { success: true };
  });

  app.post("/api/workflow/novels/projects/:projectId/props/:entityId/events", async (req, reply) => {
    const userId = req.userId;
    const params = entityParams.safeParse(req.params);
    const body = propEventSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const prop = await prisma.novelProp.findFirst({ where: { id: params.data.entityId, projectId: params.data.projectId } });
    if (!prop) return reply.code(404).send({ error: "道具不存在" });
    const event = await prisma.novelPropEvent.create({ data: { projectId: params.data.projectId, propId: prop.id, ...body.data, stateAfter: json(body.data.stateAfter) } });
    return reply.code(201).send({ success: true, data: { event } });
  });

  app.get("/api/workflow/novels/projects/:projectId/narrative-assets", async (req, reply) => {
    const userId = req.userId;
    const params = projectParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const [timeline, foreshadows, debts, events, causalEdges, facts, foreshadowEvents] = await Promise.all([
      prisma.novelTimelineEvent.findMany({ where: { projectId: params.data.projectId }, orderBy: [{ chapterNumber: "asc" }, { createdAt: "asc" }] }),
      prisma.novelForeshadowItem.findMany({ where: { projectId: params.data.projectId }, include: { events: { orderBy: { chapterIndex: "asc" } } }, orderBy: [{ status: "asc" }, { expectedPayoffChapter: "asc" }] }),
      prisma.novelNarrativeDebt.findMany({ where: { projectId: params.data.projectId }, orderBy: [{ status: "asc" }, { dueChapter: "asc" }] }),
      prisma.novelNarrativeEvent.findMany({ where: { projectId: params.data.projectId }, orderBy: [{ chapterNumber: "asc" }, { createdAt: "asc" }] }),
      prisma.novelCausalEdge.findMany({ where: { projectId: params.data.projectId }, orderBy: { createdAt: "asc" } }),
      prisma.novelKnowledgeFact.findMany({ where: { projectId: params.data.projectId }, orderBy: { updatedAt: "desc" }, take: 200 }),
      prisma.novelForeshadowEvent.findMany({ where: { projectId: params.data.projectId }, orderBy: [{ chapterIndex: "asc" }, { createdAt: "asc" }] }),
    ]);
    return { success: true, data: { timeline, foreshadows, debts, events, causalEdges, facts, foreshadowEvents } };
  });

  app.post("/api/workflow/novels/projects/:projectId/narrative-assets/backfill", async (req, reply) => {
    const userId = req.userId;
    const params = projectParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    if (await hasActiveNovelRun(prisma, params.data.projectId)) return reply.code(409).send({ error: "作品正在生成中，请等待运行结束后再补齐叙事资产" });
    const [continuity, ledgers, scores] = await Promise.all([
      backfillNovelContinuityAssets({ prisma, projectId: params.data.projectId }),
      backfillNovelNarrativeLedgers({ prisma, projectId: params.data.projectId }),
      recalculateNovelChapterScores({ prisma, projectId: params.data.projectId }),
    ]);
    await refreshNovelVectorMemoryBestEffort(prisma, params.data.projectId);
    return { success: true, data: { ...continuity, ...ledgers, ...scores } };
  });

  app.post("/api/workflow/novels/projects/:projectId/timeline", async (req, reply) => {
    const userId = req.userId;
    const params = projectParams.safeParse(req.params);
    const body = timelineSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const event = await prisma.novelTimelineEvent.create({ data: { projectId: params.data.projectId, ...body.data, participants: body.data.participants } });
    return reply.code(201).send({ success: true, data: { event } });
  });

  app.patch("/api/workflow/novels/projects/:projectId/timeline/:entityId", async (req, reply) => {
    const userId = req.userId;
    const params = entityParams.safeParse(req.params);
    const body = timelineSchema.partial().safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const found = await prisma.novelTimelineEvent.findFirst({ where: { id: params.data.entityId, projectId: params.data.projectId } });
    if (!found) return reply.code(404).send({ error: "时间线事件不存在" });
    const event = await prisma.novelTimelineEvent.update({ where: { id: found.id }, data: { ...body.data, source: "manual", sourceKey: null } });
    return { success: true, data: { event } };
  });

  app.delete("/api/workflow/novels/projects/:projectId/timeline/:entityId", async (req, reply) => {
    const userId = req.userId;
    const params = entityParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const deleted = await prisma.novelTimelineEvent.deleteMany({ where: { id: params.data.entityId, projectId: params.data.projectId } });
    if (!deleted.count) return reply.code(404).send({ error: "时间线事件不存在" });
    return { success: true };
  });

  app.post("/api/workflow/novels/projects/:projectId/foreshadows", async (req, reply) => {
    const userId = req.userId;
    const params = projectParams.safeParse(req.params);
    const body = foreshadowSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const item = await prisma.novelForeshadowItem.create({ data: { projectId: params.data.projectId, ...body.data } });
    return reply.code(201).send({ success: true, data: { item } });
  });

  app.patch("/api/workflow/novels/projects/:projectId/foreshadows/:entityId", async (req, reply) => {
    const userId = req.userId;
    const params = entityParams.safeParse(req.params);
    const body = foreshadowSchema.partial().safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const found = await prisma.novelForeshadowItem.findFirst({ where: { id: params.data.entityId, projectId: params.data.projectId } });
    if (!found) return reply.code(404).send({ error: "伏笔不存在" });
    const item = await prisma.novelForeshadowItem.update({ where: { id: found.id }, data: { ...body.data, source: "manual", sourceKey: null } });
    return { success: true, data: { item } };
  });

  app.delete("/api/workflow/novels/projects/:projectId/foreshadows/:entityId", async (req, reply) => {
    const userId = req.userId;
    const params = entityParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const deleted = await prisma.novelForeshadowItem.deleteMany({ where: { id: params.data.entityId, projectId: params.data.projectId } });
    if (!deleted.count) return reply.code(404).send({ error: "伏笔不存在" });
    return { success: true };
  });

  app.post("/api/workflow/novels/projects/:projectId/narrative-debts", async (req, reply) => {
    const userId = req.userId;
    const params = projectParams.safeParse(req.params);
    const body = debtSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const debt = await prisma.novelNarrativeDebt.create({ data: { projectId: params.data.projectId, ...body.data } });
    return reply.code(201).send({ success: true, data: { debt } });
  });

  app.patch("/api/workflow/novels/projects/:projectId/narrative-debts/:entityId", async (req, reply) => {
    const userId = req.userId;
    const params = entityParams.safeParse(req.params);
    const body = debtSchema.partial().safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const found = await prisma.novelNarrativeDebt.findFirst({ where: { id: params.data.entityId, projectId: params.data.projectId } });
    if (!found) return reply.code(404).send({ error: "叙事债务不存在" });
    const debt = await prisma.novelNarrativeDebt.update({ where: { id: found.id }, data: { ...body.data, source: "manual", sourceKey: null } });
    return { success: true, data: { debt } };
  });

  app.delete("/api/workflow/novels/projects/:projectId/narrative-debts/:entityId", async (req, reply) => {
    const userId = req.userId;
    const params = entityParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const deleted = await prisma.novelNarrativeDebt.deleteMany({ where: { id: params.data.entityId, projectId: params.data.projectId } });
    if (!deleted.count) return reply.code(404).send({ error: "叙事债务不存在" });
    return { success: true };
  });

  app.get("/api/workflow/novels/projects/:projectId/narrative-dashboard", async (req, reply) => {
    const userId = req.userId;
    const parsed = projectParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await requireProject(prisma, userId, parsed.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const [chapters, openForeshadows, storylines, debts, facts, characters] = await Promise.all([
      prisma.novelChapter.findMany({ where: { projectId: project.id }, orderBy: { chapterIndex: "asc" }, select: { chapterIndex: true, title: true, content: true, tensionScore: true, plotTension: true, emotionalTension: true, pacingTension: true, qualityScore: true, billableChars: true } }),
      prisma.novelForeshadowItem.count({ where: { projectId: project.id, status: { in: ["open", "hinted"] } } }),
      prisma.novelStoryline.count({ where: { projectId: project.id, status: "active" } }),
      prisma.novelNarrativeDebt.count({ where: { projectId: project.id, status: "open" } }),
      prisma.novelKnowledgeFact.count({ where: { projectId: project.id, status: "confirmed" } }),
      prisma.novelCharacter.count({ where: { projectId: project.id } }),
    ]);
    const completedChapters = completedNovelChapterCount(chapters);
    const completedRows = chapters.filter((chapter) => chapter.chapterIndex <= completedChapters);
    return { success: true, data: { project: { storyPhase: project.storyPhase, autopilotStatus: project.autopilotStatus, currentBranch: project.currentBranch }, stats: { chapters: completedChapters, totalChars: completedRows.reduce((sum, chapter) => sum + chapter.billableChars, 0), openForeshadows, storylines, debts, facts, characters }, tensionCurve: completedRows } };
  });

  app.get("/api/workflow/novels/projects/:projectId/checkpoints", async (req, reply) => {
    const userId = req.userId;
    const parsed = projectParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, parsed.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    return { success: true, data: { checkpoints: await prisma.novelCheckpoint.findMany({ where: { projectId: parsed.data.projectId }, orderBy: { createdAt: "desc" }, take: 100 }) } };
  });

  app.post("/api/workflow/novels/projects/:projectId/checkpoints", async (req, reply) => {
    const userId = req.userId;
    const params = projectParams.safeParse(req.params);
    const body = z.object({ label: z.string().max(120).default("手动检查点"), branchName: z.string().trim().min(1).max(80).optional() }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await requireProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const branchName = body.data.branchName ?? project.currentBranch ?? "main";
    const [chapters, structured] = await Promise.all([
      prisma.novelChapter.findMany({ where: { projectId: project.id }, orderBy: { chapterIndex: "asc" }, select: { chapterIndex: true, volumeIndex: true, title: true, summary: true, outline: true, generationHint: true, executionPlan: true, microBeats: true, content: true, rawContent: true, openThreads: true, contextSnapshot: true, generationMeta: true, consistencyJson: true, status: true, reviewStatus: true, reviewNotes: true, aiReview: true, aiActionItems: true, modificationRate: true, billableChars: true, tensionScore: true, plotTension: true, emotionalTension: true, pacingTension: true, qualityScore: true } }),
      captureNovelStructuredSnapshot(prisma, project.id),
    ]);
    const checkpoint = await prisma.$transaction(async (tx) => {
      await tx.novelCheckpoint.updateMany({ where: { projectId: project.id, branchName, isHead: true }, data: { isHead: false } });
      const parent = await tx.novelCheckpoint.findFirst({ where: { projectId: project.id, branchName }, orderBy: { createdAt: "desc" } });
      return tx.novelCheckpoint.create({ data: { projectId: project.id, branchName, parentId: parent?.id ?? null, chapterNumber: chapters.at(-1)?.chapterIndex ?? null, label: body.data.label, snapshot: json({ project: { title: project.title, genre: project.genre, premise: project.premise, settings: project.settings, generationPrefs: project.generationPrefs, narrativeContract: project.narrativeContract, storyPhase: project.storyPhase }, chapters, structured }), isHead: true } });
    });
    return reply.code(201).send({ success: true, data: { checkpoint } });
  });

  app.post("/api/workflow/novels/projects/:projectId/checkpoints/:checkpointId/rollback", async (req, reply) => {
    const userId = req.userId;
    const params = checkpointParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    if (await hasActiveNovelRun(prisma, params.data.projectId)) return reply.code(409).send({ error: "请先暂停并结束当前小说运行，再切换检查点" });
    const checkpoint = await prisma.novelCheckpoint.findFirst({ where: { id: params.data.checkpointId, projectId: params.data.projectId } });
    if (!checkpoint) return reply.code(404).send({ error: "检查点不存在" });
    await prisma.$transaction(async (tx) => {
      await restoreCheckpointSnapshot({ tx, projectId: params.data.projectId, branchName: checkpoint.branchName, snapshot: checkpoint.snapshot });
      await tx.novelCheckpoint.updateMany({ where: { projectId: params.data.projectId, branchName: checkpoint.branchName, isHead: true }, data: { isHead: false } });
      await tx.novelCheckpoint.update({ where: { id: checkpoint.id }, data: { isHead: true } });
    });
    return { success: true, data: { checkpointId: checkpoint.id } };
  });

  app.post("/api/workflow/novels/projects/:projectId/checkpoints/:checkpointId/branch", async (req, reply) => {
    const userId = req.userId;
    const params = checkpointParams.safeParse(req.params);
    const body = z.object({ branchName: z.string().trim().min(1).max(80) }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    if (await hasActiveNovelRun(prisma, params.data.projectId)) return reply.code(409).send({ error: "请先暂停并结束当前小说运行，再创建世界线" });
    const checkpoint = await prisma.novelCheckpoint.findFirst({ where: { id: params.data.checkpointId, projectId: params.data.projectId } });
    if (!checkpoint) return reply.code(404).send({ error: "检查点不存在" });
    if (await prisma.novelCheckpoint.findFirst({ where: { projectId: params.data.projectId, branchName: body.data.branchName } })) return reply.code(409).send({ error: "世界线名称已存在" });
    const branch = await prisma.$transaction(async (tx) => {
      const created = await tx.novelCheckpoint.create({ data: { projectId: params.data.projectId, branchName: body.data.branchName, parentId: checkpoint.id, chapterNumber: checkpoint.chapterNumber, label: `从 ${checkpoint.label} 分支`, snapshot: nullableJson(checkpoint.snapshot), isHead: true } });
      await restoreCheckpointSnapshot({ tx, projectId: params.data.projectId, branchName: body.data.branchName, snapshot: checkpoint.snapshot });
      return created;
    });
    return reply.code(201).send({ success: true, data: { checkpoint: branch } });
  });

  app.get("/api/workflow/novels/projects/:projectId/prompts", async (req, reply) => {
    const userId = req.userId;
    const parsed = projectParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, parsed.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const templates = await prisma.novelPromptTemplate.findMany({ where: { projectId: parsed.data.projectId }, include: { versions: { orderBy: { version: "desc" }, take: 20 } }, orderBy: [{ category: "asc" }, { name: "asc" }] });
    return { success: true, data: { templates } };
  });

  app.post("/api/workflow/novels/projects/:projectId/prompts", async (req, reply) => {
    const userId = req.userId;
    const params = projectParams.safeParse(req.params);
    const body = promptSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    if (body.data.model) {
      try {
        if (!await isEnabledPlatformModel(body.data.model)) return reply.code(400).send({ error: "只能绑定管理员已启用的平台模型" });
      } catch (error) {
        app.log.warn({ err: error }, "failed to validate novel prompt model");
        return reply.code(503).send({ error: "暂时无法校验平台模型，请稍后重试" });
      }
    }
    const template = await prisma.$transaction(async (tx) => {
      const current = await tx.novelPromptTemplate.findUnique({ where: { projectId_nodeKey: { projectId: params.data.projectId, nodeKey: body.data.nodeKey } } });
      const nextVersion = (current?.activeVersion ?? 0) + 1;
      const saved = await tx.novelPromptTemplate.upsert({ where: { projectId_nodeKey: { projectId: params.data.projectId, nodeKey: body.data.nodeKey } }, create: { projectId: params.data.projectId, nodeKey: body.data.nodeKey, name: body.data.name, category: body.data.category, content: body.data.content, variables: body.data.variables, model: body.data.model, temperature: body.data.temperature, activeVersion: nextVersion }, update: { name: body.data.name, category: body.data.category, content: body.data.content, variables: body.data.variables, model: body.data.model, temperature: body.data.temperature, activeVersion: nextVersion } });
      await tx.novelPromptVersion.create({ data: { templateId: saved.id, version: nextVersion, content: body.data.content, variables: body.data.variables, model: body.data.model, temperature: body.data.temperature, changeNote: body.data.changeNote } });
      return saved;
    });
    return reply.code(201).send({ success: true, data: { template } });
  });

  app.post("/api/workflow/novels/projects/:projectId/prompts/:templateId/rollback", async (req, reply) => {
    const userId = req.userId;
    const params = promptParams.safeParse(req.params);
    const body = z.object({ version: z.number().int().min(1) }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    if (!await requireProject(prisma, userId, params.data.projectId)) return reply.code(404).send({ error: "项目不存在" });
    const template = await prisma.novelPromptTemplate.findFirst({ where: { id: params.data.templateId, projectId: params.data.projectId } });
    if (!template) return reply.code(404).send({ error: "提示词不存在" });
    const version = await prisma.novelPromptVersion.findUnique({ where: { templateId_version: { templateId: template.id, version: body.data.version } } });
    if (!version) return reply.code(404).send({ error: "提示词版本不存在" });
    const saved = await prisma.novelPromptTemplate.update({ where: { id: template.id }, data: { content: version.content, variables: json(version.variables ?? []), model: version.model, temperature: version.temperature, activeVersion: version.version } });
    return { success: true, data: { template: saved } };
  });
}
