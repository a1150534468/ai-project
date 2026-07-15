import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createBillingClient } from "@ai-assistant/billing";
import { getPrisma, getRedis } from "@ai-assistant/db";
import { completedNovelChapterCount, nextNovelChapterIndex } from "@ai-assistant/novel-workflow";
import { novelAssistedRunSchema, novelAutopilotStartSchema } from "@ai-assistant/novel-workflow/contracts";
import { appendNovelRunEvent, novelRunChannel, serializeNovelRunEvent } from "./events.js";
import { dispatchNovelOutboxBatch } from "./outbox.js";
import { createNovelRun, createNextNovelStep, serializeNovelRun } from "./run-store.js";
import { registerNovelResourceRoutes } from "./resource-routes.js";
import { registerNovelExportRoutes } from "./export.js";
import { buildNovelRevisionGuidance } from "./revision.js";

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

export async function novelEngineRoutes(app: FastifyInstance, options: {
  prisma?: PrismaClient;
  billing?: { refundResource: (operationId: string) => Promise<unknown> };
} = {}) {
  const prisma = options.prisma ?? getPrisma();
  const billing = options.billing ?? createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });

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
    const chapters = await prisma.novelChapter.findMany({
      where: { projectId: project.id },
      orderBy: { chapterIndex: "asc" },
      select: { chapterIndex: true, content: true },
    });
    const expectedStartChapter = nextNovelChapterIndex(chapters);
    if (body.data.startChapter !== undefined && body.data.startChapter !== expectedStartChapter) {
      return reply.code(409).send({ error: `下一篇未完成章节是第 ${expectedStartChapter} 章，请刷新后重试` });
    }
    const startChapter = expectedStartChapter;
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
        completedChapters: completedNovelChapterCount(chapters),
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
    const tasks = run.steps.length ? await prisma.novelTask.findMany({
      where: { targetId: { in: run.steps.map((step) => step.id) } },
      orderBy: { createdAt: "desc" },
      select: {
        targetId: true,
        status: true,
        progressPercent: true,
        progressStage: true,
        progressMessage: true,
        streamedChars: true,
        updatedAt: true,
      },
    }) : [];
    const latestTaskByStep = new Map<string, typeof tasks[number]>();
    for (const task of tasks) {
      if (task.targetId && !latestTaskByStep.has(task.targetId)) latestTaskByStep.set(task.targetId, task);
    }
    return {
      success: true,
      data: {
        run: serializeNovelRun(run),
        steps: run.steps.map((step) => {
          const task = latestTaskByStep.get(step.id);
          return {
            ...step,
            createdAt: step.createdAt.toISOString(),
            updatedAt: step.updatedAt.toISOString(),
            startedAt: step.startedAt?.toISOString() ?? null,
            completedAt: step.completedAt?.toISOString() ?? null,
            taskProgress: task ? {
              status: task.status,
              percent: task.progressPercent,
              stage: task.progressStage,
              message: task.progressMessage,
              streamedChars: task.streamedChars,
              updatedAt: task.updatedAt.toISOString(),
            } : null,
          };
        }),
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
    const activeSteps = await prisma.novelRunStep.findMany({
      where: { runId: run.id, status: { in: ["queued", "running", "failed"] } },
      select: { id: true },
    });
    const stepIds = activeSteps.map((step) => step.id);
    const activeTasks = stepIds.length ? await prisma.novelTask.findMany({
      where: { targetId: { in: stepIds }, status: { in: ["queued", "running"] } },
      select: { id: true, operationId: true },
    }) : [];
    const cancelledAt = new Date();
    const [, updated] = await prisma.$transaction([
      prisma.novelRunStep.updateMany({ where: { runId: run.id, status: { in: ["queued", "running", "failed"] } }, data: { status: "cancelled", error: "用户已取消", workerId: null, completedAt: cancelledAt } }),
      prisma.novelRun.update({ where: { id: run.id }, data: { cancelRequested: true, status: "cancelled", completedAt: cancelledAt } }),
      prisma.novelTask.updateMany({ where: { id: { in: activeTasks.map((task) => task.id) } }, data: { status: "cancelled", error: "用户已取消", progressStage: "cancelled", progressMessage: "用户已取消", cancelledAt } }),
      prisma.novelCommandOutbox.updateMany({ where: { runId: run.id, status: { in: ["pending", "dispatching"] } }, data: { status: "cancelled", lastError: "用户已取消" } }),
      prisma.novelProject.update({ where: { id: run.projectId }, data: { autopilotStatus: "cancelled" } }),
    ]);
    await Promise.all(activeTasks.map((task) => billing.refundResource(task.operationId).catch((error) => {
      app.log.warn({ err: error, taskId: task.id, runId: run.id }, "novel run cancellation refund failed");
    })));
    await appendNovelRunEvent({ prisma, runId: run.id, type: "runStatusChanged", stage: "cancelled", step: null, chapterNumber: run.currentChapter, progress: 100, payload: { reason: "cancelRequested" } });
    return { success: true, data: { run: serializeNovelRun(updated) } };
  });

  app.post("/api/workflow/novels/projects/:projectId/runs/:runId/revise", async (req, reply) => {
    const userId = userIdOf(req);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const params = runParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const run = await ownedRun(prisma, userId, params.data.projectId, params.data.runId);
    if (!run) return reply.code(404).send({ error: "运行不存在" });
    if (run.status !== "awaitingReview" || !run.currentChapter) return reply.code(409).send({ error: "只有等待审阅的章节可以请求 AI 修订" });
    const chapter = await prisma.novelChapter.findUnique({
      where: { projectId_chapterIndex: { projectId: run.projectId, chapterIndex: run.currentChapter } },
      select: { reviewStatus: true, aiActionItems: true, billableChars: true },
    });
    if (!chapter || chapter.reviewStatus === "approved") return reply.code(409).send({ error: "当前章节无需返修，请直接恢复运行" });
    const activeStep = await prisma.novelRunStep.findFirst({ where: { runId: run.id, status: { in: ["queued", "running"] } } });
    if (activeStep) return reply.code(409).send({ error: "当前已有返修步骤在执行" });
    const actionItems = Array.isArray(chapter.aiActionItems) ? chapter.aiActionItems.filter((item): item is string => typeof item === "string") : [];
    const revisionGuidance = buildNovelRevisionGuidance({ billableChars: chapter.billableChars, targetChars: run.targetCharsPerChapter, actionItems });
    await createNextNovelStep({ prisma, runId: run.id, kind: "writeChapter", chapterNumber: run.currentChapter, priority: run.mode === "assisted" ? 1 : 5, input: { revisionGuidance } });
    const updated = await prisma.novelRun.update({
      where: { id: run.id },
      data: { pauseRequested: false, consecutiveFailures: 0, status: "queued", error: null, completedAt: null },
    });
    await prisma.novelProject.update({ where: { id: run.projectId }, data: { autopilotStatus: "queued" } });
    await appendNovelRunEvent({ prisma, runId: run.id, type: "runStatusChanged", stage: "queued", step: "writeChapter", chapterNumber: run.currentChapter, progress: 0, payload: { reason: "aiRevisionRequested", revisionGuidance } });
    await dispatchNovelOutboxBatch(prisma).catch((error) => app.log.warn({ err: error }, "novel revision dispatch deferred"));
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
    if (run.status === "awaitingReview") {
      const chapter = run.currentChapter ? await prisma.novelChapter.findUnique({
        where: { projectId_chapterIndex: { projectId: run.projectId, chapterIndex: run.currentChapter } },
        select: { reviewStatus: true },
      }) : null;
      if (!chapter || chapter.reviewStatus !== "approved") {
        return reply.code(409).send({ error: "请先在章节质检中完成人工审阅并标记为通过" });
      }
      if (run.mode === "assisted" || (run.currentChapter ?? 0) >= run.targetChapters) {
        const completedAt = new Date();
        const completed = await prisma.novelRun.update({
          where: { id: run.id },
          data: { pauseRequested: false, status: "completed", error: null, completedAt },
        });
        await prisma.novelProject.update({ where: { id: run.projectId }, data: { autopilotStatus: "completed" } });
        await appendNovelRunEvent({ prisma, runId: run.id, type: "runCompleted", stage: "completed", step: "finalizeChapter", chapterNumber: run.currentChapter, progress: 100, payload: { reason: "humanReviewApproved" } });
        return { success: true, data: { run: serializeNovelRun(completed) } };
      }
    }
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
      const chapters = await prisma.novelChapter.findMany({ where: { projectId: run.projectId }, select: { chapterIndex: true, content: true }, orderBy: { chapterIndex: "asc" } });
      const nextChapter = nextNovelChapterIndex(chapters);
      await createNextNovelStep({ prisma, runId: run.id, kind: "prepareChapter", chapterNumber: nextChapter, priority: 5 });
    } else if (!pending) {
      return reply.code(409).send({ error: "当前运行没有可恢复的步骤" });
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
    const initialTail = query.data.after === 0;
    const events = await prisma.novelRunEvent.findMany({
      where: { runId: run.id, sequence: { gt: query.data.after } },
      orderBy: { sequence: initialTail ? "desc" : "asc" },
      take: initialTail ? 200 : 500,
    });
    const ordered = initialTail ? events.reverse() : events;
    return { success: true, data: { events: ordered.map(serializeNovelRunEvent), cursor: ordered.at(-1)?.sequence ?? query.data.after } };
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
