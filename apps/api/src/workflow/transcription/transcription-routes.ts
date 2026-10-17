import type { FastifyInstance } from "fastify";
import {
  createTranscriptionRouteContext,
  type TranscriptionRouteDeps,
} from "./transcription-route-context.js";
import { registerTranscriptionTaskRoutes } from "./transcription-task-routes.js";
import { startTranscriptionReaper } from "./transcription-reaper.js";

export async function transcriptionWorkflowRoutes(
  app: FastifyInstance,
  deps: TranscriptionRouteDeps = {},
): Promise<void> {
  const context = createTranscriptionRouteContext(app, deps);

  registerTranscriptionTaskRoutes(context);

  if (!deps.redis) return;

  const timer = startTranscriptionReaper({
    prisma: context.prisma,
    redis: deps.redis as import("ioredis").Redis,
    resume: context.resumeStale,
    onError: (error) => app.log.error({ err: error }, "transcription reaper tick failed"),
  });
  app.addHook("onClose", async () => clearInterval(timer));
}
