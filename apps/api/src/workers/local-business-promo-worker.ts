import "../env.js";
import { getPrisma } from "@yc/db";
import {
  closeLocalBusinessPromoQueue,
  createLocalBusinessPromoWorker,
} from "../workflow/local-business-promo-queue.js";
import { executeLocalBusinessPromoRun } from "../workflow/local-business-promo-runner.js";

async function main() {
  const worker = createLocalBusinessPromoWorker(async (job) => {
    await executeLocalBusinessPromoRun({ runId: job.data.runId });
  });

  worker.on("completed", (job) => {
    console.info(`[local-business-promo-worker] completed run=${job.data.runId}`);
  });

  worker.on("failed", (job, error) => {
    console.error(`[local-business-promo-worker] failed run=${job?.data.runId ?? "unknown"}: ${error.message}`);
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.info(`[local-business-promo-worker] received ${signal}, shutting down`);
    try {
      await worker.close();
      await closeLocalBusinessPromoQueue();
      await getPrisma().$disconnect();
    } catch (error) {
      console.error("[local-business-promo-worker] shutdown error", error);
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void main().catch(async (error) => {
  console.error("[local-business-promo-worker] fatal error", error);
  await closeLocalBusinessPromoQueue().catch(() => undefined);
  await getPrisma().$disconnect().catch(() => undefined);
  process.exit(1);
});
