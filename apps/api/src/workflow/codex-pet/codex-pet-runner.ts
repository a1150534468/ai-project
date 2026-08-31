import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { Prisma, } from "@prisma/client";
import {
  LOOK_DIRECTIONS,
  LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
  PET_ROW_SPECS,
  assemblePetAtlas,
  composeLookBScreenLeftTrajectoryReference,
  composeLookSourceBoardReference,
  chooseChromaKey,
  createAnimatedWebpPreview,
  createAtlasContactSheet,
  createCodexPetPackage,
  createDirectionBlindQaSheet,
  createDirectionQaSheet,
  createLayoutGuide,
  createLookAnchorStoryboard,
  despillChromaEdges,
  inspectCodexPetZip,
  measureDirectionContinuity,
  petRowSpec,
  validatePetAtlas,
  type DirectionRegistrationCellDiagnostics,
  type NeutralDirectionGeometryValidation,
  type NeutralDirectionRegistrationManifest,
  type PetFramesByState,
} from "@ai-assistant/codex-pet-pipeline";
import {
  DOUBAO_IMAGE_MODEL,
  GPT_IMAGE_MODEL,
} from "../_shared/image-service.js";
import {
  CODEX_PET_MODEL_CONTRACT_VERSION,
  isAllowedCodexPetImageModel,
  isAllowedCodexPetImageProvenance,
  isAllowedCodexPetVisualModel,
} from "./codex-pet-model-contract.js";
import {
  CODEX_PET_PER_IMAGE_BILLING_MODE,
  CodexPetImageCallAlreadySentError,
  CodexPetImageCallApprovalRequiredError,
  CodexPetImageCallLimitError,
} from "./codex-pet-call-ledger.js";
import { CODEX_PET_LEGACY_READ_ONLY_STATUS } from "./codex-pet-read-only-archive.js";
import {
  buildCardinalPrompt,
  buildLookRowPrompt,
  buildVisualQaPrompt,
  normalizeCodexPetActionPrompts,
} from "./codex-pet-prompts.js";
import {
  generateCodexPetIdentityGuide,
  generateCodexPetLookMechanics,
  generateCodexPetVisual,
  createSeedreamPoseBoardScaffold,
  codexPetVisualQaVerdictPasses,
  resolveCodexPetVisualQaModel,
  runBlindDirectionQa,
  runCodexPetVisualQa,
  runCodexPetVisualQaConsensus,
  runLabeledDirectionSemantics,
  type BlindDirectionValidation,
  type DirectionSemanticVerdict,
  type PetVisualQaVerdict,
} from "./codex-pet-visual.js";
import {
  CodexPetPackagingDeferredError,
  persistOrResumeCodexPetFinalPackage,
} from "./codex-pet-packaging.js";

// === 拆分模块导入（脚本维护，勿手改顺序） ===
import {
  continueAfterDurablePackaging,
  deferRecoveryPackaging,
  resumeDurablePackaging,
} from "./codex-pet-runner/runner-packaging-resume.js";
import { completeArchivingStage } from "./codex-pet-runner/runner-archive.js";
import {
  finalizeClaimedSetupFailure,
  handleCancelled,
  handleImageApprovalRequired,
  handleImageCallLedgerPause,
  handleLeaseLost,
  handlePackagingDeferred,
  handleUnexpectedFailure,
} from "./codex-pet-runner/runner-finalize.js";
import {
  createApprovedCardinalAnchor,
  getLookMechanics,
  lookRowReferences,
  registerDirectionRow,
  requireApprovedRegisteredRow,
  reviewFirstLookRow,
  reviewSecondLookRow,
  type FirstLookRowGate,
  type SecondLookRowGate,
} from "./codex-pet-runner/runner-direction.js";
import { deriveRunningLeft, runStandardRow, storeStandardAtlas } from "./codex-pet-runner/runner-standard-rows.js";
import {
  ensurePersistedBaseSelection,
  generateBaseCandidate,
  getIdentityGuide,
  selectBaseAutomatically,
} from "./codex-pet-runner/runner-base.js";
import { codexPetJumpingTargetHeight, runBoardJob } from "./codex-pet-runner/runner-board-job.js";
import { repairLookARow, repairLookBRow } from "./codex-pet-runner/runner-look-repair.js";
import {
  assertCodexPetVisualQaProvenance,
  atlasValidationErrorsWithoutCellScope,
  codexPetCoupledStandardRepairRows,
  repairRowsFromAtlasValidation,
  repairRowsFromDirectionContinuity,
  repairRowsFromFinalQa,
  summarizeProviderUsage,
  summarizeRequiredVisualJobProvenance,
} from "./codex-pet-runner/runner-provenance.js";
import {
  codexPetMaxBoardAttempts,
  putJsonArtifact,
} from "./codex-pet-runner/runner-jobs.js";
import {
  checkCancelled,
  claimRunLease,
  currentRun,
  emit,
  resumeStageIfRepairing,
  stage,
} from "./codex-pet-runner/runner-lease.js";
import {
  asRecord,
  codexPetShouldMirrorRunningLeft,
  configuredVisualConcurrency,
  customizedStandardActionStates,
  frozenPerImageCallPoints,
  imageInput,
  isCodexPetRecoverySnapshot,
  mapWithConcurrency,
  staleRunMs,
  standardActionSpecificationSummary,
} from "./codex-pet-runner/runner-util.js";
import {
  type BoardJobResult,
  CODEX_PET_ACTIVE_STATUSES,
  CodexPetCancelledError,
  type CodexPetExecutionResult,
  CodexPetGateFailureError,
  CodexPetImageApprovalRequiredError,
  CodexPetLeaseLostError,
  type CodexPetRunnerDeps,
  CodexPetStandardAtlasStructureError,
  type FinalRepairRow,
  INTERMEDIATE_TTL_MS,
  type LookBReferenceState,
  type LookRowState,
  type RunnerContext,
  type StandardRepairRow,
} from "./codex-pet-runner/runner-types.js";

// === 门面 re-export（拆分前这些符号定义在本文件，外部调用方继续从这里导入） ===
export {
  type PoseBoardSalvage,
  codexPetBoardInputRevision,
  codexPetJumpingTargetHeight,
  codexPetRepairGenerationReferences,
  codexPetShouldAttachFailedBoardForRepair,
  loadPoseBoardSalvage,
  poseBoardSalvageMetadata,
  poseBoardSalvageSlots,
  poseBoardSlotHealth,
  preferPoseBoardSalvage,
} from "./codex-pet-runner/runner-board-job.js";
export {
  assertCodexPetVisualQaProvenance,
  atlasValidationErrorsWithoutCellScope,
  codexPetCoupledStandardRepairRows,
  repairRowsFromAtlasValidation,
  repairRowsFromDirectionContinuity,
} from "./codex-pet-runner/runner-provenance.js";
export { codexPetMaxBoardAttempts } from "./codex-pet-runner/runner-jobs.js";
export { codexPetShouldMirrorRunningLeft } from "./codex-pet-runner/runner-util.js";
export {
  CODEX_PET_ACTIVE_STATUSES,
  CODEX_PET_IDLE_BOARD_PROMPT_VERSION,
  CODEX_PET_RESOURCE_KEY,
  type CodexPetArtifactPutInput,
  type CodexPetArtifactStore,
  type CodexPetEventInput,
  type CodexPetExecutionResult,
  type CodexPetExecutionStatus,
  CodexPetLeaseLostError,
  type CodexPetRunnerDeps,
  codexPetStandardRowPromptVersion,
} from "./codex-pet-runner/runner-types.js";
export { CODEX_PET_BOARD_PROMPT_VERSION } from "./codex-pet-board-version.js";

const WORKER_ID = `codex-pet-${process.pid}-${randomUUID().slice(0, 8)}`;






























































































































