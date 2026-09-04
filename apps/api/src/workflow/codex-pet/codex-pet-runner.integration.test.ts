import { createHash, randomUUID } from "node:crypto";
import { Prisma, type CodexPetArtifact } from "@prisma/client";
import { getPrisma } from "@ai-assistant/db";
import { inspectCodexPetZip, LOOK_DIRECTIONS } from "@ai-assistant/codex-pet-pipeline";
import sharp from "sharp";
import { afterAll, describe, expect, it, vi } from "vitest";
import { appendCodexPetEvent } from "./codex-pet-events.js";
import { initializeCodexPetTargetedBoardRetry } from "./codex-pet-failed-continuation.js";
import { DOUBAO_IMAGE_MODEL, GPT_IMAGE_MODEL, ImageGenerationUpstreamError } from "../_shared/image-service.js";
import { codexPetFinalPackageInputRevision } from "./codex-pet-packaging.js";
import { buildStandardRowPrompt } from "./codex-pet-prompts.js";
import { CODEX_PET_BOARD_PROMPT_VERSION, CodexPetLeaseLostError, codexPetBoardInputRevision, codexPetStandardRowPromptVersion, executeCodexPetRun, type CodexPetArtifactStore } from "./codex-pet-runner.js";
import type { GeneratedPetVisual, PetVisualQaConsensus, PetVisualQaVerdict } from "./codex-pet-visual.js";

const prisma = getPrisma();
const enabled = Boolean(process.env.DATABASE_URL);
const cleanupUserIds: string[] = [];
const VISUAL_MODEL_PROVENANCE = {
  requestedModel: "gpt-5.6-sol",
  actualModel: "gpt-5.6-sol",
  route: "chatgpt_model_route" as const,
};

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
  modelProvenance: VISUAL_MODEL_PROVENANCE,
};

const passedConsensus: PetVisualQaConsensus = {
  pass: true,
  score: 96,
  mirrorSafe: true,
  verdicts: [passedVerdict],
  warnings: [],
  failures: [],
  modelProvenance: {
    requestedModel: "gpt-5.6-sol",
    actualModels: ["gpt-5.6-sol"],
    route: "chatgpt_model_route",
  },
};

const IDENTITY_GUIDE = "头：蓝色圆角头部；耳：无；眼：两只白色圆眼，位于面部上半部；嘴：不可见；四肢：与身体相连；尾巴：无；固定花纹：无；可动特征：眼睛、头部与四肢可小幅移动；歧义：无。";

function completeDeliveryValidationReport() {
  return {
    ok: true,
    spriteVersionNumber: 2,
    modelContractVersion: "gpt-only-quality-optional-v3",
    modelProvenance: {
      imageGeneration: { requestedModel: "gpt-image-2", actualModels: ["gpt-image-2-codex"] },
      visualQa: { requestedModel: "gpt-5.6-sol", actualModels: ["gpt-5.6-sol"], routes: ["chatgpt_model_route"] },
    },
    deterministic: { ok: true },
    standardAtlasValidation: { ok: true },
    packagedSpritesheet: { ok: true },
    chromaDespill: { ok: true },
    directionRegistration: { ok: true },
    directionContinuity: { ok: true },
    row9PreGenerationGate: { passed: true },
    row10PreGenerationGate: { passed: true },
    blindDirectionValidation: { ok: true },
    finalVisualQa: { pass: true, identity: true, structure: true, semantics: true, continuity: true },
    directionSemantics: LOOK_DIRECTIONS.map((direction) => ({ direction, verdict: "pass" })),
  };
}

