import { describe, expect, it } from "vitest";
import {
  IMAGE_ASPECT_RATIO_OPTIONS,
  IMAGE_MAX_COUNT,
  IMAGE_MODEL_OPTIONS,
  IMAGE_RESOLUTION_OPTIONS,
  WORKFLOW_MODULES,
  advanceImageTaskStatus,
  buildImageSize,
  createImageTask,
  isImageAspectRatio,
  isImageModel,
  isImageResolution,
  parseImageCount,
  resolveImageSizeSelection,
  resolveImageSubmissionContext,
  resolveImageVersionComparison,
} from "./workflowState";
import type { ImageTask, ImageTaskStatus } from "./workflowState";

const AT = "2026-06-30T06:32:00.000Z";

/** 建一个排队中的任务再按需覆盖字段 —— 状态机与对比逻辑只看其中两三个字段。 */
function task(overrides: Partial<ImageTask> = {}): ImageTask {
  const base = createImageTask({ id: "task-1", prompt: "陶瓷浅色餐盘", size: "1024x1024", count: 1, createdAt: AT });

  return { ...base, ...overrides };
}

describe("选项表", () => {
  it("比例与分辨率的顺序就是下拉里的顺序", () => {
    expect(IMAGE_ASPECT_RATIO_OPTIONS.map((option) => option.value)).toEqual([
      "1:1",
      "4:3",
      "3:4",
      "3:2",
      "2:3",
      "16:9",
      "9:16",
      "21:9",
    ]);
    expect(IMAGE_RESOLUTION_OPTIONS.map((option) => option.value)).toEqual(["1K", "2K"]);
  });

  it("比例与分辨率的文案就是值本身", () => {
    for (const option of [...IMAGE_ASPECT_RATIO_OPTIONS, ...IMAGE_RESOLUTION_OPTIONS]) {
      expect(option.label).toBe(option.value);
    }
  });

  it("三个模型都支持参考图", () => {
    expect(IMAGE_MODEL_OPTIONS.map((option) => option.value)).toEqual([
      "qwen-image-2.0-pro-2026-04-22",
      "gpt-image-2",
      "doubao-seedream-4-5-251128",
    ]);
    expect(IMAGE_MODEL_OPTIONS.every((option) => option.supportsReferenceImages)).toBe(true);
  });
});

const SIZE_PROBES = [
  { ratio: "1:1", resolution: "1K", size: "1024x1024" },
  { ratio: "3:2", resolution: "1K", size: "1536x1024" },
  { ratio: "16:9", resolution: "2K", size: "2048x1152" },
  { ratio: "9:16", resolution: "2K", size: "1152x2048" },
  { ratio: "21:9", resolution: "2K", size: "2688x1152" },
] as const;

describe("尺寸换算", () => {
  for (const probe of SIZE_PROBES) {
    it(`${probe.ratio} 的 ${probe.resolution} 是 ${probe.size}`, () => {
      expect(buildImageSize(probe.ratio, probe.resolution)).toBe(probe.size);
    });
  }

  it("整张表的尺寸串都能解回原来的比例与分辨率", () => {
    for (const ratio of IMAGE_ASPECT_RATIO_OPTIONS) {
      for (const resolution of IMAGE_RESOLUTION_OPTIONS) {
        const size = buildImageSize(ratio.value, resolution.value);

        expect(resolveImageSizeSelection(size)).toEqual({ aspectRatio: ratio.value, resolution: resolution.value });
      }
    }
  });

  it("表外的尺寸串一律认不出来", () => {
    expect(resolveImageSizeSelection("not-a-supported-size")).toBeNull();
    // 这两个 4K 档位早先版本给过，现在已经撤了，不许再被解出来
    expect(resolveImageSizeSelection("3840x2160")).toBeNull();
    expect(resolveImageSizeSelection("3840x1648")).toBeNull();
  });
});

interface GuardProbe {
  readonly what: string;
  readonly guard: (value: string) => boolean;
  readonly good: string;
  readonly bad: string;
}

const GUARD_PROBES: readonly GuardProbe[] = [
  { what: "比例", guard: isImageAspectRatio, good: "16:9", bad: "5:4" },
  { what: "分辨率", guard: isImageResolution, good: "2K", bad: "4K" },
  { what: "模型", guard: isImageModel, good: "gpt-image-2", bad: "sd-xl" },
];

describe("外部值的守卫", () => {
  for (const probe of GUARD_PROBES) {
    it(`${probe.what}只认表里的值`, () => {
      expect(probe.guard(probe.good)).toBe(true);
      expect(probe.guard(probe.bad)).toBe(false);
      expect(probe.guard("")).toBe(false);
    });
  }
});

const MODE_PROBES = [
  { mode: "editing", keeps: true },
  { mode: "empty", keeps: false },
  { mode: "result", keeps: false },
  { mode: "comparing", keeps: false },
] as const;

describe("resolveImageSubmissionContext", () => {
  for (const probe of MODE_PROBES) {
    it(`${probe.mode} 模式${probe.keeps ? "带上" : "丢掉"}来源图`, () => {
      expect(resolveImageSubmissionContext(probe.mode, "edit", "source-1")).toEqual(
        probe.keeps
          ? { generationIntent: "edit", sourceImageAssetId: "source-1" }
          : { generationIntent: "new", sourceImageAssetId: null },
      );
    });
  }

  it("编辑中原样带上传进来的意图", () => {
    expect(resolveImageSubmissionContext("editing", "variation", "source-1")).toEqual({
      generationIntent: "variation",
      sourceImageAssetId: "source-1",
    });
  });
});

