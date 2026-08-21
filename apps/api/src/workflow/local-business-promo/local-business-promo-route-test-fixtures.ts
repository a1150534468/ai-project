import { vi } from "vitest";

export function seedProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-seeded",
    userId: "u1",
    title: "本地商家宣传项目",
    brief: {
      storeName: "禾木咖啡",
      industry: "精品咖啡",
      cityArea: "上海静安",
      targetCustomers: "周边上班族",
      mainOffer: "手冲与招牌拿铁",
      sellingPoints: "出品稳定、环境舒服、适合社交会面",
    },
    materials: {
      opening: [{ url: "https://example.test/opening.mp4", mime: "video/mp4", name: "门头", durationSec: 8, objectKey: "workflow/video-materials/u1/opening.mp4" }],
      process: [{ url: "https://example.test/process.mp4", mime: "video/mp4", name: "制作过程", durationSec: 8, objectKey: "workflow/video-materials/u1/process.mp4" }],
      environment: [{ url: "https://example.test/environment.png", mime: "image/png", name: "环境", durationSec: 0, objectKey: "workflow/video-materials/u1/environment.png" }],
      result: [{ url: "https://example.test/result.mp4", mime: "video/mp4", name: "成品", durationSec: 8, objectKey: "workflow/video-materials/u1/result.mp4" }],
    },
    settings: {
      direction: "store-trust",
      durationSec: 40,
      aspectRatio: "9:16",
      subtitleStyle: "douyin-outline",
      narrationVoice: "vv-female-natural",
      voiceMode: "preset",
      voiceDesignPrompt: "",
      voiceStylePrompt: "语速自然可信，像面对面介绍服务",
      musicPreset: "premium-clean",
    },
    scriptDraft: "第一行\n第二行\n第三行\n第四行",
    latestRunId: null,
    voiceCloneSampleAssetId: null,
    activeNarrationAssetId: null,
    activeBgmAssetId: null,
    status: "draft",
    createdAt: new Date("2026-07-06T08:00:00.000Z"),
    updatedAt: new Date("2026-07-06T08:00:00.000Z"),
    ...overrides,
  };
}

export function createBillingMock() {
  return {
    reserve: vi.fn(async () => ({ reserved: 1 })),
    settle: vi.fn(async () => ({ settled: 1 })),
    chargeResource: vi.fn(async () => ({ charged: 1 })),
    refundResource: vi.fn(async () => ({ success: true })),
  };
}

export function createEmptyMaterials() {
  return {
    opening: [],
    process: [],
    environment: [],
    result: [],
  };
}
