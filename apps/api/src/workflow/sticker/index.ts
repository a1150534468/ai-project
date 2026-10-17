/** 表情包工坊：路由门面。 */
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { startStickerReaper } from "./sticker-reaper.js";
import { registerStickerTaskRoutes } from "./sticker-task-routes.js";
import { registerStickerUploadRoutes } from "./sticker-upload-routes.js";

export function registerStickerRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  registerStickerTaskRoutes(app, prisma);
  registerStickerUploadRoutes(app);
  startStickerReaper({ prisma });
}

export { STICKER_PRESETS } from "./sticker-shared.js";
