import "./env.js";
import Fastify from "fastify";
import { requireSessionSecret } from "./auth/auth-route-context.js";
import { registerOpenApiUi } from "./docs/openapi.js";
import { assertRequiredEnv, SERVER_REQUIRED_ENV, warnMissingOptionalEnv } from "./env.js";
import { installRequestAuthentication } from "./server-auth.js";
import { startBackgroundServices } from "./server-background.js";
import { installErrorHandler } from "./server-errors.js";
import { apiBodyLimit, registerServerFoundation } from "./server-foundation.js";
import { registerHealthRoutes } from "./server-health.js";
import { listenUntilShutdown } from "./server-lifecycle.js";
import { registerApplicationRoutes } from "./server-routes.js";

export async function buildServer() {
  const app = Fastify({ logger: true, bodyLimit: apiBodyLimit() });
  installErrorHandler(app);
  const docsEnabled = await registerServerFoundation(app);
  installRequestAuthentication(app, requireSessionSecret());
  await registerApplicationRoutes(app);
  await startBackgroundServices(app);
  if (docsEnabled) await registerOpenApiUi(app);
  registerHealthRoutes(app);
  return app;
}

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  assertRequiredEnv(SERVER_REQUIRED_ENV);
  warnMissingOptionalEnv();
  const port = Number(process.env.PORT ?? 8090);
  void buildServer()
    .then((app) => listenUntilShutdown(app, port))
    .catch((error) => {
      console.error("[server] 启动失败", error);
      process.exitCode = 1;
    });
}
