// 由 codex-pet-runner.ts 纯移动而来（P3.1 阶段 1，方向行配准与复核）。

import { Buffer } from "node:buffer";
import {
  type DirectionRegistrationCellDiagnostics,
  LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
  LOOK_DIRECTIONS,
  type NeutralDirectionGeometryValidation,
  type NeutralDirectionRegistrationManifest,
  composeCardinalAnchorStrip,
  createAnimatedWebpPreview,
  measureDirectionRowContinuity,
  parseNeutralDirectionRegistrationManifest,
  petRowSpec,
  registerFirstDirectionRowToNeutral,
  registerSecondDirectionRowWithManifest,
  splitRegisteredDirectionRow,
  validateNeutralLockedDirectionFrames,
} from "@ai-assistant/codex-pet-pipeline";
import { type CodexPetArtifact, type CodexPetJob, Prisma } from "@prisma/client";
import {
  CODEX_PET_CARDINAL_APPEARANCE_CONTRACT,
  buildLookMechanicsPrompt,
  buildVisualQaPrompt,
  sanitizeCodexPetDirectionRepairPrompt,
} from "../codex-pet-prompts.js";
import { ensureJob, putJsonArtifact, startJob } from "../codex-pet-runner/runner-jobs.js";
import { checkCancelled, emit } from "../codex-pet-runner/runner-lease.js";
import { assertCodexPetVisualQaProvenance } from "../codex-pet-runner/runner-provenance.js";
import {
  type BoardJobResult,
  CodexPetLeaseLostError,
  INTERMEDIATE_TTL_MS,
  type RegisteredDirectionRowResult,
  type RunnerContext,
} from "../codex-pet-runner/runner-types.js";
import { asRecord, imageInput, sameOrderedStrings } from "../codex-pet-runner/runner-util.js";
import {
  type CodexPetVisualModelProvenance,
  type PetVisualQaConsensus,
  codexPetVisualQaConsensusPasses,
} from "../codex-pet-visual.js";
import { type ImageBinaryInput } from "../image-service.js";

/** Build a deterministic reference from the four QA-approved cardinal cells.
 * The original 2×2 model board remains provenance; direction generation uses
 * this extracted strip so labels/layout noise can never become part of the
 * visual reference. */
export async function createApprovedCardinalAnchor(ctx: RunnerContext, cardinals: BoardJobResult, force = false): Promise<{ artifact: CodexPetArtifact; buffer: Buffer }> {
  const job = await ensureJob(ctx, "cardinal-anchor-strip", "deterministic_assembly", ["look-cardinals"], {
    directions: ["000", "090", "180", "270"],
    sourceBoardArtifactId: cardinals.boardArtifact.id,
  });
  const output = asRecord(job.output);
  if (!force && job.status === "completed" && typeof output.artifactId === "string") {
    const artifact = await ctx.prisma.codexPetArtifact.findFirst({
      where: {
        id: output.artifactId,
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
      },
    });
    if (artifact) return { artifact, buffer: await ctx.artifacts.load(artifact) };
  }
  const buffer = await composeCardinalAnchorStrip(cardinals.frames);
  const artifact = await ctx.artifacts.put({
    userId: ctx.project.userId,
    projectId: ctx.project.id,
    runId: ctx.runId,
    jobId: job.id,
    kind: "cardinal_anchor_strip",
    name: "已批准四方向锚点参考",
    buffer,
    mime: "image/png",
    metadata: {
      directions: ["000", "090", "180", "270"],
      sourceBoardArtifactId: cardinals.boardArtifact.id,
      sourceFrameArtifactIds: cardinals.frameArtifacts.map((item) => item.id),
      cardinalEvidence: cardinals.frameArtifacts.map((item, index) => ({
        direction: (["000", "090", "180", "270"] as const)[index],
        frameArtifactId: item.id,
        extractionDiagnostics: asRecord(item.metadata).diagnostics,
        semanticQa: {
          score: cardinals.qa.score,
          pass: cardinals.qa.pass,
          warnings: cardinals.qa.warnings,
          failures: cardinals.qa.failures,
        },
      })),
      approved: true,
      width: 384,
      height: 416,
    },
    expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
  });
  await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
    status: "completed",
    inputArtifactIds: [cardinals.boardArtifact.id, ...cardinals.frameArtifacts.map((item) => item.id)],
    outputArtifactIds: [artifact.id],
    output: { artifactId: artifact.id, sourceBoardArtifactId: cardinals.boardArtifact.id } as Prisma.InputJsonValue,
    attempt: Math.max(1, job.attempt),
    completedAt: new Date(),
    workerId: null,
  } });
  await emit(ctx, "preview.ready", "direction_generating", 70, "四个批准方向锚点参考已生成", { artifactId: artifact.id }, job.key);
  return { artifact, buffer };
}

