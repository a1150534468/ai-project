import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@ai-assistant/db";
import { getS3 } from "../../storage/s3.js";
import { putObject } from "../../storage/s3-objects.js";
import { createImageUrlSigner, type ImageUrlSigner } from "../../storage/cos-image-url.js";
import { reapStickerPacks, type ReapStickerPacksResult } from "./sticker-reaper.js";
import { runStickerPack } from "./sticker-task-runner.js";
import { loadStickerStaleTaskMs } from "./sticker-shared.js";

/**
 * sticker 的路由上下文（对齐 transcription-route-context 的形状）。
 *
 * 此前 sticker-task-routes 直接吃 (app, prisma)，执行靠 handler 里动态
 * import("./sticker-task-runner.js")，上传路由自己构造 S3 —— 没法注入假的
 * 调度/存储，路由层零测试。现在调度、存储、签名都从这里进，测试用假
 * context 即可断言 401 / 409 / 413 分支。
 */
export interface StickerRouteDeps {
  readonly prisma?: PrismaClient;
  readonly fetchFn?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly startPack?: (packId: string) => void;
  readonly storeReference?: (objectKey: string, body: Buffer, contentType: string) => Promise<void>;
  readonly signImageUrl?: ImageUrlSigner;
}

export interface StickerRouteContext {
  readonly app: FastifyInstance;
  readonly prisma: PrismaClient;
  readonly fetchFn: typeof fetch;
  readonly env: NodeJS.ProcessEnv;
  readonly staleTaskMs: number;
  /** 参考图落对象存储（上传路由用）。 */
  readonly storeReference: (objectKey: string, body: Buffer, contentType: string) => Promise<void>;
  readonly signImageUrl: ImageUrlSigner;
  /** 触发一次 pack 执行（异步，HTTP 不等待）。 */
  readonly startPack: (packId: string) => void;
  /** 卡单处理入口：sticker 的 stale 语义是置 failed（见 sticker-reaper 的论证），不是 resume。 */
  readonly resumeStale: () => Promise<ReapStickerPacksResult>;
}

export function createStickerRouteContext(
  app: FastifyInstance,
  deps: StickerRouteDeps = {},
): StickerRouteContext {
  const prisma = deps.prisma ?? getPrisma();
  const fetchFn = deps.fetchFn ?? fetch;
  const env = deps.env ?? process.env;

  const startPack = deps.startPack ?? ((packId: string) => {
    void runStickerPack({ prisma, packId, fetchFn, env }).catch((error) => {
      app.log.error(error, "sticker pack run failed");
    });
  });

  return {
    app,
    prisma,
    fetchFn,
    env,
    staleTaskMs: loadStickerStaleTaskMs(env),
    storeReference: deps.storeReference
      ?? ((objectKey, body, contentType) => putObject(getS3(env), objectKey, body, contentType, {})),
    signImageUrl: deps.signImageUrl ?? createImageUrlSigner(env),
    startPack,
    resumeStale: () => reapStickerPacks(prisma, env),
  };
}