async function executeRun(ctx: RunnerContext): Promise<CodexPetExecutionResult> {
  let run = await currentRun(ctx);
  if (run.status === "ready") return { status: "ready", runId: ctx.runId };
  if (run.status === "failed") return { status: "failed", runId: ctx.runId };
  if (run.status === "cancelled" || run.cancelRequested) throw new CodexPetCancelledError();
  if (run.status === "archiving") return completeArchivingStage(ctx);
  if (run.status === "packaging") {
    const recoveryRun = isCodexPetRecoverySnapshot(run.inputSnapshot);
    if (recoveryRun) {
      const finalPackageJob = await ctx.prisma.codexPetJob.findUnique({
        where: { runId_key: { runId: ctx.runId, key: "final-package" } },
        select: { id: true },
      });
      if (!finalPackageJob) return deferRecoveryPackaging(ctx);
      const resumed = await resumeDurablePackaging(ctx);
      return resumed ?? deferRecoveryPackaging(ctx);
    }
    const resumed = await resumeDurablePackaging(ctx);
    if (resumed) return resumed;
    // Legacy packaging rows predate final-package checkpoints. Replay the
    // graph once to establish the new durable source/output manifest.
  }

  await stage(ctx, "base_generating", 5, "正在生成主形象候选");
  const visualConcurrency = configuredVisualConcurrency(ctx.env);
  const candidates = await mapWithConcurrency(
    [1, 2],
    visualConcurrency,
    (candidateIndex, _index, signal) => generateBaseCandidate({ ...ctx, signal }, candidateIndex),
    ctx.signal,
  );
  await checkCancelled(ctx);
  run = await currentRun(ctx);
  let selectedArtifactId = run.selectedBaseArtifactId;
  if (!selectedArtifactId && run.autoContinue && ctx.qualityInspectionEnabled) {
    selectedArtifactId = await selectBaseAutomatically(ctx, candidates);
    const selectedUpdate = await ctx.prisma.codexPetRun.updateMany({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId, cancelRequested: false }, data: { selectedBaseArtifactId: selectedArtifactId } });
    if (selectedUpdate.count !== 1) throw new CodexPetLeaseLostError();
  }
  if (!selectedArtifactId) {
    const reviewReleased = await ctx.prisma.$transaction(async (tx) => {
      const changed = await tx.codexPetRun.updateMany({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId, cancelRequested: false }, data: { status: "awaiting_base_review", progressStage: "awaiting_base_review", progressPercent: 15, progressMessage: "请选择一个主形象后继续", workerId: null, heartbeatAt: new Date() } });
      if (changed.count !== 1) return false;
      await tx.codexPetProject.updateMany({ where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } }, data: { status: "awaiting_base_review" } });
      return true;
    });
    if (!reviewReleased) throw new CodexPetLeaseLostError();
    await emit(ctx, "base.review_required", "awaiting_base_review", 15, "主形象候选已就绪，请选择后继续", { candidateArtifactIds: candidates.map((candidate) => candidate.artifact.id) });
    return { status: "awaiting_base_review", runId: ctx.runId };
  }
  const selected = candidates.find((candidate) => candidate.artifact.id === selectedArtifactId);
  if (!selected) throw new Error("选中的主形象不属于当前运行候选");
  const selectedCommitted = await ctx.prisma.$transaction(async (tx) => {
    const changed = await tx.codexPetRun.updateMany({ where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId, cancelRequested: false }, data: { selectedBaseArtifactId: selectedArtifactId } });
    if (changed.count !== 1) return false;
    const artifactChanged = await tx.codexPetArtifact.updateMany({
      where: {
        id: selectedArtifactId,
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        kind: "base_candidate",
        status: "ready",
      },
      data: {
        expiresAt: null,
        metadata: { ...asRecord(selected.artifact.metadata), selected: true } as Prisma.InputJsonValue,
      },
    });
    if (artifactChanged.count !== 1) throw new CodexPetLeaseLostError();
    return true;
  });
  if (!selectedCommitted) throw new CodexPetLeaseLostError();
  await ensurePersistedBaseSelection(ctx, selectedArtifactId);
  await emit(ctx, "stage.completed", "base_generating", 15, "主形象已确认", { selectedArtifactId });

  // Base generation and base-choice QA intentionally run without a guide:
  // the approved image does not exist yet. From this durable point onward,
  // every generation/QA prompt receives the recovered canonical guide.
  ctx.identity.canonicalGuide = await getIdentityGuide(ctx, selected);

  await stage(ctx, "standard_generating", 16, "正在制作 9 组标准动作");
  // Idle is the cheapest identity/continuity gate for the whole standard
  // stage. Keep it ahead of running-right so a bad canonical micro-loop does
  // not spend a second real image call on a sibling action that will be
  // discarded immediately. The remaining rows start only after both critical
  // gates pass.
  let idle = await runStandardRow(ctx, "idle", selected, 20);
  let jumpingTargetHeight = await codexPetJumpingTargetHeight(idle.frames);
  await resumeStageIfRepairing(ctx, "standard_generating", 25, "正在制作 9 组标准动作");
  let runningRight = await runStandardRow(ctx, "running-right", selected, 25);
  await resumeStageIfRepairing(ctx, "standard_generating", 25, "正在制作 9 组标准动作");
  let runningLeft: BoardJobResult;
  if (!ctx.qualityInspectionEnabled) {
    runningLeft = await runStandardRow(ctx, "running-left", selected, 30);
  } else if (codexPetShouldMirrorRunningLeft(runningRight.mirrorSafe, ctx.identity.actionPrompts)) {
    try {
      runningLeft = await deriveRunningLeft(ctx, runningRight, selected);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "MIRROR_NOT_SAFE") throw error;
      runningLeft = await runStandardRow(ctx, "running-left", selected, 30, true, "Do not mirror: preserve asymmetric markings, prop handedness and leftward action explicitly.");
    }
  } else {
    runningLeft = await runStandardRow(ctx, "running-left", selected, 30);
  }
  await resumeStageIfRepairing(ctx, "standard_generating", 30, "正在制作 9 组标准动作");
  const remainingStates = ["waving", "jumping", "failed", "waiting", "running", "review"] as const;
  const remaining = new Map<(typeof remainingStates)[number], BoardJobResult>();
  // Keep the rest of the standard graph ordered as well. This prevents five
  // unrelated paid calls from being in flight when one action fails QA, which
  // is especially important for a user-requested single acceptance run.
  const remainingResults: BoardJobResult[] = [];
  for (const [index, stateName] of remainingStates.entries()) {
    remainingResults.push(await runStandardRow(
      ctx,
      stateName,
      selected,
      35 + index * 5,
      false,
      "",
      "standard_generating",
      stateName === "jumping" ? jumpingTargetHeight : undefined,
    ));
  }
  await resumeStageIfRepairing(ctx, "standard_generating", 60, "9 组标准动作已通过逐组检查，正在组装中间图集");
  remainingStates.forEach((stateName, index) => remaining.set(stateName, remainingResults[index]!));
  const frames: PetFramesByState = {
    idle: idle.frames,
    "running-right": runningRight.frames,
    "running-left": runningLeft.frames,
    waving: remaining.get("waving")!.frames,
    jumping: remaining.get("jumping")!.frames,
    failed: remaining.get("failed")!.frames,
    waiting: remaining.get("waiting")!.frames,
    running: remaining.get("running")!.frames,
    review: remaining.get("review")!.frames,
  };
  // Assembling the intermediate is the first moment all nine action groups are
  // graded together. A rejection here names its cells, so regenerate only the
  // implicated groups instead of failing a run that already paid for eleven
  // boards; each repair is one extra call that the caller still has to approve
  // under per-image billing.
  const standardAtlasMaxAttempts = 2;
  let assembledStandard: Awaited<ReturnType<typeof storeStandardAtlas>> | null = null;
  for (let standardAttempt = 1; standardAttempt <= standardAtlasMaxAttempts; standardAttempt += 1) {
    try {
      assembledStandard = await storeStandardAtlas(ctx, frames, standardAttempt > 1);
      break;
    } catch (error) {
      if (!(error instanceof CodexPetStandardAtlasStructureError)) throw error;
      const rows = repairRowsFromAtlasValidation(error.validation);
      const unscoped = atlasValidationErrorsWithoutCellScope(error.validation);
      if (unscoped.length > 0 || rows.length === 0) throw error;
      if (standardAttempt >= standardAtlasMaxAttempts) {
        throw new CodexPetGateFailureError(
          error.message,
          "standard-atlas-structure",
          rows,
          [...error.validation.errors],
        );
      }
      const failures = [...error.validation.errors];
      const repairHint = `修复以下动作组的结构缺陷（单元格空白、越界或未用格位不透明）：${failures.slice(0, 20).join("；")}`;
      await emit(ctx, "run.repairing", "repairing", 62, `标准图集结构缺陷动作组修复 ${standardAttempt}/${standardAtlasMaxAttempts - 1}`, { retryKind: "visual", rows, failures });
      const standardRows = codexPetCoupledStandardRepairRows(
        rows.filter((row): row is StandardRepairRow => row !== "look-a" && row !== "look-b"),
      );
      const progressByState: Record<string, number> = { idle: 20, "running-right": 25, "running-left": 30, waving: 35, jumping: 40, failed: 45, waiting: 50, running: 55, review: 60 };
      for (const state of standardRows) {
        const result = await runStandardRow(
          ctx,
          state,
          selected,
          progressByState[state] ?? 60,
          true,
          repairHint,
          "standard_generating",
          state === "jumping" ? jumpingTargetHeight : undefined,
        );
        if (state === "idle") {
          idle = result;
          jumpingTargetHeight = await codexPetJumpingTargetHeight(idle.frames);
        }
        else if (state === "running-right") runningRight = result;
        else if (state === "running-left") runningLeft = result;
        else remaining.set(state, result);
        frames[state] = result.frames;
      }
      await resumeStageIfRepairing(ctx, "standard_generating", 62, "标准动作结构修复完成，正在重新组装中间图集");
    }
  }
  if (!assembledStandard) throw new Error("标准 8×9 图集没有生成完整报告");
  let standard = assembledStandard;
  await emit(ctx, "stage.completed", "standard_generating", 65, "9 组标准动作已完成", { contactArtifactId: standard.contactArtifact.id });

  await stage(ctx, "direction_generating", 65, "正在制作 16 个观察方向");
  const mechanics = await getLookMechanics(ctx, selected);
  const cardinalLayout = ctx.imageModel === DOUBAO_IMAGE_MODEL
    ? await createSeedreamPoseBoardScaffold({ canonical: selected.buffer, chromaKey: ctx.identity.chromaKey, columns: 2, rows: 2, frameCount: 4 })
    : await createLayoutGuide({ columns: 2, rows: 2, frameCount: 4, title: "Four cardinal look anchors: up, right, down, left" });
  let cardinals = await runBoardJob(ctx, {
    key: "look-cardinals",
    kind: "look_cardinals",
    dependencies: ["look-mechanics", "standard-atlas"],
    inputArtifactIds: [selected.artifact.id, standard.contactArtifact.id],
    prompt: buildCardinalPrompt(ctx.identity, mechanics),
    // The canonical character and deterministic 2x2 guide fully define this
    // board. Uploading the large standard contact sheet as a third image adds
    // no cardinal evidence and can push relay edits past its first-response
    // window. Keep the contact artifact in job provenance/dependencies, but
    // do not send it to the model for this request.
    references: [imageInput(selected.buffer, selected.artifact.mime, "canonical-base.png"), imageInput(cardinalLayout, "image/png", "cardinal-layout.png")],
    columns: 2,
    rows: 2,
    frameCount: 4,
    progress: 68,
    qaKind: "cardinals",
    qaContext: "四个方向锚点必须明确为 000 向上、090 屏幕右、180 向下、270 屏幕左",
    qaRepetitions: 3,
  });
  let cardinalAnchor = await createApprovedCardinalAnchor(ctx, cardinals);
  await resumeStageIfRepairing(ctx, "direction_generating", 68, "四个观察方向锚点已通过，正在生成第一组方向");
  const lookLayout = ctx.imageModel === DOUBAO_IMAGE_MODEL
    ? await createSeedreamPoseBoardScaffold({ canonical: selected.buffer, chromaKey: ctx.identity.chromaKey, columns: 4, rows: 2, frameCount: 8 })
    : await createLayoutGuide({
        columns: 4,
        rows: 2,
        frameCount: 8,
        title: "Eight clockwise look directions · follow the row-major frame numbers",
        slotLabels: ["1", "2", "3", "4", "5", "6", "7", "8"],
      });
  let lookAAnchorStoryboard = await createLookAnchorStoryboard(cardinalAnchor.buffer, "look-a", ctx.identity.chromaKey);
  let lookBAnchorStoryboard = await createLookAnchorStoryboard(cardinalAnchor.buffer, "look-b", ctx.identity.chromaKey);
  const initialLookA = await runBoardJob(ctx, {
    key: "look-a",
    kind: "look_row",
    dependencies: ["look-cardinals"],
    inputArtifactIds: [selected.artifact.id, cardinalAnchor.artifact.id, standard.contactArtifact.id],
    prompt: buildLookRowPrompt(ctx.identity, "look-a", mechanics),
    references: lookRowReferences({
      row: "look-a",
      anchorStoryboard: lookAAnchorStoryboard,
      canonical: { buffer: selected.buffer, mime: selected.artifact.mime },
      cardinalAnchor: { buffer: cardinalAnchor.buffer, mime: cardinalAnchor.artifact.mime },
      standardContact: standard.contact,
      layout: lookLayout,
    }),
    columns: 4,
    rows: 2,
    frameCount: 8,
    frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
    progress: 72,
    qaKind: "directions",
    qaContext: "方向 000 到 157.5 的连续顺时针观察动作",
    animationDurations: petRowSpec("look-a").durations,
  });
  let neutralDirectionFrame = { artifact: idle.frameArtifacts[0]!, buffer: idle.frames[0]! };
  const initialRegisteredLookA = await registerDirectionRow(ctx, {
    row: "look-a",
    source: initialLookA,
    neutral: neutralDirectionFrame,
    progress: 73,
  });
  // 三份 look 修复循环读写的是同一组「生成结果 / 注册结果 / 门禁结论」，
  // 收进一个对象后修复循环才能提成函数（阶段 2 Task 2.2），闭包也不再需要捕获裸 let。
  const lookARow: LookRowState<FirstLookRowGate> = {
    row: initialLookA,
    registered: initialRegisteredLookA,
    gate: await reviewFirstLookRow(ctx, { look: initialRegisteredLookA, canonical: selected, standardContact: standard.contact, cardinalAnchor }),
  };
  await repairLookARow(ctx, {
    state: lookARow,
    deps: {
      mechanics,
      canonical: selected,
      cardinalAnchor,
      standardContact: standard.contact,
      standardContactArtifactId: standard.contactArtifact.id,
      layout: lookLayout,
      neutral: neutralDirectionFrame,
      anchorStoryboard: lookAAnchorStoryboard,
    },
    options: {
      progress: 74,
      registerProgress: 73,
      initialHint: null,
      gateFallbackHint: "Keep the complete 000 through 157.5 row on one monotonic clockwise screen-right arc.",
      exhaustedPrefix: "方向 000 到 157.5 未通过 row-10 前置门禁",
      budgetExhausted: "approval-gate",
      emitRepairing: true,
    },
  });
  requireApprovedRegisteredRow(lookARow.registered, "第一组观察方向");
  await resumeStageIfRepairing(ctx, "direction_generating", 74, "第一组观察方向已通过门禁，正在生成第二组方向");
  // Persist row 9 as an exact 8x1 atlas strip, but present those same approved
  // cells to GPT edits in the supported 4x2 board geometry. This is a pure
  // rearrangement with no resampling and avoids an unnecessarily extreme
  // 1536x208 reference aspect ratio.
  const lookBRefs: LookBReferenceState = {
    registeredLookAReference: await composeLookSourceBoardReference(lookARow.registered.frames, ctx.identity.chromaKey),
    lookBScreenLeftTrajectoryReference: await composeLookBScreenLeftTrajectoryReference(
      lookARow.registered.frames,
      cardinals.frames,
      ctx.identity.chromaKey,
    ),
  };
  await emit(ctx, "stage.completed", "direction_generating", 74, "第一组观察方向已完成注册、边缘、语义和连续性门禁", {
    row: 9,
    registeredRowArtifactId: lookARow.registered.registeredRowArtifact.id,
    registrationManifestArtifactId: lookARow.registered.manifestArtifact.id,
    neutralFrameArtifactId: neutralDirectionFrame.artifact.id,
    continuityWarnings: lookARow.gate.continuity.warnings.map((warning) => warning.message),
  }, lookARow.row.job.key);
  const initialLookB = await runBoardJob(ctx, {
    key: "look-b",
    kind: "look_row",
    dependencies: ["look-a-registration"],
    inputArtifactIds: [selected.artifact.id, cardinalAnchor.artifact.id, lookARow.registered.registeredRowArtifact.id, lookARow.registered.manifestArtifact.id, standard.contactArtifact.id],
    prompt: buildLookRowPrompt(ctx.identity, "look-b", mechanics),
    references: lookRowReferences({
      row: "look-b",
      anchorStoryboard: lookBAnchorStoryboard,
      directionArcGuide: lookBRefs.lookBScreenLeftTrajectoryReference,
      canonical: { buffer: selected.buffer, mime: selected.artifact.mime },
      cardinalAnchor: { buffer: cardinalAnchor.buffer, mime: cardinalAnchor.artifact.mime },
      registeredLookA: lookBRefs.registeredLookAReference,
      standardContact: standard.contact,
      layout: lookLayout,
    }),
    columns: 4,
    rows: 2,
    frameCount: 8,
    frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
    progress: 76,
    qaKind: "directions",
    qaContext: "方向 180 到 337.5 连续顺时针观察动作，并与 157.5/000 边界连续",
    animationDurations: petRowSpec("look-b").durations,
  });
  const initialRegisteredLookB = await registerDirectionRow(ctx, {
    row: "look-b",
    source: initialLookB,
    neutral: neutralDirectionFrame,
    lockedRow9: lookARow.registered,
    progress: 77,
  });
  const lookBRow: LookRowState<SecondLookRowGate> = {
    row: initialLookB,
    registered: initialRegisteredLookB,
    gate: await reviewSecondLookRow(ctx, { look: initialRegisteredLookB, previousLook: lookARow.registered, canonical: selected, standardContact: standard.contact, cardinalAnchor }),
  };
  await repairLookBRow(ctx, {
    state: lookBRow,
    deps: {
      mechanics,
      canonical: selected,
      cardinalAnchor,
      standardContact: standard.contact,
      standardContactArtifactId: standard.contactArtifact.id,
      layout: lookLayout,
      neutral: neutralDirectionFrame,
      anchorStoryboard: lookBAnchorStoryboard,
      lockedRow9: lookARow.registered,
      references: lookBRefs,
    },
    options: {
      progress: 78,
      registerProgress: 78,
      initialHint: null,
      gateFallbackHint: "Keep the complete 180 through 337.5 row on one monotonic clockwise screen-left arc.",
      exhaustedPrefix: "方向 180 到 337.5 未通过 row-10 前置门禁",
      budgetExhausted: "approval-gate",
      emitRepairing: true,
    },
  });
  requireApprovedRegisteredRow(lookBRow.registered, "第二组观察方向");
  await resumeStageIfRepairing(ctx, "direction_generating", 79, "第二组观察方向已通过门禁，正在组装 16 方向");
  await emit(ctx, "stage.completed", "direction_generating", 79, "第二组观察方向已完成注册、边缘、语义和连续性门禁", {
    row: 10,
    registeredRowArtifactId: lookBRow.registered.registeredRowArtifact.id,
    registrationManifestArtifactId: lookBRow.registered.manifestArtifact.id,
    continuityWarnings: lookBRow.gate.continuity.warnings.map((warning) => warning.message),
  }, lookBRow.row.job.key);
  await emit(ctx, "stage.completed", "direction_generating", 80, "16 个观察方向已完成", {});

  await stage(ctx, "validating", 80, "正在组装图集并执行最终质量检查");
  let finalAtlas: Buffer = Buffer.alloc(0);
  let contactSheet: Buffer = Buffer.alloc(0);
  let directionSheet: Buffer = Buffer.alloc(0);
  let blindSheet: Buffer = Buffer.alloc(0);
  let blindValidation: BlindDirectionValidation | null = null;
  let semantics: readonly DirectionSemanticVerdict[] = [];
  let validation: Awaited<ReturnType<typeof validatePetAtlas>> | null = null;
  let despill: Awaited<ReturnType<typeof despillChromaEdges>>["report"] | null = null;
  let continuity: Awaited<ReturnType<typeof measureDirectionContinuity>> | null = null;
  let directionRegistration: {
    readonly ok: boolean;
    readonly sharedScale: number;
    readonly sourceBoardSizes: readonly { readonly width: number; readonly height: number }[];
    readonly diagnosticsByBoard: readonly (readonly DirectionRegistrationCellDiagnostics[])[];
    readonly schemaVersion: string;
    readonly neutralFrameArtifactId: string;
    readonly target: NeutralDirectionRegistrationManifest["transform"]["target"];
    readonly registeredRowArtifactIds: readonly string[];
    readonly manifestArtifactId: string;
    readonly row9ImmutableDuringRow10Registration: true;
    readonly neutralValidationByBoard: readonly NeutralDirectionGeometryValidation[];
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
  } | null = null;
  let finalQa: PetVisualQaVerdict | null = null;
  const finalRepairHistory: Array<{ attempt: number; rows: readonly string[]; failures: readonly string[] }> = [];

  // Rebuild both direction rows as complete groups whenever a direction gate
  // or final visual QA requests repair.  Re-running both rows keeps the seam
  // and the 000/360 wrap coherent; no individual direction frame is patched.
  const regenerateDirectionRows = async (repairHint: string): Promise<void> => {
    // 两行共用的输入必须在每次调用时重读：repairScopedRows 会在调用之前整体换掉
    // selected / standard / cardinalAnchor 等上游产物，提前提到闭包外就会拿到旧的。
    const sharedDeps = {
      mechanics,
      canonical: selected,
      cardinalAnchor,
      standardContact: standard.contact,
      standardContactArtifactId: standard.contactArtifact.id,
      layout: lookLayout,
      neutral: neutralDirectionFrame,
    };
    const rebuildHint = repairHint
      || "Rebuild both coherent look rows while preserving the approved cardinal semantics and both row boundaries.";
    await repairLookARow(ctx, {
      state: lookARow,
      deps: { ...sharedDeps, anchorStoryboard: lookAAnchorStoryboard },
      options: {
        progress: 84,
        registerProgress: 84,
        workflowStage: "validating",
        initialHint: rebuildHint,
        gateFallbackHint: "Keep row A monotonic across the top-to-bottom row boundary between chronological cells 4 and 5.",
        exhaustedPrefix: "修复后的第一组观察方向未通过前置门禁",
        budgetExhausted: "plain-error",
        emitRepairing: false,
      },
    });
    requireApprovedRegisteredRow(lookARow.registered, "修复后的第一组观察方向");
    lookBRefs.registeredLookAReference = await composeLookSourceBoardReference(lookARow.registered.frames, ctx.identity.chromaKey);
    lookBRefs.lookBScreenLeftTrajectoryReference = await composeLookBScreenLeftTrajectoryReference(
      lookARow.registered.frames,
      cardinals.frames,
      ctx.identity.chromaKey,
    );
    await repairLookBRow(ctx, {
      state: lookBRow,
      deps: {
        ...sharedDeps,
        anchorStoryboard: lookBAnchorStoryboard,
        lockedRow9: lookARow.registered,
        references: lookBRefs,
      },
      options: {
        progress: 84,
        registerProgress: 84,
        workflowStage: "validating",
        initialHint: rebuildHint,
        gateFallbackHint: "Keep row B monotonic across the top-to-bottom row boundary between chronological cells 4 and 5 and both row seams.",
        exhaustedPrefix: "修复后的第二组观察方向未通过前置门禁",
        budgetExhausted: "plain-error",
        emitRepairing: false,
      },
    });
    requireApprovedRegisteredRow(lookBRow.registered, "修复后的第二组观察方向");
    await resumeStageIfRepairing(ctx, "validating", 84, "方向修复已通过，正在继续最终质量检查");
  };

  /**
   * Regenerate the complete action groups a verdict implicates, then rebuild
   * every downstream artifact that depends on them.
   *
   * Deterministic structural gates and the independent visual reviewer both
   * produce row-scoped evidence, so both must reach the same bounded repair
   * path. Throwing on a structural rejection instead would end the run holding
   * fully paid, fully approved action groups — the `老鼠猫` failure mode.
   */
  const repairScopedRows = async (input: {
    readonly rows: readonly FinalRepairRow[];
    readonly repairHint: string;
    readonly progress: number;
    readonly message: string;
    readonly failures: readonly string[];
  }): Promise<void> => {
    await emit(ctx, "run.repairing", "repairing", input.progress, input.message, { retryKind: "visual", rows: [...input.rows], failures: [...input.failures] });
    const standardRows = codexPetCoupledStandardRepairRows(
      input.rows.filter((row): row is StandardRepairRow => row !== "look-a" && row !== "look-b"),
    );
    if (standardRows.length > 0) {
      const progressByState: Record<string, number> = { idle: 20, "running-right": 25, "running-left": 30, waving: 35, jumping: 40, failed: 45, waiting: 50, running: 55, review: 60 };
      if (standardRows[0] === "idle") {
        idle = await runStandardRow(
          ctx,
          "idle",
          selected,
          progressByState.idle!,
          true,
          input.repairHint,
          "validating",
        );
        frames.idle = idle.frames;
        jumpingTargetHeight = await codexPetJumpingTargetHeight(idle.frames);
        neutralDirectionFrame = { artifact: idle.frameArtifacts[0]!, buffer: idle.frames[0]! };
      }
      const parallelRows = standardRows.filter((state) => state !== "idle");
      const repaired = await mapWithConcurrency(parallelRows, visualConcurrency, (state, _index, signal) => (
        runStandardRow(
          { ...ctx, signal },
          state,
          selected,
          progressByState[state] ?? 64,
          true,
          input.repairHint,
          "validating",
          state === "jumping" ? jumpingTargetHeight : undefined,
        )
      ), ctx.signal);
      repaired.forEach((result, index) => {
        const state = parallelRows[index]!;
        if (state === "running-right") runningRight = result;
        else runningLeft = state === "running-left" ? result : runningLeft;
        if (state !== "running-right" && state !== "running-left") remaining.set(state, result);
        frames[state] = result.frames;
      });
      standard = await storeStandardAtlas(ctx, frames, true);

      // Direction references include the approved standard contact; refresh
      // the cardinal anchors as well whenever standard action art changes.
      cardinals = await runBoardJob(ctx, {
        key: "look-cardinals", kind: "look_cardinals", dependencies: ["look-mechanics", "standard-atlas"], inputArtifactIds: [selected.artifact.id, standard.contactArtifact.id],
        prompt: buildCardinalPrompt(ctx.identity, mechanics), references: [imageInput(selected.buffer, selected.artifact.mime, "canonical-base.png"), imageInput(cardinalLayout, "image/png", "cardinal-layout.png")],
        columns: 2, rows: 2, frameCount: 4, progress: 83, qaKind: "cardinals", qaContext: "修复后四个方向锚点必须明确为 000 向上、090 屏幕右、180 向下、270 屏幕左", qaRepetitions: 3, workflowStage: "validating", force: true, repairHint: input.repairHint,
      });
      cardinalAnchor = await createApprovedCardinalAnchor(ctx, cardinals, true);
      lookAAnchorStoryboard = await createLookAnchorStoryboard(cardinalAnchor.buffer, "look-a", ctx.identity.chromaKey);
      lookBAnchorStoryboard = await createLookAnchorStoryboard(cardinalAnchor.buffer, "look-b", ctx.identity.chromaKey);
    }
    await regenerateDirectionRows(input.repairHint);
  };

  const directionMaxAttempts = 3;
  for (let directionAttempt = 1; directionAttempt <= directionMaxAttempts; directionAttempt += 1) {
    requireApprovedRegisteredRow(lookARow.registered, "最终组装第一组观察方向");
    requireApprovedRegisteredRow(lookBRow.registered, "最终组装第二组观察方向");
    const registrationErrors = [
      ...lookARow.registered.errors,
      ...lookBRow.registered.errors,
      ...(lookARow.registered.manifest.transform.scale === lookBRow.registered.manifest.transform.scale ? [] : ["row-10-registration-scale-changed"]),
      ...(lookARow.registered.manifestArtifact.id === lookBRow.registered.manifestArtifact.id ? [] : ["row-10-registration-manifest-changed"]),
    ];
    directionRegistration = {
      ok: registrationErrors.length === 0 && lookARow.registered.validation.ok && lookBRow.registered.validation.ok,
      sharedScale: lookARow.registered.manifest.transform.scale,
      sourceBoardSizes: [lookARow.registered.sourceBoardSize, lookBRow.registered.sourceBoardSize],
      diagnosticsByBoard: [lookARow.registered.diagnostics, lookBRow.registered.diagnostics],
      schemaVersion: lookARow.registered.manifest.schemaVersion,
      neutralFrameArtifactId: neutralDirectionFrame.artifact.id,
      target: lookARow.registered.manifest.transform.target,
      registeredRowArtifactIds: [lookARow.registered.registeredRowArtifact.id, lookBRow.registered.registeredRowArtifact.id],
      manifestArtifactId: lookARow.registered.manifestArtifact.id,
      row9ImmutableDuringRow10Registration: true,
      neutralValidationByBoard: [lookARow.registered.validation, lookBRow.registered.validation],
      errors: registrationErrors,
      warnings: [...lookARow.registered.warnings, ...lookBRow.registered.warnings],
    };
    await putJsonArtifact(ctx, {
      jobId: lookBRow.registered.registrationJob.id,
      kind: "qa_report",
      name: `16 方向中立帧锁定缩放与基线注册 · 第 ${directionAttempt} 次`,
      value: directionRegistration,
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    });
    if (!directionRegistration.ok) {
      if (directionAttempt >= directionMaxAttempts) {
        throw new CodexPetGateFailureError(
          `16 个观察方向中立帧锁定注册经 ${directionMaxAttempts} 次尝试后仍未通过：${directionRegistration.errors.join("；")}`,
          "direction-registration",
          ["look-a", "look-b"],
          directionRegistration.errors,
        );
      }
      const repairHint = directionRegistration.errors.join("; ") || "keep all 16 direction poses at the approved neutral body scale, lower-body anchor and baseline";
      await emit(ctx, "run.repairing", "repairing", 82, `方向中立帧锁定注册自动修复 ${directionAttempt}/${directionMaxAttempts - 1}`, { retryKind: "visual", failures: directionRegistration.errors });
      await regenerateDirectionRows(repairHint);
      continue;
    }
    // These are loaded from the persisted registered row artifacts. Final
    // assembly never revisits either raw 4x2 board and therefore cannot let a
    // wide row-10 pose recalculate or shrink the approved row 9.
    frames["look-a"] = lookARow.registered.frames;
    frames["look-b"] = lookBRow.registered.frames;
    const assembled = await assemblePetAtlas(frames, "png");
    const cleaned = await despillChromaEdges(assembled, ctx.identity.chromaKey);
    finalAtlas = cleaned.image;
    despill = cleaned.report;
    validation = await validatePetAtlas(finalAtlas, ctx.identity.chromaKey, {
      allowAuxiliaryForegroundComponentsForStates: customizedStandardActionStates(ctx.identity.actionPrompts),
    });
    continuity = await measureDirectionContinuity(finalAtlas);
    if (!validation.ok || !continuity.ok) {
      // Both reports name the offending cells, so a structural rejection is a
      // repair scope rather than a wall. Only unattributable atlas-wide defects
      // (dimensions, missing alpha, residue outside the cell grid) remain fatal,
      // because no action group could be regenerated to fix them.
      const structuralFailures = [...validation.errors, ...continuity.errors];
      const unscopedErrors = atlasValidationErrorsWithoutCellScope(validation);
      const structuralRows = [...new Set([
        ...repairRowsFromAtlasValidation(validation),
        ...repairRowsFromDirectionContinuity(continuity),
      ])];
      if (unscopedErrors.length > 0 || structuralRows.length === 0 || directionAttempt >= directionMaxAttempts) {
        const message = `最终图集结构检查失败：${structuralFailures.join("；")}`;
        // An unattributable defect has no row scope to hand a continuation; a
        // scoped one does, even after the in-process attempts are spent.
        throw unscopedErrors.length > 0 || structuralRows.length === 0
          ? new Error(message)
          : new CodexPetGateFailureError(message, "final-atlas-structure", structuralRows, structuralFailures);
      }
      finalRepairHistory.push({ attempt: directionAttempt, rows: structuralRows, failures: structuralFailures });
      await repairScopedRows({
        rows: structuralRows,
        repairHint: `修复以下动作组的结构缺陷（单元格空白、越界、残留色键或方向缺失）：${structuralFailures.slice(0, 20).join("；")}`,
        progress: 86,
        message: `最终图集结构缺陷动作组修复 ${directionAttempt}/${directionMaxAttempts - 1}`,
        failures: structuralFailures,
      });
      continue;
    }
    // Despill residue inside the cell grid is already attributed per row above;
    // anything left here is a defect of the despill pass itself.
    if (!despill.ok) throw new Error(`最终图集残留色键像素 ${despill.remainingOpaqueKeyPixels}`);
    contactSheet = await createAtlasContactSheet(finalAtlas);
    directionSheet = await createDirectionQaSheet(finalAtlas);
    const blind = await createDirectionBlindQaSheet(finalAtlas);
    blindSheet = blind.image;
    if (!ctx.qualityInspectionEnabled) {
      blindValidation = { ok: true, reviewers: [], consensus: [], failures: [], warnings: [] };
      semantics = [];
      finalQa = {
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
      };
      break;
    }
    [blindValidation, semantics] = await Promise.all([
      ctx.blindQa({ sheet: blind.image, answerKey: blind.answerKey, identityGuide: ctx.identity.canonicalGuide, env: ctx.env, signal: ctx.signal }),
      ctx.directionSemantics({ sheet: directionSheet, expectedDirections: LOOK_DIRECTIONS, identityGuide: ctx.identity.canonicalGuide, env: ctx.env, signal: ctx.signal }),
    ]);
    assertCodexPetVisualQaProvenance(blindValidation.modelProvenance, ctx.visualQaModel, "blind-direction-qa");
    semantics.forEach((item) => {
      assertCodexPetVisualQaProvenance(item.modelProvenance, ctx.visualQaModel, `direction-${item.direction}`);
    });
    const semanticFailures = semantics.filter((item) => item.verdict === "fail");
    if (!(blindValidation.ok && semanticFailures.length === 0)) {
      const directionFailures = [...blindValidation.failures, ...semanticFailures.map((item) => `${item.direction}:${item.reason}`)];
      if (directionAttempt >= directionMaxAttempts) {
        // Blind QA and semantics both speak in direction labels; map them back to
        // the two direction rows so a continuation redoes only those boards.
        const directionRows = [...new Set([
          ...repairRowsFromDirectionContinuity({ errors: directionFailures }),
          ...(blindValidation.failures.length > 0 ? ["look-a", "look-b"] as const : []),
        ])];
        throw new CodexPetGateFailureError(
          `方向质检经 ${directionMaxAttempts} 次尝试后仍未通过：${directionFailures.join("；")}`,
          "direction-qa",
          directionRows,
          directionFailures,
        );
      }
      const repairHint = [...blindValidation.failures, ...semanticFailures.map((item) => `${item.direction}: ${item.reason}`)].join("; ");
      await emit(ctx, "run.repairing", "repairing", 84, `方向动作自动修复 ${directionAttempt}/${directionMaxAttempts - 1}`, { retryKind: "visual", failures: repairHint });
      await regenerateDirectionRows(repairHint);
      continue;
    }

    // The final independent reviewer is part of the bounded repair loop. It
    // receives playable previews for all nine rows and returns complete row
    // scopes, allowing us to regenerate an action group before packaging.
    const continuityWarnings = continuity!.warnings.map((item) => item.message);
    const motionPreviews = await Promise.all(PET_ROW_SPECS.slice(0, 9).map((spec) => (
      createAnimatedWebpPreview(frames[spec.state]!, spec.durations)
    )));
    finalQa = await ctx.qa({
      images: [
        { buffer: selected.buffer, mime: selected.artifact.mime },
        { buffer: standard.contact, mime: "image/png" },
        { buffer: contactSheet, mime: "image/png" },
        { buffer: directionSheet, mime: "image/png" },
        ...motionPreviews.map((preview) => ({ buffer: preview.image, mime: preview.mime })),
      ],
      prompt: buildVisualQaPrompt(
        "final",
        `All nine standard rows and the complete labeled 16-direction loop; deterministic validation passed. `
        + `The first image is the canonical identity, followed by standard/final/direction sheets and nine animated WebP previews in row order. Inspect actual playback for cadence, vertical travel, inert loops, wrong facing, reversal, size popping and baseline jumps. `
        + `If any action group is defective, list its complete row name in repairRows; never request a single-frame patch. `
        + `Continuity metrics are review evidence only: ${continuityWarnings.slice(0, 20).join(" | ") || "no metric warnings"}`,
        ctx.identity.canonicalGuide,
        standardActionSpecificationSummary(ctx.identity.actionPrompts),
      ),
      env: ctx.env,
      signal: ctx.signal,
    });
    assertCodexPetVisualQaProvenance(finalQa.modelProvenance, ctx.visualQaModel, "final-visual-qa");
    if (codexPetVisualQaVerdictPasses(finalQa)) break;
    if (directionAttempt >= directionMaxAttempts) {
      throw new CodexPetGateFailureError(
        `最终独立视觉质检经 ${directionMaxAttempts} 次尝试后仍未通过：${finalQa.failures.join("；") || "角色一致性或动作连续性失败"}`,
        "final-visual-qa",
        repairRowsFromFinalQa(finalQa),
        finalQa.failures,
      );
    }
    const repairRows = repairRowsFromFinalQa(finalQa);
    finalRepairHistory.push({ attempt: directionAttempt, rows: repairRows, failures: finalQa.failures });
    await repairScopedRows({
      rows: repairRows,
      repairHint: finalQa.repairPrompt || finalQa.failures.join("；") || "修复指定动作组的身份、动作语义、节奏与连续性",
      progress: 88,
      message: `最终视觉质检动作组修复 ${directionAttempt}/${directionMaxAttempts - 1}`,
      failures: finalQa.failures,
    });
  }
  if (!validation || !despill || !blindValidation || !continuity || !directionRegistration?.ok || !finalQa || (ctx.qualityInspectionEnabled && !codexPetVisualQaVerdictPasses(finalQa))) {
    throw new Error("最终验证没有生成完整报告");
  }
  await resumeStageIfRepairing(ctx, "validating", 94, "最终结构、方向盲测与视觉质检已通过");
  const continuityWarnings = continuity.warnings.map((item) => item.message);
  await emit(ctx, "stage.completed", "validating", 94, "最终结构、方向盲测与视觉质检已通过", { warnings: [...validation.warnings, ...continuityWarnings, ...blindValidation.warnings, ...semantics.filter((item) => item.verdict === "warning").map((item) => `${item.direction}:${item.reason}`)] });

  const petId = `${ctx.identity.name}-${createHash("sha256").update(ctx.project.id).digest("hex").slice(0, 10)}`;
  const packaged = await createCodexPetPackage({ id: petId, displayName: ctx.identity.name, description: ctx.identity.description, spritesheet: finalAtlas });
  // Re-open the exact ZIP bytes that will be persisted.  This closes the
  // validation gap between the pre-package PNG checks and the WebP/ZIP bytes
  // consumed by Codex, and makes a malformed package a normal refundable run
  // failure instead of a deliverable that only fails at install time.
  const inspectedPackage = await inspectCodexPetZip(packaged.zip);
  if (inspectedPackage.manifest.spriteVersionNumber !== 2 || inspectedPackage.manifest.spritesheetPath !== "spritesheet.webp") {
    throw new Error("Codex v2 安装包结构验证失败");
  }
  const packagedValidation = await validatePetAtlas(packaged.spritesheet, ctx.identity.chromaKey, {
    allowAuxiliaryForegroundComponentsForStates: customizedStandardActionStates(ctx.identity.actionPrompts),
  });
  if (!packagedValidation.ok) {
    throw new Error(`Codex v2 WebP 图集验证失败：${packagedValidation.errors.join("；")}`);
  }
  let visualQaActualModels: string[] = [];
  let visualQaRoutes: string[] = [];
  if (ctx.qualityInspectionEnabled) {
    if (!lookARow.gate.visual) throw new Error("row9 前置门禁缺少所选视觉模型证明");
    const requiredJobProvenance = await summarizeRequiredVisualJobProvenance(ctx);
    const row9GateProvenance = assertCodexPetVisualQaProvenance(lookARow.gate.visual.modelProvenance, ctx.visualQaModel, "row9-pre-generation-gate");
    const row10GateProvenance = assertCodexPetVisualQaProvenance(lookBRow.gate.visual?.modelProvenance, ctx.visualQaModel, "row10-pre-generation-gate");
    const finalQaProvenance = assertCodexPetVisualQaProvenance(finalQa.modelProvenance, ctx.visualQaModel, "final-visual-qa");
    const blindQaProvenance = assertCodexPetVisualQaProvenance(blindValidation.modelProvenance, ctx.visualQaModel, "blind-direction-qa");
    const semanticProvenance = semantics.map((item) => (
      assertCodexPetVisualQaProvenance(item.modelProvenance, ctx.visualQaModel, `direction-${item.direction}`)
    ));
    visualQaActualModels = [...new Set([
      ...requiredJobProvenance.actualModels,
      ...row9GateProvenance.actualModels,
      ...row10GateProvenance.actualModels,
      ...finalQaProvenance.actualModels,
      ...blindQaProvenance.actualModels,
      ...semanticProvenance.flatMap((item) => item.actualModels),
    ])];
    if (visualQaActualModels.length === 0
      || visualQaActualModels.some((model) => !isAllowedCodexPetVisualModel(model))) {
      throw new Error(`最终视觉质检模型不符合 ${ctx.visualQaModel} 合同`);
    }
    visualQaRoutes = [...new Set([
      ...requiredJobProvenance.routes,
      ...row9GateProvenance.routes,
      ...row10GateProvenance.routes,
      ...finalQaProvenance.routes,
      ...blindQaProvenance.routes,
      ...semanticProvenance.flatMap((item) => item.routes),
    ])];
  }
  const provider = await summarizeProviderUsage(ctx);
  const imageModelMatches = (model: string) => model === ctx.imageModel
    || (ctx.imageModel === GPT_IMAGE_MODEL && model === "gpt-image-2-codex");
  if (provider.actualModels.length === 0
    || provider.actualModels.some((model) => !isAllowedCodexPetImageProvenance(model) || !imageModelMatches(model))) {
    throw new Error(`最终生图模型不符合 ${ctx.imageModel} 合同`);
  }
  const report = {
    ok: true,
    spriteVersionNumber: 2,
    modelContractVersion: CODEX_PET_MODEL_CONTRACT_VERSION,
    requestedModel: ctx.imageModel,
    modelProvenance: {
      imageGeneration: {
        requestedModel: ctx.imageModel,
        actualModels: provider.actualModels,
      },
      visualQa: {
        enabled: ctx.qualityInspectionEnabled,
        requestedModel: ctx.qualityInspectionEnabled ? ctx.visualQaModel : null,
        actualModels: visualQaActualModels,
        routes: visualQaRoutes,
      },
    },
    chromaKey: ctx.identity.chromaKey,
    cardinalAnchor: {
      artifactId: cardinalAnchor.artifact.id,
      sourceBoardArtifactId: cardinals.boardArtifact.id,
      directions: ["000", "090", "180", "270"],
      evidence: asRecord(cardinalAnchor.artifact.metadata).cardinalEvidence,
    },
    deterministic: validation,
    standardAtlasValidation: standard.validation,
    packagedSpritesheet: packagedValidation,
    chromaDespill: despill,
    directionRegistration,
    directionContinuity: continuity,
    row9PreGenerationGate: {
      passed: lookARow.gate.pass,
      neutralFrameArtifactId: neutralDirectionFrame.artifact.id,
      registeredRowArtifactId: lookARow.registered.registeredRowArtifact.id,
      registrationManifestArtifactId: lookARow.registered.manifestArtifact.id,
      neutralGeometryValidation: lookARow.registered.validation,
      deterministicContinuity: lookARow.gate.continuity,
    },
    row10PreGenerationGate: {
      passed: lookBRow.gate.pass,
      registeredRowArtifactId: lookBRow.registered.registeredRowArtifact.id,
      reusedRegistrationManifestArtifactId: lookBRow.registered.manifestArtifact.id,
      neutralGeometryValidation: lookBRow.registered.validation,
      deterministicContinuity: lookBRow.gate.continuity,
      visual: lookBRow.gate.visual,
      failures: lookBRow.gate.failures,
    },
    finalRepairHistory,
    blindDirectionValidation: blindValidation,
    directionSemantics: semantics,
    finalVisualQa: finalQa,
    acceptableWarnings: [...validation.warnings, ...continuityWarnings, ...blindValidation.warnings, ...semantics.filter((item) => item.verdict === "warning").map((item) => `${item.direction}:${item.reason}`)],
  };
  const durablePackage = await persistOrResumeCodexPetFinalPackage({
    prisma: ctx.prisma,
    artifacts: ctx.artifacts,
    runId: ctx.runId,
    projectId: ctx.project.id,
    userId: ctx.project.userId,
    workerId: ctx.workerId,
    displayName: ctx.identity.name,
    description: ctx.identity.description,
    chromaKey: ctx.identity.chromaKey,
    provider,
    seed: {
      petId: packaged.petId,
      finalAtlas,
      spritesheet: packaged.spritesheet,
      zip: packaged.zip,
      contactSheet,
      directionSheet,
      blindSheet,
      report,
      inputArtifactIds: [
        standard.atlasArtifact.id,
        lookARow.registered.registeredRowArtifact.id,
        lookBRow.registered.registeredRowArtifact.id,
      ],
    },
  });
  if (!durablePackage) throw new Error("最终打包任务未能建立持久化 checkpoint");
  return continueAfterDurablePackaging(ctx, durablePackage);
}

