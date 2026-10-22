/**
 * 表情包工坊：pack 管理路由（创建 / 列表 / 详情 / 删除 / 重试）。
 *
 * 参考图上传走独立的 multipart 接口（存对象存储），创建 pack 时传 referenceObjectKey。
 * 贴纸图片通过 ImageAsset 查询（requestId 聚合），详情接口一并返回。
 *
 * 鉴权统一走 requireUser preHandler，入参走 zod schema，执行调度从
 * sticker-route-context 注入（startPack）—— 与 transcription 的骨架对齐。
 */
import { requireUser } from "../../auth/require-user.js";
import type { StickerRouteContext } from "./sticker-route-context.js";
import {
  MAX_STICKER_NAME_LENGTH,
  sanitizePresetKeys,
  stickerPackCreateSchema,
  stickerPackParamsSchema,
} from "./sticker-route-helpers.js";
import {
  newStickerRequestId,
  STICKER_PACK_FINAL_STATUSES,
  STICKER_PACK_STATUS,
  STICKER_PRESETS,
  type StickerPackRow,
} from "./sticker-shared.js";

function toPackRow(pack: {
  id: string;
  userId: string;
  requestId: string;
  name: string;
  characterPrompt: string;
  style: string;
  referenceObjectKey: string | null;
  baseImageRequestId: string | null;
  presetKeys: string[];
  status: string;
  completedCount: number;
  failedCount: number;
  executionToken: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}): StickerPackRow {
  return { ...pack, presetKeys: [...pack.presetKeys] };
}

export function registerStickerTaskRoutes(context: StickerRouteContext): void {
  const { app, prisma } = context;

  // 模板列表：新建 pack 前独立获取，不依赖已有 pack（新用户首单必需）
  app.get("/api/workflow/sticker/presets", { preHandler: requireUser }, async (_request, reply) => {
    return reply.send({ presets: STICKER_PRESETS });
  });

  // 创建 pack（不立即跑：由下面的 run 触发）
  app.post("/api/workflow/sticker/packs", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const parsed = stickerPackCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const tooLong = parsed.error.issues.find((issue) => issue.code === "too_big");
      return reply.code(400).send({ error: tooLong?.message ?? "请求参数无效" });
    }
    const characterPrompt = parsed.data.characterPrompt ?? "";
    const referenceObjectKey = parsed.data.referenceObjectKey ?? null;
    if (!characterPrompt && !referenceObjectKey) {
      return reply.code(400).send({ error: "请填写角色描述或上传参考图" });
    }
    const name = parsed.data.name
      ? parsed.data.name.slice(0, MAX_STICKER_NAME_LENGTH)
      : `表情包 ${new Date().toLocaleDateString("zh-CN")}`;
    // referenceObjectKey 必须归属当前用户，防止传任意 key 读别人的对象
    if (referenceObjectKey && !referenceObjectKey.startsWith(`workflow/stickers/${userId}/`)) {
      return reply.code(400).send({ error: "参考图无效，请重新上传" });
    }
    const presetKeys = sanitizePresetKeys(parsed.data.presetKeys);
    if (presetKeys.length === 0) return reply.code(400).send({ error: "请至少选择一个表情模板" });

    const pack = await prisma.stickerPack.create({
      data: {
        userId,
        requestId: newStickerRequestId(),
        name,
        characterPrompt: characterPrompt || "（参考图角色）",
        style: "cute",
        referenceObjectKey,
        presetKeys,
        status: STICKER_PACK_STATUS.queued,
      },
    });
    return reply.code(201).send({ pack: toPackRow(pack) });
  });

  // 触发执行（幂等：只有 queued 能被认领）
  app.post("/api/workflow/sticker/packs/:id/run", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = stickerPackParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "请求参数无效" });
    const pack = await prisma.stickerPack.findFirst({ where: { id: params.data.id, userId } });
    if (!pack) return reply.code(404).send({ error: "not found" });
    if (pack.status !== STICKER_PACK_STATUS.queued) {
      return reply.code(409).send({ error: `当前状态为 ${pack.status}，无法启动` });
    }
    // 异步跑：调度从 context 注入，HTTP 不等待
    context.startPack(pack.id);
    return reply.send({ ok: true });
  });

  // 失败后重试：failed → queued，已落盘的贴纸会跳过。
  // 清空 executionToken 撤销旧 runner 的执行权：它后续的归属写必然失败并退出。
  app.post("/api/workflow/sticker/packs/:id/retry", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = stickerPackParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "请求参数无效" });
    const updated = await prisma.stickerPack.updateMany({
      where: { id: params.data.id, userId, status: STICKER_PACK_STATUS.failed },
      data: { status: STICKER_PACK_STATUS.queued, executionToken: null, error: null, updatedAt: new Date() },
    });
    if (updated.count === 0) return reply.code(409).send({ error: "只有失败的任务可以重试" });
    return reply.send({ ok: true });
  });

  // 列表
  app.get("/api/workflow/sticker/packs", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const packs = await prisma.stickerPack.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return reply.send({ packs: packs.map(toPackRow) });
  });

  // 详情 + 贴纸图片
  app.get("/api/workflow/sticker/packs/:id", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = stickerPackParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "请求参数无效" });
    const pack = await prisma.stickerPack.findFirst({ where: { id: params.data.id, userId } });
    if (!pack) return reply.code(404).send({ error: "not found" });
    const assets = await prisma.imageAsset.findMany({
      where: { userId, requestId: pack.requestId },
      orderBy: { requestIndex: "asc" },
      select: { id: true, requestIndex: true, thumbnailUrl: true, originalUrl: true, mime: true },
    });
    let baseAsset: { id: string; thumbnailUrl: string; originalUrl: string } | null = null;
    if (pack.baseImageRequestId) {
      baseAsset = await prisma.imageAsset.findUnique({
        where: { requestId_requestIndex: { requestId: pack.baseImageRequestId, requestIndex: 0 } },
        select: { id: true, thumbnailUrl: true, originalUrl: true },
      });
    }
    return reply.send({
      pack: toPackRow(pack),
      stickers: assets,
      baseAsset,
      presets: STICKER_PRESETS,
    });
  });

  // 删除 pack（贴纸 ImageAsset 保留在素材库）
  app.delete("/api/workflow/sticker/packs/:id", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = stickerPackParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "请求参数无效" });
    const pack = await prisma.stickerPack.findFirst({ where: { id: params.data.id, userId } });
    if (!pack) return reply.code(404).send({ error: "not found" });
    if (!STICKER_PACK_FINAL_STATUSES.has(pack.status)) {
      return reply.code(409).send({ error: "任务进行中，完成后可删除" });
    }
    // 原子删除：检查后若被并发 /retry 改为非终态，删不掉，避免删掉运行中的任务
    const deleted = await prisma.stickerPack.deleteMany({
      where: { id: params.data.id, userId, status: { in: [...STICKER_PACK_FINAL_STATUSES] } },
    });
    if (deleted.count === 0) {
      return reply.code(409).send({ error: "任务状态已变化，请刷新后重试" });
    }
    return reply.send({ ok: true });
  });
}
