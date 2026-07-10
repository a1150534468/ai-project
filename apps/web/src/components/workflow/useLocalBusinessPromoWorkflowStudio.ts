import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { useToast } from "../../motion";
import { uploadWorkflowVideoMaterial } from "../../videoApi";
import {
  createLocalBusinessPromoProject,
  generateLocalBusinessPromoBgm,
  generateLocalBusinessPromoNarration,
  generateLocalBusinessPromoScript,
  generateLocalBusinessPromoVideo,
  getLocalBusinessPromoOptions,
  getLocalBusinessPromoState,
  listLocalBusinessPromoProjects,
  previewLocalBusinessPromoBgm,
  previewLocalBusinessPromoNarration,
  type LocalBusinessPromoAudioState,
  type LocalBusinessPromoMaterialGroup,
  type LocalBusinessPromoMaterialItem,
  type LocalBusinessPromoOptions,
  type LocalBusinessPromoProject,
  type LocalBusinessPromoProjectSummary,
  type LocalBusinessPromoRun,
  type LocalBusinessPromoSettings,
  type WorkflowAudioAsset,
  updateLocalBusinessPromoActiveAudio,
  updateLocalBusinessPromoProject,
  updateLocalBusinessPromoScript,
  uploadLocalBusinessPromoBgm,
  uploadLocalBusinessPromoVoiceSample,
} from "../../workflowLocalBusinessPromoApi";
import {
  LOCAL_BUSINESS_PROMO_FALLBACK_OPTIONS,
  canGenerateLocalBusinessPromo,
  createEmptyLocalBusinessPromoAudioState,
  isLocalBusinessPromoBusy,
  missingBriefLabels,
} from "./localBusinessPromoWorkflowModel";
import {
  assetMusicPreset,
  deriveBgmMode,
  errorMessage,
  firstAvailableMusicPreset,
  playbackErrorMessage,
  type LocalBusinessPromoBgmMode,
  type LocalBusinessPromoStudioView,
  toSummary,
} from "./localBusinessPromoWorkflowStudioModel";
import { useLocalBusinessPromoWorkflowStudioDerived } from "./localBusinessPromoWorkflowStudioDerived";
import { useLocalBusinessPromoNarrationPreview } from "./useLocalBusinessPromoNarrationPreview";

const POLL_MS = 5000;

export interface LocalBusinessPromoWorkflowStudioProps {
  readonly token: string;
  readonly onBalanceRefresh?: () => void;
  readonly initialOptions?: LocalBusinessPromoOptions;
  readonly initialProjects?: readonly LocalBusinessPromoProjectSummary[];
  readonly initialProject?: LocalBusinessPromoProject | null;
  readonly initialLatestRun?: LocalBusinessPromoRun | null;
  readonly initialRuns?: readonly LocalBusinessPromoRun[];
  readonly initialAudioState?: LocalBusinessPromoAudioState;
  readonly initialBootstrapping?: boolean;
}