const EDITED = task({ status: "completed", generationIntent: "edit", sourceImageAssetId: "source-v1" });

interface ComparisonProbe {
  readonly what: string;
  readonly task: ImageTask | null;
  readonly candidate: string | null;
  readonly want: readonly [string, string] | null;
}

const COMPARISON_PROBES: readonly ComparisonProbe[] = [
  { what: "改图跑完给出前后两个 id", task: EDITED, candidate: "candidate-v2", want: ["source-v1", "candidate-v2"] },
  { what: "还在跑就没得比", task: { ...EDITED, status: "running" }, candidate: "candidate-v2", want: null },
  { what: "新画的图没有改前", task: { ...EDITED, generationIntent: "new" }, candidate: "candidate-v2", want: null },
  { what: "来源图丢了就没得比", task: { ...EDITED, sourceImageAssetId: null }, candidate: "candidate-v2", want: null },
  { what: "还没选中改后的那张", task: EDITED, candidate: null, want: null },
  { what: "根本没有任务", task: null, candidate: "candidate-v2", want: null },
];

describe("resolveImageVersionComparison", () => {
  for (const probe of COMPARISON_PROBES) {
    it(probe.what, () => {
      expect(resolveImageVersionComparison(probe.task, probe.candidate)).toEqual(probe.want);
    });
  }
});

describe("WORKFLOW_MODULES", () => {
  it("四个模块可用、只有 PPT 在建，顺序就是导航顺序", () => {
    const byStatus = (status: string) => WORKFLOW_MODULES.filter((card) => card.status === status).map((card) => card.id);

    expect(byStatus("available")).toEqual(["image", "novel", "codex-pet", "article-workflow"]);
    expect(byStatus("developing")).toEqual(["ppt"]);
  });

  it("每个模块都有标题、说明和图标", () => {
    for (const card of WORKFLOW_MODULES) {
      expect(card.title).not.toBe("");
      expect(card.description).not.toBe("");
      expect(card.icon).toMatch(/^mdi:/);
    }
  });
});

const COUNT_PROBES = [
  { raw: "1", want: { ok: true, value: 1 } },
  { raw: "8", want: { ok: true, value: 8 } },
  { raw: "  3  ", want: { ok: true, value: 3 } },
  { raw: "08", want: { ok: true, value: 8 } },
  { raw: "0", want: { ok: false, error: "张数至少为 1" } },
  { raw: "9", want: { ok: false, error: "最多生成 8 张" } },
  { raw: "1.5", want: { ok: false, error: "张数必须是整数" } },
  { raw: "abc", want: { ok: false, error: "张数必须是整数" } },
  { raw: "", want: { ok: false, error: "张数必须是整数" } },
  // 负号在第一道就被拦掉，所以报的是「必须是整数」而不是「至少为 1」
  { raw: "-1", want: { ok: false, error: "张数必须是整数" } },
  // 全角数字也不算数字：它进不了 parseInt，别指望它被当成 1
  { raw: "１", want: { ok: false, error: "张数必须是整数" } },
] as const;

describe("parseImageCount", () => {
  for (const probe of COUNT_PROBES) {
    it(`${JSON.stringify(probe.raw)} → ${probe.want.ok ? probe.want.value : probe.want.error}`, () => {
      expect(parseImageCount(probe.raw)).toEqual(probe.want);
    });
  }

  it("上界跟着 IMAGE_MAX_COUNT 走", () => {
    expect(parseImageCount(String(IMAGE_MAX_COUNT)).ok).toBe(true);
    expect(parseImageCount(String(IMAGE_MAX_COUNT + 1))).toEqual({
      ok: false,
      error: `最多生成 ${IMAGE_MAX_COUNT} 张`,
    });
  });
});

describe("createImageTask", () => {
  it("提示词去掉首尾空白、状态从排队起，字段不多不少", () => {
    const created = createImageTask({
      id: "task-1",
      prompt: "  陶瓷浅色餐盘  ",
      size: "1024x1024",
      count: 2,
      createdAt: AT,
    });

    expect(created).toEqual({
      id: "task-1",
      prompt: "陶瓷浅色餐盘",
      size: "1024x1024",
      count: 2,
      status: "queued",
      createdAt: AT,
    });
  });
});

const SETTLED: readonly ImageTaskStatus[] = ["completed", "failed", "cancelled"];

describe("advanceImageTaskStatus", () => {
  it("排队 → 运行 → 完成，完成时把进度补满", () => {
    const running = advanceImageTaskStatus(task({ count: 4 }), "running");

    expect(running.status).toBe("running");
    expect(running.completedCount).toBeUndefined();

    const completed = advanceImageTaskStatus(running, "completed");

    expect(completed.status).toBe("completed");
    expect(completed.completedCount).toBe(4);
  });

  for (const status of SETTLED) {
    it(`落到 ${status} 之后再来的更新一律忽略`, () => {
      const settled = task({ status });

      // 连对象都不换：晚到的轮询结果不该让引用变，免得白重渲染一次
      expect(advanceImageTaskStatus(settled, "running")).toBe(settled);
    });
  }
});

