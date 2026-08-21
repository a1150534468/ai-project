import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import {
  buildLocalBusinessPromoShotPlan,
  hasAnyMaterials,
  localBusinessPromoDurationWindow,
  localBusinessPromoRenderResourceKey,
  requiredBriefFieldsMissing,
} from "./local-business-promo-core.js";
import {
  attemptLocalBusinessPromoRefund,
  buildPendingRefundMarker,
  LOCAL_BUSINESS_PROMO_REFUND_STATUS_NONE,
} from "./local-business-promo-refund.js";
import {
  authUserId,
  findOwnedProject,
  projectStateFromRow,
  safeErrorMessage,
  serializeProjectState,
  serializeRun,
} from "./local-business-promo-route-helpers.js";
import {
  projectParamsSchema,
  type LocalBusinessPromoRouteContext,
  type RunRow,
} from "./local-business-promo-route-types.js";
import { sanitizeLocalBusinessPromoMaterials } from "./local-business-promo-material-security.js";

export function registerLocalBusinessPromoRunRoutes(app: FastifyInstance, ctx: LocalBusinessPromoRouteContext) {
  app.post("/api/workflow/local-business-promos/projects/:projectId/generate", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(ctx.prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    if (project.status === "generating") {
      return reply.code(409).send({ error: "当前项目已有生成任务进行中" });
    }
    if (project.latestRunId) {
      const latestRun = await ctx.prisma.localBusinessPromoRun.findFirst({ where: { id: project.latestRunId, userId } });
      if (latestRun && (latestRun.status === "queued" || latestRun.status === "running" || latestRun.status === "merging")) {
        return reply.code(409).send({ error: "当前项目已有生成任务进行中" });
      }
    }
    const state = projectStateFromRow(project);
    const missing = requiredBriefFieldsMissing(state.brief);
    if (missing.length > 0) return reply.code(400).send({ error: `请先完善资料：${missing.join("、")}` });
    if (!state.scriptDraft.trim()) return reply.code(400).send({ error: "请先生成或填写口播文案" });
    if (!hasAnyMaterials(state.materials)) return reply.code(400).send({ error: "请先上传至少一组图片或视频素材" });
    if (project.activeNarrationAssetId) {
      const durationWindow = localBusinessPromoDurationWindow(state.settings.durationSec);
      const narrationAsset = await ctx.prisma.audioAsset.findFirst({
        where: { id: project.activeNarrationAssetId, userId, projectId: project.id, kind: "narration" },
      });
      if (narrationAsset && narrationAsset.durationSec > durationWindow.maxDurationSec) {
        return reply.code(400).send({
          error: `当前正式口播约 ${Number(narrationAsset.durationSec.toFixed(1))} 秒，已超出 ${state.settings.durationSec} 秒版本可接受的顺延范围（最多约 ${durationWindow.maxDurationSec} 秒），请重新生成更短的口播后再开始生成`,
        });
      }
    }
    let safeMaterials = state.materials;
    try {
      safeMaterials = sanitizeLocalBusinessPromoMaterials(userId, state.materials);
    } catch (error) {
      return reply.code(400).send({ error: safeErrorMessage(error) });
    }
    const shotPlan = buildLocalBusinessPromoShotPlan({
      brief: state.brief,
      materials: safeMaterials,
      settings: state.settings,
      scriptDraft: state.scriptDraft,
    });
    if (shotPlan.some((shot) => shot.materials.length === 0)) {
      return reply.code(400).send({ error: "存在镜头缺少可用素材，请补充素材后再生成" });
    }
    const operationId = `local-business-promo-render:${project.id}:${randomUUID()}`;
    const previousLatestRunId = project.latestRunId;
    const previousProjectStatus = project.status;
    let run: RunRow | null = null;
    let claimedProject = false;
    let charged = false;
    try {
      const claimed = await ctx.prisma.localBusinessPromoProject.updateMany({
        where: {
          id: project.id,
          userId,
          latestRunId: previousLatestRunId,
          status: previousProjectStatus,
          updatedAt: project.updatedAt,
        },
        data: { status: "generating" },
      });
      if (claimed.count !== 1) {
        return reply.code(409).send({ error: "项目状态已更新，请刷新后重试" });
      }
      claimedProject = true;

      run = await ctx.prisma.localBusinessPromoRun.create({
        data: {
          projectId: project.id,
          userId,
          billingOperationId: operationId,
          billingRefundedAt: null,
          billingRefundStatus: LOCAL_BUSINESS_PROMO_REFUND_STATUS_NONE,
          billingRefundError: null,
          billingRefundRetryCount: 0,
          billingRefundLastAttemptAt: null,
          billingRefundNextRetryAt: null,
          settingsSnapshot: state.settings,
          scriptSnapshot: state.scriptDraft,
          shotPlan,
          analysisSnapshot: Prisma.JsonNull,
          mergedAssetId: null,
          narrationAssetId: project.activeNarrationAssetId,
          bgmAssetId: state.settings.musicPreset === "no-bgm" ? null : project.activeBgmAssetId,
          status: "queued",
          progressPercent: 0,
          progressStage: "queued",
          progressMessage: "任务已入队，等待 worker 处理",
          error: null,
          startedAt: null,
          workerId: null,
        },
      });
      await ctx.billing.chargeResource({
        operationId,
        userId,
        resourceKey: localBusinessPromoRenderResourceKey(state.settings.durationSec),
        units: 1,
        accountType: "video",
      });
      charged = true;
      await ctx.prisma.localBusinessPromoProject.update({
        where: { id: project.id },
        data: {
          title: state.title,
          latestRunId: run.id,
          status: "generating",
        },
      });

      await ctx.enqueueRun({ runId: run.id });
      return reply.code(202).send({ success: true, data: { run: await serializeRun(ctx.prisma, run) } });
    } catch (error) {
      const message = safeErrorMessage(error);
      const failureMessage = `任务入队失败：${message}`;
      app.log.error({ err: error, projectId: project.id, runId: run?.id ?? null }, "failed to enqueue local business promo run");
      if (run) {
        await ctx.prisma.localBusinessPromoRun.update({
          where: { id: run.id },
          data: {
            status: "failed",
            progressStage: "failed",
            progressPercent: 100,
            progressMessage: failureMessage,
            error: failureMessage,
            completedAt: new Date(),
            ...(charged ? buildPendingRefundMarker("启动失败后退款处理中") : {}),
          },
        }).catch(() => undefined);
        await ctx.prisma.localBusinessPromoProject.update({
          where: { id: project.id },
          data: {
            latestRunId: previousLatestRunId,
            status: previousProjectStatus,
          },
        }).catch(() => undefined);
      } else if (claimedProject) {
        await ctx.prisma.localBusinessPromoProject.update({
          where: { id: project.id },
          data: {
            latestRunId: previousLatestRunId,
            status: previousProjectStatus,
          },
        }).catch(() => undefined);
      }
      if (charged && run) {
        const refundResult = await attemptLocalBusinessPromoRefund({
          run,
          billing: ctx.billing,
          fetchFn: ctx.fetchFn,
        });
        if (refundResult) {
          await ctx.prisma.localBusinessPromoRun.update({
            where: { id: run.id },
            data: refundResult.patch,
          }).catch(() => undefined);
          if (refundResult.status !== "refunded") {
            app.log.warn({
              operationId,
              runId: run.id,
              retryCount: refundResult.retryCount,
              nextRetryAt: refundResult.nextRetryAt,
              error: refundResult.error,
            }, "refund local business promo render charge deferred for retry");
          }
        }
      }
      return reply.code(500).send({ error: `启动任务失败：${message}` });
    }
  });

  app.get("/api/workflow/local-business-promos/projects/:projectId/runs", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(ctx.prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    return {
      success: true,
      data: {
        runs: (await serializeProjectState(ctx.prisma, userId, project)).runs,
      },
    };
  });

  app.get("/api/workflow/local-business-promos/projects/:projectId/state", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(ctx.prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    return {
      success: true,
      data: await serializeProjectState(ctx.prisma, userId, project),
    };
  });
}
