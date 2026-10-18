/**
 * 表情包工坊：任务执行器。
 *
 * 租约 + 执行归属：同一 pack 同一时间只有一个 runner 在推进；每轮执行分配唯一
 * executionToken，重试（/retry 或 reaper 后）会启动新 token。旧 runner 在每次
 * 落盘/状态更新时用 updateMany(where: { id, executionToken }) 校验归属，抢不到
 * 就抛 StickerPackStoppedError 退出，避免两轮同时生成造成重复付费。
 *
 * 计费安全：模型调用（付费）与落盘（存储/DB）分属两个重试段。模型成功返回后，
 * 若存储失败，重试只重跑落盘，不再调模型；落盘前先查资产是否已存在。
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { PrismaClient } from "@prisma/client";
import {
  callImageEdit,
  callImageGeneration,
} from "../_shared/image-service-calls.js";
import { DEFAULT_IMAGE_MODEL } from "../_shared/image-service-constants.js";
import { loadImageGenerationConfigForModel } from "../_shared/image-service-providers.js";
import { storeWorkflowImage } from "../_shared/image-service-storage.js";
import { getObject, loadS3Config, makeS3 } from "../../storage/s3.js";
import type { GeneratedImage } from "../_shared/image-service-types.js";
import {
  buildBaseCharacterPrompt,
  buildStickerPrompt,
  sniffImageMime,
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

/**
 * 归属校验：pack 必须处于 running，且 executionToken 与本轮一致。
 * 新一轮已接管（/retry 或用户重新触发）时旧 runner 必须停。
 */
async function assertOwnsPack(
  prisma: PrismaClient,
  packId: string,
  executionToken: string,
): Promise<StickerPackRow> {
  const pack = await getPack(prisma, packId);
  if (!pack) throw new StickerPackStoppedError("sticker pack not found");
  const message = TERMINAL_STATUS_MESSAGE[pack.status];
  if (message) throw new StickerPackStoppedError(message);
  if (pack.status !== STICKER_PACK_STATUS.running) {
    throw new StickerPackStoppedError(`sticker pack is ${pack.status}, not running`);
  }
  if (pack.executionToken !== executionToken) {
    throw new StickerPackStoppedError("sticker pack execution superseded by a newer run");
  }
  return pack;
}

/**
 * 归属写：只有「本轮 token 且状态仍为 running」能更新。reaper / /retry 撤销执行权
 * 后（状态变为 failed/queued，或 token 被清空），旧 runner 抢不到就抛
 * StickerPackStoppedError，直接退出，不再写库。
 */
async function updateOwnedPack(
  prisma: PrismaClient,
  packId: string,
  executionToken: string,
  data: Record<string, unknown>,
): Promise<void> {
  const updated = await prisma.stickerPack.updateMany({
    where: { id: packId, executionToken, status: STICKER_PACK_STATUS.running },
    data: { ...data, updatedAt: new Date() },
  });
  if (updated.count === 0) {
    throw new StickerPackStoppedError("sticker pack execution superseded by a newer run");
  }
}

interface BaseImage {
  readonly buffer: Buffer;
  readonly mime: string;
}

interface StickerAssetData {
  readonly userId: string;
  readonly requestId: string;
  readonly requestIndex: number;
  readonly prompt: string;
  readonly model: string;
  readonly size: string;
  readonly originalUrl: string;
  readonly thumbnailUrl: string;
  readonly objectKey: string | null;
  readonly mime: string;
  readonly width: number | null;
  readonly height: number | null;
}

/**
 * 原子资产提交：在同一个事务里先用带归属条件的 updateMany 拿 pack 行锁
 * （行锁保持到事务提交，并发 reaper/retry 无法在此期间撤权），再 upsert 资产。
 * 旧 runner 若已被撤销，updateMany 返回 0，直接抛 StickerPackStoppedError，
 * upsert 不会执行，避免把旧结果写入新一轮的资产表。
 */
async function commitStickerAsset(
  prisma: PrismaClient,
  packId: string,
  executionToken: string,
  asset: StickerAssetData,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const locked = await tx.stickerPack.updateMany({
      where: { id: packId, executionToken, status: STICKER_PACK_STATUS.running },
      data: { updatedAt: new Date() },
    });
    if (locked.count === 0) {
      throw new StickerPackStoppedError("sticker pack execution superseded by a newer run");
    }
    await tx.imageAsset.upsert({
      where: {
        requestId_requestIndex: { requestId: asset.requestId, requestIndex: asset.requestIndex },
      },
      update: {},
      create: {
        userId: asset.userId,
        requestId: asset.requestId,
        requestIndex: asset.requestIndex,
        prompt: asset.prompt,
        model: asset.model,
        size: asset.size,
        originalUrl: asset.originalUrl,
        thumbnailUrl: asset.thumbnailUrl,
        objectKey: asset.objectKey,
        mime: asset.mime,
        width: asset.width,
        height: asset.height,
      },
    });
  });
}

