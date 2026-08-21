// 由 codex-pet-runner.ts 纯移动而来（P3.1 阶段 1，标准动作行与图集）。

import { Buffer } from "node:buffer";
import {
  PET_ROW_SPECS,
  type PetFramesByState,
  type PetRowSpec,
  assembleStandardPetAtlas,
  composeNormalizedPoseBoard,
  createAnimatedWebpPreview,
  createLayoutGuide,
  createStandardAtlasContactSheet,
  extractPoseBoard,
  mirrorFramesPreservingOrder,
  petRowSpec,
  validateStandardPetAtlas,
} from "@ai-assistant/codex-pet-pipeline";
import { type CodexPetArtifact, Prisma } from "@prisma/client";
import { buildStandardRowPrompt, buildVisualQaPrompt } from "../codex-pet-prompts.js";
import { completedBoardJob, runBoardJob } from "./runner-board-job.js";
import { ensureJob, failJobAttempt, putJsonArtifact, startJob } from "./runner-jobs.js";
import { emit } from "./runner-lease.js";
import { assertCodexPetVisualQaProvenance } from "./runner-provenance.js";
import {
  type BoardJobResult,
  CodexPetLeaseLostError,
  CodexPetStandardAtlasStructureError,
  INTERMEDIATE_TTL_MS,
  type RunnerContext,
  codexPetStandardRowPromptVersion,
} from "./runner-types.js";
import { asRecord, customizedStandardActionStates, imageInput, safeError } from "./runner-util.js";
import {
  type PetVisualQaConsensus,
  codexPetVisualQaConsensusPasses,
  createSeedreamPoseBoardScaffold,
  selectSeedreamGaitScaffoldVariants,
} from "../codex-pet-visual.js";
import { DOUBAO_IMAGE_MODEL } from "../image-service.js";

