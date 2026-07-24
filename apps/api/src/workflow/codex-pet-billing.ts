import { InsufficientBalanceError } from "@ai-assistant/billing";
import type { PrismaClient } from "@prisma/client";
import { CODEX_PET_PER_IMAGE_BILLING_MODE } from "./codex-pet-call-ledger.js";
import { sanitizeCodexPetDiagnosticText } from "./codex-pet-events.js";

export const CODEX_PET_BILLING_RESOURCE_KEY = "codex_pet_v2_package";
// Run.status intentionally stays inside the public workflow state contract.
// Workers must require billingChargeStatus=charged + billingActivatedAt!=null
// before accepting a queued run.
export const CODEX_PET_BILLING_PENDING_RUN_STATUS = "queued";

export const CODEX_PET_CHARGE_STATUSES = [
  "pending",
  "charging",
  "charged",
  "insufficient",
  "uncertain",
  "cancelled",
] as const;

export type CodexPetChargeStatus = (typeof CODEX_PET_CHARGE_STATUSES)[number];

export interface CodexPetChargeClient {
  readonly chargeResource: (args: {
    readonly operationId: string;
    readonly userId: string;
    readonly resourceKey: string;
    readonly units: number;
  }) => Promise<{ readonly charged: number }>;
}

export type CodexPetBillingOutcome =
  | "activated"
  | "refund_pending"
  | "charging"
  | "retry_scheduled"
  | "insufficient"
  | "uncertain"
  | "cancelled";

export interface CodexPetBillingReconcileResult {
  readonly runId: string;
  readonly chargeStatus: CodexPetChargeStatus;
  readonly outcome: CodexPetBillingOutcome;
  /** Queue.add must use jobId=runId, making repeated true results harmless. */
  readonly shouldEnqueue: boolean;
  readonly refundPending: boolean;
  readonly attemptCount: number;
  readonly chargedPoints: number;
  readonly retryAt: Date | null;
  readonly error: string | null;
}

export interface CodexPetBillingClockOptions {
  readonly now?: () => Date;
  readonly chargeLeaseMs?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
}

export interface CodexPetBillingRunScope {
  readonly runId: string;
  readonly userId: string;
  readonly projectId: string;
}

export interface ReconcileCodexPetBillingArgs extends CodexPetBillingClockOptions, CodexPetBillingRunScope {
  readonly prisma: PrismaClient;
  readonly billing: CodexPetChargeClient;
  /** Maintenance leaves an insufficient run parked; an explicit API retry may opt in after a top-up. */
  readonly retryInsufficient?: boolean;
  readonly resourceKey?: string;
}

export interface ActivateCodexPetBillingArgs extends CodexPetBillingRunScope {
  readonly prisma: PrismaClient;
  readonly chargedPoints: number;
  readonly now?: () => Date;
  readonly resourceKey?: string;
}

