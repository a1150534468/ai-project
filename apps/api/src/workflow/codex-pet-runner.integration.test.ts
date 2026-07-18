import { randomUUID } from "node:crypto";
import { Prisma, type CodexPetArtifact } from "@prisma/client";
import { getPrisma } from "@ai-assistant/db";
import { inspectCodexPetZip, LOOK_DIRECTIONS } from "@ai-assistant/codex-pet-pipeline";
import sharp from "sharp";
import { afterAll, describe, expect, it, vi } from "vitest";
import { archiveCodexPetRun } from "./codex-pet-archive.js";
import { appendCodexPetEvent } from "./codex-pet-events.js";
import { ImageGenerationUpstreamError } from "./image-service.js";
import { executeCodexPetRun, type CodexPetArtifactStore } from "./codex-pet-runner.js";
import type { GeneratedPetVisual, PetVisualQaConsensus, PetVisualQaVerdict } from "./codex-pet-visual.js";

const prisma = getPrisma();
const enabled = Boolean(process.env.DATABASE_URL);
const cleanupUserIds: string[] = [];

const passedVerdict: PetVisualQaVerdict = {
  pass: true,
  score: 96,
  mirrorSafe: true,
  identity: true,
  structure: true,
  semantics: true,
  continuity: true,
  warnings: [],
  failures: [],
  repairPrompt: "",
};

const passedConsensus: PetVisualQaConsensus = {
  pass: true,
  score: 96,
  mirrorSafe: true,
  verdicts: [passedVerdict],
  warnings: [],
  failures: [],
};

async function syntheticVisual(prompt: string): Promise<GeneratedPetVisual> {
  const isBase = prompt.includes("main character candidate");
  const width = isBase ? 1024 : 1536;
  const height = 1024;
  const chromaMatch = /flat\s+(#[0-9a-f]{6})\s+background|exactly\s+(#[0-9a-f]{6})/i.exec(prompt);
  const chromaKey = chromaMatch?.[1] ?? chromaMatch?.[2] ?? "#ff00ff";
  let buffer: Buffer;
  if (isBase) {
    buffer = await sharp({ create: { width, height, channels: 4, background: chromaKey } })
      .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect x="350" y="190" width="324" height="720" rx="120" fill="#2459c7"/><circle cx="455" cy="430" r="28" fill="#fff"/><circle cx="569" cy="430" r="28" fill="#fff"/></svg>`) }])
      .png().toBuffer();
  } else {
    const frameCount = Number(/exactly (\d+) separated/i.exec(prompt)?.[1]
      ?? (/exactly four separated/i.test(prompt) ? 4 : 8));
    const columns = /2×2|2 columns/i.test(prompt) ? 2 : /3 columns/i.test(prompt) ? 3 : 4;
    const rows = 2;
    const slotWidth = width / columns;
    const slotHeight = height / rows;
    const overlays = Array.from({ length: frameCount }, (_, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const bodyWidth = Math.round(slotWidth * 0.34);
      const bodyHeight = Math.round(slotHeight * 0.62);
      const x = Math.round(column * slotWidth + (slotWidth - bodyWidth) / 2);
      const y = Math.round(row * slotHeight + slotHeight - 56 - bodyHeight);
      return { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${x}" y="${y}" width="${bodyWidth}" height="${bodyHeight}" rx="${Math.round(bodyWidth * 0.25)}" fill="#2459c7"/><circle cx="${x + Math.round(bodyWidth * 0.38)}" cy="${y + Math.round(bodyHeight * 0.3)}" r="10" fill="#fff"/><circle cx="${x + Math.round(bodyWidth * 0.62)}" cy="${y + Math.round(bodyHeight * 0.3)}" r="10" fill="#fff"/></svg>`) };
    });
    buffer = await sharp({ create: { width, height, channels: 4, background: chromaKey } }).composite(overlays).png().toBuffer();
  }
  return {
    buffer,
    mime: "image/png",
    provider: {
      image: { kind: "b64", b64: buffer.toString("base64"), mime: "image/png" },
      upstreamRequestId: "req-synthetic-visual",
      requestedModel: "gpt-image-2",
      actualModel: "gpt-image-2-codex",
      requestedSize: `${width}x${height}`,
      actualSize: `${width}x${height}`,
      requestedQuality: "low",
      actualQuality: "auto",
      usage: { inputTokens: 20, imageInputTokens: 10, textInputTokens: 10, outputTokens: 30, imageOutputTokens: 30, totalTokens: 50 },
    },
  };
}

