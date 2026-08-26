// 由 codex-pet-runner.ts 纯移动而来（P3.1 阶段 1，底图候选与身份指南）。

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { type CodexPetArtifact, type CodexPetJob, Prisma } from "@prisma/client";
import { codexPetGptFailedContinuationSnapshot } from "../codex-pet-gpt-continuation.js";
import { CodexPetModelContractError } from "../codex-pet-model-contract.js";
import { buildBaseChoiceQaContext, buildBasePetPrompt, buildVisualQaPrompt } from "../codex-pet-prompts.js";
import {
  completeImageGenerationAttempt,
  prepareImageGenerationDispatch,
  recordImageGenerationAttempt,
} from "./runner-billing.js";
import {
  ensureJob,
  failJobAttempt,
  loadArtifactsInOrder,
  markImageSucceeded,
  putJsonArtifact,
  startJob,
} from "./runner-jobs.js";
import { checkCancelled, currentRun, emit, updateOwnedJob } from "./runner-lease.js";
import { assertCodexPetVisualQaProvenance } from "./runner-provenance.js";
import {
  CodexPetCancelledError,
  CodexPetImageApprovalRequiredError,
  CodexPetLeaseLostError,
  IDENTITY_GUIDE_VERSION,
  INTERMEDIATE_TTL_MS,
  type RunnerContext,
} from "./runner-types.js";
import {
  asRecord,
  configuredTransportAttempts,
  imageFailureMetadata,
  providerMetadata,
  safeError,
} from "./runner-util.js";
import { type CodexPetVisualModelProvenance, codexPetVisualQaVerdictPasses } from "../codex-pet-visual.js";
import { classifyImageGenerationError } from "../../_shared/image-service.js";

export async function reuseGptContinuationBaseCandidate(
  ctx: RunnerContext,
  job: CodexPetJob,
  candidateIndex: number,
): Promise<{ artifact: CodexPetArtifact; buffer: Buffer } | null> {
  if (candidateIndex !== 1 || job.attempt !== 0) return null;
  const run = await currentRun(ctx);
  const continuation = codexPetGptFailedContinuationSnapshot(run.inputSnapshot);
  if (!continuation) return null;

  const existing = await ctx.prisma.codexPetArtifact.findFirst({
    where: {
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      jobId: job.id,
      kind: "base_candidate",
      status: "ready",
    },
  });
  if (existing) {
    const buffer = await ctx.artifacts.load(existing);
    await ctx.prisma.codexPetJob.update({
      where: { id: job.id },
      data: { status: "completed", outputArtifactIds: [existing.id], completedAt: new Date(), workerId: null, error: null },
    });
    return { artifact: existing, buffer };
  }

  const source = await ctx.prisma.codexPetArtifact.findFirst({
    where: {
      id: continuation.sourceBaseArtifactId,
      runId: continuation.sourceRunId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      kind: "base_candidate",
      status: "ready",
    },
  });
  if (!source) throw new Error("GPT failed continuation source base candidate is unavailable");
  const buffer = await ctx.artifacts.load(source);
  const artifact = await ctx.artifacts.put({
    userId: ctx.project.userId,
    projectId: ctx.project.id,
    runId: ctx.runId,
    jobId: job.id,
    kind: "base_candidate",
    name: "主形象候选 1（复用）",
    buffer,
    mime: source.mime,
    metadata: {
      ...asRecord(source.metadata),
      reusedFrom: {
        runId: continuation.sourceRunId,
        artifactId: continuation.sourceBaseArtifactId,
        providerCallReused: true,
      },
    },
    expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
  });
  await ctx.prisma.codexPetJob.update({
    where: { id: job.id },
    data: { status: "completed", outputArtifactIds: [artifact.id], completedAt: new Date(), workerId: null, error: null },
  });
  await emit(ctx, "preview.ready", "base_generating", 8, "主形象候选 1 已从失败运行复用", {
    artifactId: artifact.id,
    sourceRunId: continuation.sourceRunId,
    providerCallReused: true,
  }, job.key);
  await emit(ctx, "job.completed", "base_generating", 8, "主形象候选 1 已复用，未产生模型调用", {
    artifactId: artifact.id,
    sourceRunId: continuation.sourceRunId,
    providerCallReused: true,
  }, job.key);
  return { artifact, buffer };
}

