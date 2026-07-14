import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma, getRedis } from "@ai-assistant/db";
import { novelAssistedRunSchema, novelAutopilotStartSchema } from "@ai-assistant/novel-workflow/contracts";
import { novelRunChannel, serializeNovelRunEvent } from "./events.js";
import { dispatchNovelOutboxBatch } from "./outbox.js";
import { createNovelRun, createNextNovelStep, serializeNovelRun } from "./run-store.js";
import { registerNovelResourceRoutes } from "./resource-routes.js";
import { registerNovelExportRoutes } from "./export.js";

const projectParamsSchema = z.object({ projectId: z.string().min(1) });
const runParamsSchema = projectParamsSchema.extend({ runId: z.string().min(1) });
const eventsQuerySchema = z.object({ after: z.coerce.number().int().nonnegative().default(0) });

async function ownedProject(prisma: PrismaClient, userId: string, projectId: string) {
  return prisma.novelProject.findFirst({ where: { id: projectId, userId } });
}

async function ownedRun(prisma: PrismaClient, userId: string, projectId: string, runId: string) {
  return prisma.novelRun.findFirst({ where: { id: runId, projectId, userId } });
}

function userIdOf(req: unknown): string {
  return (req as { userId?: string }).userId ?? "";
}

function activeRunConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function novelEngineRoutes(app: FastifyInstance, options: { prisma?: PrismaClient } = {}) {
  const prisma = options.prisma ?? getPrisma();

  app.post("/api/workflow/novels/projects/:projectId/runs/assisted", async (req, reply) => {
    const userId = userIdOf(req);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const params = projectParamsSchema.safeParse(req.params);
    const body = novelAssistedRunSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await ownedProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    try {
      const created = await createNovelRun({
        prisma,
        projectId: project.id,
        userId,
        mode: "assisted",
        startChapter: body.data.chapterIndex,
        targetChapters: Math.max(project.targetChapters, body.data.chapterIndex),
        targetCharsPerChapter: body.data.targetChars,
        autoReview: false,
        input: body.data,
      });
      await dispatchNovelOutboxBatch(prisma).catch((error) => app.log.warn({ err: error }, "novel outbox dispatch deferred"));
      return reply.code(202).send({ success: true, data: { run: serializeNovelRun(created.run) } });
    } catch (error) {
      if (activeRunConflict(error)) return reply.code(409).send({ error: "当前作品已有运行中的小说任务" });
      throw error;
    }
  });

  app.post("/api/workflow/novels/projects/:projectId/runs/autopilot", async (req, reply) => {
    const userId = userIdOf(req);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const params = projectParamsSchema.safeParse(req.params);
    const body = novelAutopilotStartSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await ownedProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const latest = await prisma.novelChapter.findFirst({ where: { projectId: project.id }, orderBy: { chapterIndex: "desc" } });
    const startChapter = body.data.startChapter ?? (latest?.chapterIndex ?? 0) + 1;
    if (startChapter > body.data.targetChapters) return reply.code(400).send({ error: "起始章节不能超过目标章节" });
    try {
      const created = await createNovelRun({
        prisma,
        projectId: project.id,
        userId,
        mode: "autopilot",
        startChapter,
        targetChapters: body.data.targetChapters,
        targetCharsPerChapter: body.data.targetCharsPerChapter,
        autoReview: body.data.autoReview,
      });
      await prisma.novelProject.update({
        where: { id: project.id },
        data: { targetChapters: body.data.targetChapters, targetCharsPerChapter: body.data.targetCharsPerChapter, autopilotStatus: "queued" },
      });
      await dispatchNovelOutboxBatch(prisma).catch((error) => app.log.warn({ err: error }, "novel outbox dispatch deferred"));
      return reply.code(202).send({ success: true, data: { run: serializeNovelRun(created.run) } });
    } catch (error) {
      if (activeRunConflict(error)) return reply.code(409).send({ error: "当前作品已有运行中的小说任务" });
      throw error;
    }
  });

  app.get("/api/workflow/novels/projects/:projectId/runs", async (req, reply) => {
    const userId = userIdOf(req);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await ownedProject(prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const runs = await prisma.novelRun.findMany({ where: { projectId: project.id, userId }, orderBy: { updatedAt: "desc" }, take: 30 });
    return { success: true, data: { runs: runs.map(serializeNovelRun) } };
  });

  app.get("/api/workflow/novels/projects/:projectId/runs/:runId", async (req, reply) => {
    const userId = userIdOf(req);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const params = runParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const run = await prisma.novelRun.findFirst({
      where: { id: params.data.runId, projectId: params.data.projectId, userId },
      include: { steps: { orderBy: { sequence: "asc" } } },
    });
    if (!run) return reply.code(404).send({ error: "运行不存在" });
    return {
      success: true,
      data: {
        run: serializeNovelRun(run),
        steps: run.steps.map((step) => ({ ...step, createdAt: step.createdAt.toISOString(), updatedAt: step.updatedAt.toISOString(), startedAt: step.startedAt?.toISOString() ?? null, completedAt: step.completedAt?.toISOString() ?? null })),
      },
    };
  });

  app.post("/api/workflow/novels/projects/:projectId/runs/:runId/pause", async (req, reply) => {
    const userId = userIdOf(req);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const params = runParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const run = await ownedRun(prisma, userId, params.data.projectId, params.data.runId);
    if (!run) return reply.code(404).send({ error: "运行不存在" });
    const updated = await prisma.novelRun.update({ where: { id: run.id }, data: { pauseRequested: true, status: run.status === "queued" ? "paused" : run.status } });
    await prisma.novelProject.update({ where: { id: run.projectId }, data: { autopilotStatus: "paused" } });
    return { success: true, data: { run: serializeNovelRun(updated) } };
  });

  app.post("/api/workflow/novels/projects/:projectId/runs/:runId/cancel", async (req, reply) => {
    const userId = userIdOf(req);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const params = runParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const run = await ownedRun(prisma, userId, params.data.projectId, params.data.runId);
    if (!run) return reply.code(404).send({ error: "运行不存在" });
    const updated = await prisma.novelRun.update({ where: { id: run.id }, data: { cancelRequested: true, status: "cancelled", completedAt: new Date() } });
    await prisma.novelRunStep.updateMany({ where: { runId: run.id, status: "queued" }, data: { status: "cancelled", completedAt: new Date() } });
    await prisma.novelProject.update({ where: { id: run.projectId }, data: { autopilotStatus: "cancelled" } });
    return { success: true, data: { run: serializeNovelRun(updated) } };
  });

  app.post("/api/workflow/novels/projects/:projectId/runs/:runId/resume", async (req, reply) => {
    const userId = userIdOf(req);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const params = runParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const run = await ownedRun(prisma, userId, params.data.projectId, params.data.runId);
    if (!run) return reply.code(404).send({ error: "运行不存在" });
    if (run.status === "cancelled" || run.status === "completed") return reply.code(409).send({ error: "该运行已结束，不能恢复" });
    const pending = await prisma.novelRunStep.findFirst({ where: { runId: run.id, status: { in: ["queued", "failed"] } }, orderBy: { sequence: "desc" } });
    if (pending) {
      await prisma.$transaction([
        prisma.novelRunStep.update({ where: { id: pending.id }, data: { status: "queued", error: null, workerId: null } }),
        prisma.novelCommandOutbox.upsert({
          where: { stepId: pending.id },
          create: { projectId: run.projectId, runId: run.id, stepId: pending.id, payload: { type: "engine-step", stepId: pending.id }, priority: pending.priority },
          update: { status: "pending", availableAt: new Date(), sentAt: null, lastError: null },
        }),
      ]);
    } else if (run.mode === "autopilot" && (run.currentChapter ?? 0) < run.targetChapters) {
      await createNextNovelStep({ prisma, runId: run.id, kind: "prepareChapter", chapterNumber: (run.currentChapter ?? 0) + 1, priority: 5 });
    }
    const updated = await prisma.novelRun.update({ where: { id: run.id }, data: { pauseRequested: false, cancelRequested: false, consecutiveFailures: 0, status: "queued", error: null, completedAt: null } });
    await prisma.novelProject.update({ where: { id: run.projectId }, data: { autopilotStatus: "queued" } });
    await dispatchNovelOutboxBatch(prisma).catch((error) => app.log.warn({ err: error }, "novel outbox dispatch deferred"));
    return { success: true, data: { run: serializeNovelRun(updated) } };
  });

  app.get("/api/workflow/novels/projects/:projectId/runs/:runId/events", async (req, reply) => {
    const userId = userIdOf(req);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const params = runParamsSchema.safeParse(req.params);
    const query = eventsQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "参数不合法" });
    const run = await ownedRun(prisma, userId, params.data.projectId, params.data.runId);
    if (!run) return reply.code(404).send({ error: "运行不存在" });
    const events = await prisma.novelRunEvent.findMany({ where: { runId: run.id, sequence: { gt: query.data.after } }, orderBy: { sequence: "asc" }, take: 500 });
    return { success: true, data: { events: events.map(serializeNovelRunEvent), cursor: events.at(-1)?.sequence ?? query.data.after } };
  });

  app.get("/api/workflow/novels/projects/:projectId/runs/:runId/events/stream", async (req, reply) => {
    const userId = userIdOf(req);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const params = runParamsSchema.safeParse(req.params);
    const query = eventsQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "参数不合法" });
    const run = await ownedRun(prisma, userId, params.data.projectId, params.data.runId);
    if (!run) return reply.code(404).send({ error: "运行不存在" });

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let cursor = Math.max(query.data.after, Number(req.headers["last-event-id"] ?? 0) || 0);
    let flushing = false;
    const subscriber = getRedis().duplicate();
    const flush = async () => {
      if (flushing || reply.raw.destroyed) return;
      flushing = true;
      try {
        const events = await prisma.novelRunEvent.findMany({ where: { runId: run.id, sequence: { gt: cursor } }, orderBy: { sequence: "asc" }, take: 200 });
        for (const event of events) {
          const serialized = serializeNovelRunEvent(event);
          reply.raw.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(serialized)}\n\n`);
          cursor = event.sequence;
        }
      } finally {
        flushing = false;
      }
    };
    const triggerFlush = () => { void flush().catch((error) => app.log.warn({ err: error, runId: run.id }, "novel SSE database flush failed")); };
    subscriber.on("message", triggerFlush);
    void subscriber.subscribe(novelRunChannel(run.id)).catch((error) => app.log.warn({ err: error, runId: run.id }, "novel SSE redis subscription unavailable; polling database"));
    await flush();
    const poller = setInterval(triggerFlush, 2_000);
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
    }, 15_000);
    await new Promise<void>((resolve) => {
      req.raw.once("close", resolve);
      req.raw.once("error", resolve);
    });
    clearInterval(poller);
    clearInterval(heartbeat);
    await subscriber.unsubscribe(novelRunChannel(run.id)).catch(() => undefined);
    subscriber.disconnect();
  });

  await registerNovelResourceRoutes(app, { prisma });
  await registerNovelExportRoutes(app, { prisma });
}