function memoryArtifactStore(): CodexPetArtifactStore & { buffers: Map<string, Buffer> } {
  const buffers = new Map<string, Buffer>();
  return {
    buffers,
    async put(input) {
      const id = randomUUID();
      const objectKey = `workflow/codex-pets/${input.userId}/${input.projectId}/${input.runId}/${id}`;
      buffers.set(objectKey, input.buffer);
      return prisma.codexPetArtifact.create({ data: {
        id,
        userId: input.userId,
        projectId: input.projectId,
        runId: input.runId,
        jobId: input.jobId,
        kind: input.kind,
        name: input.name,
        objectKey,
        mime: input.mime,
        sizeBytes: input.buffer.byteLength,
        width: input.width,
        height: input.height,
        checksum: "test",
        metadata: (input.metadata ?? {}) as Prisma.InputJsonObject,
        expiresAt: input.expiresAt,
      } });
    },
    async load(artifact: Pick<CodexPetArtifact, "objectKey">) {
      const value = buffers.get(artifact.objectKey);
      if (!value) throw new Error("test artifact missing");
      return value;
    },
  };
}

async function seed(autoContinue: boolean, options: {
  readonly referenceCount?: number;
  readonly stylePreset?: string;
  readonly prompt?: string;
} = {}) {
  const suffix = randomUUID();
  const user = await prisma.user.create({ data: { uid: `pet-${suffix}`, username: `pet-${suffix}`, passwordHash: "test" } });
  cleanupUserIds.push(user.id);
  const referenceAssetIds = await Promise.all(Array.from({ length: options.referenceCount ?? 0 }, async (_, index) => {
    const asset = await prisma.imageAsset.create({ data: {
      userId: user.id,
      requestId: `pet-ref-${suffix}`,
      requestIndex: index,
      prompt: "codex pet integration reference",
      model: "reference_upload",
      size: "256x256",
      originalUrl: `/api/workflow/images/references/pet-ref-${suffix}-${index}`,
      thumbnailUrl: `/api/workflow/images/references/pet-ref-${suffix}-${index}`,
      objectKey: `workflow/images/${user.id}/pet-ref-${suffix}/${index}.png`,
      mime: "image/png",
    } });
    return asset.id;
  }));
  const project = await prisma.codexPetProject.create({ data: {
    userId: user.id,
    name: "蓝色测试宠",
    description: "端到端测试桌宠",
    prompt: options.prompt ?? "蓝色圆角机器人",
    stylePreset: options.stylePreset ?? "pixel",
    referenceAssetIds,
    autoContinue,
    status: "queued",
  } });
  const run = await prisma.codexPetRun.create({ data: {
    projectId: project.id,
    userId: user.id,
    idempotencyKey: `run-${suffix}`,
    inputSnapshot: {
      name: project.name,
      description: project.description,
      prompt: project.prompt,
      stylePreset: project.stylePreset,
      referenceAssetIds,
    },
    autoContinue,
    billingOperationId: `codex-pet:test-${suffix}`,
    billingPoints: 200,
    billingChargeStatus: "charged",
    billingChargeAttemptCount: 1,
    billingChargedAt: new Date(),
    billingActivatedAt: new Date(),
    startedAt: new Date(),
    status: "queued",
  } });
  await prisma.codexPetProject.update({ where: { id: project.id }, data: { latestRunId: run.id } });
  return { user, project, run, referenceAssetIds };
}

