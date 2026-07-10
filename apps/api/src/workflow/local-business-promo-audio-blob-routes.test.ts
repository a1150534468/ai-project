import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApp,
  createMimoFetchMock,
  createPrismaMock,
  getObjectMock,
  seedProject,
} from "./local-business-promo-route-test-helpers.js";

describe("local business promo audio blob routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MIMO_API_KEY = "test-mimo-key";
    process.env.SESSION_SECRET = "x".repeat(32);
  });

  afterEach(() => {
    delete process.env.MIMO_API_KEY;
    delete process.env.SESSION_SECRET;
  });

  it("serves stored audio through the same-origin blob route", async () => {
    const prisma = createPrismaMock({ projects: [seedProject()] });
    const { app } = await createApp({ prisma });
    const key = "workflow/audio/u1/project-seeded/preview/test-preview.wav";

    const response = await app.inject({
      method: "GET",
      url: `/api/workflow/local-business-promos/projects/project-seeded/audio/blob?key=${encodeURIComponent(key)}&mime=${encodeURIComponent("audio/wav")}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("audio/wav");
    expect(response.body).toBe(`blob:${key}`);
    expect(getObjectMock).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("serves signed blob urls for preset narration preview without auth headers", async () => {
    const prisma = createPrismaMock({ projects: [seedProject()] });
    const fetchFn = createMimoFetchMock();
    const { app: authedApp } = await createApp({ prisma, fetchFn });

    const preview = await authedApp.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/narration/preview",
    });
    expect(preview.statusCode).toBe(200);
    const signedUrl = new URL(preview.json().data.asset.originalUrl as string, "http://localhost");
    expect(signedUrl.searchParams.get("sig")).toBeTruthy();
    await authedApp.close();

    const { app: anonymousApp } = await createApp({ prisma, userId: "" });
    const response = await anonymousApp.inject({
      method: "GET",
      url: `${signedUrl.pathname}${signedUrl.search}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("audio/wav");
    expect(response.body).toContain("preset-narration-preview");
    await anonymousApp.close();
  });
});
