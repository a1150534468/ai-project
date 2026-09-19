import type { FastifyInstance } from "fastify";
import { createImageUrlSigner } from "../../storage/cos-image-url.js";
import { getPrisma } from "@ai-assistant/db";
import { getObject, loadS3Config, makeS3 } from "../../storage/s3.js";
import { enqueueCodexPetRun } from "./codex-pet-queue.js";
import { IMAGE_REFERENCE_MIME_TYPES } from "../_shared/image-service.js";
import { isCodexPetArtifactObjectKey } from "./codex-pet-storage.js";
import {
  CODEX_PET_IMAGE_MODELS,
  CODEX_PET_VISUAL_QA_MODEL,
} from "./codex-pet-model-contract.js";
import { CODEX_PET_LEGACY_READ_ONLY_STATUS } from "./codex-pet-read-only-archive.js";
import { validateCodexPetReferenceAsset } from "./codex-pet-route-helpers.js";
import type { CodexPetRouteDeps, RunShape } from "./codex-pet-route-types.js";

// 拆分 codex-pet-routes.ts 时抽出的共享上下文：原来是插件函数体顶部的依赖解析和
// 8 个闭包，各路由分组都要用。类型由返回值推导，避免在这里再手写一份签名。
export function createCodexPetRouteContext(app: FastifyInstance, deps: CodexPetRouteDeps) {
  const prisma = deps.prisma ?? getPrisma();
  const enqueueRun = deps.enqueueRun ?? ((runId: string) => enqueueCodexPetRun({ runId }));
  const signImageUrl = deps.signImageUrl ?? createImageUrlSigner();
  const now = deps.now ?? (() => new Date());
  const loadArtifact = deps.loadArtifact ?? ((objectKey: string) => {
    // The production loader is the last boundary before S3. Embedded tests
    // may provide an in-memory loader with synthetic keys, but the real route
    // must never follow a database row outside our private prefix.
    // The caller performs the row-level ownership check before invoking this
    // loader. Keep the generic namespace guard here as defense in depth.
    if (!isCodexPetArtifactObjectKey(objectKey)) throw new Error("invalid Codex pet artifact object key");
    return getObject(makeS3(loadS3Config()), objectKey);
  });
  const validateReferenceAsset = deps.validateReferenceAsset ?? ((asset: {
    readonly id: string;
    readonly userId: string;
    readonly objectKey: string;
    readonly mime: string;
  }) => validateCodexPetReferenceAsset(
    asset,
    (objectKey) => getObject(makeS3(loadS3Config()), objectKey),
  ));

  async function ownedProject(userId: string, projectId: string) {
    return prisma.codexPetProject.findFirst({ where: { id: projectId, userId, deletedAt: null } });
  }

  async function ownedRun(userId: string, projectId: string, runId: string) {
    return prisma.codexPetRun.findFirst({ where: { id: runId, projectId, userId } });
  }

  async function validateReferenceAssets(userId: string, assetIds: readonly string[]): Promise<boolean> {
    if (assetIds.length === 0) return true;
    const assets = await prisma.imageAsset.findMany({
      where: { userId, id: { in: [...assetIds] } },
      select: { id: true, objectKey: true, mime: true },
    });
    if (assets.length !== assetIds.length) return false;
    if (!assets.every((asset) => Boolean(asset.objectKey)
      && IMAGE_REFERENCE_MIME_TYPES.has(asset.mime.toLowerCase().split(";", 1)[0]!))) return false;
    const checks = await Promise.all(assets.map((asset) => validateReferenceAsset({
      id: asset.id,
      userId,
      objectKey: asset.objectKey!,
      mime: asset.mime,
    }).catch(() => false)));
    return checks.every(Boolean);
  }

  async function codexPetModelOptions() {
    // 模型广场的动态目录已下线，只保留模型合约内的固定选项（原先取不到目录时
    // 走的就是这份回落清单）。
    return {
      visualModels: [{ model: CODEX_PET_VISUAL_QA_MODEL, displayName: "GPT-5.6 Sol" }],
      imageModels: CODEX_PET_IMAGE_MODELS.map((model) => ({ model, displayName: "GPT Image 2" })),
    } as const;
  }

  async function selectedVisualModelIsAvailable(model: string): Promise<boolean> {
    const options = await codexPetModelOptions();
    return options.visualModels.some((candidate) => candidate.model === model);
  }

  async function createCancellation(
    userId: string,
    projectId: string,
    runId: string,
  ): Promise<{ readonly run: RunShape; readonly eventSequences: readonly number[] }> {
    return prisma.$transaction(async (tx) => {
      // pg_advisory_xact_lock returns PostgreSQL `void`. Prisma attempts to
      // deserialize SELECT rows issued through $queryRawUnsafe and raises
      // P2010 for that type, so execute the statement without decoding rows.
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet-cancel:${runId}`);
      await tx.$queryRawUnsafe('SELECT "id" FROM "CodexPetRun" WHERE "id" = $1 FOR UPDATE', runId);
      const current = await tx.codexPetRun.findFirst({ where: { id: runId, projectId, userId } });
      if (!current) throw new Error("CODEX_PET_RUN_NOT_FOUND");
      if (current.status === "ready" || current.status === "failed" || current.status === CODEX_PET_LEGACY_READ_ONLY_STATUS) {
        throw new Error("CODEX_PET_RUN_TERMINAL");
      }
      // 已取消是终态，重复取消保持幂等：原样返回，不再发第二条事件。
      if (current.status === "cancelled") {
        return { run: current as RunShape, eventSequences: [] };
      }
      if (current.workerId && current.cancelRequested) {
        return { run: current as RunShape, eventSequences: [] };
      }

      // A live worker may still finish an image-generation request after this
      // transaction begins. Persist the flag and let that worker close the run
      // only after it has stopped.
      if (current.workerId) {
        const requested = await tx.codexPetRun.update({
          where: { id: current.id },
          data: {
            cancelRequested: true,
            progressMessage: "正在取消桌宠制作",
            lastEventSequence: { increment: 1 },
          },
        });
        await tx.codexPetEvent.create({
          data: {
            projectId,
            runId,
            userId,
            sequence: requested.lastEventSequence,
            type: "run.cancellation_requested",
            stage: requested.progressStage,
            message: "已请求取消桌宠制作，正在等待当前子任务停止",
            progress: requested.progressPercent,
            payload: {},
          },
        });
        return { run: requested as RunShape, eventSequences: [requested.lastEventSequence] };
      }

      const cancelledAt = now();
      const updated = await tx.codexPetRun.update({
        where: { id: current.id },
        data: {
          cancelRequested: true,
          status: "cancelled",
          progressStage: "cancelled",
          progressMessage: "用户已取消",
          completedAt: cancelledAt,
          lastEventSequence: { increment: 1 },
        },
      });
      await tx.codexPetEvent.create({
        data: {
          projectId,
          runId,
          userId,
          sequence: updated.lastEventSequence,
          type: "run.cancelled",
          stage: "cancelled",
          message: "用户已取消桌宠制作",
          progress: updated.progressPercent,
          payload: { hasSuccessfulImage: updated.hasSuccessfulImage },
        },
      });

      await tx.codexPetProject.updateMany({
        where: { id: projectId, userId, latestRunId: runId, status: { not: "deleting" } },
        data: { status: "cancelled" },
      });
      return { run: updated as RunShape, eventSequences: [updated.lastEventSequence] };
    });
  }

  return {
    deps,
    prisma,
    enqueueRun,
    now,
    loadArtifact,
    signImageUrl,
    validateReferenceAsset,
    ownedProject,
    ownedRun,
    validateReferenceAssets,
    codexPetModelOptions,
    selectedVisualModelIsAvailable,
    createCancellation,
  };
}

export type CodexPetRouteContext = ReturnType<typeof createCodexPetRouteContext>;