export async function generateBaseCandidate(ctx: RunnerContext, candidateIndex: number): Promise<{ artifact: CodexPetArtifact; buffer: Buffer }> {
  const key = `base-candidate-${candidateIndex}`;
  let job = await ensureJob(
    ctx,
    key,
    "base_candidate",
    [],
    { candidateIndex, referenceAssetIds: ctx.referenceAssetIds },
    ctx.maxBoardAttempts,
  );
  if (job.status === "completed" && job.outputArtifactIds.length === 1) {
    const loaded = await loadArtifactsInOrder(ctx, job.outputArtifactIds);
    return { artifact: loaded.artifacts[0]!, buffer: loaded.buffers[0]! };
  }
  const reused = await reuseGptContinuationBaseCandidate(ctx, job, candidateIndex);
  if (reused) return reused;
  const attempt = Math.max(1, job.attempt + 1);
  job = await startJob(ctx, job, attempt, 6 + candidateIndex * 2, `生成主形象候选 ${candidateIndex}`);
  try {
    const generated = await ctx.generate({
      prompt: buildBasePetPrompt(ctx.identity, candidateIndex),
      references: ctx.userReferences,
      size: "1024x1024",
      quality: "low",
      env: ctx.env,
      signal: ctx.signal,
      // Transport retries stay inside this one charged unit; only a quality
      // redraw costs another approval.
      maxAttempts: ctx.perImageBilling ? configuredTransportAttempts(ctx.env) : undefined,
      onAttempt: ctx.perImageBilling ? undefined : (providerAttempt) => recordImageGenerationAttempt(ctx, key, attempt, providerAttempt),
      onRequestDispatching: ctx.perImageBilling
        ? (transportAttempt) => prepareImageGenerationDispatch(ctx, key, attempt, transportAttempt)
        : undefined,
      onRequestSent: ctx.perImageBilling ? (providerAttempt) => recordImageGenerationAttempt(ctx, key, attempt, providerAttempt) : undefined,
      onRetry: async (error, transportAttempt) => emit(ctx, "job.retrying", "base_generating", 8, "生图服务暂时不可用，正在重试", {
        transportAttempt,
        retryKind: "transport",
        ...(ctx.perImageBilling ? { withinPaidCall: true } : {}),
        ...imageFailureMetadata(error),
      }, key),
    });
    await completeImageGenerationAttempt(ctx, key, attempt, generated.provider);
    await checkCancelled(ctx);
    const artifact = await ctx.artifacts.put({
      userId: ctx.project.userId,
      projectId: ctx.project.id,
      runId: ctx.runId,
      jobId: job.id,
      kind: "base_candidate",
      name: `主形象候选 ${candidateIndex}`,
      buffer: generated.buffer,
      mime: generated.mime,
      metadata: providerMetadata(generated.provider),
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    });
    // A stored base candidate is already a successful, user-visible image.
    // Persist this before releasing the run into awaiting_base_review so a
    // cancellation from that state follows the documented no-refund branch.
    await markImageSucceeded(ctx, job, generated.provider);
    job = await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: { status: "completed", outputArtifactIds: [artifact.id], completedAt: new Date(), workerId: null } });
    await emit(ctx, "preview.ready", "base_generating", 10, `主形象候选 ${candidateIndex} 已生成`, { artifactId: artifact.id }, key);
    await emit(ctx, "job.completed", "base_generating", 10, `主形象候选 ${candidateIndex} 已完成`, { artifactId: artifact.id }, key);
    return { artifact, buffer: generated.buffer };
  } catch (error) {
    await completeImageGenerationAttempt(ctx, key, attempt, undefined, error).catch(() => undefined);
    const failure = classifyImageGenerationError(error);
    await failJobAttempt(ctx, job, attempt, safeError(error), 10, true, imageFailureMetadata(error));
    if (ctx.perImageBilling && failure.category === "rate_limit") {
      throw new CodexPetImageApprovalRequiredError(
        key,
        `上游并发额度暂不可用，${key} 已暂停；需要单次授权后重试`,
      );
    }
    throw error;
  }
}