export function useLocalBusinessPromoWorkflowStudio({
  token,
  onBalanceRefresh,
  initialOptions,
  initialProjects,
  initialProject,
  initialLatestRun,
  initialRuns,
  initialAudioState,
  initialBootstrapping,
}: LocalBusinessPromoWorkflowStudioProps) {
  const toast = useToast();
  const initialAudio = initialAudioState ?? createEmptyLocalBusinessPromoAudioState();
  const hasInitialData = initialOptions !== undefined
    || initialProjects !== undefined
    || initialProject !== undefined
    || initialLatestRun !== undefined
    || initialRuns !== undefined
    || initialAudioState !== undefined;
  const [options, setOptions] = useState<LocalBusinessPromoOptions>(initialOptions ?? LOCAL_BUSINESS_PROMO_FALLBACK_OPTIONS);
  const [projects, setProjects] = useState<readonly LocalBusinessPromoProjectSummary[]>(initialProjects ?? []);
  const [project, setProject] = useState<LocalBusinessPromoProject | null>(initialProject ?? null);
  const [latestRun, setLatestRun] = useState<LocalBusinessPromoRun | null>(initialLatestRun ?? null);
  const [runs, setRuns] = useState<readonly LocalBusinessPromoRun[]>(initialRuns ?? []);
  const [audioState, setAudioState] = useState<LocalBusinessPromoAudioState>(initialAudio);
  const [bgmPreview, setBgmPreview] = useState<WorkflowAudioAsset | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(initialBootstrapping ?? !hasInitialData);
  const [viewMode, setViewMode] = useState<LocalBusinessPromoStudioView>(initialProject ? "studio" : "list");
  const [bgmMode, setBgmMode] = useState<LocalBusinessPromoBgmMode>(() => deriveBgmMode(initialProject ?? null, initialAudio));
  const [isLoadingProject, setIsLoadingProject] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [isSavingProject, setIsSavingProject] = useState(false);
  const [isGeneratingScript, setIsGeneratingScript] = useState(false);
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [isUploadingVoiceSample, setIsUploadingVoiceSample] = useState(false);
  const [isUploadingBgm, setIsUploadingBgm] = useState(false);
  const [isPreviewingNarration, setIsPreviewingNarration] = useState(false);
  const [isGeneratingNarration, setIsGeneratingNarration] = useState(false);
  const [isPreviewingBgm, setIsPreviewingBgm] = useState(false);
  const [isGeneratingBgm, setIsGeneratingBgm] = useState(false);
  const [switchingAudioKey, setSwitchingAudioKey] = useState("");
  const [uploadingGroup, setUploadingGroup] = useState<LocalBusinessPromoMaterialGroup | null>(null);
  const [pendingUploadGroup, setPendingUploadGroup] = useState<LocalBusinessPromoMaterialGroup | null>(null);
  const [openingProjectId, setOpeningProjectId] = useState("");
  const [projectDirty, setProjectDirty] = useState(false);
  const [scriptDirty, setScriptDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const voiceSampleInputRef = useRef<HTMLInputElement>(null);
  const bgmUploadInputRef = useRef<HTMLInputElement>(null);
  const {
    presetNarrationPreviewUrlRef,
    narrationPreviewState,
    setNarrationPreviewState,
    stopNarrationPreviewPlayback,
    playNarrationPreviewUrl,
  } = useLocalBusinessPromoNarrationPreview({
    onPlaybackError: (message) => {
      setError(message);
      toast.show("err", message);
    },
  });

  const applyProjectState = useCallback((state: {
    project: LocalBusinessPromoProject;
    latestRun: LocalBusinessPromoRun | null;
    runs: readonly LocalBusinessPromoRun[];
    audio: LocalBusinessPromoAudioState;
  }) => {
    stopNarrationPreviewPlayback("idle");
    setViewMode("studio");
    setProject(state.project);
    setLatestRun(state.latestRun);
    setRuns(state.runs);
    setAudioState(state.audio);
    setBgmMode(deriveBgmMode(state.project, state.audio));
    setBgmPreview(null);
    setProjects((current) => {
      const summary = toSummary(state.project);
      const next = [summary, ...current.filter((item) => item.id !== summary.id)];
      return next.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
    });
    setProjectDirty(false);
    setScriptDirty(false);
  }, [stopNarrationPreviewPlayback]);

  const loadProjectState = useCallback(async (projectId: string) => {
    setIsLoadingProject(true);
    try {
      applyProjectState(await getLocalBusinessPromoState(token, projectId));
      setError("");
      return true;
    } catch (loadError) {
      setError(errorMessage(loadError));
      return false;
    } finally {
      setIsLoadingProject(false);
    }
  }, [applyProjectState, token]);

  useEffect(() => {
    void (async () => {
      try {
        const [loadedOptions, loadedProjects] = await Promise.all([
          getLocalBusinessPromoOptions(token).catch(() => LOCAL_BUSINESS_PROMO_FALLBACK_OPTIONS),
          listLocalBusinessPromoProjects(token),
        ]);
        setOptions(loadedOptions);
        setProjects(loadedProjects);
      } catch (loadError) {
        setError(errorMessage(loadError));
      } finally {
        setIsBootstrapping(false);
      }
    })();
  }, [token]);

  const refreshCurrentState = useCallback(async () => {
    if (!project) return;
    try {
      const wasBusy = isLocalBusinessPromoBusy(project.status) || isLocalBusinessPromoBusy(latestRun?.status);
      const nextState = await getLocalBusinessPromoState(token, project.id);
      applyProjectState(nextState);
      const isBusyNow = isLocalBusinessPromoBusy(nextState.project.status) || isLocalBusinessPromoBusy(nextState.latestRun?.status);
      if (wasBusy && !isBusyNow) onBalanceRefresh?.();
    } catch {
      // ignore polling failure
    }
  }, [applyProjectState, latestRun, onBalanceRefresh, project, token]);

  useEffect(() => {
    if (!project) return undefined;
    if (!isLocalBusinessPromoBusy(project.status) && !isLocalBusinessPromoBusy(latestRun?.status)) return undefined;
    const timer = window.setInterval(() => {
      void refreshCurrentState();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [latestRun?.status, project, project?.status, refreshCurrentState]);

  useEffect(() => {
    stopNarrationPreviewPlayback("idle");
  }, [
    audioState.voiceCloneSample?.id,
    project?.settings.narrationVoice,
    project?.settings.voiceDesignPrompt,
    project?.settings.voiceMode,
    project?.settings.voiceStylePrompt,
    stopNarrationPreviewPlayback,
  ]);

  useEffect(() => {
    setBgmPreview(null);
  }, [project?.id, project?.settings.musicPreset]);

  const updateProjectLocal = useCallback((updater: (current: LocalBusinessPromoProject) => LocalBusinessPromoProject) => {
    setProject((current) => {
      if (!current) return current;
      const next = updater(current);
      setProjectDirty(true);
      return next;
    });
    setError("");
    setNotice("");
  }, []);

  const persistProject = useCallback(async (source?: LocalBusinessPromoProject | null): Promise<LocalBusinessPromoProject | null> => {
    const target = source ?? project;
    if (!target) return null;
    setIsSavingProject(true);
    try {
      const saved = await updateLocalBusinessPromoProject(token, target.id, {
        title: target.title,
        brief: target.brief,
        materials: target.materials,
        settings: target.settings,
      });
      setProject(saved);
      setProjects((current) => {
        const summary = toSummary(saved);
        const next = [summary, ...current.filter((item) => item.id !== summary.id)];
        return next.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
      });
      setProjectDirty(false);
      setError("");
      return saved;
    } catch (saveError) {
      const message = errorMessage(saveError);
      setError(message);
      toast.show("err", `保存失败：${message}`);
      return null;
    } finally {
      setIsSavingProject(false);
    }
  }, [project, toast, token]);

  const savePendingChanges = useCallback(async (): Promise<LocalBusinessPromoProject | null> => {
    if (!project) return null;
    let current = project;
    if (projectDirty) {
      const savedProject = await persistProject(current);
      if (!savedProject) return null;
      current = { ...savedProject, scriptDraft: project.scriptDraft };
      setProject(current);
    }
    if (scriptDirty) {
      setIsSavingProject(true);
      try {
        const savedScript = await updateLocalBusinessPromoScript(token, current.id, project.scriptDraft);
        setProject(savedScript);
        setProjects((items) => [toSummary(savedScript), ...items.filter((item) => item.id !== savedScript.id)]);
        setScriptDirty(false);
        current = savedScript;
      } catch (saveError) {
        const message = errorMessage(saveError);
        setError(message);
        toast.show("err", `保存失败：${message}`);
        return null;
      } finally {
        setIsSavingProject(false);
      }
    }
    return current;
  }, [persistProject, project, projectDirty, scriptDirty, toast, token]);

  const handleOpenProjectsPage = useCallback(async () => {
    if ((projectDirty || scriptDirty) && !(await savePendingChanges())) return;
    stopNarrationPreviewPlayback("idle");
    setViewMode("list");
    setProject(null);
    setLatestRun(null);
    setRuns([]);
    setAudioState(createEmptyLocalBusinessPromoAudioState());
    setBgmMode("preset");
    setBgmPreview(null);
    setProjectDirty(false);
    setScriptDirty(false);
    setOpeningProjectId("");
  }, [projectDirty, savePendingChanges, scriptDirty, stopNarrationPreviewPlayback]);

  const handleCreateProject = useCallback(async () => {
    if (isCreatingProject) return;
    if ((projectDirty || scriptDirty) && !(await savePendingChanges())) return;
    setIsCreatingProject(true);
    try {
      const created = await createLocalBusinessPromoProject(token, { title: "本地商家宣传项目" });
      applyProjectState({ project: created, latestRun: null, runs: [], audio: createEmptyLocalBusinessPromoAudioState() });
      setNotice("已创建新项目");
      toast.show("ok", "已创建新项目");
    } catch (createError) {
      const message = errorMessage(createError);
      setError(message);
      toast.show("err", `创建项目失败：${message}`);
    } finally {
      setIsCreatingProject(false);
    }
  }, [applyProjectState, isCreatingProject, projectDirty, savePendingChanges, scriptDirty, toast, token]);

  const handleSelectProject = useCallback(async (projectId: string) => {
    if (project?.id === projectId && viewMode === "studio") return;
    if (isLoadingProject || openingProjectId === projectId) return;
    if ((projectDirty || scriptDirty) && !(await savePendingChanges())) return;
    setOpeningProjectId(projectId);
    try {
      if (project?.id === projectId) {
        setViewMode("studio");
        setError("");
        return;
      }
      await loadProjectState(projectId);
    } finally {
      setOpeningProjectId("");
    }
  }, [isLoadingProject, loadProjectState, openingProjectId, project?.id, projectDirty, savePendingChanges, scriptDirty, viewMode]);

  const handleUploadMaterial = useCallback(async (group: LocalBusinessPromoMaterialGroup, file: File) => {
    if (!project) return;
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
      const message = "仅支持图片和视频素材";
      setError(message);
      toast.show("err", message);
      return;
    }
    setUploadingGroup(group);
    setError("");
    try {
      const uploaded = await uploadWorkflowVideoMaterial(token, file);
      const nextItem: LocalBusinessPromoMaterialItem = { ...uploaded, name: file.name };
      const nextProject = {
        ...project,
        materials: {
          ...project.materials,
          [group]: [...project.materials[group], nextItem],
        },
      };
      setProject(nextProject);
      setProjectDirty(true);
      const saved = await persistProject(nextProject);
      if (!saved) return;
      setNotice(`已添加素材：${file.name}`);
      toast.show("ok", `已添加素材：${file.name}`);
    } catch (uploadError) {
      const message = errorMessage(uploadError);
      setError(message);
      toast.show("err", `上传失败：${message}`);
    } finally {
      setUploadingGroup(null);
    }
  }, [persistProject, project, toast, token]);

  const handleOpenUploadPicker = useCallback((group: LocalBusinessPromoMaterialGroup) => {
    setPendingUploadGroup(group);
    uploadInputRef.current?.click();
  }, []);

  const handleUploadInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const group = pendingUploadGroup;
    if (file && group) void handleUploadMaterial(group, file);
    event.currentTarget.value = "";
    setPendingUploadGroup(null);
  }, [handleUploadMaterial, pendingUploadGroup]);

  const handleRemoveMaterial = useCallback((group: LocalBusinessPromoMaterialGroup, url: string) => {
    updateProjectLocal((current) => ({
      ...current,
      materials: {
        ...current.materials,
        [group]: current.materials[group].filter((item) => item.url !== url),
      },
    }));
  }, [updateProjectLocal]);

  const handleOpenVoiceSamplePicker = useCallback(() => {
    voiceSampleInputRef.current?.click();
  }, []);

  const handleUploadVoiceSample = useCallback(async (file: File) => {
    if (!project || isUploadingVoiceSample) return;
    setIsUploadingVoiceSample(true);
    setError("");
    try {
      const result = await uploadLocalBusinessPromoVoiceSample(token, project.id, file);
      setAudioState(result.audio);
      setNotice(`音色样本已更新：${file.name}`);
      toast.show("ok", `音色样本已更新：${file.name}`);
    } catch (uploadError) {
      const message = errorMessage(uploadError);
      setError(message);
      toast.show("err", `上传失败：${message}`);
    } finally {
      setIsUploadingVoiceSample(false);
    }
  }, [isUploadingVoiceSample, project, toast, token]);

  const handleVoiceSampleInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void handleUploadVoiceSample(file);
    event.currentTarget.value = "";
  }, [handleUploadVoiceSample]);

  const handleOpenBgmUploadPicker = useCallback(() => {
    bgmUploadInputRef.current?.click();
  }, []);

  const handleUploadBgm = useCallback(async (file: File) => {
    if (!project || isUploadingBgm) return;
    setIsUploadingBgm(true);
    setError("");
    try {
      const result = await uploadLocalBusinessPromoBgm(token, project.id, file);
      setAudioState(result.audio);
      setBgmMode("upload");
      setNotice(`BGM 素材已上传：${file.name}`);
      toast.show("ok", `BGM 素材已上传：${file.name}`);
    } catch (uploadError) {
      const message = errorMessage(uploadError);
      setError(message);
      toast.show("err", `上传失败：${message}`);
    } finally {
      setIsUploadingBgm(false);
    }
  }, [isUploadingBgm, project, toast, token]);

  const handleBgmUploadInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void handleUploadBgm(file);
    event.currentTarget.value = "";
  }, [handleUploadBgm]);

  const handleGenerateScript = useCallback(async () => {
    const saved = projectDirty ? await persistProject(project) : project;
    if (!saved || isGeneratingScript) return;
    const missing = missingBriefLabels(saved.brief);
    if (missing.length > 0) {
      const message = `请先完善资料：${missing.join("、")}`;
      setError(message);
      toast.show("err", message);
      return;
    }
    setIsGeneratingScript(true);
    setError("");
    try {
      const updated = await generateLocalBusinessPromoScript(token, saved.id);
      setProject(updated);
      setProjects((current) => [toSummary(updated), ...current.filter((item) => item.id !== updated.id)]);
      setScriptDirty(false);
      setNotice("口播文案已生成");
      toast.show("ok", "口播文案已生成");
      onBalanceRefresh?.();
    } catch (generateError) {
      const message = errorMessage(generateError);
      setError(message);
      toast.show("err", `生成失败：${message}`);
    } finally {
      setIsGeneratingScript(false);
    }
  }, [isGeneratingScript, onBalanceRefresh, persistProject, project, projectDirty, toast, token]);

  const handleSaveScript = useCallback(async () => {
    const saved = await savePendingChanges();
    if (!saved) return;
    setNotice("文案已保存");
    toast.show("ok", "文案已保存");
  }, [savePendingChanges, toast]);

  const handlePreviewNarration = useCallback(async () => {
    if (!project) return;
    if (narrationPreviewState === "playing") {
      stopNarrationPreviewPlayback("ready");
      return;
    }
    if (isPreviewingNarration) return;
    setIsPreviewingNarration(true);
    setNarrationPreviewState("loading");
    setError("");
    try {
      if (project.settings.voiceMode === "preset") {
        const cachedUrl = presetNarrationPreviewUrlRef.current[project.settings.narrationVoice];
        if (cachedUrl) {
          await playNarrationPreviewUrl(cachedUrl);
          return;
        }
      }
      const saved = projectDirty ? await persistProject(project) : project;
      if (!saved) {
        setNarrationPreviewState("idle");
        return;
      }
      const asset = await previewLocalBusinessPromoNarration(token, saved.id);
      if (saved.settings.voiceMode === "preset") {
        presetNarrationPreviewUrlRef.current[saved.settings.narrationVoice] = asset.originalUrl;
      }
      await playNarrationPreviewUrl(asset.originalUrl);
    } catch (previewError) {
      const message = playbackErrorMessage(previewError, "口播试听播放失败");
      stopNarrationPreviewPlayback("idle");
      setError(message);
      toast.show("err", `试听失败：${message}`);
    } finally {
      setIsPreviewingNarration(false);
    }
  }, [isPreviewingNarration, narrationPreviewState, persistProject, playNarrationPreviewUrl, project, projectDirty, stopNarrationPreviewPlayback, toast, token]);

  const handleGenerateNarration = useCallback(async () => {
    const saved = await savePendingChanges();
    if (!saved || isGeneratingNarration) return;
    setIsGeneratingNarration(true);
    setError("");
    try {
      const result = await generateLocalBusinessPromoNarration(token, saved.id);
      stopNarrationPreviewPlayback("idle");
      setAudioState(result.audio);
      setNotice("正式口播已生成并设为当前版本");
      toast.show("ok", "正式口播已生成");
    } catch (generateError) {
      const message = errorMessage(generateError);
      setError(message);
      toast.show("err", `生成失败：${message}`);
    } finally {
      setIsGeneratingNarration(false);
    }
  }, [isGeneratingNarration, savePendingChanges, stopNarrationPreviewPlayback, toast, token]);

  const handlePreviewBgm = useCallback(async () => {
    const saved = await savePendingChanges();
    if (!saved || isPreviewingBgm) return;
    setIsPreviewingBgm(true);
    setError("");
    try {
      const asset = await previewLocalBusinessPromoBgm(token, saved.id);
      setBgmPreview(asset);
      setNotice(asset ? "背景音乐试听已更新" : "当前预设为不使用 BGM");
      toast.show("ok", asset ? "背景音乐试听已更新" : "当前预设为不使用 BGM");
    } catch (previewError) {
      const message = errorMessage(previewError);
      setError(message);
      toast.show("err", `试听失败：${message}`);
    } finally {
      setIsPreviewingBgm(false);
    }
  }, [isPreviewingBgm, savePendingChanges, toast, token]);

  const handleGenerateBgm = useCallback(async () => {
    const saved = await savePendingChanges();
    if (!saved || isGeneratingBgm) return;
    setIsGeneratingBgm(true);
    setError("");
    try {
      const result = await generateLocalBusinessPromoBgm(token, saved.id);
      setAudioState(result.audio);
      setBgmMode(result.asset ? "preset" : "none");
      setBgmPreview(result.asset);
      setNotice(result.asset ? "背景音乐已生成并设为当前版本" : "已清空当前背景音乐");
      toast.show("ok", result.asset ? "背景音乐已生成" : "已清空背景音乐");
    } catch (generateError) {
      const message = errorMessage(generateError);
      setError(message);
      toast.show("err", `生成失败：${message}`);
    } finally {
      setIsGeneratingBgm(false);
    }
  }, [isGeneratingBgm, savePendingChanges, toast, token]);

  const handleSetActiveNarration = useCallback(async (assetId: string | null) => {
    if (!project || switchingAudioKey === `narration:${assetId}`) return;
    setSwitchingAudioKey(`narration:${assetId}`);
    setError("");
    try {
      const nextAudio = await updateLocalBusinessPromoActiveAudio(token, project.id, { narrationAssetId: assetId });
      setAudioState(nextAudio);
      toast.show("ok", assetId ? "已切换当前口播版本" : "已清空当前口播");
    } catch (switchError) {
      const message = errorMessage(switchError);
      setError(message);
      toast.show("err", `切换失败：${message}`);
    } finally {
      setSwitchingAudioKey("");
    }
  }, [project, switchingAudioKey, toast, token]);

  const handleSetActiveBgm = useCallback(async (assetId: string | null) => {
    if (!project || switchingAudioKey === `bgm:${assetId}`) return;
    setSwitchingAudioKey(`bgm:${assetId}`);
    setError("");
    try {
      const nextAudio = await updateLocalBusinessPromoActiveAudio(token, project.id, { bgmAssetId: assetId });
      setAudioState(nextAudio);
      setBgmMode(deriveBgmMode(project, nextAudio));
      toast.show("ok", assetId ? "已切换当前背景音乐版本" : "已清空当前背景音乐");
    } catch (switchError) {
      const message = errorMessage(switchError);
      setError(message);
      toast.show("err", `切换失败：${message}`);
    } finally {
      setSwitchingAudioKey("");
    }
  }, [project, switchingAudioKey, toast, token]);

  const handleSelectBgmMode = useCallback((nextMode: LocalBusinessPromoBgmMode) => {
    if (!project) return;
    setBgmMode(nextMode);
    setBgmPreview(null);
    if (nextMode === "none") {
      updateProjectLocal((current) => ({
        ...current,
        settings: { ...current.settings, musicPreset: "no-bgm" },
      }));
      return;
    }
    updateProjectLocal((current) => ({
      ...current,
      settings: {
        ...current.settings,
        musicPreset: current.settings.musicPreset === "no-bgm"
          ? firstAvailableMusicPreset(options)
          : current.settings.musicPreset,
      },
    }));
  }, [options, project, updateProjectLocal]);

  const ensureBgmReadyForRun = useCallback(async (saved: LocalBusinessPromoProject): Promise<boolean> => {
    if (saved.settings.musicPreset === "no-bgm" || bgmMode === "none") return true;
    if (bgmMode === "upload") {
      if (audioState.activeBgm?.source === "upload") return true;
      const message = "当前选择的是上传 BGM，请先上传音频文件";
      setError(message);
      toast.show("err", message);
      return false;
    }
    const activePreset = audioState.activeBgm?.source === "local-bgm" ? assetMusicPreset(audioState.activeBgm) : null;
    if (audioState.activeBgm?.source === "local-bgm" && activePreset === saved.settings.musicPreset) return true;

    setIsGeneratingBgm(true);
    setError("");
    try {
      const result = await generateLocalBusinessPromoBgm(token, saved.id);
      setAudioState(result.audio);
      setBgmMode(result.asset ? "preset" : "none");
      setBgmPreview(result.asset);
      setNotice(result.asset ? "已自动应用当前预制 BGM" : "当前项目不使用 BGM");
      return true;
    } catch (generateError) {
      const message = errorMessage(generateError);
      setError(message);
      toast.show("err", `生成失败：${message}`);
      return false;
    } finally {
      setIsGeneratingBgm(false);
    }
  }, [audioState.activeBgm, bgmMode, toast, token]);

  const handleStartRun = useCallback(async () => {
    const saved = await savePendingChanges();
    if (!saved || isStartingRun) return;
    if (!canGenerateLocalBusinessPromo(saved)) {
      const message = "请先完善资料、素材和口播文案";
      setError(message);
      toast.show("err", message);
      return;
    }
    if (!(await ensureBgmReadyForRun(saved))) return;
    setIsStartingRun(true);
    setError("");
    try {
      const run = await generateLocalBusinessPromoVideo(token, saved.id);
      setLatestRun(run);
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      setProject((current) => current ? { ...current, latestRunId: run.id, status: "generating" } : current);
      setNotice("多段生成任务已开始");
      toast.show("ok", "多段生成任务已开始");
      onBalanceRefresh?.();
    } catch (runError) {
      const message = errorMessage(runError);
      setError(message);
      toast.show("err", `启动失败：${message}`);
    } finally {
      setIsStartingRun(false);
    }
  }, [ensureBgmReadyForRun, isStartingRun, onBalanceRefresh, savePendingChanges, toast, token]);

  const setScriptDraft = useCallback((value: string) => {
    setProject((current) => current ? { ...current, scriptDraft: value } : current);
    setScriptDirty(true);
    setError("");
    setNotice("");
  }, []);

  const derived = useLocalBusinessPromoWorkflowStudioDerived({
    project,
    latestRun,
    options,
    audioState,
    bgmMode,
    narrationPreviewState,
    projectDirty,
    scriptDirty,
  });

  return {
    state: {
      options,
      projects,
      project,
      latestRun,
      runs,
      audioState,
      bgmPreview,
      isBootstrapping,
      viewMode,
      bgmMode,
      isLoadingProject,
      isCreatingProject,
      isSavingProject,
      isGeneratingScript,
      isStartingRun,
      isUploadingVoiceSample,
      isUploadingBgm,
      isPreviewingNarration,
      isGeneratingNarration,
      isPreviewingBgm,
      isGeneratingBgm,
      switchingAudioKey,
      uploadingGroup,
      openingProjectId,
      error,
      notice,
      narrationPreviewState,
    },
    derived,
    refs: {
      uploadInputRef,
      voiceSampleInputRef,
      bgmUploadInputRef,
    },
    actions: {
      updateProjectLocal,
      setScriptDraft,
      savePendingChanges,
      openProjectsPage: handleOpenProjectsPage,
      createProject: handleCreateProject,
      selectProject: handleSelectProject,
      openUploadPicker: handleOpenUploadPicker,
      onUploadInputChange: handleUploadInputChange,
      removeMaterial: handleRemoveMaterial,
      openVoiceSamplePicker: handleOpenVoiceSamplePicker,
      onVoiceSampleInputChange: handleVoiceSampleInputChange,
      openBgmUploadPicker: handleOpenBgmUploadPicker,
      onBgmUploadInputChange: handleBgmUploadInputChange,
      generateScript: handleGenerateScript,
      saveScript: handleSaveScript,
      previewNarration: handlePreviewNarration,
      generateNarration: handleGenerateNarration,
      previewBgm: handlePreviewBgm,
      generateBgm: handleGenerateBgm,
      setActiveNarration: handleSetActiveNarration,
      setActiveBgm: handleSetActiveBgm,
      selectBgmMode: handleSelectBgmMode,
      startRun: handleStartRun,
    },
  };
}

export type LocalBusinessPromoWorkflowStudioController = ReturnType<typeof useLocalBusinessPromoWorkflowStudio>;
