import { getPrisma } from "@ai-assistant/db";
import type { FastifyInstance } from "fastify";
import { registerAccountRoutes } from "./account-routes.js";
import { createAuthRouteContext } from "./auth-route-context.js";
import { registerDemoAccountRoutes } from "./demo-routes.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const context = createAuthRouteContext(getPrisma());
  registerDemoAccountRoutes(app, context);
  registerAccountRoutes(app, context);
}
