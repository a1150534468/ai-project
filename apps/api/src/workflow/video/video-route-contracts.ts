/**
 * video-routes 拆分后的契约层:计费客户端与依赖注入的形状,以及数据库行的读取形状。
 *
 * `BillingForVideos` 是"视频域只用得到计费客户端的这几个方法"的窄接口,而不是直接引用
 * `@ai-assistant/billing` 的完整客户端类型。这一点是刻意的:测试用一个手写对象就能注入,
 * 不必造出整个 billing client;同时它也是一份可读的清单 —— 视频链路会预留、结算、退款,
 * 不会做别的。往里加方法之前先想清楚是不是真该由视频域调。
 *
 * `VideoAssetRow` / `VideoWorkflowRouteDeps` 的字段就是 select 的字段,少一个就编译不过 ——
 * 所以这两个 interface 是 prisma 查询与路由返回之间的唯一约定,别在使用方另写局部类型。
 *
 * 依赖方向:本文件是叶子(只依赖 prisma / Anthropic 的类型)。不 import 同域任何文件。
 */

import type { PrismaClient } from "@prisma/client";
import type Anthropic from "@anthropic-ai/sdk";

export interface BillingResourcePrice {
  readonly resourceKey: string;
  readonly displayName: string;
  readonly pricingType: "PER_CALL" | "PER_UNIT" | "VIDEO_IO";
  readonly rate: number;
  readonly outputRate?: number;
  readonly perUnits: number;
  readonly enabled: boolean;
}

export interface BillingForVideos {
  chargeResource: (args: { operationId: string; userId: string; resourceKey: string; units: number; inputUnits?: number; accountType?: "points" | "video" }) => Promise<{ charged: number }>;
  settleVideoResource?: (args: { operationId: string; resourceKey: string; units: number; inputUnits?: number }) => Promise<{ settled: number }>;
  refundResource: (operationId: string) => Promise<{ success: boolean }>;
  listResourcePrices?: () => Promise<{ data: BillingResourcePrice[] }>;
  // 脚本生成走 token 计费（原价×2 在服务层实现）
  reserve: (args: { operationId: string; userId: string; type: string; model: string; inputTokens: number; maxOutputTokens: number }) => Promise<{ reserved: number }>;
  settle: (args: { operationId: string; userId: string; model: string; inputTokens: number; outputTokens: number }) => Promise<{ settled: number }>;
}

type ScheduleTask = (work: () => Promise<void>) => void;

export interface VideoWorkflowRouteDeps {
  readonly prisma?: PrismaClient;
  readonly billing?: BillingForVideos;
  readonly fetchFn?: typeof fetch;
  readonly scheduleTask?: ScheduleTask;
  readonly pollInitialDelayMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxPollAttempts?: number;
  readonly submitRetries?: number;
  readonly submitRetryDelayMs?: number;
  readonly llmClient?: Anthropic;
  // 视频/图片理解已切到 gemini 原生 vision（见 vision-client.ts）；测试注入用
  readonly visionCfg?: import("../_shared/vision-client.js").VisionConfig;
  readonly callVisionFn?: typeof import("../_shared/vision-client.js").callVision;
  /**
   * 给了才起主动扫的定时器。留成可选是为了让既有测试注册插件时不需要 redis，
   * 也避免测试进程里凭空多一个后台定时器。生产在 server.ts 注入。
   */
  readonly redis?: import("ioredis").Redis;
}

export interface VideoAssetRow {
  readonly id: string;
  readonly requestId: string;
  readonly requestIndex: number;
  readonly prompt: string;
  readonly model: string;
  readonly aspectRatio: string;
  readonly resolution: string;
  readonly durationSec: number;
  readonly originalUrl: string;
  readonly mime: string;
  readonly format: string;
  readonly createdAt: Date;
}