/**
 * GPT Image edits preserves only the first two direction references as
 * independent multipart images and compacts the remaining guidance into one
 * contact sheet. Direction edits keep a deterministic 4×2 direction scaffold
 * first as the primary edit target and canonical identity second. The complete
 * cardinal basis remains in supporting guidance. Standard motion, layout, the
 * registered first row and failed-board diagnostics are useful continuity
 * evidence, but none may outrank the cardinal semantics.
 */
export function lookRowReferences(input: {
  readonly row: "look-a" | "look-b";
  readonly anchorStoryboard: Buffer;
  readonly directionArcGuide?: Buffer;
  readonly canonical: { readonly buffer: Buffer; readonly mime: string };
  readonly cardinalAnchor: { readonly buffer: Buffer; readonly mime: string };
  readonly standardContact: Buffer;
  readonly layout: Buffer;
  readonly registeredLookA?: Buffer;
  readonly diagnosticBoard?: Buffer;
}): readonly ImageBinaryInput[] {
  if (input.row === "look-b" && !input.directionArcGuide) {
    throw new Error("look-b requires the deterministic screen-left trajectory scaffold");
  }
  const authoritative = [
    imageInput(
      input.row === "look-b" ? input.directionArcGuide! : input.anchorStoryboard,
      "image/png",
      input.row === "look-b" ? "look-b-screen-left-trajectory-scaffold.png" : "look-a-approved-anchor-storyboard.png",
    ),
    imageInput(input.canonical.buffer, input.canonical.mime, "approved-canonical-base.png"),
  ];
  if (input.row === "look-a") {
    const references = [
      ...authoritative,
      imageInput(input.cardinalAnchor.buffer, input.cardinalAnchor.mime, "approved-cardinal-anchor-strip.png"),
      imageInput(input.standardContact, "image/png", "approved-standard-contact.png"),
      imageInput(input.layout, "image/png", "look-layout.png"),
    ];
    if (input.diagnosticBoard) {
      references.push(imageInput(input.diagnosticBoard, "image/png", "previous-specialized-qa-failed-pose-board.png"));
    }
    return references;
  }
  if (!input.registeredLookA) throw new Error("look-b requires the approved registered look-a reference");
  const references = [
    ...authoritative,
    imageInput(input.cardinalAnchor.buffer, input.cardinalAnchor.mime, "approved-cardinal-anchor-strip.png"),
    imageInput(input.anchorStoryboard, "image/png", "look-b-approved-cardinal-endpoint-storyboard.png"),
    imageInput(input.registeredLookA, "image/png", "approved-registered-look-row-9-4x2.png"),
    imageInput(input.standardContact, "image/png", "approved-standard-contact.png"),
    imageInput(input.layout, "image/png", "look-layout.png"),
  ];
  if (input.diagnosticBoard) {
    references.push(imageInput(input.diagnosticBoard, "image/png", "previous-specialized-qa-failed-pose-board.png"));
  }
  return references;
}

