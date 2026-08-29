import type { FastifyInstance } from "fastify";
import { requireUser } from "../../auth/require-user.js";
import {
  defaultSubscribeRunEvents,
  defaultWaitForSseDisconnect,
  eventCursor,
  eventsQuerySchema,
  formatCodexPetSseEvent,
  runParamsSchema,
  safeDiagnostic,
  serializeEvent,
} from "./codex-pet-route-helpers.js";
import type { CodexPetRouteContext } from "./codex-pet-route-context.js";
import type { EventShape } from "./codex-pet-route-types.js";

export function registerCodexPetEventRoutes(app: FastifyInstance, ctx: CodexPetRouteContext) {
  const { deps, prisma, ownedRun } = ctx;

  app.get("/api/workflow/codex-pets/projects/:projectId/runs/:runId/events", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = runParamsSchema.safeParse(request.params);
    const query = eventsQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "事件查询参数不合法" });
    const run = await ownedRun(userId, params.data.projectId, params.data.runId);
    if (!run) return reply.code(404).send({ error: "桌宠运行不存在" });
    const initialTail = query.data.after === 0;
    const events = await prisma.codexPetEvent.findMany({
      where: { runId: run.id, projectId: run.projectId, userId, sequence: { gt: query.data.after } },
      orderBy: { sequence: initialTail ? "desc" : "asc" },
      take: initialTail ? 200 : 500,
    });
    const ordered = initialTail ? events.reverse() : events;
    return {
      success: true,
      data: {
        events: ordered.map((event) => serializeEvent(event as EventShape)),
        cursor: ordered.at(-1)?.sequence ?? query.data.after,
      },
    };
  });

  app.get("/api/workflow/codex-pets/projects/:projectId/runs/:runId/events/stream", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = runParamsSchema.safeParse(request.params);
    const query = eventsQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "事件流参数不合法" });
    const run = await ownedRun(userId, params.data.projectId, params.data.runId);
    if (!run) return reply.code(404).send({ error: "桌宠运行不存在" });

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let cursor = eventCursor(request, query.data.after);
    app.log.info({ runId: run.id, status: "opened" }, "Codex pet SSE connection opened");
    let flushing = false;
    const flush = async () => {
      if (flushing || reply.raw.destroyed || reply.raw.writableEnded) return;
      flushing = true;
      try {
        const events = await prisma.codexPetEvent.findMany({
          where: { runId: run.id, projectId: run.projectId, userId, sequence: { gt: cursor } },
          orderBy: { sequence: "asc" },
          take: 200,
        });
        for (const event of events) {
          reply.raw.write(formatCodexPetSseEvent(event as EventShape));
          cursor = event.sequence;
        }
      } finally {
        flushing = false;
      }
    };
    const triggerFlush = () => {
      void flush().catch((error) => app.log.warn({ error: safeDiagnostic(error), runId: run.id }, "Codex pet SSE database replay failed"));
    };

    let unsubscribe: (() => Promise<void> | void) | undefined;
    let redisFallback = false;
    try {
      try {
        const subscribe = deps.subscribeRunEvents ?? defaultSubscribeRunEvents;
        unsubscribe = await subscribe(run.id, triggerFlush) ?? undefined;
      } catch (error) {
        redisFallback = true;
        app.log.warn({ error: safeDiagnostic(error), runId: run.id }, "Codex pet SSE Redis subscription unavailable; polling database");
      }
      await flush();
      const poller = setInterval(triggerFlush, deps.ssePollIntervalMs ?? 2_000);
      const heartbeat = setInterval(() => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
      }, deps.sseHeartbeatIntervalMs ?? 15_000);
      try {
        await (deps.waitForSseDisconnect ?? defaultWaitForSseDisconnect)(request, reply);
      } finally {
        clearInterval(poller);
        clearInterval(heartbeat);
      }
    } finally {
      await unsubscribe?.();
      app.log.info({ runId: run.id, status: "closed", redisFallback }, "Codex pet SSE connection closed");
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    }
  });
}
