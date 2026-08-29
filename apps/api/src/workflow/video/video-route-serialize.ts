/**
 * video-routes 拆分后的读取与序列化层:请求归一化、库表读取、对外 JSON 形状、
 * 以及写库用的 `Prisma.InputJson*` 构造。
 *
 * `serializeVideo` / `serializeTask` 是前端可见形状的唯一出处。路由里任何一处直接
 * `reply.send(row)` 都会把库字段泄给前端,所以新增字段要么加进这两个函数,要么就是
 * 明确不给前端 —— 没有第三种情况。
 *
 * `sumInputDurationSec` 的"任一素材缺时长则整体返回 0"不是容错,是计费口径:0 表示
 * "不可按时长计费",上游据此改走保守分支。别把它改成跳过缺时长的素材求和,那会按偏小的
 * 时长扣费。
 *
 * `requestPayloadJson` / `statusPayloadJson` 的返回类型是 `Prisma.InputJsonObject` 而不是
 * `any`:落库的 JSON 一旦带上 `undefined` 字段,prisma 会在运行时才报错。
 *
 * 依赖方向:schemas / support / contracts → 本文件。不 import task,更不 import 路由门面。
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  AUDIO_REFERENCE_ROLE,
  VIDEO_PRICE_CONFIGS,
  VIDEO_REFERENCE_ROLE,
  type ExtractedVideoStatus,
  type VideoAspectRatio,
  type VideoImageRole,
  type VideoModel,
  type VideoResolution,
  type VideoRoleInput,
  type VideoTaskStatus,
} from "../_shared/video-service.js";
import type { VideoTaskRow } from "./video-shared.js";
import type { VideoGenerationRequest } from "./video-route-schemas.js";
import { VIDEO_KEEP_LIMIT, VIDEO_TASK_KEEP_LIMIT } from "./video-route-support.js";
import type { BillingResourcePrice, VideoAssetRow } from "./video-route-contracts.js";

export function hasInputVideo(request: VideoGenerationRequest): boolean {
  return request.videoWithRoles.length > 0;
}

// 汇总多个输入视频的权威时长（秒）。仅统计存在且时长 > 0 的素材；任一素材缺时长则整体视为不可计费（返回 0）。
export async function sumInputDurationSec(prisma: PrismaClient, urls: readonly string[]): Promise<number> {
  const uniqueUrls = [...new Set(urls)];
  if (uniqueUrls.length === 0) return 0;
  const rows = await prisma.videoMaterial.findMany({
    where: { url: { in: uniqueUrls } },
    select: { url: true, durationSec: true },
  });
  const durationByUrl = new Map(rows.map((row) => [row.url, row.durationSec]));
  let total = 0;
  for (const url of uniqueUrls) {
    const seconds = durationByUrl.get(url) ?? 0;
    if (seconds <= 0) return 0;
    total += seconds;
  }
  return total;
}

export function normalizeRequest(data: VideoGenerationRequest) {
  return {
    requestId: data.requestId,
    model: data.model as VideoModel,
    prompt: data.prompt,
    durationSec: data.durationSec,
    aspectRatio: data.aspectRatio as VideoAspectRatio,
    resolution: data.resolution as VideoResolution,
    generateAudio: data.generateAudio,
    imageWithRoles: data.imageWithRoles as readonly VideoRoleInput<VideoImageRole>[],
    videoWithRoles: data.videoWithRoles as readonly VideoRoleInput<typeof VIDEO_REFERENCE_ROLE>[],
    audioWithRoles: data.audioWithRoles as readonly VideoRoleInput<typeof AUDIO_REFERENCE_ROLE>[],
    ...(data.seed !== undefined ? { seed: data.seed } : {}),
  };
}

export function serializeVideo(row: VideoAssetRow) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeTask(row: VideoTaskRow) {
  return {
    id: row.id,
    requestId: row.requestId,
    providerTaskId: row.providerTaskId,
    prompt: row.prompt,
    model: row.model,
    aspectRatio: row.aspectRatio,
    resolution: row.resolution,
    durationSec: row.durationSec,
    generateAudio: row.generateAudio,
    hasInputVideo: row.hasInputVideo,
    resourceKey: row.resourceKey,
    chargedPoints: row.chargedPoints,
    status: row.status as VideoTaskStatus,
    progress: row.progress,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export async function listRecentVideos(prisma: PrismaClient, userId: string): Promise<VideoAssetRow[]> {
  return prisma.videoAsset.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: VIDEO_KEEP_LIMIT,
    select: {
      id: true,
      requestId: true,
      requestIndex: true,
      prompt: true,
      model: true,
      aspectRatio: true,
      resolution: true,
      durationSec: true,
      originalUrl: true,
      mime: true,
      format: true,
      createdAt: true,
    },
  });
}

export async function listRecentTasks(prisma: PrismaClient, userId: string): Promise<VideoTaskRow[]> {
  return prisma.videoGenerationTask.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: VIDEO_TASK_KEEP_LIMIT,
  });
}

export function configuredVideoPriceRows(rows: readonly BillingResourcePrice[]) {
  return VIDEO_PRICE_CONFIGS.map((config) => {
    const found = rows.find((row) => row.resourceKey === config.resourceKey);
    // 有输入视频复合计价 VIDEO_IO：rate=输入单价/秒，outputRate=输出单价/秒；无输入视频保持 PER_UNIT。
    return {
      ...config,
      displayName: found?.displayName?.trim() || config.displayName,
      pricingType: config.hasInputVideo ? ("VIDEO_IO" as const) : ("PER_UNIT" as const),
      rate: found?.rate ?? 0,
      outputRate: config.hasInputVideo ? (found?.outputRate ?? 0) : 0,
      perUnits: found?.perUnits && found.perUnits > 0 ? found.perUnits : 1,
      enabled: found?.enabled ?? false,
    };
  });
}

function roleInputsJson(inputs: readonly VideoRoleInput<string>[]): Prisma.InputJsonArray {
  return inputs.map((item) => ({ url: item.url, role: item.role }));
}

export function requestPayloadJson(request: ReturnType<typeof normalizeRequest>): Prisma.InputJsonObject {
  return {
    model: request.model,
    client_business_id: request.requestId,
    prompt: request.prompt,
    duration: request.durationSec,
    aspect_ratio: request.aspectRatio,
    resolution: request.resolution,
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.model !== "seedance-2-mini" ? { generate_audio: request.generateAudio } : {}),
    ...(request.imageWithRoles.length > 0 ? { image_with_roles: roleInputsJson(request.imageWithRoles) } : {}),
    ...(request.videoWithRoles.length > 0 ? { video_with_roles: roleInputsJson(request.videoWithRoles) } : {}),
    ...(request.audioWithRoles.length > 0 ? { audio_with_roles: roleInputsJson(request.audioWithRoles) } : {}),
  };
}

export function statusPayloadJson(status: ExtractedVideoStatus): Prisma.InputJsonObject {
  return {
    providerTaskId: status.providerTaskId,
    providerStatus: status.providerStatus,
    status: status.status,
    progress: status.progress,
    videoUrl: status.videoUrl,
    format: status.format,
    error: status.error,
    completedAt: status.completedAt?.toISOString() ?? null,
    expiresAt: status.expiresAt?.toISOString() ?? null,
  };
}
