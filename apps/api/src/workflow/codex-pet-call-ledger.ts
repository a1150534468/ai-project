import type { PrismaClient } from "@prisma/client";
import { sanitizeCodexPetDiagnosticText } from "./codex-pet-events.js";

export const CODEX_PET_PLANNED_IMAGE_CALL_LIMIT = 14;
export const CODEX_PET_PER_IMAGE_BILLING_MODE = "per_image_call_v1";

export class CodexPetImageCallLimitError extends Error {
  constructor(readonly runId: string, readonly jobKey: string, readonly limit: number) {
    super(`Codex pet image call limit ${limit} reached before provider request`);
    this.name = "CodexPetImageCallLimitError";
  }
}

export class CodexPetImageCallAlreadySentError extends Error {
  constructor(readonly runId: string, readonly jobKey: string, readonly logicalAttempt: number) {
    super(`Codex pet image call already dispatched for ${jobKey} attempt ${logicalAttempt}`);
    this.name = "CodexPetImageCallAlreadySentError";
  }
}

export class CodexPetImageCallApprovalRequiredError extends Error {
  constructor(readonly runId: string, readonly jobKey: string, readonly logicalAttempt: number) {
    super(`Codex pet image call ${jobKey} attempt ${logicalAttempt} requires one-time approval`);
    this.name = "CodexPetImageCallApprovalRequiredError";
  }
}

export function codexPetImageCallOperationId(input: {
  readonly runId: string;
  readonly jobKey: string;
  readonly logicalAttempt: number;
  readonly callKind: "planned" | "extra";
}): string {
  return `codex-pet:run:${input.runId}:image:${input.jobKey}:${input.logicalAttempt}:${input.callKind}`;
}

function purposeForJob(jobKey: string): string {
  if (jobKey.startsWith("base-candidate-")) return "base";
  if (jobKey === "look-cardinals") return "cardinals";
  if (jobKey.startsWith("look-")) return "look";
  if (jobKey.startsWith("row-")) return "row";
  return "manual";
}

type LedgerTx = Pick<PrismaClient, "codexPetRun" | "codexPetImageCall"> & {
  $queryRawUnsafe: PrismaClient["$queryRawUnsafe"];
};

export interface CodexPetImageCallDispatchInput {
  readonly prisma: PrismaClient;
  readonly runId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly workerId: string;
  readonly jobKey: string;
  readonly logicalAttempt: number;
  readonly requestedModel: string;
  /** Frozen from the run's reservation-time pricing snapshot. */
  readonly points: number;
}

/**
 * Durably reserve one provider-dispatch slot before calling fetch. This is
 * deliberately not a sent call: the adapter still has to invoke fetch and
 * transition it to sent afterwards.
 */
export async function prepareCodexPetImageCallDispatch(input: CodexPetImageCallDispatchInput): Promise<{
  readonly callKind: "planned" | "extra";
  readonly operationId: string;
}> {
  if (!Number.isSafeInteger(input.points) || input.points <= 0) {
    throw new Error("Codex pet planned image call requires a positive frozen point price");
  }
  return input.prisma.$transaction(async (tx) => {
    const ledger = tx as unknown as LedgerTx;
    await ledger.$queryRawUnsafe('SELECT "id" FROM "CodexPetRun" WHERE "id" = $1 FOR UPDATE', input.runId);
    const run = await tx.codexPetRun.findFirst({
      where: {
        id: input.runId,
        projectId: input.projectId,
        userId: input.userId,
        workerId: input.workerId,
        cancelRequested: false,
      },
      select: {
        billingMode: true,
        plannedImageCallLimit: true,
        imageGenerationCallCount: true,
        billingResourceKey: true,
      },
    });
    if (!run) throw new Error("Codex pet lease lost before provider request");
    if (run.billingMode !== CODEX_PET_PER_IMAGE_BILLING_MODE) {
      throw new Error("Codex pet call ledger is only valid for per-image runs");
    }

    let call = await tx.codexPetImageCall.findUnique({
      where: { runId_jobKey_logicalAttempt: { runId: input.runId, jobKey: input.jobKey, logicalAttempt: input.logicalAttempt } },
    });
    const callKind = call?.callKind === "extra" ? "extra" as const : "planned" as const;
    if (call && ["dispatching", "sent", "succeeded", "failed"].includes(call.status)) {
      throw new CodexPetImageCallAlreadySentError(input.runId, input.jobKey, input.logicalAttempt);
    }
    if (!call && input.logicalAttempt > 1) {
      throw new CodexPetImageCallApprovalRequiredError(input.runId, input.jobKey, input.logicalAttempt);
    }
    if (callKind === "planned") {
      const dispatching = await tx.codexPetImageCall.count({
        where: { runId: input.runId, projectId: input.projectId, userId: input.userId, callKind: "planned", status: "dispatching" },
      });
      if (run.imageGenerationCallCount + dispatching >= run.plannedImageCallLimit) {
        throw new CodexPetImageCallLimitError(input.runId, input.jobKey, run.plannedImageCallLimit);
      }
    }
    const operationId = call?.operationId ?? codexPetImageCallOperationId({
      runId: input.runId,
      jobKey: input.jobKey,
      logicalAttempt: input.logicalAttempt,
      callKind,
    });
    if (call) {
      call = await tx.codexPetImageCall.update({
        where: { id: call.id },
        data: { status: "dispatching", error: null, completedAt: null },
      });
    } else {
      call = await tx.codexPetImageCall.create({
        data: {
          projectId: input.projectId,
          runId: input.runId,
          userId: input.userId,
          jobKey: input.jobKey,
          logicalAttempt: input.logicalAttempt,
          callKind,
          purpose: purposeForJob(input.jobKey),
          requestedModel: input.requestedModel,
          operationId,
          status: "dispatching",
          resourceKey: run.billingResourceKey,
          units: 1,
          points: input.points,
        },
      });
    }
    return {
      callKind: call.callKind === "extra" ? "extra" : "planned",
      operationId: call.operationId,
    };
  });
}