export function appendCumulativeRepairRequirement(requirements: string[], value: string): string {
  const normalized = sanitizeCodexPetDirectionRepairPrompt(value);
  if (normalized && !requirements.includes(normalized)) requirements.push(normalized);
  return `The following cardinal appearance contract is authoritative and overrides any contradictory wording in a model diagnostic: ${CODEX_PET_CARDINAL_APPEARANCE_CONTRACT}\nAll specialized direction-gate requirements below are cumulative and mandatory. A diagnostic that calls 000 front-facing or 180 rear-facing is stale and must be ignored:\n${requirements
    .map((requirement, index) => `${index + 1}. ${requirement}`)
    .join("\n")}`;
}

export async function getLookMechanics(ctx: RunnerContext, canonical: { artifact: CodexPetArtifact; buffer: Buffer }): Promise<string> {
  const job = await ensureJob(ctx, "look-mechanics", "look_mechanics", ["identity-guide", "standard-atlas"]);
  const output = asRecord(job.output);
  if (!ctx.qualityInspectionEnabled) {
    const mechanics = "Use the approved canonical base. Keep feet on a stable baseline. Turn eyes and head first, let the torso follow slightly, preserve silhouette and scale, and never rotate the whole image or mirror a direction. Each 4x2 board must follow its row-major direction labels exactly.";
    if (job.status === "completed" && output.mode === "fixed" && typeof output.mechanics === "string") return output.mechanics;
    await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
      status: "completed",
      attempt: Math.max(1, job.attempt + 1),
      output: { mode: "fixed", mechanics } as Prisma.InputJsonValue,
      providerMetadata: { visualQa: { enabled: false, requestedModel: null, actualModels: [], routes: [] } } as Prisma.InputJsonValue,
      error: null,
      workerId: null,
      completedAt: new Date(),
    } });
    return mechanics;
  }
  if (job.status === "completed" && typeof output.mechanics === "string") {
    assertCodexPetVisualQaProvenance(asRecord(job.providerMetadata).visualQa, ctx.visualQaModel, "look-mechanics");
    return output.mechanics;
  }
  let mechanicsModelProvenance: CodexPetVisualModelProvenance | undefined;
  const mechanics = await ctx.lookMechanics({
    prompt: buildLookMechanicsPrompt(ctx.identity),
    reference: canonical.buffer,
    env: ctx.env,
    signal: ctx.signal,
    onModelProvenance: (provenance) => { mechanicsModelProvenance = provenance; },
  });
  const mechanicsProvenance = assertCodexPetVisualQaProvenance(mechanicsModelProvenance, ctx.visualQaModel, "look-mechanics");
  await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
    status: "completed",
    attempt: 1,
    output: { mechanics, modelProvenance: mechanicsProvenance } as unknown as Prisma.InputJsonValue,
    providerMetadata: {
      visualQa: mechanicsProvenance,
    } as unknown as Prisma.InputJsonValue,
    completedAt: new Date(),
  } });
  return mechanics;
}

export function recoveredRegistrationDiagnostics(
  validation: NeutralDirectionGeometryValidation,
): readonly DirectionRegistrationCellDiagnostics[] {
  return validation.frames.map((frame) => ({
    index: frame.index,
    sourceBounds: null,
    sourceGeometry: null,
    normalizedBounds: frame.geometry?.bounds ?? null,
    normalizedGeometry: frame.geometry,
    chromaCoverage: 0,
    edgePixels: frame.edgePixels,
    errors: frame.errors,
    warnings: [...frame.warnings, "recovered-from-registered-artifact"],
  }));
}

export function registeredSourceBoardSize(output: Record<string, unknown>, manifest: NeutralDirectionRegistrationManifest): { width: number; height: number } {
  const source = asRecord(output.sourceBoardSize);
  return {
    width: typeof source.width === "number" && Number.isFinite(source.width) ? source.width : manifest.row9Source.width,
    height: typeof source.height === "number" && Number.isFinite(source.height) ? source.height : manifest.row9Source.height,
  };
}

