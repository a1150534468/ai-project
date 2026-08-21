// 由 codex-pet-runner.ts 纯移动而来（P3.1 阶段 1，纯工具与配置读取）。

import { Buffer } from "node:buffer";
import { PET_ROW_SPECS } from "@ai-assistant/codex-pet-pipeline";
import { type CodexPetRun } from "@prisma/client";
import { sanitizeCodexPetDiagnosticText } from "../codex-pet-events.js";
import { type CodexPetActionPrompts } from "../codex-pet-prompts.js";
import {
  CODEX_PET_RECOVERY_SCHEMA_VERSION,
  CodexPetCancelledError,
  DEFAULT_STALE_RUN_MS,
  type RunnerContext,
  type StandardActionState,
} from "../codex-pet-runner/runner-types.js";
import {
  type PetVisualQaConsensus,
  codexPetImageMaxAttempts,
  codexPetVisualQaConsensusPasses,
} from "../codex-pet-visual.js";
import { type ImageBinaryInput, type ImageGenerationResult, classifyImageGenerationError } from "../image-service.js";

export function codexPetShouldMirrorRunningLeft(
  mirrorSafe: boolean,
  actionPrompts: CodexPetActionPrompts | undefined,
): boolean {
  return mirrorSafe
    && !actionPrompts?.["running-right"]
    && !actionPrompts?.["running-left"];
}

export function customizedStandardActionStates(
  actionPrompts: CodexPetActionPrompts | undefined,
): readonly StandardActionState[] {
  return PET_ROW_SPECS.slice(0, 9).flatMap((spec) => {
    const state = spec.state as StandardActionState;
    return actionPrompts?.[state]?.trim() ? [state] : [];
  });
}

export function standardActionSpecificationSummary(actionPrompts: CodexPetActionPrompts | undefined): string {
  return customizedStandardActionStates(actionPrompts)
    .map((state) => `${state}: ${actionPrompts?.[state]?.trim()}`)
    .join("; ");
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function safeError(error: unknown): string {
  const classification = classifyImageGenerationError(error);
  if (classification.category === "moderation") {
    return "参考图或角色描述未通过内容安全审核，请修改提示词或更换参考图后复制为新项目重试";
  }
  if (classification.category === "invalid_request") {
    return "图片服务无法接受当前参数或参考图，请检查图片格式与角色描述后复制为新项目重试";
  }
  if (classification.category === "authentication") {
    return "图片生成服务配置异常，本次制作已停止并将按系统失败退款";
  }
  if (["rate_limit", "timeout", "upstream", "network"].includes(classification.category)) {
    return "图片生成服务暂时不可用；本次请求未重试，运行已停止并将按系统失败退款";
  }
  return sanitizeCodexPetDiagnosticText(
    error instanceof Error && error.message ? error.message : "桌宠制作失败",
    1_000,
  );
}

export function frozenPerImageCallPoints(snapshot: Record<string, unknown>, run: CodexPetRun): number {
  const snapshotted = snapshot.perImageCallPoints;
  if (typeof snapshotted === "number" && Number.isSafeInteger(snapshotted) && snapshotted > 0) {
    return snapshotted;
  }

  // Rollout-era runs can resume only when their durable reservation proves an
  // integral unit price. Never read mutable billing configuration here.
  if (run.billingReservedUnits > 0
    && run.billingReservedPoints > 0
    && run.billingReservedPoints % run.billingReservedUnits === 0) {
    return run.billingReservedPoints / run.billingReservedUnits;
  }
  throw new Error("Codex pet per-image run is missing a frozen per-call price");
}

/**
 * How many times one *already-paid* image call may be re-sent to the provider.
 *
 * This is the transport axis and it is deliberately independent of the board /
 * quality axis (`maxBoardAttempts`, `job.maxAttempts`), which is pinned to 1
 * under per-image billing because every redraw is a separately charged unit that
 * needs its own user approval. Conflating the two meant a single socket blip
 * parked the run and demanded a paid approval for work the user never chose to
 * redo — the failure shape where `look-cardinals` burned 6 extra calls on 6
 * consecutive socket errors. A transport retry re-enters the same ledger row, so
 * it costs the user nothing.
 *
 * `CODEX_PET_IMAGE_MAX_ATTEMPTS=1` still forces one-shot for acceptance runs.
 */
export function configuredTransportAttempts(env: NodeJS.ProcessEnv): number {
  return codexPetImageMaxAttempts(env);
}

// Both call sites of this value dispatch real billed image calls (the two base
// candidates, and the repair fan-out over standard rows). Concurrency > 1 makes
// them compete for the same upstream relay quota, which self-inflicts the 429
// that killed an earlier run. Serial by default; raise it only deliberately.
export function configuredVisualConcurrency(env: NodeJS.ProcessEnv): number {
  const value = Number(env.CODEX_PET_VISUAL_CONCURRENCY);
  return Number.isInteger(value) && value > 0 ? Math.min(3, value) : 1;
}

export function configuredArchiveMaxAttempts(env: NodeJS.ProcessEnv): number {
  const value = Number(env.CODEX_PET_ARCHIVE_MAX_ATTEMPTS);
  return Number.isInteger(value) && value > 0 ? Math.min(100, value) : 10;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  parentSignal?: AbortSignal,
): Promise<R[]> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) controller.abort(parentSignal.reason);
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const results = new Array<R>(items.length);
  let cursor = 0;
  const failures: unknown[] = [];
  const runners = Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, async () => {
    for (;;) {
      if (controller.signal.aborted) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index]!, index, controller.signal);
      } catch (error) {
        if (failures.length === 0) {
          failures.push(error);
          if (!controller.signal.aborted) controller.abort(error);
        }
        return;
      }
    }
  });
  try {
    // A terminal run/refund must not race a sibling that is still unwinding
    // an upstream image request, QA call or artifact write. Abort on the first
    // branch failure, then drain every branch before rethrowing that failure.
    await Promise.allSettled(runners);
  } finally {
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
  if (failures.length > 0) throw failures[0];
  if (controller.signal.aborted) {
    const reason = controller.signal.reason;
    if (reason instanceof Error) throw reason;
    throw new CodexPetCancelledError();
  }
  return results;
}

