import { getPrisma, getRedis } from "@ai-assistant/db";
import type { FastifyInstance } from "fastify";
import { withTimeout } from "./runtime/with-timeout.js";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/health", async () => ({ ok: true }));
  app.get("/health/resources", async () => {
    const memory = process.memoryUsage();
    const usage = process.resourceUsage();
    return {
      ok: true,
      process: "api",
      pid: process.pid,
      uptimeSec: Math.floor(process.uptime()),
      memory: {
        rss: memory.rss,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
        maxRss: usage.maxRSS * 1024,
      },
    };
  });
  app.get("/ready", async (_request, reply) => {
    try {
      const [, pong] = await Promise.all([
        withTimeout(getPrisma().$queryRawUnsafe("SELECT 1"), 2_000, "PostgreSQL readiness check"),
        withTimeout(getRedis().ping(), 2_000, "Redis readiness check"),
      ]);
      if (pong !== "PONG") throw new Error("Redis ping failed");
      return { ok: true };
    } catch (error) {
      app.log.warn({ err: error }, "readiness check failed");
      return reply.code(503).send({ ok: false });
    }
  });
}