export async function executeCodexPetRun(input: { runId: string; deps: CodexPetRunnerDeps }): Promise<CodexPetExecutionResult> {
  const { deps } = input;
  const env = deps.env ?? process.env;
  const initialRun = await deps.prisma.codexPetRun.findUnique({ where: { id: input.runId }, include: { project: true } });
  if (!initialRun) throw new Error("Codex pet run not found");
  if (initialRun.project.id !== initialRun.projectId || initialRun.project.userId !== initialRun.userId) {
    throw new Error("Codex pet run ownership mismatch");
  }
  // BullMQ delivery is at-least-once and older retained failed jobs may be
  // observed during an upgrade. Terminal database state is authoritative: a
  // failed/refunded or API-cancelled run must never regenerate artifacts,
  // emit another terminal event, or attempt another refund.
  if (initialRun.status === "ready" || initialRun.status === "failed" || initialRun.status === "cancelled" || initialRun.status === CODEX_PET_LEGACY_READ_ONLY_STATUS || initialRun.status === "awaiting_direction_review" || initialRun.status === "awaiting_regeneration_approval") {
    return { status: initialRun.status, runId: initialRun.id };
  }
  const initialSnapshot = asRecord(initialRun.inputSnapshot);
  const initialQualityInspectionEnabled = typeof initialSnapshot.qualityInspectionEnabled === "boolean"
    ? initialSnapshot.qualityInspectionEnabled
    : typeof initialRun.qualityInspectionEnabled === "boolean"
      ? initialRun.qualityInspectionEnabled
      : initialRun.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE ? false : true;
  const zeroChargeRecovery = ["packaging", "archiving"].includes(initialRun.status)
    && isCodexPetRecoverySnapshot(initialRun.inputSnapshot)
    && initialRun.billingChargeStatus === "not_required"
    && initialRun.billingPoints === 0;
  const initialVisualQaModel = typeof initialSnapshot.visualQaModel === "string"
    ? initialSnapshot.visualQaModel.trim()
    : "";
  const initialModelContractValid = initialSnapshot.modelContractVersion === CODEX_PET_MODEL_CONTRACT_VERSION
    && typeof initialSnapshot.requestedModel === "string"
    && isAllowedCodexPetImageModel(initialSnapshot.requestedModel)
    && initialRun.requestedModel === initialSnapshot.requestedModel
    && (!initialQualityInspectionEnabled || initialVisualQaModel === resolveCodexPetVisualQaModel(env, initialVisualQaModel));
  // Waiting for an explicit user choice is a durable pause, not runnable
  // work. A duplicate Bull delivery (for example an old retained/stalled job)
  // must not claim the run and replay base generation while the workbench is
  // showing candidates. Auto-selection and explicit selection routes first
  // move the row back to a runnable stage, so they are unaffected.
  if (initialRun.status === "awaiting_base_review"
    && !initialRun.selectedBaseArtifactId
    && !initialRun.autoContinue
    && initialModelContractValid
    && !initialRun.cancelRequested) {
    return { status: "awaiting_base_review", runId: initialRun.id };
  }
  // Queue delivery must never start visual work before the external package
  // charge is durably confirmed and the activation transaction has committed.
  const initialBillingActivated = initialRun.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE
    ? initialRun.billingSettlementStatus === "reserved"
    : initialRun.billingChargeStatus === "charged" && Boolean(initialRun.billingActivatedAt);
  if (!zeroChargeRecovery && !initialBillingActivated) {
    throw new Error("Codex pet run billing is not activated");
  }
  // A caller that does not supply a worker identity is generally a direct
  // invocation (tests, maintenance, or a one-off repair). Give each such
  // invocation a unique lease token so two concurrent calls in one process
  // still obey the same CAS rule. Queue workers supply their own unique token
  // and use it for the heartbeat below.
  const workerId = deps.workerId ?? `${WORKER_ID}:${randomUUID().slice(0, 12)}`;
  const claimed = await claimRunLease(
    deps.prisma,
    input.runId,
    workerId,
    env,
    initialRun.projectId,
    initialRun.userId,
    zeroChargeRecovery,
  );
  if (!claimed.claimed) {
    const fresh = claimed.run;
    if (!fresh) throw new Error("Codex pet run not found");
    if (fresh.status === "ready" || fresh.status === "failed" || fresh.status === "cancelled") {
      return { status: fresh.status, runId: fresh.id };
    }
    // Another live worker owns the run. Do not invoke finalizeFailure or
    // cancellation here; doing so would race the owner and could trigger a
    // duplicate refund. The queue/maintenance pass will retry after a stale
    // lease expires if necessary.
    return { status: "busy", runId: fresh.id };
  }
  const run = claimed.run;
  if (!run) throw new Error("Codex pet run disappeared after lease claim");
  const snapshot = asRecord(run.inputSnapshot);
  const snapshottedModelContractVersion = typeof snapshot.modelContractVersion === "string" ? snapshot.modelContractVersion.trim() : "";
  const snapshottedImageModel = typeof snapshot.requestedModel === "string" ? snapshot.requestedModel.trim() : "";
  const snapshottedVisualQaModel = typeof snapshot.visualQaModel === "string" ? snapshot.visualQaModel.trim() : "";
  const qualityInspectionEnabled = typeof snapshot.qualityInspectionEnabled === "boolean"
    ? snapshot.qualityInspectionEnabled
    : typeof run.qualityInspectionEnabled === "boolean"
      ? run.qualityInspectionEnabled
      : run.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE ? false : true;
  const visualQaModel = qualityInspectionEnabled
    ? resolveCodexPetVisualQaModel(env, snapshottedVisualQaModel || run.visualQaModel || undefined)
    : "";
  const imageModel = snapshottedImageModel || run.requestedModel;
  const failedContinuation = asRecord(snapshot.failedContinuation);
  const snapshottedMaxBoardAttempts = failedContinuation.maxBoardAttemptsPerJob;
  const perImageBilling = run.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE;
  const perImageCallPoints = perImageBilling ? frozenPerImageCallPoints(snapshot, run) : 0;
  const maxBoardAttempts = perImageBilling ? 1 : codexPetMaxBoardAttempts(env, snapshottedMaxBoardAttempts);
  // All visual calls in this run use the snapshotted project choice. Keeping
  // it in the context environment lets the existing visual helpers and their
  // injected test clients share one durable route without consulting the
  // mutable process default.
  const visualEnv = qualityInspectionEnabled ? { ...env, PET_VISUAL_QA_MODEL: visualQaModel } : env;
  // Recovery packaging is bound to already-approved bytes and never needs to
  // reload user references. Avoid making a zero-charge recovery depend on
  // reference-object availability after the original run has finished.
  const referenceAssetIds = zeroChargeRecovery ? [] : Array.isArray(snapshot.referenceAssetIds)
    ? snapshot.referenceAssetIds.filter((value): value is string => typeof value === "string")
    : [...run.project.referenceAssetIds];
  const snapshotString = (key: string, fallback: string) => typeof snapshot[key] === "string" ? snapshot[key] as string : fallback;
  const identity = {
    name: snapshotString("name", run.project.name),
    description: snapshotString("description", run.project.description),
    prompt: snapshotString("prompt", run.project.prompt),
    actionPrompts: normalizeCodexPetActionPrompts(snapshot.actionPrompts ?? run.project.actionPrompts),
    stylePreset: snapshotString("stylePreset", run.project.stylePreset),
    styleNotes: snapshotString("styleNotes", run.project.styleNotes),
  };
  let loadedReferences: Array<{ buffer: Buffer; mime: string; filename: string }> = [];
  let chromaKey = run.colorKey || "#ff00ff";
  try {
    if (snapshottedModelContractVersion !== CODEX_PET_MODEL_CONTRACT_VERSION) {
      throw new Error(`Codex pet run is missing the required ${CODEX_PET_MODEL_CONTRACT_VERSION} model contract`);
    }
    if (!isAllowedCodexPetImageModel(imageModel) || run.requestedModel !== imageModel) {
      throw new Error(`Codex pet image model contract is invalid: ${imageModel || "missing"}`);
    }
    if (qualityInspectionEnabled && snapshottedVisualQaModel !== visualQaModel) {
      throw new Error(`Codex pet visual model contract changed after start: ${snapshottedVisualQaModel} -> ${visualQaModel}`);
    }
    const referenceAssets = referenceAssetIds.length
      ? await deps.prisma.imageAsset.findMany({ where: { userId: run.userId, id: { in: referenceAssetIds } } })
      : [];
    if (referenceAssets.length !== referenceAssetIds.length) throw new Error("参考图不存在或无权使用");
    loadedReferences = await Promise.all(referenceAssetIds.map(async (id) => {
      const asset = referenceAssets.find((candidate) => candidate.id === id);
      if (!asset) throw new Error("参考图不存在或无权使用");
      const loaded = await deps.loadReferenceAsset(asset);
      return { ...loaded, filename: `${asset.id}.${loaded.mime.includes("webp") ? "webp" : "png"}` };
    }));
    chromaKey = run.colorKey || (loadedReferences.length
      ? await chooseChromaKey(loadedReferences.map((reference) => reference.buffer))
      : "#ff00ff");
    if (!run.colorKey) {
      const colorKeyClaim = await deps.prisma.codexPetRun.updateMany({ where: { id: run.id, projectId: run.project.id, userId: run.userId, workerId }, data: { colorKey: chromaKey, heartbeatAt: new Date() } });
      if (colorKeyClaim.count !== 1) throw new CodexPetLeaseLostError();
    }
  } catch (error) {
    if (!(error instanceof CodexPetLeaseLostError)) {
      await finalizeClaimedSetupFailure({ prisma: deps.prisma, appendEvent: deps.appendEvent, billing: deps.billing, project: run.project, runId: run.id, workerId, error }).catch(() => undefined);
    }
    throw error;
  }

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(deps.signal?.reason);
  if (deps.signal?.aborted) controller.abort(deps.signal.reason);
  else deps.signal?.addEventListener("abort", abortFromParent, { once: true });
  let checking = false;
  const monitor = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    void deps.prisma.codexPetRun.findFirst({ where: { id: run.id, projectId: run.project.id, userId: run.userId }, select: { cancelRequested: true, status: true, workerId: true } })
      .then((fresh) => {
        if (!fresh || fresh.cancelRequested || fresh.status === "cancelled") controller.abort(new CodexPetCancelledError());
        else if (!(CODEX_PET_ACTIVE_STATUSES as readonly string[]).includes(fresh.status) || fresh.workerId !== workerId) controller.abort(new CodexPetLeaseLostError());
      })
      .finally(() => { checking = false; });
  }, 1_000);
  const configuredHeartbeat = Number(env.CODEX_PET_HEARTBEAT_MS);
  const leaseHeartbeatMs = Number.isFinite(configuredHeartbeat) && configuredHeartbeat > 0
    ? configuredHeartbeat
    : Math.min(10_000, Math.max(1_000, Math.floor(staleRunMs(env) / 3)));
  const leaseHeartbeat = setInterval(() => {
    void deps.prisma.codexPetRun.updateMany({
      where: {
        id: run.id,
        workerId,
        status: { in: [...CODEX_PET_ACTIVE_STATUSES] },
        ...(zeroChargeRecovery
          ? { billingChargeStatus: "not_required", billingPoints: 0 }
          : perImageBilling
            ? { billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE, billingSettlementStatus: "reserved" }
            : { billingChargeStatus: "charged", billingActivatedAt: { not: null } }),
      },
      data: { heartbeatAt: new Date() },
    }).then((updated) => {
      if (updated.count !== 1 && !controller.signal.aborted) controller.abort(new CodexPetLeaseLostError());
    }).catch(() => undefined);
  }, leaseHeartbeatMs);
  const ctx: RunnerContext = {
    ...deps,
    env: visualEnv,
    workerId,
    signal: controller.signal,
    project: run.project,
    runId: run.id,
    imageModel,
    visualQaModel,
    qualityInspectionEnabled,
    perImageBilling,
    perImageCallPoints,
    maxBoardAttempts,
    referenceAssetIds,
    identity: {
      ...identity,
      chromaKey,
    },
    userReferences: loadedReferences.map((loaded) => imageInput(loaded.buffer, loaded.mime, loaded.filename)),
    generate: deps.visual?.generate ?? ((input) => generateCodexPetVisual({ ...input, model: imageModel })),
    qa: deps.visual?.qa ?? runCodexPetVisualQa,
    qaConsensus: deps.visual?.qaConsensus ?? runCodexPetVisualQaConsensus,
    blindQa: deps.visual?.blindQa ?? runBlindDirectionQa,
    directionSemantics: deps.visual?.directionSemantics ?? runLabeledDirectionSemantics,
    lookMechanics: deps.visual?.lookMechanics ?? generateCodexPetLookMechanics,
    identityGuide: deps.visual?.identityGuide ?? generateCodexPetIdentityGuide,
  };
  try {
    return await executeRun(ctx);
  } catch (error) {
    if (error instanceof CodexPetImageApprovalRequiredError) {
      return await handleImageApprovalRequired(ctx, error);
    }
    if (error instanceof CodexPetImageCallLimitError || error instanceof CodexPetImageCallApprovalRequiredError || error instanceof CodexPetImageCallAlreadySentError) {
      return await handleImageCallLedgerPause(ctx, error);
    }
    if (error instanceof CodexPetPackagingDeferredError) {
      return await handlePackagingDeferred(ctx, error);
    }
    if (error instanceof CodexPetLeaseLostError || controller.signal.reason instanceof CodexPetLeaseLostError) {
      return await handleLeaseLost(ctx);
    }
    if (error instanceof CodexPetCancelledError || controller.signal.reason instanceof CodexPetCancelledError) {
      return await handleCancelled(ctx);
    }
    return await handleUnexpectedFailure(ctx, error);
  } finally {
    clearInterval(monitor);
    clearInterval(leaseHeartbeat);
    deps.signal?.removeEventListener("abort", abortFromParent);
  }
}
