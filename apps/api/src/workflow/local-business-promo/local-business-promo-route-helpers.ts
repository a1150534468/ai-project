import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { errorMessageOrFallback } from "../_shared/error-message.js";
import {
  formatProjectTitle,
  isProgressStage,
  isProjectStatus,
  materialCount,
  normalizeBrief,
  normalizeMaterials,
  normalizeSettings,
  normalizeShotPlan,
  type LocalBusinessPromoProgressStage,
} from "./local-business-promo-core.js";
import {
  AUDIO_KEEP_LIMIT,
  RUN_KEEP_LIMIT,
  type AudioAssetRow,
  type AudioTaskRow,
  type ProjectRow,
  type RunRow,
  type VideoAssetRow,
} from "./local-business-promo-route-types.js";
import {
  projectAudioBlobUrl,
  projectVideoBlobUrl,
} from "./local-business-promo-media-access.js";
export {
  audioBlobMimeFromQuery,
  hasValidProjectAudioBlobAccess,
  isAllowedProjectAudioKey,
  isAllowedProjectVideoKey,
  projectAudioBlobUrl,
  projectVideoBlobUrl,
  videoBlobMimeFromQuery,
} from "./local-business-promo-media-access.js";

export function authUserId(req: { readonly userId?: string }, reply: FastifyReply): string | null {
  const userId = req.userId?.trim();
  if (!userId) {
    void reply.code(401).send({ error: "未登录" });
    return null;
  }
  return userId;
}

export function safeErrorMessage(error: unknown): string {
  return errorMessageOrFallback(error, "操作失败");
}

export function serializeVideoAsset(row: NonNullable<VideoAssetRow>, playbackProjectId: string | null = null) {
  return {
    id: row.id,
    requestId: row.requestId,
    requestIndex: row.requestIndex,
    prompt: row.prompt,
    model: row.model,
    aspectRatio: row.aspectRatio,
    resolution: row.resolution,
    durationSec: row.durationSec,
    originalUrl: row.objectKey && playbackProjectId
      ? projectVideoBlobUrl(playbackProjectId, row.objectKey, row.mime)
      : row.originalUrl,
    mime: row.mime,
    format: row.format,
    createdAt: row.createdAt.toISOString(),
  };
}

const STALE_GENERATING_WITHOUT_RUN_MS = 30_000;

function isActiveProjectRunStatus(status: string) {
  return status === "queued" || status === "running" || status === "merging";
}

function projectStatusFromRecoveredRun(project: ProjectRow, run: RunRow | null): ProjectRow["status"] {
  if (!run) return "draft";
  if (isActiveProjectRunStatus(run.status)) return "generating";
  if (run.status === "completed") return "completed";
  if (run.status === "failed") return "failed";
  return "draft";
}

function staleGeneratingWithoutRun(project: ProjectRow) {
  return Date.now() - project.updatedAt.getTime() >= STALE_GENERATING_WITHOUT_RUN_MS;
}

