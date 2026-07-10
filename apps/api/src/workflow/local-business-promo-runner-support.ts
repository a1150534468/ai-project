import { randomUUID } from "node:crypto";
import os from "node:os";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@yc/db";
import {
  isProgressStage,
  type LocalBusinessPromoBrief,
  type LocalBusinessPromoProgressStage,
  type LocalBusinessPromoSettings,
  type LocalBusinessPromoShotPlanEntry,
} from "./local-business-promo-core.js";
import type { LocalBusinessPromoEditPlanSnapshot } from "./local-business-promo-edit-analysis.js";

type ProjectRow = NonNullable<Awaited<ReturnType<ReturnType<typeof getPrisma>["localBusinessPromoProject"]["findFirst"]>>>;
type RunRow = NonNullable<Awaited<ReturnType<ReturnType<typeof getPrisma>["localBusinessPromoRun"]["findFirst"]>>>;
type AudioAssetRow = NonNullable<Awaited<ReturnType<ReturnType<typeof getPrisma>["audioAsset"]["findFirst"]>>>;
type VideoAssetRow = NonNullable<Awaited<ReturnType<ReturnType<typeof getPrisma>["videoAsset"]["findFirst"]>>>;

interface AnalysisSnapshot {
  readonly version: "v1";
  readonly analyzedAt: string;
  readonly brief: {
    readonly storeName: string;
    readonly industry: string;
    readonly cityArea: string;
  };
  readonly settings: {
    readonly direction: string;
    readonly durationSec: number;
    readonly aspectRatio: string;
  };
  readonly shots: LocalBusinessPromoEditPlanSnapshot["shots"];
}

export function toAnalysisSnapshotJson(snapshot: AnalysisSnapshot): Prisma.InputJsonValue {
  return snapshot as unknown as Prisma.InputJsonValue;
}

export function safeRunnerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "本地商家宣传剪辑执行失败";
}

export function defaultWorkerId(): string {
  return `${process.pid}-${os.hostname()}-${randomUUID()}`;
}

export function resolveProgressStage(run: RunRow): LocalBusinessPromoProgressStage {
  if (isProgressStage(run.progressStage)) return run.progressStage;
  if (run.status === "completed") return "completed";
  if (run.status === "failed") return "failed";
  return "queued";
}

export function isRenderableShot(shot: LocalBusinessPromoShotPlanEntry): boolean {
  return Boolean(shot.selectedMaterialUrl && shot.selectedMaterialMime && shot.renderMode);
}

export function upsertShotSnapshot(
  snapshots: LocalBusinessPromoEditPlanSnapshot["shots"],
  next: LocalBusinessPromoEditPlanSnapshot["shots"][number],
): LocalBusinessPromoEditPlanSnapshot["shots"] {
  const filtered = snapshots.filter((item) => item.shotId !== next.shotId);
  return [...filtered, next];
}

export function parseAnalysisSnapshot(raw: unknown): LocalBusinessPromoEditPlanSnapshot["shots"] {
  if (!raw || typeof raw !== "object") return [];
  const row = raw as { readonly shots?: unknown };
  if (!Array.isArray(row.shots)) return [];
  return row.shots.filter((item): item is LocalBusinessPromoEditPlanSnapshot["shots"][number] => {
    if (!item || typeof item !== "object") return false;
    const shot = item as Record<string, unknown>;
    return typeof shot.shotId === "string"
      && typeof shot.rationale === "string"
      && Array.isArray(shot.materialNotes);
  });
}

export function buildAnalysisSnapshot(args: {
  readonly brief: LocalBusinessPromoBrief;
  readonly settings: LocalBusinessPromoSettings;
  readonly shots: LocalBusinessPromoEditPlanSnapshot["shots"];
}): AnalysisSnapshot {
  return {
    version: "v1",
    analyzedAt: new Date().toISOString(),
    brief: {
      storeName: args.brief.storeName,
      industry: args.brief.industry,
      cityArea: args.brief.cityArea,
    },
    settings: {
      direction: args.settings.direction,
      durationSec: args.settings.durationSec,
      aspectRatio: args.settings.aspectRatio,
    },
    shots: args.shots,
  };
}

export function analysisProgress(completed: number, total: number): number {
  if (total <= 0) return 15;
  return Math.min(50, Math.max(8, Math.round((completed / total) * 50)));
}

export function renderingProgress(completed: number, total: number): number {
  if (total <= 0) return 80;
  return Math.min(96, Math.max(55, 55 + Math.round((completed / total) * 40)));
}

export async function requireRun(prisma: PrismaClient, runId: string): Promise<RunRow> {
  const run = await prisma.localBusinessPromoRun.findFirst({ where: { id: runId } });
  if (!run) throw new Error("运行记录不存在");
  return run;
}

export async function requireProject(prisma: PrismaClient, run: RunRow): Promise<ProjectRow> {
  const project = await prisma.localBusinessPromoProject.findFirst({
    where: { id: run.projectId, userId: run.userId },
  });
  if (!project) throw new Error("宣传项目不存在");
  return project;
}

export async function requireAudioAsset(
  prisma: PrismaClient,
  userId: string,
  assetId: string | null | undefined,
  label: string,
): Promise<AudioAssetRow | null> {
  if (!assetId) return null;
  const asset = await prisma.audioAsset.findFirst({
    where: { id: assetId, userId },
  });
  if (!asset) throw new Error(`${label}不存在或已失效`);
  return asset;
}

export async function findExistingMergedAsset(
  prisma: PrismaClient,
  userId: string,
  requestId: string,
): Promise<VideoAssetRow | null> {
  const asset = await prisma.videoAsset.findFirst({
    where: { userId, requestId },
  });
  return asset ?? null;
}

export type { AudioAssetRow, ProjectRow, RunRow, VideoAssetRow };