async function syntheticVisual(
  prompt: string,
  jumpingLiftOverride?: readonly number[],
  bodyWidthRatioOverride?: number,
): Promise<GeneratedPetVisual> {
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
    const columns = Number(/as a (\d+) columns/i.exec(prompt)?.[1]
      ?? (/2×2/i.test(prompt) ? 2 : 4));
    const rows = Number(/columns × (\d+) rows?/i.exec(prompt)?.[1]
      ?? (/2×2/i.test(prompt) ? 2 : 2));
    const jumpingLift = prompt.includes("“jumping” animation")
      ? jumpingLiftOverride ?? [0, 0.1, 0.2, 0.1, 0]
      : [];
    const slotWidth = width / columns;
    const slotHeight = height / rows;
    const overlays = Array.from({ length: frameCount }, (_, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const bodyWidth = Math.round(slotWidth * (bodyWidthRatioOverride ?? 0.34));
      const bodyHeight = Math.round(slotHeight * 0.62);
      const x = Math.round(column * slotWidth + (slotWidth - bodyWidth) / 2);
      const y = Math.round(row * slotHeight + slotHeight - 56 - bodyHeight
        - slotHeight * (jumpingLift[index] ?? 0));
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

async function syntheticVisualForModel(prompt: string, model: string): Promise<GeneratedPetVisual> {
  const generated = await syntheticVisual(prompt);
  return {
    ...generated,
    provider: {
      ...generated.provider,
      requestedModel: model,
      actualModel: model,
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
        checksum: createHash("sha256").update(input.buffer).digest("hex"),
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
  readonly imageGenerationApprovalBudget?: number;
  readonly imageModel?: string;
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
    imageModel: options.imageModel ?? GPT_IMAGE_MODEL,
    qualityInspectionEnabled: true,
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
      modelContractVersion: "gpt-only-quality-optional-v3",
      requestedModel: options.imageModel ?? GPT_IMAGE_MODEL,
      visualQaModel: "gpt-5.6-sol",
      qualityInspectionEnabled: true,
    },
    autoContinue,
    imageGenerationApprovalBudget: options.imageGenerationApprovalBudget ?? 100,
    requestedModel: options.imageModel ?? GPT_IMAGE_MODEL,
    qualityInspectionEnabled: true,
    startedAt: new Date(),
    status: "queued",
  } });
  await prisma.codexPetProject.update({ where: { id: project.id }, data: { latestRunId: run.id } });
  return { user, project, run, referenceAssetIds };
}

async function seedArchivingDeliverables(seeded: Awaited<ReturnType<typeof seed>>) {
  const prefix = `workflow/codex-pets/${seeded.user.id}/${seeded.project.id}/${seeded.run.id}`;
  const [spritesheet, packageArtifact, preview] = await Promise.all([
    prisma.codexPetArtifact.create({ data: {
      projectId: seeded.project.id,
      runId: seeded.run.id,
      userId: seeded.user.id,
      kind: "spritesheet",
      name: "spritesheet.webp",
      objectKey: `${prefix}/spritesheet-${randomUUID()}.webp`,
      mime: "image/webp",
      sizeBytes: 1024,
      width: 1536,
      height: 2288,
    } }),
    prisma.codexPetArtifact.create({ data: {
      projectId: seeded.project.id,
      runId: seeded.run.id,
      userId: seeded.user.id,
      kind: "package",
      name: "pet.zip",
      objectKey: `${prefix}/package-${randomUUID()}.zip`,
      mime: "application/zip",
      sizeBytes: 2048,
      metadata: { petId: `pet-${seeded.run.id}` },
    } }),
    prisma.codexPetArtifact.create({ data: {
      projectId: seeded.project.id,
      runId: seeded.run.id,
      userId: seeded.user.id,
      kind: "preview",
      name: "preview.png",
      objectKey: `${prefix}/preview-${randomUUID()}.png`,
      mime: "image/png",
      sizeBytes: 512,
      width: 1024,
      height: 1024,
    } }),
  ]);
  await prisma.$transaction([
    prisma.codexPetRun.update({
      where: { id: seeded.run.id },
      data: {
        status: "archiving",
        progressStage: "archiving",
        progressPercent: 98,
        progressMessage: "正在归档到 AI 产物知识库",
        colorKey: "#ff00ff",
        workerId: null,
        heartbeatAt: null,
        spritesheetArtifactId: spritesheet.id,
        packageArtifactId: packageArtifact.id,
        previewArtifactId: preview.id,
        validationReport: completeDeliveryValidationReport(),
      },
    }),
    prisma.codexPetProject.update({ where: { id: seeded.project.id }, data: { status: "archiving" } }),
  ]);
  return { spritesheet, packageArtifact, preview };
}

function runnerDeps(store: ReturnType<typeof memoryArtifactStore>, consensus = vi.fn(async () => passedConsensus)) {
  return {
    env: { CODEX_PET_IMAGE_APPROVAL_GATE: "0" },
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
    visual: {
      generate: vi.fn(async (input: { prompt: string; onAttempt?: (attempt: number) => Promise<void> | void }) => {
        await input.onAttempt?.(1);
        return syntheticVisual(input.prompt);
      }) as never,
      qa: vi.fn(async () => passedVerdict),
      qaConsensus: consensus as never,
      blindQa: vi.fn(async () => ({
        ok: true,
        reviewers: [],
        consensus: [],
        failures: [],
        warnings: [],
        modelProvenance: { requestedModel: "gpt-5.6-sol", actualModels: ["gpt-5.6-sol"], route: "chatgpt_model_route" as const },
      })),
      directionSemantics: vi.fn(async () => LOOK_DIRECTIONS.map((direction) => ({
        direction,
        verdict: "pass" as const,
        expected: direction,
        observed: direction,
        horizontalEvidence: "ok",
        verticalEvidence: "ok",
        reason: "continuous",
        modelProvenance: VISUAL_MODEL_PROVENANCE,
      }))),
      lookMechanics: vi.fn(async (input: { onModelProvenance?: (provenance: typeof VISUAL_MODEL_PROVENANCE) => void }) => {
        input.onModelProvenance?.(VISUAL_MODEL_PROVENANCE);
        return "下半身固定，眼睛先引导，头部与天线平滑跟随，四个基准方向明确。";
      }),
      identityGuide: vi.fn(async (input: { onModelProvenance?: (provenance: typeof VISUAL_MODEL_PROVENANCE) => void }) => {
        input.onModelProvenance?.(VISUAL_MODEL_PROVENANCE);
        return IDENTITY_GUIDE;
      }),
    },
  };
}

describe.skipIf(!enabled)("Codex pet runner database integration", () => {
  it.skip("keeps the retired Seedream targeted-retry fixture offline and non-runnable", async () => {
    const seeded = await seed(false, { imageModel: DOUBAO_IMAGE_MODEL });
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);
    Object.assign(deps.env, {
      CODEX_PET_IMAGE_APPROVAL_GATE: "0",
      CODEX_PET_MAX_BOARD_ATTEMPTS: "1",
    });
    deps.visual.generate = vi.fn(async (input: {
      prompt: string;
      onAttempt?: (attempt: number) => Promise<void> | void;
    }) => {
      await input.onAttempt?.(1);
      return syntheticVisualForModel(input.prompt, DOUBAO_IMAGE_MODEL);
    }) as never;

    expect(await executeCodexPetRun({ runId: seeded.run.id, deps }))
      .toEqual({ status: "awaiting_base_review", runId: seeded.run.id });
    const canonical = await prisma.codexPetArtifact.findFirstOrThrow({
      where: { runId: seeded.run.id, kind: "base_candidate", status: "ready" },
      orderBy: { createdAt: "asc" },
    });
    await prisma.$transaction([
      prisma.codexPetRun.update({
        where: { id: seeded.run.id },
        data: {
          selectedBaseArtifactId: canonical.id,
          status: "standard_generating",
          progressStage: "standard_generating",
        },
      }),
      prisma.codexPetProject.update({
        where: { id: seeded.project.id },
        data: { status: "standard_generating" },
      }),
    ]);
    deps.visual.qaConsensus = vi.fn(async (input: { prompt: string }) => (
      input.prompt.includes("Context: running-right 动作组")
        ? {
            ...passedConsensus,
            pass: false,
            score: 20,
            failures: ["running gait is static"],
            verdicts: [{ ...passedVerdict, pass: false, score: 20, failures: ["running gait is static"] }],
          }
        : passedConsensus
    )) as never;

    await expect(executeCodexPetRun({ runId: seeded.run.id, deps })).rejects.toThrow("running gait is static");
    const [failedRun, idleBefore, runningRightBefore] = await Promise.all([
      prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: seeded.run.id, key: "row-idle" } } }),
      prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: seeded.run.id, key: "row-running-right" } } }),
    ]);
    expect(failedRun).toMatchObject({
      status: "failed",
      workerId: null,
      imageGenerationCallCount: 4,
    });
    expect(idleBefore).toMatchObject({
      status: "completed",
      attempt: 1,
      maxAttempts: 1,
    });
    expect(runningRightBefore).toMatchObject({ status: "failed", attempt: 1, maxAttempts: 1 });
    const failedBoard = await prisma.codexPetArtifact.findFirstOrThrow({
      where: {
        runId: seeded.run.id,
        jobId: runningRightBefore.id,
        kind: "pose_board",
        status: "ready",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(failedBoard.metadata).toMatchObject({
      requestedModel: DOUBAO_IMAGE_MODEL,
      actualModel: DOUBAO_IMAGE_MODEL,
    });

    const scaffoldBuffer = await sharp({
      create: { width: 1536, height: 768, channels: 4, background: "#ff00ff" },
    }).composite([
      {
        input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="768"><rect x="120" y="80" width="240" height="260" rx="60" fill="#28b9a8"/><rect x="504" y="100" width="240" height="240" rx="60" fill="#28b9a8"/></svg>'),
      },
    ]).png().toBuffer();
    const scaffold = await store.put({
      userId: seeded.user.id,
      projectId: seeded.project.id,
      runId: seeded.run.id,
      jobId: runningRightBefore.id,
      kind: "pose_board_scaffold",
      name: "offline-audited-two-phase-scaffold",
      buffer: scaffoldBuffer,
      mime: "image/png",
      width: 1536,
      height: 768,
      metadata: { state: "running-right", schemaVersion: "test-explicit-scaffold-v1" },
    });
    const mismatchedScaffold = await store.put({
      userId: seeded.user.id,
      projectId: seeded.project.id,
      runId: seeded.run.id,
      jobId: runningRightBefore.id,
      kind: "pose_board_scaffold",
      name: "mismatched-3x2-scaffold",
      buffer: await sharp(scaffoldBuffer).extend({ bottom: 256, background: "#ff00ff" }).png().toBuffer(),
      mime: "image/png",
      width: 1536,
      height: 1024,
    });
    await expect(initializeCodexPetTargetedBoardRetry({
      prisma,
      runId: seeded.run.id,
      projectId: seeded.project.id,
      userId: seeded.user.id,
      sourceBoardArtifactId: failedBoard.id,
      scaffoldArtifactId: mismatchedScaffold.id,
      reason: "reject a scaffold whose aspect ratio would split target slots",
    })).rejects.toThrow("定向续跑脚手架必须使用与 4×2 目标一致的方形槽位画布");

    const foreign = await seed(false, { imageModel: DOUBAO_IMAGE_MODEL });
    const foreignJob = await prisma.codexPetJob.create({
      data: {
        projectId: foreign.project.id,
        runId: foreign.run.id,
        userId: foreign.user.id,
        key: "row-running-right",
        kind: "standard_row",
        status: "failed",
      },
    });
    const foreignScaffold = await store.put({
      userId: foreign.user.id,
      projectId: foreign.project.id,
      runId: foreign.run.id,
      jobId: foreignJob.id,
      kind: "pose_board_scaffold",
      name: "foreign-scaffold",
      buffer: scaffoldBuffer,
      mime: "image/png",
      width: 1536,
      height: 1024,
    });
    for (const rejectedScaffoldArtifactId of [randomUUID(), foreignScaffold.id]) {
      await expect(initializeCodexPetTargetedBoardRetry({
        prisma,
        runId: seeded.run.id,
        projectId: seeded.project.id,
        userId: seeded.user.id,
        sourceBoardArtifactId: failedBoard.id,
        scaffoldArtifactId: rejectedScaffoldArtifactId,
        reason: "reject an unavailable or foreign recovery scaffold",
      })).rejects.toThrow("定向续跑脚手架不属于 running-right 动作");
      expect(await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } })).toMatchObject({
        status: "failed",
        imageGenerationCallCount: 4,
        workerId: null,
      });
      expect(await prisma.codexPetJob.findUniqueOrThrow({ where: { id: runningRightBefore.id } }))
        .toMatchObject({ status: "failed", attempt: 1 });
    }

    await expect(initializeCodexPetTargetedBoardRetry({
      prisma,
      runId: seeded.run.id,
      projectId: seeded.project.id,
      userId: seeded.user.id,
      sourceBoardArtifactId: failedBoard.id,
      scaffoldArtifactId: scaffold.id,
      reason: "offline-validated two-phase gait scaffold",
    })).resolves.toMatchObject({
      resumed: true,
      preservedImageGenerationCallCount: 4,
      sourceBoardArtifactId: failedBoard.id,
    });

    let observedTargetedBinding = false;
    deps.visual.generate = vi.fn(async (input: {
      prompt: string;
      references: Array<{ filename?: string; b64: string }>;
      maxAttempts?: number;
    }) => {
      expect(input.prompt).toContain("running-right");
      expect(input.maxAttempts).toBe(1);
      const scaffoldReference = input.references.find((reference) => reference.filename === "running-right-seedream-scaffold.png");
      expect(scaffoldReference?.b64).toBe(scaffoldBuffer.toString("base64"));
      observedTargetedBinding = true;
      throw new Error("offline-stop-after-targeted-binding");
    }) as never;

    await expect(executeCodexPetRun({
      runId: seeded.run.id,
      deps: { ...deps, workerId: "targeted-scaffold-offline-test" },
    })).rejects.toThrow("offline-stop-after-targeted-binding");
    expect(observedTargetedBinding).toBe(true);

    const [after, idleAfter, runningRightAfter] = await Promise.all([
      prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: seeded.run.id, key: "row-idle" } } }),
      prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: seeded.run.id, key: "row-running-right" } } }),
    ]);
    expect(after.imageGenerationCallCount).toBe(4);
    expect(idleAfter).toMatchObject({
      status: "completed",
      attempt: idleBefore.attempt,
      inputArtifactIds: idleBefore.inputArtifactIds,
      outputArtifactIds: idleBefore.outputArtifactIds,
    });
    expect(runningRightAfter.inputArtifactIds).toEqual([canonical.id, failedBoard.id, scaffold.id]);
    expect(runningRightAfter.input).toMatchObject({
      promptVersion: CODEX_PET_BOARD_PROMPT_VERSION,
      inputArtifactIds: [canonical.id, failedBoard.id, scaffold.id],
    });
  }, 120_000);

  it("runs the GPT-only default path with fourteen image calls and no visual QA calls", async () => {
    const seeded = await seed(false);
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);
    const snapshot = seeded.run.inputSnapshot as Record<string, unknown>;
    await prisma.$transaction([
      prisma.codexPetProject.update({
        where: { id: seeded.project.id },
        data: { qualityInspectionEnabled: false },
      }),
      prisma.codexPetRun.update({
        where: { id: seeded.run.id },
        data: {
          inputSnapshot: { ...snapshot, qualityInspectionEnabled: false } as Prisma.InputJsonObject,
          qualityInspectionEnabled: false,
          plannedImageCallLimit: 14,
          imageGenerationApprovalBudget: 0,
        },
      }),
    ]);
    const generatedRequests: Array<{ readonly prompt: string; readonly size?: string; readonly referenceCount: number }> = [];
    deps.visual.generate = vi.fn(async (input: {
      prompt: string;
      size?: string;
      references?: readonly unknown[];
      onAttempt?: (attempt: number) => Promise<void> | void;
    }) => {
      generatedRequests.push({ prompt: input.prompt, size: input.size, referenceCount: input.references?.length ?? 0 });
      await input.onAttempt?.(1);
      return syntheticVisual(input.prompt);
    }) as never;

    await expect(executeCodexPetRun({ runId: seeded.run.id, deps }))
      .resolves.toEqual({ status: "awaiting_base_review", runId: seeded.run.id });
    const selected = await prisma.codexPetArtifact.findFirstOrThrow({
      where: { runId: seeded.run.id, kind: "base_candidate", status: "ready" },
      orderBy: { createdAt: "asc" },
    });
    await prisma.$transaction([
      prisma.codexPetRun.update({
        where: { id: seeded.run.id },
        data: { selectedBaseArtifactId: selected.id, status: "standard_generating", progressStage: "standard_generating" },
      }),
      prisma.codexPetProject.update({ where: { id: seeded.project.id }, data: { status: "standard_generating" } }),
    ]);

    await expect(executeCodexPetRun({ runId: seeded.run.id, deps }))
      .resolves.toEqual({ status: "ready", runId: seeded.run.id });

    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(run).toMatchObject({
      status: "ready",
      qualityInspectionEnabled: false,
      imageGenerationCallCount: 14,
    });
    const directionRequests = generatedRequests.filter(({ prompt }) => (
      prompt.includes("Generate exactly four separated cardinal looking poses")
      || prompt.includes("Direction order:")
    ));
    expect(directionRequests).toHaveLength(3);
    expect(directionRequests.every(({ size }) => size === "1024x688")).toBe(true);
    expect(directionRequests.find(({ prompt }) => prompt.includes("cardinal looking poses"))?.referenceCount).toBe(2);
    expect(deps.visual.qa).not.toHaveBeenCalled();
    expect(deps.visual.qaConsensus).not.toHaveBeenCalled();
    expect(deps.visual.blindQa).not.toHaveBeenCalled();
    expect(deps.visual.directionSemantics).not.toHaveBeenCalled();
    expect(deps.visual.lookMechanics).not.toHaveBeenCalled();
    expect(deps.visual.identityGuide).not.toHaveBeenCalled();
  }, 120_000);

  it("runs all visual groups, packages v2 and delivers ready without touching the knowledge base", async () => {
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
      if (input.type === "package.ready" || input.type === "run.completed") throw new Error("event store unavailable after durable commit");
      return persistEvent(input);
    });
    const result = await executeCodexPetRun({ runId: seeded.run.id, deps });
    const packageDiagnostic = result.status === "packaging"
      ? (await prisma.codexPetJob.findUnique({ where: { runId_key: { runId: seeded.run.id, key: "final-package" } }, select: { error: true } }))?.error
      : undefined;
    expect(result.status, packageDiagnostic ?? undefined).toBe("ready");
    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(deps.visual.identityGuide).toHaveBeenCalledOnce();
    const identityGuideJob = await prisma.codexPetJob.findUniqueOrThrow({
      where: { runId_key: { runId: run.id, key: "identity-guide" } },
    });
    expect(identityGuideJob).toMatchObject({
      status: "completed",
      kind: "identity_guide",
      dependencyKeys: ["base-selection"],
      inputArtifactIds: [run.selectedBaseArtifactId!],
    });
    expect(identityGuideJob.output).toMatchObject({
      version: 2,
      selectedArtifactId: run.selectedBaseArtifactId,
      supportingReferenceAssetIds: [],
      guide: IDENTITY_GUIDE,
    });
    expect(deps.visual.identityGuide).toHaveBeenCalledWith(expect.objectContaining({
      originalReferences: [],
      characterBrief: "名称：蓝色测试宠；描述：端到端测试桌宠；角色设定：蓝色圆角机器人；风格：pixel",
    }));
    const generatedPrompts = (deps.visual.generate as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String((call[0] as { prompt?: string }).prompt ?? ""));
    const basePrompts = generatedPrompts.filter((prompt) => prompt.includes("main character candidate"));
    const guidedGenerationPrompts = generatedPrompts.filter((prompt) => !prompt.includes("main character candidate"));
    expect(basePrompts).toHaveLength(2);
    expect(basePrompts.every((prompt) => !prompt.includes(IDENTITY_GUIDE))).toBe(true);
    expect(guidedGenerationPrompts.length).toBeGreaterThan(0);
    expect(guidedGenerationPrompts.every((prompt) => prompt.includes(IDENTITY_GUIDE))).toBe(true);
    const consensusPrompts = consensus.mock.calls.map((call) => String((call[0] as { prompt?: string }).prompt ?? ""));
    expect(consensusPrompts.length).toBeGreaterThan(0);
    expect(consensusPrompts.every((prompt) => prompt.includes(IDENTITY_GUIDE))).toBe(true);
    const postSelectionQaPrompts = (deps.visual.qa as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String((call[0] as { prompt?: string }).prompt ?? ""))
      .filter((prompt) => !prompt.includes("Kind: base-choice"));
    expect(postSelectionQaPrompts.length).toBeGreaterThan(0);
    expect(postSelectionQaPrompts.every((prompt) => prompt.includes(IDENTITY_GUIDE))).toBe(true);
    const row9GateCall = consensus.mock.calls
      .map((call) => call[0] as { prompt?: string; images?: readonly { buffer: Buffer; mime?: string }[] })
      .find((input) => input.prompt?.includes("Pre-row-10 gate for the registered row-9 sequence"));
    expect(row9GateCall?.images).toHaveLength(5);
    expect(row9GateCall?.images?.[3]?.mime).toBe("image/png");
    expect(await sharp(row9GateCall!.images![3]!.buffer).metadata()).toMatchObject({ width: 1536, height: 208 });
    expect(row9GateCall?.images?.[4]?.mime).toBe("image/webp");
    const mirroredRunningLeftQaCall = consensus.mock.calls
      .map((call) => call[0] as { prompt?: string; images?: readonly { buffer: Buffer; mime?: string }[] })
      .find((input) => input.prompt?.includes("running-left must face/travel left"));
    expect(mirroredRunningLeftQaCall?.images).toHaveLength(3);
    expect(mirroredRunningLeftQaCall?.prompt).toContain("Bright magenta/chroma fringe at the alpha boundary is expected here and must never fail mirror suitability");
    expect(mirroredRunningLeftQaCall?.images?.[1]?.mime).toBe("image/png");
    expect(await sharp(mirroredRunningLeftQaCall!.images![1]!.buffer).metadata()).toMatchObject({ width: 768, height: 416 });
    expect(mirroredRunningLeftQaCall?.images?.[2]?.mime).toBe("image/webp");
    expect(deps.visual.lookMechanics).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining(IDENTITY_GUIDE) }));
    expect(deps.visual.blindQa).toHaveBeenCalledWith(expect.objectContaining({ identityGuide: IDENTITY_GUIDE }));
    expect(deps.visual.directionSemantics).toHaveBeenCalledWith(expect.objectContaining({ identityGuide: IDENTITY_GUIDE }));
    expect(run.progressPercent).toBe(100);
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
      directionRegistration?: {
        ok?: boolean;
        sharedScale?: number;
        sourceBoardSizes?: unknown[];
        neutralFrameArtifactId?: string;
        registeredRowArtifactIds?: string[];
        manifestArtifactId?: string;
        row9ImmutableDuringRow10Registration?: boolean;
        neutralValidationByBoard?: Array<{ ok?: boolean; medianHeightRatio?: number }>;
      };
    };
    expect(report.directionContinuity?.pairs).toHaveLength(16);
    expect(report.directionContinuity?.semanticAssessment).toBe("not-assessed");
    expect(report.directionRegistration).toMatchObject({ ok: true });
    expect(report.directionRegistration?.sharedScale).toBeGreaterThan(0);
    expect(report.directionRegistration?.sourceBoardSizes).toHaveLength(2);
    expect(report.directionRegistration).toMatchObject({
      row9ImmutableDuringRow10Registration: true,
      neutralFrameArtifactId: expect.any(String),
      manifestArtifactId: expect.any(String),
      registeredRowArtifactIds: [expect.any(String), expect.any(String)],
      neutralValidationByBoard: [expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })],
    });
    const [row9RegistrationJob, row10RegistrationJob, rawRow9Job, row10Job] = await Promise.all([
      prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: "look-a-registration" } } }),
      prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: "look-b-registration" } } }),
      prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: "look-a" } } }),
      prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: "look-b" } } }),
    ]);
    const row9RegistrationOutput = row9RegistrationJob.output as { registeredRowArtifactId: string; manifestArtifactId: string };
    expect(row9RegistrationJob).toMatchObject({ status: "completed", dependencyKeys: ["look-a", "row-idle"] });
    expect(row10RegistrationJob).toMatchObject({ status: "completed", dependencyKeys: ["look-b", "look-a-registration"] });
    expect(row10Job.dependencyKeys).toEqual(["look-a-registration"]);
    expect(row10Job.inputArtifactIds).toContain(row9RegistrationOutput.registeredRowArtifactId);
    expect(row10Job.inputArtifactIds).toContain(row9RegistrationOutput.manifestArtifactId);
    expect(row10Job.inputArtifactIds).not.toContain((rawRow9Job.output as { boardArtifactId: string }).boardArtifactId);
    const manifestArtifact = await prisma.codexPetArtifact.findUniqueOrThrow({ where: { id: row9RegistrationOutput.manifestArtifactId } });
    expect(JSON.parse((await store.load(manifestArtifact)).toString("utf8"))).toMatchObject({
      schemaVersion: "codex-pet-neutral-direction-registration-v1",
      transform: { scale: expect.any(Number), target: { bodyHeight: expect.any(Number), lowerBodyAnchorX: expect.any(Number), baseline: expect.any(Number) } },
    });
    const row9GenerationCall = (deps.visual.generate as unknown as ReturnType<typeof vi.fn>).mock.calls.find((call) => (
      String((call[0] as { prompt?: string }).prompt ?? "").includes("Direction order: 000, 022.5")
    ));
    const row9References = (row9GenerationCall?.[0] as { references?: Array<{ filename?: string }> }).references ?? [];
    expect(row9References.slice(0, 2).map((reference) => reference.filename)).toEqual([
      "look-a-approved-anchor-storyboard.png",
      "approved-canonical-base.png",
    ]);
    const directionQaCalls = (deps.visual.qaConsensus as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((call) => (
      String((call[0] as { prompt?: string }).prompt ?? "").includes("Image 1 is the complete normalized eight-pose row under review")
    ));
    expect(directionQaCalls).toHaveLength(2);
    expect((directionQaCalls[0]?.[0] as { images?: unknown[] }).images).toHaveLength(4);
    expect((directionQaCalls[1]?.[0] as { images?: unknown[] }).images).toHaveLength(5);
    const row10GenerationCall = (deps.visual.generate as unknown as ReturnType<typeof vi.fn>).mock.calls.find((call) => (
      String((call[0] as { prompt?: string }).prompt ?? "").includes("Direction order: 180, 202.5")
    ));
    const row10References = (row10GenerationCall?.[0] as { references?: Array<{ filename?: string; b64?: string }> }).references ?? [];
    expect(row10References.slice(0, 2).map((reference) => reference.filename)).toEqual([
      "look-b-screen-left-trajectory-scaffold.png",
      "approved-canonical-base.png",
    ]);
    expect(row10References.map((reference) => reference.filename)).toContain("approved-registered-look-row-9-4x2.png");
    const registeredReference = row10References.find((reference) => reference.filename === "approved-registered-look-row-9-4x2.png");
    expect(await sharp(Buffer.from(registeredReference!.b64!, "base64")).metadata()).toMatchObject({ width: 768, height: 416 });
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
    const stageEvents = await prisma.codexPetEvent.findMany({
      where: { runId: run.id, type: "stage.started", stage: "standard_generating" },
    });
    expect(stageEvents.some((event) => (
      (event.payload as { resumedAfterRepair?: boolean }).resumedAfterRepair === true
    ))).toBe(true);
    const packageArtifact = await prisma.codexPetArtifact.findUniqueOrThrow({ where: { id: run.packageArtifactId! } });
    expect((await inspectCodexPetZip(await store.load(packageArtifact))).manifest.spriteVersionNumber).toBe(2);
    // P1.2：交付不再写知识库，所以 ready 的判据里没有任何归档指针可看。P5.4 连
    // CodexPetRun.knowledgeDocumentId 那一列也退役了，这条按属主数文档的断言就是
    // 现在唯一也是更强的钉子——不管用什么键，这个用户名下什么文档都没被写出来。
    expect(await prisma.document.count({ where: { kb: { userId: run.userId } } })).toBe(0);

    expect(await executeCodexPetRun({ runId: run.id, deps: { ...deps, workerId: "identity-guide-replay-worker" } }))
      .toEqual({ status: "ready", runId: run.id });
    expect(deps.visual.identityGuide).toHaveBeenCalledOnce();

    expect(await prisma.codexPetProject.findUnique({ where: { id: seeded.project.id } })).not.toBeNull();
  }, 120_000);

  it("recovers partial and fully-written final packages without replaying visual QA or duplicating permanent artifacts", async () => {
    for (const interruptAfterKind of ["package", "validation_report"] as const) {
      const seeded = await seed(true);
      const baseStore = memoryArtifactStore();
      let interrupted = false;
      const store: CodexPetArtifactStore & { buffers: Map<string, Buffer> } = {
        buffers: baseStore.buffers,
        load: baseStore.load,
        async put(input) {
          const artifact = await baseStore.put(input);
          if (!interrupted && input.jobId && input.kind === interruptAfterKind) {
            interrupted = true;
            // The object and Artifact row exist, but the Job output does not
            // yet reference them: this is the critical process-crash window.
            throw new Error(`synthetic packaging interruption after ${interruptAfterKind}`);
          }
          return artifact;
        },
      };
      const deps = runnerDeps(store);
      const persistedEvent = deps.appendEvent;
      deps.appendEvent = vi.fn(async (input) => {
        if (input.type === "package.ready") throw new Error("package.ready event unavailable after database commit");
        return persistedEvent(input);
      });

      await expect(executeCodexPetRun({ runId: seeded.run.id, deps }))
        .resolves.toEqual({ status: "packaging", runId: seeded.run.id });
      expect(interrupted).toBe(true);
      const interruptedRun = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
      expect(interruptedRun).toMatchObject({
        status: "packaging",
        spritesheetArtifactId: null,
        packageArtifactId: null,
        previewArtifactId: null,
      });
      const interruptedJob = await prisma.codexPetJob.findUniqueOrThrow({
        where: { runId_key: { runId: seeded.run.id, key: "final-package" } },
      });
      expect(interruptedJob).toMatchObject({ kind: "final_package", status: "queued", attempt: 1, workerId: null });
      expect(interruptedJob.input).toMatchObject({
        version: 1,
        inputRevision: expect.stringMatching(/^[0-9a-f]{64}$/),
        finalAtlasChecksum: expect.stringMatching(/^[0-9a-f]{64}$/),
        validationReportChecksum: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      const orphanedCheckpoint = await prisma.codexPetArtifact.findFirstOrThrow({
        where: { runId: seeded.run.id, jobId: interruptedJob.id, kind: interruptAfterKind, status: "ready" },
      });
      expect(orphanedCheckpoint.checksum).toMatch(/^[0-9a-f]{64}$/);
      if (interruptAfterKind === "validation_report") {
        // Also cover a process dying after every per-file checkpoint but
        // immediately before the Run delivery fields are visible. The new
        // implementation commits these together, but recovery also tolerates
        // this legacy/manually-repaired complete-checkpoint state.
        const output = interruptedJob.output as Record<string, unknown>;
        const artifacts = output.artifacts as Record<string, unknown>;
        const completedArtifacts: Record<string, unknown> = {
          ...artifacts,
          validationReport: {
            artifactId: orphanedCheckpoint.id,
            checksum: orphanedCheckpoint.checksum,
            kind: orphanedCheckpoint.kind,
            sizeBytes: orphanedCheckpoint.sizeBytes,
          },
        };
        const completedKeys = ["spritesheet", "package", "preview", "directionQa", "directionBlindQa", "validationReport"];
        await prisma.codexPetJob.update({
          where: { id: interruptedJob.id },
          data: {
            output: {
              ...output,
              artifacts: completedArtifacts,
            } as Prisma.InputJsonObject,
            status: "completed",
            outputArtifactIds: completedKeys.map((key) => (
              (completedArtifacts[key] as { artifactId: string }).artifactId
            )),
            completedAt: new Date(),
            workerId: null,
          },
        });
      }

      const mocks = [
        deps.visual.generate,
        deps.visual.qa,
        deps.visual.qaConsensus,
        deps.visual.blindQa,
        deps.visual.directionSemantics,
      ] as unknown as Array<ReturnType<typeof vi.fn>>;
      const callCounts = mocks.map((mock) => mock.mock.calls.length);

      await expect(executeCodexPetRun({
        runId: seeded.run.id,
        deps: { ...deps, workerId: `packaging-recovery-${interruptAfterKind}` },
      })).resolves.toEqual({ status: "ready", runId: seeded.run.id });
      mocks.forEach((mock, index) => expect(mock.mock.calls).toHaveLength(callCounts[index]!));

      const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
      expect(run).toMatchObject({ status: "ready", progressPercent: 100 });
      expect(await prisma.document.count({ where: { kb: { userId: run.userId } } })).toBe(0);
      expect(await prisma.codexPetEvent.count({ where: { runId: run.id, type: "package.ready" } })).toBe(0);

      const finalJob = await prisma.codexPetJob.findUniqueOrThrow({
        where: { runId_key: { runId: run.id, key: "final-package" } },
      });
      expect(finalJob).toMatchObject({ status: "completed", workerId: null });
      expect(finalJob.outputArtifactIds).toHaveLength(6);
      const permanentKinds = ["spritesheet", "package", "preview", "direction_qa", "direction_blind_qa", "validation_report"];
      const permanentArtifacts = await prisma.codexPetArtifact.findMany({
        where: { runId: run.id, jobId: finalJob.id, kind: { in: permanentKinds }, status: "ready", expiresAt: null },
      });
      expect(permanentArtifacts).toHaveLength(6);
      expect(new Set(permanentArtifacts.map((artifact) => artifact.kind))).toEqual(new Set(permanentKinds));
      expect(new Set(finalJob.outputArtifactIds)).toEqual(new Set(permanentArtifacts.map((artifact) => artifact.id)));
      expect(permanentArtifacts.every((artifact) => /^[0-9a-f]{64}$/.test(artifact.checksum ?? ""))).toBe(true);
      const packageArtifact = permanentArtifacts.find((artifact) => artifact.kind === "package")!;
      expect((await inspectCodexPetZip(await store.load(packageArtifact))).manifest.spriteVersionNumber).toBe(2);
    }
  }, 240_000);

  it("keeps a recovery run at packaging until final-package bytes are recoverable", async () => {
    const seeded = await seed(false);
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);
    const sourceRunId = `failed-source-${randomUUID()}`;
    const fingerprint = createHash("sha256").update(`${sourceRunId}:${seeded.run.id}`).digest("hex");
    const snapshot = seeded.run.inputSnapshot as Prisma.JsonObject;
    await prisma.$transaction([
      prisma.codexPetRun.update({
        where: { id: seeded.run.id },
        data: {
          inputSnapshot: {
            ...snapshot,
            recovery: {
              schemaVersion: "codex-pet-recovery-v1",
              sourceRunId,
              fingerprint,
            },
          },
          status: "packaging",
          progressStage: "packaging",
          progressPercent: 94,
          progressMessage: "正在恢复已通过质检的 Codex 安装包",
          colorKey: "#ff00ff",
          imageGenerationApprovalBudget: 0,
          workerId: null,
          heartbeatAt: null,
        },
      }),
      prisma.codexPetProject.update({
        where: { id: seeded.project.id },
        data: { status: "packaging" },
      }),
    ]);
    expect(await prisma.codexPetJob.findUnique({
      where: { runId_key: { runId: seeded.run.id, key: "final-package" } },
    })).toBeNull();

    const mocks = [
      deps.visual.generate,
      deps.visual.qa,
      deps.visual.qaConsensus,
      deps.visual.blindQa,
      deps.visual.directionSemantics,
      deps.visual.lookMechanics,
      deps.visual.identityGuide,
    ] as unknown as Array<ReturnType<typeof vi.fn>>;
    const callCounts = mocks.map((mock) => mock.mock.calls.length);

    await expect(executeCodexPetRun({
      runId: seeded.run.id,
      deps: { ...deps, workerId: "recovery-before-checkpoint-worker" },
    })).resolves.toEqual({ status: "packaging", runId: seeded.run.id });
    mocks.forEach((mock, index) => expect(mock.mock.calls).toHaveLength(callCounts[index]!));

    expect(await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } })).toMatchObject({
      status: "packaging",
      progressStage: "packaging",
      progressPercent: 94,
      workerId: null,
      heartbeatAt: null,
      error: null,
    });
    expect(await prisma.codexPetProject.findUniqueOrThrow({ where: { id: seeded.project.id } }))
      .toMatchObject({ status: "packaging" });
    expect(await prisma.codexPetJob.findUnique({
      where: { runId_key: { runId: seeded.run.id, key: "final-package" } },
    })).toBeNull();

    const report = completeDeliveryValidationReport();
    const binding = codexPetFinalPackageInputRevision({ finalAtlas: Buffer.from("not-yet-checkpointed"), report });
    await prisma.codexPetJob.create({
      data: {
        projectId: seeded.project.id,
        runId: seeded.run.id,
        userId: seeded.user.id,
        key: "final-package",
        kind: "final_package",
        dependencyKeys: ["standard-atlas", "look-a", "look-b"],
        maxAttempts: 10,
        input: {
          version: 1,
          inputRevision: binding.revision,
          finalAtlasChecksum: binding.finalAtlasChecksum,
          validationReportChecksum: binding.reportChecksum,
        },
        output: {
          version: 1,
          inputRevision: binding.revision,
          petId: `recovery-${seeded.run.id}`,
          displayName: seeded.project.name,
          description: seeded.project.description,
          report,
          reportChecksum: binding.reportChecksum,
          artifacts: {},
        },
      },
    });

    await expect(executeCodexPetRun({
      runId: seeded.run.id,
      deps: { ...deps, workerId: "recovery-empty-checkpoint-worker" },
    })).resolves.toEqual({ status: "packaging", runId: seeded.run.id });
    mocks.forEach((mock, index) => expect(mock.mock.calls).toHaveLength(callCounts[index]!));
    expect(await prisma.codexPetJob.findUniqueOrThrow({
      where: { runId_key: { runId: seeded.run.id, key: "final-package" } },
    })).toMatchObject({ status: "queued", attempt: 0, workerId: null, error: null });
    expect(await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } }))
      .toMatchObject({ status: "packaging", workerId: null });
  }, 120_000);

  it("resumes from the persisted registered row-9 artifact without regenerating or re-fitting it", async () => {
    const seeded = await seed(true);
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);
    const baseGenerate = deps.visual.generate as unknown as (input: { prompt: string }) => Promise<GeneratedPetVisual>;
    let interrupted = false;
    const generate = vi.fn(async (input: { prompt: string }) => {
      if (!interrupted && input.prompt.includes("Direction order: 180, 202.5")) {
        interrupted = true;
        await prisma.codexPetRun.update({
          where: { id: seeded.run.id },
          data: { workerId: "simulated-crashed-worker", heartbeatAt: new Date() },
        });
        throw new CodexPetLeaseLostError();
      }
      return baseGenerate(input);
    });
    deps.visual.generate = generate as never;

    expect(await executeCodexPetRun({ runId: seeded.run.id, deps })).toEqual({ status: "busy", runId: seeded.run.id });
    const registrationBefore = await prisma.codexPetJob.findUniqueOrThrow({
      where: { runId_key: { runId: seeded.run.id, key: "look-a-registration" } },
    });
    expect(registrationBefore.status).toBe("completed");
    const outputBefore = registrationBefore.output as { registeredRowArtifactId: string; manifestArtifactId: string };
    const [rowArtifactBefore, manifestArtifactBefore] = await Promise.all([
      prisma.codexPetArtifact.findUniqueOrThrow({ where: { id: outputBefore.registeredRowArtifactId } }),
      prisma.codexPetArtifact.findUniqueOrThrow({ where: { id: outputBefore.manifestArtifactId } }),
    ]);
    const rowHashBefore = createHash("sha256").update(await store.load(rowArtifactBefore)).digest("hex");
    const manifestHashBefore = createHash("sha256").update(await store.load(manifestArtifactBefore)).digest("hex");
    const row9GenerationCallsBefore = generate.mock.calls.filter((call) => call[0].prompt.includes("Direction order: 000, 022.5")).length;

    await prisma.codexPetRun.update({
      where: { id: seeded.run.id },
      data: { workerId: null, heartbeatAt: null },
    });
    expect(await executeCodexPetRun({ runId: seeded.run.id, deps: { ...deps, workerId: "registered-row-resume-worker" } }))
      .toEqual({ status: "ready", runId: seeded.run.id });

    const registrationAfter = await prisma.codexPetJob.findUniqueOrThrow({
      where: { runId_key: { runId: seeded.run.id, key: "look-a-registration" } },
    });
    const outputAfter = registrationAfter.output as { registeredRowArtifactId: string; manifestArtifactId: string };
    expect(outputAfter).toEqual(expect.objectContaining(outputBefore));
    expect(outputAfter.registeredRowArtifactId).toBe(outputBefore.registeredRowArtifactId);
    expect(outputAfter.manifestArtifactId).toBe(outputBefore.manifestArtifactId);
    expect(createHash("sha256").update(await store.load(rowArtifactBefore)).digest("hex")).toBe(rowHashBefore);
    expect(createHash("sha256").update(await store.load(manifestArtifactBefore)).digest("hex")).toBe(manifestHashBefore);
    expect(generate.mock.calls.filter((call) => call[0].prompt.includes("Direction order: 000, 022.5"))).toHaveLength(row9GenerationCallsBefore);
  }, 120_000);

  it("repairs an over-wide row 10 without replacing or shrinking the approved registered row 9", async () => {
    const seeded = await seed(true);
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);
    let row10Calls = 0;
    let approvedRow9ArtifactId = "";
    let approvedRow9Hash = "";
    deps.visual.generate = vi.fn(async ({ prompt }: { prompt: string }) => {
      if (prompt.includes("Direction order: 180, 202.5")) {
        row10Calls += 1;
        if (row10Calls === 1) {
          const registration = await prisma.codexPetJob.findUniqueOrThrow({
            where: { runId_key: { runId: seeded.run.id, key: "look-a-registration" } },
          });
          approvedRow9ArtifactId = String((registration.output as { registeredRowArtifactId?: string }).registeredRowArtifactId ?? "");
          const artifact = await prisma.codexPetArtifact.findUniqueOrThrow({ where: { id: approvedRow9ArtifactId } });
          approvedRow9Hash = createHash("sha256").update(await store.load(artifact)).digest("hex");
          return syntheticVisual(prompt, undefined, 0.9);
        }
      }
      return syntheticVisual(prompt);
    }) as never;

    expect(await executeCodexPetRun({ runId: seeded.run.id, deps })).toEqual({ status: "ready", runId: seeded.run.id });
    expect(row10Calls).toBe(2);
    const [row9Registration, row10Job, approvedRow9Artifact] = await Promise.all([
      prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: seeded.run.id, key: "look-a-registration" } } }),
      prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: seeded.run.id, key: "look-b" } } }),
      prisma.codexPetArtifact.findUniqueOrThrow({ where: { id: approvedRow9ArtifactId } }),
    ]);
    expect(row10Job.attempt).toBe(2);
    expect((row9Registration.output as { registeredRowArtifactId?: string }).registeredRowArtifactId).toBe(approvedRow9ArtifactId);
    expect(approvedRow9Artifact.status).toBe("ready");
    expect(createHash("sha256").update(await store.load(approvedRow9Artifact)).digest("hex")).toBe(approvedRow9Hash);
    const failedRegistration = await prisma.codexPetArtifact.findFirstOrThrow({
      where: { runId: seeded.run.id, kind: "direction_registration_report", name: { contains: "row 10" } },
      orderBy: { createdAt: "asc" },
    });
    const failedReport = JSON.parse((await store.load(failedRegistration)).toString("utf8")) as { ok?: boolean; errors?: string[] };
    expect(failedReport.ok).toBe(false);
    expect(failedReport.errors?.some((error) => error.includes("registered-frame-outside-safe-margin") || error.includes("registered-near-edge-pixels"))).toBe(true);
  }, 120_000);

  it("reuses an interrupted running attempt instead of consuming a visual repair", async () => {
    const seeded = await seed(false);
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);
    expect(await executeCodexPetRun({ runId: seeded.run.id, deps }))
      .toEqual({ status: "awaiting_base_review", runId: seeded.run.id });
    const candidate = await prisma.codexPetArtifact.findFirstOrThrow({
      where: { runId: seeded.run.id, kind: "base_candidate", status: "ready" },
      orderBy: { createdAt: "asc" },
    });
    const promptIdentity = {
      name: seeded.project.name,
      description: seeded.project.description,
      prompt: seeded.project.prompt,
      actionPrompts: {},
      stylePreset: seeded.project.stylePreset,
      styleNotes: seeded.project.styleNotes,
      chromaKey: "#ff00ff",
      canonicalGuide: IDENTITY_GUIDE,
    };
    await prisma.codexPetRun.update({
      where: { id: seeded.run.id },
      data: {
        selectedBaseArtifactId: candidate.id,
        status: "standard_generating",
        progressStage: "standard_generating",
      },
    });
    const inputBinding = {
      inputArtifactIds: [candidate.id],
      columns: 3,
      rows: 2,
      frameCount: 6,
      promptVersion: codexPetStandardRowPromptVersion("idle"),
      prompt: buildStandardRowPrompt(promptIdentity, "idle"),
    } as const;
    await prisma.codexPetJob.create({
      data: {
        projectId: seeded.project.id,
        runId: seeded.run.id,
        userId: seeded.user.id,
        key: "row-idle",
        kind: "standard_row",
        status: "running",
        dependencyKeys: ["base-selection"],
        attempt: 2,
        maxAttempts: 3,
        input: {
          columns: 3,
          rows: 2,
          frameCount: 6,
          inputRevision: codexPetBoardInputRevision(inputBinding),
        },
        inputArtifactIds: [candidate.id],
        workerId: "interrupted-worker",
        startedAt: new Date(Date.now() - 60_000),
      },
    });
    await prisma.codexPetJob.create({
      data: {
        projectId: seeded.project.id,
        runId: seeded.run.id,
        userId: seeded.user.id,
        key: "row-running-right",
        kind: "standard_row",
        status: "running",
        dependencyKeys: ["identity-guide"],
        attempt: 2,
        maxAttempts: 3,
        // Legacy board Jobs did not persist inputRevision. Matching ordered
        // artifact ids must backfill the revision without resetting attempt.
        input: { columns: 4, rows: 2, frameCount: 8 },
        inputArtifactIds: [candidate.id],
        workerId: "interrupted-legacy-worker",
        startedAt: new Date(Date.now() - 60_000),
      },
    });

    const result = await executeCodexPetRun({
      runId: seeded.run.id,
      deps,
    });

    expect(result.status).toBe("ready");
    const idleJob = await prisma.codexPetJob.findUniqueOrThrow({
      where: { runId_key: { runId: seeded.run.id, key: "row-idle" } },
    });
    expect(idleJob.status).toBe("completed");
    expect(idleJob.attempt).toBe(2);
    const legacyRunningJob = await prisma.codexPetJob.findUniqueOrThrow({
      where: { runId_key: { runId: seeded.run.id, key: "row-running-right" } },
    });
    expect(legacyRunningJob).toMatchObject({
      status: "completed",
      attempt: 2,
      inputArtifactIds: [candidate.id],
    });
    expect(legacyRunningJob.input).toMatchObject({
      inputRevision: codexPetBoardInputRevision({
        inputArtifactIds: [candidate.id],
        columns: 4,
        rows: 2,
        frameCount: 8,
        prompt: buildStandardRowPrompt(promptIdentity, "running-right"),
      }),
    });
  }, 120_000);

  it("rejects a peak-only jumping row before visual QA and retries with an actionable full-arc prompt", async () => {
    const seeded = await seed(true);
    const store = memoryArtifactStore();
    const consensus = vi.fn(async () => passedConsensus);
    const deps = runnerDeps(store, consensus);
    let injectedPeakOnly = false;
    deps.visual.generate = vi.fn(async ({ prompt }: { prompt: string }) => {
      if (!injectedPeakOnly && prompt.includes("“jumping” animation")) {
        injectedPeakOnly = true;
        return syntheticVisual(prompt, [0, 0, 0.2, 0, 0]);
      }
      return syntheticVisual(prompt);
    }) as never;

    expect((await executeCodexPetRun({ runId: seeded.run.id, deps })).status).toBe("ready");

    const jumpingCalls = (deps.visual.generate as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String((call[0] as { prompt?: string }).prompt ?? ""))
      .filter((prompt) => prompt.includes("“jumping” animation"));
    expect(jumpingCalls).toHaveLength(2);
    expect(jumpingCalls[1]).toContain("Move the whole character visibly upward in frame 2");
    expect(jumpingCalls[1]).toContain("keep frame 4 visibly above the ground before frame 5 settles");

    const jumpingQaCalls = (consensus as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String((call[0] as { prompt?: string }).prompt ?? ""))
      .filter((prompt) => prompt.includes("Context: jumping 动作组"));
    expect(jumpingQaCalls).toHaveLength(1);
    const jumpingJob = await prisma.codexPetJob.findUniqueOrThrow({
      where: { runId_key: { runId: seeded.run.id, key: "row-jumping" } },
    });
    expect(jumpingJob.attempt).toBe(2);
    const report = await prisma.codexPetArtifact.findFirstOrThrow({
      where: { runId: seeded.run.id, jobId: jumpingJob.id, kind: "qa_report" },
    });
    const diagnostic = JSON.parse((await store.load(report)).toString("utf8")) as {
      deterministic: { jumpingArc: { errors: string[] } };
    };
    expect(diagnostic.deterministic.jumpingArc.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^jumping-arc:frame-2-rise-too-small:/),
      expect.stringMatching(/^jumping-arc:frame-4-not-airborne-before-settle:/),
    ]));
  }, 120_000);

  it("adjudicates a jumping zoom claim that contradicts shared-scale geometry", async () => {
    const seeded = await seed(true);
    const store = memoryArtifactStore();
    const scaleFailure: PetVisualQaVerdict = {
      ...passedVerdict,
      pass: false,
      score: 65,
      failures: [
        "Actual zoom detected: visible width and height increase at the peak frame",
        "Unintended scale jumps",
      ],
      repairPrompt: "keep one constant scale",
      repairRows: ["jumping"],
    };
    const consensus = vi.fn(async (input: { prompt: string; repetitions?: number }) => {
      if (input.prompt.includes("Independent jumping scale adjudication")) return passedConsensus;
      if (input.prompt.includes("Context: jumping 动作组")) {
        return {
          ...passedConsensus,
          pass: false,
          score: 65,
          verdicts: [scaleFailure],
          failures: scaleFailure.failures,
        };
      }
      return passedConsensus;
    });
    const deps = runnerDeps(store, consensus);

    expect((await executeCodexPetRun({ runId: seeded.run.id, deps })).status).toBe("ready");

    const jumpingJob = await prisma.codexPetJob.findUniqueOrThrow({
      where: { runId_key: { runId: seeded.run.id, key: "row-jumping" } },
    });
    expect(jumpingJob).toMatchObject({ status: "completed", attempt: 1 });
    const jumpingCalls = consensus.mock.calls
      .map((call) => call[0] as { prompt: string; repetitions?: number })
      .filter((input) => input.prompt.includes("jumping"));
    expect(jumpingCalls.some((input) => input.prompt.includes("one shared raster scale"))).toBe(true);
    expect(jumpingCalls.find((input) => input.prompt.includes("Independent jumping scale adjudication"))?.repetitions).toBe(3);

    const adjudication = await prisma.codexPetArtifact.findFirstOrThrow({
      where: { runId: seeded.run.id, jobId: jumpingJob.id, kind: "qa_report", name: { contains: "尺度冲突独立裁决" } },
    });
    expect(JSON.parse((await store.load(adjudication)).toString("utf8"))).toMatchObject({
      deterministic: { geometry: { widthRatio: expect.any(Number) }, jumpingArc: { ok: true } },
      initial: { pass: false },
      adjudication: { pass: true },
    });
    const warning = await prisma.codexPetEvent.findFirstOrThrow({
      where: { runId: seeded.run.id, type: "validation.warning", jobKey: "row-jumping" },
    });
    expect(warning.payload).toMatchObject({ adjudicationScore: passedConsensus.score });
  }, 120_000);

  it("runs a single-reference plush pet through packaging and delivery", async () => {
    const seeded = await seed(true, {
      referenceCount: 1,
      stylePreset: "plush",
      prompt: "保留参考图身份，制作柔软毛绒桌宠",
    });
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);
    let baseQaIndex = 0;
    deps.visual!.qa = vi.fn(async (input: { prompt: string }) => {
      if (!input.prompt.includes("Kind: base-choice")) return passedVerdict;
      baseQaIndex += 1;
      return baseQaIndex === 1
        ? { ...passedVerdict, score: 100, structure: false, failures: ["candidate-local structure failure"] }
        : { ...passedVerdict, score: 70 };
    }) as never;

    expect((await executeCodexPetRun({ runId: seeded.run.id, deps })).status).toBe("ready");
    expect(deps.loadReferenceAsset).toHaveBeenCalledOnce();
    const baseCalls = (deps.visual.generate as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as { prompt: string; references?: readonly unknown[] })
      .filter((input) => input.prompt.includes("main character candidate"));
    expect(baseCalls).toHaveLength(2);
    expect(baseCalls.every((input) => input.references?.length === 1)).toBe(true);
    const baseQaCalls = (deps.visual.qa as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as { prompt: string; images: readonly unknown[] })
      .filter((input) => input.prompt.includes("Kind: base-choice"));
    expect(baseQaCalls).toHaveLength(2);
    expect(baseQaCalls.every((input) => input.images.length === 2)).toBe(true);
    expect(baseQaCalls.every((input) => input.prompt.includes("original references in upload order"))).toBe(true);
    expect(baseQaCalls.every((input) => input.prompt.includes("same shape, color, connection and location as a real paw"))).toBe(true);
    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    const selected = await prisma.codexPetArtifact.findUniqueOrThrow({ where: { id: run.selectedBaseArtifactId! } });
    expect(selected.name).toBe("主形象候选 2");
    // 原先这里读归档文档的正文,确认风格预设写进了摘要。P1.2 之后没有摘要,
    // 交付判据回到产物本身。
    expect(await prisma.document.count({ where: { kb: { userId: seeded.user.id } } })).toBe(0);
    expect(run.packageArtifactId).toBeTruthy();
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
    const identityGuideInput = (deps.visual.identityGuide as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      originalReferences: Array<{ filename?: string }>;
      characterBrief: string;
    };
    expect(identityGuideInput.originalReferences.map((reference) => reference.filename)).toEqual(
      seeded.referenceAssetIds.map((id) => `${id}.png`),
    );
    expect(identityGuideInput.characterBrief).toBe(
      "名称：蓝色测试宠；描述：端到端测试桌宠；角色设定：保留右耳单边配件与不对称花纹，不可通过镜像改变身份；风格：painterly",
    );
    const identityGuideJob = await prisma.codexPetJob.findUniqueOrThrow({
      where: { runId_key: { runId: seeded.run.id, key: "identity-guide" } },
    });
    expect(identityGuideJob.input).toMatchObject({
      version: 2,
      supportingReferenceAssetIds: seeded.referenceAssetIds,
    });
    expect(identityGuideJob.output).toMatchObject({
      version: 2,
      supportingReferenceAssetIds: seeded.referenceAssetIds,
    });
    const generatedPrompts = (deps.visual.generate as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String((call[0] as { prompt?: string }).prompt ?? ""));
    expect(generatedPrompts.some((prompt) => prompt.includes("running-left"))).toBe(true);
    const runningLeftJob = await prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: seeded.run.id, key: "row-running-left" } } });
    expect(runningLeftJob.kind).toBe("standard_row");
    expect(runningLeftJob.input).not.toMatchObject({ derivation: "per-frame-mirror-preserve-order" });
  }, 120_000);

  it("pauses for base review and resumes from persisted candidate jobs without regenerating", async () => {
    const seeded = await seed(false);
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);
    expect((await executeCodexPetRun({ runId: seeded.run.id, deps })).status).toBe("awaiting_base_review");
    expect(deps.visual.identityGuide).not.toHaveBeenCalled();
    expect((await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } })).hasSuccessfulImage).toBe(true);
    const generate = deps.visual.generate as unknown as ReturnType<typeof vi.fn>;
    const callsAtPause = generate.mock.calls.length;
    expect((await executeCodexPetRun({ runId: seeded.run.id, deps })).status).toBe("awaiting_base_review");
    expect(generate).toHaveBeenCalledTimes(callsAtPause);
    const cursorAtPause = (await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } })).lastEventSequence;
    const candidate = await prisma.codexPetArtifact.findFirstOrThrow({ where: { runId: seeded.run.id, kind: "base_candidate" }, orderBy: { createdAt: "asc" } });
    await prisma.codexPetRun.update({ where: { id: seeded.run.id }, data: { selectedBaseArtifactId: candidate.id } });
    expect((await executeCodexPetRun({ runId: seeded.run.id, deps })).status).toBe("ready");
    expect(deps.visual.identityGuide).toHaveBeenCalledOnce();
    const identityGuideJob = await prisma.codexPetJob.findUniqueOrThrow({
      where: { runId_key: { runId: seeded.run.id, key: "identity-guide" } },
    });
    expect(identityGuideJob).toMatchObject({
      status: "completed",
      dependencyKeys: ["base-selection"],
      inputArtifactIds: [candidate.id],
      output: { version: 2, selectedArtifactId: candidate.id, supportingReferenceAssetIds: [], guide: IDENTITY_GUIDE },
    });
    expect(await executeCodexPetRun({ runId: seeded.run.id, deps: { ...deps, workerId: "manual-resume-replay-worker" } }))
      .toEqual({ status: "ready", runId: seeded.run.id });
    expect(deps.visual.identityGuide).toHaveBeenCalledOnce();
    expect(await prisma.codexPetJob.count({ where: { runId: seeded.run.id, key: { startsWith: "base-candidate-" } } })).toBe(2);
    const resumedStageEvents = await prisma.codexPetEvent.findMany({
      where: { runId: seeded.run.id, sequence: { gt: cursorAtPause }, type: "stage.started" },
      orderBy: { sequence: "asc" },
      select: { stage: true, progress: true },
    });
    expect(resumedStageEvents[0]).toMatchObject({ stage: "standard_generating", progress: 16 });
    expect(resumedStageEvents).not.toContainEqual(expect.objectContaining({ stage: "base_generating" }));
  }, 120_000);

  it("keeps a completed identity guide durable when its completion event fails", async () => {
    const seeded = await seed(true);
    const deps = runnerDeps(memoryArtifactStore());
    const persistEvent = deps.appendEvent;
    let rejectedGuideEvent = false;
    deps.appendEvent = vi.fn(async (input) => {
      if (!rejectedGuideEvent && input.type === "job.completed" && input.jobKey === "identity-guide") {
        rejectedGuideEvent = true;
        throw new Error("identity guide event store unavailable");
      }
      return persistEvent(input);
    });

    await expect(executeCodexPetRun({ runId: seeded.run.id, deps }))
      .resolves.toEqual({ status: "ready", runId: seeded.run.id });
    expect(rejectedGuideEvent).toBe(true);
    expect(deps.visual.identityGuide).toHaveBeenCalledOnce();
    const job = await prisma.codexPetJob.findUniqueOrThrow({
      where: { runId_key: { runId: seeded.run.id, key: "identity-guide" } },
    });
    expect(job).toMatchObject({
      status: "completed",
      output: expect.objectContaining({ version: 2, guide: IDENTITY_GUIDE }),
    });
  }, 30_000);

  it("restores a canonical-bound identity guide in a new active worker without another model call", async () => {
    const seeded = await seed(false);
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);
    expect(await executeCodexPetRun({ runId: seeded.run.id, deps }))
      .toEqual({ status: "awaiting_base_review", runId: seeded.run.id });
    const candidate = await prisma.codexPetArtifact.findFirstOrThrow({
      where: { runId: seeded.run.id, kind: "base_candidate", status: "ready" },
      orderBy: { createdAt: "asc" },
    });
    await prisma.codexPetRun.update({
      where: { id: seeded.run.id },
      data: { selectedBaseArtifactId: candidate.id, status: "standard_generating", progressStage: "standard_generating" },
    });
    await prisma.codexPetJob.create({
      data: {
        projectId: seeded.project.id,
        runId: seeded.run.id,
        userId: seeded.user.id,
        key: "base-selection",
        kind: "visual_qa",
        status: "completed",
        dependencyKeys: ["base-candidate-1", "base-candidate-2"],
        attempt: 1,
        output: { selectedArtifactId: candidate.id, selectionMode: "manual" },
        completedAt: new Date(),
      },
    });
    await prisma.codexPetJob.create({
      data: {
        projectId: seeded.project.id,
        runId: seeded.run.id,
        userId: seeded.user.id,
        key: "identity-guide",
        kind: "identity_guide",
        status: "completed",
        dependencyKeys: ["base-selection"],
        attempt: 1,
        input: {
          version: 2,
          selectedBaseArtifactId: candidate.id,
          supportingReferenceAssetIds: [],
          characterBriefHash: createHash("sha256")
            .update("名称：蓝色测试宠；描述：端到端测试桌宠；角色设定：蓝色圆角机器人；风格：pixel")
            .digest("hex"),
        },
        inputArtifactIds: [candidate.id],
        output: {
          version: 2,
          selectedArtifactId: candidate.id,
          supportingReferenceAssetIds: [],
          characterBriefHash: createHash("sha256")
            .update("名称：蓝色测试宠；描述：端到端测试桌宠；角色设定：蓝色圆角机器人；风格：pixel")
            .digest("hex"),
          guide: IDENTITY_GUIDE,
        },
        providerMetadata: { visualQa: VISUAL_MODEL_PROVENANCE },
        completedAt: new Date(),
      },
    });
    deps.visual.identityGuide = vi.fn(async () => { throw new Error("identity guide must be restored"); });

    expect(await executeCodexPetRun({
      runId: seeded.run.id,
      deps: { ...deps, workerId: "identity-guide-recovery-worker" },
    })).toEqual({ status: "ready", runId: seeded.run.id });
    expect(deps.visual.identityGuide).not.toHaveBeenCalled();
    const guidedPrompts = (deps.visual.generate as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String((call[0] as { prompt?: string }).prompt ?? ""))
      .filter((prompt) => !prompt.includes("main character candidate"));
    expect(guidedPrompts.length).toBeGreaterThan(0);
    expect(guidedPrompts.every((prompt) => prompt.includes(IDENTITY_GUIDE))).toBe(true);
  }, 120_000);

  it("fails an active legacy run without the GPT-only model contract", async () => {
    const seeded = await seed(true);
    const deps = runnerDeps(memoryArtifactStore());
    const snapshot = seeded.run.inputSnapshot as Record<string, unknown>;
    const { modelContractVersion: _ignoredContract, ...legacySnapshot } = snapshot;
    await prisma.codexPetRun.update({
      where: { id: seeded.run.id },
      data: { inputSnapshot: legacySnapshot as Prisma.InputJsonObject },
    });

    await expect(executeCodexPetRun({ runId: seeded.run.id, deps }))
      .rejects.toThrow("missing the required gpt-only-quality-optional-v3 model contract");
    expect(await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } }))
      .toMatchObject({ status: "failed" });
  }, 30_000);

  it("uses one approved direction call, pauses on failure, and resumes without regenerating passed standard rows", async () => {
    const seeded = await seed(true, { imageGenerationApprovalBudget: 1 });
    const store = memoryArtifactStore();
    let rejectLookA = true;
    const consensus = vi.fn(async (input: { prompt: string }) => {
      if (rejectLookA && input.prompt.includes("Kind: directions")) {
        return {
          ...passedConsensus,
          pass: false,
          score: 35,
          failures: ["look-a reverses into the 270 family"],
          verdicts: [{ ...passedVerdict, pass: false, repairPrompt: "keep the complete row on the approved screen-right half-turn" }],
        };
      }
      return passedConsensus;
    });
    const deps = runnerDeps(store, consensus);
    deps.env = { ...deps.env, CODEX_PET_IMAGE_APPROVAL_GATE: "1" };

    await expect(executeCodexPetRun({ runId: seeded.run.id, deps }))
      .resolves.toEqual({ status: "awaiting_direction_review", runId: seeded.run.id });
    const generate = deps.visual.generate as unknown as ReturnType<typeof vi.fn>;
    const firstDirectionCalls = generate.mock.calls.filter((call) => (
      String((call[0] as { prompt?: string }).prompt ?? "").includes("Direction order: 000, 022.5")
    ));
    expect(firstDirectionCalls).toHaveLength(1);
    expect(generate.mock.calls.some((call) => String((call[0] as { prompt?: string }).prompt ?? "").includes("Direction order: 180, 202.5"))).toBe(false);

    const paused = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(paused).toMatchObject({
      status: "awaiting_direction_review",
      pendingImageJobKey: "look-a",
      imageGenerationApprovalBudget: 0,
      imageGenerationCallCount: generate.mock.calls.length,
    });
    expect(await prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: seeded.run.id, key: "look-a" } } }))
      .toMatchObject({ status: "awaiting_approval", attempt: 1 });
    expect(await prisma.codexPetJob.findUnique({ where: { runId_key: { runId: seeded.run.id, key: "look-b" } } })).toBeNull();

    const callCountBeforeResume = generate.mock.calls.length;
    rejectLookA = false;
    await prisma.$transaction([
      prisma.codexPetRun.update({
        where: { id: seeded.run.id },
        data: {
          status: "direction_generating",
          progressStage: "direction_generating",
          imageGenerationApprovalBudget: 1,
          pendingImageJobKey: null,
          workerId: null,
          heartbeatAt: null,
        },
      }),
      prisma.codexPetProject.update({ where: { id: seeded.project.id }, data: { status: "direction_generating" } }),
      prisma.codexPetJob.update({
        where: { runId_key: { runId: seeded.run.id, key: "look-a" } },
        data: { status: "queued", workerId: null, completedAt: null, error: null },
      }),
    ]);

    await expect(executeCodexPetRun({ runId: seeded.run.id, deps: { ...deps, workerId: "approved-look-a-resume" } }))
      .resolves.toEqual({ status: "awaiting_direction_review", runId: seeded.run.id });
    const resumedPrompts = generate.mock.calls.slice(callCountBeforeResume)
      .map((call) => String((call[0] as { prompt?: string }).prompt ?? ""));
    expect(resumedPrompts).toHaveLength(1);
    expect(resumedPrompts[0]).toContain("Direction order: 000, 022.5");
    expect(resumedPrompts[0]).not.toContain("main character candidate");
    expect((await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } }))).toMatchObject({
      status: "awaiting_direction_review",
      pendingImageJobKey: "look-b",
      imageGenerationApprovalBudget: 0,
    });
  }, 30_000);

  it("does not consume a direction approval when the durable job-start event fails first", async () => {
    const seeded = await seed(true, { imageGenerationApprovalBudget: 1 });
    const deps = runnerDeps(memoryArtifactStore());
    const originalAppendEvent = deps.appendEvent;
    deps.appendEvent = vi.fn(async (input) => {
      if (input.type === "job.started" && input.jobKey === "look-a") {
        throw new Error("event store unavailable before direction provider call");
      }
      return originalAppendEvent(input);
    });
    const directionGenerate = deps.visual.generate as unknown as ReturnType<typeof vi.fn>;

    await expect(executeCodexPetRun({ runId: seeded.run.id, deps })).rejects.toThrow("event store unavailable");
    expect(directionGenerate).not.toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Direction order: 000, 022.5"),
    }));
    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(run.imageGenerationApprovalBudget).toBe(1);
    expect(run.imageGenerationCallCount).toBe(directionGenerate.mock.calls.length);
  }, 30_000);

  it("persists cancelled before the first image even when terminal events fail", async () => {
    const seeded = await seed(false);
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);
    const persistEvent = deps.appendEvent;
    deps.appendEvent = vi.fn(async (input) => {
      if (input.type === "run.cancelled") throw new Error("terminal event store unavailable");
      return persistEvent(input);
    });
    await prisma.codexPetRun.update({ where: { id: seeded.run.id }, data: { cancelRequested: true } });
    expect((await executeCodexPetRun({ runId: seeded.run.id, deps })).status).toBe("cancelled");
    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(run).toMatchObject({ status: "cancelled", progressStage: "cancelled", workerId: null });
    expect(run.completedAt).not.toBeNull();
  });

  it("persists failed even when terminal events fail", async () => {
    const seeded = await seed(false);
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);
    deps.visual.generate = vi.fn(async () => { throw new Error("synthetic provider failure"); }) as never;
    const persistEvent = deps.appendEvent;
    deps.appendEvent = vi.fn(async (input) => {
      if (input.type === "run.failed") throw new Error("terminal event store unavailable");
      return persistEvent(input);
    });

    await expect(executeCodexPetRun({ runId: seeded.run.id, deps })).rejects.toThrow("synthetic provider failure");

    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(run).toMatchObject({ status: "failed", progressStage: "failed", workerId: null });
    expect(run.completedAt).not.toBeNull();
  });

  it("preserves the originating base transport failure while cancelling only its sibling", async () => {
    const seeded = await seed(false);
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);
    // A sibling can only be *cancelled* if it was running, so this contract needs
    // the two base candidates in flight together. Production defaults to serial to
    // keep the pair off the same upstream quota, so pin the parallel case here.
    Object.assign(deps.env, { CODEX_PET_VISUAL_CONCURRENCY: "2" });
    deps.visual!.generate = vi.fn(async (input: { readonly prompt: string; readonly signal?: AbortSignal }) => {
      if (input.prompt.includes("Candidate variation 1")) {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
        });
      }
      await new Promise<never>((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
      });
      throw new Error("unreachable");
    }) as never;

    await expect(executeCodexPetRun({ runId: seeded.run.id, deps })).rejects.toThrow("fetch failed");

    const jobs = await prisma.codexPetJob.findMany({
      where: { runId: seeded.run.id, kind: "base_candidate" },
      orderBy: { key: "asc" },
    });
    expect(jobs.map((job) => job.status).sort()).toEqual(["cancelled", "failed"]);
    const failed = jobs.find((job) => job.status === "failed");
    const sibling = jobs.find((job) => job.status === "cancelled");
    expect(failed?.error).toContain("图片生成服务暂时不可用");
    expect(failed?.error).toContain("本次请求未重试");
    expect(failed?.providerMetadata).toMatchObject({
      failure: { category: "network", transportCode: "ECONNRESET" },
    });
    expect(sibling?.error).toBe("同一运行中的其他任务失败，当前任务已停止");

    const failureEvent = await prisma.codexPetEvent.findFirst({
      where: { runId: seeded.run.id, type: "run.failed" },
    });
    expect(failureEvent?.payload).toMatchObject({
      errorCategory: "network",
      transportCode: "ECONNRESET",
    });
    const terminalJobEvent = await prisma.codexPetEvent.findFirst({
      where: { runId: seeded.run.id, jobKey: failed?.key, type: "validation.failed" },
      orderBy: { sequence: "desc" },
    });
    expect(terminalJobEvent).toMatchObject({ stage: "failed", payload: { failureKind: "terminal" } });
    expect((terminalJobEvent?.payload as Record<string, unknown> | null)?.retryKind).toBeUndefined();
  });

  it("does not start the running-right sibling when the idle gate fails", async () => {
    const seeded = await seed(true);
    const baseStore = memoryArtifactStore();
    let terminalEventSeen = false;
    const artifactWritesAfterTerminal: string[] = [];
    const store: CodexPetArtifactStore & { buffers: Map<string, Buffer> } = {
      ...baseStore,
      async put(input) {
        if (terminalEventSeen) artifactWritesAfterTerminal.push(input.kind);
        return baseStore.put(input);
      },
    };
    const deps = runnerDeps(store);
    const lifecycle: string[] = [];

    deps.visual!.generate = vi.fn(async (input: { readonly prompt: string }) => {
      if (input.prompt.includes("“idle” animation")) {
        lifecycle.push("idle.failed");
        throw new Error("synthetic idle gate failure");
      }
      if (input.prompt.includes("“running-right” animation")) {
        lifecycle.push("running-right.started");
      }
      return syntheticVisual(input.prompt);
    }) as never;

    const persistEvent = deps.appendEvent;
    deps.appendEvent = vi.fn(async (input) => {
      if (input.type === "run.failed") {
        terminalEventSeen = true;
        lifecycle.push(input.type);
      }
      return persistEvent(input);
    });

    await expect(executeCodexPetRun({ runId: seeded.run.id, deps }))
      .rejects.toThrow("synthetic idle gate failure");

    expect(lifecycle).not.toContain("running-right.started");
    expect(lifecycle.indexOf("idle.failed")).toBeLessThan(lifecycle.indexOf("run.failed"));
    expect(artifactWritesAfterTerminal).toEqual([]);

    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(run).toMatchObject({ status: "failed" });
    expect(run.completedAt).not.toBeNull();
    expect(await prisma.codexPetArtifact.count({
      where: { runId: run.id, kind: "pose_board" },
    })).toBe(0);
    expect(await prisma.codexPetArtifact.count({
      where: { runId: run.id, createdAt: { gt: run.completedAt! } },
    })).toBe(0);

    const idleJob = await prisma.codexPetJob.findUniqueOrThrow({
      where: { runId_key: { runId: run.id, key: "row-idle" } },
    });
    expect(idleJob).toMatchObject({ status: "failed", workerId: null });
    expect(idleJob.completedAt).not.toBeNull();
    const runningRightJob = await prisma.codexPetJob.findUnique({
      where: { runId_key: { runId: run.id, key: "row-running-right" } },
    });
    expect(runningRightJob).toBeNull();

    const events = await prisma.codexPetEvent.findMany({
      where: { runId: run.id },
      orderBy: { sequence: "asc" },
    });
    const failedIndex = events.findIndex((event) => event.type === "run.failed");
    expect(failedIndex).toBeGreaterThanOrEqual(0);
    expect(events.slice(failedIndex + 1)).toEqual([]);
    expect(events.some((event, index) => index > failedIndex && event.jobKey === "row-idle")).toBe(false);
  }, 30_000);

  it("turns moderation failures into an actionable user message", async () => {
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
    expect(run).toMatchObject({ status: "failed" });
    expect(run.error).toContain("请修改提示词或更换参考图");
    expect(run.error).not.toContain("prompt was blocked");
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
      prisma.codexPetRun.update({ where: { id: cancelledSeed.run.id }, data: { status: "cancelled", progressStage: "cancelled", cancelRequested: true, completedAt: terminalAt } }),
      prisma.codexPetRun.update({ where: { id: failedSeed.run.id }, data: { status: "failed", progressStage: "failed", completedAt: terminalAt } }),
    ]);
    const cancelledDeps = runnerDeps(memoryArtifactStore());
    const failedDeps = runnerDeps(memoryArtifactStore());

    await expect(executeCodexPetRun({ runId: cancelledSeed.run.id, deps: cancelledDeps })).resolves.toEqual({ status: "cancelled", runId: cancelledSeed.run.id });
    await expect(executeCodexPetRun({ runId: failedSeed.run.id, deps: failedDeps })).resolves.toEqual({ status: "failed", runId: failedSeed.run.id });

    expect(cancelledDeps.visual.generate).not.toHaveBeenCalled();
    expect(failedDeps.visual.generate).not.toHaveBeenCalled();
    expect(await prisma.codexPetEvent.count({ where: { runId: { in: [cancelledSeed.run.id, failedSeed.run.id] } } })).toBe(0);
  });

  // P1.2:archiving 是直通阶段,不再写知识库。原先这里有四个测试覆盖
  // CodexPetJob(kind='knowledge_archive') 的可续跑归档 —— 归档失败仍交付、
  // 已交付不重试、按归属 reconcile 已有 Document、陈旧 worker 竞态。那套
  // 持久化重试机制是为「登记到知识库」这一个动作建的,写入删了它也就没了。
  // 留下的判据只有一条:崩在 archiving 的运行仍能被新 worker 接走并走到
  // ready,过程中不建任何 Document、不建归档任务。
  it("passes a crashed archiving run straight through to ready without creating a knowledge document", async () => {
    const seeded = await seed(true);
    await seedArchivingDeliverables(seeded);
    await prisma.codexPetRun.update({
      where: { id: seeded.run.id },
      data: { workerId: "archive-worker-crashed", heartbeatAt: new Date(0) },
    });
    const deps = runnerDeps(memoryArtifactStore());

    await expect(executeCodexPetRun({
      runId: seeded.run.id,
      deps: {
        ...deps,
        workerId: "archive-worker-recovery",
        env: { CODEX_PET_STALE_RUN_MS: "1", CODEX_PET_HEARTBEAT_MS: "60000" },
      },
    })).resolves.toEqual({ status: "ready", runId: seeded.run.id });

    const [run, project, archiveJobs, documents] = await Promise.all([
      prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      prisma.codexPetProject.findUniqueOrThrow({ where: { id: seeded.project.id } }),
      prisma.codexPetJob.count({ where: { runId: seeded.run.id, kind: "knowledge_archive" } }),
      prisma.document.count({ where: { kb: { userId: seeded.user.id } } }),
    ]);
    expect(run).toMatchObject({
      status: "ready",
      progressStage: "ready",
      progressPercent: 100,
      workerId: null,
      error: null,
    });
    expect(project.status).toBe("ready");
    expect(archiveJobs).toBe(0);
    expect(documents).toBe(0);
    expect(await prisma.knowledgeBase.count({ where: { userId: seeded.user.id } })).toBe(0);
    expect(deps.visual.generate).not.toHaveBeenCalled();
  });

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

  it("does not auto-select model outputs whose pass flag contradicts a failed base hard gate", async () => {
    const seeded = await seed(true);
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);
    deps.visual!.qa = vi.fn(async () => ({
      ...passedVerdict,
      pass: true,
      score: 99,
      structure: false,
      failures: ["ambiguous limb attachment"],
      repairPrompt: "make every limb attachment explicit",
    })) as never;

    await expect(executeCodexPetRun({ runId: seeded.run.id, deps })).rejects.toThrow("两个主形象候选均未通过视觉质检");
    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(run.status).toBe("failed");
    expect(run.selectedBaseArtifactId).toBeNull();
    expect(run.hasSuccessfulImage).toBe(true);
  }, 120_000);

  it("cancels the run when cancellation wins during later visual QA", async () => {
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
    expect(run.status).toBe("cancelled");
  }, 120_000);

  it("retries the independent row-10 gate before starting final assembly", async () => {
    const seeded = await seed(true);
    const store = memoryArtifactStore();
    let rejectedRow10Count = 0;
    const consensus = vi.fn(async (input: { prompt: string }) => {
      if (rejectedRow10Count < 2 && input.prompt.includes("pre-row-10 gate")) {
        rejectedRow10Count += 1;
        const requirement = rejectedRow10Count === 1
          ? "preserve the 180 anchor and repair the row-10 seam"
          : "preserve the earlier seam fix and stop the cell-4-to-5 quadrant reversal";
        return { ...passedConsensus, pass: false, failures: [requirement], verdicts: [{ ...passedVerdict, pass: false, repairPrompt: requirement }] };
      }
      return passedConsensus;
    });
    const deps = runnerDeps(store, consensus);
    const result = await executeCodexPetRun({ runId: seeded.run.id, deps });
    expect(result.status).toBe("ready");
    expect(rejectedRow10Count).toBe(2);
    const row10Job = await prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: seeded.run.id, key: "look-b" } } });
    expect(row10Job.attempt).toBe(3);
    const row10GenerationCalls = (deps.visual.generate as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as { prompt: string; references: Array<{ filename?: string }> })
      .filter((call) => call.prompt.includes("Direction order: 180, 202.5"));
    expect(row10GenerationCalls).toHaveLength(3);
    expect(row10GenerationCalls[1]!.prompt).toContain("preserve the 180 anchor and repair the row-10 seam");
    expect(row10GenerationCalls[2]!.prompt).toContain("preserve the 180 anchor and repair the row-10 seam");
    expect(row10GenerationCalls[2]!.prompt).toContain("stop the cell-4-to-5 quadrant reversal");
    expect(row10GenerationCalls[2]!.references.slice(0, 2).map((reference) => reference.filename)).toEqual([
      "look-b-screen-left-trajectory-scaffold.png",
      "approved-canonical-base.png",
    ]);
    expect(row10GenerationCalls[2]!.references.map((reference) => reference.filename))
      .toContain("previous-specialized-qa-failed-pose-board.png");
    const run = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect((run.validationReport as { row10PreGenerationGate?: { passed?: boolean } }).row10PreGenerationGate?.passed).toBe(true);
  }, 120_000);

  // 行内 row-9 前置门禁的修复循环此前没有测试覆盖（row-10 的有，validating 期重建的有）。
  // 这条把它的可观察行为全部钉住：尝试次数、累积修复要求、诊断板只在修复轮出现、
  // run.repairing 的进度/文案/job key。三份修复循环合一时靠它保证行内这份没被改掉。
  it("retries the row-9 pre-gate before starting the second look row", async () => {
    const seeded = await seed(true);
    const store = memoryArtifactStore();
    let rejectedRow9Count = 0;
    const consensus = vi.fn(async (input: { prompt: string }) => {
      if (rejectedRow9Count < 2 && input.prompt.includes("Pre-row-10 gate for the registered row-9 sequence")) {
        rejectedRow9Count += 1;
        const requirement = rejectedRow9Count === 1
          ? "preserve the 000 anchor and repair the cell-4-to-5 quadrant"
          : "preserve the earlier quadrant fix and stop the 090 screen-right reversal";
        return { ...passedConsensus, pass: false, failures: [requirement], verdicts: [{ ...passedVerdict, pass: false, repairPrompt: requirement }] };
      }
      return passedConsensus;
    });
    const deps = runnerDeps(store, consensus);
    const result = await executeCodexPetRun({ runId: seeded.run.id, deps });
    expect(result.status).toBe("ready");
    expect(rejectedRow9Count).toBe(2);
    const row9Job = await prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: seeded.run.id, key: "look-a" } } });
    expect(row9Job.attempt).toBe(3);
    const row9GenerationCalls = (deps.visual.generate as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as { prompt: string; references: Array<{ filename?: string }> })
      .filter((call) => call.prompt.includes("Direction order: 000, 022.5"));
    expect(row9GenerationCalls).toHaveLength(3);
    expect(row9GenerationCalls[1]!.prompt).toContain("preserve the 000 anchor and repair the cell-4-to-5 quadrant");
    expect(row9GenerationCalls[2]!.prompt).toContain("preserve the 000 anchor and repair the cell-4-to-5 quadrant");
    expect(row9GenerationCalls[2]!.prompt).toContain("stop the 090 screen-right reversal");
    expect(row9GenerationCalls[0]!.references.map((reference) => reference.filename))
      .not.toContain("previous-specialized-qa-failed-pose-board.png");
    expect(row9GenerationCalls[2]!.references.map((reference) => reference.filename))
      .toContain("previous-specialized-qa-failed-pose-board.png");
    expect(row9GenerationCalls[2]!.references.slice(0, 2).map((reference) => reference.filename)).toEqual([
      "look-a-approved-anchor-storyboard.png",
      "approved-canonical-base.png",
    ]);
    const repairEvents = await prisma.codexPetEvent.findMany({
      where: { runId: seeded.run.id, type: "run.repairing", jobKey: "look-a" },
      orderBy: { sequence: "asc" },
    });
    expect(repairEvents).toHaveLength(2);
    expect(repairEvents.map((event) => event.progress)).toEqual([74, 74]);
    expect(repairEvents.map((event) => event.message)).toEqual([
      "正在修复第一组观察方向，第二组尚未启动",
      "正在修复第一组观察方向，第二组尚未启动",
    ]);
    expect(repairEvents.map((event) => (event.payload as { attempt?: number; retryKind?: string }).attempt)).toEqual([1, 2]);
    expect(repairEvents.map((event) => (event.payload as { retryKind?: string }).retryKind)).toEqual(["visual", "visual"]);
  }, 120_000);

  it("resets an exhausted board job when its ordered input artifact revision changes", async () => {
    const seeded = await seed(false);
    const store = memoryArtifactStore();
    const deps = runnerDeps(store);
    expect(await executeCodexPetRun({ runId: seeded.run.id, deps }))
      .toEqual({ status: "awaiting_base_review", runId: seeded.run.id });
    const candidates = await prisma.codexPetArtifact.findMany({
      where: { runId: seeded.run.id, kind: "base_candidate", status: "ready" },
      orderBy: { createdAt: "asc" },
    });
    const selected = candidates[0]!;
    const staleInput = candidates[1]!;
    await prisma.codexPetRun.update({
      where: { id: seeded.run.id },
      data: {
        selectedBaseArtifactId: selected.id,
        status: "standard_generating",
        progressStage: "standard_generating",
      },
    });
    const staleBinding = {
      inputArtifactIds: [staleInput.id],
      columns: 3,
      rows: 2,
      frameCount: 6,
      promptVersion: codexPetStandardRowPromptVersion("idle"),
    } as const;
    const staleStartedAt = new Date(Date.now() - 120_000);
    const job = await prisma.codexPetJob.create({
      data: {
        projectId: seeded.project.id,
        runId: seeded.run.id,
        userId: seeded.user.id,
        key: "row-idle",
        kind: "standard_row",
        status: "completed",
        dependencyKeys: ["identity-guide"],
        attempt: 3,
        maxAttempts: 3,
        input: {
          columns: 3,
          rows: 2,
          frameCount: 6,
          inputRevision: codexPetBoardInputRevision(staleBinding),
        },
        inputArtifactIds: [staleInput.id],
        providerMetadata: { actualModel: "obsolete-model" },
        error: "obsolete failure",
        workerId: "obsolete-worker",
        startedAt: staleStartedAt,
        completedAt: new Date(Date.now() - 60_000),
      },
    });
    const [oldBoard, oldFrame, oldPreview] = await Promise.all([
      store.put({ userId: seeded.user.id, projectId: seeded.project.id, runId: seeded.run.id, jobId: job.id, kind: "pose_board", name: "old board", buffer: Buffer.from("old-board"), mime: "image/png" }),
      store.put({ userId: seeded.user.id, projectId: seeded.project.id, runId: seeded.run.id, jobId: job.id, kind: "frame", name: "old frame", buffer: Buffer.from("old-frame"), mime: "image/png" }),
      store.put({ userId: seeded.user.id, projectId: seeded.project.id, runId: seeded.run.id, jobId: job.id, kind: "animation_preview", name: "old preview", buffer: Buffer.from("old-preview"), mime: "image/webp" }),
    ]);
    await prisma.codexPetJob.update({
      where: { id: job.id },
      data: {
        outputArtifactIds: [oldFrame.id],
        output: { boardArtifactId: oldBoard.id, animationPreviewArtifactId: oldPreview.id },
      },
    });

    let observedReset = false;
    deps.visual.generate = vi.fn(async ({ prompt }: { prompt: string }) => {
      if (!observedReset && prompt.includes("“idle” animation")) {
        observedReset = true;
        const resetJob = await prisma.codexPetJob.findUniqueOrThrow({ where: { id: job.id } });
        const currentBinding = {
          inputArtifactIds: [selected.id],
          columns: 3,
          rows: 2,
          frameCount: 6,
          promptVersion: codexPetStandardRowPromptVersion("idle"),
          prompt,
        } as const;
        expect(resetJob).toMatchObject({
          status: "running",
          attempt: 1,
          inputArtifactIds: [selected.id],
          outputArtifactIds: [],
          output: null,
          providerMetadata: null,
          completedAt: null,
          error: null,
        });
        expect(resetJob.startedAt!.getTime()).toBeGreaterThan(staleStartedAt.getTime());
        expect(resetJob.input).toMatchObject({
          inputRevision: codexPetBoardInputRevision(currentBinding),
          inputArtifactIds: [selected.id],
        });
        const obsolete = await prisma.codexPetArtifact.findMany({
          where: { id: { in: [oldBoard.id, oldFrame.id, oldPreview.id] } },
        });
        expect(obsolete).toHaveLength(3);
        expect(obsolete.every((artifact) => artifact.status === "superseded" && artifact.expiresAt !== null)).toBe(true);
      }
      return syntheticVisual(prompt);
    }) as never;

    expect(await executeCodexPetRun({ runId: seeded.run.id, deps }))
      .toEqual({ status: "ready", runId: seeded.run.id });
    expect(observedReset).toBe(true);
    const completed = await prisma.codexPetJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(completed).toMatchObject({ status: "completed", attempt: 1, inputArtifactIds: [selected.id] });
  }, 120_000);

  it("keeps same-revision repair attempts but resets look-b after look-a produces a new dependency", async () => {
    const seeded = await seed(true);
    const store = memoryArtifactStore();
    let initialLookBFailures = 0;
    const consensus = vi.fn(async (input: { prompt: string }) => {
      if (input.prompt.includes("Context: 方向 180 到 337.5 连续顺时针观察动作") && initialLookBFailures < 2) {
        initialLookBFailures += 1;
        return {
          ...passedConsensus,
          pass: false,
          failures: [`initial look-b failure ${initialLookBFailures}`],
          verdicts: [{ ...passedVerdict, pass: false, repairPrompt: "repair the same complete look-b row" }],
        };
      }
      return passedConsensus;
    });
    const deps = runnerDeps(store, consensus);
    let rejectedFinal = false;
    let initialLookARevision = "";
    let initialLookBRevision = "";
    let initialLookABoardArtifactId = "";
    let initialRegisteredLookAArtifactId = "";
    let initialLookBOutputArtifactIds: string[] = [];
    deps.visual.qa = vi.fn(async (input: { prompt: string }) => {
      if (!rejectedFinal && input.prompt.includes("Kind: final")) {
        rejectedFinal = true;
        const [lookA, lookB, lookARegistration] = await Promise.all([
          prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: seeded.run.id, key: "look-a" } } }),
          prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: seeded.run.id, key: "look-b" } } }),
          prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: seeded.run.id, key: "look-a-registration" } } }),
        ]);
        initialLookARevision = String((lookA.input as { inputRevision?: string }).inputRevision ?? "");
        initialLookBRevision = String((lookB.input as { inputRevision?: string }).inputRevision ?? "");
        initialLookABoardArtifactId = String((lookA.output as { boardArtifactId?: string }).boardArtifactId ?? "");
        initialRegisteredLookAArtifactId = String((lookARegistration.output as { registeredRowArtifactId?: string }).registeredRowArtifactId ?? "");
        initialLookBOutputArtifactIds = [
          ...lookB.outputArtifactIds,
          String((lookB.output as { boardArtifactId?: string }).boardArtifactId ?? ""),
          String((lookB.output as { animationPreviewArtifactId?: string }).animationPreviewArtifactId ?? ""),
        ].filter(Boolean);
        expect(lookA.attempt).toBe(1);
        expect(lookB.attempt).toBe(3);
        return {
          ...passedVerdict,
          pass: false,
          failures: ["look rows need one coherent repair"],
          repairPrompt: "repair both complete direction rows while preserving their input contract",
          repairRows: ["look-a", "look-b"],
        };
      }
      return passedVerdict;
    }) as never;

    let lookBGenerationCount = 0;
    let observedChangedDependencyReset = false;
    deps.visual.generate = vi.fn(async ({ prompt }: { prompt: string }) => {
      if (prompt.includes("Direction order: 180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5")) {
        lookBGenerationCount += 1;
        if (lookBGenerationCount === 4) {
          const [lookA, lookB, lookARegistration] = await Promise.all([
            prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: seeded.run.id, key: "look-a" } } }),
            prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: seeded.run.id, key: "look-b" } } }),
            prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: seeded.run.id, key: "look-a-registration" } } }),
          ]);
          const newLookABoardArtifactId = String((lookA.output as { boardArtifactId?: string }).boardArtifactId ?? "");
          const newRegisteredLookAArtifactId = String((lookARegistration.output as { registeredRowArtifactId?: string }).registeredRowArtifactId ?? "");
          const lookBRevision = String((lookB.input as { inputRevision?: string }).inputRevision ?? "");
          expect(newLookABoardArtifactId).not.toBe(initialLookABoardArtifactId);
          expect(newRegisteredLookAArtifactId).not.toBe(initialRegisteredLookAArtifactId);
          expect(lookB).toMatchObject({ status: "running", attempt: 1, output: null, providerMetadata: null, completedAt: null });
          expect(lookB.inputArtifactIds).toContain(newRegisteredLookAArtifactId);
          expect(lookB.inputArtifactIds).not.toContain(newLookABoardArtifactId);
          expect(lookBRevision).not.toBe(initialLookBRevision);
          observedChangedDependencyReset = true;
        }
      }
      return syntheticVisual(prompt);
    }) as never;

    expect(await executeCodexPetRun({ runId: seeded.run.id, deps }))
      .toEqual({ status: "ready", runId: seeded.run.id });
    expect(initialLookBFailures).toBe(2);
    expect(rejectedFinal).toBe(true);
    expect(lookBGenerationCount).toBe(4);
    expect(observedChangedDependencyReset).toBe(true);
    const [lookA, lookB, supersededLookBArtifacts] = await Promise.all([
      prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: seeded.run.id, key: "look-a" } } }),
      prisma.codexPetJob.findUniqueOrThrow({ where: { runId_key: { runId: seeded.run.id, key: "look-b" } } }),
      prisma.codexPetArtifact.findMany({ where: { id: { in: initialLookBOutputArtifactIds } } }),
    ]);
    expect(lookA.attempt).toBe(2);
    expect((lookA.input as { inputRevision?: string }).inputRevision).toBe(initialLookARevision);
    expect(lookB.attempt).toBe(1);
    expect((lookB.input as { inputRevision?: string }).inputRevision).not.toBe(initialLookBRevision);
    expect(supersededLookBArtifacts).toHaveLength(initialLookBOutputArtifactIds.length);
    expect(supersededLookBArtifacts.every((artifact) => artifact.status === "superseded" && artifact.expiresAt !== null)).toBe(true);
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
    // P5.2 之前这里先按 runId 查一遍再 `deleteMany({ sourceModule, sourceId })`。
    // 那两列删了，改成按属主清；本文件从不建知识库，所以这一句今天恒删 0 行，
    // 留着只是别让「跑完不留脏数据」这条纪律断在这里。
    await prisma.document.deleteMany({ where: { kb: { userId: { in: cleanupUserIds } } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
  await prisma.$disconnect();
});
