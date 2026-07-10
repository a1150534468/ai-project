import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@yc/db";
import {
  createBinding,
  listBindings,
  deleteBinding,
  BindingForbiddenError,
  type CreateBindingInput,
} from "./bindings.js";

const createSchema = z.object({
  deviceId: z.string().min(1).max(128),
  targetType: z.enum(["agent", "team"]),
  targetId: z.string().min(1).max(128),
  model: z.string().min(1).max(128).optional(),
});

export async function wechatRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  // POST /api/wechat/bindings - 创建或更新微信绑定
  app.post("/api/wechat/bindings", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });

    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });

    try {
      const data = await createBinding(prisma, userId, parsed.data as CreateBindingInput);
      return reply.send({ success: true, data });
    } catch (e) {
      if (e instanceof BindingForbiddenError) {
        return reply.code(403).send({ error: e.message });
      }
      throw e;
    }
  });

  // GET /api/wechat/bindings - 列出当前用户的微信绑定
  app.get("/api/wechat/bindings", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });

    const data = await listBindings(prisma, userId);
    return reply.send({ success: true, data });
  });

  // DELETE /api/wechat/bindings/:id - 删除微信绑定
  app.delete("/api/wechat/bindings/:id", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });

    const { id } = req.params as { id: string };

    try {
      await deleteBinding(prisma, userId, id);
      return reply.send({ success: true });
    } catch (e) {
      if (e instanceof BindingForbiddenError) {
        return reply.code(403).send({ error: e.message });
      }
      throw e;
    }
  });
}
