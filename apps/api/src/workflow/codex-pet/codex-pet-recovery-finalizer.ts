import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  LOOK_DIRECTIONS,
  PET_ROW_SPECS,
  assemblePetAtlas,
  assembleStandardPetAtlas,
  createAtlasContactSheet,
  createDirectionBlindQaSheet,
  createDirectionQaSheet,
  createCodexPetPackage,
  despillChromaEdges,
  measureDirectionContinuity,
  parseNeutralDirectionRegistrationManifest,
  validateNeutralLockedDirectionFrames,
  validatePetAtlas,
  validateStandardPetAtlas,
  type PetFramesByState,
} from "@ai-assistant/codex-pet-pipeline";
import { archiveCodexPetRun } from "./codex-pet-archive.js";
import { CODEX_PET_PER_IMAGE_BILLING_MODE } from "./codex-pet-call-ledger.js";
import { CODEX_PET_MODEL_CONTRACT_VERSION, codexPetVisualQaRouteForModel } from "./codex-pet-model-contract.js";
import { persistOrResumeCodexPetFinalPackage, type CodexPetFinalPackageSeed } from "./codex-pet-packaging.js";
import type { CodexPetArtifactStore } from "./codex-pet-runner.js";
import type { BlindDirectionValidation, DirectionSemanticVerdict, PetVisualQaVerdict } from "./codex-pet-visual.js";
import { loadSharp } from "../../runtime/resource-limits.js";

type JsonRecord = Record<string, unknown>;

export interface CodexPetRecoveryProviderEvidence {
  readonly imageGeneration: {
    readonly requestedModel: string;
    readonly actualModels: readonly string[];
    readonly usage: Record<string, number>;
  };
  readonly visualQa: {
    readonly requestedModel: string;
    readonly actualModels: readonly string[];
    readonly routes: readonly string[];
  };
}

export interface CodexPetRecoveryQaEvidence {
  readonly cardinalAnchor: JsonRecord;
  readonly directionRegistration: JsonRecord;
  readonly row9PreGenerationGate: JsonRecord;
  readonly row10PreGenerationGate: JsonRecord;
  readonly blindDirectionValidation: BlindDirectionValidation;
  readonly directionSemantics: readonly DirectionSemanticVerdict[];
  readonly finalVisualQa: PetVisualQaVerdict;
  readonly finalRepairHistory?: readonly JsonRecord[];
}

export interface CodexPetRecoveryBuildInput {
  readonly petId: string;
  readonly displayName: string;
  readonly description: string;
  readonly chromaKey: string;
  /**
   * Must equal the source run's own setting. A run created with AI quality
   * inspection off never produced blind/semantic verdicts, so demanding them
   * back would make its recovery impossible; a run created with it on must
   * still present them. `initializeCodexPetRecoveryRun` binds this to the
   * source row so the weaker posture cannot be claimed by a caller.
   */
  readonly qualityInspectionEnabled: boolean;
  /** Either a validated 8x9 atlas or already extracted standard row frames. */
  readonly standardAtlas?: Buffer;
  readonly standardFrames?: PetFramesByState;
  readonly neutralFrame?: Buffer;
  /** Approved, registered, 8-frame rows. Each frame must already be 192x208. */
  readonly registeredLookAFrames: readonly Buffer[];
  readonly registeredLookBFrames: readonly Buffer[];
  readonly registrationManifest: unknown;
  readonly provider: CodexPetRecoveryProviderEvidence;
  readonly qa: CodexPetRecoveryQaEvidence;
  readonly inputArtifactIds?: readonly string[];
}

