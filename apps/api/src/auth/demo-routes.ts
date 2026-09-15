import type { FastifyInstance } from "fastify";
import type { AuthRouteContext } from "./auth-route-context.js";
import { DemoAccountConflictError, ensureDemoUser, readDemoAccountConfig } from "./demo.js";
import { signToken } from "./token.js";

function unavailableConfig(request: { log: { error: (value: unknown, message: string) => void } }, error: unknown) {
  request.log.error({ err: error }, "体验账号配置无效");
}

export function registerDemoAccountRoutes(app: FastifyInstance, context: AuthRouteContext): void {
  app.get("/api/auth/demo-config", async (request, reply) => {
    try {
      const config = readDemoAccountConfig();
      return { enabled: config !== null, username: config?.username ?? null };
    } catch (error) {
      unavailableConfig(request, error);
      return reply.code(503).send({ error: "体验账号暂不可用" });
    }
  });

  app.post("/api/auth/demo", async (request, reply) => {
    let config;
    try {
      config = readDemoAccountConfig();
    } catch (error) {
      unavailableConfig(request, error);
      return reply.code(503).send({ error: "体验账号暂不可用" });
    }
    if (!config) return reply.code(404).send({ error: "体验账号暂未开放" });

    try {
      const user = await ensureDemoUser(context.prisma, config);
      if (user.bannedAt) return reply.code(403).send({ error: "体验账号暂不可用" });
      await context.recordLogin(request, user.id);
      return {
        token: signToken(user.id, context.secret),
        userId: user.id,
        uid: user.uid,
      };
    } catch (error) {
      if (error instanceof DemoAccountConflictError) {
        return reply.code(409).send({ error: "体验账号暂不可用" });
      }
      throw error;
    }
  });
}
