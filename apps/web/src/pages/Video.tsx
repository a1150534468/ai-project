import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "../motion";
import { VideoGenerationStudio } from "../components/video/VideoGenerationStudio";
import { HelpWriteWizard } from "../components/video/HelpWriteWizard";
import {
  clampVideoSettings,
  generateWorkflowVideo,
  getWorkflowVideoState,
  listWorkflowVideoPricing,
  materialKindOf,
  uploadWorkflowVideoMaterial,
  VIDEO_MATERIAL_LIMITS,
  type MaterialKind,
  type VideoAspectRatio,
  type VideoModel,
  type VideoResolution,
  type UploadedVideoMaterial,
  type WorkflowVideoAsset,
  type WorkflowVideoPricingRow,
  type WorkflowVideoTask,
} from "../videoApi";

interface VideoPageProps {
  readonly token: string;
  readonly onBalanceRefresh: () => Promise<void>;
}

export type ReferenceMaterial = UploadedVideoMaterial & {
  readonly name: string;
};

const KIND_LABEL: Record<MaterialKind, string> = { image: "图片", video: "视频", audio: "音频" };

function nextRequestId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `video-${Date.now()}-${random}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败";
}

export default function Video({ token, onBalanceRefresh }: VideoPageProps) {
  const toast = useToast();
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<VideoModel>("seedance-2");
  const [aspectRatio, setAspectRatio] = useState<VideoAspectRatio>("9:16");
  const [resolution, setResolution] = useState<VideoResolution>("720p");
  const [durationSec, setDurationSec] = useState(15);
  const [generateAudio, setGenerateAudio] = useState(true);
  const [materials, setMaterials] = useState<ReferenceMaterial[]>([]);
  const [materialNotice, setMaterialNotice] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [tasks, setTasks] = useState<WorkflowVideoTask[]>([]);
  const [videos, setVideos] = useState<WorkflowVideoAsset[]>([]);
  const [pricingRows, setPricingRows] = useState<WorkflowVideoPricingRow[]>([]);

  const hasRunningTasks = useMemo(() => tasks.some((task) => task.status === "running"), [tasks]);

  // 素材按类型分组的数量，供上限校验与计数展示。
  const materialCounts = useMemo(() => {
    const counts: Record<MaterialKind, number> = { image: 0, video: 0, audio: 0 };
    for (const item of materials) {
      const kind = materialKindOf(item.mime);
      if (kind) counts[kind] += 1;
    }
    return counts;
  }, [materials]);

  // 输入视频总时长（秒），作为「有输入视频」复合计费的输入依据（前端预估用）。
  const inputVideoDurationSec = useMemo(
    () => materials.filter((m) => m.mime.startsWith("video/")).reduce((sum, m) => sum + (m.durationSec || 0), 0),
    [materials],
  );

  const load = useCallback(async () => {
    const [state, pricing] = await Promise.all([
      getWorkflowVideoState(token),
      listWorkflowVideoPricing(token),
    ]);
    setTasks(state.tasks);
    setVideos(state.videos);
    setPricingRows(pricing);
  }, [token]);

  useEffect(() => {
    void load().catch((err) => setError(errorMessage(err)));
  }, [load]);

  useEffect(() => {
    if (!hasRunningTasks) return;
    const timer = window.setInterval(() => {
      void getWorkflowVideoState(token).then((state) => {
        setTasks(state.tasks);
        setVideos(state.videos);
        if (!state.tasks.some((task) => task.status === "running")) {
          void onBalanceRefresh().catch(() => undefined);
        }
      }).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [hasRunningTasks, onBalanceRefresh, token]);

  const handleModelChange = (nextModel: VideoModel) => {
    const next = clampVideoSettings(nextModel, resolution, durationSec);
    setModel(nextModel);
    setResolution(next.resolution);
    setDurationSec(next.durationSec);
    if (nextModel === "seedance-2-mini") setGenerateAudio(false);
  };

  const handleUploadMaterial = async (file: File) => {
    setError("");
    const kind = materialKindOf(file.type);
    if (!kind) {
      const msg = "仅支持图片 / 视频 / 音频素材";
      setError(msg);
      toast.show("err", msg);
      return;
    }
    if (materialCounts[kind] >= VIDEO_MATERIAL_LIMITS[kind]) {
      const msg = `${KIND_LABEL[kind]}最多 ${VIDEO_MATERIAL_LIMITS[kind]} 个`;
      setMaterialNotice("");
      setError(msg);
      toast.show("err", msg);
      return;
    }
    setMaterialNotice("素材上传中");
    try {
      const uploaded = await uploadWorkflowVideoMaterial(token, file);
      setMaterials((current) => [...current, { ...uploaded, name: file.name }]);
      setMaterialNotice(`已添加素材：${file.name}`);
      toast.show("ok", `已添加素材：${file.name}`);
    } catch (err) {
      setMaterialNotice("");
      const msg = errorMessage(err);
      setError(msg);
      toast.show("err", `素材上传失败：${msg}`);
    }
  };

  const handleRemoveMaterial = (url: string) => {
    setMaterials((current) => current.filter((item) => item.url !== url));
    setMaterialNotice("");
  };

  const handleSubmit = async () => {
    const text = prompt.trim();
    if (!text) {
      setError("请输入视频提示词");
      return;
    }
    setIsSubmitting(true);
    setError("");
    try {
      const imageMaterials = materials.filter((item) => item.mime.startsWith("image/"));
      const videoMaterials = materials.filter((item) => item.mime.startsWith("video/"));
      const audioMaterials = materials.filter((item) => item.mime.startsWith("audio/"));
      const result = await generateWorkflowVideo(token, {
        requestId: nextRequestId(),
        prompt: text,
        model,
        durationSec,
        aspectRatio,
        resolution,
        generateAudio: model !== "seedance-2-mini" && generateAudio,
        imageWithRoles: imageMaterials.slice(0, VIDEO_MATERIAL_LIMITS.image).map((item) => ({ url: item.url, role: "reference_image" })),
        videoWithRoles: videoMaterials.slice(0, VIDEO_MATERIAL_LIMITS.video).map((item) => ({ url: item.url, role: "reference_video" as const })),
        audioWithRoles: audioMaterials.slice(0, VIDEO_MATERIAL_LIMITS.audio).map((item) => ({ url: item.url, role: "reference_audio" })),
      });
      setTasks((current) => [result.task, ...current.filter((task) => task.requestId !== result.task.requestId)].slice(0, 20));
      setVideos(result.videos);
      toast.show("ok", "视频生成任务已提交，请在任务队列中查看进度");
      await onBalanceRefresh().catch(() => undefined);
    } catch (err) {
      const msg = errorMessage(err);
      setError(msg);
      toast.show("err", `视频生成失败：${msg}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <VideoGenerationStudio
        prompt={prompt}
        model={model}
        aspectRatio={aspectRatio}
        resolution={resolution}
        durationSec={durationSec}
        generateAudio={generateAudio}
        materials={materials}
        materialCounts={materialCounts}
        inputVideoDurationSec={inputVideoDurationSec}
        materialNotice={materialNotice}
        error={error}
        isSubmitting={isSubmitting}
        onHelpWrite={() => setWizardOpen(true)}
        pricingRows={pricingRows}
        tasks={tasks}
        videos={videos}
        onPromptChange={setPrompt}
        onModelChange={handleModelChange}
        onAspectRatioChange={setAspectRatio}
        onResolutionChange={setResolution}
        onDurationChange={setDurationSec}
        onGenerateAudioChange={setGenerateAudio}
        onRemoveMaterial={handleRemoveMaterial}
        onUploadMaterial={(file) => void handleUploadMaterial(file)}
        onNewTask={() => { setPrompt(""); setMaterials([]); setMaterialNotice(""); setError(""); }}
        onSubmit={() => void handleSubmit()}
      />
      <HelpWriteWizard
        token={token}
        open={wizardOpen}
        materials={materials.map((m) => ({ url: m.url, mime: m.mime, name: m.name, durationSec: m.durationSec }))}
        durationSec={durationSec}
        onClose={() => setWizardOpen(false)}
        onApply={(script, opts) => {
          setPrompt(script);
          setWizardOpen(false);
          // 有旁白：视频需含音频才会配音；mini 不支持音频，自动切到 Seedance-2.0。
          if (opts.hasNarration) {
            if (model === "seedance-2-mini") {
              handleModelChange("seedance-2");
              setGenerateAudio(true);
              toast.show("ok", "已开启含音频并切换到 Seedance-2.0（旁白需要音频，mini 不支持）");
            } else {
              setGenerateAudio(true);
              toast.show("ok", "已自动开启「含音频」，生成的视频将带旁白配音");
            }
          }
        }}
      />
    </>
  );
}