export async function completedRegisteredDirectionRow(
  ctx: RunnerContext,
  job: CodexPetJob,
  source: BoardJobResult,
  neutral: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer },
  expectedInputArtifactIds: readonly string[],
  lockedManifestArtifactId?: string,
): Promise<RegisteredDirectionRowResult | null> {
  if (job.status !== "completed" || !sameOrderedStrings(job.inputArtifactIds, expectedInputArtifactIds)) return null;
  const output = asRecord(job.output);
  if (output.sourceBoardArtifactId !== source.boardArtifact.id || output.neutralFrameArtifactId !== neutral.artifact.id
    || typeof output.registeredRowArtifactId !== "string" || typeof output.manifestArtifactId !== "string") return null;
  if (lockedManifestArtifactId && output.manifestArtifactId !== lockedManifestArtifactId) return null;
  const [registeredRowArtifact, manifestArtifact] = await Promise.all([
    ctx.prisma.codexPetArtifact.findFirst({ where: {
      id: output.registeredRowArtifactId,
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      status: "ready",
    } }),
    ctx.prisma.codexPetArtifact.findFirst({ where: {
      id: output.manifestArtifactId,
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      status: "ready",
    } }),
  ]);
  if (!registeredRowArtifact || !manifestArtifact) return null;
  try {
    const [registeredRow, manifestBytes] = await Promise.all([
      ctx.artifacts.load(registeredRowArtifact),
      ctx.artifacts.load(manifestArtifact),
    ]);
    const manifest = parseNeutralDirectionRegistrationManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown);
    const frames = await splitRegisteredDirectionRow(registeredRow);
    const validation = await validateNeutralLockedDirectionFrames(neutral.buffer, frames, manifest.thresholds);
    if (!validation.ok) return null;
    return {
      registrationJob: job,
      source,
      frames,
      registeredRow,
      registeredRowArtifact,
      manifest,
      manifestArtifact,
      validation,
      diagnostics: recoveredRegistrationDiagnostics(validation),
      sourceBoardSize: registeredSourceBoardSize(output, manifest),
      ok: true,
      errors: [],
      warnings: validation.warnings,
    };
  } catch {
    // A missing/corrupt deterministic artifact is cache corruption, not a
    // reason to invoke the image provider. Rebuild it from the durable source
    // board below and preserve the provider attempt budget.
    return null;
  }
}

/**
 * Persist the exact direction cells that QA and final assembly consume.
 * Row 9 creates the immutable neutral registration manifest. Row 10 reuses it
 * verbatim and can never trigger a second fit of the already-approved row 9.
 */