export class CodexPetBillingRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Codex pet billing run not found: ${runId}`);
    this.name = "CodexPetBillingRunNotFoundError";
  }
}

export class CodexPetBillingOperationMissingError extends Error {
  constructor(runId: string) {
    super(`Codex pet billing operation is missing: ${runId}`);
    this.name = "CodexPetBillingOperationMissingError";
  }
}

/**
 * Fields the start endpoint writes while creating the run in its own short DB
 * transaction. No external call belongs in that transaction. Only after this
 * record commits should reconcileCodexPetRunBilling be called.
 */
export function codexPetPendingBillingFields(operationId: string) {
  const normalized = operationId.trim();
  if (!normalized) throw new Error("Codex pet billing operationId is required");
  return {
    status: CODEX_PET_BILLING_PENDING_RUN_STATUS,
    progressStage: "queued",
    progressPercent: 0,
    progressMessage: "正在确认桌宠套餐扣费",
    billingOperationId: normalized,
    billingPoints: 0,
    billingChargeStatus: "pending" as const,
    billingChargeAttemptCount: 0,
    billingChargeError: null,
    billingChargeLastAttemptAt: null,
    billingChargeNextRetryAt: null,
    billingChargeLeaseUntil: null,
    billingChargedAt: null,
    billingActivatedAt: null,
    startedAt: null,
  };
}

function asChargeStatus(value: string): CodexPetChargeStatus {
  return (CODEX_PET_CHARGE_STATUSES as readonly string[]).includes(value)
    ? value as CodexPetChargeStatus
    : "uncertain";
}

function safeBillingError(error: unknown): string {
  return sanitizeCodexPetDiagnosticText(
    error instanceof Error ? error.message : String(error),
    500,
  );
}

function isInsufficientBalance(error: unknown): boolean {
  return error instanceof InsufficientBalanceError
    || (error instanceof Error && error.name === "InsufficientBalanceError");
}

function retryDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.min(Math.max(0, attempt - 1), 10));
}

function resultFromRun(
  run: {
    readonly id: string;
    readonly status: string;
    readonly billingChargeStatus: string;
    readonly billingChargeAttemptCount: number;
    readonly billingChargeNextRetryAt: Date | null;
    readonly billingChargeError: string | null;
    readonly billingPoints: number;
    readonly billingActivatedAt: Date | null;
    readonly billingRefundedAt: Date | null;
    readonly billingRefundStatus: string;
  },
  outcome?: CodexPetBillingOutcome,
): CodexPetBillingReconcileResult {
  const refundPending = !run.billingRefundedAt && run.billingRefundStatus !== "none";
  const inferred: CodexPetBillingOutcome = outcome
    ?? (refundPending
      ? "refund_pending"
      : run.billingActivatedAt
        ? "activated"
        : asChargeStatus(run.billingChargeStatus) === "insufficient"
          ? "insufficient"
          : asChargeStatus(run.billingChargeStatus) === "charging"
            ? "charging"
            : asChargeStatus(run.billingChargeStatus) === "cancelled"
              ? "cancelled"
              : "retry_scheduled");
  return {
    runId: run.id,
    chargeStatus: asChargeStatus(run.billingChargeStatus),
    outcome: inferred,
    shouldEnqueue: inferred === "activated" && run.status === "queued",
    refundPending,
    attemptCount: run.billingChargeAttemptCount,
    chargedPoints: run.billingPoints,
    retryAt: run.billingChargeNextRetryAt,
    error: run.billingChargeError,
  };
}

function isActivationBlocked(run: {
  readonly status: string;
  readonly cancelRequested: boolean;
  readonly billingRefundStatus: string;
}, projectStatus: string): boolean {
  return projectStatus === "deleting"
    || run.cancelRequested
    || run.status === "cancelled"
    || run.status === "failed"
    || run.billingRefundStatus !== "none";
}

/**
 * Records a confirmed external charge and activates the run atomically.
 * Row locks serialize cancellation/deletion with the final decision, while
 * billingActivatedAt and the unique (runId, sequence) event key make retries
 * harmless. The external charge itself is intentionally never made here.
 */
export async function activateChargedCodexPetRun(
  args: ActivateCodexPetBillingArgs,
): Promise<CodexPetBillingReconcileResult> {
  const at = (args.now ?? (() => new Date()))();
  const resourceKey = args.resourceKey ?? CODEX_PET_BILLING_RESOURCE_KEY;
  if (!Number.isSafeInteger(args.chargedPoints) || args.chargedPoints < 0) {
    throw new Error("Codex pet billing returned an invalid charged amount");
  }

  return args.prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "CodexPetRun" WHERE "id" = $1 AND "userId" = $2 AND "projectId" = $3 FOR UPDATE',
      args.runId,
      args.userId,
      args.projectId,
    );
    const run = await tx.codexPetRun.findUnique({
      where: { id: args.runId, userId: args.userId, projectId: args.projectId },
    });
    if (!run) throw new CodexPetBillingRunNotFoundError(args.runId);
    if (!run.billingOperationId) throw new CodexPetBillingOperationMissingError(args.runId);

    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "CodexPetProject" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE',
      args.projectId,
      args.userId,
    );
    const project = await tx.codexPetProject.findUnique({
      where: { id: args.projectId, userId: args.userId },
    });
    if (!project) throw new CodexPetBillingRunNotFoundError(args.runId);
    // The denormalized userId columns are intentionally indexed for scoped
    // queries, but they are not part of a composite foreign key.  Refuse to
    // activate/refund a corrupt or cross-linked run rather than mutating a
    // project/event under the wrong user's ownership boundary.
    if (project.userId !== run.userId) {
      throw new Error("Codex pet billing ownership mismatch");
    }

    if (isActivationBlocked(run, project.status)) {
      // A refund recorded before an in-flight/uncertain charge settled may
      // have been a harmless no-op. Once that late charge is confirmed it
      // needs a fresh durable refund intent. A receipt is reusable only when
      // this run had already persisted the charge before it was refunded.
      const confirmedChargeWasAlreadyRefunded = run.billingChargeStatus === "charged"
        && Boolean(run.billingChargedAt)
        && Boolean(run.billingRefundedAt)
        && run.billingRefundedAt!.getTime() >= run.billingChargedAt!.getTime();
      const shouldCancel = project.status === "deleting"
        || run.cancelRequested
        || run.status === "queued";
      const updated = await tx.codexPetRun.update({
        where: { id: run.id, userId: args.userId, projectId: args.projectId },
        data: {
          billingChargeStatus: "charged",
          billingPoints: args.chargedPoints,
          billingChargedAt: run.billingChargedAt ?? at,
          billingChargeError: null,
          billingChargeLeaseUntil: null,
          billingChargeNextRetryAt: null,
          billingRefundedAt: confirmedChargeWasAlreadyRefunded ? run.billingRefundedAt : null,
          billingRefundStatus: confirmedChargeWasAlreadyRefunded ? "refunded" : "pending",
          billingRefundError: confirmedChargeWasAlreadyRefunded ? run.billingRefundError : null,
          billingRefundNextRetryAt: confirmedChargeWasAlreadyRefunded ? null : at,
          ...(shouldCancel ? {
            status: "cancelled",
            progressStage: "cancelled",
            progressMessage: project.status === "deleting" ? "项目删除中，套餐扣费将自动退回" : "运行已取消，套餐扣费将自动退回",
            cancelRequested: true,
            completedAt: run.completedAt ?? at,
          } : {}),
        },
      });
      return resultFromRun(updated, confirmedChargeWasAlreadyRefunded ? "cancelled" : "refund_pending");
    }

    // A committed prior activation is authoritative. Returning shouldEnqueue
    // for a still-queued run lets API and maintenance repair an enqueue crash.
    if (run.billingActivatedAt) {
      const updated = run.billingChargeStatus === "charged" && run.billingPoints === args.chargedPoints
        ? run
        : await tx.codexPetRun.update({
          where: { id: run.id, userId: args.userId, projectId: args.projectId },
          data: {
            billingChargeStatus: "charged",
            billingPoints: args.chargedPoints,
            billingChargedAt: run.billingChargedAt ?? at,
            billingChargeError: null,
            billingChargeLeaseUntil: null,
            billingChargeNextRetryAt: null,
          },
        });
      return resultFromRun(updated, "activated");
    }

    // Compatibility for a run activated before these saga columns existed.
    const existingQueuedEvent = await tx.codexPetEvent.findFirst({
      where: {
        runId: run.id,
        projectId: args.projectId,
        userId: args.userId,
        type: "run.queued",
      },
      select: { id: true },
    });
    if (existingQueuedEvent) {
      const updated = await tx.codexPetRun.update({
        where: { id: run.id, userId: args.userId, projectId: args.projectId },
        data: {
          billingChargeStatus: "charged",
          billingPoints: args.chargedPoints,
          billingChargedAt: run.billingChargedAt ?? run.startedAt ?? run.createdAt,
          billingActivatedAt: run.startedAt ?? run.createdAt,
          billingChargeError: null,
          billingChargeLeaseUntil: null,
          billingChargeNextRetryAt: null,
        },
      });
      await tx.codexPetProject.updateMany({
        where: { id: project.id, userId: args.userId, status: { not: "deleting" } },
        data: { latestRunId: run.id, status: run.status },
      });
      return resultFromRun(updated, "activated");
    }

    const updated = await tx.codexPetRun.update({
      where: { id: run.id, userId: args.userId, projectId: args.projectId },
      data: {
        status: "queued",
        progressStage: "queued",
        progressPercent: 0,
        progressMessage: "桌宠制作任务已进入队列",
        billingChargeStatus: "charged",
        billingPoints: args.chargedPoints,
        billingChargedAt: run.billingChargedAt ?? at,
        billingActivatedAt: at,
        billingChargeError: null,
        billingChargeLeaseUntil: null,
        billingChargeNextRetryAt: null,
        startedAt: run.startedAt ?? at,
        lastEventSequence: { increment: 1 },
      },
    });
    await tx.codexPetProject.update({
      where: { id: project.id, userId: args.userId },
      data: { latestRunId: run.id, status: "queued" },
    });
    await tx.codexPetEvent.create({
      data: {
        projectId: run.projectId,
        runId: run.id,
        userId: run.userId,
        sequence: updated.lastEventSequence,
        type: "run.queued",
        stage: "queued",
        message: "桌宠制作任务已进入队列",
        progress: 0,
        payload: { resourceKey },
      },
    });
    return resultFromRun(updated, "activated");
  });
}

async function markDefinitelyUnchargedCancellation(
  prisma: PrismaClient,
  scope: CodexPetBillingRunScope,
  chargeStatus: "pending" | "insufficient",
  at: Date,
) {
  await prisma.codexPetRun.updateMany({
    where: {
      id: scope.runId,
      userId: scope.userId,
      projectId: scope.projectId,
      billingChargeStatus: chargeStatus,
    },
    data: {
      billingChargeStatus: "cancelled",
      billingChargeError: null,
      billingChargeLeaseUntil: null,
      billingChargeNextRetryAt: null,
      status: "cancelled",
      progressStage: "cancelled",
      progressMessage: "桌宠套餐未扣费，运行已取消",
      cancelRequested: true,
      completedAt: at,
      billingRefundedAt: null,
      billingRefundStatus: "none",
      billingRefundError: null,
      billingRefundNextRetryAt: null,
    },
  });
  return prisma.codexPetRun.findUnique({
    where: { id: scope.runId, userId: scope.userId, projectId: scope.projectId },
  });
}

async function markUncertain(args: {
  readonly prisma: PrismaClient;
  readonly runId: string;
  readonly userId: string;
  readonly projectId: string;
  readonly attempt: number;
  readonly at: Date;
  readonly error: unknown;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
}) {
  const retryAt = new Date(args.at.getTime() + retryDelayMs(args.attempt, args.retryBaseMs, args.retryMaxMs));
  await args.prisma.codexPetRun.updateMany({
    where: {
      id: args.runId,
      userId: args.userId,
      projectId: args.projectId,
      billingChargeStatus: "charging",
      billingChargeAttemptCount: args.attempt,
    },
    data: {
      billingChargeStatus: "uncertain",
      billingChargeError: safeBillingError(args.error),
      billingChargeLeaseUntil: null,
      billingChargeNextRetryAt: retryAt,
    },
  }).catch(() => undefined);
  return retryAt;
}

/**
 * Reconciles one durable charge intent. chargeResource is always outside a DB
 * transaction and always receives the persisted operationId. A crashed or
 * timed-out attempt is therefore safely repeated after its lease/backoff.
 */
export async function reconcileCodexPetRunBilling(
  args: ReconcileCodexPetBillingArgs,
): Promise<CodexPetBillingReconcileResult> {
  const now = args.now ?? (() => new Date());
  const at = now();
  const leaseMs = Math.max(1_000, args.chargeLeaseMs ?? 60_000);
  const retryBaseMs = Math.max(1_000, args.retryBaseMs ?? 30_000);
  const retryMaxMs = Math.max(retryBaseMs, args.retryMaxMs ?? 30 * 60_000);
  const resourceKey = args.resourceKey ?? CODEX_PET_BILLING_RESOURCE_KEY;

  let run = await args.prisma.codexPetRun.findUnique({
    where: { id: args.runId, userId: args.userId, projectId: args.projectId },
    include: { project: { select: { status: true, userId: true } } },
  });
  if (!run) throw new CodexPetBillingRunNotFoundError(args.runId);
  if (!run.billingOperationId) throw new CodexPetBillingOperationMissingError(args.runId);
  if (run.project.userId !== run.userId) throw new Error("Codex pet billing ownership mismatch");

  if (run.billingChargeStatus === "charged") {
    return activateChargedCodexPetRun({
      prisma: args.prisma,
      runId: run.id,
      userId: args.userId,
      projectId: args.projectId,
      chargedPoints: run.billingPoints,
      now,
      resourceKey,
    });
  }
  if (run.billingChargeStatus === "cancelled") return resultFromRun(run, "cancelled");

  const definitelyUncharged = run.billingChargeStatus === "pending" || run.billingChargeStatus === "insufficient";
  const retryingInsufficient = run.billingChargeStatus === "insufficient"
    && Boolean(args.retryInsufficient)
    && !run.cancelRequested
    && run.project.status !== "deleting";
  const blocked = run.project.status === "deleting"
    || run.cancelRequested
    || (run.status === "cancelled" && !retryingInsufficient);
  if (blocked && definitelyUncharged) {
    const cancelled = await markDefinitelyUnchargedCancellation(
      args.prisma,
      { runId: run.id, userId: args.userId, projectId: args.projectId },
      run.billingChargeStatus as "pending" | "insufficient",
      at,
    );
    if (!cancelled) throw new CodexPetBillingRunNotFoundError(run.id);
    return resultFromRun(cancelled, "cancelled");
  }

  if (run.billingChargeStatus === "insufficient" && !args.retryInsufficient) {
    return resultFromRun(run, "insufficient");
  }
  if (run.billingChargeStatus === "charging"
    && run.billingChargeLeaseUntil
    && run.billingChargeLeaseUntil > at) {
    return resultFromRun(run, "charging");
  }
  if ((run.billingChargeStatus === "pending" || run.billingChargeStatus === "uncertain")
    && run.billingChargeNextRetryAt
    && run.billingChargeNextRetryAt > at) {
    return resultFromRun(run, "retry_scheduled");
  }

  const currentStatus = asChargeStatus(run.billingChargeStatus);
  const claimable = currentStatus === "pending"
    || currentStatus === "uncertain"
    || currentStatus === "insufficient"
    || currentStatus === "charging";
  if (!claimable) return resultFromRun(run, "uncertain");

  const claimed = await args.prisma.codexPetRun.updateMany({
    where: {
      id: run.id,
      userId: args.userId,
      projectId: args.projectId,
      billingChargeStatus: run.billingChargeStatus,
      billingChargeAttemptCount: run.billingChargeAttemptCount,
      ...(run.billingChargeStatus === "charging"
        ? { OR: [{ billingChargeLeaseUntil: null }, { billingChargeLeaseUntil: { lte: at } }] }
        : {}),
    },
    data: {
      billingChargeStatus: "charging",
      billingChargeAttemptCount: { increment: 1 },
      billingChargeLastAttemptAt: at,
      billingChargeLeaseUntil: new Date(at.getTime() + leaseMs),
      billingChargeNextRetryAt: null,
      billingChargeError: null,
      ...(run.billingChargeStatus === "insufficient" ? {
        status: "queued",
        progressStage: "queued",
        progressMessage: "正在重新确认桌宠套餐扣费",
        completedAt: null,
      } : {}),
    },
  });
  if (claimed.count === 0) {
    const current = await args.prisma.codexPetRun.findUnique({
      where: { id: run.id, userId: args.userId, projectId: args.projectId },
    });
    if (!current) throw new CodexPetBillingRunNotFoundError(run.id);
    return resultFromRun(current);
  }

  run = await args.prisma.codexPetRun.findUnique({
    where: { id: run.id, userId: args.userId, projectId: args.projectId },
    include: { project: { select: { status: true, userId: true } } },
  });
  if (!run) throw new CodexPetBillingRunNotFoundError(args.runId);
  if (!run.billingOperationId) throw new CodexPetBillingOperationMissingError(run.id);
  if (run.project.userId !== run.userId) throw new Error("Codex pet billing ownership mismatch");
  const attempt = run.billingChargeAttemptCount;
  const operationId = run.billingOperationId;

  let chargedPoints: number;
  try {
    const receipt = await args.billing.chargeResource({
      operationId,
      userId: run.userId,
      resourceKey,
      units: 1,
    });
    if (!Number.isSafeInteger(receipt.charged) || receipt.charged < 0) {
      throw new Error("billing returned an invalid charged amount");
    }
    chargedPoints = receipt.charged;
  } catch (error) {
    if (isInsufficientBalance(error)) {
      const transitioned = await args.prisma.codexPetRun.updateMany({
        where: {
          id: run.id,
          userId: args.userId,
          projectId: args.projectId,
          billingChargeStatus: "charging",
          billingChargeAttemptCount: attempt,
        },
        data: {
          billingChargeStatus: "insufficient",
          billingChargeError: safeBillingError(error),
          billingChargeLeaseUntil: null,
          billingChargeNextRetryAt: null,
          status: "cancelled",
          progressStage: "cancelled",
          progressMessage: "积分不足，桌宠制作尚未开始",
          completedAt: at,
        },
      });
      const insufficient = await args.prisma.codexPetRun.findUnique({
        where: { id: run.id, userId: args.userId, projectId: args.projectId },
      });
      if (!insufficient) throw new CodexPetBillingRunNotFoundError(run.id);
      return transitioned.count === 1
        ? resultFromRun(insufficient, "insufficient")
        : resultFromRun(insufficient);
    }

    const retryAt = await markUncertain({
      prisma: args.prisma,
      runId: run.id,
      userId: args.userId,
      projectId: args.projectId,
      attempt,
      at,
      error,
      retryBaseMs,
      retryMaxMs,
    });
    const uncertain = await args.prisma.codexPetRun.findUnique({
      where: { id: run.id, userId: args.userId, projectId: args.projectId },
    }).catch(() => null);
    if (uncertain && uncertain.billingChargeStatus !== "charging" && uncertain.billingChargeStatus !== "uncertain") {
      return resultFromRun(uncertain);
    }
    return uncertain
      ? resultFromRun(uncertain, "uncertain")
      : {
        runId: run.id,
        chargeStatus: "uncertain",
        outcome: "uncertain",
        shouldEnqueue: false,
        refundPending: false,
        attemptCount: attempt,
        chargedPoints: 0,
        retryAt,
        error: safeBillingError(error),
      };
  }

  try {
    return await activateChargedCodexPetRun({
      prisma: args.prisma,
      runId: run.id,
      userId: args.userId,
      projectId: args.projectId,
      chargedPoints,
      now,
      resourceKey,
    });
  } catch (error) {
    // The charge may already exist even when activation commit/ack fails.
    // Persist uncertainty when possible; a later call repeats the same
    // operationId and either observes or creates the same single charge.
    const retryAt = await markUncertain({
      prisma: args.prisma,
      runId: run.id,
      userId: args.userId,
      projectId: args.projectId,
      attempt,
      at,
      error,
      retryBaseMs,
      retryMaxMs,
    });
    const current = await args.prisma.codexPetRun.findUnique({
      where: { id: run.id, userId: args.userId, projectId: args.projectId },
    }).catch(() => null);
    if (current && current.billingChargeStatus !== "charging" && current.billingChargeStatus !== "uncertain") {
      return resultFromRun(current);
    }
    return current
      ? resultFromRun(current, "uncertain")
      : {
        runId: run.id,
        chargeStatus: "uncertain",
        outcome: "uncertain",
        shouldEnqueue: false,
        refundPending: false,
        attemptCount: attempt,
        chargedPoints,
        retryAt,
        error: safeBillingError(error),
      };
  }
}

/** Returns due charge intents for a bounded maintenance pass. */
export async function listCodexPetBillingReconciliationCandidates(args: {
  readonly prisma: PrismaClient;
  readonly now?: Date;
  readonly limit?: number;
  readonly includeInsufficient?: boolean;
}): Promise<readonly CodexPetBillingReconciliationCandidate[]> {
  const at = args.now ?? new Date();
  const statuses = ["pending", "uncertain", ...(args.includeInsufficient ? ["insufficient"] : [])];
  const runs = await args.prisma.codexPetRun.findMany({
    where: {
      // Per-image runs reserve their maximum budget at start and are settled
      // from the durable image-call ledger. They must never fall through to
      // the historical package charge reconciler.
      billingMode: { not: CODEX_PET_PER_IMAGE_BILLING_MODE },
      billingOperationId: { not: null },
      billingActivatedAt: null,
      OR: [
        {
          billingChargeStatus: { in: statuses },
          OR: [{ billingChargeNextRetryAt: null }, { billingChargeNextRetryAt: { lte: at } }],
        },
        {
          billingChargeStatus: "charging",
          OR: [{ billingChargeLeaseUntil: null }, { billingChargeLeaseUntil: { lte: at } }],
        },
        { billingChargeStatus: "charged", billingRefundStatus: "none" },
      ],
    },
    orderBy: { updatedAt: "asc" },
    select: { id: true, userId: true, projectId: true },
    take: Math.min(500, Math.max(1, args.limit ?? 50)),
  });
  return runs.map((run) => ({
    runId: run.id,
    userId: run.userId,
    projectId: run.projectId,
  }));
}

export interface CodexPetBillingReconciliationCandidate extends CodexPetBillingRunScope {}

/** Cleanup must not cascade-delete the only durable receipt for these states. */
export function codexPetBillingBlocksProjectDeletion(run: {
  readonly billingChargeStatus: string;
  readonly billingActivatedAt: Date | null;
  readonly billingRefundedAt: Date | null;
  readonly billingRefundStatus: string;
}): boolean {
  if (run.billingChargeStatus === "charging" || run.billingChargeStatus === "uncertain") return true;
  return run.billingChargeStatus === "charged"
    && !run.billingRefundedAt
    && (!run.billingActivatedAt || run.billingRefundStatus !== "none");
}

/**
 * Releases a definitively uncharged intent from active-run gating without
 * deleting its idempotency/audit record. The conditional transition races
 * safely with a charge claim: exactly one of them can change the source state.
 */
export async function releaseDefinitelyUnchargedCodexPetRun(args: CodexPetBillingRunScope & {
  readonly prisma: PrismaClient;
  readonly now?: Date;
}): Promise<boolean> {
  const at = args.now ?? new Date();
  const released = await args.prisma.codexPetRun.updateMany({
    where: {
      id: args.runId,
      userId: args.userId,
      projectId: args.projectId,
      billingChargeStatus: { in: ["pending", "insufficient"] },
    },
    data: {
      status: "cancelled",
      progressStage: "cancelled",
      progressMessage: "桌宠套餐未扣费，运行已释放",
      completedAt: at,
      billingChargeStatus: "cancelled",
      billingChargeError: null,
      billingChargeLeaseUntil: null,
      billingChargeNextRetryAt: null,
      billingRefundedAt: null,
      billingRefundStatus: "none",
      billingRefundError: null,
      billingRefundNextRetryAt: null,
    },
  });
  return released.count === 1;
}
