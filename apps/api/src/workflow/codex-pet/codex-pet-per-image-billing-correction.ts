import type { Prisma, PrismaClient } from "@prisma/client";
import { CODEX_PET_PER_IMAGE_BILLING_MODE } from "./codex-pet-call-ledger.js";

const TERMINAL_STATUSES = new Set(["ready", "failed", "cancelled"]);

type BillingCorrectionClient = {
  readonly chargeResource: (args: {
    readonly operationId: string;
    readonly userId: string;
    readonly resourceKey: string;
    readonly units: number;
  }) => Promise<{ readonly charged: number }>;
};

type CorrectableRun = {
  readonly id: string;
  readonly projectId: string;
  readonly userId: string;
  readonly status: string;
  readonly workerId: string | null;
  readonly cancelRequested: boolean;
  readonly billingMode: string;
  readonly billingOperationId: string | null;
  readonly billingResourceKey: string | null;
  readonly billingSettlementStatus: string;
  readonly billingSettledPoints: number;
  readonly billingSettledUnits: number;
  readonly billingPoints: number;
  readonly usage: unknown;
  readonly lastEventSequence: number;
};

type SentCall = {
  readonly id: string;
  readonly points: number;
};

export type CodexPetPerImageBillingCorrectionResult = {
  readonly runId: string;
  readonly correctionOperationId: string;
  readonly status: "corrected" | "already_corrected";
  readonly sentPlannedCalls: number;
  readonly ledgerPoints: number;
  readonly previouslySettledPoints: number;
  readonly correctionPoints: number;
  readonly settledPoints: number;
};

