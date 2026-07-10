import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApp,
  createPrismaMock,
  seedProject,
} from "./local-business-promo-route-test-helpers.js";

describe("local business promo project routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MIMO_API_KEY = "test-mimo-key";
    process.env.SESSION_SECRET = "x".repeat(32);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.MIMO_API_KEY;
    delete process.env.SESSION_SECRET;
  });

  it("covers options and project CRUD", async () => {
    const prisma = createPrismaMock();
    const { app } = await createApp({ prisma });

    const options = await app.inject({ method: "GET", url: "/api/workflow/local-business-promos/options" });
    expect(options.statusCode).toBe(200);
    expect(options.json().data.voiceModes.map((item: { value: string }) => item.value)).toEqual(["preset", "design", "clone"]);
    expect(options.json().data.voiceTemplates.map((item: { value: string }) => item.value)).toEqual(["local-business-guide"]);
    expect(options.json().data.narrationVoices.length).toBeGreaterThan(0);
    expect(options.json().data.musicPresets.length).toBeGreaterThan(0);

    const created = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects",
      payload: { title: "咖啡店七月宣传" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.project.title).toBe("咖啡店七月宣传");

    const listed = await app.inject({ method: "GET", url: "/api/workflow/local-business-promos/projects" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data[0].materialCount).toBe(0);

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/workflow/local-business-promos/projects/project-1",
      payload: {
        brief: { storeName: "咖啡晨光", industry: "咖啡", cityArea: "杭州西湖", targetCustomers: "游客", mainOffer: "招牌冰滴", sellingPoints: "景观好" },
        settings: { durationSec: 60, musicPreset: "city-lively" },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data.project.brief.storeName).toBe("咖啡晨光");
    expect(updated.json().data.project.settings.durationSec).toBe(60);

    const detail = await app.inject({ method: "GET", url: "/api/workflow/local-business-promos/projects/project-1" });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.project.brief.cityArea).toBe("杭州西湖");
    await app.close();
  });

  it("generates script and saves manual script edits", async () => {
    const prisma = createPrismaMock({ projects: [seedProject({ brief: { ...seedProject().brief, sellingPoints: "精品豆、稳定出品" } })] });
    const generateScript = vi.fn(async () => "开场文案\n环境文案\n过程文案\n结果文案");
    const { app } = await createApp({ prisma, generateScript });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/script/generate",
    });
    expect(response.statusCode).toBe(200);
    expect(generateScript).toHaveBeenCalledTimes(1);
    expect(response.json().data.project.scriptDraft).toContain("环境文案");

    const saved = await app.inject({
      method: "PATCH",
      url: "/api/workflow/local-business-promos/projects/project-seeded/script",
      payload: { scriptDraft: "人工改稿一\n人工改稿二" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data.project.scriptDraft).toContain("人工改稿");
    await app.close();
  });

  it("heals stale generating projects without runs when reading project state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T08:10:00.000Z"));
    const prisma = createPrismaMock({
      projects: [seedProject({
        status: "generating",
        latestRunId: null,
        updatedAt: new Date("2026-07-06T08:00:00.000Z"),
      })],
    });
    const { app } = await createApp({ prisma });

    const listed = await app.inject({ method: "GET", url: "/api/workflow/local-business-promos/projects" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data[0].status).toBe("draft");

    const detail = await app.inject({ method: "GET", url: "/api/workflow/local-business-promos/projects/project-seeded" });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.project.status).toBe("draft");
    expect(detail.json().data.project.latestRunId).toBeNull();

    await app.close();
  });

  it("rejects unsafe material sources on project save", async () => {
    const prisma = createPrismaMock({ projects: [seedProject()] });
    const { app } = await createApp({ prisma });

    const ssrfAttempt = await app.inject({
      method: "PATCH",
      url: "/api/workflow/local-business-promos/projects/project-seeded",
      payload: {
        materials: {
          opening: [{ url: "http://169.254.169.254/latest/meta-data", mime: "image/png", name: "bad", durationSec: 0 }],
          process: [],
          environment: [],
          result: [],
        },
      },
    });
    expect(ssrfAttempt.statusCode).toBe(400);
    expect(ssrfAttempt.json().error).toContain("仅支持使用当前账号上传的图片或视频素材");

    const crossUserAttempt = await app.inject({
      method: "PATCH",
      url: "/api/workflow/local-business-promos/projects/project-seeded",
      payload: {
        materials: {
          opening: [{
            url: "https://example.test/other-user.png",
            mime: "image/png",
            name: "bad",
            durationSec: 0,
            objectKey: "workflow/video-materials/u2/other-user.png",
          }],
          process: [],
          environment: [],
          result: [],
        },
      },
    });
    expect(crossUserAttempt.statusCode).toBe(400);
    expect(crossUserAttempt.json().error).toContain("素材不存在或已失效");

    await app.close();
  });
});
