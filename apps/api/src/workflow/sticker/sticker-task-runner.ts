/**
 * 表情包工坊：任务执行器。
 *
 * 租约模式：同一 pack 同一时间只有一个 runner 在推进；逐张贴纸生成，
 * 每落一张刷 updatedAt 当心跳。单张失败重试 3 次仍失败则记入 failedCount
 * 继续下一张，不阻断整包。
 */
import { setTimeout as delay } from "node:timers/promises";
import type { PrismaClient } from "@prisma/client";
import {
  callImageEdit,
  callImageGeneration,
} from "../_shared/image-service-calls.js";
import { DEFAULT_IMAGE_MODEL } from "../_shared/image-service-constants.js";
import { loadImageGenerationConfigForModel } from "../_shared/image-service-providers.js";
import { measureBinary, storeWorkflowImage } from "../_shared/image-service-storage.js";
import { getObject, loadS3Config, makeS3 } from "../../storage/s3.js";
import {
  buildBaseCharacterPrompt,
  buildStickerPrompt,
  STICKER_PACK_FINAL_STATUSES,
  STICKER_PACK_STATUS,
  stickerPresetByKey,
  type StickerPackRow,
  type StickerPreset,
} from "./sticker-shared.js";

export class StickerPackStoppedError extends Error {}

const TERMINAL_STATUS_MESSAGE: Record<string, string> = {
  completed: "表情包已生成完成",
  failed: "表情包生成失败",
};

export interface RunStickerPackArgs {
  readonly prisma: PrismaClient;
  readonly packId: string;
  readonly fetchFn: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  /** 单张贴纸的最大重试次数（不含首次），默认 3。 */
  readonly maxAttempts?: number;
  readonly onProgress?: (completed: number, failed: number, total: number) => void | Promise<void>;
}

async function getPack(prisma: PrismaClient, packId: string): Promise<StickerPackRow | null> {
  const pack = await prisma.stickerPack.findUnique({ where: { id: packId } });
  if (!pack) return null;
  return { ...pack, presetKeys: [...pack.presetKeys] };
}

async function assertPackRunning(prisma: PrismaClient, packId: string): Promise<StickerPackRow> {
  const pack = await getPack(prisma, packId);
  if (!pack) throw new StickerPackStoppedError("sticker pack not found");
  const message = TERMINAL_STATUS_MESSAGE[pack.status];
  if (message) throw new StickerPackStoppedError(message);
  if (pack.status !== STICKER_PACK_STATUS.running) {
    throw new StickerPackStoppedError(`sticker pack is ${pack.status}, not running`);
  }
  return pack;
}

async function updatePack(prisma: PrismaClient, packId: string, data: Record<string, unknown>): Promise<void> {
  await prisma.stickerPack.update({ where: { id: packId }, data: { ...data, updatedAt: new Date() } });
}

interface BaseImage {
  readonly buffer: Buffer;
  readonly mime: string;
}

