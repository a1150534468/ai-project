import { useMemo } from "react";
import type {
  LocalBusinessPromoAudioState,
  LocalBusinessPromoOptions,
  LocalBusinessPromoProject,
  LocalBusinessPromoRun,
} from "../../workflowLocalBusinessPromoApi";
import {
  canGenerateLocalBusinessPromo,
  formatLocalBusinessPromoProgressStage,
  formatLocalBusinessPromoProjectStatus,
  formatLocalBusinessPromoRunStatus,
  latestPreviewUrl,
} from "./localBusinessPromoWorkflowModel";
import {
  assetMusicPreset,
  firstAvailableMusicPreset,
  latestCompletedShots,
  type LocalBusinessPromoBgmMode,
  type NarrationPreviewState,
} from "./localBusinessPromoWorkflowStudioModel";

export function useLocalBusinessPromoWorkflowStudioDerived(args: {
  readonly project: LocalBusinessPromoProject | null;
  readonly latestRun: LocalBusinessPromoRun | null;
  readonly options: LocalBusinessPromoOptions;
  readonly audioState: LocalBusinessPromoAudioState;
  readonly bgmMode: LocalBusinessPromoBgmMode;
  readonly narrationPreviewState: NarrationPreviewState;
  readonly projectDirty: boolean;
  readonly scriptDirty: boolean;
}) {
  const dirty = args.projectDirty || args.scriptDirty;
  const previewUrl = useMemo(() => latestPreviewUrl(args.latestRun), [args.latestRun]);
  const previewAspectRatio = useMemo(
    () => args.latestRun?.mergedAsset?.aspectRatio ?? args.latestRun?.settingsSnapshot.aspectRatio ?? args.project?.settings.aspectRatio ?? "9:16",
    [args.latestRun, args.project?.settings.aspectRatio],
  );
  const selectedProjectStatus = useMemo(
    () => args.project ? formatLocalBusinessPromoProjectStatus(args.project.status) : "",
    [args.project],
  );
  const latestRunCompletedShots = useMemo(() => latestCompletedShots(args.latestRun), [args.latestRun]);
  const selectedNarrationVoice = useMemo(
    () => args.options.narrationVoices.find((item) => item.value === args.project?.settings.narrationVoice) ?? null,
    [args.options.narrationVoices, args.project?.settings.narrationVoice],
  );
  const selectedVoiceMode = useMemo(
    () => args.options.voiceModes.find((item) => item.value === args.project?.settings.voiceMode) ?? null,
    [args.options.voiceModes, args.project?.settings.voiceMode],
  );
  const designVoiceTemplateExample = useMemo(() => args.options.voiceTemplates[0]?.description ?? "", [args.options.voiceTemplates]);
  const narrationPreviewReady = Boolean(
    args.project
      && (
        args.project.settings.voiceMode === "preset"
        || (args.project.settings.voiceMode === "design" && args.project.settings.voiceDesignPrompt.trim())
        || (args.project.settings.voiceMode === "clone" && args.audioState.voiceCloneSample)
      ),
  );
  const narrationGenerateReady = narrationPreviewReady && Boolean(args.project?.scriptDraft.trim());
  const narrationPreviewIdleLabel = args.project?.settings.voiceMode === "preset" ? "试听当前音色" : "试听固定样例";
  const narrationPreviewButtonLabel = args.narrationPreviewState === "loading"
    ? "试听中"
    : args.narrationPreviewState === "playing"
      ? "停止试听"
      : args.narrationPreviewState === "ready"
        ? "重新试听"
        : narrationPreviewIdleLabel;
  const narrationPreviewButtonIcon = args.narrationPreviewState === "loading"
    ? "mdi:loading"
    : args.narrationPreviewState === "playing"
      ? "mdi:stop-circle-outline"
      : "mdi:play-circle-outline";
  const presetBgmHistory = useMemo(
    () => args.audioState.bgmHistory.filter((asset) => asset.source === "local-bgm"),
    [args.audioState.bgmHistory],
  );
  const uploadedBgmHistory = useMemo(
    () => args.audioState.bgmHistory.filter((asset) => asset.source === "upload"),
    [args.audioState.bgmHistory],
  );
  const activeBgmPreset = useMemo(() => assetMusicPreset(args.audioState.activeBgm), [args.audioState.activeBgm]);
  const selectedMusicPreset = args.project?.settings.musicPreset ?? firstAvailableMusicPreset(args.options);
  const presetBgmNeedsApply = args.bgmMode === "preset"
    && selectedMusicPreset !== "no-bgm"
    && (
      args.audioState.activeBgm?.source !== "local-bgm"
      || activeBgmPreset !== selectedMusicPreset
    );

  return {
    dirty,
    previewUrl,
    previewAspectRatio,
    selectedProjectStatus,
    latestRunCompletedShots,
    selectedNarrationVoice,
    selectedVoiceMode,
    designVoiceTemplateExample,
    narrationPreviewReady,
    narrationGenerateReady,
    narrationPreviewButtonLabel,
    narrationPreviewButtonIcon,
    presetBgmHistory,
    uploadedBgmHistory,
    activeBgmPreset,
    selectedMusicPreset,
    presetBgmNeedsApply,
    canGenerate: canGenerateLocalBusinessPromo(args.project),
    latestRunStatusLabel: args.latestRun ? formatLocalBusinessPromoRunStatus(args.latestRun.status) : null,
    latestRunStageLabel: args.latestRun ? formatLocalBusinessPromoProgressStage(args.latestRun.progressStage) : null,
  };
}
