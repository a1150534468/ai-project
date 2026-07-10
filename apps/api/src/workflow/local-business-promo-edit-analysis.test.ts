import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  analyzeLocalBusinessPromoShot,
  buildLocalBusinessPromoAnalysisBlocks,
} from "./local-business-promo-edit-analysis.js";

const IMAGE_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnRmwAAAABJRU5ErkJggg==";

function createShot(materials: Array<{ url: string; mime: string; name: string; durationSec: number }>) {
  return {
    shotId: "shot-1",
    label: "开场",
    durationSec: 4,
    materialGroup: "opening",
    fallbackGroups: [] as Array<"opening" | "process" | "environment" | "result">,
    scriptLine: "第一口就要把门店状态讲清楚。",
    subtitlePlacement: "bottom" as const,
    prompt: "开场镜头",
    materials,
    taskStatus: "queued",
  } as const;
}

function createBrief() {
  return {
    storeName: "瑞幸咖啡",
    industry: "精品咖啡",
    cityArea: "广州正佳广场",
    targetCustomers: "周围白领",
    mainOffer: "生椰拿铁",
    sellingPoints: "出品稳定，性价比高",
  } as const;
}

function createSettings() {
  return {
    direction: "service-showcase",
    durationSec: 25,
    aspectRatio: "9:16",
    subtitleStyle: "douyin-outline",
    narrationVoice: "vv-female-natural",
    voiceMode: "preset",
    voiceDesignPrompt: "",
    voiceStylePrompt: "",
    musicPreset: "premium-clean",
  } as const;
}

async function runFfmpeg(args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

async function createVideoDataUrl(durationSec = 4): Promise<string> {
  const workdir = await mkdtemp(join(tmpdir(), "local-business-promo-analysis-test-"));
  try {
    const outputPath = join(workdir, "sample.mp4");
    await runFfmpeg([
      "-y",
      "-f", "lavfi",
      "-i", `testsrc=size=160x120:rate=1:duration=${durationSec}`,
      "-pix_fmt", "yuv420p",
      outputPath,
    ]);
    const buffer = await readFile(outputPath);
    return `data:video/mp4;base64,${buffer.toString("base64")}`;
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe("local-business-promo-edit-analysis", () => {
  it("builds video preview frames instead of forwarding the whole video block", async () => {
    const videoUrl = await createVideoDataUrl();
    const blocks = await buildLocalBusinessPromoAnalysisBlocks({
      materials: [{
        url: videoUrl,
        mime: "video/mp4",
        name: "sample.mp4",
        durationSec: 4,
      }],
    });

    expect(blocks.some((block) => block.type === "video")).toBe(false);
    expect(blocks.filter((block) => block.type === "image").length).toBeGreaterThanOrEqual(3);
    expect(blocks[0]).toMatchObject({ type: "text" });
    expect((blocks[0] as { type: "text"; text: string }).text).toContain("预览帧");
  });

  it("retries transient timeout errors before returning shot analysis", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("Request timed out."))
      .mockResolvedValueOnce({
        content: [{
          type: "text",
          text: '{"materialNotes":[{"index":1,"description":"门头与出杯画面"}],"selectedIndex":1,"sourceStartSec":0,"sourceEndSec":0,"renderMode":"image-pan","subtitlePlacement":"top","rationale":"开场适合先看门店主体"}',
        }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    const client = {
      messages: {
        create,
      },
    } as unknown as Anthropic;

    const analyzed = await analyzeLocalBusinessPromoShot({
      brief: createBrief(),
      settings: createSettings(),
      shot: createShot([{
        url: IMAGE_DATA_URL,
        mime: "image/png",
        name: "门头.png",
        durationSec: 0,
      }]),
      client,
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(analyzed.shot.selectedMaterialName).toBe("门头.png");
    expect(analyzed.shot.renderMode).toBe("image-pan");
    expect(analyzed.shot.subtitlePlacement).toBe("top");
    expect(analyzed.snapshot.materialNotes[0]?.description).toContain("门头");
  });

  it("avoids reusing the same video range when fallback analysis must pick again", async () => {
    const videoUrl = await createVideoDataUrl(12);
    const timeoutClient = {
      messages: {
        create: vi.fn(async () => {
          throw new Error("Request timed out.");
        }),
      },
    } as unknown as Anthropic;
    const baseShot = createShot([{
      url: videoUrl,
      mime: "video/mp4",
      name: "门店混剪.mp4",
      durationSec: 12,
    }]);

    const first = await analyzeLocalBusinessPromoShot({
      brief: createBrief(),
      settings: createSettings(),
      shot: baseShot,
      client: timeoutClient,
    });
    const second = await analyzeLocalBusinessPromoShot({
      brief: createBrief(),
      settings: createSettings(),
      shot: {
        ...baseShot,
        shotId: "shot-2",
        label: "结果收尾",
        materialGroup: "result",
      },
      priorSelections: [first.shot],
      client: timeoutClient,
    });

    expect(first.shot.renderMode).toBe("video-cut");
    expect(second.shot.renderMode).toBe("video-cut");
    expect((second.shot.sourceStartSec ?? 0) >= (first.shot.sourceEndSec ?? 0)).toBe(true);
  });
});
