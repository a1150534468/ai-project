import { describe, expect, it, vi } from "vitest";
import { estimateComicVideoCost, listComicVideoModels } from "./comic-video-models.js";
import { loadSeedanceConfig, pollSeedanceVideoTask, submitSeedanceVideoTask } from "./comic-video-service.js";

describe("comic video service", () => {
  it("exposes deterministic Seedance-compatible model costs", () => {
    const models = listComicVideoModels();
    expect(models[0]?.id).toBe("seedance-lite");
    expect(estimateComicVideoCost({ modelId: "seedance-lite", durationSec: 10, shotCount: 2 })).toBe(48);
  });

  it("fails before provider calls when SEEDANCE_API_KEY is missing", () => {
    expect(() => loadSeedanceConfig({ SEEDANCE_BASE_URL: "https://example.com" })).toThrow("SEEDANCE_API_KEY required");
  });

  it("submits image-to-video without forbidden white-model fields", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      expect(JSON.stringify(body)).not.toMatch(/whiteModel|white-model|shot_white_model|Blender|白模/u);
      return new Response(JSON.stringify({ id: "video-task-1", status: "queued" }), { status: 200 });
    });

    const result = await submitSeedanceVideoTask({
      config: {
        apiKey: "key",
        baseUrl: "https://seedance.example/v1",
        model: "seedance-lite",
      },
      fetchFn,
      imageUrl: "https://cdn.example/shot.png",
      prompt: "角色走入雨夜旧港区",
      durationSec: 5,
      resolution: "720p",
    });

    expect(result).toEqual({ taskId: "video-task-1", status: "queued" });
  });

  it("polls completed provider task", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      id: "video-task-1",
      status: "succeeded",
      videoUrl: "https://cdn.example/shot.mp4",
    }), { status: 200 }));

    const result = await pollSeedanceVideoTask({
      config: {
        apiKey: "key",
        baseUrl: "https://seedance.example/v1",
        model: "seedance-lite",
      },
      fetchFn,
      taskId: "video-task-1",
    });

    expect(result).toEqual({ taskId: "video-task-1", status: "succeeded", videoUrl: "https://cdn.example/shot.mp4" });
  });
});
