/**
 * 拆分 image-routes.ts 时抽出的类型层：原来这些接口就写在插件文件顶部，
 * 现在 routes / billing / task-runner 三处都要用。
 *
 * 只放类型，不放任何运行时代码——本文件编译产物为空，谁 import 都不会多出副作用。
 */

import type { Buffer } from "node:buffer";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { WorkflowResourcePriceRow } from "../_shared/workflow-pricing.js";
import type { IMAGE_TASK_STATUS } from "./image-shared.js";

export interface BillingForImages {
  reserveResource: (args: { operationId: string; userId: string; resourceKey: string; units: number; reservationTtlSeconds?: number }) => Promise<{ reserved: number }>;
  settleResource: (args: { operationId: string; resourceKey: string; units: number }) => Promise<{ settled: number }>;
  refundResource: (operationId: string) => Promise<{ success: boolean }>;
  reserve: (args: { operationId: string; userId: string; type: string; model: string; inputTokens: number; maxOutputTokens: number }) => Promise<{ reserved: number }>;
  settle: (args: { operationId: string; userId: string; model: string; inputTokens: number; outputTokens: number; cacheInputTokens?: number; cacheOutputTokens?: number }) => Promise<{ settled: number }>;
  listResourcePrices?: () => Promise<{ data: WorkflowResourcePriceRow[] }>;
}

export type ScheduleTask = (work: () => Promise<void>) => void;
export type ImageTaskStatus = typeof IMAGE_TASK_STATUS[keyof typeof IMAGE_TASK_STATUS];
export interface PromptOptimizationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheInputTokens?: number;
  readonly cacheOutputTokens?: number;
}

export interface OptimizedPromptResult {
  readonly prompt: string;
  readonly model: string;
  readonly usage: PromptOptimizationUsage;
}

export type PromptOptimizer = (prompt: string) => Promise<string | OptimizedPromptResult>;

export interface ImageWorkflowRouteDeps {
  readonly prisma?: PrismaClient;
  readonly billing?: BillingForImages;
  readonly fetchFn?: typeof fetch;
  readonly promptOptimizer?: PromptOptimizer;
  readonly scheduleTask?: ScheduleTask;
  readonly retryDelayMs?: number;
  readonly maxAttempts?: number;
  readonly staleTaskMs?: number;
  readonly loadStoredImage?: (objectKey: string) => Promise<Buffer>;
  /**
   * 给了才起主动扫的定时器。留成可选是为了让既有测试注册插件时不需要 redis，
   * 也避免测试进程里凭空多一个后台定时器。生产在 server.ts 注入。
   */
  readonly redis?: Redis;
}

export interface RetryOptions {
  readonly retryDelayMs: number;
  readonly maxAttempts?: number;
  readonly onRetry?: (error: unknown, attempt: number) => Promise<void>;
  readonly shouldStop?: (error: unknown) => boolean;
}