export async function deriveRunningLeft(ctx: RunnerContext, right: BoardJobResult, canonical: { artifact: CodexPetArtifact; buffer: Buffer }): Promise<BoardJobResult> {
  let job = await ensureJob(ctx, "row-running-left", "derived_row", ["row-running-right"], { derivation: "per-frame-mirror-preserve-order" });
  const completed = await completedBoardJob(ctx, job);
  if (completed) return completed;
  const previousOutput = asRecord(job.output);
  const previousArtifactIds = [...new Set([
    ...job.outputArtifactIds,
    typeof previousOutput.boardArtifactId === "string" ? previousOutput.boardArtifactId : "",
  ].filter(Boolean))];
  job = await startJob(ctx, job, 1, 30, "逐帧镜像生成向左移动动画");
  const frames = await mirrorFramesPreservingOrder(right.frames);
  const normalizedBoard = await composeNormalizedPoseBoard(frames, {
    columns: 4,
    rows: 2,
    chromaKey: ctx.identity.chromaKey,
  });
  const preview = await createAnimatedWebpPreview(frames, petRowSpec("running-left").durations);
  const boardArtifact = await ctx.artifacts.put({
    userId: ctx.project.userId,
    projectId: ctx.project.id,
    runId: ctx.runId,
    jobId: job.id,
    kind: "animation_preview",
    name: "running-left 逐帧镜像预览",
    buffer: preview.image,
    mime: "image/webp",
    metadata: { derivation: "per-frame-mirror-preserve-order", sourceJobId: right.job.id },
    // Treat the preview as intermediate until mirror-specific visual QA has
    // passed. A rejected/errored mirror must never remain as a permanent,
    // user-visible animation preview.
    expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
  });
  const frameArtifacts: CodexPetArtifact[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    frameArtifacts.push(await ctx.artifacts.put({
      userId: ctx.project.userId,
      projectId: ctx.project.id,
      runId: ctx.runId,
      jobId: job.id,
      kind: "frame",
      name: `running-left · frame ${String(index).padStart(2, "0")}`,
      buffer: frames[index]!,
      mime: "image/png",
      metadata: { index, mirroredFrom: right.frameArtifacts[index]?.id },
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    }));
  }
  const generatedArtifactIds = [boardArtifact.id, ...frameArtifacts.map((artifact) => artifact.id)];
  const supersedeRejectedMirror = async () => {
    await ctx.prisma.codexPetArtifact.updateMany({
      where: {
        id: { in: generatedArtifactIds },
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
      },
      data: { status: "superseded", expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS) },
    });
  };
  let qa: PetVisualQaConsensus;
  try {
    qa = await ctx.qaConsensus({
      images: [
        { buffer: canonical.buffer, mime: canonical.artifact.mime },
        { buffer: normalizedBoard, mime: "image/png" },
        { buffer: preview.image, mime: "image/webp" },
      ],
      prompt: buildVisualQaPrompt(
        "row",
        "running-left must face/travel left; the second image is the complete static chronological eight-frame cycle and the third is its animation preview; mirroring must preserve identity, timing and all asymmetric meaning. Images 2 and 3 are pre-despill intermediate assets. Bright magenta/chroma fringe at the alpha boundary is expected here and must never fail mirror suitability: the single deterministic final-atlas despill pass owns chroma cleanup. Judge only facing direction, gait cadence, identity, asymmetric meaning, attachment, clipping and motion continuity.",
        ctx.identity.canonicalGuide,
      ),
      env: ctx.env,
      signal: ctx.signal,
      repetitions: 1,
    });
  } catch (error) {
    await supersedeRejectedMirror().catch(() => undefined);
    await failJobAttempt(ctx, job, 1, safeError(error), 30, true).catch(() => undefined);
    throw error;
  }
  const qaProvenance = assertCodexPetVisualQaProvenance(qa.modelProvenance, ctx.visualQaModel, "row-running-left");
  if (!codexPetVisualQaConsensusPasses(qa)) {
    await supersedeRejectedMirror();
    await failJobAttempt(ctx, job, 1, qa.failures.join("；") || "镜像结果不适用", 30);
    throw new Error("MIRROR_NOT_SAFE");
  }
  job = await ctx.prisma.$transaction(async (tx) => {
    if (previousArtifactIds.length > 0) {
      await tx.codexPetArtifact.updateMany({
        where: {
          id: { in: previousArtifactIds },
          runId: ctx.runId,
          projectId: ctx.project.id,
          userId: ctx.project.userId,
        },
        data: { status: "superseded", expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS) },
      });
    }
    const promoted = await tx.codexPetArtifact.updateMany({
      where: {
        id: boardArtifact.id,
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        status: "ready",
      },
      data: { expiresAt: null },
    });
    if (promoted.count !== 1) throw new CodexPetLeaseLostError();
    return tx.codexPetJob.update({ where: { id: job.id }, data: {
      status: "completed",
      inputArtifactIds: right.frameArtifacts.map((artifact) => artifact.id),
      outputArtifactIds: frameArtifacts.map((artifact) => artifact.id),
      output: { boardArtifactId: boardArtifact.id, mirrorSafe: true, qa: { score: qa.score, warnings: qa.warnings } } as Prisma.InputJsonValue,
      providerMetadata: {
        visualQa: qaProvenance,
      } as unknown as Prisma.InputJsonValue,
      completedAt: new Date(),
      workerId: null,
    } });
  });
  return { job, frames, frameArtifacts, board: preview.image, boardArtifact, mirrorSafe: true, qa };
}

