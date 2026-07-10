import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApp,
  createMimoFetchMock,
  createMultipartPayload,
  createPrismaMock,
  getObjectMock,
  seedProject,
} from "./local-business-promo-route-test-helpers.js";

describe("local business promo audio narration routes", () => {
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

  it("previews narration with a mimo preset voice and fixed preview text", async () => {
    const prisma = createPrismaMock({ projects: [seedProject()] });
    const fetchFn = createMimoFetchMock();
    const { app } = await createApp({ prisma, fetchFn });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/narration/preview",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.asset.kind).toBe("narration");
    expect(response.json().data.asset.providerModel).toBe("mimo-v2.5-tts");
    expect(response.json().data.asset.textContent).toContain("欢迎来到这里");
    expect(prisma.__state.projects[0]?.activeNarrationAssetId).toBeNull();
    expect(prisma.__state.audioTasks).toHaveLength(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(response.json().data.asset.metadata.presetPreview).toBe(true);

    const repeated = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/narration/preview",
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().data.asset.id).toBe(response.json().data.asset.id);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("previews and generates narration with voicedesign mode", async () => {
    const prisma = createPrismaMock({
      projects: [seedProject({
        settings: {
          ...seedProject().settings,
          voiceMode: "design",
          voiceDesignPrompt: "一位自然亲切、普通话清晰的年轻女性门店顾问",
          voiceStylePrompt: "语速自然可信，像面对面介绍服务",
        },
      })],
    });
    const fetchFn = createMimoFetchMock();
    const { app } = await createApp({ prisma, fetchFn });

    const preview = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/narration/preview",
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.asset.providerModel).toBe("mimo-v2.5-tts-voicedesign");

    const generated = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/narration/generate",
    });
    expect(generated.statusCode).toBe(200);
    expect(generated.json().data.asset.providerModel).toBe("mimo-v2.5-tts-voicedesign");
    expect(generated.json().data.task.inputPayload.voiceMode).toBe("design");
    expect(generated.json().data.task.inputPayload.voiceDesignPrompt).toContain("年轻女性门店顾问");
    await app.close();
  });

  it("rejects narration generation when the script is longer than the selected duration budget", async () => {
    const prisma = createPrismaMock({
      projects: [seedProject({
        settings: {
          ...seedProject().settings,
          durationSec: 25,
        },
        scriptDraft: "这段口播把门店环境服务流程主推产品核心卖点适合人群结果反馈到店理由一次性全部展开，明显已经超过二十五秒版本应该承载的长度，而且还在继续补充价格感受细节口碑评价和转化引导，让整段旁白长到无法塞进短视频里",
      })],
    });
    const fetchFn = createMimoFetchMock();
    const { app } = await createApp({ prisma, fetchFn });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/narration/generate",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("25 秒版本建议控制在");
    expect(fetchFn).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires a sample for clone mode and then uses voiceclone for preview and generation", async () => {
    const prisma = createPrismaMock({
      projects: [seedProject({
        settings: {
          ...seedProject().settings,
          voiceMode: "clone",
          voiceStylePrompt: "贴近样本的语气与节奏",
        },
      })],
    });
    const fetchFn = createMimoFetchMock();
    const { app } = await createApp({ prisma, fetchFn });

    const missingSample = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/narration/preview",
    });
    expect(missingSample.statusCode).toBe(400);
    expect(missingSample.json().error).toContain("请先上传音色复刻样本");

    const upload = createMultipartPayload({
      filename: "sample.wav",
      mime: "audio/wav",
      content: "RIFFfakewavsample",
    });
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/voice-sample",
      headers: { "content-type": upload.contentType },
      payload: upload.payload,
    });
    expect(uploaded.statusCode).toBe(200);

    const preview = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/narration/preview",
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.asset.providerModel).toBe("mimo-v2.5-tts-voiceclone");
    expect(preview.json().data.asset.metadata.voiceStylePrompt).toBeNull();

    const generated = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/narration/generate",
    });
    expect(generated.statusCode).toBe(200);
    expect(generated.json().data.asset.providerModel).toBe("mimo-v2.5-tts-voiceclone");
    expect(generated.json().data.task.inputPayload.voiceMode).toBe("clone");
    expect(generated.json().data.task.inputPayload.voiceStylePrompt).toBeNull();
    expect(generated.json().data.task.inputPayload.sampleAssetId).toBeTruthy();
    await app.close();
  });

  it("loads clone samples from object storage even when the stored public url returns 403", async () => {
    const prisma = createPrismaMock({
      projects: [seedProject({
        settings: {
          ...seedProject().settings,
          voiceMode: "clone",
        },
        voiceCloneSampleAssetId: "audio-seeded-sample",
      })],
      audioAssets: [{
        id: "audio-seeded-sample",
        userId: "u1",
        projectId: "project-seeded",
        requestId: null,
        kind: "voice-sample",
        source: "upload",
        provider: null,
        providerModel: null,
        originalUrl: "http://s3.test/test-bucket/workflow/audio/u1/project-seeded/voice-sample/private-sample.wav",
        objectKey: "workflow/audio/u1/project-seeded/voice-sample/private-sample.wav",
        mime: "audio/wav",
        format: "wav",
        durationSec: 4,
        textContent: null,
        metadata: null,
        createdAt: new Date("2026-07-06T08:15:00.000Z"),
      }],
    });
    const audioBase64 = Buffer.from("fake wav bytes").toString("base64");
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("s3.test")) return new Response("forbidden", { status: 403 });
      return new Response(JSON.stringify({
        choices: [{ message: { audio: { data: audioBase64 } } }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const { app } = await createApp({ prisma, fetchFn });

    const preview = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/narration/preview",
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.asset.providerModel).toBe("mimo-v2.5-tts-voiceclone");

    const generated = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/audio/narration/generate",
    });
    expect(generated.statusCode).toBe(200);
    expect(generated.json().data.asset.providerModel).toBe("mimo-v2.5-tts-voiceclone");
    expect(getObjectMock).toHaveBeenCalledWith(expect.anything(), "workflow/audio/u1/project-seeded/voice-sample/private-sample.wav");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
