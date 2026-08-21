import { assertRequiredEnv } from "../env.js";
import { getPrisma } from "@ai-assistant/db";
import {
  closeLocalBusinessPromoQueue,
  createLocalBusinessPromoWorker,
} from "../workflow/local-business-promo/index.js";
import { runHeavyWorkerTask } from "./heavy-task-gate.js";
import { isDirectWorkerEntrypoint, runStandaloneWorker, type StartedWorkerRuntime } from "./worker-runtime.js";

export async function startLocalBusinessPromoWorker(): Promise<StartedWorkerRuntime> {
  assertRequiredEnv();
  const worker = createLocalBusinessPromoWorker(async (job) => {
    await runHeavyWorkerTask(async () => {
      const { executeLocalBusinessPromoRun } = await import("../workflow/local-business-promo/index.js");
      await executeLocalBusinessPromoRun({ runId: job.data.runId });
    });
  });

  worker.on("completed", (job) => {
    console.info(`[local-business-promo-worker] completed run=${job.data.runId}`);
  });

  worker.on("failed", (job, error) => {
    console.error(`[local-business-promo-worker] failed run=${job?.data.runId ?? "unknown"}: ${error.message}`);
  });

  return {
    name: "local-business-promo-worker",
    close: async (signal: string) => {
      console.info(`[local-business-promo-worker] received ${signal}, shutting down`);
      await worker.close();
      await closeLocalBusinessPromoQueue();
    },
  };
}

if (isDirectWorkerEntrypoint(import.meta.url)) {
  runStandaloneWorker({
    name: "local-business-promo-worker",
    start: startLocalBusinessPromoWorker,
    afterClose: () => getPrisma().$disconnect(),
    onFatal: async () => {
      await closeLocalBusinessPromoQueue().catch(() => undefined);
      await getPrisma()
        .$disconnect()
        .catch(() => undefined);
    },
  });
}