export function codexPetPerImageBillingCorrectionOperationId(runId: string, targetPoints: number): string {
  return `codex-pet:run:${runId}:planned-images:settlement-correction:${targetPoints}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value as Record<string, unknown> }
    : {};
}

function assertFrozenPoints(points: number): void {
  if (!Number.isSafeInteger(points) || points <= 0) {
    throw new Error("Codex pet billing correction requires a positive frozen per-call price");
  }
}

function assertCorrectableRun(run: CorrectableRun | null): asserts run is CorrectableRun {
  if (!run) throw new Error("Codex pet billing correction run was not found");
  if (run.billingMode !== CODEX_PET_PER_IMAGE_BILLING_MODE
    || run.billingSettlementStatus !== "settled"
    || !TERMINAL_STATUSES.has(run.status)) {
    throw new Error("Codex pet billing correction only permits settled terminal per-image runs");
  }
  // 活跃性只认 workerId。cancelRequested 在「已取消」终态上只是历史痕迹：worker 还在
  // 跑时取消路由只写 cancelRequested 并保持非终态，等收手后才写 status=cancelled，
  // 所以 cancelled + workerId=null 是确定的静止态。把 cancelRequested 一律当活跃信号，
  // 会让这个补收工具永远修不了取消路径——而按图预留最常见的收口恰恰是取消，也正是
  // settleCancellationRefund 写下「需要按图补收」诊断的那一条，诊断与工具必须对得上。
  // ready/failed 上的 cancelRequested 仍然拦住：那说明取消信号发出后运行另有归宿，
  // 状态机没走完，先查清再补收。
  const stillActive = run.workerId !== null || (run.cancelRequested && run.status !== "cancelled");
  if (stillActive || !run.billingOperationId || !run.billingResourceKey) {
    throw new Error("Codex pet billing correction requires an inactive run with a billing receipt");
  }
}

function validateCalls(calls: readonly SentCall[], perImageCallPoints: number): number {
  if (calls.length === 0) throw new Error("Codex pet billing correction requires at least one sent planned call");
  if (calls.some((call) => call.points !== 0 && call.points !== perImageCallPoints)) {
    throw new Error("Codex pet billing correction found a conflicting planned-call price");
  }
  return calls.length * perImageCallPoints;
}

async function loadCorrectionState(prisma: PrismaClient, runId: string): Promise<{ run: CorrectableRun; calls: SentCall[] }> {
  const run = await prisma.codexPetRun.findFirst({ where: { id: runId } }) as CorrectableRun | null;
  assertCorrectableRun(run);
  const calls = await prisma.codexPetImageCall.findMany({
    where: { runId, callKind: "planned", sentAt: { not: null } },
    select: { id: true, points: true },
    orderBy: { sentAt: "asc" },
  }) as SentCall[];
  return { run, calls };
}

/**
 * Repairs a prematurely-settled rollout run without issuing an image request.
 * The correction operation is deterministic, so a process crash after its
 * billing call can be safely resumed without a second deduction.
 */
export async function correctCodexPetPerImageBilling(input: {
  readonly prisma: PrismaClient;
  readonly billing: BillingCorrectionClient;
  readonly runId: string;
  readonly perImageCallPoints: number;
  readonly now?: () => Date;
}): Promise<CodexPetPerImageBillingCorrectionResult> {
  assertFrozenPoints(input.perImageCallPoints);
  const now = input.now ?? (() => new Date());
  const initial = await loadCorrectionState(input.prisma, input.runId);
  const targetPoints = validateCalls(initial.calls, input.perImageCallPoints);
  const correctionOperationId = codexPetPerImageBillingCorrectionOperationId(initial.run.id, targetPoints);
  const missingPoints = targetPoints - initial.run.billingSettledPoints;
  if (missingPoints < 0 || missingPoints % input.perImageCallPoints !== 0) {
    throw new Error("Codex pet billing correction cannot reconcile this settlement amount");
  }

  let correctionPoints = 0;
  if (missingPoints > 0) {
    const receipt = await input.billing.chargeResource({
      operationId: correctionOperationId,
      userId: initial.run.userId,
      resourceKey: initial.run.billingResourceKey!,
      units: missingPoints / input.perImageCallPoints,
    });
    correctionPoints = receipt.charged;
  }

  return input.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRawUnsafe('SELECT "id" FROM "CodexPetRun" WHERE "id" = $1 FOR UPDATE', input.runId);
    const current = await loadCorrectionState(tx as unknown as PrismaClient, input.runId);
    const currentTargetPoints = validateCalls(current.calls, input.perImageCallPoints);
    const currentCorrectionOperationId = codexPetPerImageBillingCorrectionOperationId(current.run.id, currentTargetPoints);
    const usage = asRecord(current.run.usage);
    const existingCorrection = asRecord(usage.perImageBillingCorrection);
    if (current.run.billingSettledPoints >= currentTargetPoints
      && existingCorrection.operationId === currentCorrectionOperationId) {
      return {
        runId: current.run.id,
        correctionOperationId: currentCorrectionOperationId,
        status: "already_corrected" as const,
        sentPlannedCalls: current.calls.length,
        ledgerPoints: currentTargetPoints,
        previouslySettledPoints: current.run.billingSettledPoints,
        correctionPoints: Number(existingCorrection.correctionPoints) || 0,
        settledPoints: current.run.billingSettledPoints,
      };
    }
    if (currentTargetPoints !== targetPoints || current.run.billingSettledPoints !== initial.run.billingSettledPoints) {
      throw new Error("Codex pet billing correction state changed before it could be recorded");
    }
    if (currentCorrectionOperationId !== correctionOperationId) {
      throw new Error("Codex pet billing correction operation changed unexpectedly");
    }

    await tx.codexPetImageCall.updateMany({
      where: { runId: current.run.id, callKind: "planned", sentAt: { not: null }, points: 0 },
      data: { points: input.perImageCallPoints },
    });
    const settledPoints = current.run.billingSettledPoints + correctionPoints;
    const nextUsage = {
      ...usage,
      perImageBillingCorrection: {
        version: 1,
        operationId: correctionOperationId,
        sentPlannedCalls: current.calls.length,
        ledgerPoints: currentTargetPoints,
        previouslySettledPoints: current.run.billingSettledPoints,
        correctionPoints,
        settledPoints,
        appliedAt: now().toISOString(),
      },
    };
    const updated = await tx.codexPetRun.update({
      where: { id: current.run.id },
      data: {
        billingSettledUnits: current.calls.length,
        billingSettledPoints: settledPoints,
        billingPoints: settledPoints,
        // 补收就是那条「需要按图补收」诊断的解除条件。留着不清，账本已经修好的运行
        // 还会一直挂着报警，下一次真出事时没人会再当真；审计痕迹由下面的
        // perImageBillingCorrection 和 billing.settlement.corrected 事件承担。
        billingChargeError: null,
        usage: nextUsage,
        lastEventSequence: { increment: 1 },
      },
    }) as CorrectableRun;
    await tx.codexPetEvent.create({
      data: {
        projectId: current.run.projectId,
        runId: current.run.id,
        userId: current.run.userId,
        sequence: updated.lastEventSequence,
        type: "billing.settlement.corrected",
        stage: current.run.status,
        message: "已更正已发送生图调用的账本结算；未发起任何额外生图调用",
        progress: 100,
        payload: {
          correctionOperationId,
          sentPlannedCalls: current.calls.length,
          ledgerPoints: currentTargetPoints,
          previouslySettledPoints: current.run.billingSettledPoints,
          correctionPoints,
          settledPoints,
        },
      },
    });
    return {
      runId: current.run.id,
      correctionOperationId,
      status: "corrected" as const,
      sentPlannedCalls: current.calls.length,
      ledgerPoints: currentTargetPoints,
      previouslySettledPoints: current.run.billingSettledPoints,
      correctionPoints,
      settledPoints,
    };
  });
}
