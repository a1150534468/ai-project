import { writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { loadWorkflowMediaBuffer } from "./workflow-media-loader.js";
import type {
  LocalBusinessPromoAspectRatio,
  LocalBusinessPromoShotPlanEntry,
} from "./local-business-promo-core.js";

export function sanitizeExt(value: string) {
  return /^[a-z0-9]{2,8}$/i.test(value) ? value.toLowerCase() : "bin";
}

export function extensionFromMimeOrUrl(mime: string, url: string) {
  if (mime.startsWith("video/webm")) return "webm";
  if (mime.startsWith("video/quicktime")) return "mov";
  if (mime.startsWith("video/")) return "mp4";
  if (mime.startsWith("image/png")) return "png";
  if (mime.startsWith("image/jpeg")) return "jpg";
  const ext = sanitizeExt(extname(new URL(url).pathname).replace(/^\./, ""));
  return ext || "bin";
}

export async function fetchToFile(args: {
  readonly fetchFn: typeof fetch;
  readonly url: string;
  readonly mime: string;
  readonly objectKey?: string | null;
  readonly outputPath: string;
}): Promise<{ readonly filePath: string; readonly mime: string }> {
  const loaded = await loadWorkflowMediaBuffer({
    source: {
      url: args.url,
      mime: args.mime,
      objectKey: args.objectKey ?? null,
    },
    fetchFn: args.fetchFn,
    allowUrlFallback: args.objectKey ? false : undefined,
    fetchOptions: { method: "GET" },
    fetchErrorMessage: (status) => `素材下载失败：${status}`,
  });
  await writeFile(args.outputPath, loaded.buffer);
  return {
    filePath: args.outputPath,
    mime: args.mime,
  };
}

export function resolveSelectedMaterialObjectKey(shot: LocalBusinessPromoShotPlanEntry): string | null {
  const directMatch = shot.materials.find((material) =>
    material.url === shot.selectedMaterialUrl
    && material.mime === shot.selectedMaterialMime);
  if (directMatch?.objectKey) return directMatch.objectKey;

  if (!shot.selectedMaterialName) return null;
  const namedMatch = shot.materials.find((material) =>
    material.name === shot.selectedMaterialName
    && material.mime === shot.selectedMaterialMime);
  return namedMatch?.objectKey ?? null;
}

export function stretchShotPlanToDuration(
  shotPlan: readonly LocalBusinessPromoShotPlanEntry[],
  targetDurationSec?: number | null,
): LocalBusinessPromoShotPlanEntry[] {
  const baseDurationSec = shotPlan.reduce((sum, shot) => sum + shot.durationSec, 0);
  if (!Number.isFinite(targetDurationSec ?? NaN) || !targetDurationSec || targetDurationSec <= baseDurationSec + 0.05 || baseDurationSec <= 0) {
    return shotPlan.map((shot) => ({ ...shot }));
  }

  const scale = targetDurationSec / baseDurationSec;
  let remaining = Number(targetDurationSec.toFixed(2));
  return shotPlan.map((shot, index) => {
    const isLast = index === shotPlan.length - 1;
    const durationSec = isLast
      ? Number(Math.max(0.5, remaining).toFixed(2))
      : Number(Math.max(0.5, (shot.durationSec * scale)).toFixed(2));
    remaining = Number(Math.max(0, remaining - durationSec).toFixed(2));
    return {
      ...shot,
      durationSec,
    };
  });
}

export type RenderShotArgs = {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly shot: LocalBusinessPromoShotPlanEntry;
  readonly aspectRatio: LocalBusinessPromoAspectRatio;
  readonly overlayPath?: string | null;
};
