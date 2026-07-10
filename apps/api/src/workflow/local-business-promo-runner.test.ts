import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { executeLocalBusinessPromoRun } from "./local-business-promo-runner.js";

function createPrismaForRunner() {
  const project = {
    id: "project-1",
    userId: "u1",
    title: "门店宣传",
    brief: {
      storeName: "晴天咖啡",
      industry: "咖啡店",
      cityArea: "杭州滨江",
      targetCustomers: "白领",
      mainOffer: "拿铁",
      sellingPoints: "出品稳定",
    },
    materials: {},
    settings: {
      direction: "store-trust",
      durationSec: 25,
      aspectRatio: "9:16",
      subtitleStyle: "none",
      narrationVoice: "vv-female-natural",
      voiceMode: "preset",
      voiceDesignPrompt: "",
      voiceStylePrompt: "",
      musicPreset: "light-explore",
    },
    scriptDraft: "第一行\n第二行",
    latestRunId: "run-1",
    voiceCloneSampleAssetId: null,
    activeNarrationAssetId: "audio-1",
    activeBgmAssetId: "audio-2",
    status: "generating",
    createdAt: new Date("2026-07-07T08:00:00.000Z"),
    updatedAt: new Date("2026-07-07T08:00:00.000Z"),
  };
  const run = {
    id: "run-1",
    projectId: "project-1",
    userId: "u1",
    billingOperationId: "local-business-promo-render:project-1:op-1",
    billingRefundedAt: null,
    billingRefundStatus: "none",
    billingRefundError: null,
    billingRefundRetryCount: 0,
    billingRefundLastAttemptAt: null,
    billingRefundNextRetryAt: null,
    settingsSnapshot: project.settings,
    scriptSnapshot: project.scriptDraft,
    shotPlan: [
      {
        shotId: "shot-1",
        label: "开场",
        durationSec: 4,
        materialGroup: "opening",
        fallbackGroups: [],
        scriptLine: "第一行",
        subtitlePlacement: "bottom",
        prompt: "开场镜头",
        materials: [{ url: "https://example.test/opening.mp4", mime: "video/mp4", name: "门头", durationSec: 8, objectKey: "workflow/video-materials/u1/opening.mp4" }],
        taskStatus: "queued",
      },
      {
        shotId: "shot-2",
        label: "环境",
        durationSec: 4,
        materialGroup: "environment",
        fallbackGroups: [],
        scriptLine: "第二行",
        subtitlePlacement: "bottom",
        prompt: "环境镜头",
        materials: [{ url: "https://example.test/environment.jpg", mime: "image/jpeg", name: "环境图", durationSec: 0, objectKey: "workflow/video-materials/u1/environment.jpg" }],
        taskStatus: "queued",
      },
    ],
    analysisSnapshot: null,
    clipRequestIds: [],
    mergedAssetId: null,
    narrationAssetId: "audio-1",
    bgmAssetId: "audio-2",
    status: "queued",
    progressPercent: 0,
    progressStage: "queued",
    progressMessage: null,
    error: null,
    startedAt: null,
    workerId: null,
    createdAt: new Date("2026-07-07T08:00:00.000Z"),
    updatedAt: new Date("2026-07-07T08:00:00.000Z"),
    completedAt: null,
  };
  const audioAssets = [
    {
      id: "audio-1",
      userId: "u1",
      projectId: "project-1",
      requestId: "req-audio-1",
      kind: "narration",
      source: "mimo",
      provider: "mimo",
      providerModel: "mimo-v2.5-tts",
      originalUrl: "https://example.test/narration.wav",
      objectKey: "workflow/audio/u1/project-1/narration.wav",
      mime: "audio/wav",
      format: "wav",
      durationSec: 12,
      textContent: "旁白",
      metadata: {},
      createdAt: new Date("2026-07-07T08:00:00.000Z"),
    },
    {
      id: "audio-2",
      userId: "u1",
      projectId: "project-1",
      requestId: "req-audio-2",
      kind: "bgm",
      source: "preset",
      provider: null,
      providerModel: null,
      originalUrl: "https://example.test/bgm.mp3",
      objectKey: "workflow/audio/u1/project-1/bgm.mp3",
      mime: "audio/mpeg",
      format: "mp3",
      durationSec: 25,
      textContent: null,
      metadata: {},
      createdAt: new Date("2026-07-07T08:00:00.000Z"),
    },
  ];
  const videoAssets: Array<Record<string, unknown>> = [];
  const billing = {
    refundResource: vi.fn(async () => ({ success: true })),
  };

  const prisma = {
    localBusinessPromoRun: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) => (where.id === run.id ? run : null)),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if (where.id !== run.id) throw new Error("run not found");
        Object.assign(run, data, { updatedAt: new Date("2026-07-07T08:01:00.000Z") });
        return run;
      }),
    },
    localBusinessPromoProject: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string; userId?: string } }) =>
        where.id === project.id && where.userId === project.userId ? project : null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if (where.id !== project.id) throw new Error("project not found");
        Object.assign(project, data, { updatedAt: new Date("2026-07-07T08:02:00.000Z") });
        return project;
      }),
    },
    audioAsset: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string; userId?: string } }) =>
        audioAssets.find((asset) => asset.id === where.id && asset.userId === where.userId) ?? null),
    },
    videoAsset: {
      findFirst: vi.fn(async ({ where }: { where: { requestId?: string; userId?: string } }) =>
        videoAssets.find((asset) => asset.requestId === where.requestId && asset.userId === where.userId) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `video-${videoAssets.length + 1}`,
          createdAt: new Date("2026-07-07T08:03:00.000Z"),
          ...data,
        };
        videoAssets.push(row);
        return row;
      }),
    },
  } as unknown as PrismaClient;

  return { prisma, billing, state: { project, run, videoAssets } };
}

