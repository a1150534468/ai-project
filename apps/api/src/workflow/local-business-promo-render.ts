import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  storeVideoFile,
  type StoredVideoFile,
} from "./_shared/video-service.js";
import type {
  LocalBusinessPromoAspectRatio,
  LocalBusinessPromoBrief,
  LocalBusinessPromoShotPlanEntry,
  LocalBusinessPromoSubtitleStyle,
} from "./local-business-promo-core.js";
import { renderLocalBusinessPromoOverlay } from "./local-business-promo-overlay.js";
import { getFfmpegSemaphore } from "./local-business-promo-render-ffmpeg.js";
import { muxAudio } from "./local-business-promo-render-audio.js";
import {
  extensionFromMimeOrUrl,
  fetchToFile,
  resolveSelectedMaterialObjectKey,
  stretchShotPlanToDuration,
} from "./local-business-promo-render-support.js";
import { concatSegments, renderImageShot, renderVideoShot } from "./local-business-promo-render-segments.js";

export interface RenderLocalBusinessPromoVideoInput {
  readonly userId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly aspectRatio: LocalBusinessPromoAspectRatio;
  readonly brief: LocalBusinessPromoBrief;
  readonly subtitleStyle: LocalBusinessPromoSubtitleStyle;
  readonly targetDurationSec?: number | null;
  readonly shotPlan: readonly LocalBusinessPromoShotPlanEntry[];
  readonly narrationUrl?: string | null;
  readonly narrationObjectKey?: string | null;
  readonly bgmUrl?: string | null;
  readonly bgmObjectKey?: string | null;
  readonly fetchFn?: typeof fetch;
  readonly onShotStart?: (shotId: string) => Promise<void> | void;
  readonly onShotComplete?: (shotId: string) => Promise<void> | void;
}

export async function renderLocalBusinessPromoVideo(
  input: RenderLocalBusinessPromoVideoInput,
): Promise<StoredVideoFile> {
  const fetchFn = input.fetchFn ?? fetch;
  const workdir = await mkdtemp(join(tmpdir(), "local-business-promo-render-"));
  return getFfmpegSemaphore().run(async () => {
    try {
      const renderShotPlan = stretchShotPlanToDuration(input.shotPlan, input.targetDurationSec);
      const segmentPaths: string[] = [];
      for (let index = 0; index < renderShotPlan.length; index += 1) {
        const shot = renderShotPlan[index]!;
        if (!shot.selectedMaterialUrl || !shot.selectedMaterialMime || !shot.renderMode) {
          throw new Error(`镜头「${shot.label}」缺少可执行的素材选择`);
        }
        await input.onShotStart?.(shot.shotId);
        const ext = extensionFromMimeOrUrl(shot.selectedMaterialMime, shot.selectedMaterialUrl);
        const sourcePath = join(workdir, `source-${index + 1}.${ext}`);
        await fetchToFile({
          fetchFn,
          url: shot.selectedMaterialUrl,
          mime: shot.selectedMaterialMime,
          objectKey: resolveSelectedMaterialObjectKey(shot),
          outputPath: sourcePath,
        });
        const overlayPath = join(workdir, `overlay-${index + 1}.png`);
        const hasOverlay = await renderLocalBusinessPromoOverlay({
          outputPath: overlayPath,
          aspectRatio: input.aspectRatio,
          brief: input.brief,
          shot,
          shotIndex: index,
          totalShots: renderShotPlan.length,
          subtitleStyle: input.subtitleStyle,
        });
        const segmentPath = join(workdir, `segment-${index + 1}.mp4`);
        if (shot.renderMode === "image-pan") {
          await renderImageShot({
            inputPath: sourcePath,
            outputPath: segmentPath,
            shot,
            aspectRatio: input.aspectRatio,
            overlayPath: hasOverlay ? overlayPath : null,
          });
        } else {
          await renderVideoShot({
            inputPath: sourcePath,
            outputPath: segmentPath,
            shot,
            aspectRatio: input.aspectRatio,
            overlayPath: hasOverlay ? overlayPath : null,
          });
        }
        segmentPaths.push(segmentPath);
        await input.onShotComplete?.(shot.shotId);
      }

      const concatPath = join(workdir, "concat-base.mp4");
      await concatSegments(segmentPaths, concatPath);

      const narrationPath = input.narrationUrl
        ? (await fetchToFile({
          fetchFn,
          url: input.narrationUrl,
          mime: "audio/wav",
          objectKey: input.narrationObjectKey ?? null,
          outputPath: join(workdir, `narration-${randomUUID()}.bin`),
        })).filePath
        : null;
      const bgmPath = input.bgmUrl
        ? (await fetchToFile({
          fetchFn,
          url: input.bgmUrl,
          mime: "audio/mpeg",
          objectKey: input.bgmObjectKey ?? null,
          outputPath: join(workdir, `bgm-${randomUUID()}.bin`),
        })).filePath
        : null;
      const outputPath = join(workdir, "final.mp4");
      const durationSec = renderShotPlan.reduce((sum, shot) => sum + shot.durationSec, 0);
      await muxAudio({
        baseVideoPath: concatPath,
        outputPath,
        narrationPath,
        bgmPath,
        durationSec,
      });

      const contentHash = createHash("sha1")
        .update(`${input.projectId}:${input.runId}:${input.aspectRatio}:${durationSec}`)
        .digest("hex")
        .slice(0, 12);
      return await storeVideoFile({
        userId: input.userId,
        filename: `local-business-promo-${contentHash}.mp4`,
        mime: "video/mp4",
        filePath: outputPath,
        folder: `workflow/local-business-promo/${input.userId}/${input.projectId}/${input.runId}`,
      });
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

export { muxAudio };