/**
 * Record a local provider request only after the adapter has invoked fetch.
 * A socket error after this point remains billable because the request may
 * already have reached the relay; failures before fetch leave sentAt null.
 */
export async function markCodexPetImageCallSent(input: CodexPetImageCallDispatchInput): Promise<{
  readonly callCount: number;
  readonly callKind: "planned" | "extra";
  readonly operationId: string;
}> {
  return input.prisma.$transaction(async (tx) => {
    const ledger = tx as unknown as LedgerTx;
    await ledger.$queryRawUnsafe('SELECT "id" FROM "CodexPetRun" WHERE "id" = $1 FOR UPDATE', input.runId);
    const run = await tx.codexPetRun.findFirst({
      where: {
        id: input.runId,
        projectId: input.projectId,
        userId: input.userId,
        workerId: input.workerId,
        cancelRequested: false,
      },
      select: { plannedImageCallLimit: true, imageGenerationCallCount: true },
    });
    if (!run) throw new Error("Codex pet lease lost while recording provider request");
    const call = await tx.codexPetImageCall.findUnique({
      where: { runId_jobKey_logicalAttempt: { runId: input.runId, jobKey: input.jobKey, logicalAttempt: input.logicalAttempt } },
    });
    if (!call || call.status !== "dispatching") {
      throw new CodexPetImageCallAlreadySentError(input.runId, input.jobKey, input.logicalAttempt);
    }
    const callKind = call.callKind === "extra" ? "extra" as const : "planned" as const;
    if (callKind === "planned" && run.imageGenerationCallCount >= run.plannedImageCallLimit) {
      throw new CodexPetImageCallLimitError(input.runId, input.jobKey, run.plannedImageCallLimit);
    }
    const sentAt = new Date();
    await tx.codexPetImageCall.update({
      where: { id: call.id },
      data: { status: "sent", sentAt, error: null },
    });
    const updated = await tx.codexPetRun.updateMany({
      where: { id: input.runId, projectId: input.projectId, userId: input.userId, workerId: input.workerId, cancelRequested: false },
      data: { imageGenerationCallCount: { increment: 1 }, heartbeatAt: sentAt },
    });
    if (updated.count !== 1) throw new Error("Codex pet lease lost while recording provider request");
    return { callCount: run.imageGenerationCallCount + 1, callKind, operationId: call.operationId };
  });
}

export async function completeCodexPetImageCall(input: {
  readonly prisma: PrismaClient;
  readonly runId: string;
  readonly jobKey: string;
  readonly logicalAttempt: number;
  readonly actualModel?: string | null;
  readonly upstreamRequestId?: string | null;
  readonly error?: unknown;
}): Promise<void> {
  const error = input.error ? sanitizeCodexPetDiagnosticText(
    input.error instanceof Error ? input.error.message : String(input.error),
    500,
  ) : null;
  await input.prisma.codexPetImageCall.updateMany({
    where: {
      runId: input.runId,
      jobKey: input.jobKey,
      logicalAttempt: input.logicalAttempt,
      status: { in: ["sent", "dispatching"] },
    },
    data: {
      status: error ? "failed" : "succeeded",
      actualModel: input.actualModel?.trim() || undefined,
      upstreamRequestId: input.upstreamRequestId?.trim() || undefined,
      completedAt: new Date(),
      error,
    },
  });
}

export async function prepareCodexPetExtraImageCall(input: {
  readonly prisma: PrismaClient;
  readonly runId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly jobKey: string;
  readonly logicalAttempt: number;
  readonly requestedModel: string;
  readonly resourceKey: string;
  readonly points: number;
}): Promise<{ readonly operationId: string; readonly created: boolean }> {
  return input.prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT "id" FROM "CodexPetRun" WHERE "id" = $1 FOR UPDATE', input.runId);
    const existing = await tx.codexPetImageCall.findUnique({
      where: { runId_jobKey_logicalAttempt: { runId: input.runId, jobKey: input.jobKey, logicalAttempt: input.logicalAttempt } },
    });
    if (existing) {
      if (existing.status === "cancelled") {
        await tx.codexPetImageCall.update({
          where: { id: existing.id },
          data: { status: "prepared", error: null, completedAt: null },
        });
        return { operationId: existing.operationId, created: true };
      }
      return { operationId: existing.operationId, created: false };
    }
    const earlierExtra = await tx.codexPetImageCall.findFirst({
      where: { runId: input.runId, jobKey: input.jobKey, callKind: "extra" },
      select: { id: true },
    });
    if (earlierExtra) throw new Error("Codex pet extra call was already used for this job");
    const operationId = codexPetImageCallOperationId({
      runId: input.runId,
      jobKey: input.jobKey,
      logicalAttempt: input.logicalAttempt,
      callKind: "extra",
    });
    await tx.codexPetImageCall.create({
      data: {
        projectId: input.projectId,
        runId: input.runId,
        userId: input.userId,
        jobKey: input.jobKey,
        logicalAttempt: input.logicalAttempt,
        callKind: "extra",
        purpose: "repair",
        requestedModel: input.requestedModel,
        operationId,
        status: "prepared",
        resourceKey: input.resourceKey,
        units: 1,
        points: input.points,
      },
    });
    return { operationId, created: true };
  });
}
