import { assertRequiredEnv } from "../env.js";
import { createServer } from "node:http";
import { createBillingClient } from "@ai-assistant/billing";
import { getPrisma } from "@ai-assistant/db";
import { createNovelGenerator } from "../workflow/novel-generation.js";
import { runNovelTask } from "../workflow/novel-task-runner.js";
import { dispatchNovelOutboxBatch, recoverInterruptedNovelSteps, recoverInterruptedNovelTasks } from "../novel/outbox.js";
import { closeNovelQueue, createNovelWorker } from "../novel/queue.js";
import { executeNovelEngineStep } from "../novel/runner.js";
import { withNovelProjectLock } from "../novel/project-lock.js";

const prisma = getPrisma();
const billing = createBillingClient({
  baseUrl: process.env.BILLING_BASE_URL!,
  token: process.env.BILLING_INTERNAL_TOKEN!,
});
const generator = createNovelGenerator();
let ready = false;
let lastDispatchAt = 0;

async function main() {
  // P1.4 启动期聚合校验：缺必需 env 直接拒绝启动（见 env.ts）
  assertRequiredEnv();
  await recoverInterruptedNovelSteps(prisma);
  await recoverInterruptedNovelTasks(prisma);
  await dispatchNovelOutboxBatch(prisma);

  const worker = createNovelWorker(async (job) => {
    if (job.data.type === "generation-task") {
      const task = await prisma.novelTask.findUnique({ where: { id: job.data.taskId } });
      if (!task) return;
      await withNovelProjectLock({ projectId: task.projectId, work: () => runNovelTask({ prisma, billing, generator, task }) });
    } else {
      const stepId = job.data.stepId;
      const step = await prisma.novelRunStep.findUnique({ where: { id: stepId }, select: { run: { select: { projectId: true } } } });
      if (!step) return;
      await withNovelProjectLock({ projectId: step.run.projectId, work: () => executeNovelEngineStep({ stepId, prisma, billing }) });
    }
    await dispatchNovelOutboxBatch(prisma);
  });

  worker.on("completed", (job) => {
    console.info(`[novel-worker] completed job=${job.id ?? "unknown"} type=${job.data.type}`);
  });
  worker.on("failed", (job, error) => {
    console.error(`[novel-worker] failed job=${job?.id ?? "unknown"}: ${error.message}`);
  });
  worker.on("error", (error) => {
    console.error(`[novel-worker] worker error: ${error.message}`);
  });

  const dispatchTimer = setInterval(() => {
    void dispatchNovelOutboxBatch(prisma)
      .then(() => { lastDispatchAt = Date.now(); })
      .catch((error) => console.error(`[novel-worker] outbox error: ${error instanceof Error ? error.message : String(error)}`));
  }, 1000);
  const recoveryTimer = setInterval(() => {
    void Promise.all([recoverInterruptedNovelSteps(prisma), recoverInterruptedNovelTasks(prisma)])
      .then(([stepCount, taskCount]) => {
        if (stepCount > 0 || taskCount > 0) console.warn(`[novel-worker] recovered ${stepCount} interrupted step(s), ${taskCount} generation task(s)`);
      })
      .catch((error) => console.error(`[novel-worker] recovery error: ${error instanceof Error ? error.message : String(error)}`));
  }, 15_000);
  lastDispatchAt = Date.now();
  ready = true;

  const healthPort = Number(process.env.NOVEL_WORKER_HEALTH_PORT ?? "8091");
  const healthServer = createServer((_req, res) => {
    const healthy = ready && Date.now() - lastDispatchAt < 30_000;
    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: healthy, worker: "novel" }));
  });
  healthServer.listen(healthPort, "0.0.0.0");

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    ready = false;
    clearInterval(dispatchTimer);
    clearInterval(recoveryTimer);
    console.info(`[novel-worker] received ${signal}, waiting for current steps`);
    try {
      await worker.close();
      await closeNovelQueue();
      await new Promise<void>((resolve) => healthServer.close(() => resolve()));
      await prisma.$disconnect();
    } catch (error) {
      console.error(`[novel-worker] shutdown error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void main().catch(async (error) => {
  console.error(`[novel-worker] fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  await closeNovelQueue().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
