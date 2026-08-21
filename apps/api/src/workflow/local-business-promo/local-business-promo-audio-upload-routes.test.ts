import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApp,
  createMultipartPayload,
  createPrismaMock,
  seedProject,
} from "./local-business-promo-route-test-helpers.js";

describe("local business promo audio upload routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MIMO_API_KEY = "test-mimo-key";
    process.env.SESSION_SECRET = "x".repeat(32);
  });

  afterEach(() => {
    delete process.env.MIMO_API_KEY;
    delete process.env.SESSION_SECRET;
  });

  it("uploads voice sample and returns audio state", async () => {
    const prisma = createPrismaMock({ projects: [seedProject()] });
    const { app } = await createApp({ prisma });
    const upload = createMultipartPayload({
      filename: "sample.wav",
      mime: "audio/wav",
      content: "RIFFfakewavsample",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/voice-sample",
      headers: { "content-type": upload.contentType },
      payload: upload.payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.asset.kind).toBe("voice-sample");
    expect(response.json().data.audio.voiceCloneSample.id).toBe(response.json().data.asset.id);
    expect(prisma.__state.projects[0]?.voiceCloneSampleAssetId).toBe(response.json().data.asset.id);
    await app.close();
  });

  it("uploads m4a voice samples and returns audio state", async () => {
    const prisma = createPrismaMock({ projects: [seedProject()] });
    const { app } = await createApp({ prisma });
    const upload = createMultipartPayload({
      filename: "sample.m4a",
      mime: "audio/mp4",
      content: "fake m4a sample",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/voice-sample",
      headers: { "content-type": upload.contentType },
      payload: upload.payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.asset.kind).toBe("voice-sample");
    expect(response.json().data.asset.mime).toBe("audio/mp4");
    expect(response.json().data.audio.voiceCloneSample.id).toBe(response.json().data.asset.id);
    await app.close();
  });

  it("uploads custom bgm and sets it as the active project bgm", async () => {
    const prisma = createPrismaMock({ projects: [seedProject()] });
    const { app } = await createApp({ prisma });
    const upload = createMultipartPayload({
      filename: "custom-bgm.mp3",
      mime: "audio/mpeg",
      content: "ID3fakebgm",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/bgm-upload",
      headers: { "content-type": upload.contentType },
      payload: upload.payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.asset.kind).toBe("bgm");
    expect(response.json().data.asset.source).toBe("upload");
    expect(response.json().data.audio.activeBgm.id).toBe(response.json().data.asset.id);
    expect(prisma.__state.projects[0]?.activeBgmAssetId).toBe(response.json().data.asset.id);
    await app.close();
  });
});