async function resolveBaseImage(args: {
  prisma: PrismaClient;
  pack: StickerPackRow;
  fetchFn: typeof fetch;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<BaseImage> {
  const { prisma, pack, fetchFn, env, signal } = args;
  // 1) 用户上传的参考图
  if (pack.referenceObjectKey) {
    const s3 = makeS3(loadS3Config(env));
    const buffer = await getObject(s3, pack.referenceObjectKey);
    const measured = await measureBinary(buffer);
    void measured;
    return { buffer, mime: "image/png" };
  }
  // 2) 已生成的主形象（ImageAsset）
  if (pack.baseImageRequestId) {
    const asset = await prisma.imageAsset.findUnique({
      where: { requestId_requestIndex: { requestId: pack.baseImageRequestId, requestIndex: 0 } },
    });
    if (!asset) throw new Error("base character image not found");
    const response = await fetchFn(asset.originalUrl, { signal });
    if (!response.ok) throw new Error(`base character download ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "image/png";
    return { buffer, mime: contentType.startsWith("image/") ? contentType : "image/png" };
  }
  // 3) 文字描述模式：先生成一张主形象
  const config = loadImageGenerationConfigForModel(DEFAULT_IMAGE_MODEL, env);
  const prompt = buildBaseCharacterPrompt(pack.characterPrompt, pack.style);
  const generated = await callImageGeneration({
    config,
    prompt,
    size: "1024x1024",
    fetchFn,
    signal,
    env,
  });
  const stored = await storeWorkflowImage({
    image: generated,
    userId: pack.userId,
    requestId: pack.baseImageRequestId ?? `${pack.requestId}-base`,
    requestIndex: 0,
    fetchFn,
    signal,
    env,
    namespace: "workflow/stickers",
  });
  const baseRequestId = `${pack.requestId}-base`;
  await prisma.imageAsset.upsert({
    where: { requestId_requestIndex: { requestId: baseRequestId, requestIndex: 0 } },
    update: {},
    create: {
      userId: pack.userId,
      requestId: baseRequestId,
      requestIndex: 0,
      prompt,
      model: config.model,
      size: "1024x1024",
      originalUrl: stored.originalUrl,
      thumbnailUrl: stored.thumbnailUrl,
      objectKey: stored.objectKey,
      mime: stored.mime,
      width: stored.width ?? null,
      height: stored.height ?? null,
    },
  });
  await updatePack(prisma, pack.id, { baseImageRequestId: baseRequestId });
  const response = await fetchFn(stored.originalUrl, { signal });
  if (!response.ok) throw new Error(`base character download ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, mime: stored.mime };
}

async function generateOneSticker(args: {
  prisma: PrismaClient;
  pack: StickerPackRow;
  base: BaseImage;
  preset: StickerPreset;
  requestIndex: number;
  fetchFn: typeof fetch;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  maxAttempts: number;
}): Promise<{ ok: boolean; error?: string }> {
  const { prisma, pack, base, preset, requestIndex, fetchFn, env, signal, maxAttempts } = args;
  const config = loadImageGenerationConfigForModel(DEFAULT_IMAGE_MODEL, env);
  const prompt = buildStickerPrompt(pack.characterPrompt, preset, pack.style);
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      await assertPackRunning(prisma, pack.id);
      const generated = await callImageEdit({
        config,
        prompt,
        referenceImages: [{ b64: base.buffer.toString("base64"), mime: base.mime }],
        fetchFn,
        size: "1024x1024",
        outputFormat: "png",
        signal,
        env,
      });
      await assertPackRunning(prisma, pack.id);
      const stored = await storeWorkflowImage({
        image: generated,
        userId: pack.userId,
        requestId: pack.requestId,
        requestIndex,
        fetchFn,
        signal,
        env,
        namespace: "workflow/stickers",
      });
      await prisma.imageAsset.upsert({
        where: { requestId_requestIndex: { requestId: pack.requestId, requestIndex } },
        update: {},
        create: {
          userId: pack.userId,
          requestId: pack.requestId,
          requestIndex,
          prompt,
          model: config.model,
          size: "1024x1024",
          originalUrl: stored.originalUrl,
          thumbnailUrl: stored.thumbnailUrl,
          objectKey: stored.objectKey,
          mime: stored.mime,
          width: stored.width ?? null,
          height: stored.height ?? null,
        },
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof StickerPackStoppedError) throw error;
      lastError = error;
      if (attempt < maxAttempts) {
        await delay(5_000, undefined, { signal }).catch(() => {});
      }
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  return { ok: false, error: message.slice(0, 500) };
}

export async function runStickerPack(args: RunStickerPackArgs): Promise<StickerPackRow> {
  const { prisma, packId, fetchFn } = args;
  const env = args.env ?? process.env;
  const maxAttempts = args.maxAttempts ?? 3;

  // 租约：只有 queued 能被认领为 running
  const claimed = await prisma.stickerPack.updateMany({
    where: { id: packId, status: STICKER_PACK_STATUS.queued },
    data: { status: STICKER_PACK_STATUS.running, error: null, updatedAt: new Date() },
  });
  let pack = await getPack(prisma, packId);
  if (!pack) throw new Error("sticker pack not found");
  if (claimed.count === 0 && pack.status !== STICKER_PACK_STATUS.running) {
    const message = TERMINAL_STATUS_MESSAGE[pack.status] ?? `sticker pack is ${pack.status}`;
    throw new StickerPackStoppedError(message);
  }
  if (pack.status !== STICKER_PACK_STATUS.running) {
    pack = (await getPack(prisma, packId))!;
  }

  const presets = pack.presetKeys
    .map((key) => stickerPresetByKey(key))
    .filter((preset): preset is StickerPreset => preset !== null);
  if (presets.length === 0) {
    await updatePack(prisma, pack.id, { status: STICKER_PACK_STATUS.failed, error: "没有选择任何表情模板" });
    return (await getPack(prisma, pack.id))!;
  }

  try {
    const base = await resolveBaseImage({ prisma, pack, fetchFn, env, signal: args.signal });
    // 主形象已就绪：baseImageRequestId 可能在 resolve 中被写入，重读一次
    pack = (await getPack(prisma, pack.id))!;

    let completed = pack.completedCount;
    let failed = pack.failedCount;
    const failedLabels: string[] = [];

    for (let index = 0; index < presets.length; index++) {
      const preset = presets[index];
      // 断点续跑：已落盘的跳过
      const existing = await prisma.imageAsset.findUnique({
        where: { requestId_requestIndex: { requestId: pack.requestId, requestIndex: index } },
      });
      if (existing) {
        completed += 1;
        await updatePack(prisma, pack.id, { completedCount: completed });
        continue;
      }
      const result = await generateOneSticker({
        prisma,
        pack,
        base,
        preset,
        requestIndex: index,
        fetchFn,
        env,
        signal: args.signal,
        maxAttempts,
      });
      if (result.ok) {
        completed += 1;
      } else {
        failed += 1;
        failedLabels.push(preset.label);
      }
      // 心跳：逐张刷 updatedAt，reaper 不会误判卡单
      await updatePack(prisma, pack.id, { completedCount: completed, failedCount: failed });
      await args.onProgress?.(completed, failed, presets.length);
    }

    const error = failedLabels.length > 0 ? `以下 ${failedLabels.length} 张生成失败：${failedLabels.join("、")}` : null;
    await updatePack(prisma, pack.id, { status: STICKER_PACK_STATUS.completed, error });
    return (await getPack(prisma, pack.id))!;
  } catch (error) {
    if (error instanceof StickerPackStoppedError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await updatePack(prisma, pack.id, { status: STICKER_PACK_STATUS.failed, error: message.slice(0, 1000) });
    return (await getPack(prisma, pack.id))!;
  }
}

export interface PollStickerPackArgs {
  readonly prisma: PrismaClient;
  readonly packId: string;
  readonly fetchFn: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly maxWaitMs?: number;
}

/** 轮询等待 pack 进入终态（给 HTTP 上传接口用，避免客户端长轮询）。 */
export async function pollStickerPackForCompletion(args: PollStickerPackArgs): Promise<StickerPackRow> {
  const maxWaitMs = args.maxWaitMs ?? 30_000;
  const deadline = Date.now() + maxWaitMs;
  let pack = await getPack(args.prisma, args.packId);
  while (pack && !STICKER_PACK_FINAL_STATUSES.has(pack.status) && Date.now() < deadline) {
    await delay(2_000, undefined, { signal: args.signal }).catch(() => {});
    pack = await getPack(args.prisma, args.packId);
  }
  if (!pack) throw new Error("sticker pack not found");
  return pack;
}
