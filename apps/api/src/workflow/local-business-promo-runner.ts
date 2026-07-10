import type Anthropic from "@anthropic-ai/sdk";
import type { PrismaClient } from "@prisma/client";
import { UnrecoverableError } from "bullmq";
import { createLlmClient, loadLlmConfig } from "@yc/llm";
import { getPrisma } from "@yc/db";
import {
  LOCAL_BUSINESS_PROMO_VIDEO_MODEL,
  LOCAL_BUSINESS_PROMO_VIDEO_RESOLUTION,
  formatProjectTitle,
  resolveLocalBusinessPromoFinalDuration,
  normalizeBrief,
  normalizeSettings,
  normalizeShotPlan,
} from "./local-business-promo-core.js";
import {
  analyzeLocalBusinessPromoShot,
} from "./local-business-promo-edit-analysis.js";
import {
  renderLocalBusinessPromoVideo,
  type RenderLocalBusinessPromoVideoInput,
} from "./local-business-promo-render.js";
import {
  attemptLocalBusinessPromoRefund,
  type BillingForLocalBusinessPromoRefund,
  buildPendingRefundMarker,
} from "./local-business-promo-refund.js";
import {
  analysisProgress,
  buildAnalysisSnapshot,
  defaultWorkerId,
  findExistingMergedAsset,
  isRenderableShot,
  parseAnalysisSnapshot,
  renderingProgress,
  requireAudioAsset,
  requireProject,
  requireRun,
  resolveProgressStage,
  safeRunnerErrorMessage,
  toAnalysisSnapshotJson,
  upsertShotSnapshot,
} from "./local-business-promo-runner-support.js";
import { sanitizeLocalBusinessPromoShotPlan } from "./local-business-promo-material-security.js";

type AnalyzeShotFn = typeof analyzeLocalBusinessPromoShot;
type RenderVideoFn = (input: RenderLocalBusinessPromoVideoInput) => ReturnType<typeof renderLocalBusinessPromoVideo>;

export interface ExecuteLocalBusinessPromoRunInput {
  readonly runId: string;
  readonly prisma?: PrismaClient;
  readonly fetchFn?: typeof fetch;
  readonly client?: Anthropic;
  readonly analyzeShot?: AnalyzeShotFn;
  readonly renderVideo?: RenderVideoFn;
  readonly workerId?: string;
  readonly billing?: BillingForLocalBusinessPromoRefund;
}