export interface CodexPetRecoveryBuildResult {
  readonly seed: CodexPetFinalPackageSeed;
  readonly report: JsonRecord;
  readonly standardAtlas: Buffer;
  readonly standardValidation: Awaited<ReturnType<typeof validateStandardPetAtlas>>;
  readonly finalAtlas: Buffer;
  readonly finalValidation: Awaited<ReturnType<typeof validatePetAtlas>>;
  readonly despill: Awaited<ReturnType<typeof despillChromaEdges>>["report"];
  readonly continuity: Awaited<ReturnType<typeof measureDirectionContinuity>>;
  readonly row9Validation: Awaited<ReturnType<typeof validateNeutralLockedDirectionFrames>>;
  readonly row10Validation: Awaited<ReturnType<typeof validateNeutralLockedDirectionFrames>>;
}

export interface CodexPetRecoveryFinalizeInput extends CodexPetRecoveryBuildInput {
  readonly prisma: PrismaClient;
  readonly artifacts: CodexPetArtifactStore;
  readonly runId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly workerId: string;
}

export interface CodexPetRecoveryRunInput extends CodexPetRecoveryBuildInput {
  readonly prisma: PrismaClient;
  readonly sourceRunId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly workerId: string;
}

export interface CodexPetRecoveryRunResult {
  readonly runId: string;
  readonly sourceRunId: string;
  readonly fingerprint: string;
  readonly imageGenerationCallCount: number;
  readonly created: boolean;
}

