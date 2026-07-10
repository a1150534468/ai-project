import type {
  LocalBusinessPromoAudioState,
  LocalBusinessPromoOptions,
  LocalBusinessPromoProject,
  LocalBusinessPromoProjectSummary,
  LocalBusinessPromoRun,
  LocalBusinessPromoSettings,
  WorkflowAudioAsset,
} from "../../workflowLocalBusinessPromoApi";
import { countProjectMaterials } from "./localBusinessPromoWorkflowModel";

export type NarrationPreviewState = "idle" | "loading" | "playing" | "ready";
export type LocalBusinessPromoStudioView = "list" | "studio";
export type LocalBusinessPromoBgmMode = "preset" | "upload" | "none";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败";
}

export function playbackErrorMessage(error: unknown, fallback: string): string {
  const message = errorMessage(error);
  return /no supported source|notsupportederror|media resource/i.test(message) ? fallback : message;
}

export function toSummary(project: LocalBusinessPromoProject): LocalBusinessPromoProjectSummary {
  return {
    id: project.id,
    title: project.title,
    status: project.status,
    latestRunId: project.latestRunId,
    materialCount: countProjectMaterials(project.materials),
    updatedAt: project.updatedAt,
    createdAt: project.createdAt,
  };
}

export function projectTitle(project: LocalBusinessPromoProject | null): string {
  if (!project) return "本地商家宣传剪辑";
  return project.brief.storeName.trim() || project.title;
}

export function deriveBgmMode(
  project: LocalBusinessPromoProject | null,
  audio: LocalBusinessPromoAudioState,
): LocalBusinessPromoBgmMode {
  if (project?.settings.musicPreset === "no-bgm") return "none";
  return audio.activeBgm?.source === "upload" ? "upload" : "preset";
}

export function firstAvailableMusicPreset(options: LocalBusinessPromoOptions): LocalBusinessPromoSettings["musicPreset"] {
  return options.musicPresets.find((item) => item.value !== "no-bgm")?.value ?? "light-explore";
}

export function assetMusicPreset(asset: WorkflowAudioAsset | null): LocalBusinessPromoSettings["musicPreset"] | null {
  if (!asset?.metadata || typeof asset.metadata !== "object") return null;
  const candidate = (asset.metadata as { readonly musicPreset?: unknown }).musicPreset;
  return typeof candidate === "string" ? candidate as LocalBusinessPromoSettings["musicPreset"] : null;
}

export function previewAspectRatioValue(value: string | null | undefined): string {
  if (value === "16:9") return "16 / 9";
  if (value === "1:1") return "1 / 1";
  return "9 / 16";
}

export function previewFrameWidthClass(value: string | null | undefined): string {
  if (value === "16:9") return "max-w-[720px]";
  if (value === "1:1") return "max-w-[460px]";
  return "max-w-[360px]";
}

export function latestCompletedShots(run: LocalBusinessPromoRun | null): number {
  return run?.shotPlan.filter((shot) => shot.taskStatus === "completed").length ?? 0;
}
