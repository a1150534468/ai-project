import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/require-user.js";
import { z } from "zod";
import { getPrisma } from "@ai-assistant/db";
import { InsufficientBalanceError } from "@ai-assistant/billing";
import { SCHED } from "./config.js";
import { validateCron, computeNextRun, checkMinInterval } from "./schedule.js";
import { RateLimitedError, type AiDraftFn } from "./ai-draft-glue.js";

const createSchema = z.object({
  title: z.string().min(1).max(100),
  prompt: z.string().min(1).max(8000),
  model: z.string().min(1),
  agentId: z.string().optional().nullable(),
  kbIds: z.array(z.string()).optional(),
  deviceId: z.string().optional().nullable(),
  cron: z.string().min(1),
  timezone: z.string().min(1),
  oneShot: z.boolean().optional(),
  emailTo: z.string().email().or(z.literal("")).optional(),
});

const updateSchema = createSchema.partial().extend({ enabled: z.boolean().optional() });

const aiDraftSchema = z.object({ description: z.string().min(1).max(1000) });

export interface ScheduledRoutesOpts {
  readonly aiDraft?: AiDraftFn;
}

export async function scheduledRoutes(app: FastifyInstance, opts: ScheduledRoutesOpts = {}): Promise<void> {
  // 本文件 6 个路由全部必须登录，挂插件级。钩子和它保护的路由同文件，
  // 这样测试单独注册本文件时守卫不会凭空消失。
  app.addHook("preHandler", requireUser);

  const prisma = getPrisma();

  app.post("/api/scheduled-tasks/ai-draft", async (req, reply) => {
    const userId = req.userId;
    const parsed = aiDraftSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    if (!opts.aiDraft) return reply.code(503).send({ error: "AI 起草暂不可用" });
    try {
      const draft = await opts.aiDraft(userId, parsed.data.description);
      return reply.send({ data: draft });
    } catch (err) {
      if (err instanceof RateLimitedError) return reply.code(429).send({ error: err.message });
      if (err instanceof InsufficientBalanceError) return reply.code(400).send({ error: "算力点余额不足" });
      req.log.error({ err }, "scheduled ai-draft failed");
      return reply.code(500).send({ error: "AI 生成失败，请重试" });
    }
  });

  app.get("/api/scheduled-tasks", async (req, reply) => {
    const userId = req.userId;
    const tasks = await prisma.scheduledTask.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
    return reply.send({ data: tasks });
  });

  app.post("/api/scheduled-tasks", async (req, reply) => {
    const userId = req.userId;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const d = parsed.data;

    if (!validateCron(d.cron)) return reply.code(400).send({ error: "cron 表达式非法" });
    if (!checkMinInterval(d.cron, d.timezone, SCHED.minIntervalMs)) {
      return reply.code(400).send({ error: `触发间隔不得小于 ${Math.round(SCHED.minIntervalMs / 60000)} 分钟` });
    }
    if (d.deviceId) {
      const dev = await prisma.device.findFirst({ where: { id: d.deviceId, userId }, select: { id: true } });
      if (!dev) return reply.code(400).send({ error: "绑定设备不存在或不属于你" });
    }
    const count = await prisma.scheduledTask.count({ where: { userId } });
    if (count >= SCHED.maxTasksPerUser) {
      return reply.code(400).send({ error: `定时任务数量已达上限（${SCHED.maxTasksPerUser}）` });
    }

    const nextRunAt = computeNextRun(d.cron, d.timezone, new Date());
    if (!nextRunAt) return reply.code(400).send({ error: "无法根据 cron 计算下次触发时间" });

    const task = await prisma.scheduledTask.create({
      data: {
        userId,
        title: d.title,
        prompt: d.prompt,
        model: d.model,
        agentId: d.agentId ?? null,
        kbIds: d.kbIds ?? undefined,
        deviceId: d.deviceId ?? null,
        cron: d.cron,
        timezone: d.timezone,
        oneShot: d.oneShot ?? false,
        emailTo: d.emailTo ?? "",
        nextRunAt,
      },
    });
    return reply.send(task);
  });

  app.patch("/api/scheduled-tasks/:id", async (req, reply) => {
    const userId = req.userId;
    const { id } = req.params as { id: string };
    const existing = await prisma.scheduledTask.findFirst({ where: { id, userId } });
    if (!existing) return reply.code(404).send({ error: "任务不存在" });

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const d = parsed.data;

    const cron = d.cron ?? existing.cron;
    const timezone = d.timezone ?? existing.timezone;
    if (d.cron || d.timezone) {
      if (!validateCron(cron)) return reply.code(400).send({ error: "cron 表达式非法" });
      if (!checkMinInterval(cron, timezone, SCHED.minIntervalMs)) {
        return reply.code(400).send({ error: `触发间隔不得小于 ${Math.round(SCHED.minIntervalMs / 60000)} 分钟` });
      }
    }
    if (d.deviceId) {
      const dev = await prisma.device.findFirst({ where: { id: d.deviceId, userId }, select: { id: true } });
      if (!dev) return reply.code(400).send({ error: "绑定设备不存在或不属于你" });
    }

    const recompute = d.cron || d.timezone || d.enabled === true;
    const nextRunAt = recompute ? computeNextRun(cron, timezone, new Date()) ?? existing.nextRunAt : existing.nextRunAt;

    const task = await prisma.scheduledTask.update({
      where: { id },
      data: {
        title: d.title,
        prompt: d.prompt,
        model: d.model,
        agentId: d.agentId,
        kbIds: d.kbIds ?? undefined,
        deviceId: d.deviceId,
        cron,
        timezone,
        oneShot: d.oneShot,
        emailTo: d.emailTo,
        enabled: d.enabled,
        nextRunAt,
      },
    });
    return reply.send(task);
  });

  app.delete("/api/scheduled-tasks/:id", async (req, reply) => {
    const userId = req.userId;
    const { id } = req.params as { id: string };
    const existing = await prisma.scheduledTask.findFirst({ where: { id, userId } });
    if (!existing) return reply.code(404).send({ error: "任务不存在" });
    await prisma.scheduledTask.delete({ where: { id } });
    return reply.send({ ok: true });
  });

  app.get("/api/scheduled-tasks/:id/runs", async (req, reply) => {
    const userId = req.userId;
    const { id } = req.params as { id: string };
    const existing = await prisma.scheduledTask.findFirst({ where: { id, userId }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: "任务不存在" });
    const runs = await prisma.scheduledTaskRun.findMany({ where: { taskId: id }, orderBy: { createdAt: "desc" }, take: 50 });
    return reply.send({ data: runs });
  });
}