async function downloadToBaseImage(args: {
  fetchFn: typeof fetch;
  url: string;
  mime: string;
  signal?: AbortSignal;
}): Promise<BaseImage> {
  const response = await args.fetchFn(args.url, { signal: args.signal });
  if (!response.ok) throw new Error(`base character download ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, mime: args.mime };
}

async function resolveBaseImage(args: {
  prisma: PrismaClient;
  pack: StickerPackRow;
  executionToken: string;
  fetchFn: typeof fetch;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  maxAttempts: number;
}): Promise<BaseImage> {
  const { prisma, pack, executionToken, fetchFn, env, signal, maxAttempts } = args;
  // 1) 用户上传的参考图
  if (pack.referenceObjectKey) {
    const s3 = makeS3(loadS3Config(env));
    const buffer = await getObject(s3, pack.referenceObjectKey);
    return { buffer, mime: sniffImageMime(buffer) };
  }
  const baseRequestId = `${pack.requestId}-base`;
  // 2) pack 上已记录的主形象
  if (pack.baseImageRequestId) {
    const asset = await prisma.imageAsset.findUnique({
      where: { requestId_requestIndex: { requestId: pack.baseImageRequestId, requestIndex: 0 } },
    });
    if (!asset) throw new Error("base character image not found");
    return downloadToBaseImage({ fetchFn, url: asset.originalUrl, mime: asset.mime, signal });
  }
  // 3) 资产已落盘但 pack 没记上（上轮落盘成功、更新 pack 失败）：直接复用，不再调模型
  const existingBase = await prisma.imageAsset.findUnique({
    where: { requestId_requestIndex: { requestId: baseRequestId, requestIndex: 0 } },
  });
  if (existingBase) {
    await updateOwnedPack(prisma, pack.id, executionToken, { baseImageRequestId: baseRequestId });
    return downloadToBaseImage({ fetchFn, url: existingBase.originalUrl, mime: existingBase.mime, signal });
  }
  // 4) 文字描述模式：生成主形象。生成与落盘分离：模型成功后落盘失败只重试落盘。
  const config = loadImageGenerationConfigForModel(DEFAULT_IMAGE_MODEL, env);
  const prompt = buildBaseCharacterPrompt(pack.characterPrompt, pack.style);
  let generated: GeneratedImage | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      await assertOwnsPack(prisma, pack.id, executionToken);
      generated = await callImageGeneration({
        config,
        prompt,
        size: "1024x1024",
        fetchFn,
        signal,
        env,
      });
      break;
    } catch (error) {
      if (error instanceof StickerPackStoppedError) throw error;
      lastError = error;
      if (attempt < maxAttempts) await delay(5_000, undefined, { signal }).catch(() => {});
    }
  }
  if (!generated) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`base character generation failed: ${message}`);
  }
  lastError = null;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      await assertOwnsPack(prisma, pack.id, executionToken);
      const stored = await storeWorkflowImage({
        image: generated,
        userId: pack.userId,
        requestId: baseRequestId,
        requestIndex: 0,
        fetchFn,
        signal,
        env,
        namespace: "workflow/stickers",
      });
      await commitStickerAsset(prisma, pack.id, executionToken, {
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
      });
      await updateOwnedPack(prisma, pack.id, executionToken, { baseImageRequestId: baseRequestId });
      return downloadToBaseImage({ fetchFn, url: stored.originalUrl, mime: stored.mime, signal });
    } catch (error) {
      if (error instanceof StickerPackStoppedError) throw error;
      lastError = error;
      if (attempt < maxAttempts) await delay(5_000, undefined, { signal }).catch(() => {});
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`base character persist failed: ${message}`);
}

async function generateOneSticker(args: {
  prisma: PrismaClient;
  pack: StickerPackRow;
  executionToken: string;
  base: BaseImage;
  preset: StickerPreset;
  requestIndex: number;
  fetchFn: typeof fetch;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  maxAttempts: number;
}): Promise<{ ok: boolean; error?: string }> {
  const { prisma, pack, executionToken, base, preset, requestIndex, fetchFn, env, signal, maxAttempts } = args;
  const config = loadImageGenerationConfigForModel(DEFAULT_IMAGE_MODEL, env);
  const prompt = buildStickerPrompt(pack.characterPrompt, preset, pack.style);
  const assetWhere = { requestId_requestIndex: { requestId: pack.requestId, requestIndex } };

  // 付费前预查：资产已存在（快照过期、或并发写入）则直接成功，避免重复付费生成
  const preExisting = await prisma.imageAsset.findUnique({ where: assetWhere });
  if (preExisting) return { ok: true };

  // 阶段一：调模型（付费）。失败可重试；成功后进入阶段二，不再调模型。
  let generated: GeneratedImage | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      await assertOwnsPack(prisma, pack.id, executionToken);
      generated = await callImageEdit({
        config,
        prompt,
        referenceImages: [{ b64: base.buffer.toString("base64"), mime: base.mime }],
        fetchFn,
        size: "1024x1024",
        outputFormat: "png",
        signal,
        env,
      });
      break;
    } catch (error) {
      if (error instanceof StickerPackStoppedError) throw error;
      lastError = error;
      if (attempt < maxAttempts) {
        await delay(5_000, undefined, { signal }).catch(() => {});
      }
    }
  }
  if (!generated) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    return { ok: false, error: message.slice(0, 500) };
  }

  // 阶段二：落盘（存储 + DB）。失败只重试落盘；先查资产是否已存在，避免重复落盘。
  // 资产提交与归属校验在同一事务里原子执行：若本轮已被撤销，upsert 不执行。
  lastError = null;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      await assertOwnsPack(prisma, pack.id, executionToken);
      const existing = await prisma.imageAsset.findUnique({ where: assetWhere });
      if (!existing) {
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
        await commitStickerAsset(prisma, pack.id, executionToken, {
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
        });
      }
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

  // 租约：只有 queued 能被认领为 running，同时分配本轮 executionToken 并重置计数；
  // 没抢到就抛，避免重复付费生成。
  const executionToken = randomUUID();
  const claimed = await prisma.stickerPack.updateMany({
    where: { id: packId, status: STICKER_PACK_STATUS.queued },
    data: {
      status: STICKER_PACK_STATUS.running,
      executionToken,
      error: null,
      updatedAt: new Date(),
    },
  });
  if (claimed.count === 0) {
    const current = await getPack(prisma, packId);
    if (!current) throw new Error("sticker pack not found");
    const message = TERMINAL_STATUS_MESSAGE[current.status] ?? `sticker pack is ${current.status}, not queued`;
    throw new StickerPackStoppedError(message);
  }
  let pack = await getPack(prisma, packId);
  if (!pack) throw new Error("sticker pack not found");

  // 认领成功后再读续跑基准：认领前读到的快照可能过期（另一轮在此期间落盘），
  // 用过期快照会导致重复生成。本轮只增量计数，不跨轮累加。
  const existingAssets = await prisma.imageAsset.findMany({
    where: { requestId: pack.requestId },
    select: { requestIndex: true },
  });
  const doneIndexes = new Set(existingAssets.map((asset) => asset.requestIndex));
  const completedBase = doneIndexes.size;
  await updateOwnedPack(prisma, pack.id, executionToken, {
    completedCount: completedBase,
    failedCount: 0,
  });

  const presets = pack.presetKeys
    .map((key) => stickerPresetByKey(key))
    .filter((preset): preset is StickerPreset => preset !== null);
  if (presets.length === 0) {
    await updateOwnedPack(prisma, pack.id, executionToken, {
      status: STICKER_PACK_STATUS.failed,
      error: "没有选择任何表情模板",
    });
    return (await getPack(prisma, pack.id))!;
  }

  try {
    const base = await resolveBaseImage({
      prisma,
      pack,
      executionToken,
      fetchFn,
      env,
      signal: args.signal,
      maxAttempts,
    });
    // 主形象已就绪：baseImageRequestId 可能在 resolve 中被写入，重读一次
    pack = (await getPack(prisma, pack.id))!;

    let completed = completedBase;
    let failed = 0;
    const failedLabels: string[] = [];

    for (let index = 0; index < presets.length; index++) {
      const preset = presets[index];
      // 断点续跑：已落盘的跳过（计数已在 completedBase 里，不重复加）
      if (doneIndexes.has(index)) continue;
      const result = await generateOneSticker({
        prisma,
        pack,
        executionToken,
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
        doneIndexes.add(index);
      } else {
        failed += 1;
        failedLabels.push(preset.label);
      }
      // 心跳：逐张刷 updatedAt，reaper 不会误判卡单
      await updateOwnedPack(prisma, pack.id, executionToken, {
        completedCount: completed,
        failedCount: failed,
      });
      await args.onProgress?.(completed, failed, presets.length);
    }

    // 有缺图 → failed（可 /retry 补跑已落盘跳过）；全成功 → completed
    if (failed > 0) {
      const error = `以下 ${failedLabels.length} 张生成失败：${failedLabels.join("、")}`;
      await updateOwnedPack(prisma, pack.id, executionToken, {
        status: STICKER_PACK_STATUS.failed,
        error,
      });
    } else {
      await updateOwnedPack(prisma, pack.id, executionToken, {
        status: STICKER_PACK_STATUS.completed,
        error: null,
      });
    }
    return (await getPack(prisma, pack.id))!;
  } catch (error) {
    if (error instanceof StickerPackStoppedError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    // 终态写也带归属校验：若已易主（抛 StoppedError），新一轮负责 outcome，本轮直接退出
    await updateOwnedPack(prisma, pack.id, executionToken, {
      status: STICKER_PACK_STATUS.failed,
      error: message.slice(0, 1000),
    });
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