function runnerDeps(store: ReturnType<typeof memoryArtifactStore>, consensus = vi.fn(async () => passedConsensus)) {
  return {
    prisma,
    artifacts: store,
    appendEvent: (input: Parameters<typeof appendCodexPetEvent>[0]) => appendCodexPetEvent({ ...input, redis: { publish: vi.fn(async () => 1) } }),
    loadReferenceAsset: vi.fn(async (asset: { readonly id: string; readonly mime: string }) => ({
      buffer: await sharp({ create: { width: 256, height: 256, channels: 4, background: "#ffb020" } })
        .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect x="52" y="28" width="152" height="204" rx="56" fill="#2459c7"/><circle cx="104" cy="104" r="12" fill="#fff"/><circle cx="152" cy="104" r="12" fill="#fff"/><path d="M182 82 L228 58 L214 124 Z" fill="#101828"/></svg>`) }])
        .png()
        .toBuffer(),
      mime: asset.mime,
    })),
    archiveRun: archiveCodexPetRun,
    billing: { refundResource: vi.fn(async () => ({ success: true })) },
    visual: {
      generate: vi.fn(async ({ prompt }: { prompt: string }) => syntheticVisual(prompt)) as never,
      qa: vi.fn(async () => passedVerdict),
      qaConsensus: consensus as never,
      blindQa: vi.fn(async () => ({ ok: true, reviewers: [], consensus: [], failures: [], warnings: [] })),
      directionSemantics: vi.fn(async () => LOOK_DIRECTIONS.map((direction) => ({ direction, verdict: "pass" as const, expected: direction, observed: direction, horizontalEvidence: "ok", verticalEvidence: "ok", reason: "continuous" }))),
      lookMechanics: vi.fn(async () => "下半身固定，眼睛先引导，头部与天线平滑跟随，四个基准方向明确。"),
    },
  };
}

describe.skipIf(!enabled)("Codex pet runner database integration", () => {
  it("runs all visual groups, packages v2 and archives before ready", async () => {
    const seeded = await seed(true);
    const store = memoryArtifactStore();
    let idleFailed = false;
    let mirroredLeftFailed = false;
    const consensus = vi.fn(async (input: { prompt: string }) => {
      if (!idleFailed && input.prompt.includes("idle")) {
        idleFailed = true;
        return { ...passedConsensus, pass: false, score: 30, failures: ["idle motion is static"], verdicts: [{ ...passedVerdict, pass: false, repairPrompt: "make all six idle frames visibly vary" }] };
      }
      if (!mirroredLeftFailed && input.prompt.includes("running-left must face/travel left")) {
        mirroredLeftFailed = true;
        return { ...passedConsensus, pass: false, score: 20, failures: ["asymmetric prop changed handedness"], verdicts: [{ ...passedVerdict, pass: false, repairPrompt: "generate the full left-facing group without mirroring" }] };
      }
      return passedConsensus;
    });
    const deps = runnerDeps(store, consensus);
    const persistEvent = deps.appendEvent;
    deps.appendEvent = vi.fn(async (input) => {
      if (input.type === "run.completed") throw new Error("event store unavailable after ready commit");
      return persistEvent(input);
    });
    const result = await executeCodexPetRun({ runId: seeded.run.id, deps });
    expect(result.status).toBe("ready");
    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(run.progressPercent).toBe(100);
    expect(run.knowledgeDocumentId).toBeTruthy();
    expect(run.actualModels).toEqual(["gpt-image-2-codex"]);
    expect((run.usage as { totalTokens: number }).totalTokens).toBeGreaterThan(0);
    const providerArtifact = await prisma.codexPetArtifact.findFirstOrThrow({
      where: { runId: run.id, kind: { in: ["base_candidate", "pose_board"] } },
      orderBy: { createdAt: "asc" },
    });
    expect(providerArtifact.metadata).toMatchObject({
      upstreamRequestId: "req-synthetic-visual",
      requestedModel: "gpt-image-2",
      actualModel: "gpt-image-2-codex",
      requestedQuality: "low",
      actualQuality: "auto",
      usage: expect.objectContaining({ totalTokens: 50 }),
    });
    const report = run.validationReport as {
      directionContinuity?: { pairs?: unknown[]; semanticAssessment?: string };
      directionRegistration?: { ok?: boolean; sharedScale?: number; sourceBoardSizes?: unknown[] };
    };
    expect(report.directionContinuity?.pairs).toHaveLength(16);
    expect(report.directionContinuity?.semanticAssessment).toBe("not-assessed");
    expect(report.directionRegistration).toMatchObject({ ok: true });
    expect(report.directionRegistration?.sharedScale).toBeGreaterThan(0);
    expect(report.directionRegistration?.sourceBoardSizes).toHaveLength(2);
    expect(await prisma.codexPetArtifact.count({ where: { runId: run.id, kind: "animation_preview", status: "ready" } })).toBe(11);
    expect(await prisma.codexPetArtifact.count({ where: { runId: run.id, kind: "animation_preview" } })).toBe(12);
    const rejectedMirror = await prisma.codexPetArtifact.findFirstOrThrow({
      where: {
        runId: run.id,
        kind: "animation_preview",
        metadata: { path: ["derivation"], equals: "per-frame-mirror-preserve-order" },
      },
    });
    expect(rejectedMirror).toMatchObject({ status: "superseded" });
    expect(rejectedMirror.expiresAt).not.toBeNull();
    const idleJob = await prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: "row-idle" } } });
    expect(idleJob.attempt).toBe(2);
    const packageArtifact = await prisma.codexPetArtifact.findUniqueOrThrow({ where: { id: run.packageArtifactId! } });
    expect((await inspectCodexPetZip(await store.load(packageArtifact))).manifest.spriteVersionNumber).toBe(2);
    const document = await prisma.document.findUniqueOrThrow({ where: { id: run.knowledgeDocumentId! } });
    expect(document.sourceModule).toBe("codex_pet");
    expect(document.sourceId).toBe(run.id);
    expect(JSON.stringify(document.metadata)).not.toContain("objectKey");
    expect(deps.billing.refundResource).not.toHaveBeenCalled();

    const artifactCount = await prisma.codexPetArtifact.count({ where: { runId: run.id } });
    await prisma.document.delete({ where: { id: document.id } });
    const retainedRun = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(retainedRun.knowledgeDocumentId).toBeNull();
    expect(await prisma.codexPetProject.findUnique({ where: { id: seeded.project.id } })).not.toBeNull();
    expect(await prisma.codexPetArtifact.count({ where: { runId: run.id } })).toBe(artifactCount);
  }, 120_000);

  it("runs a single-reference plush pet through packaging and knowledge archival", async () => {
    const seeded = await seed(true, {
      referenceCount: 1,
      stylePreset: "plush",
      prompt: "保留参考图身份，制作柔软毛绒桌宠",
    });
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);

    expect((await executeCodexPetRun({ runId: seeded.run.id, deps })).status).toBe("ready");
    expect(deps.loadReferenceAsset).toHaveBeenCalledOnce();
    const baseCalls = (deps.visual.generate as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as { prompt: string; references?: readonly unknown[] })
      .filter((input) => input.prompt.includes("main character candidate"));
    expect(baseCalls).toHaveLength(2);
    expect(baseCalls.every((input) => input.references?.length === 1)).toBe(true);
    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    const document = await prisma.document.findUniqueOrThrow({ where: { id: run.knowledgeDocumentId! } });
    expect(document.content).toContain("风格预设：plush");
  }, 120_000);

  it("uses all three references and generates running-left separately for asymmetric identity", async () => {
    const seeded = await seed(true, {
      referenceCount: 3,
      stylePreset: "painterly",
      prompt: "保留右耳单边配件与不对称花纹，不可通过镜像改变身份",
    });
    const asymmetricConsensus = vi.fn(async (input: { prompt: string }) => (
      input.prompt.includes("running-right")
        ? {
            ...passedConsensus,
            mirrorSafe: false,
            verdicts: [{ ...passedVerdict, mirrorSafe: false }],
          }
        : passedConsensus
    ));
    const deps = runnerDeps(memoryArtifactStore(), asymmetricConsensus);

    expect((await executeCodexPetRun({ runId: seeded.run.id, deps })).status).toBe("ready");
    expect(deps.loadReferenceAsset).toHaveBeenCalledTimes(3);
    const generatedPrompts = (deps.visual.generate as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String((call[0] as { prompt?: string }).prompt ?? ""));
    expect(generatedPrompts.some((prompt) => prompt.includes("running-left"))).toBe(true);
    const runningLeftJob = await prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: seeded.run.id, key: "row-running-left" } } });
    expect(runningLeftJob.kind).toBe("standard_row");
    expect(runningLeftJob.input).not.toMatchObject({ derivation: "per-frame-mirror-preserve-order" });
  }, 120_000);

  it("pauses for base review, resumes from persisted candidate jobs, and does not charge again", async () => {
    const seeded = await seed(false);
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);
    expect((await executeCodexPetRun({ runId: seeded.run.id, deps })).status).toBe("awaiting_base_review");
    expect((await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } })).hasSuccessfulImage).toBe(true);
    const generate = deps.visual.generate as unknown as ReturnType<typeof vi.fn>;
    const callsAtPause = generate.mock.calls.length;
    expect((await executeCodexPetRun({ runId: seeded.run.id, deps })).status).toBe("awaiting_base_review");
    expect(generate).toHaveBeenCalledTimes(callsAtPause);
    const cursorAtPause = (await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } })).lastEventSequence;
    const candidate = await prisma.codexPetArtifact.findFirstOrThrow({ where: { runId: seeded.run.id, kind: "base_candidate" }, orderBy: { createdAt: "asc" } });
    await prisma.codexPetRun.update({ where: { id: seeded.run.id }, data: { selectedBaseArtifactId: candidate.id } });
    expect((await executeCodexPetRun({ runId: seeded.run.id, deps })).status).toBe("ready");
    expect(await prisma.codexPetJob.count({ where: { runId: seeded.run.id, key: { startsWith: "base-candidate-" } } })).toBe(2);
    const resumedStageEvents = await prisma.codexPetEvent.findMany({
      where: { runId: seeded.run.id, sequence: { gt: cursorAtPause }, type: "stage.started" },
      orderBy: { sequence: "asc" },
      select: { stage: true, progress: true },
    });
    expect(resumedStageEvents[0]).toMatchObject({ stage: "standard_generating", progress: 16 });
    expect(resumedStageEvents).not.toContainEqual(expect.objectContaining({ stage: "base_generating" }));
  }, 120_000);

  it("does not enter ready when the archived knowledge document is concurrently deleted", async () => {
    const seeded = await seed(true);
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);
    deps.archiveRun = async (input) => {
      const archived = await archiveCodexPetRun(input);
      await prisma.document.delete({ where: { id: archived.documentId } });
      return archived;
    };

    await expect(executeCodexPetRun({ runId: seeded.run.id, deps })).rejects.toThrow("知识库归档关联已变化");

    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(run).toMatchObject({ status: "failed", knowledgeDocumentId: null, billingRefundStatus: "refunded" });
    expect(deps.billing.refundResource).toHaveBeenCalledOnce();
  }, 120_000);

  it("cancels before the first image and refunds the fixed package", async () => {
    const seeded = await seed(false);
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);
    const persistEvent = deps.appendEvent;
    deps.appendEvent = vi.fn(async (input) => {
      if (input.type === "run.cancelled" || input.type === "billing.refunded") throw new Error("terminal event store unavailable");
      return persistEvent(input);
    });
    await prisma.codexPetRun.update({ where: { id: seeded.run.id }, data: { cancelRequested: true } });
    expect((await executeCodexPetRun({ runId: seeded.run.id, deps })).status).toBe("cancelled");
    expect(deps.billing.refundResource).toHaveBeenCalledOnce();
    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(run.billingRefundedAt).not.toBeNull();
    expect(run.billingRefundStatus).toBe("refunded");
  });

  it("persists failed/refunded even when terminal events fail", async () => {
    const seeded = await seed(false);
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);
    deps.visual.generate = vi.fn(async () => { throw new Error("synthetic provider failure"); }) as never;
    const persistEvent = deps.appendEvent;
    deps.appendEvent = vi.fn(async (input) => {
      if (input.type === "run.failed" || input.type === "billing.refunded") throw new Error("terminal event store unavailable");
      return persistEvent(input);
    });

    await expect(executeCodexPetRun({ runId: seeded.run.id, deps })).rejects.toThrow("synthetic provider failure");

    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(run).toMatchObject({ status: "failed", billingRefundStatus: "refunded" });
    expect(run.billingRefundedAt).not.toBeNull();
    expect(deps.billing.refundResource).toHaveBeenCalledOnce();
  });

  it("turns moderation failures into an actionable user message and refunds", async () => {
    const seeded = await seed(false);
    const deps = runnerDeps(memoryArtifactStore());
    deps.visual.generate = vi.fn(async () => {
      throw new ImageGenerationUpstreamError(
        400,
        "prompt was blocked",
        "moderation_blocked",
        "content_policy",
        "req-moderation-123",
      );
    }) as never;

    await expect(executeCodexPetRun({ runId: seeded.run.id, deps }))
      .rejects.toMatchObject({ category: "moderation", retryable: false });

    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(run).toMatchObject({ status: "failed", billingRefundStatus: "refunded" });
    expect(run.error).toContain("请修改提示词或更换参考图");
    expect(run.error).not.toContain("prompt was blocked");
    expect(deps.billing.refundResource).toHaveBeenCalledOnce();
    const failedEvent = await prisma.codexPetEvent.findFirstOrThrow({
      where: { runId: seeded.run.id, type: "run.failed" },
      orderBy: { sequence: "desc" },
    });
    expect(failedEvent.payload).toMatchObject({
      errorCategory: "moderation",
      upstreamRequestId: "req-moderation-123",
    });
  });

  it("treats terminal database state as authoritative on duplicate queue delivery", async () => {
    const [cancelledSeed, failedSeed] = await Promise.all([seed(false), seed(false)]);
    const terminalAt = new Date();
    await Promise.all([
      prisma.codexPetRun.update({ where: { id: cancelledSeed.run.id }, data: { status: "cancelled", progressStage: "cancelled", cancelRequested: true, billingRefundStatus: "refunded", billingRefundedAt: terminalAt, completedAt: terminalAt } }),
      prisma.codexPetRun.update({ where: { id: failedSeed.run.id }, data: { status: "failed", progressStage: "failed", billingRefundStatus: "refunded", billingRefundedAt: terminalAt, completedAt: terminalAt } }),
    ]);
    const cancelledDeps = runnerDeps(memoryArtifactStore());
    const failedDeps = runnerDeps(memoryArtifactStore());

    await expect(executeCodexPetRun({ runId: cancelledSeed.run.id, deps: cancelledDeps })).resolves.toEqual({ status: "cancelled", runId: cancelledSeed.run.id });
    await expect(executeCodexPetRun({ runId: failedSeed.run.id, deps: failedDeps })).resolves.toEqual({ status: "failed", runId: failedSeed.run.id });

    expect(cancelledDeps.visual.generate).not.toHaveBeenCalled();
    expect(failedDeps.visual.generate).not.toHaveBeenCalled();
    expect(cancelledDeps.billing.refundResource).not.toHaveBeenCalled();
    expect(failedDeps.billing.refundResource).not.toHaveBeenCalled();
    expect(await prisma.codexPetEvent.count({ where: { runId: { in: [cancelledSeed.run.id, failedSeed.run.id] } } })).toBe(0);
  });

  it("keeps transient archive failures at 98%, resumes without regenerating, then refunds after durable retries exhaust", async () => {
    const seeded = await seed(true);
    const store = memoryArtifactStore();
    const baseDeps = runnerDeps(store);
    const archiveRun = vi.fn(async () => { throw new Error("knowledge archive unavailable"); });
    const deps = { ...baseDeps, archiveRun, env: { CODEX_PET_ARCHIVE_MAX_ATTEMPTS: "3" } };

    await expect(executeCodexPetRun({ runId: seeded.run.id, deps }))
      .resolves.toEqual({ status: "archiving", runId: seeded.run.id });
    const generationMock = baseDeps.visual.generate as unknown as { readonly mock: { readonly calls: readonly unknown[] } };
    const generationCallsAfterPackaging = generationMock.mock.calls.length;
    await expect(executeCodexPetRun({ runId: seeded.run.id, deps }))
      .resolves.toEqual({ status: "archiving", runId: seeded.run.id });
    expect(generationMock.mock.calls).toHaveLength(generationCallsAfterPackaging);
    await expect(executeCodexPetRun({ runId: seeded.run.id, deps }))
      .rejects.toThrow("knowledge archive unavailable");

    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(run).toMatchObject({
      status: "failed",
      progressStage: "failed",
      progressPercent: 98,
      knowledgeDocumentId: null,
      billingRefundStatus: "refunded",
    });
    expect(archiveRun).toHaveBeenCalledTimes(3);
    expect(baseDeps.billing.refundResource).toHaveBeenCalledOnce();
    expect(await prisma.document.count({ where: { sourceModule: "codex_pet", sourceId: run.id } })).toBe(0);
    const events = await prisma.codexPetEvent.findMany({ where: { runId: run.id }, orderBy: { sequence: "asc" } });
    expect(events.filter((event) => event.type === "knowledge.archive_retrying")).toHaveLength(3);
    expect(events.map((event) => event.type)).toContain("run.failed");
    expect(events.map((event) => event.type)).not.toContain("run.completed");
  }, 120_000);

  it("recovers a deferred knowledge archive on the next worker delivery", async () => {
    const seeded = await seed(true);
    const store = memoryArtifactStore();
    const baseDeps = runnerDeps(store);
    let first = true;
    const archiveRun = vi.fn(async (input: Parameters<typeof archiveCodexPetRun>[0]) => {
      if (first) {
        first = false;
        throw new Error("knowledge database temporarily unavailable");
      }
      return archiveCodexPetRun(input);
    });
    const deps = { ...baseDeps, archiveRun, env: { CODEX_PET_ARCHIVE_MAX_ATTEMPTS: "3" } };

    await expect(executeCodexPetRun({ runId: seeded.run.id, deps }))
      .resolves.toEqual({ status: "archiving", runId: seeded.run.id });
    const generationMock = baseDeps.visual.generate as unknown as { readonly mock: { readonly calls: readonly unknown[] } };
    const generationCallsAfterPackaging = generationMock.mock.calls.length;
    await expect(executeCodexPetRun({ runId: seeded.run.id, deps }))
      .resolves.toEqual({ status: "ready", runId: seeded.run.id });

    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(run).toMatchObject({ status: "ready", progressPercent: 100 });
    expect(run.knowledgeDocumentId).toBeTruthy();
    expect(generationMock.mock.calls).toHaveLength(generationCallsAfterPackaging);
    expect(baseDeps.billing.refundResource).not.toHaveBeenCalled();
    expect(archiveRun).toHaveBeenCalledTimes(2);
  }, 120_000);

  it("repairs complete action groups requested by the final visual QA", async () => {
    const seeded = await seed(true);
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);
    const persistedRepairStages: string[] = [];
    const persistEvent = deps.appendEvent;
    deps.appendEvent = async (input) => {
      if (input.type === "run.repairing" || input.type === "job.retrying") {
        const current = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
        persistedRepairStages.push(current.status);
      }
      return persistEvent(input);
    };
    let rejectedFinalReview = false;
    deps.visual!.qa = vi.fn(async (input: { prompt: string }) => {
      if (!rejectedFinalReview && input.prompt.includes("Kind: final")) {
        rejectedFinalReview = true;
        return {
          ...passedVerdict,
          pass: false,
          failures: ["idle animation is too static"],
          repairPrompt: "regenerate the complete idle action group",
          repairRows: ["idle"],
        };
      }
      return passedVerdict;
    }) as never;

    const result = await executeCodexPetRun({ runId: seeded.run.id, deps });
    expect(result.status).toBe("ready");
    expect(rejectedFinalReview).toBe(true);
    const idleJob = await prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: seeded.run.id, key: "row-idle" } } });
    expect(idleJob.attempt).toBe(2);
    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    const report = run.validationReport as { finalRepairHistory?: Array<{ rows: string[] }> };
    expect(report.finalRepairHistory?.[0]?.rows).toContain("idle");
    expect(persistedRepairStages).toContain("repairing");
  }, 120_000);

  it("does not auto-select when both base candidates fail visual QA", async () => {
    const seeded = await seed(true);
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);
    deps.visual!.qa = vi.fn(async () => ({ ...passedVerdict, pass: false, score: 12, failures: ["identity drift"], repairPrompt: "preserve identity" })) as never;

    await expect(executeCodexPetRun({ runId: seeded.run.id, deps })).rejects.toThrow("两个主形象候选均未通过视觉质检");
    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(run.status).toBe("failed");
    expect(run.selectedBaseArtifactId).toBeNull();
    expect(run.hasSuccessfulImage).toBe(true);
    expect(run.billingRefundStatus).toBe("refunded");
    expect(deps.billing.refundResource).toHaveBeenCalledOnce();
  }, 120_000);

  it("does not refund after base candidates exist when cancellation wins during later visual QA", async () => {
    const seeded = await seed(true);
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);
    let cancellationRequested = false;
    deps.visual!.qaConsensus = vi.fn(async () => {
      if (!cancellationRequested) {
        cancellationRequested = true;
        await prisma.codexPetRun.update({ where: { id: seeded.run.id }, data: { cancelRequested: true } });
      }
      return passedConsensus;
    }) as never;

    await expect(executeCodexPetRun({ runId: seeded.run.id, deps })).resolves.toMatchObject({ status: "cancelled", runId: seeded.run.id });
    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(run.hasSuccessfulImage).toBe(true);
    expect(run.billingRefundStatus).toBe("none");
    expect(deps.billing.refundResource).not.toHaveBeenCalled();
  }, 120_000);

  it("retries the independent row-10 gate before starting final assembly", async () => {
    const seeded = await seed(true);
    const store = memoryArtifactStore();
    let rejectedRow10 = false;
    const consensus = vi.fn(async (input: { prompt: string }) => {
      if (!rejectedRow10 && input.prompt.includes("pre-row-10 gate")) {
        rejectedRow10 = true;
        return { ...passedConsensus, pass: false, failures: ["row-10 seam registration"], verdicts: [{ ...passedVerdict, pass: false, repairPrompt: "repair the complete 180–337.5 row" }] };
      }
      return passedConsensus;
    });
    const deps = runnerDeps(store, consensus);
    const result = await executeCodexPetRun({ runId: seeded.run.id, deps });
    expect(result.status).toBe("ready");
    expect(rejectedRow10).toBe(true);
    const row10Job = await prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: seeded.run.id, key: "look-b" } } });
    expect(row10Job.attempt).toBe(2);
    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect((run.validationReport as { row10PreGenerationGate?: { passed?: boolean } }).row10PreGenerationGate?.passed).toBe(true);
  }, 120_000);

  it("does not enter the visual pipeline while another fresh worker owns the run lease", async () => {
    const seeded = await seed(true);
    await prisma.codexPetRun.update({ where: { id: seeded.run.id }, data: { workerId: "worker-live", heartbeatAt: new Date() } });
    const deps = runnerDeps(memoryArtifactStore());

    await expect(executeCodexPetRun({ runId: seeded.run.id, deps: { ...deps, workerId: "worker-contender" } }))
      .resolves.toEqual({ status: "busy", runId: seeded.run.id });
    expect(deps.visual.generate).not.toHaveBeenCalled();
    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(run.workerId).toBe("worker-live");
    expect(run.status).toBe("queued");
  });
});

afterAll(async () => {
  if (cleanupUserIds.length) {
    const runs = await prisma.codexPetRun.findMany({ where: { userId: { in: cleanupUserIds } }, select: { id: true } });
    await prisma.document.deleteMany({ where: { sourceModule: "codex_pet", sourceId: { in: runs.map((run) => run.id) } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
  await prisma.$disconnect();
});
