import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApp,
  createBillingMock,
  createEmptyMaterials,
  createPrismaMock,
  seedProject,
} from "./local-business-promo-route-test-helpers.js";

describe("local business promo run routes", () => {
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

  it("creates a queued run, charges render seconds, and enqueues the worker job", async () => {
    const project = seedProject();
    const prisma = createPrismaMock({ projects: [project] });
    const billing = createBillingMock();
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp({ prisma, billing, enqueueRun });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/generate",
    });
    expect(response.statusCode).toBe(202);
    expect(billing.chargeResource).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1",
      resourceKey: "local_business_promo_render_40s",
      units: 1,
      accountType: "video",
    }));
    const chargedCalls = billing.chargeResource.mock.calls as unknown as Array<[{ operationId?: string }]>;
    const chargedOperation = chargedCalls[0]?.[0];
    expect(prisma.__state.runs[0]?.billingOperationId).toBe(chargedOperation?.operationId);
    expect(prisma.__state.runs[0]?.billingRefundedAt).toBeNull();
    expect(enqueueRun).toHaveBeenCalledWith({ runId: "run-1" });
    expect(response.json().data.run.progressStage).toBe("queued");
    expect(response.json().data.run.progressPercent).toBe(0);
    expect(response.json().data.run).not.toHaveProperty("clipRequestIds");
    expect(response.json().data.run).not.toHaveProperty("clipTasks");

    const state = await app.inject({
      method: "GET",
      url: "/api/workflow/local-business-promos/projects/project-seeded/state",
    });
    expect(state.statusCode).toBe(200);
    expect(state.json().data.project.status).toBe("generating");
    expect(state.json().data.latestRun.status).toBe("queued");
    expect(state.json().data.latestRun.progressStage).toBe("queued");
    expect(state.json().data.latestRun).not.toHaveProperty("clipRequestIds");
    expect(state.json().data.latestRun).not.toHaveProperty("clipTasks");
    expect(state.json().data.latestRun.shotPlan).toHaveLength(4);
    expect(state.json().data.audio.activeNarration).toBeNull();
    expect(state.json().data.audio.activeBgm).toBeNull();

    const history = await app.inject({
      method: "GET",
      url: "/api/workflow/local-business-promos/projects/project-seeded/runs",
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().data.runs).toHaveLength(1);
    await app.close();
  });

  it("refunds and marks the run failed when enqueue fails", async () => {
    const prisma = createPrismaMock({ projects: [seedProject()] });
    const billing = createBillingMock();
    const enqueueRun = vi.fn(async () => {
      throw new Error("queue unavailable");
    });
    const { app } = await createApp({ prisma, billing, enqueueRun });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/generate",
    });
    expect(response.statusCode).toBe(500);
    expect(billing.refundResource).toHaveBeenCalledTimes(1);
    expect(billing.refundResource).toHaveBeenCalledWith(prisma.__state.runs[0]?.billingOperationId);
    expect(prisma.__state.runs[0]?.billingRefundedAt).not.toBeNull();

    const state = await app.inject({
      method: "GET",
      url: "/api/workflow/local-business-promos/projects/project-seeded/state",
    });
    expect(state.statusCode).toBe(200);
    expect(state.json().data.project.status).toBe("draft");
    expect(state.json().data.latestRun).toBeNull();
    expect(state.json().data.runs[0].status).toBe("failed");
    expect(state.json().data.runs[0].progressStage).toBe("failed");
    expect(state.json().data.runs[0].error).toContain("queue unavailable");
    await app.close();
  });

  it("does not charge when the run record cannot be created", async () => {
    const prisma = createPrismaMock({ projects: [seedProject()] });
    prisma.localBusinessPromoRun.create.mockRejectedValueOnce(new Error("run insert failed"));
    const billing = createBillingMock();
    const { app } = await createApp({ prisma, billing });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/generate",
    });

    expect(response.statusCode).toBe(500);
    expect(billing.chargeResource).not.toHaveBeenCalled();
    expect(prisma.__state.runs).toHaveLength(0);
    await app.close();
  });

  it("keeps a pending refund record when startup fails after charge and refund also fails", async () => {
    const prisma = createPrismaMock({ projects: [seedProject()] });
    prisma.localBusinessPromoProject.update.mockRejectedValueOnce(new Error("project update failed"));
    const billing = createBillingMock();
    billing.refundResource.mockRejectedValueOnce(new Error("refund unavailable"));
    const { app } = await createApp({ prisma, billing });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/generate",
    });

    expect(response.statusCode).toBe(500);
    expect(billing.chargeResource).toHaveBeenCalledTimes(1);
    expect(billing.refundResource).toHaveBeenCalledWith(prisma.__state.runs[0]?.billingOperationId);
    expect(prisma.__state.runs[0]?.status).toBe("failed");
    expect(prisma.__state.runs[0]?.billingRefundedAt).toBeNull();
    expect(prisma.__state.runs[0]?.billingRefundStatus).toBe("pending");
    expect(prisma.__state.runs[0]?.billingRefundError).toContain("refund unavailable");
    expect(prisma.__state.runs[0]?.billingRefundRetryCount).toBe(1);
    expect(prisma.__state.runs[0]?.billingRefundNextRetryAt).not.toBeNull();
    await app.close();
  });

  it("rejects a second concurrent generate request before it can charge twice", async () => {
    let chargeCalls = 0;
    let releaseFirstCharge: () => void = () => {};
    let firstChargeStarted: () => void = () => {};
    const firstChargePending = new Promise<void>((resolve) => {
      firstChargeStarted = () => resolve();
    });
    const firstChargeReleased = new Promise<void>((resolve) => {
      releaseFirstCharge = () => resolve();
    });
    const prisma = createPrismaMock({ projects: [seedProject()] });
    const billing = createBillingMock();
    billing.chargeResource.mockImplementation(async () => {
      chargeCalls += 1;
      if (chargeCalls === 1) {
        firstChargeStarted?.();
        await firstChargeReleased;
      }
      return { charged: 1 };
    });
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp({ prisma, billing, enqueueRun });

    const firstRequest = app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/generate",
    });
    await firstChargePending;

    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/generate",
    });

    expect(secondResponse.statusCode).toBe(409);
    expect(secondResponse.json().error).toContain("已有生成任务进行中");
    expect(billing.chargeResource).toHaveBeenCalledTimes(1);
    expect(prisma.__state.runs).toHaveLength(1);
    expect(prisma.__state.runs[0]?.billingOperationId).toContain("local-business-promo-render:project-seeded:");

    releaseFirstCharge();
    const firstResponse = await firstRequest;
    expect(firstResponse.statusCode).toBe(202);
    expect(prisma.__state.runs).toHaveLength(1);
    expect(enqueueRun).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("rejects unauthenticated access and invalid generate preconditions", async () => {
    const missingProject = seedProject({ brief: { ...seedProject().brief, targetCustomers: "" }, materials: createEmptyMaterials(), scriptDraft: "" });
    const prisma = createPrismaMock({ projects: [missingProject] });
    const { app } = await createApp({ prisma });
    const unauthorized = await createApp({ userId: "" });

    expect((await unauthorized.app.inject({ method: "GET", url: "/api/workflow/local-business-promos/projects" })).statusCode).toBe(401);

    const badGenerate = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/generate",
    });
    expect(badGenerate.statusCode).toBe(400);
    expect(badGenerate.json().error).toContain("请先完善资料");

    await unauthorized.app.close();
    await app.close();
  });

  it("rejects generate when the project is already marked as generating", async () => {
    const prisma = createPrismaMock({
      projects: [seedProject({ status: "generating", latestRunId: "run-active-1" })],
      runs: [{
        id: "run-active-1",
        projectId: "project-seeded",
        userId: "u1",
        billingOperationId: "local-business-promo-render:project-seeded:active",
        billingRefundedAt: null,
        billingRefundStatus: "none",
        billingRefundError: null,
        billingRefundRetryCount: 0,
        billingRefundLastAttemptAt: null,
        billingRefundNextRetryAt: null,
        settingsSnapshot: seedProject().settings,
        scriptSnapshot: seedProject().scriptDraft,
        shotPlan: [],
        analysisSnapshot: null,
        clipRequestIds: [],
        mergedAssetId: null,
        narrationAssetId: null,
        bgmAssetId: null,
        status: "queued",
        progressPercent: 0,
        progressStage: "queued",
        progressMessage: "任务已入队，等待 worker 处理",
        error: null,
        startedAt: null,
        workerId: null,
        createdAt: new Date("2026-07-06T08:05:00.000Z"),
        updatedAt: new Date("2026-07-06T08:05:00.000Z"),
        completedAt: null,
      }],
    });
    const billing = createBillingMock();
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp({ prisma, billing, enqueueRun });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/generate",
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("已有生成任务进行中");
    expect(billing.chargeResource).not.toHaveBeenCalled();
    expect(enqueueRun).not.toHaveBeenCalled();
    await app.close();
  });

  it("recovers a stale generating project with no run and allows restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T08:10:00.000Z"));
    const prisma = createPrismaMock({
      projects: [seedProject({
        status: "generating",
        latestRunId: null,
        updatedAt: new Date("2026-07-06T08:00:00.000Z"),
      })],
    });
    const billing = createBillingMock();
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp({ prisma, billing, enqueueRun });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/generate",
    });

    expect(response.statusCode).toBe(202);
    expect(prisma.__state.projects[0]?.status).toBe("generating");
    expect(prisma.__state.projects[0]?.latestRunId).toBe("run-1");
    expect(billing.chargeResource).toHaveBeenCalledTimes(1);
    expect(enqueueRun).toHaveBeenCalledWith({ runId: "run-1" });
    await app.close();
  });

  it("heals stale generating state with no run when loading project state", async () => {
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

    const response = await app.inject({
      method: "GET",
      url: "/api/workflow/local-business-promos/projects/project-seeded/state",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.project.status).toBe("draft");
    expect(response.json().data.project.latestRunId).toBeNull();
    expect(response.json().data.latestRun).toBeNull();
    await app.close();
  });

  it("keeps a fresh generating project without run blocked during the startup grace window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T08:10:00.000Z"));
    const prisma = createPrismaMock({
      projects: [seedProject({
        status: "generating",
        latestRunId: null,
        updatedAt: new Date("2026-07-06T08:09:50.000Z"),
      })],
    });
    const billing = createBillingMock();
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp({ prisma, billing, enqueueRun });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/generate",
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("已有生成任务进行中");
    expect(billing.chargeResource).not.toHaveBeenCalled();
    expect(enqueueRun).not.toHaveBeenCalled();
    await app.close();
  });

  it("allows a run when the active narration only exceeds the selected duration by a small buffer", async () => {
    const prisma = createPrismaMock({
      projects: [seedProject({
        settings: {
          ...seedProject().settings,
          durationSec: 25,
        },
        activeNarrationAssetId: "audio-narration-1",
      })],
      audioAssets: [{
        id: "audio-narration-1",
        userId: "u1",
        projectId: "project-seeded",
        requestId: "req-1",
        kind: "narration",
        source: "mimo-tts",
        provider: "mimo",
        providerModel: "mimo-v2.5-tts",
        originalUrl: "https://example.test/narration.wav",
        objectKey: "workflow/audio/u1/project-seeded/narration/near-limit.wav",
        mime: "audio/wav",
        format: "wav",
        durationSec: 27.4,
        textContent: "略长但仍可顺延的口播",
        metadata: null,
        createdAt: new Date("2026-07-06T08:15:00.000Z"),
      }],
    });
    const billing = createBillingMock();
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp({ prisma, billing, enqueueRun });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/generate",
    });

    expect(response.statusCode).toBe(202);
    expect(billing.chargeResource).toHaveBeenCalledTimes(1);
    expect(enqueueRun).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("rejects starting a run when the active narration exceeds the allowed duration buffer", async () => {
    const prisma = createPrismaMock({
      projects: [seedProject({
        settings: {
          ...seedProject().settings,
          durationSec: 25,
        },
        activeNarrationAssetId: "audio-narration-1",
      })],
      audioAssets: [{
        id: "audio-narration-1",
        userId: "u1",
        projectId: "project-seeded",
        requestId: "req-1",
        kind: "narration",
        source: "mimo-tts",
        provider: "mimo",
        providerModel: "mimo-v2.5-tts",
        originalUrl: "https://example.test/narration.wav",
        objectKey: "workflow/audio/u1/project-seeded/narration/long.wav",
        mime: "audio/wav",
        format: "wav",
        durationSec: 33,
        textContent: "超长口播",
        metadata: null,
        createdAt: new Date("2026-07-06T08:15:00.000Z"),
      }],
    });
    const billing = createBillingMock();
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp({ prisma, billing, enqueueRun });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/generate",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("当前正式口播约 33 秒");
    expect(response.json().error).toContain("最多约 28 秒");
    expect(billing.chargeResource).not.toHaveBeenCalled();
    expect(enqueueRun).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects persisted projects that reference unsafe or foreign materials", async () => {
    const prisma = createPrismaMock({
      projects: [seedProject({
        materials: {
          opening: [{
            url: "https://example.test/other-user.mp4",
            mime: "video/mp4",
            name: "门头",
            durationSec: 8,
            objectKey: "workflow/video-materials/u2/other-user.mp4",
          }],
          process: [],
          environment: [],
          result: [],
        },
      })],
    });
    const billing = createBillingMock();
    const enqueueRun = vi.fn(async () => undefined);
    const { app } = await createApp({ prisma, billing, enqueueRun });

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/local-business-promos/projects/project-seeded/generate",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("素材不存在或已失效");
    expect(billing.chargeResource).not.toHaveBeenCalled();
    expect(enqueueRun).not.toHaveBeenCalled();
    await app.close();
  });
});
