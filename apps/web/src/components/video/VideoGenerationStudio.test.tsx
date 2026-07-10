import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { VideoGenerationStudio } from "./VideoGenerationStudio";
import type { MaterialKind, WorkflowVideoTask, WorkflowVideoAsset, WorkflowVideoPricingRow } from "../../videoApi";

const pricingRows: WorkflowVideoPricingRow[] = [
  {
    resourceKey: "video_seedance_2_720p_text",
    displayName: "Seedance-2.0 720p 无输入视频",
    model: "seedance-2",
    resolution: "720p",
    hasInputVideo: false,
    pricingType: "PER_UNIT",
    rate: 3,
    outputRate: 0,
    perUnits: 1,
    enabled: true,
  },
  {
    resourceKey: "video_seedance_2_720p_with_video",
    displayName: "Seedance-2.0 720p 有输入视频",
    model: "seedance-2",
    resolution: "720p",
    hasInputVideo: true,
    pricingType: "VIDEO_IO",
    rate: 2,
    outputRate: 5,
    perUnits: 1,
    enabled: true,
  },
];

const runningTask: WorkflowVideoTask = {
  id: "task-1",
  requestId: "vid-1",
  providerTaskId: "tsk_vid_1",
  prompt: "产品短片",
  model: "seedance-2",
  aspectRatio: "9:16",
  resolution: "720p",
  durationSec: 8,
  generateAudio: true,
  hasInputVideo: false,
  resourceKey: "video_seedance_2_720p_text",
  chargedPoints: 2400,
  status: "running",
  progress: 35,
  error: null,
  createdAt: "2026-07-04T08:00:00.000Z",
  updatedAt: "2026-07-04T08:00:00.000Z",
  completedAt: null,
};

const videoAsset: WorkflowVideoAsset = {
  id: "video-1",
  requestId: "vid-1",
  requestIndex: 0,
  prompt: "产品短片",
  model: "seedance-2",
  aspectRatio: "9:16",
  resolution: "720p",
  durationSec: 8,
  originalUrl: "https://cdn.example.test/video.mp4",
  mime: "video/mp4",
  format: "mp4",
  createdAt: "2026-07-04T08:05:00.000Z",
};

const noCounts: Record<MaterialKind, number> = { image: 0, video: 0, audio: 0 };

function render(overrides: Partial<ComponentProps<typeof VideoGenerationStudio>> = {}) {
  return renderToStaticMarkup(
    <VideoGenerationStudio
      prompt="产品短片"
      model="seedance-2"
      aspectRatio="9:16"
      resolution="720p"
      durationSec={8}
      generateAudio={true}
      materials={[]}
      materialCounts={noCounts}
      inputVideoDurationSec={0}
      materialNotice=""
      error=""
      isSubmitting={false}
      pricingRows={pricingRows}
      tasks={[]}
      videos={[]}
      onPromptChange={vi.fn()}
      onModelChange={vi.fn()}
      onAspectRatioChange={vi.fn()}
      onResolutionChange={vi.fn()}
      onDurationChange={vi.fn()}
      onGenerateAudioChange={vi.fn()}
      onRemoveMaterial={vi.fn()}
      onUploadMaterial={vi.fn()}
      onHelpWrite={vi.fn()}
      onNewTask={vi.fn()}
      onSubmit={vi.fn()}
      {...overrides}
    />,
  );
}

describe("VideoGenerationStudio", () => {
  it("renders workspace, unified upload with 9/3/3 limits, and固定时长预估", () => {
    const html = render({ tasks: [runningTask], videos: [videoAsset] });
    expect(html).toContain("AI 视频");
    expect(html).toContain("Seedance-2.0-VIP");
    expect(html).toContain("参考素材");
    expect(html).toContain("配置");
    expect(html).not.toContain("参考视频 URL"); // URL 输入已移除
    expect(html).toContain("/ 9"); // 图片上限
    expect(html).toContain("/ 3"); // 视频/音频上限
    // 固定时长 8s，PER_UNIT rate 3 → 24
    expect(html).toContain("预计 24 视频点");
    expect(html).toContain("任务队列");
    expect(html).toContain("35%");
    expect(html).toContain("https://cdn.example.test/video.mp4");
  });

  it("estimates composite cost for input video: 输入秒×输入单价 + 输出秒×输出单价", () => {
    // 有输入视频（video 计数 1）+ 已知输入时长 6s
    const html = render({ materialCounts: { image: 0, video: 1, audio: 0 }, inputVideoDurationSec: 6 });
    // rate 2 × 输入 6 + outputRate 5 × 输出 8 = 52
    expect(html).toContain("预计 52 视频点");
  });

  it("auto duration shows 按实际结算 与预扣（15s 顶格）", () => {
    // 自动时长 durationSec=0，无输入视频，PER_UNIT rate 3 × 15 = 45
    const html = render({ durationSec: 0 });
    expect(html).toContain("按实际结算");
    expect(html).toContain("预扣 45");
  });

  it("shows 帮我写 button entry", () => {
    expect(render()).toContain("帮我写");
  });

  it("failed task shows friendly error, not raw provider JSON", () => {
    const failed: WorkflowVideoTask = {
      ...runningTask,
      id: "task-fail",
      status: "failed",
      progress: 0,
      error: 'video submit 403 {"code":"quota_not_enough","message":"user quota is not enough"}',
    };
    const html = render({ tasks: [failed] });
    expect(html).toContain("视频生成服务额度不足");
    expect(html).not.toContain("quota_not_enough");
  });

  it("上游已带「生成失败：」时不叠加前缀", () => {
    const failed: WorkflowVideoTask = {
      ...runningTask, id: "task-dup", status: "failed", progress: 0,
      error: "生成失败：任务处理失败",
    };
    const html = render({ tasks: [failed] });
    expect(html).toContain("生成失败：任务处理失败");
    expect(html).not.toContain("生成失败：生成失败");
  });

  it("shows a hint instead of an estimate when input video duration is unknown", () => {
    const html = render({ materialCounts: { image: 0, video: 1, audio: 0 }, inputVideoDurationSec: 0 });
    expect(html).toContain("请上传输入视频以估价");
  });
});