export interface CodexPetRecoveryFinalizeResult extends CodexPetRecoveryBuildResult {
  readonly package: Awaited<ReturnType<typeof persistOrResumeCodexPetFinalPackage>>;
  readonly knowledgeDocumentId: string;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requirePass(value: unknown, label: string): JsonRecord {
  const result = record(value);
  if (result.ok !== true && result.pass !== true && result.passed !== true && result.approved !== true) {
    throw new Error(`恢复最终化缺少通过的 ${label} 证据`);
  }
  return result;
}

function assertEightCells(frames: readonly Buffer[], label: string): void {
  if (frames.length !== 8) throw new Error(`${label} 必须包含完整 8 帧，不能只修补单格`);
}

async function extractStandardFrames(atlas: Buffer): Promise<PetFramesByState> {
  const sharp = await loadSharp();
  const metadata = await sharp(atlas).metadata();
  if (metadata.width !== 1536 || metadata.height !== 1872) {
    throw new Error("恢复输入的标准图集必须是 1536x1872 的 8x9 中间图集");
  }
  const frames: PetFramesByState = {};
  for (const spec of PET_ROW_SPECS.slice(0, 9)) {
    frames[spec.state] = await Promise.all(Array.from({ length: spec.frameCount }, (_, column) => (
      sharp(atlas).extract({
        left: column * 192,
        top: spec.row * 208,
        width: 192,
        height: 208,
      }).png().toBuffer()
    )));
  }
  return frames;
}

async function validateCellDimensions(frames: readonly Buffer[], label: string): Promise<void> {
  const sharp = await loadSharp();
  await Promise.all(frames.map(async (frame, index) => {
    const metadata = await sharp(frame).metadata();
    if (metadata.width !== 192 || metadata.height !== 208 || !metadata.hasAlpha) {
      throw new Error(`${label}[${index}] 必须是带透明通道的 192x208 单格`);
    }
  }));
}

function validateProviderEvidence(provider: CodexPetRecoveryProviderEvidence, qualityInspectionEnabled: boolean): void {
  const image = provider.imageGeneration;
  const visual = provider.visualQa;
  if (!image.requestedModel.trim() || image.actualModels.length === 0 || image.actualModels.some((model) => !model.trim())) {
    throw new Error("恢复最终化缺少真实生图模型来源");
  }
  // The requested model always binds to the source run, even when inspection is
  // off, so the recovery cannot be re-pointed at a different reviewer.
  if (!visual.requestedModel.trim()) {
    throw new Error("恢复最终化缺少严格匹配的视觉质检模型来源");
  }
  if (!qualityInspectionEnabled) {
    // No reviewer was ever called, so there is no provenance to present. Empty
    // is the only honest value: anything else would be invented evidence.
    if (visual.actualModels.length > 0 || visual.routes.length > 0) {
      throw new Error("质检关闭的恢复不能声称调用过视觉质检模型");
    }
    return;
  }
  if (visual.actualModels.length === 0 || visual.actualModels.some((model) => model !== visual.requestedModel)) {
    throw new Error("恢复最终化缺少严格匹配的视觉质检模型来源");
  }
  const expectedRoute = codexPetVisualQaRouteForModel(visual.requestedModel);
  if (visual.routes.length === 0 || visual.routes.some((route) => route !== expectedRoute)) {
    throw new Error("恢复最终化的视觉质检路由与所选模型不一致");
  }
}

function validateQaEvidence(qa: CodexPetRecoveryQaEvidence, qualityInspectionEnabled: boolean): void {
  // These four are deterministic pixel gates. They run regardless of whether AI
  // inspection is on, so they are required in both postures.
  requirePass(qa.cardinalAnchor, "四方向锚点");
  requirePass(qa.directionRegistration, "方向注册");
  requirePass(qa.row9PreGenerationGate, "row 9 前置门禁");
  requirePass(qa.row10PreGenerationGate, "row 10 前置门禁");
  if (!qa.blindDirectionValidation.ok) throw new Error("恢复最终化不能绕过方向盲测失败");
  if (!qualityInspectionEnabled) {
    // Mirrors what the runner records when inspection is off: no reviewers, no
    // consensus, no per-direction verdicts. Requiring emptiness here is what
    // stops a QA-enabled failure from being laundered as a QA-off recovery.
    if (qa.blindDirectionValidation.reviewers.length > 0
      || qa.blindDirectionValidation.consensus.length > 0
      || qa.directionSemantics.length > 0) {
      throw new Error("质检关闭的恢复不能声称取得方向盲测或语义评审证据");
    }
  } else if (qa.directionSemantics.length !== LOOK_DIRECTIONS.length
    || qa.directionSemantics.some((item) => item.verdict === "fail")) {
    throw new Error("恢复最终化需要 16 个方向的完整语义通过证据");
  }
  if (!qa.finalVisualQa.pass || !qa.finalVisualQa.identity || !qa.finalVisualQa.structure
    || !qa.finalVisualQa.semantics || !qa.finalVisualQa.continuity) {
    throw new Error("恢复最终化需要独立最终视觉质检通过证据");
  }
}

/**
 * Build the final v2 seed from already approved bytes. This function has no
 * model/provider dependency by design: it is the only path a recovery caller
 * may use after a failed run has produced all visual evidence.
 */
export async function buildCodexPetRecoverySeed(input: CodexPetRecoveryBuildInput): Promise<CodexPetRecoveryBuildResult> {
  validateProviderEvidence(input.provider, input.qualityInspectionEnabled);
  validateQaEvidence(input.qa, input.qualityInspectionEnabled);
  assertEightCells(input.registeredLookAFrames, "row 9");
  assertEightCells(input.registeredLookBFrames, "row 10");
  await validateCellDimensions(input.registeredLookAFrames, "row 9");
  await validateCellDimensions(input.registeredLookBFrames, "row 10");

  const standardFrames = input.standardFrames ?? (input.standardAtlas ? await extractStandardFrames(input.standardAtlas) : undefined);
  if (!standardFrames) throw new Error("恢复最终化需要标准 8x9 图集或已提取标准帧");
  for (const spec of PET_ROW_SPECS.slice(0, 9)) {
    const frames = standardFrames[spec.state];
    if (!frames || frames.length !== spec.frameCount) throw new Error(`${spec.state} 标准动作帧数量不完整`);
    await validateCellDimensions(frames, spec.state);
  }

  const standardAtlas = input.standardAtlas ?? await assembleStandardPetAtlas(standardFrames, "png");
  const standardValidation = await validateStandardPetAtlas(standardAtlas);
  if (!standardValidation.ok) throw new Error(`标准 8x9 图集验证失败：${standardValidation.errors.join("；")}`);
  const neutral = input.neutralFrame ?? standardFrames.idle?.[0];
  if (!neutral) throw new Error("恢复最终化缺少 idle 中立帧");
  const manifest = parseNeutralDirectionRegistrationManifest(input.registrationManifest);
  if (manifest.chroma.key.toLowerCase() !== input.chromaKey.toLowerCase()) {
    throw new Error("方向注册 manifest 的色键与恢复输入不一致");
  }
  const [row9Validation, row10Validation] = await Promise.all([
    validateNeutralLockedDirectionFrames(neutral, input.registeredLookAFrames, manifest.thresholds),
    validateNeutralLockedDirectionFrames(neutral, input.registeredLookBFrames, manifest.thresholds),
  ]);
  if (!row9Validation.ok || !row10Validation.ok) {
    throw new Error(`注册方向行几何验证失败：${[...row9Validation.errors, ...row10Validation.errors].join("；")}`);
  }

  const assembled = await assemblePetAtlas({
    ...standardFrames,
    "look-a": input.registeredLookAFrames,
    "look-b": input.registeredLookBFrames,
  }, "png");
  const cleaned = await despillChromaEdges(assembled, input.chromaKey);
  if (!cleaned.report.ok) throw new Error(`恢复最终化 despill 失败：残留 ${cleaned.report.remainingOpaqueKeyPixels} 个色键像素`);
  const finalValidation = await validatePetAtlas(cleaned.image, input.chromaKey);
  if (!finalValidation.ok) throw new Error(`恢复最终化 v2 图集验证失败：${finalValidation.errors.join("；")}`);
  const continuity = await measureDirectionContinuity(cleaned.image);
  if (!continuity.ok) throw new Error(`恢复最终化方向连续性失败：${continuity.errors.join("；")}`);
  const packaged = await createCodexPetPackage({
    id: input.petId,
    displayName: input.displayName,
    description: input.description,
    spritesheet: cleaned.image,
  });
  const packagedValidation = await validatePetAtlas(packaged.spritesheet, input.chromaKey);
  if (!packagedValidation.ok) throw new Error(`恢复最终化 WebP 验证失败：${packagedValidation.errors.join("；")}`);
  const [contactSheet, directionSheet, blind] = await Promise.all([
    createAtlasContactSheet(packaged.spritesheet),
    createDirectionQaSheet(packaged.spritesheet),
    createDirectionBlindQaSheet(packaged.spritesheet),
  ]);
  validateProviderEvidence(input.provider, input.qualityInspectionEnabled);
  const report: JsonRecord = {
    ok: true,
    spriteVersionNumber: 2,
    modelContractVersion: CODEX_PET_MODEL_CONTRACT_VERSION,
    requestedModel: input.provider.imageGeneration.requestedModel,
    modelProvenance: {
      imageGeneration: {
        requestedModel: input.provider.imageGeneration.requestedModel,
        actualModels: [...input.provider.imageGeneration.actualModels],
      },
      visualQa: {
        // Same shape the runner writes, so a recovered report is not mistakable
        // for an inspected one when inspection was off.
        enabled: input.qualityInspectionEnabled,
        requestedModel: input.qualityInspectionEnabled ? input.provider.visualQa.requestedModel : null,
        actualModels: [...input.provider.visualQa.actualModels],
        routes: [...input.provider.visualQa.routes],
      },
    },
    chromaKey: input.chromaKey,
    cardinalAnchor: input.qa.cardinalAnchor,
    deterministic: finalValidation,
    standardAtlasValidation: standardValidation,
    packagedSpritesheet: packagedValidation,
    chromaDespill: cleaned.report,
    directionRegistration: {
      ...input.qa.directionRegistration,
      ok: true,
      schemaVersion: manifest.schemaVersion,
      neutralValidationByBoard: [row9Validation, row10Validation],
    },
    directionContinuity: continuity,
    row9PreGenerationGate: {
      ...input.qa.row9PreGenerationGate,
      passed: true,
      deterministicContinuity: row9Validation,
    },
    row10PreGenerationGate: {
      ...input.qa.row10PreGenerationGate,
      passed: true,
      deterministicContinuity: row10Validation,
    },
    blindDirectionValidation: input.qa.blindDirectionValidation,
    directionSemantics: input.qa.directionSemantics,
    finalVisualQa: input.qa.finalVisualQa,
    finalRepairHistory: input.qa.finalRepairHistory ?? [],
    acceptableWarnings: [
      ...standardValidation.warnings,
      ...finalValidation.warnings,
      ...(cleaned.report.ok ? [] : [`despill:${cleaned.report.remainingOpaqueKeyPixels}`]),
      ...continuity.warnings.map((warning) => warning.message),
      ...input.qa.blindDirectionValidation.warnings,
      ...input.qa.directionSemantics.filter((item) => item.verdict === "warning").map((item) => `${item.direction}:${item.reason}`),
    ],
  };
  const seed: CodexPetFinalPackageSeed = {
    petId: packaged.petId,
    finalAtlas: cleaned.image,
    spritesheet: packaged.spritesheet,
    zip: packaged.zip,
    contactSheet,
    directionSheet,
    blindSheet: blind.image,
    report,
    ...(input.inputArtifactIds ? { inputArtifactIds: input.inputArtifactIds } : {}),
  };
  return {
    seed,
    report,
    standardAtlas,
    standardValidation,
    finalAtlas: cleaned.image,
    finalValidation,
    despill: cleaned.report,
    continuity,
    row9Validation,
    row10Validation,
  };
}

/**
 * Create a fresh, zero-charge packaging run for an already failed/refunded
 * source run. The source run is never mutated and no provider is contacted.
 * Building the seed first binds the new run to the exact approved bytes and
 * QA evidence that the caller is about to finalize.
 */
export async function initializeCodexPetRecoveryRun(input: CodexPetRecoveryRunInput): Promise<CodexPetRecoveryRunResult> {
  const built = await buildCodexPetRecoverySeed(input);
  const finalAtlasChecksum = sha256(built.finalAtlas);
  const reportChecksum = sha256(JSON.stringify(built.report));
  const fingerprint = sha256(`${input.sourceRunId}\0${finalAtlasChecksum}\0${reportChecksum}`);
  const recoveryRunId = `cpr_recovery_${fingerprint.slice(0, 24)}`;
  const idempotencyKey = `recovery-${fingerprint.slice(0, 48)}`;
  const usageCalls = input.provider.imageGeneration.usage.imageGenerationCalls;
  if (typeof usageCalls !== "number"
    || !Number.isSafeInteger(usageCalls)
    || usageCalls < 0
    || usageCalls < 1) {
    throw new Error("恢复运行缺少真实生图调用总数");
  }

  return input.prisma.$transaction(async (tx) => {
    const source = await tx.codexPetRun.findUnique({
      where: { id: input.sourceRunId },
      include: { project: true },
    });
    if (!source
      || source.projectId !== input.projectId
      || source.userId !== input.userId
      || source.project.id !== input.projectId
      || source.project.userId !== input.userId) {
      throw new Error("恢复源运行归属不一致");
    }
    if (source.requestedModel !== input.provider.imageGeneration.requestedModel
      || source.visualQaModel !== input.provider.visualQa.requestedModel
      || source.colorKey?.toLowerCase() !== input.chromaKey.toLowerCase()) {
      throw new Error("恢复证据与源运行的模型或色键不一致");
    }
    // The inspection posture is the source run's, not the caller's. Without this
    // a caller could pass `false` to skip the blind/semantic evidence gate on a
    // run that really was inspected and really did fail it.
    if (source.qualityInspectionEnabled !== input.qualityInspectionEnabled) {
      throw new Error("恢复证据与源运行的质检开关不一致");
    }
    // The precondition is that the source run is terminal and its money is
    // already closed out, so a zero-charge recovery cannot double-bill.
    // "Closed out" differs by billing mode: a points/package run is refunded,
    // while a per-image run is charged per real call and settled — those calls
    // genuinely happened and produced the approved atlas, so there is nothing
    // to refund and `refunded` is unreachable for it.
    const financiallyClosed = source.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE
      ? source.billingSettlementStatus === "settled" && Boolean(source.billingSettledAt)
      : source.billingRefundStatus === "refunded" && Boolean(source.billingRefundedAt);
    if (source.status !== "failed"
      || !financiallyClosed
      || source.cancelRequested
      || source.workerId) {
      throw new Error("恢复只允许从已失败且账务已结清的无 lease 源运行开始");
    }
    if (source.project.deletedAt || source.project.status === "deleting") {
      throw new Error("恢复源项目已删除或正在删除");
    }
    if (usageCalls < source.imageGenerationCallCount
      || usageCalls > source.imageGenerationCallCount + 2) {
      throw new Error("恢复生图调用总数超出源运行与两次方向 POC 的范围");
    }
    const actualImageModels = [...new Set(input.provider.imageGeneration.actualModels)];
    if (actualImageModels.length === 0
      || (source.actualModels.length > 0 && actualImageModels.some((model) => !source.actualModels.includes(model)))) {
      throw new Error("恢复生图模型来源与源运行记录不一致");
    }

    const existing = await tx.codexPetRun.findUnique({ where: { id: recoveryRunId } });
    if (existing) {
      const snapshot = record(existing.inputSnapshot);
      const recovery = record(snapshot.recovery);
      if (existing.projectId !== input.projectId
        || existing.userId !== input.userId
        || recovery.sourceRunId !== input.sourceRunId
        || recovery.fingerprint !== fingerprint
        || existing.imageGenerationCallCount !== usageCalls) {
        throw new Error("恢复运行 ID 已被其他证据占用");
      }
      if (["packaging", "archiving"].includes(existing.status) && existing.workerId !== input.workerId) {
        throw new Error("恢复运行已被其他 Worker 持有");
      }
      return {
        runId: existing.id,
        sourceRunId: input.sourceRunId,
        fingerprint,
        imageGenerationCallCount: existing.imageGenerationCallCount,
        created: false,
      };
    }
    if (source.project.latestRunId !== source.id) {
      throw new Error("源运行不是项目最新运行，拒绝覆盖更新的项目状态");
    }

    const snapshot = {
      ...record(source.inputSnapshot),
      modelContractVersion: CODEX_PET_MODEL_CONTRACT_VERSION,
      requestedModel: source.requestedModel,
      visualQaModel: source.visualQaModel,
      recovery: {
        schemaVersion: "codex-pet-recovery-v1",
        sourceRunId: input.sourceRunId,
        fingerprint,
        finalAtlasChecksum,
        reportChecksum,
        sourceImageGenerationCallCount: source.imageGenerationCallCount,
        imageGenerationCallCount: usageCalls,
      },
    } as Prisma.InputJsonObject;
    await tx.codexPetRun.create({
      data: {
        id: recoveryRunId,
        projectId: input.projectId,
        userId: input.userId,
        idempotencyKey,
        inputSnapshot: snapshot,
        status: "packaging",
        progressStage: "packaging",
        progressPercent: 94,
        progressMessage: "正在恢复已通过质检的 Codex 安装包",
        autoContinue: false,
        colorKey: input.chromaKey,
        billingPoints: 0,
        billingChargeStatus: "not_required",
        billingRefundStatus: "none",
        hasSuccessfulImage: true,
        requestedModel: source.requestedModel,
        visualQaModel: source.visualQaModel,
        // The column defaults to true, so it has to be carried over explicitly
        // or a QA-off recovery would advertise itself as inspected.
        qualityInspectionEnabled: source.qualityInspectionEnabled,
        imageGenerationCallCount: usageCalls,
        imageGenerationApprovalBudget: 0,
        actualModels: actualImageModels,
        usage: input.provider.imageGeneration.usage as Prisma.InputJsonObject,
        workerId: input.workerId,
        heartbeatAt: new Date(),
        startedAt: new Date(),
      },
    });
    await tx.codexPetProject.update({
      where: { id: input.projectId },
      data: { latestRunId: recoveryRunId, status: "packaging" },
    });
    return {
      runId: recoveryRunId,
      sourceRunId: input.sourceRunId,
      fingerprint,
      imageGenerationCallCount: usageCalls,
      created: true,
    };
  });
}

/** Persist and archive an already-approved recovery without claiming a model call. */
export async function finalizeCodexPetRecovery(input: CodexPetRecoveryFinalizeInput): Promise<CodexPetRecoveryFinalizeResult> {
  const run = await input.prisma.codexPetRun.findUnique({
    where: { id: input.runId, projectId: input.projectId, userId: input.userId },
    include: { project: true },
  });
  if (!run || run.project.id !== input.projectId || run.project.userId !== input.userId) {
    throw new Error("恢复最终化运行归属不一致");
  }
  if (run.status !== "packaging" || run.workerId !== input.workerId || run.cancelRequested) {
    throw new Error("恢复最终化只允许由当前 packaging lease 执行");
  }
  // This entry point is callable on its own, so the inspection posture is
  // re-bound to the run row rather than trusted from the caller.
  if (run.qualityInspectionEnabled !== input.qualityInspectionEnabled) {
    throw new Error("恢复最终化与运行记录的质检开关不一致");
  }
  const imageCallsBefore = run.imageGenerationCallCount;
  const built = await buildCodexPetRecoverySeed(input);
  const packaged = await persistOrResumeCodexPetFinalPackage({
    prisma: input.prisma,
    artifacts: input.artifacts,
    runId: input.runId,
    projectId: input.projectId,
    userId: input.userId,
    workerId: input.workerId,
    displayName: input.displayName,
    description: input.description,
    chromaKey: input.chromaKey,
    provider: {
      actualModels: input.provider.imageGeneration.actualModels,
      usage: input.provider.imageGeneration.usage,
    },
    seed: built.seed,
  });
  if (!packaged) throw new Error("恢复最终化未建立最终打包 checkpoint");
  const document = await archiveCodexPetRun({
    prisma: input.prisma,
    runId: input.runId,
    projectId: input.projectId,
    userId: input.userId,
    workerId: input.workerId,
  });
  const ready = await input.prisma.$transaction(async (tx) => {
    const changed = await tx.codexPetRun.updateMany({
      where: {
        id: input.runId,
        projectId: input.projectId,
        userId: input.userId,
        workerId: input.workerId,
        status: "archiving",
        knowledgeDocumentId: document.documentId,
        cancelRequested: false,
      },
      data: {
        status: "ready",
        progressStage: "ready",
        progressPercent: 100,
        progressMessage: "桌宠已完成，可安装到 Codex",
        completedAt: new Date(),
        heartbeatAt: new Date(),
        workerId: null,
        error: null,
      },
    });
    if (changed.count !== 1) return false;
    await tx.codexPetProject.updateMany({
      where: { id: input.projectId, userId: input.userId, status: { not: "deleting" } },
      data: { status: "ready" },
    });
    return true;
  });
  if (!ready) throw new Error("恢复最终化归档关联已变化，桌宠不能进入 ready");
  const finalRun = await input.prisma.codexPetRun.findUniqueOrThrow({ where: { id: input.runId }, select: { imageGenerationCallCount: true } });
  if (finalRun.imageGenerationCallCount !== imageCallsBefore) {
    throw new Error("恢复最终化意外增加了真实生图调用计数");
  }
  return { ...built, package: packaged, knowledgeDocumentId: document.documentId };
}