export async function selectBaseAutomatically(ctx: RunnerContext, candidates: readonly { artifact: CodexPetArtifact; buffer: Buffer }[]): Promise<string> {
  if (!ctx.qualityInspectionEnabled) throw new Error("AI quality inspection is disabled; base selection must be manual");
  const job = await ensureJob(ctx, "base-selection", "visual_qa", ["base-candidate-1", "base-candidate-2"]);
  const output = asRecord(job.output);
  if (job.status === "completed" && typeof output.selectedArtifactId === "string") {
    assertCodexPetVisualQaProvenance(asRecord(job.providerMetadata).visualQa, ctx.visualQaModel, "base-selection");
    return output.selectedArtifactId;
  }
  const verdicts = await Promise.all(candidates.map((candidate, index) => ctx.qa({
    images: [
      { buffer: candidate.buffer, mime: candidate.artifact.mime },
      ...ctx.userReferences.slice(0, 3).map((reference) => ({ buffer: Buffer.from(reference.b64, "base64"), mime: reference.mime })),
    ],
    prompt: buildVisualQaPrompt("base-choice", buildBaseChoiceQaContext(index + 1)),
    env: ctx.env,
    signal: ctx.signal,
  })));
  await checkCancelled(ctx);
  const baseQaProvenance = verdicts.map((verdict, index) => (
    assertCodexPetVisualQaProvenance(verdict.modelProvenance, ctx.visualQaModel, `base-selection-candidate-${index + 1}`)
  ));
  const eligible = codexPetVisualQaVerdictPasses;
  // Never silently pick a visually rejected candidate.  Continuing with the
  // highest numeric score would produce a run whose canonical identity was
  // explicitly rejected by every reviewer.  The caller treats this as a
  // terminal workflow error (and therefore refunds the package).
  if (verdicts.length === 0 || verdicts.every((verdict) => !eligible(verdict))) {
    const qaArtifact = await putJsonArtifact(ctx, {
      jobId: job.id,
      kind: "qa_report",
      name: "主形象自动选择失败报告",
      value: { selectedArtifactId: null, verdicts, reason: "all_candidates_failed" },
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    });
    await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
      status: "failed",
      attempt: Math.max(1, job.attempt + 1),
      output: { selectedArtifactId: null, qaArtifactId: qaArtifact.id, reason: "all_candidates_failed" } as Prisma.InputJsonValue,
      outputArtifactIds: [qaArtifact.id],
      error: "两个主形象候选均未通过视觉质检",
      completedAt: new Date(),
      workerId: null,
    } });
    throw new Error("两个主形象候选均未通过视觉质检");
  }
  const selectedIndex = verdicts.reduce((best, verdict, index) => {
    if (!eligible(verdict)) return best;
    if (best < 0) return index;
    const bestVerdict = verdicts[best]!;
    return verdict.score > bestVerdict.score ? index : best;
  }, -1);
  if (selectedIndex < 0) throw new Error("两个主形象候选均未通过视觉质检");
  const selectedArtifactId = candidates[selectedIndex]!.artifact.id;
  const qaArtifact = await putJsonArtifact(ctx, { jobId: job.id, kind: "qa_report", name: "主形象自动选择报告", value: { selectedArtifactId, verdicts } });
  await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
    status: "completed",
    attempt: 1,
    output: { selectedArtifactId, qaArtifactId: qaArtifact.id } as Prisma.InputJsonValue,
    outputArtifactIds: [qaArtifact.id],
    providerMetadata: {
      visualQa: {
        requestedModel: ctx.visualQaModel,
        actualModels: [...new Set(baseQaProvenance.flatMap((value) => value.actualModels))],
        routes: [...new Set(baseQaProvenance.flatMap((value) => value.routes))],
      },
    } as Prisma.InputJsonValue,
    completedAt: new Date(),
  } });
  return selectedArtifactId;
}

export async function ensurePersistedBaseSelection(ctx: RunnerContext, selectedArtifactId: string): Promise<void> {
  const job = await ensureJob(ctx, "base-selection", "visual_qa", ["base-candidate-1", "base-candidate-2"]);
  const output = asRecord(job.output);
  if (job.status === "completed") {
    if (output.selectedArtifactId !== selectedArtifactId) throw new Error("Persisted base selection does not match the approved artifact");
    return;
  }
  // Automatic selection already completes this job with a QA report. Manual
  // selection is committed by the route, so the runner records the same
  // durable graph node without inventing another visual review.
  await updateOwnedJob(ctx.prisma, ctx, job.id, {
    status: "completed",
    attempt: Math.max(1, job.attempt),
    inputArtifactIds: [selectedArtifactId],
    output: { selectedArtifactId, selectionMode: "manual" } as Prisma.InputJsonValue,
    error: null,
    workerId: null,
    completedAt: new Date(),
  }, { status: { not: "completed" } });
}