export async function registerDirectionRow(
  ctx: RunnerContext,
  input: {
    readonly row: "look-a" | "look-b";
    readonly source: BoardJobResult;
    readonly neutral: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer };
    readonly lockedRow9?: RegisteredDirectionRowResult;
    readonly progress: number;
  },
): Promise<RegisteredDirectionRowResult> {
  if (input.row === "look-b" && (!input.lockedRow9?.registeredRowArtifact || !input.lockedRow9.manifestArtifact)) {
    throw new Error("第二组观察方向缺少已批准的 row-9 注册产物");
  }
  const expectedInputArtifactIds = input.row === "look-a"
    ? [input.source.boardArtifact.id, input.neutral.artifact.id]
    : [
        input.source.boardArtifact.id,
        input.neutral.artifact.id,
        input.lockedRow9!.registeredRowArtifact!.id,
        input.lockedRow9!.manifestArtifact!.id,
      ];
  let job = await ensureJob(
    ctx,
    `${input.row}-registration`,
    "look_direction_registration",
    input.row === "look-a" ? ["look-a", "row-idle"] : ["look-b", "look-a-registration"],
    { row: input.row, schemaVersion: "codex-pet-neutral-direction-registration-v1" },
  );
  const cached = await completedRegisteredDirectionRow(
    ctx,
    job,
    input.source,
    input.neutral,
    expectedInputArtifactIds,
    input.lockedRow9?.manifestArtifact?.id,
  );
  if (cached) return cached;

  await checkCancelled(ctx);
  const obsoleteArtifactIds = [...job.outputArtifactIds];
  if (obsoleteArtifactIds.length > 0) {
    await ctx.prisma.codexPetArtifact.updateMany({
      where: {
        id: { in: obsoleteArtifactIds },
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
      },
      data: { status: "superseded", expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS) },
    });
  }
  job = await startJob(
    ctx,
    job,
    Math.max(1, input.source.job.attempt),
    input.progress,
    input.row === "look-a" ? "按已批准 idle 中立帧注册第一组观察方向" : "复用 row-9 固定变换注册第二组观察方向",
  );
  const result = input.row === "look-a"
    ? await registerFirstDirectionRowToNeutral(input.source.board, input.neutral.buffer, {
        chromaKey: ctx.identity.chromaKey,
        frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
      })
    : await registerSecondDirectionRowWithManifest(
        input.source.board,
        input.neutral.buffer,
        input.lockedRow9!.manifest,
        { chromaKey: ctx.identity.chromaKey, frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT },
      );
  const reportArtifact = await putJsonArtifact(ctx, {
    jobId: job.id,
    kind: "direction_registration_report",
    name: `${input.row === "look-a" ? "row 9" : "row 10"} 中立帧锁定注册报告 · 第 ${input.source.job.attempt} 次`,
    value: {
      schemaVersion: result.manifest.schemaVersion,
      sourceBoardArtifactId: input.source.boardArtifact.id,
      neutralFrameArtifactId: input.neutral.artifact.id,
      sourceBoardSize: result.sourceBoardSize,
      transform: result.manifest.transform,
      validation: result.validation,
      diagnostics: result.diagnostics,
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
    },
    expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
  });
  if (!result.ok) {
    const rejected = await ctx.prisma.codexPetJob.updateMany({
      where: { id: job.id, runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId },
      data: {
        status: "queued",
        inputArtifactIds: [...expectedInputArtifactIds],
        outputArtifactIds: [reportArtifact.id],
        output: {
          sourceBoardArtifactId: input.source.boardArtifact.id,
          neutralFrameArtifactId: input.neutral.artifact.id,
          reportArtifactId: reportArtifact.id,
          sourceBoardSize: result.sourceBoardSize,
          ok: false,
          errors: result.errors,
        } as Prisma.InputJsonValue,
        error: result.errors.join("；") || "中立帧锁定注册未通过",
        workerId: null,
        completedAt: null,
      },
    });
    if (rejected.count !== 1) throw new CodexPetLeaseLostError();
    return {
      registrationJob: job,
      source: input.source,
      frames: result.frames,
      registeredRow: result.registeredRow,
      registeredRowArtifact: null,
      manifest: result.manifest,
      manifestArtifact: input.lockedRow9?.manifestArtifact ?? null,
      validation: result.validation,
      diagnostics: result.diagnostics,
      sourceBoardSize: result.sourceBoardSize,
      ok: false,
      errors: result.errors,
      warnings: result.warnings,
    };
  }

  const manifestArtifact = input.row === "look-a"
    ? await putJsonArtifact(ctx, {
        jobId: job.id,
        kind: "direction_registration_manifest",
        name: "row 9 中立帧锁定注册 Manifest",
        value: result.manifest,
        expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
      })
    : input.lockedRow9!.manifestArtifact!;
  const registeredRowArtifact = await ctx.artifacts.put({
    userId: ctx.project.userId,
    projectId: ctx.project.id,
    runId: ctx.runId,
    jobId: job.id,
    kind: "registered_direction_row",
    name: input.row === "look-a" ? "已批准注册 row 9 · 000–157.5" : "固定 row-9 变换注册 row 10 · 180–337.5",
    buffer: result.registeredRow,
    mime: "image/png",
    width: 1536,
    height: 208,
    metadata: {
      row: input.row === "look-a" ? 9 : 10,
      sourceBoardArtifactId: input.source.boardArtifact.id,
      neutralFrameArtifactId: input.neutral.artifact.id,
      manifestArtifactId: manifestArtifact.id,
      schemaVersion: result.manifest.schemaVersion,
      lockedScale: result.manifest.transform.scale,
      target: result.manifest.transform.target,
      validation: {
        medianHeightRatio: result.validation.medianHeightRatio,
        medianWidthRatio: result.validation.medianWidthRatio,
      },
    },
    expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
  });
  const outputArtifactIds = input.row === "look-a"
    ? [registeredRowArtifact.id, manifestArtifact.id, reportArtifact.id]
    : [registeredRowArtifact.id, reportArtifact.id];
  const completed = await ctx.prisma.codexPetJob.updateMany({
    where: { id: job.id, runId: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId },
    data: {
      status: "completed",
      inputArtifactIds: [...expectedInputArtifactIds],
      outputArtifactIds,
      output: {
        sourceBoardArtifactId: input.source.boardArtifact.id,
        neutralFrameArtifactId: input.neutral.artifact.id,
        registeredRowArtifactId: registeredRowArtifact.id,
        manifestArtifactId: manifestArtifact.id,
        reportArtifactId: reportArtifact.id,
        sourceBoardSize: result.sourceBoardSize,
        ok: true,
      } as Prisma.InputJsonValue,
      error: null,
      workerId: null,
      completedAt: new Date(),
    },
  });
  if (completed.count !== 1) throw new CodexPetLeaseLostError();
  await emit(ctx, "preview.ready", "direction_generating", input.progress,
    input.row === "look-a" ? "第一组观察方向已按中立帧完成固定注册" : "第二组观察方向已复用 row-9 固定注册",
    {
      artifactId: registeredRowArtifact.id,
      manifestArtifactId: manifestArtifact.id,
      lockedScale: result.manifest.transform.scale,
      medianHeightRatio: result.validation.medianHeightRatio,
    }, job.key);
  return {
    registrationJob: { ...job, status: "completed", workerId: null, outputArtifactIds },
    source: input.source,
    frames: result.frames,
    registeredRow: result.registeredRow,
    registeredRowArtifact,
    manifest: result.manifest,
    manifestArtifact,
    validation: result.validation,
    diagnostics: result.diagnostics,
    sourceBoardSize: result.sourceBoardSize,
    ok: true,
    errors: [],
    warnings: result.warnings,
  };
}

