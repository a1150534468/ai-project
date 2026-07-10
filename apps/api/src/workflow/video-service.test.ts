import { describe, expect, it } from "vitest";
import {
  VIDEO_PRICE_CONFIGS,
  buildVideoGenerationPayload,
  extractVideoStatus,
  isAutoDuration,
  isDurationSupported,
  videoGenerationResourceKey,
} from "./video-service.js";

describe("video service", () => {
  it("自动时长 0/-1 仅 seedance-2 / fast 支持，mini 拒绝", () => {
    expect(isAutoDuration(0)).toBe(true);
    expect(isAutoDuration(-1)).toBe(true);
    expect(isAutoDuration(8)).toBe(false);
    expect(isDurationSupported("seedance-2", 0)).toBe(true);
    expect(isDurationSupported("seedance-2-fast", -1)).toBe(true);
    expect(isDurationSupported("seedance-2-mini", 0)).toBe(false);
    expect(isDurationSupported("seedance-2-mini", -1)).toBe(false);
    // 固定时长规则不变
    expect(isDurationSupported("seedance-2", 12)).toBe(true);
    expect(isDurationSupported("seedance-2-mini", 6)).toBe(false);
    expect(isDurationSupported("seedance-2-mini", 8)).toBe(true);
  });

  it("builds payload passing through auto duration sentinel", () => {
    const payload = buildVideoGenerationPayload({
      requestId: "vid-auto-0001",
      model: "seedance-2",
      prompt: "自动时长",
      durationSec: 0,
      aspectRatio: "9:16",
      resolution: "720p",
      generateAudio: true,
      imageWithRoles: [],
      videoWithRoles: [],
      audioWithRoles: [],
    });
    expect(payload.duration).toBe(0);
  });

  it("builds ToAPIs payload without generate_audio for seedance mini", () => {
    const payload = buildVideoGenerationPayload({
      requestId: "vid-req-0001",
      model: "seedance-2-mini",
      prompt: "让图片1中的人物转身",
      durationSec: 8,
      aspectRatio: "16:9",
      resolution: "720p",
      generateAudio: true,
      imageWithRoles: [{ url: "https://example.test/ref.png", role: "reference_image" }],
      videoWithRoles: [],
      audioWithRoles: [],
    });

    expect(payload).toMatchObject({
      model: "seedance-2-mini",
      client_business_id: "vid-req-0001",
      prompt: "让图片1中的人物转身",
      duration: 8,
      aspect_ratio: "16:9",
      resolution: "720p",
      image_with_roles: [{ url: "https://example.test/ref.png", role: "reference_image" }],
    });
    expect(payload).not.toHaveProperty("generate_audio");
  });

  it("keeps generate_audio for seedance standard and maps video price resource keys", () => {
    const payload = buildVideoGenerationPayload({
      requestId: "vid-req-0002",
      model: "seedance-2",
      prompt: "霓虹街道运镜",
      durationSec: 12,
      aspectRatio: "9:16",
      resolution: "1080p",
      generateAudio: false,
      imageWithRoles: [],
      videoWithRoles: [{ url: "https://example.test/ref.mp4", role: "reference_video" }],
      audioWithRoles: [],
    });

    expect(payload).toMatchObject({
      generate_audio: false,
      video_with_roles: [{ url: "https://example.test/ref.mp4", role: "reference_video" }],
    });
    expect(videoGenerationResourceKey("seedance-2", "1080p", true)).toBe("video_seedance_2_1080p_with_video");
    expect(videoGenerationResourceKey("seedance-2-fast", "720p", false)).toBe("video_seedance_2_fast_720p_text");
  });

  it("extracts completed video result from ToAPIs task status", () => {
    const status = extractVideoStatus({
      id: "tsk_vid_1",
      object: "generation.task",
      model: "seedance-2",
      status: "completed",
      progress: 100,
      result: {
        type: "video",
        data: [{ url: "https://cdn.example.test/video.mp4", format: "mp4" }],
      },
      completed_at: 1781577700,
      expires_at: 1781664100,
    });

    expect(status).toEqual({
      providerTaskId: "tsk_vid_1",
      providerStatus: "completed",
      status: "completed",
      progress: 100,
      videoUrl: "https://cdn.example.test/video.mp4",
      format: "mp4",
      error: null,
      completedAt: new Date(1781577700 * 1000),
      expiresAt: new Date(1781664100 * 1000),
    });
  });

  it("failed status 保留上游错误 code + message（便于定位真实原因）", () => {
    const status = extractVideoStatus({
      id: "tsk_vid_2",
      status: "failed",
      progress: 100,
      error: { code: "quota_not_enough", message: "任务处理失败" },
    });
    expect(status.status).toBe("failed");
    expect(status.error).toBe("[quota_not_enough] 任务处理失败");
  });

  it("defines the fixed video pricing matrix only for known models", () => {
    expect(VIDEO_PRICE_CONFIGS).toHaveLength(16);
    expect(VIDEO_PRICE_CONFIGS.map((row) => row.resourceKey)).toContain("video_seedance_2_4k_text");
    expect(VIDEO_PRICE_CONFIGS.map((row) => row.resourceKey)).toContain("video_seedance_2_mini_480p_with_video");
    expect(new Set(VIDEO_PRICE_CONFIGS.map((row) => row.resourceKey)).size).toBe(VIDEO_PRICE_CONFIGS.length);
  });
});
