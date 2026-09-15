import type { FastifyInstance } from "fastify";
import { loadImageAttemptTimeoutMs } from "../_shared/image-service.js";
import { registerImageAssetRoutes } from "./image-asset-routes.js";
import { createImageRouteContext } from "./image-route-context.js";
import { loadImageMaxAttempts } from "./image-route-helpers.js";
import type { ImageWorkflowRouteDeps } from "./image-route-types.js";
import { startImageReaper } from "./image-reaper.js";
import { registerImageTaskRoutes } from "./image-task-routes.js";

export { loadImageAttemptTimeoutMs, loadImageMaxAttempts };

export async function imageWorkflowRoutes(
  app: FastifyInstance,
  deps: ImageWorkflowRouteDeps = {},
): Promise<void> {
  const context = createImageRouteContext(app, deps);

  registerImageAssetRoutes(context);
  registerImageTaskRoutes(context);

  if (!deps.redis) return;

  const timer = startImageReaper({
    prisma: context.prisma,
    redis: deps.redis,
    resume: context.resumeStale,
    onError: (error) => app.log.error({ err: error }, "image reaper tick failed"),
  });
  app.addHook("onClose", async () => clearInterval(timer));
}