export function providerMetadata(result: ImageGenerationResult): Record<string, unknown> {
  return {
    upstreamRequestId: result.upstreamRequestId,
    requestedModel: result.requestedModel,
    actualModel: result.actualModel,
    requestedSize: result.requestedSize,
    actualSize: result.actualSize,
    requestedQuality: result.requestedQuality,
    actualQuality: result.actualQuality,
    usage: result.usage,
  };
}

export function isCodexPetRecoverySnapshot(value: unknown): boolean {
  const snapshot = asRecord(value);
  const recovery = asRecord(snapshot.recovery);
  return recovery.schemaVersion === CODEX_PET_RECOVERY_SCHEMA_VERSION
    && typeof recovery.sourceRunId === "string"
    && recovery.sourceRunId.length > 0
    && typeof recovery.fingerprint === "string"
    && recovery.fingerprint.length > 0;
}

export function imageFailureMetadata(error: unknown): Record<string, unknown> {
  const classification = classifyImageGenerationError(error);
  return {
    category: classification.category,
    ...(classification.transportCode
      ? { transportCode: classification.transportCode }
      : {}),
    ...(classification.upstreamRequestId
      ? { upstreamRequestId: classification.upstreamRequestId }
      : {}),
  };
}

export function visualQaPasses(ctx: RunnerContext, consensus: PetVisualQaConsensus): boolean {
  return !ctx.qualityInspectionEnabled || codexPetVisualQaConsensusPasses(consensus);
}

export function staleRunMs(env: NodeJS.ProcessEnv): number {
  const value = Number(env.CODEX_PET_STALE_RUN_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_STALE_RUN_MS;
}

export function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function imageInput(buffer: Buffer, mime = "image/png", filename = "reference.png"): ImageBinaryInput {
  return { b64: buffer.toString("base64"), mime, filename };
}