export async function executeLocalBusinessPromoRun(input: ExecuteLocalBusinessPromoRunInput): Promise<void> {
  const prisma = input.prisma ?? getPrisma();
  const workerId = input.workerId ?? defaultWorkerId();
  const fetchFn = input.fetchFn ?? fetch;
  const analyzeShot = input.analyzeShot ?? analyzeLocalBusinessPromoShot;
  const renderVideo = input.renderVideo ?? renderLocalBusinessPromoVideo;
  const client = input.client ?? createLlmClient(loadLlmConfig());

  const run = await requireRun(prisma, input.runId);
  if (run.status === "completed" || run.billingRefundedAt) return;

  const project = await requireProject(prisma, run);
  const brief = normalizeBrief(project.brief);
  const settings = normalizeSettings(run.settingsSnapshot);
  const title = formatProjectTitle(project.title, brief);
  let shotPlan = normalizeShotPlan(run.shotPlan);
  let snapshots = parseAnalysisSnapshot(run.analysisSnapshot);

  try {
    shotPlan = sanitizeLocalBusinessPromoShotPlan(run.userId, shotPlan);
    const totalShots = shotPlan.length;
    await prisma.localBusinessPromoRun.update({
      where: { id: run.id },
      data: {
        status: "running",
        error: null,
        progressStage: resolveProgressStage(run) === "rendering" ? "rendering" : "analyzing",
        progressPercent: Math.max(run.progressPercent, shotPlan.every(isRenderableShot) ? 55 : 0),
        progressMessage: shotPlan.every(isRenderableShot) ? "AI 分析已完成，准备开始渲染" : "AI 正在分析素材与镜头匹配",
        startedAt: run.startedAt ?? new Date(),
        workerId,
        completedAt: null,
      },
    });
    for (let index = 0; index < shotPlan.length; index += 1) {
      const shot = shotPlan[index]!;
      if (isRenderableShot(shot)) continue;
      await prisma.localBusinessPromoRun.update({
        where: { id: run.id },
        data: {
          progressStage: "analyzing",
          progressPercent: analysisProgress(index, totalShots),
          progressMessage: `AI 正在分析第 ${index + 1}/${totalShots} 段素材`,
        },
      });
      const analyzed = await analyzeShot({
        brief,
        settings,
        shot,
        priorSelections: shotPlan.filter((candidate, candidateIndex) => candidateIndex !== index && isRenderableShot(candidate)),
        client,
        fetchFn,
      });
      shotPlan[index] = {
        ...analyzed.shot,
        taskStatus: "queued",
        error: null,
        assetId: null,
        assetUrl: null,
      };
      snapshots = upsertShotSnapshot(snapshots, analyzed.snapshot);
      await prisma.localBusinessPromoRun.update({
        where: { id: run.id },
        data: {
          shotPlan,
          analysisSnapshot: toAnalysisSnapshotJson(buildAnalysisSnapshot({ brief, settings, shots: snapshots })),
          progressStage: "analyzing",
          progressPercent: analysisProgress(index + 1, totalShots),
          progressMessage: `AI 已完成 ${index + 1}/${totalShots} 段素材分析`,
        },
      });
    }

    shotPlan = shotPlan.map((shot) => ({
      ...shot,
      taskStatus: "queued",
      error: null,
      assetId: null,
      assetUrl: null,
    }));

    const narrationAsset = await requireAudioAsset(prisma, run.userId, run.narrationAssetId, "当前口播素材");
    const bgmAsset = await requireAudioAsset(prisma, run.userId, run.bgmAssetId, "当前背景音乐素材");

    await prisma.localBusinessPromoRun.update({
      where: { id: run.id },
      data: {
        shotPlan,
        analysisSnapshot: toAnalysisSnapshotJson(buildAnalysisSnapshot({ brief, settings, shots: snapshots })),
        progressStage: "rendering",
        progressPercent: 55,
        progressMessage: totalShots > 0 ? `开始渲染第 1/${totalShots} 段镜头` : "开始渲染成片",
      },
    });

    const completedShots = new Set<string>();
    const rendered = await renderVideo({
      userId: run.userId,
      projectId: run.projectId,
      runId: run.id,
      aspectRatio: settings.aspectRatio,
      brief,
      subtitleStyle: settings.subtitleStyle,
      targetDurationSec: resolveLocalBusinessPromoFinalDuration(settings.durationSec, narrationAsset?.durationSec ?? null),
      shotPlan,
      narrationUrl: narrationAsset?.originalUrl ?? null,
      narrationObjectKey: narrationAsset?.objectKey ?? null,
      bgmUrl: bgmAsset?.originalUrl ?? null,
      bgmObjectKey: bgmAsset?.objectKey ?? null,
      fetchFn,
      onShotStart: async (shotId) => {
        shotPlan = shotPlan.map((shot) => shot.shotId === shotId ? { ...shot, taskStatus: "running", error: null } : shot);
        const runningIndex = Math.max(1, shotPlan.findIndex((shot) => shot.shotId === shotId) + 1);
        await prisma.localBusinessPromoRun.update({
          where: { id: run.id },
          data: {
            shotPlan,
            progressStage: "rendering",
            progressPercent: renderingProgress(completedShots.size, totalShots),
            progressMessage: `正在渲染第 ${runningIndex}/${totalShots} 段镜头`,
          },
        });
      },
      onShotComplete: async (shotId) => {
        completedShots.add(shotId);
        shotPlan = shotPlan.map((shot) => shot.shotId === shotId ? { ...shot, taskStatus: "completed", error: null } : shot);
        await prisma.localBusinessPromoRun.update({
          where: { id: run.id },
          data: {
            shotPlan,
            progressStage: "rendering",
            progressPercent: renderingProgress(completedShots.size, totalShots),
            progressMessage: completedShots.size >= totalShots
              ? "镜头渲染完成，正在上传成片"
              : `已完成 ${completedShots.size}/${totalShots} 段镜头渲染`,
          },
        });
      },
    });

    const mergedRequestId = `local-business-promo-render:${run.id}`;
    const existingAsset = await findExistingMergedAsset(prisma, run.userId, mergedRequestId);
    const mergedAsset = existingAsset ?? await prisma.videoAsset.create({
      data: {
        userId: run.userId,
        requestId: mergedRequestId,
        requestIndex: 0,
        prompt: `本地商家宣传剪辑：${title}`,
        model: LOCAL_BUSINESS_PROMO_VIDEO_MODEL,
        aspectRatio: settings.aspectRatio,
        resolution: LOCAL_BUSINESS_PROMO_VIDEO_RESOLUTION,
        durationSec: rendered.durationSec > 0 ? rendered.durationSec : settings.durationSec,
        originalUrl: rendered.url,
        objectKey: rendered.objectKey,
        mime: rendered.mime,
        format: rendered.format,
      },
    });

    await prisma.localBusinessPromoRun.update({
      where: { id: run.id },
      data: {
        status: "completed",
        progressStage: "completed",
        progressPercent: 100,
        progressMessage: "成片已生成",
        shotPlan,
        analysisSnapshot: toAnalysisSnapshotJson(buildAnalysisSnapshot({ brief, settings, shots: snapshots })),
        mergedAssetId: mergedAsset.id,
        error: null,
        completedAt: new Date(),
      },
    });
    await prisma.localBusinessPromoProject.update({
      where: { id: project.id },
      data: {
        latestRunId: run.id,
        status: "completed",
      },
    });
  } catch (error) {
    const message = safeRunnerErrorMessage(error);
    await prisma.localBusinessPromoRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        progressStage: "failed",
        progressPercent: 100,
        progressMessage: message,
        error: message,
        completedAt: new Date(),
        workerId,
        ...(run.billingOperationId && !run.billingRefundedAt
          ? buildPendingRefundMarker("执行失败后退款处理中")
          : {}),
      },
    }).catch(() => undefined);
    await prisma.localBusinessPromoProject.update({
      where: { id: project.id },
      data: { status: "failed" },
    }).catch(() => undefined);
    if (run.billingOperationId && !run.billingRefundedAt) {
      const refundResult = await attemptLocalBusinessPromoRefund({
        run,
        billing: input.billing,
        fetchFn,
      });
      if (refundResult) {
        await prisma.localBusinessPromoRun.update({
          where: { id: run.id },
          data: refundResult.patch,
        }).catch(() => undefined);
        if (refundResult.status !== "refunded") {
          throw new UnrecoverableError(`${message}；退款将在后台继续重试`);
        }
      }
    }
    throw new UnrecoverableError(message);
  }
}