export function serializeAudioAsset(row: NonNullable<AudioAssetRow>, playbackProjectId: string | null = row.projectId) {
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    provider: row.provider,
    providerModel: row.providerModel,
    projectId: row.projectId,
    requestId: row.requestId,
    originalUrl: row.objectKey && playbackProjectId
      ? projectAudioBlobUrl(playbackProjectId, row.objectKey, row.mime)
      : row.originalUrl,
    objectKey: row.objectKey,
    mime: row.mime,
    format: row.format,
    durationSec: row.durationSec,
    textContent: row.textContent,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeAudioTask(row: NonNullable<AudioTaskRow>) {
  return {
    id: row.id,
    requestId: row.requestId,
    kind: row.kind,
    provider: row.provider,
    providerModel: row.providerModel,
    status: row.status,
    error: row.error,
    inputPayload: row.inputPayload,
    resultPayload: row.resultPayload,
    assetId: row.assetId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export function projectStateFromRow(row: ProjectRow) {
  const brief = normalizeBrief(row.brief);
  return {
    id: row.id,
    title: formatProjectTitle(row.title, brief),
    brief,
    materials: normalizeMaterials(row.materials),
    settings: normalizeSettings(row.settings),
    scriptDraft: row.scriptDraft ?? "",
    latestRunId: row.latestRunId,
    status: isProjectStatus(row.status) ? row.status : "draft",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeProjectSummary(row: ProjectRow) {
  const project = projectStateFromRow(row);
  return {
    id: project.id,
    title: project.title,
    status: project.status,
    latestRunId: project.latestRunId,
    materialCount: materialCount(project.materials),
    updatedAt: project.updatedAt,
    createdAt: project.createdAt,
  };
}

export async function serializeRun(prisma: PrismaClient, row: RunRow) {
  const mergedAsset = row.mergedAssetId
    ? await prisma.videoAsset.findFirst({ where: { id: row.mergedAssetId, userId: row.userId } })
    : null;
  const progressStage: LocalBusinessPromoProgressStage = isProgressStage(row.progressStage)
    ? row.progressStage
    : row.status === "completed"
      ? "completed"
      : row.status === "failed"
        ? "failed"
        : row.status === "running" || row.status === "merging"
          ? "rendering"
          : "queued";
  return {
    id: row.id,
    projectId: row.projectId,
    settingsSnapshot: normalizeSettings(row.settingsSnapshot),
    scriptSnapshot: row.scriptSnapshot,
    shotPlan: normalizeShotPlan(row.shotPlan),
    mergedAssetId: row.mergedAssetId,
    mergedAsset: mergedAsset ? serializeVideoAsset(mergedAsset, row.projectId) : null,
    status: row.status,
    progressPercent: row.progressPercent,
    progressStage,
    progressMessage: row.progressMessage,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export async function findOwnedProject(prisma: PrismaClient, userId: string, projectId: string): Promise<ProjectRow | null> {
  const project = await prisma.localBusinessPromoProject.findFirst({ where: { id: projectId, userId } });
  if (!project) return null;
  return reconcileProjectRunState(prisma, userId, project);
}

export async function listProjectRuns(prisma: PrismaClient, userId: string, projectId: string): Promise<RunRow[]> {
  return prisma.localBusinessPromoRun.findMany({
    where: { userId, projectId },
    orderBy: { createdAt: "desc" },
    take: RUN_KEEP_LIMIT,
  });
}

export async function serializeProjectAudioState(prisma: PrismaClient, userId: string, project: ProjectRow) {
  const [
    voiceCloneSample,
    activeNarration,
    activeBgm,
    narrationHistory,
    bgmHistory,
    tasks,
  ] = await Promise.all([
    project.voiceCloneSampleAssetId
      ? prisma.audioAsset.findFirst({ where: { id: project.voiceCloneSampleAssetId, userId } })
      : Promise.resolve(null),
    project.activeNarrationAssetId
      ? prisma.audioAsset.findFirst({ where: { id: project.activeNarrationAssetId, userId } })
      : Promise.resolve(null),
    project.activeBgmAssetId
      ? prisma.audioAsset.findFirst({ where: { id: project.activeBgmAssetId, userId } })
      : Promise.resolve(null),
    prisma.audioAsset.findMany({
      where: { userId, projectId: project.id, kind: "narration" },
      orderBy: { createdAt: "desc" },
      take: AUDIO_KEEP_LIMIT,
    }),
    prisma.audioAsset.findMany({
      where: { userId, projectId: project.id, kind: "bgm" },
      orderBy: { createdAt: "desc" },
      take: AUDIO_KEEP_LIMIT,
    }),
    prisma.audioGenerationTask.findMany({
      where: { userId, projectId: project.id },
      orderBy: { createdAt: "desc" },
      take: AUDIO_KEEP_LIMIT,
    }),
  ]);
  return {
    voiceCloneSample: voiceCloneSample ? serializeAudioAsset(voiceCloneSample) : null,
    activeNarration: activeNarration ? serializeAudioAsset(activeNarration) : null,
    activeBgm: activeBgm ? serializeAudioAsset(activeBgm) : null,
    narrationHistory: narrationHistory.map((row) => serializeAudioAsset(row)),
    bgmHistory: bgmHistory.map((row) => serializeAudioAsset(row)),
    tasks: tasks.map(serializeAudioTask),
  };
}

export function nextProjectStatus(project: ProjectRow, overrides?: Partial<{ scriptDraft: string }>): ProjectRow["status"] {
  if (project.status === "generating") return "generating";
  if ((overrides?.scriptDraft ?? project.scriptDraft).trim().length > 0) return "draft";
  return "draft";
}

export async function reconcileProjectRunState(
  prisma: PrismaClient,
  userId: string,
  project: ProjectRow,
): Promise<ProjectRow> {
  if (project.status !== "generating") return project;

  const runs = await listProjectRuns(prisma, userId, project.id);
  const latestRun = project.latestRunId
    ? runs.find((run) => run.id === project.latestRunId) ?? await prisma.localBusinessPromoRun.findFirst({ where: { id: project.latestRunId, userId } })
    : null;

  if (latestRun) {
    if (isActiveProjectRunStatus(latestRun.status)) return project;
    return prisma.localBusinessPromoProject.update({
      where: { id: project.id },
      data: {
        latestRunId: latestRun.id,
        status: projectStatusFromRecoveredRun(project, latestRun),
      },
    });
  }

  if (!staleGeneratingWithoutRun(project)) return project;

  const newestRun = runs[0] ?? null;
  return prisma.localBusinessPromoProject.update({
    where: { id: project.id },
    data: {
      latestRunId: newestRun?.id ?? null,
      status: projectStatusFromRecoveredRun(project, newestRun),
    },
  });
}

export async function markRunFailed(prisma: PrismaClient, runId: string, projectId: string, message: string) {
  await prisma.localBusinessPromoRun.update({
    where: { id: runId },
    data: {
      status: "failed",
      progressStage: "failed",
      progressPercent: 100,
      progressMessage: message,
      error: message,
      completedAt: new Date(),
    },
  }).catch(() => undefined);
  await prisma.localBusinessPromoProject.update({
    where: { id: projectId },
    data: { status: "failed" },
  }).catch(() => undefined);
}

export async function serializeProjectState(prisma: PrismaClient, userId: string, project: ProjectRow) {
  const consistentProject = await reconcileProjectRunState(prisma, userId, project);
  const runs = await listProjectRuns(prisma, userId, consistentProject.id);
  const latestRun = consistentProject.latestRunId
    ? runs.find((run) => run.id === consistentProject.latestRunId) ?? await prisma.localBusinessPromoRun.findFirst({ where: { id: consistentProject.latestRunId, userId } })
    : null;
  return {
    project: projectStateFromRow(consistentProject),
    latestRun: latestRun ? await serializeRun(prisma, latestRun) : null,
    runs: await Promise.all(runs.map((run) => serializeRun(prisma, run))),
    audio: await serializeProjectAudioState(prisma, userId, consistentProject),
  };
}

export function createTransientAudioAsset(args: {
  readonly kind: NonNullable<AudioAssetRow>["kind"];
  readonly source: string;
  readonly provider?: string | null;
  readonly providerModel?: string | null;
  readonly requestId?: string | null;
  readonly originalUrl: string;
  readonly playbackUrl?: string;
  readonly objectKey?: string | null;
  readonly mime: string;
  readonly format: string;
  readonly durationSec: number;
  readonly textContent?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}) {
  return {
    id: `preview:${args.kind}:${randomUUID()}`,
    kind: args.kind,
    source: args.source,
    provider: args.provider ?? null,
    providerModel: args.providerModel ?? null,
    projectId: null,
    requestId: args.requestId ?? null,
    originalUrl: args.playbackUrl ?? args.originalUrl,
    objectKey: args.objectKey ?? null,
    mime: args.mime,
    format: args.format,
    durationSec: args.durationSec,
    textContent: args.textContent ?? null,
    metadata: args.metadata ?? { preview: true },
    createdAt: new Date().toISOString(),
  };
}
