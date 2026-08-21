import { describe, expect, it, vi } from "vitest";
import {
  VIDEO_PRICE_CONFIGS,
  buildVideoGenerationPayload,
  extractVideoStatus,
  isAutoDuration,
  isDurationSupported,
  probeVideoGenerationStatus,
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

// 兜底扫用的三态探测。与 getVideoGenerationStatus 的区别就是「查不到」和「暂时答不了」
// 必须分开：前者该收尸退款，后者只能等下一轮。混成一种就会在上游抖动时错退钱。
describe("probeVideoGenerationStatus", () => {
  const cfg = {
    apiKey: "k",
    endpoint: "https://toapis.test/v1/videos/generations",
    statusEndpointBase: "https://toapis.test/v1/videos/generations",
  } satisfies Parameters<typeof probeVideoGenerationStatus>[0]["cfg"];

  async function probe(fetchFn: typeof fetch) {
    return probeVideoGenerationStatus({ cfg, providerTaskId: "tsk_1", fetchFn, timeoutMs: 1_000 });
  }

  it("200 → found，带上游解析出的状态", async () => {
    const result = await probe(vi.fn(async () => new Response(JSON.stringify({
      id: "tsk_1", status: "in_progress", progress: 42,
    }), { status: 200 })) as unknown as typeof fetch);
    expect(result.kind).toBe("found");
    if (result.kind !== "found") throw new Error("unreachable");
    expect(result.status.status).toBe("running");
    expect(result.status.progress).toBe(42);
  });

  it("404 / 410 → missing（上游明确说没有这个任务，才允许收尸）", async () => {
    for (const httpStatus of [404, 410]) {
      const result = await probe(vi.fn(async () => new Response("gone", { status: httpStatus })) as unknown as typeof fetch);
      expect(result).toEqual({ kind: "missing", httpStatus });
    }
  });

  it("5xx → unknown（上游自己坏了，不代表任务没了）", async () => {
    for (const httpStatus of [500, 502, 503]) {
      const result = await probe(vi.fn(async () => new Response("boom", { status: httpStatus })) as unknown as typeof fetch);
      expect(result.kind).toBe("unknown");
    }
  });

  it("401 / 429 → unknown（鉴权失配、限流都不是「任务不存在」）", async () => {
    // 这两个尤其危险：配置写错或被限流时，若判成 missing 会把全库在跑的任务集体退款。
    for (const httpStatus of [401, 403, 429]) {
      const result = await probe(vi.fn(async () => new Response("nope", { status: httpStatus })) as unknown as typeof fetch);
      expect(result.kind).toBe("unknown");
    }
  });

  it("fetch 抛异常（超时 / DNS / 连接被拒）→ unknown，绝不是 missing", async () => {
    const result = await probe(vi.fn(async () => { throw new Error("The operation was aborted due to timeout"); }) as unknown as typeof fetch);
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") throw new Error("unreachable");
    expect(result.reason).toContain("timeout");
  });

  it("响应体不是 JSON → unknown（网关塞了 HTML 错误页这种）", async () => {
    const result = await probe(vi.fn(async () => new Response("<html>502</html>", {
      status: 200, headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch);
    expect(result.kind).toBe("unknown");
  });

  it("reason 截断到 200 字，日志不被上游长报文淹", async () => {
    const result = await probe(vi.fn(async () => { throw new Error("x".repeat(500)); }) as unknown as typeof fetch);
    if (result.kind !== "unknown") throw new Error("unreachable");
    expect(result.reason).toHaveLength(200);
  });

  it("providerTaskId 做过 URL 编码，异常 id 不会拼歪路径", async () => {
    // 入参类型要显式写出来，否则 mock.calls[0] 被推成空元组，取 [0] 报 TS2493。
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: "x", status: "completed", progress: 100 }), { status: 200 })
    );
    await probeVideoGenerationStatus({
      cfg, providerTaskId: "a/../b?x=1", fetchFn: fetchFn as unknown as typeof fetch, timeoutMs: 1_000,
    });
    expect(fetchFn.mock.calls[0]![0]).toBe("https://toapis.test/v1/videos/generations/a%2F..%2Fb%3Fx%3D1");
  });
});