export function requireApprovedRegisteredRow(result: RegisteredDirectionRowResult, label: string): asserts result is RegisteredDirectionRowResult & {
  readonly registeredRowArtifact: CodexPetArtifact;
  readonly manifestArtifact: CodexPetArtifact;
} {
  if (!result.ok || !result.registeredRowArtifact || !result.manifestArtifact) {
    throw new Error(`${label} 未形成可恢复的注册产物`);
  }
}

export async function reviewFirstLookRow(
  ctx: RunnerContext,
  input: {
    readonly look: RegisteredDirectionRowResult;
    readonly canonical: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer };
    readonly standardContact: Buffer;
    readonly cardinalAnchor: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer };
  },
) {
  const directions = LOOK_DIRECTIONS.slice(0, 8);
  const continuity = await measureDirectionRowContinuity(input.look.frames, directions);
  if (!input.look.ok || !continuity.ok) {
    const failures = [...input.look.errors, ...continuity.errors];
    await putJsonArtifact(ctx, {
      jobId: input.look.registrationJob.id,
      kind: "qa_report",
      name: `方向 000–157.5 注册与连续性门禁 · 第 ${input.look.source.job.attempt} 次`,
      value: { neutralRegistration: input.look.validation, deterministicContinuity: continuity, failures },
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    });
    return {
      pass: false,
      continuity,
      visual: null,
      failures,
      repairPrompt: failures.join("; ") || "repair direction scale, lower-body anchor, baseline, edge clearance or structural cells",
    };
  }
  if (!ctx.qualityInspectionEnabled) {
    await putJsonArtifact(ctx, {
      jobId: input.look.registrationJob.id,
      kind: "qa_report",
      name: `方向 000–157.5 本地注册与连续性检查 · 第 ${input.look.source.job.attempt} 次`,
      value: { neutralRegistration: input.look.validation, deterministicContinuity: continuity, visualQa: { enabled: false, requestedModel: null, actualModels: [], routes: [] } },
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    });
    return { pass: true, continuity, visual: null, failures: [], repairPrompt: "" };
  }
  const preview = await createAnimatedWebpPreview(input.look.frames, petRowSpec("look-a").durations);
  const qa = await ctx.qaConsensus({
    images: [
      { buffer: input.canonical.buffer, mime: input.canonical.artifact.mime },
      { buffer: input.standardContact, mime: "image/png" },
      { buffer: input.cardinalAnchor.buffer, mime: input.cardinalAnchor.artifact.mime },
      // Keep the complete registered row as a static, inspectable artifact in
      // addition to the animated preview. Some multimodal reviewers inspect
      // only the first animation frame and otherwise cannot verify all eight
      // direction cells or a local reversal.
      { buffer: input.look.registeredRow, mime: "image/png" },
      { buffer: preview.image, mime: preview.mime },
    ],
    prompt: buildVisualQaPrompt(
      "directions",
      `Pre-row-10 gate for the registered row-9 sequence 000, 022.5, 045, 067.5, 090, 112.5, 135, 157.5. `
      + `Confirm 000 unmistakably up, 090 unmistakably screen-right, every intermediate stays in its labeled quadrant, and the animated sequence advances clockwise without reversal, registration snap, scale pop or identity drift. `
      + `Image 3 is the authoritative 2x2 cardinal basis: top-left 000 UP, top-right 090 SCREEN-RIGHT, bottom-left 180 DOWN, bottom-right 270 SCREEN-LEFT. Row-9 cell 1 must match Image 3 top-left's visible front/back appearance, cell 5 must match its top-right, and cell 8 must visibly approach its bottom-left without entering the opposite side. `
      + `Image 4 is the complete static eight-frame registered row in chronological left-to-right order; inspect every cell. Image 5 is its animation preview. `
      + `Continuity metrics are review evidence only: ${continuity.warnings.map((warning) => warning.message).slice(0, 16).join(" | ") || "none"}.`,
      ctx.identity.canonicalGuide,
    ),
    env: ctx.env,
    signal: ctx.signal,
    repetitions: 1,
  });
  assertCodexPetVisualQaProvenance(qa.modelProvenance, ctx.visualQaModel, "row9-pre-generation-gate");
  await putJsonArtifact(ctx, {
    jobId: input.look.registrationJob.id,
    kind: "qa_report",
    name: `方向 000–157.5 注册与连续性门禁 · 第 ${input.look.source.job.attempt} 次`,
    value: { neutralRegistration: input.look.validation, deterministicContinuity: continuity, visual: qa },
    expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
  });
  const passed = codexPetVisualQaConsensusPasses(qa);
  return {
    pass: passed,
    continuity,
    visual: qa,
    failures: qa.failures,
    repairPrompt: qa.verdicts.find((verdict) => verdict.repairPrompt)?.repairPrompt
      || qa.failures.join("; ")
      || "strengthen labeled direction semantics and adjacent continuity for the complete row",
  };
}

