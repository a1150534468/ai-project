/**
 * 拆分 image-routes.ts 时抽出的类型层：原来这些接口就写在插件文件顶部，
 * 现在 routes / task-runner 两处都要用。
 *
 * 只放类型，不放任何运行时代码——本文件编译产物为空，谁 import 都不会多出副作用。
 */

import type { Buffer } from "node:buffer";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { ImageUrlSigner } from "../../storage/cos-image-url.js";
import type { IMAGE_TASK_STATUS } from "./image-shared.js";

export type ScheduleTask = (work: () => Promise<void>) => void;
export type ImageTaskStatus = typeof IMAGE_TASK_STATUS[keyof typeof IMAGE_TASK_STATUS];

export type PromptOptimizer = (prompt: string) => Promise<string>;

export interface ImageWorkflowRouteDeps {
  readonly prisma?: PrismaClient;
  readonly fetchFn?: typeof fetch;
  readonly promptOptimizer?: PromptOptimizer;
  readonly scheduleTask?: ScheduleTask;
  readonly retryDelayMs?: number;
  readonly maxAttempts?: number;
  readonly staleTaskMs?: number;
  readonly loadStoredImage?: (objectKey: string) => Promise<Buffer>;
  readonly signImageUrl?: ImageUrlSigner;
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
