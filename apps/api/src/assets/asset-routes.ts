/**
 * `GET /api/assets` —— 素材库唯一的读接口。
 *
 * 这里**只做查询解析**：准入规则在 asset-classify.ts，分页在 asset-service.ts，
 * 每条链接由原模块自己签（asset-sources.ts）。素材库没有第二个端点，也没有取件端点。
 */

import { getPrisma } from "@ai-assistant/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/require-user.js";
import { decodeAssetCursor } from "./asset-cursor.js";
import { ASSET_PAGE_SIZE_MAX, listAssets } from "./asset-service.js";
import { createAssetSourceDeps } from "./asset-sources.js";
import { ASSET_SOURCE_MODULES, type AssetSourceModule } from "./asset-types.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(ASSET_PAGE_SIZE_MAX).optional(),
  cursor: z.string().min(1).max(400).optional(),
  sourceModule: z.enum([...ASSET_SOURCE_MODULES] as [AssetSourceModule, ...AssetSourceModule[]]).optional(),
  origin: z.enum(["ai", "upload"]).optional(),
});

export async function assetRoutes(app: FastifyInstance) {
  // 本文件只有一个路由、且必须登录，所以挂插件级钩子；钩子与它保护的路由同文件，
  // 单独注册本文件做测试时守卫不会凭空消失（见 auth/require-user.ts）。
  app.addHook("preHandler", requireUser);

  const deps = createAssetSourceDeps(getPrisma());

  app.get("/api/assets", async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    // 游标解不出来当没带处理（回第一页），不报错：它只决定翻页位置。
    const page = await listAssets(deps, {
      userId: req.userId,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor ? decodeAssetCursor(parsed.data.cursor) : null,
      sourceModule: parsed.data.sourceModule ?? null,
      origin: parsed.data.origin ?? null,
    });
    return reply.send(page);
  });
}
