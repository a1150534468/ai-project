import { getRedis } from "@ai-assistant/db";
import type { FastifyInstance } from "fastify";
import { adminAuditRoutes } from "./admin/audit-routes.js";
import { clientMenuRoutes } from "./admin/client-menu-routes.js";
import { adminKnowledgeRoutes } from "./admin/knowledge-routes.js";
import { adminRoutes } from "./admin/routes.js";
import { adminUserRoutes } from "./admin/user-routes.js";
import { agentRoutes } from "./agents/routes.js";
import { assetRoutes } from "./assets/asset-routes.js";
import { authRoutes } from "./auth/routes.js";
import { chatRoutes } from "./chat/routes.js";
import { kbRoutes } from "./kb/routes.js";
import { memoryRoutes } from "./memory/routes.js";
import { modelRoutes } from "./models/routes.js";
import { novelEngineRoutes } from "./novel/routes.js";
import { articleWorkflowRoutes } from "./workflow/article/index.js";
import { codexPetRoutes, enqueueCodexPetProjectCleanup } from "./workflow/codex-pet/index.js";
import { imageWorkflowRoutes } from "./workflow/image/index.js";
import { novelWorkflowRoutes } from "./workflow/novel/index.js";
import { announcementRoutes } from "./admin/announcement-routes.js";

export async function registerApplicationRoutes(app: FastifyInstance): Promise<void> {
  await app.register(authRoutes);
  await app.register(chatRoutes);
  await app.register(kbRoutes);
  await app.register(assetRoutes);
  await app.register(modelRoutes);
  await app.register(agentRoutes, { redis: getRedis() });
  await app.register((instance) => imageWorkflowRoutes(instance, { redis: getRedis() }));
  await app.register((instance) =>
    codexPetRoutes(instance, { enqueueProjectCleanup: enqueueCodexPetProjectCleanup }),
  );
  await app.register(novelWorkflowRoutes);
  await app.register(novelEngineRoutes);
  await app.register(articleWorkflowRoutes);
  await app.register(memoryRoutes);
  await app.register(adminRoutes);
  await app.register(adminUserRoutes);
  await app.register(adminAuditRoutes);
  await app.register(announcementRoutes);
  await app.register(adminKnowledgeRoutes);
  await app.register(clientMenuRoutes);
}