/**
 * Independent row-10 (180–337.5°) gate.  Row 10 is checked before final
 * assembly, rather than relying solely on the full-atlas blind test.  The
 * previous row is supplied to the multimodal reviewer to expose both seam
 * continuity (157.5→180 and 337.5→000) and registration/scale changes.
 */
export async function reviewSecondLookRow(
  ctx: RunnerContext,
  input: {
    readonly look: RegisteredDirectionRowResult;
    readonly previousLook: RegisteredDirectionRowResult;
    readonly canonical: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer };
    readonly standardContact: Buffer;
    readonly cardinalAnchor: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer };
  },
) {
  const directions = LOOK_DIRECTIONS.slice(8);
  const continuity = await measureDirectionRowContinuity(input.look.frames, directions);
  const preview = await createAnimatedWebpPreview(input.look.frames, petRowSpec("look-b").durations);
  let qa: PetVisualQaConsensus = {
    pass: false,
    verdicts: [],
    score: 0,
    mirrorSafe: false,
    warnings: [],
    failures: [],
  };
  if (!ctx.qualityInspectionEnabled && input.look.ok && continuity.ok) {
    await putJsonArtifact(ctx, {
      jobId: input.look.registrationJob.id,
      kind: "qa_report",
      name: `方向 180–337.5 本地注册与连续性检查 · 第 ${input.look.source.job.attempt} 次`,
      value: { row: 10, directions, neutralRegistration: input.look.validation, deterministicContinuity: continuity, visualQa: { enabled: false, requestedModel: null, actualModels: [], routes: [] } },
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    });
    return { pass: true, continuity, visual: null, failures: [], repairPrompt: "" };
  }
  if (input.look.ok && continuity.ok) {
    qa = await ctx.qaConsensus({
      images: [
        { buffer: input.canonical.buffer, mime: input.canonical.artifact.mime },
        { buffer: input.standardContact, mime: "image/png" },
        { buffer: input.cardinalAnchor.buffer, mime: input.cardinalAnchor.artifact.mime },
        { buffer: input.previousLook.registeredRow, mime: "image/png" },
        { buffer: input.look.registeredRow, mime: "image/png" },
        { buffer: preview.image, mime: preview.mime },
      ],
      prompt: buildVisualQaPrompt(
        "directions",
        `Independent pre-row-10 gate for registered directions 180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5. `
        + `Confirm 180 unmistakably down, 270 unmistakably screen-left, every intermediate remains in its labeled quadrant, and the animated row advances clockwise without reversal, registration snap, scale pop or identity drift. `
        + `Image 3 is the authoritative 2x2 cardinal basis: top-left 000 UP, top-right 090 SCREEN-RIGHT, bottom-left 180 DOWN, bottom-right 270 SCREEN-LEFT. Image 4 is approved row 9; Image 5 is the complete static row 10 in chronological left-to-right order; Image 6 is its animation preview. Row-10 cell 1 must match Image 3 bottom-left and cell 5 must match Image 3 bottom-right. `
        + `Compare the preceding 157.5 frame from row 9 and the 000 anchor for both row-boundary seams. `
        + `Continuity metrics are review evidence only: ${continuity.warnings.map((warning) => warning.message).slice(0, 16).join(" | ") || "none"}.`,
        ctx.identity.canonicalGuide,
      ),
      env: ctx.env,
      signal: ctx.signal,
      repetitions: 1,
    });
    assertCodexPetVisualQaProvenance(qa.modelProvenance, ctx.visualQaModel, "row10-pre-generation-gate");
  }
  const failures = [...input.look.errors, ...continuity.errors, ...qa.failures];
  const repairPrompt = qa.verdicts.find((verdict) => verdict.repairPrompt)?.repairPrompt
    || failures.join("; ")
    || "strengthen the complete 180–337.5 direction row and both row-boundary seams";
  await putJsonArtifact(ctx, {
    jobId: input.look.registrationJob.id,
    kind: "qa_report",
    name: `方向 180–337.5 注册与连续性门禁 · 第 ${input.look.source.job.attempt} 次`,
    value: {
      row: 10,
      directions,
      neutralRegistration: input.look.validation,
      deterministicContinuity: continuity,
      visual: qa,
      animationPreview: { frameCount: preview.frameCount, durations: preview.durations },
      previousRowArtifactId: input.previousLook.registeredRowArtifact?.id ?? null,
      cardinalAnchorArtifactId: input.cardinalAnchor.artifact.id,
      row10PreGenerationGate: { passed: input.look.ok && continuity.ok && codexPetVisualQaConsensusPasses(qa), failures },
    },
    expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
  });
  return {
    pass: input.look.ok && continuity.ok && codexPetVisualQaConsensusPasses(qa),
    continuity,
    visual: qa,
    failures,
    repairPrompt,
  };
}