describe("executeLocalBusinessPromoRun", () => {
  it("analyzes shots, renders the video, and writes completed state", async () => {
    const { prisma, billing, state } = createPrismaForRunner();
    const analyzeShot = vi
      .fn()
      .mockResolvedValueOnce({
        shot: {
          ...state.run.shotPlan[0],
          selectedMaterialUrl: "https://example.test/opening.mp4",
          selectedMaterialName: "门头",
          selectedMaterialMime: "video/mp4",
          sourceStartSec: 1,
          sourceEndSec: 5,
          renderMode: "video-cut",
        },
        snapshot: {
          shotId: "shot-1",
          rationale: "开场先看门头",
          materialNotes: [{ index: 1, description: "门店外景视频" }],
        },
      })
      .mockResolvedValueOnce({
        shot: {
          ...state.run.shotPlan[1],
          selectedMaterialUrl: "https://example.test/environment.jpg",
          selectedMaterialName: "环境图",
          selectedMaterialMime: "image/jpeg",
          sourceStartSec: 0,
          sourceEndSec: 0,
          renderMode: "image-pan",
        },
        snapshot: {
          shotId: "shot-2",
          rationale: "补充空间环境",
          materialNotes: [{ index: 1, description: "室内环境图片" }],
        },
      });
    const renderVideo = vi.fn(async ({ shotPlan, onShotStart, onShotComplete }) => {
      for (const shot of shotPlan) {
        await onShotStart?.(shot.shotId);
        await onShotComplete?.(shot.shotId);
      }
      return {
        url: "https://example.test/final.mp4",
        objectKey: "workflow/local-business-promo/u1/project-1/run-1/final.mp4",
        mime: "video/mp4",
        format: "mp4",
        durationSec: 8,
      };
    });

    await executeLocalBusinessPromoRun({
      runId: "run-1",
      prisma,
      billing,
      client: {} as never,
      analyzeShot,
      renderVideo,
      workerId: "worker-test",
    });

    expect(analyzeShot).toHaveBeenCalledTimes(2);
    expect(renderVideo).toHaveBeenCalledTimes(1);
    expect(renderVideo).toHaveBeenCalledWith(expect.objectContaining({
      brief: expect.objectContaining({
        storeName: "晴天咖啡",
      }),
      subtitleStyle: "none",
      targetDurationSec: 25,
      narrationObjectKey: "workflow/audio/u1/project-1/narration.wav",
      bgmObjectKey: "workflow/audio/u1/project-1/bgm.mp3",
    }));
    expect(state.run.status).toBe("completed");
    expect(state.run.progressStage).toBe("completed");
    expect(state.run.progressPercent).toBe(100);
    expect(state.run.mergedAssetId).toBe("video-1");
    expect(billing.refundResource).not.toHaveBeenCalled();
    expect((state.run.shotPlan as Array<{ taskStatus: string; selectedMaterialName?: string }>).every((shot) => shot.taskStatus === "completed")).toBe(true);
    expect(state.project.status).toBe("completed");
    expect(state.videoAssets[0]?.originalUrl).toBe("https://example.test/final.mp4");
  });

  it("refunds and marks the run failed when shot analysis fails", async () => {
    const { prisma, billing, state } = createPrismaForRunner();
    const analyzeShot = vi.fn(async () => {
      throw new Error("analysis failed");
    });
    const renderVideo = vi.fn();

    await expect(executeLocalBusinessPromoRun({
      runId: "run-1",
      prisma,
      billing,
      client: {} as never,
      analyzeShot,
      renderVideo,
      workerId: "worker-test",
    })).rejects.toThrow("analysis failed");

    expect(renderVideo).not.toHaveBeenCalled();
    expect(billing.refundResource).toHaveBeenCalledWith(state.run.billingOperationId);
    expect(state.run.status).toBe("failed");
    expect(state.run.progressStage).toBe("failed");
    expect(state.run.error).toContain("analysis failed");
    expect(state.run.billingRefundedAt).not.toBeNull();
    expect(state.project.status).toBe("failed");
  });

  it("refunds and marks the run failed when renderVideo fails", async () => {
    const { prisma, billing, state } = createPrismaForRunner();
    const analyzeShot = vi
      .fn()
      .mockResolvedValueOnce({
        shot: {
          ...state.run.shotPlan[0],
          selectedMaterialUrl: "https://example.test/opening.mp4",
          selectedMaterialName: "门头",
          selectedMaterialMime: "video/mp4",
          sourceStartSec: 1,
          sourceEndSec: 5,
          renderMode: "video-cut",
        },
        snapshot: {
          shotId: "shot-1",
          rationale: "开场先看门头",
          materialNotes: [{ index: 1, description: "门店外景视频" }],
        },
      })
      .mockResolvedValueOnce({
        shot: {
          ...state.run.shotPlan[1],
          selectedMaterialUrl: "https://example.test/environment.jpg",
          selectedMaterialName: "环境图",
          selectedMaterialMime: "image/jpeg",
          sourceStartSec: 0,
          sourceEndSec: 0,
          renderMode: "image-pan",
        },
        snapshot: {
          shotId: "shot-2",
          rationale: "补充空间环境",
          materialNotes: [{ index: 1, description: "室内环境图片" }],
        },
      });
    const renderVideo = vi.fn(async () => {
      throw new Error("render failed");
    });

    await expect(executeLocalBusinessPromoRun({
      runId: "run-1",
      prisma,
      billing,
      client: {} as never,
      analyzeShot,
      renderVideo,
      workerId: "worker-test",
    })).rejects.toThrow("render failed");

    expect(analyzeShot).toHaveBeenCalledTimes(2);
    expect(renderVideo).toHaveBeenCalledTimes(1);
    expect(billing.refundResource).toHaveBeenCalledWith(state.run.billingOperationId);
    expect(state.run.status).toBe("failed");
    expect(state.run.progressStage).toBe("failed");
    expect(state.run.error).toContain("render failed");
    expect(state.run.billingRefundedAt).not.toBeNull();
    expect(state.project.status).toBe("failed");
  });

  it("marks the refund as pending when worker failure cannot refund immediately", async () => {
    const { prisma, billing, state } = createPrismaForRunner();
    billing.refundResource.mockRejectedValueOnce(new Error("billing timeout"));
    const analyzeShot = vi.fn(async () => {
      throw new Error("analysis failed");
    });

    await expect(executeLocalBusinessPromoRun({
      runId: "run-1",
      prisma,
      billing,
      client: {} as never,
      analyzeShot,
      renderVideo: vi.fn(),
      workerId: "worker-test",
    })).rejects.toThrow("后台继续重试");

    expect(billing.refundResource).toHaveBeenCalledWith(state.run.billingOperationId);
    expect(state.run.status).toBe("failed");
    expect(state.run.billingRefundedAt).toBeNull();
    expect(state.run.billingRefundStatus).toBe("pending");
    expect(state.run.billingRefundError).toContain("billing timeout");
    expect(state.run.billingRefundRetryCount).toBe(1);
    expect(state.run.billingRefundNextRetryAt).not.toBeNull();
    expect(state.project.status).toBe("failed");
  });
});