export async function getIdentityGuide(
  ctx: RunnerContext,
  canonical: { readonly artifact: CodexPetArtifact; readonly buffer: Buffer },
): Promise<string> {
  const compact = (value: string, limit: number) => value.replace(/\s+/g, " ").trim().slice(0, limit);
  const characterBrief = [
    `名称：${compact(ctx.identity.name, 60)}`,
    ctx.identity.description ? `描述：${compact(ctx.identity.description, 240)}` : "",
    ctx.identity.prompt ? `角色设定：${compact(ctx.identity.prompt, 640)}` : "",
    `风格：${compact(ctx.identity.stylePreset, 60)}`,
    ctx.identity.styleNotes ? `风格补充：${compact(ctx.identity.styleNotes, 180)}` : "",
  ].filter(Boolean).join("；").slice(0, 1200);
  const supportingReferenceAssetIds = ctx.referenceAssetIds.slice(0, 3);
  const characterBriefHash = createHash("sha256").update(characterBrief).digest("hex");
  const guideBinding = {
    version: IDENTITY_GUIDE_VERSION,
    selectedBaseArtifactId: canonical.artifact.id,
    supportingReferenceAssetIds,
    characterBriefHash,
  };
  let job = await ensureJob(ctx, "identity-guide", "identity_guide", ["base-selection"], {
    ...guideBinding,
  });
  const persistedOutput = asRecord(job.output);
  if (!ctx.qualityInspectionEnabled) {
    const guide = [
      "Use the approved canonical base image as the only identity source.",
      "Preserve silhouette, head-body ratio, face placement, palette, accessories and material.",
      "Keep feet anchored to the slot baseline; do not rotate the whole character or invent extra limbs, heads, text or background.",
    ].join(" ");
    if (job.status === "completed" && persistedOutput.mode === "fixed" && typeof persistedOutput.guide === "string") {
      return persistedOutput.guide;
    }
    job = await startJob(ctx, job, Math.max(1, job.attempt + 1), 16, "已锁定固定身份约束，不调用 AI 质检");
    await ctx.prisma.codexPetJob.update({ where: { id: job.id }, data: {
      status: "completed",
      inputArtifactIds: [canonical.artifact.id],
      outputArtifactIds: [],
      output: { mode: "fixed", guide, selectedArtifactId: canonical.artifact.id } as Prisma.InputJsonValue,
      providerMetadata: { visualQa: { enabled: false, requestedModel: null, actualModels: [], routes: [] } } as Prisma.InputJsonValue,
      error: null,
      workerId: null,
      completedAt: new Date(),
    } });
    return guide;
  }
  const persisted = persistedOutput.guide;
  if (job.status === "completed") {
    const jobInput = asRecord(job.input);
    const persistedReferenceIds = Array.isArray(persistedOutput.supportingReferenceAssetIds)
      ? persistedOutput.supportingReferenceAssetIds.filter((value): value is string => typeof value === "string")
      : [];
    const inputReferenceIds = Array.isArray(jobInput.supportingReferenceAssetIds)
      ? jobInput.supportingReferenceAssetIds.filter((value): value is string => typeof value === "string")
      : [];
    const referencesMatch = (values: readonly string[]) => values.length === supportingReferenceAssetIds.length
      && values.every((value, index) => value === supportingReferenceAssetIds[index]);
    const matchesCanonical = persistedOutput.version === IDENTITY_GUIDE_VERSION
      && persistedOutput.selectedArtifactId === canonical.artifact.id
      && persistedOutput.characterBriefHash === characterBriefHash
      && referencesMatch(persistedReferenceIds)
      && jobInput.version === IDENTITY_GUIDE_VERSION
      && jobInput.selectedBaseArtifactId === canonical.artifact.id
      && jobInput.characterBriefHash === characterBriefHash
      && referencesMatch(inputReferenceIds)
      && job.inputArtifactIds.length === 1
      && job.inputArtifactIds[0] === canonical.artifact.id
      && typeof persisted === "string"
      && Boolean(persisted.trim())
      && persisted.length <= 1600;
    if (matchesCanonical) {
      assertCodexPetVisualQaProvenance(asRecord(job.providerMetadata).visualQa, ctx.visualQaModel, "identity-guide");
      return persisted.trim();
    }

    // A regenerated/changed base must never inherit anatomy inferred from a
    // different candidate. Reset this internal text job and recompute it from
    // the currently approved, ownership-checked artifact.
    await updateOwnedJob(ctx.prisma, ctx, job.id, {
      status: "queued",
      attempt: 0,
      input: guideBinding as Prisma.InputJsonValue,
      inputArtifactIds: [canonical.artifact.id],
      outputArtifactIds: [],
      output: {} as Prisma.InputJsonValue,
      error: null,
      workerId: null,
      startedAt: null,
      completedAt: null,
    }, { status: "completed" });
    const resetJob = await ctx.prisma.codexPetJob.findUnique({ where: { id: job.id } });
    if (!resetJob) throw new Error("Identity guide job disappeared while resetting stale output");
    job = resetJob;
  }

  // A queued/running job may predate the anatomy-reference contract. Bind its
  // durable input before invoking the model so crash recovery cannot reuse a
  // guide inferred from a different brief or supporting-reference order.
  job = await ctx.prisma.codexPetJob.update({
    where: { id: job.id },
    data: {
      input: guideBinding as Prisma.InputJsonValue,
      inputArtifactIds: [canonical.artifact.id],
    },
  });

  // Resume a process-interrupted attempt without consuming an automatic retry.
  const firstAttempt = job.status === "running" && job.attempt > 0
    ? job.attempt
    : Math.max(1, job.attempt + 1);
  let lastError = "";
  for (let attempt = firstAttempt; attempt <= job.maxAttempts; attempt += 1) {
    job = await startJob(ctx, job, attempt, 16, "正在分析批准主形象的角色解剖与身份特征");
    let completedGuide: string | null = null;
    try {
      let guideModelProvenance: CodexPetVisualModelProvenance | undefined;
      const generatedGuide = await ctx.identityGuide({
        reference: canonical.buffer,
        mime: canonical.artifact.mime,
        originalReferences: ctx.userReferences,
        characterBrief,
        env: ctx.env,
        signal: ctx.signal,
        onModelProvenance: (provenance) => { guideModelProvenance = provenance; },
      });
      const guide = generatedGuide.replace(/\s+/g, " ").trim().slice(0, 1600);
      if (!guide) throw new Error("角色解剖与身份指南为空");
      const guideProvenance = assertCodexPetVisualQaProvenance(guideModelProvenance, ctx.visualQaModel, "identity-guide");
      await checkCancelled(ctx);
      await updateOwnedJob(ctx.prisma, ctx, job.id, {
        status: "completed",
        inputArtifactIds: [canonical.artifact.id],
        outputArtifactIds: [],
        output: {
          version: IDENTITY_GUIDE_VERSION,
          selectedArtifactId: canonical.artifact.id,
          supportingReferenceAssetIds,
          characterBriefHash,
          guide,
          modelProvenance: guideProvenance,
        } as unknown as Prisma.InputJsonValue,
        providerMetadata: {
          visualQa: guideProvenance,
        } as unknown as Prisma.InputJsonValue,
        error: null,
        workerId: null,
        completedAt: new Date(),
      }, { status: "running", workerId: ctx.workerId });
      completedGuide = guide;
    } catch (error) {
      if (error instanceof CodexPetLeaseLostError || ctx.signal?.reason instanceof CodexPetLeaseLostError) throw new CodexPetLeaseLostError();
      if (error instanceof CodexPetCancelledError || ctx.signal?.aborted) throw new CodexPetCancelledError();
      lastError = safeError(error);
      await failJobAttempt(ctx, job, attempt, lastError, 16);
      if (error instanceof CodexPetModelContractError) throw error;
      if (attempt >= job.maxAttempts) throw new Error(`角色解剖与身份指南生成失败：${lastError}`);
    }
    if (completedGuide) {
      // The durable job output is authoritative. Event delivery happens after
      // the attempt catch so an event-store failure cannot turn a completed
      // guide back into queued work and invoke the multimodal model twice.
      await emit(ctx, "job.completed", "standard_generating", 16, "角色解剖与身份指南已锁定", {}, job.key).catch(() => undefined);
      return completedGuide;
    }
  }
  throw new Error(`角色解剖与身份指南生成失败：${lastError || "多模态模型未返回结果"}`);
}
