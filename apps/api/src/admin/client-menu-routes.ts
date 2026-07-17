import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@ai-assistant/db";
import { getPrisma } from "@ai-assistant/db";
import { z } from "zod";
import { requireAdmin } from "./guard.js";
import { writeAudit } from "./audit.js";
import {
  CLIENT_MENU_CATALOG,
  CLIENT_MENU_KEYS,
  resolveClientMenuItems,
} from "./client-menu-catalog.js";

const updateSchema = z.object({ visible: z.boolean() });

export interface ClientMenuRoutesDeps {
  readonly prisma?: PrismaClient;
}

export async function clientMenuRoutes(
  app: FastifyInstance,
  deps: ClientMenuRoutesDeps = {},
): Promise<void> {
  const prisma = deps.prisma ?? getPrisma();

  const list = async () => {
    const rows = await prisma.clientMenuVisibility.findMany({
      select: { key: true, visible: true },
    });
    return resolveClientMenuItems(rows);
  };

  // 用户端读取；不含管理员信息，未登录页也可安全调用。
  app.get("/api/client-menu", async () => ({ success: true, data: await list() }));

  app.get(
    "/api/admin/client-menu",
    { preHandler: requireAdmin("ADMIN_MANAGE") },
    async () => ({ success: true, data: await list() }),
  );

  app.patch(
    "/api/admin/client-menu/:key",
    { preHandler: requireAdmin("ADMIN_MANAGE") },
    async (req, reply) => {
      const { key } = req.params as { key: string };
      const parsed = updateSchema.safeParse(req.body);
      if (!CLIENT_MENU_KEYS.has(key) || !parsed.success) {
        return reply.code(400).send({ error: "菜单项或参数不合法" });
      }

      await prisma.clientMenuVisibility.upsert({
        where: { key },
        create: { key, visible: parsed.data.visible },
        update: { visible: parsed.data.visible },
      });
      const definition = CLIENT_MENU_CATALOG.find((item) => item.key === key)!;
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "CLIENT_MENU_VISIBILITY_UPDATE", key, {
        visible: parsed.data.visible,
      });
      return {
        success: true,
        data: { ...definition, visible: parsed.data.visible },
      };
    },
  );
}