export async function runStandardRow(
  ctx: RunnerContext,
  state: Exclude<PetRowSpec["state"], "look-a" | "look-b">,
  canonical: { artifact: CodexPetArtifact; buffer: Buffer },
  progress: number,
  force = false,
  repairHint = "",
  workflowStage: "standard_generating" | "validating" = "standard_generating",
  jumpingTargetHeight?: number,
): Promise<BoardJobResult> {
  const spec = petRowSpec(state);
  let layout: Buffer | null = null;
  let scaffoldArtifactId: string | null = null;
  let scaffoldSourceArtifactId: string | null = null;
  if (ctx.imageModel === DOUBAO_IMAGE_MODEL) {
    let poseVariants: readonly Buffer[] | undefined;
    let variantSequence: readonly number[] | undefined;
    // A targeted recovery may use one explicitly selected already-paid failed
    // board as two alternating construction phases. The snapshot flag prevents an old
    // completed board from changing its own input revision on a normal resume.
    if (state === "running-right") {
      const retryState = await ctx.prisma.codexPetRun.findFirst({
        where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId },
        select: { inputSnapshot: true },
      });
      const targeted = asRecord(asRecord(retryState?.inputSnapshot).targetedBoardRetry);
      const retryEnabled = targeted.state === "running-right" && targeted.status === "prepared";
      if (retryEnabled) {
        const expectedArtifactId = typeof targeted.sourceBoardArtifactId === "string"
          ? targeted.sourceBoardArtifactId
          : "";
        const expectedScaffoldArtifactId = typeof targeted.scaffoldArtifactId === "string"
          ? targeted.scaffoldArtifactId
          : "";
        const priorJob = await ctx.prisma.codexPetJob.findFirst({
          where: { runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, key: "row-running-right" },
          select: { id: true },
        });
        const [priorBoard, recoveryScaffold] = priorJob ? await Promise.all([
          expectedArtifactId ? ctx.prisma.codexPetArtifact.findFirst({
              where: {
                id: expectedArtifactId,
                runId: ctx.runId,
                projectId: ctx.project.id,
                userId: ctx.project.userId,
                jobId: priorJob.id,
                kind: "pose_board",
                status: "ready",
              },
            }) : null,
          expectedScaffoldArtifactId ? ctx.prisma.codexPetArtifact.findFirst({
            where: {
              id: expectedScaffoldArtifactId,
              runId: ctx.runId,
              projectId: ctx.project.id,
              userId: ctx.project.userId,
              jobId: priorJob.id,
              kind: "pose_board_scaffold",
              status: "ready",
              mime: "image/png",
            },
          }) : null,
        ]) : [null, null];
        if (!priorBoard || priorBoard.id !== expectedArtifactId) {
          throw new Error("受控 running-right 续跑缺少已锁定的失败姿势板");
        }
        scaffoldSourceArtifactId = priorBoard.id;
        if (expectedScaffoldArtifactId) {
          if (!recoveryScaffold) throw new Error("受控 running-right 续跑缺少已锁定的恢复脚手架");
          layout = await ctx.artifacts.load(recoveryScaffold);
          scaffoldArtifactId = recoveryScaffold.id;
        } else {
          const priorBuffer = await ctx.artifacts.load(priorBoard);
          const priorExtracted = await extractPoseBoard(priorBuffer, {
            columns: spec.boardColumns,
            rows: spec.boardRows,
            frameCount: spec.frameCount,
            chromaKey: ctx.identity.chromaKey,
            requireUnusedSlotsEmpty: true,
          });
          if (priorExtracted.ok && priorExtracted.frames.length >= 5) {
            poseVariants = await selectSeedreamGaitScaffoldVariants(priorExtracted.frames);
            variantSequence = [0, 1, 0, 1, 0, 1, 0, 1];
            scaffoldArtifactId = priorBoard.id;
          }
        }
      }
    }
    // A repeated canonical scaffold is useful for the quiet idle row, but it
    // makes Seedream copy one frozen pose into every slot of a dynamic row.
    // Dynamic rows already receive the canonical image separately; omitting
    // the repeated scaffold leaves the action prompt responsible for phase
    // changes instead of supplying six/eight static exemplars to copy.
    if (state === "idle" || poseVariants) {
      layout = await createSeedreamPoseBoardScaffold({
        canonical: canonical.buffer,
        ...(poseVariants ? { poseVariants, variantSequence } : {}),
        chromaKey: ctx.identity.chromaKey,
        columns: spec.boardColumns,
        rows: spec.boardRows,
        frameCount: spec.frameCount,
      });
    }
  } else {
    layout = await createLayoutGuide({ columns: spec.boardColumns, rows: spec.boardRows, frameCount: spec.frameCount, title: `${state} ${spec.frameCount}-pose board` });
  }
  const inputArtifactIds = [...new Set([
    canonical.artifact.id,
    scaffoldSourceArtifactId,
    scaffoldArtifactId,
  ].filter((artifactId): artifactId is string => Boolean(artifactId)))];
  const authoritativeActionPrompt = ctx.identity.actionPrompts?.[state]?.trim();
  return runBoardJob(ctx, {
    key: `row-${state}`,
    kind: "standard_row",
    dependencies: state === "running-left" ? ["row-running-right"] : ["identity-guide"],
    inputArtifactIds,
    prompt: buildStandardRowPrompt(ctx.identity, state),
    promptVersion: codexPetStandardRowPromptVersion(state),
    references: [
      imageInput(canonical.buffer, canonical.artifact.mime, "canonical-base.png"),
      ...(layout ? [imageInput(layout, "image/png", ctx.imageModel === DOUBAO_IMAGE_MODEL ? `${state}-seedream-scaffold.png` : `${state}-layout.png`)] : []),
    ],
    columns: spec.boardColumns,
    rows: spec.boardRows,
    frameCount: spec.frameCount,
    progress,
    qaKind: "row",
    qaContext: `${state} 动作组：身份、${spec.frameCount} 帧结构、动作语义和连续性`,
    workflowStage,
    animationDurations: spec.durations,
    force,
    repairHint,
    jumpingTargetHeight: state === "jumping" ? jumpingTargetHeight : undefined,
    allowAuxiliaryForegroundComponents: Boolean(authoritativeActionPrompt),
    authoritativeActionPrompt,
  });
}

