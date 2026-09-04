import { createServer } from "node:http";
import { getPrisma, getRedis } from "@ai-assistant/db";
import { assertRequiredEnv } from "../env.js";
import { startCodexPetWorker } from "./codex-pet-worker.js";
import { startNovelWorker } from "./novel-worker.js";
import { isDirectWorkerEntrypoint, type StartedWorkerRuntime } from "./worker-runtime.js";
import { withTimeout } from "../runtime/with-timeout.js";

async function startCombinedWorker(): Promise<void> {
  assertRequiredEnv();
  const runtimes: StartedWorkerRuntime[] = [];
  let ready = false;
  let closing = false;
  const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? "8091");
  const healthServer = createServer(async (req, res) => {
    let postgres = false;
    let redis = false;
    if (ready && !closing) {
      const [postgresResult, redisResult] = await Promise.allSettled([
        withTimeout(getPrisma().$queryRawUnsafe("SELECT 1"), 2_000, "PostgreSQL health check"),
        withTimeout(getRedis().ping(), 2_000, "Redis health check"),
      ]);
      postgres = postgresResult.status === "fulfilled";
      redis = redisResult.status === "fulfilled" && redisResult.value === "PONG";
    }
    const healthy = ready && !closing && postgres && redis;
    const memory = process.memoryUsage();
    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: healthy,
        worker: "combined",
        queues: runtimes.map((runtime) => runtime.name),
        dependencies: { postgres, redis },
        uptimeSec: Math.floor(process.uptime()),
        memory: {
          rss: memory.rss,
          heapUsed: memory.heapUsed,
          external: memory.external,
          arrayBuffers: memory.arrayBuffers,
        },
        path: req.url,
      }),
    );
  });

  const close = async (signal: string, exitCode = 0) => {
    if (closing) return;
    closing = true;
    ready = false;
    console.info(`[combined-worker] received ${signal}, shutting down ${runtimes.length} runtimes`);
    try {
      for (const runtime of [...runtimes].reverse()) await runtime.close(signal);
      await new Promise<void>((resolve) => healthServer.close(() => resolve()));
      await getPrisma().$disconnect();
      await getRedis().quit();
    } catch (error) {
      exitCode = 1;
      console.error("[combined-worker] shutdown error", error);
    } finally {
      process.exit(exitCode);
    }
  };

  process.once("SIGTERM", () => void close("SIGTERM"));
  process.once("SIGINT", () => void close("SIGINT"));

  try {
    runtimes.push(await startNovelWorker({ healthPort: false }));
    runtimes.push(await startCodexPetWorker({ healthPort: false }));
    healthServer.listen(healthPort, "0.0.0.0");
    ready = true;
    console.info(
      `[combined-worker] ready queues=${runtimes.map((runtime) => runtime.name).join(",")} port=${healthPort}`,
    );
  } catch (error) {
    console.error("[combined-worker] startup failed", error);
    await close("startup-failure", 1);
  }
}

if (isDirectWorkerEntrypoint(import.meta.url)) void startCombinedWorker();
