import { createHash, randomUUID } from "node:crypto";
import { Prisma, type CodexPetArtifact } from "@prisma/client";
import { getPrisma } from "@ai-assistant/db";
import {
  LOOK_DIRECTIONS,
  PET_ROW_SPECS,
  assembleStandardPetAtlas,
  composeNormalizedPoseBoard,
  inspectCodexPetZip,
  registerFirstDirectionRowToNeutral,
  registerSecondDirectionRowWithManifest,
  type PetFramesByState,
} from "@ai-assistant/codex-pet-pipeline";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { CODEX_PET_PER_IMAGE_BILLING_MODE } from "./codex-pet-call-ledger.js";
import { codexPetValidationPassed } from "./codex-pet-delivery-validation.js";
import {
  buildCodexPetRecoverySeed,
  finalizeCodexPetRecovery,
  initializeCodexPetRecoveryRun,
  type CodexPetRecoveryBuildInput,
} from "./codex-pet-recovery-finalizer.js";
import type { CodexPetArtifactStore } from "./codex-pet-runner.js";

const prisma = getPrisma();
const databaseEnabled = Boolean(process.env.DATABASE_URL);
const cleanupUserIds: string[] = [];

async function petCell(input: { readonly color?: string; readonly eyeOffsetX?: number; readonly bodyOffsetX?: number } = {}): Promise<Buffer> {
  const bodyOffsetX = input.bodyOffsetX ?? 0;
  const eyeOffsetX = input.eyeOffsetX ?? 0;
  return sharp({ create: { width: 192, height: 208, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="192" height="208"><rect x="${52 + bodyOffsetX}" y="34" width="88" height="160" rx="32" fill="${input.color ?? "#2459c7"}"/><circle cx="${82 + bodyOffsetX + eyeOffsetX}" cy="88" r="9" fill="#fff"/><circle cx="${110 + bodyOffsetX + eyeOffsetX}" cy="88" r="9" fill="#fff"/></svg>`) }])
    .png()
    .toBuffer();
}

async function recoveryFixture(): Promise<CodexPetRecoveryBuildInput> {
  const standardFrames: PetFramesByState = {};
  for (const spec of PET_ROW_SPECS.slice(0, 9)) {
    standardFrames[spec.state] = await Promise.all(Array.from({ length: spec.frameCount }, (_, index) => (
      petCell({ eyeOffsetX: (index % 3) - 1 })
    )));
  }
  const neutral = standardFrames.idle![0]!;
  const lookAInput = await Promise.all(Array.from({ length: 8 }, (_, index) => petCell({ eyeOffsetX: index - 3 })));
  const lookBInput = await Promise.all(Array.from({ length: 8 }, (_, index) => petCell({ eyeOffsetX: 3 - index })));
  const [lookABoard, lookBBoard] = await Promise.all([
    composeNormalizedPoseBoard(lookAInput, { columns: 4, rows: 2, chromaKey: "#ff00ff" }),
    composeNormalizedPoseBoard(lookBInput, { columns: 4, rows: 2, chromaKey: "#ff00ff" }),
  ]);
  const registeredA = await registerFirstDirectionRowToNeutral(lookABoard, neutral, { chromaKey: "#ff00ff" });
  const registeredB = await registerSecondDirectionRowWithManifest(lookBBoard, neutral, registeredA.manifest, { chromaKey: "#ff00ff" });
  if (!registeredA.ok || !registeredB.ok) {
    throw new Error(`synthetic registration failed: ${[...registeredA.errors, ...registeredB.errors].join("; ")}`);
  }
  const standardAtlas = await assembleStandardPetAtlas(standardFrames, "webp");
  const visualProvenance = {
    requestedModel: "gpt-5.6-sol",
    actualModel: "gpt-5.6-sol",
    route: "chatgpt_model_route" as const,
  };
  return {
    petId: "recovery-test-pet",
    displayName: "恢复测试宠",
    description: "零模型调用恢复最终化测试",
    chromaKey: "#ff00ff",
    qualityInspectionEnabled: true,
    standardAtlas,
    neutralFrame: neutral,
    registeredLookAFrames: registeredA.frames,
    registeredLookBFrames: registeredB.frames,
    registrationManifest: registeredA.manifest,
    provider: {
      imageGeneration: {
        requestedModel: "gpt-image-2",
        actualModels: ["gpt-image-2-codex"],
        usage: { imageGenerationCalls: 24 },
      },
      visualQa: {
        requestedModel: "gpt-5.6-sol",
        actualModels: ["gpt-5.6-sol"],
        routes: ["chatgpt_model_route"],
      },
    },
    qa: {
      cardinalAnchor: { approved: true, directions: ["000", "090", "180", "270"] },
      directionRegistration: { ok: true, row9ImmutableDuringRow10Registration: true },
      row9PreGenerationGate: { passed: true },
      row10PreGenerationGate: { passed: true },
      blindDirectionValidation: {
        ok: true,
        reviewers: [],
        consensus: [],
        failures: [],
        warnings: [],
        modelProvenance: { requestedModel: "gpt-5.6-sol", actualModels: ["gpt-5.6-sol"], route: "chatgpt_model_route" },
      },
      directionSemantics: LOOK_DIRECTIONS.map((direction) => ({
        direction,
        verdict: "pass" as const,
        expected: direction,
        observed: direction,
        horizontalEvidence: "ordered deterministic fixture",
        verticalEvidence: "ordered deterministic fixture",
        reason: "approved recovery evidence",
        modelProvenance: visualProvenance,
      })),
      finalVisualQa: {
        pass: true,
        score: 100,
        mirrorSafe: true,
        identity: true,
        structure: true,
        semantics: true,
        continuity: true,
        warnings: [],
        failures: [],
        repairPrompt: "",
        modelProvenance: visualProvenance,
      },
    },
  };
}

function memoryArtifactStore(): CodexPetArtifactStore & { readonly buffers: Map<string, Buffer> } {
  const buffers = new Map<string, Buffer>();
  return {
    buffers,
    async put(input) {
      const id = randomUUID();
      const objectKey = `workflow/codex-pets/${input.userId}/${input.projectId}/${input.runId}/${id}`;
      buffers.set(objectKey, input.buffer);
      let width = input.width ?? null;
      let height = input.height ?? null;
      if (input.mime.startsWith("image/")) {
        const metadata = await sharp(input.buffer).metadata();
        width = metadata.width ?? width;
        height = metadata.height ?? height;
      }
      return prisma.codexPetArtifact.create({
        data: {
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
          width,
          height,
          checksum: createHash("sha256").update(input.buffer).digest("hex"),
          metadata: (input.metadata ?? {}) as Prisma.InputJsonObject,
          expiresAt: input.expiresAt,
        },
      });
    },
    async load(artifact: Pick<CodexPetArtifact, "objectKey">) {
      const value = buffers.get(artifact.objectKey);
      if (!value) throw new Error("test artifact missing");
      return value;
    },
  };
}

afterAll(async () => {
  if (cleanupUserIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.$disconnect();
});

/** A failed, lease-free source run whose billing fields the caller dictates. */
async function recoveryScenario(billing: Record<string, unknown>) {
  const suffix = randomUUID();
  const workerId = `recovery-${suffix}`;
  const user = await prisma.user.create({ data: { uid: `pet-billing-${suffix}`, username: `pet-billing-${suffix}`, passwordHash: "test" } });
  cleanupUserIds.push(user.id);
  const project = await prisma.codexPetProject.create({ data: {
    userId: user.id,
    name: "计费闸门测试宠",
    description: "账务已结清判定",
    prompt: "蓝色圆角机器人",
    stylePreset: "pixel",
    imageModel: "gpt-image-2",
    visualQaModel: "gpt-5.6-sol",
    status: "failed",
  } });
  const sourceRun = await prisma.codexPetRun.create({ data: {
    projectId: project.id,
    userId: user.id,
    inputSnapshot: {
      name: project.name,
      description: project.description,
      prompt: project.prompt,
      stylePreset: project.stylePreset,
      modelContractVersion: "selectable-visual-v2",
      requestedModel: "gpt-image-2",
      visualQaModel: "gpt-5.6-sol",
    },
    status: "failed",
    progressStage: "failed",
    progressPercent: 94,
    colorKey: "#ff00ff",
    requestedModel: "gpt-image-2",
    visualQaModel: "gpt-5.6-sol",
    imageGenerationCallCount: 24,
    hasSuccessfulImage: true,
    actualModels: ["gpt-image-2-codex"],
    startedAt: new Date(),
    completedAt: new Date(),
    ...billing,
  } as Prisma.CodexPetRunUncheckedCreateInput });
  const withRun = await prisma.codexPetProject.update({
    where: { id: project.id },
    data: { latestRunId: sourceRun.id },
  });
  return { prisma, project: withRun, user, workerId, sourceRun };
}

async function recoveryBuildInput(imageGenerationCalls: number): Promise<CodexPetRecoveryBuildInput> {
  const fixture = await recoveryFixture();
  return {
    ...fixture,
    provider: {
      ...fixture.provider,
      imageGeneration: {
        ...fixture.provider.imageGeneration,
        usage: { ...fixture.provider.imageGeneration.usage, imageGenerationCalls },
      },
    },
  };
}

/**
 * The evidence a run records when AI quality inspection is off: the deterministic
 * pixel gates still pass, but no reviewer was ever called, so blind/semantic
 * provenance is empty. This mirrors codex-pet-runner's own QA-off branch.
 */
async function uninspectedRecoveryFixture(): Promise<CodexPetRecoveryBuildInput> {
  const fixture = await recoveryFixture();
  return {
    ...fixture,
    qualityInspectionEnabled: false,
    provider: {
      ...fixture.provider,
      visualQa: { requestedModel: "gpt-5.6-sol", actualModels: [], routes: [] },
    },
    qa: {
      ...fixture.qa,
      blindDirectionValidation: { ok: true, reviewers: [], consensus: [], failures: [], warnings: [] },
      directionSemantics: [],
      finalVisualQa: {
        pass: true,
        score: 100,
        mirrorSafe: false,
        identity: true,
        structure: true,
        semantics: true,
        continuity: true,
        warnings: [],
        failures: [],
        repairPrompt: "",
      },
    },
  };
}

describe("Codex pet recovery finalizer", () => {
  it("builds a validated 1536x2288 v2 package without a model dependency", async () => {
    const result = await buildCodexPetRecoverySeed(await recoveryFixture());
    const metadata = await sharp(result.finalAtlas).metadata();
    expect(metadata).toMatchObject({ width: 1536, height: 2288, hasAlpha: true });
    expect(result.standardValidation.ok).toBe(true);
    expect(result.finalValidation.ok).toBe(true);
    expect(result.despill.ok).toBe(true);
    expect(result.continuity.ok).toBe(true);
    expect(codexPetValidationPassed(result.report)).toBe(true);
    expect((await inspectCodexPetZip(result.seed.zip)).manifest).toMatchObject({
      id: "recovery-test-pet",
      spriteVersionNumber: 2,
      spritesheetPath: "spritesheet.webp",
    });
  }, 120_000);

  it("rejects incomplete semantic evidence before producing a package", async () => {
    const fixture = await recoveryFixture();
    await expect(buildCodexPetRecoverySeed({
      ...fixture,
      qa: { ...fixture.qa, directionSemantics: fixture.qa.directionSemantics.slice(0, 15) },
    })).rejects.toThrow(/16 个方向/);
  }, 120_000);

  it("builds a package for a run whose AI quality inspection was off", async () => {
    const result = await buildCodexPetRecoverySeed(await uninspectedRecoveryFixture());
    expect(result.finalValidation.ok).toBe(true);
    expect(result.continuity.ok).toBe(true);
    expect(codexPetValidationPassed(result.report)).toBe(true);
    // The report says plainly that no reviewer ran, so it cannot be mistaken
    // for an inspected one.
    expect(result.report.modelProvenance).toMatchObject({
      visualQa: { enabled: false, requestedModel: null, actualModels: [], routes: [] },
    });
    expect(result.report.directionSemantics).toEqual([]);
  }, 120_000);

  it("refuses a quality-inspection-off recovery that claims reviewer evidence", async () => {
    const fixture = await uninspectedRecoveryFixture();
    const inspected = await recoveryFixture();
    await expect(buildCodexPetRecoverySeed({
      ...fixture,
      qa: { ...fixture.qa, directionSemantics: inspected.qa.directionSemantics },
    })).rejects.toThrow(/方向盲测或语义评审证据/);
    await expect(buildCodexPetRecoverySeed({
      ...fixture,
      provider: { ...fixture.provider, visualQa: { requestedModel: "gpt-5.6-sol", actualModels: ["gpt-5.6-sol"], routes: ["chatgpt_model_route"] } },
    })).rejects.toThrow(/不能声称调用过视觉质检模型/);
  }, 120_000);

  it("still demands the full 16-direction evidence when inspection was on", async () => {
    const fixture = await uninspectedRecoveryFixture();
    // Same empty evidence, but the run says it was inspected: that is a bypass.
    await expect(buildCodexPetRecoverySeed({
      ...fixture,
      qualityInspectionEnabled: true,
      provider: { ...fixture.provider, visualQa: { requestedModel: "gpt-5.6-sol", actualModels: ["gpt-5.6-sol"], routes: ["chatgpt_model_route"] } },
    })).rejects.toThrow(/16 个方向/);
  }, 120_000);

  it.skipIf(!databaseEnabled)("creates an idempotent zero-charge recovery, preserves source calls, and archives knowledge", async () => {
    const suffix = randomUUID();
    const workerId = `recovery-${suffix}`;
    const user = await prisma.user.create({ data: { uid: `pet-recovery-${suffix}`, username: `pet-recovery-${suffix}`, passwordHash: "test" } });
    cleanupUserIds.push(user.id);
    const project = await prisma.codexPetProject.create({ data: {
      userId: user.id,
      name: "恢复测试宠",
      description: "数据库恢复测试",
      prompt: "蓝色圆角机器人",
      stylePreset: "pixel",
      imageModel: "gpt-image-2",
      visualQaModel: "gpt-5.6-sol",
      status: "failed",
    } });
    const sourceRun = await prisma.codexPetRun.create({ data: {
      projectId: project.id,
      userId: user.id,
      inputSnapshot: {
        name: project.name,
        description: project.description,
        prompt: project.prompt,
        stylePreset: project.stylePreset,
        modelContractVersion: "selectable-visual-v2",
        requestedModel: "gpt-image-2",
        visualQaModel: "gpt-5.6-sol",
      },
      status: "failed",
      progressStage: "failed",
      progressPercent: 72,
      colorKey: "#ff00ff",
      requestedModel: "gpt-image-2",
      visualQaModel: "gpt-5.6-sol",
      imageGenerationCallCount: 24,
      hasSuccessfulImage: true,
      actualModels: ["gpt-image-2-codex"],
      startedAt: new Date(),
      billingChargeStatus: "charged",
      billingPoints: 200,
      billingRefundStatus: "refunded",
      billingRefundedAt: new Date(),
      completedAt: new Date(),
    } });
    await prisma.codexPetProject.update({ where: { id: project.id }, data: { latestRunId: sourceRun.id } });
    const store = memoryArtifactStore();
    const fixture = await recoveryFixture();
    const built: CodexPetRecoveryBuildInput = {
      ...fixture,
      provider: {
        ...fixture.provider,
        imageGeneration: {
          ...fixture.provider.imageGeneration,
          usage: { ...fixture.provider.imageGeneration.usage, imageGenerationCalls: 26 },
        },
      },
    };
    const initialized = await initializeCodexPetRecoveryRun({
      ...built,
      prisma,
      sourceRunId: sourceRun.id,
      projectId: project.id,
      userId: user.id,
      workerId,
    });
    expect(initialized).toMatchObject({
      sourceRunId: sourceRun.id,
      imageGenerationCallCount: 26,
      created: true,
    });
    const replay = await initializeCodexPetRecoveryRun({
      ...built,
      prisma,
      sourceRunId: sourceRun.id,
      projectId: project.id,
      userId: user.id,
      workerId,
    });
    expect(replay).toMatchObject({ runId: initialized.runId, created: false });
    expect(await prisma.codexPetRun.findUniqueOrThrow({ where: { id: sourceRun.id } }))
      .toMatchObject({ status: "failed", billingRefundStatus: "refunded", imageGenerationCallCount: 24, workerId: null });
    expect(await prisma.codexPetRun.findUniqueOrThrow({ where: { id: initialized.runId } }))
      .toMatchObject({ status: "packaging", billingChargeStatus: "not_required", billingPoints: 0, imageGenerationCallCount: 26, workerId });
    const result = await finalizeCodexPetRecovery({
      ...built,
      prisma,
      artifacts: store,
      runId: initialized.runId,
      projectId: project.id,
      userId: user.id,
      workerId,
    });

    const persistedRun = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: initialized.runId } });
    expect(persistedRun).toMatchObject({
      status: "ready",
      progressPercent: 100,
      imageGenerationCallCount: 26,
      knowledgeDocumentId: result.knowledgeDocumentId,
    });
    const finalKinds = await prisma.codexPetArtifact.findMany({
      where: { runId: initialized.runId, status: "ready", expiresAt: null },
      select: { kind: true },
    });
    expect(new Set(finalKinds.map((artifact) => artifact.kind))).toEqual(new Set([
      "spritesheet",
      "package",
      "preview",
      "direction_qa",
      "direction_blind_qa",
      "validation_report",
    ]));
    const document = await prisma.document.findUniqueOrThrow({ where: { id: result.knowledgeDocumentId } });
    expect(document).toMatchObject({ sourceModule: "codex_pet", sourceId: initialized.runId, mime: "application/zip" });
    const packageArtifact = await prisma.codexPetArtifact.findUniqueOrThrow({ where: { id: persistedRun.packageArtifactId! } });
    expect((await inspectCodexPetZip(await store.load(packageArtifact))).manifest.spriteVersionNumber).toBe(2);
  }, 180_000);

  // A per-image run is billed per real call. When it dies after the atlas is
  // approved, those calls genuinely happened, so nothing is refunded and
  // `billingRefundStatus` stays "none" forever. Settlement is what closes its
  // books, and recovery must key off that instead of demanding a refund that
  // can never arrive.
  it.skipIf(!databaseEnabled)("recovers a settled per-image source run that has no refund to wait for", async () => {
    const { prisma, project, user, workerId } = await recoveryScenario({
      billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
      billingChargeStatus: "reserved",
      billingPoints: 0,
      billingRefundStatus: "none",
      billingRefundedAt: null,
      billingSettlementStatus: "settled",
      billingSettledAt: new Date(),
    });
    const built = await recoveryBuildInput(26);

    const initialized = await initializeCodexPetRecoveryRun({
      ...built, prisma, sourceRunId: project.latestRunId!, projectId: project.id, userId: user.id, workerId,
    });

    expect(initialized.created).toBe(true);
    expect(await prisma.codexPetRun.findUniqueOrThrow({ where: { id: initialized.runId } }))
      .toMatchObject({ status: "packaging", billingChargeStatus: "not_required", billingPoints: 0 });
    // The source run's money is untouched by the rescue.
    expect(await prisma.codexPetRun.findUniqueOrThrow({ where: { id: project.latestRunId! } }))
      .toMatchObject({ status: "failed", billingRefundStatus: "none", billingSettlementStatus: "settled" });
  }, 180_000);

  it.skipIf(!databaseEnabled)("still refuses a per-image source run whose settlement is not closed", async () => {
    const { prisma, project, user, workerId } = await recoveryScenario({
      billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
      billingChargeStatus: "reserved",
      billingPoints: 0,
      billingRefundStatus: "none",
      billingRefundedAt: null,
      billingSettlementStatus: "reserved",
      billingSettledAt: null,
    });
    const built = await recoveryBuildInput(26);

    await expect(initializeCodexPetRecoveryRun({
      ...built, prisma, sourceRunId: project.latestRunId!, projectId: project.id, userId: user.id, workerId,
    })).rejects.toThrow("账务已结清");
  }, 180_000);

  it.skipIf(!databaseEnabled)("still refuses a points source run that was never refunded", async () => {
    const { prisma, project, user, workerId } = await recoveryScenario({
      billingChargeStatus: "charged",
      billingPoints: 200,
      billingRefundStatus: "none",
      billingRefundedAt: null,
    });
    const built = await recoveryBuildInput(26);

    await expect(initializeCodexPetRecoveryRun({
      ...built, prisma, sourceRunId: project.latestRunId!, projectId: project.id, userId: user.id, workerId,
    })).rejects.toThrow("账务已结清");
  }, 180_000);

  it.skipIf(!databaseEnabled)("carries the source run's quality-inspection posture onto the recovery run", async () => {
    const { prisma, project, user, workerId } = await recoveryScenario({
      qualityInspectionEnabled: false,
      billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
      billingChargeStatus: "reserved",
      billingPoints: 0,
      billingRefundStatus: "none",
      billingRefundedAt: null,
      billingSettlementStatus: "settled",
      billingSettledAt: new Date(),
    });
    const fixture = await uninspectedRecoveryFixture();
    const built: CodexPetRecoveryBuildInput = {
      ...fixture,
      provider: {
        ...fixture.provider,
        imageGeneration: { ...fixture.provider.imageGeneration, usage: { ...fixture.provider.imageGeneration.usage, imageGenerationCalls: 26 } },
      },
    };

    const initialized = await initializeCodexPetRecoveryRun({
      ...built, prisma, sourceRunId: project.latestRunId!, projectId: project.id, userId: user.id, workerId,
    });

    // The column defaults to true, so this asserts the value was carried over
    // rather than left at its default.
    expect(await prisma.codexPetRun.findUniqueOrThrow({ where: { id: initialized.runId } }))
      .toMatchObject({ status: "packaging", qualityInspectionEnabled: false });
  }, 180_000);

  it.skipIf(!databaseEnabled)("refuses to claim inspection was off when the source run was inspected", async () => {
    const { prisma, project, user, workerId } = await recoveryScenario({
      qualityInspectionEnabled: true,
      billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
      billingChargeStatus: "reserved",
      billingPoints: 0,
      billingRefundStatus: "none",
      billingRefundedAt: null,
      billingSettlementStatus: "settled",
      billingSettledAt: new Date(),
    });
    const fixture = await uninspectedRecoveryFixture();

    await expect(initializeCodexPetRecoveryRun({
      ...fixture,
      provider: {
        ...fixture.provider,
        imageGeneration: { ...fixture.provider.imageGeneration, usage: { ...fixture.provider.imageGeneration.usage, imageGenerationCalls: 26 } },
      },
      prisma, sourceRunId: project.latestRunId!, projectId: project.id, userId: user.id, workerId,
    })).rejects.toThrow("质检开关不一致");
  }, 180_000);
});