export async function storeStandardAtlas(ctx: RunnerContext, frames: PetFramesByState, force = false): Promise<{
  atlas: Buffer;
  contact: Buffer;
  atlasArtifact: CodexPetArtifact;
  contactArtifact: CodexPetArtifact;
  validation: Awaited<ReturnType<typeof validateStandardPetAtlas>>;
}> {
  const inspectionOptions = {
    allowAuxiliaryForegroundComponentsForStates: customizedStandardActionStates(ctx.identity.actionPrompts),
  } as const;
  const job = await ensureJob(ctx, "standard-atlas", "deterministic_assembly", PET_ROW_SPECS.slice(0, 9).map((spec) => `row-${spec.state}`));
  const output = asRecord(job.output);
  if (!force && job.status === "completed" && typeof output.atlasArtifactId === "string" && typeof output.contactArtifactId === "string") {
    const [atlasArtifact, contactArtifact] = await Promise.all([
      ctx.prisma.codexPetArtifact.findFirst({ where: { id: output.atlasArtifactId, runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId } }),
      ctx.prisma.codexPetArtifact.findFirst({ where: { id: output.contactArtifactId, runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId } }),
    ]);
    if (atlasArtifact && contactArtifact) {
      const [atlas, contact] = await Promise.all([ctx.artifacts.load(atlasArtifact), ctx.artifacts.load(contactArtifact)]);
      const validation = await validateStandardPetAtlas(atlas, inspectionOptions);
      // A recovered atlas that no longer validates carries the same row-scoped
      // evidence as a fresh one, so the caller can repair and force a rebuild
      // instead of failing a run whose rows are mostly good.
      if (!validation.ok) throw new CodexPetStandardAtlasStructureError(validation);
      return { atlas, contact, atlasArtifact, contactArtifact, validation };
    }
  }
  const atlas = await assembleStandardPetAtlas(frames, "webp");
  const validation = await validateStandardPetAtlas(atlas, inspectionOptions);
  if (!validation.ok) throw new CodexPetStandardAtlasStructureError(validation);
  const contact = await createStandardAtlasContactSheet(atlas);
  const [atlasArtifact, contactArtifact, validationArtifact] = await Promise.all([
    ctx.artifacts.put({ userId: ctx.project.userId, projectId: ctx.project.id, runId: ctx.runId, jobId: job.id, kind: "standard_atlas", name: "标准 8×9 中间图集", buffer: atlas, mime: "image/webp", expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS) }),
    ctx.artifacts.put({ userId: ctx.project.userId, projectId: ctx.project.id, runId: ctx.runId, jobId: job.id, kind: "qa_contact_sheet", name: "标准动作 Contact Sheet", buffer: contact, mime: "image/png", expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS) }),
    putJsonArtifact(ctx, { jobId: job.id, kind: "qa_report", name: "标准 8×9 图集结构验证", value: validation, expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS) }),
  ]);
  await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
    status: "completed",
    attempt: 1,
    output: { atlasArtifactId: atlasArtifact.id, contactArtifactId: contactArtifact.id, validationArtifactId: validationArtifact.id } as Prisma.InputJsonValue,
    outputArtifactIds: [atlasArtifact.id, contactArtifact.id, validationArtifact.id],
    completedAt: new Date(),
  } });
  if (validation.warnings.length > 0) {
    await emit(ctx, "validation.warning", "standard_generating", 65, "标准动作图集通过结构检查，存在可复核警告", { warnings: validation.warnings }, job.key);
  }
  return { atlas, contact, atlasArtifact, contactArtifact, validation };
}
