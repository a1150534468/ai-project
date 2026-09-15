import { getPrisma, getRedis } from "@ai-assistant/db";
import type { FastifyInstance } from "fastify";

export interface ShutdownResources {
  readonly disconnectPrisma: () => Promise<unknown>;
  readonly quitRedis: () => Promise<unknown>;
}

function defaultShutdownResources(): ShutdownResources {
  return {
    disconnectPrisma: () => getPrisma().$disconnect(),
    quitRedis: () => getRedis().quit(),
  };
}

export async function closeApplication(
  app: FastifyInstance,
  signal?: NodeJS.Signals,
  resources: ShutdownResources = defaultShutdownResources(),
): Promise<void> {
  if (signal) app.log.info(`收到 ${signal}，优雅关闭中…`);
  const appResult = await Promise.allSettled([app.close()]);
  if (appResult[0]?.status === "rejected") app.log.error(appResult[0].reason);

  const resourceResults = await Promise.allSettled([
    resources.disconnectPrisma(),
    resources.quitRedis(),
  ]);
  for (const result of resourceResults) {
    if (result.status === "rejected") app.log.error(result.reason);
  }
}

export async function listenUntilShutdown(app: FastifyInstance, port: number): Promise<void> {
  let closing: Promise<void> | undefined;
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return closing;
    closing = closeApplication(app, signal);
    return closing;
  };

  const onTerminate = () => void shutdown("SIGTERM");
  const onInterrupt = () => void shutdown("SIGINT");
  process.once("SIGTERM", onTerminate);
  process.once("SIGINT", onInterrupt);
  try {
    await app.listen({ port, host: "0.0.0.0" });
  } catch (error) {
    process.off("SIGTERM", onTerminate);
    process.off("SIGINT", onInterrupt);
    await (closing ?? closeApplication(app));
    throw error;
  }
}
