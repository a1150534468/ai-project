import { describe, expect, it } from "vitest";
import {
  IMAGE_ASPECT_RATIO_OPTIONS,
  IMAGE_RESOLUTION_OPTIONS,
  IMAGE_SIZE_OPTIONS,
  WORKFLOW_MODULES,
  advanceImageTaskStatus,
  buildImageSize,
  createImageTask,
  parseImageCount,
  resolveImageSizeSelection,
  resolveImageSubmissionContext,
  resolveImageVersionComparison,
  summarizeImageTasks,
} from "./workflowState";

describe("workflowState", () => {
  it("exposes the requested aspect ratios and resolutions", () => {
    expect(IMAGE_ASPECT_RATIO_OPTIONS.map((option) => option.value)).toEqual(["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"]);
    expect(IMAGE_RESOLUTION_OPTIONS.map((option) => option.value)).toEqual(["1K", "2K"]);
  });

  it("builds the backend size from aspect ratio and resolution", () => {
    expect(buildImageSize("1:1", "1K")).toBe("1024x1024");
    expect(buildImageSize("3:2", "1K")).toBe("1536x1024");
    expect(buildImageSize("16:9", "2K")).toBe("2048x1152");
    expect(buildImageSize("9:16", "2K")).toBe("1152x2048");
    expect(buildImageSize("21:9", "2K")).toBe("2688x1152");
  });

  it("keeps compatibility size options derived from ratio and resolution", () => {
    expect(IMAGE_SIZE_OPTIONS.map((option) => option.value)).not.toContain("3840x2160");
    expect(IMAGE_SIZE_OPTIONS.map((option) => option.value)).not.toContain("3840x1648");
  });

  it("restores aspect ratio and resolution from a persisted task size", () => {
    expect(resolveImageSizeSelection("2048x1152")).toEqual({ aspectRatio: "16:9", resolution: "2K" });
    expect(resolveImageSizeSelection("not-a-supported-size")).toBeNull();
  });

  it("only submits an edit source while the workspace is editing", () => {
    expect(resolveImageSubmissionContext("editing", "variation", "source-1")).toEqual({
      generationIntent: "variation",
      sourceImageAssetId: "source-1",
    });
    expect(resolveImageSubmissionContext("result", "edit", "stale-source")).toEqual({
      generationIntent: "new",
      sourceImageAssetId: null,
    });
  });

  it("uses the completed task's persisted source for version comparison", () => {
    const completedEdit = {
      ...createImageTask({
        id: "task-v2",
        prompt: "新版本",
        size: "1024x1024",
        count: 1,
        createdAt: "2026-07-22T10:00:00.000Z",
      }),
      status: "completed" as const,
      generationIntent: "edit" as const,
      sourceImageAssetId: "source-v1",
    };

    expect(resolveImageVersionComparison(completedEdit, "candidate-v2")).toEqual(["source-v1", "candidate-v2"]);
    expect(resolveImageVersionComparison({ ...completedEdit, status: "running" }, "candidate-v2")).toBeNull();
  });

  it("marks image, novel, commerce, fanout, article workflow, local business promo, comic, and scheduled task modules available", () => {
    const available = WORKFLOW_MODULES.filter((module) => module.status === "available");

    expect(available.map((module) => module.id)).toEqual([
      "image",
      "novel",
      "commerce-long-image",
      "codex-pet",
      "fanout",
      "article-workflow",
      "local-business-promo",
      "ai-comic",
      "scheduled-task",
    ]);
    expect(WORKFLOW_MODULES.filter((module) => module.status === "developing")).toHaveLength(1);
  });

  it("parses image count as an integer from 1 to 8", () => {
    expect(parseImageCount("1")).toEqual({ ok: true, value: 1 });
    expect(parseImageCount("8")).toEqual({ ok: true, value: 8 });
    expect(parseImageCount("0")).toEqual({ ok: false, error: "张数至少为 1" });
    expect(parseImageCount("9")).toEqual({ ok: false, error: "最多生成 8 张" });
    expect(parseImageCount("1.5")).toEqual({ ok: false, error: "张数必须是整数" });
    expect(parseImageCount("abc")).toEqual({ ok: false, error: "张数必须是整数" });
  });

  it("creates a queued image task with trimmed prompt", () => {
    const task = createImageTask({
      id: "task-1",
      prompt: "  陶瓷浅色餐盘  ",
      size: "1024x1024 (1:1)",
      count: 2,
      createdAt: "2026-06-30T06:32:00.000Z",
    });

    expect(task).toEqual({
      id: "task-1",
      prompt: "陶瓷浅色餐盘",
      size: "1024x1024 (1:1)",
      count: 2,
      status: "queued",
      createdAt: "2026-06-30T06:32:00.000Z",
    });
  });

  it("advances queued tasks to running and running tasks to completed", () => {
    const queued = createImageTask({
      id: "task-1",
      prompt: "陶瓷浅色餐盘",
      size: "1024x1024 (1:1)",
      count: 1,
      createdAt: "2026-06-30T06:32:00.000Z",
    });

    const running = advanceImageTaskStatus(queued, "running");
    const completed = advanceImageTaskStatus(running, "completed");

    expect(running.status).toBe("running");
    expect(completed.status).toBe("completed");
    expect(advanceImageTaskStatus(completed, "running").status).toBe("completed");
  });

  it("summarizes running tasks and completed images", () => {
    const base = {
      prompt: "陶瓷浅色餐盘",
      size: "1024x1024 (1:1)",
      createdAt: "2026-06-30T06:32:00.000Z",
    };

    const tasks = [
      { ...createImageTask({ ...base, id: "task-1", count: 1 }), status: "queued" as const },
      { ...createImageTask({ ...base, id: "task-2", count: 2 }), status: "running" as const },
      { ...createImageTask({ ...base, id: "task-3", count: 4 }), status: "completed" as const },
      { ...createImageTask({ ...base, id: "task-4", count: 8 }), status: "failed" as const },
      { ...createImageTask({ ...base, id: "task-5", count: 1 }), status: "cancelled" as const },
    ];

    expect(summarizeImageTasks(tasks)).toEqual({
      runningTasks: 2,
      completedImages: 4,
      failedTasks: 1,
    });
  });
});
