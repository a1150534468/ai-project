import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApp,
  createMimoFetchMock,
  createPrismaMock,
  seedProject,
} from "./local-business-promo-route-test-helpers.js";

describe("local business promo audio state routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MIMO_API_KEY = "test-mimo-key";
    process.env.SESSION_SECRET = "x".repeat(32);
  });

  afterEach(() => {
    delete process.env.MIMO_API_KEY;
    delete process.env.SESSION_SECRET;
  });

  it("generates narration and bgm, supports history switching, and clears bgm for no-bgm", async () => {
    const prisma = createPrismaMock({ projects: [seedProject()] });
    const fetchFn = createMimoFetchMock();
    const { app } = await createApp({ prisma, fetchFn });

    const narration1 = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/narration/generate",
    });
    expect(narration1.statusCode).toBe(200);
    const narrationAssetId1 = narration1.json().data.asset.id as string;
    expect(narration1.json().data.asset.providerModel).toBe("mimo-v2.5-tts");
    expect(narration1.json().data.audio.activeNarration.id).toBe(narrationAssetId1);

    const updateScript = await app.inject({
      method: "PATCH",
      url: "/api/workflow/local-business-promos/projects/project-seeded/script",
      payload: { scriptDraft: "新版本第一行\n新版本第二行\n新版本第三行\n新版本第四行" },
    });
    expect(updateScript.statusCode).toBe(200);

    const narration2 = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/narration/generate",
    });
    expect(narration2.statusCode).toBe(200);
    const narrationAssetId2 = narration2.json().data.asset.id as string;
    expect(narrationAssetId2).not.toBe(narrationAssetId1);
    expect(narration2.json().data.audio.narrationHistory).toHaveLength(2);

    const bgmPreview = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/bgm/preview",
    });
    expect(bgmPreview.statusCode).toBe(200);
    expect(bgmPreview.json().data.asset.kind).toBe("bgm");
    expect(prisma.__state.projects[0]?.activeBgmAssetId).toBeNull();

    const bgmGenerate = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/bgm/generate",
    });
    expect(bgmGenerate.statusCode).toBe(200);
    const bgmAssetId = bgmGenerate.json().data.asset.id as string;
    expect(bgmGenerate.json().data.audio.activeBgm.id).toBe(bgmAssetId);

    const switchNarration = await app.inject({
      method: "PATCH",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/active",
      payload: { narrationAssetId: narrationAssetId1 },
    });
    expect(switchNarration.statusCode).toBe(200);
    expect(switchNarration.json().data.audio.activeNarration.id).toBe(narrationAssetId1);

    const switchBgm = await app.inject({
      method: "PATCH",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/active",
      payload: { bgmAssetId },
    });
    expect(switchBgm.statusCode).toBe(200);
    expect(switchBgm.json().data.audio.activeBgm.id).toBe(bgmAssetId);

    const noBgmProject = await app.inject({
      method: "PATCH",
      url: "/api/workflow/local-business-promos/projects/project-seeded",
      payload: { settings: { musicPreset: "no-bgm" } },
    });
    expect(noBgmProject.statusCode).toBe(200);

    const clearBgm = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/bgm/generate",
    });
    expect(clearBgm.statusCode).toBe(200);
    expect(clearBgm.json().data.asset).toBeNull();
    expect(clearBgm.json().data.audio.activeBgm).toBeNull();

    const audioState = await app.inject({
      method: "GET",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/state",
    });
    expect(audioState.statusCode).toBe(200);
    expect(audioState.json().data.narrationHistory).toHaveLength(2);
    expect(audioState.json().data.bgmHistory).toHaveLength(1);
    expect(audioState.json().data.tasks.length).toBeGreaterThanOrEqual(3);

    const state = await app.inject({
      method: "GET",
      url: "/api/workflow/local-business-promos/projects/project-seeded/state",
    });
    expect(state.statusCode).toBe(200);
    expect(state.json().data.audio.narrationHistory).toHaveLength(2);
    expect(state.json().data.audio.activeNarration.originalUrl).toContain("/api/workflow/local-business-promos/projects/project-seeded/audio/blob?");
    await app.close();
  });
});
