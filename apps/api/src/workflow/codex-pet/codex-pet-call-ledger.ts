import type { PrismaClient } from "@prisma/client";
import { sanitizeCodexPetDiagnosticText } from "./codex-pet-events.js";
import { classifyImageGenerationError } from "../_shared/image-service.js";

export const CODEX_PET_PLANNED_IMAGE_CALL_LIMIT = 14;
export const CODEX_PET_PER_IMAGE_BILLING_MODE = "per_image_call_v1";

function positiveInteger(key: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env[key]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Ceiling on paid repair attempts for one action.
 *
 * Each approval only raised the job's own `maxAttempts` by one, so a row that
 * kept failing validation could be re-approved forever: the `老鼠猫` incident
 * spent 10 extra calls on `row-running-right` alone. Calibrated against both
 * completed v2 runs, where no action ever needed more than 2 *billable* extras
 * (the 6-extra `look-cardinals` case was 6 consecutive socket failures, which
 * this rule does not count). 4 leaves generous headroom over observed need.
 */
export const CODEX_PET_EXTRA_IMAGE_CALLS_PER_JOB_LIMIT = positiveInteger(
  "CODEX_PET_EXTRA_IMAGE_CALLS_PER_JOB_LIMIT",
  4,
);

/**
 * Ceiling on paid repair attempts across the whole run, so a defect that moves
 * from action to action cannot drain a balance one under-cap job at a time.
 * Observed need: 9 billable extras (`老鼠猫`, under the pre-fix pixel rules that
 * were themselves the defect) and 1 (the completed run).
 */
export const CODEX_PET_EXTRA_IMAGE_CALLS_PER_RUN_LIMIT = positiveInteger(
  "CODEX_PET_EXTRA_IMAGE_CALLS_PER_RUN_LIMIT",
  12,
);

/**
 * Statuses that mean the user's points are committed to this call: it is either
 * in flight or it produced a result. `failed` is excluded because a failed call
 * is refunded (extra) or left out of the settled units (planned), so counting it
 * would charge the user's budget for a call they did not pay for. `prepared` and
 * `cancelled` never reached the provider.
 */
const BILLABLE_EXTRA_STATUSES = ["dispatching", "sent", "succeeded"] as const;

/** Whether one ledger row commits the user's points against the repair budget. */
export function codexPetCallConsumesExtraBudget(call: { readonly callKind: string; readonly status: string }): boolean {
  return call.callKind === "extra" && (BILLABLE_EXTRA_STATUSES as readonly string[]).includes(call.status);
}

/**
 * The same budget as `codexPetExtraCallBudget`, computed from ledger rows the
 * caller already holds.
 *
 * The project detail response loads the whole ledger anyway, and the approval
 * panel needs the remaining count *before* the user clicks: hitting a 409 is how
 * users used to discover the cap, which is the worst possible moment.
 */
export function codexPetExtraCallBudgetFromCalls(
  calls: readonly { readonly callKind: string; readonly status: string; readonly jobKey: string }[],
  jobKey: string | null,
): CodexPetExtraCallBudget {
  const billable = calls.filter(codexPetCallConsumesExtraBudget);
  const jobUsed = jobKey ? billable.filter((call) => call.jobKey === jobKey).length : 0;
  const runUsed = billable.length;
  const jobLimit = CODEX_PET_EXTRA_IMAGE_CALLS_PER_JOB_LIMIT;
  const runLimit = CODEX_PET_EXTRA_IMAGE_CALLS_PER_RUN_LIMIT;
  return {
    jobUsed,
    jobLimit,
    runUsed,
    runLimit,
    exhausted: jobKey && jobUsed >= jobLimit ? "job" : runUsed >= runLimit ? "run" : null,
  };
}

export interface CodexPetExtraCallBudget {
  readonly jobUsed: number;
  readonly jobLimit: number;
  readonly runUsed: number;
  readonly runLimit: number;
  readonly exhausted: "job" | "run" | null;
}

/**
 * Paid repair attempts already committed, per action and per run.
 *
 * Counted from the ledger rather than from `job.attempt` because `attempt` also
 * advances on provider transport failures, which are refunded and must not
 * consume the user's repair budget.
 */
export async function codexPetExtraCallBudget(input: {
  readonly prisma: Pick<PrismaClient, "codexPetImageCall">;
  readonly runId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly jobKey: string;
}): Promise<CodexPetExtraCallBudget> {
  const scope = {
    runId: input.runId,
    projectId: input.projectId,
    userId: input.userId,
    callKind: "extra",
    status: { in: [...BILLABLE_EXTRA_STATUSES] as string[] },
  };
  const [jobUsed, runUsed] = await Promise.all([
    input.prisma.codexPetImageCall.count({ where: { ...scope, jobKey: input.jobKey } }),
    input.prisma.codexPetImageCall.count({ where: scope }),
  ]);
  const jobLimit = CODEX_PET_EXTRA_IMAGE_CALLS_PER_JOB_LIMIT;
  const runLimit = CODEX_PET_EXTRA_IMAGE_CALLS_PER_RUN_LIMIT;
  return {
    jobUsed,
    jobLimit,
    runUsed,
    runLimit,
    exhausted: jobUsed >= jobLimit ? "job" : runUsed >= runLimit ? "run" : null,
  };
}

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
  /**
   * Transport-layer attempt inside this one logical attempt, 1-based.
   *
   * A logical attempt is the billing unit: one ledger row, one settled unit, one
   * user approval. Everything above 1 here is the adapter retrying a socket-level
   * failure under that already-paid unit, so it re-dispatches the SAME row rather
   * than reserving a new one, and never increments the run's call count.
   */
  readonly transportAttempt?: number;
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
    // A transport retry re-enters this row on purpose. `succeeded` and `failed`
    // are still refused: those are terminal outcomes of the paid unit, and
    // re-dispatching them would be a second unpaid image or a double refund.
    const transportRetry = (input.transportAttempt ?? 1) > 1
      && Boolean(call)
      && (call!.status === "dispatching" || call!.status === "sent");
    if (call && !transportRetry && ["dispatching", "sent", "succeeded", "failed"].includes(call.status)) {
      throw new CodexPetImageCallAlreadySentError(input.runId, input.jobKey, input.logicalAttempt);
    }
    if (!call && input.logicalAttempt > 1) {
      throw new CodexPetImageCallApprovalRequiredError(input.runId, input.jobKey, input.logicalAttempt);
    }
    // A transport retry consumes no new planned slot — its own row is already
    // inside the counts below, so re-checking the limit would reject the retry
    // of the very last planned call.
    if (callKind === "planned" && !transportRetry) {
      const [sentPlanned, dispatching] = await Promise.all([
        tx.codexPetImageCall.count({
          where: { runId: input.runId, projectId: input.projectId, userId: input.userId, callKind: "planned", sentAt: { not: null } },
        }),
        tx.codexPetImageCall.count({
          where: { runId: input.runId, projectId: input.projectId, userId: input.userId, callKind: "planned", status: "dispatching" },
        }),
      ]);
      if (sentPlanned + dispatching >= run.plannedImageCallLimit) {
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
 * Record a local provider request only after the adapter has invoked fetch, so
 * `sentAt` distinguishes "reached the relay" from "never left this process".
 *
 * `sentAt` is deliberately NOT a billing predicate. A call that ends `failed`
 * is refunded (extras) or excluded from the settled units (planned) regardless
 * of `sentAt` — all four settlement sites filter `status: { not: "failed" }`.
 * That means the platform absorbs the upstream cost of a request that did reach
 * the relay but produced no image, instead of passing it to the user. `sentAt`
 * survives only as diagnostic evidence and as the "was it really dispatched"
 * half of the settled-unit filter (`sentAt: { not: null }`).
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
    // A transport retry of an already-sent unit keeps its original sentAt and
    // does not re-count: `imageGenerationCallCount` and the planned limit both
    // measure billed units, not upstream round trips.
    // `!= null` on purpose: a freshly created row omits the column, so a strict
    // `!== null` reads `undefined` as "already sent" and silently swallows the
    // increment for the *first* send of every call.
    const alreadySent = call.sentAt != null;
    if (callKind === "planned" && !alreadySent) {
      const sentPlanned = await tx.codexPetImageCall.count({
        where: { runId: input.runId, projectId: input.projectId, userId: input.userId, callKind: "planned", sentAt: { not: null } },
      });
      if (sentPlanned >= run.plannedImageCallLimit) {
        throw new CodexPetImageCallLimitError(input.runId, input.jobKey, run.plannedImageCallLimit);
      }
    }
    const sentAt = new Date();
    await tx.codexPetImageCall.update({
      where: { id: call.id },
      data: { status: "sent", error: null, ...(alreadySent ? {} : { sentAt }) },
    });
    const updated = await tx.codexPetRun.updateMany({
      where: { id: input.runId, projectId: input.projectId, userId: input.userId, workerId: input.workerId, cancelRequested: false },
      data: { ...(alreadySent ? {} : { imageGenerationCallCount: { increment: 1 } }), heartbeatAt: sentAt },
    });
    if (updated.count !== 1) throw new Error("Codex pet lease lost while recording provider request");
    return {
      callCount: alreadySent ? run.imageGenerationCallCount : run.imageGenerationCallCount + 1,
      callKind,
      operationId: call.operationId,
    };
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
  const error = input.error ? (() => {
    const classification = classifyImageGenerationError(input.error);
    const detail = sanitizeCodexPetDiagnosticText(
      input.error instanceof Error ? input.error.message : String(input.error),
      400,
    );
    const diagnostic = [classification.category, classification.transportCode]
      .filter((value): value is string => Boolean(value))
      .join("/");
    return sanitizeCodexPetDiagnosticText(
      diagnostic ? `[${diagnostic}] ${detail}` : detail,
      500,
    );
  })() : null;
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

/**
 * Refund an extra call that was charged at approval time but never produced an
 * image.
 *
 * An extra call is charged up-front with an independent `chargeResource`, so a
 * provider failure leaves the user paying for nothing — the `老鼠猫` ledger has a
 * `network/UND_ERR_CONNECT_TIMEOUT` row billed at full price. Planned calls need
 * no refund here: they are covered by the run reservation and drop out of the
 * settled units instead.
 *
 * Idempotent through the billing operation id, and best-effort by design: a
 * refund outage must not fail the run, so the sweeper retries from the ledger.
 */
export async function refundCodexPetFailedExtraCall(input: {
  readonly prisma: Pick<PrismaClient, "codexPetImageCall">;
  readonly billing: { readonly refundResource: (operationId: string) => Promise<{ success: boolean }> };
  readonly runId: string;
  readonly jobKey: string;
  readonly logicalAttempt: number;
  readonly onError?: (error: unknown, operationId: string) => void;
}): Promise<boolean> {
  const call = await input.prisma.codexPetImageCall.findUnique({
    where: {
      runId_jobKey_logicalAttempt: { runId: input.runId, jobKey: input.jobKey, logicalAttempt: input.logicalAttempt },
    },
  });
  if (!call || call.callKind !== "extra" || call.status !== "failed") return false;
  if (call.refundStatus === "refunded") return true;
  try {
    const receipt = await input.billing.refundResource(call.operationId);
    if (!receipt.success) throw new Error("billing refund was not accepted");
  } catch (error) {
    input.onError?.(error, call.operationId);
    await input.prisma.codexPetImageCall.updateMany({
      where: { id: call.id, refundStatus: { not: "refunded" } },
      data: { refundStatus: "pending", refundError: sanitizeCodexPetDiagnosticText(String(error), 400) },
    }).catch(() => undefined);
    return false;
  }
  await input.prisma.codexPetImageCall.updateMany({
    where: { id: call.id, refundStatus: { not: "refunded" } },
    data: { refundStatus: "refunded", refundedAt: new Date(), refundError: null },
  });
  return true;
}

/**
 * Refund every extra call of a run that was charged at approval but never
 * dispatched to the provider.
 *
 * The charge is attached to the *approval* action (`prepareCodexPetExtraImageCall`
 * runs before the job is queued), while `refundCodexPetFailedExtraCall` is
 * attached to the *provider outcome*. A run cancelled between those two points
 * leaves a `prepared` row that neither predicate covers, so its points stay in
 * the system. Cancellation settlement calls this to close that window.
 *
 * Only `prepared` rows qualify: `dispatching`/`sent` reached the relay and are
 * refunded (or not) by their own terminal outcome, and `cancelled` rows were
 * never charged. Best-effort and idempotent, exactly like the failed-call path.
 */
export async function refundCodexPetUndispatchedExtraCalls(input: {
  readonly prisma: Pick<PrismaClient, "codexPetImageCall">;
  readonly billing: { readonly refundResource: (operationId: string) => Promise<{ success: boolean }> };
  readonly runId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly onError?: (error: unknown, operationId: string) => void;
}): Promise<{ readonly refunded: number; readonly pending: number }> {
  const calls = await input.prisma.codexPetImageCall.findMany({
    where: {
      runId: input.runId,
      projectId: input.projectId,
      userId: input.userId,
      callKind: "extra",
      status: "prepared",
      refundStatus: { not: "refunded" },
    },
    select: { id: true, operationId: true },
  });
  let refunded = 0;
  let pending = 0;
  for (const call of calls) {
    try {
      const receipt = await input.billing.refundResource(call.operationId);
      if (!receipt.success) throw new Error("billing refund was not accepted");
    } catch (error) {
      pending += 1;
      input.onError?.(error, call.operationId);
      await input.prisma.codexPetImageCall.updateMany({
        where: { id: call.id, refundStatus: { not: "refunded" } },
        data: { refundStatus: "pending", refundError: sanitizeCodexPetDiagnosticText(String(error), 400) },
      }).catch(() => undefined);
      continue;
    }
    // The row is kept as an audit trail of a charge that was made and returned;
    // `cancelled` would wrongly claim it was never charged.
    await input.prisma.codexPetImageCall.updateMany({
      where: { id: call.id, refundStatus: { not: "refunded" } },
      data: { refundStatus: "refunded", refundedAt: new Date(), refundError: null },
    });
    refunded += 1;
  }
  return { refunded, pending };
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
