import { Prisma, type PrismaClient } from "@prisma/client";
import { CODEX_PET_PER_IMAGE_BILLING_MODE } from "./codex-pet-call-ledger.js";
import {
  codexPetGateRowJobKey,
  readCodexPetGateFailureSnapshot,
} from "./codex-pet-gate-failure.js";
import { CODEX_PET_BOARD_PROMPT_VERSION } from "./codex-pet-board-version.js";
import { DOUBAO_IMAGE_MODEL } from "./_shared/image-service.js";

const CONTINUATION_SCHEMA_VERSION = "codex-pet-failed-continuation-v1";
const REQUIRED_CHECKPOINT_KEYS = [
  "base-candidate-1",
  "base-candidate-2",
  "base-selection",
  "identity-guide",
] as const;
const BOARD_JOB_KINDS = new Set(["standard_row", "look_cardinals", "look_row"]);
const TARGETED_BOARD_MAX_REAL_ATTEMPTS = 4;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

export interface ContinuationBillingShape {
  readonly billingMode: string;
  readonly billingChargeStatus: string;
  readonly billingRefundStatus: string;
  readonly billingRefundedAt: Date | null;
  readonly billingSettlementStatus: string;
}

/**
 * A continuation must never replay work the user has not paid for, so each
 * billing mode has its own proof that the money side is safe to reuse.
 *
 * Legacy package runs charge up front and refund on failure, so the proof is a
 * completed refund. Per-image runs neither charge up front nor refund — they
 * hold a reservation and settle once. For them the proof is an *unsettled*
 * reservation: settlement is irreversible and closes every resume path, so a
 * still-reserved run is exactly the one that can be continued. Requiring the
 * legacy refund columns here (as this module originally did) rejected every
 * per-image run, which is why a fixable failure had no continuation path at all.
 */
export function continuationBillingBlocked(run: ContinuationBillingShape): string | null {
  if (run.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE) {
    if (run.billingSettlementStatus !== "reserved") {
      return "按次计费续跑只允许调用额度仍处于预留中的失败运行（已结清的运行不能续跑）";
    }
    return null;
  }
  if (run.billingChargeStatus !== "charged"
    || run.billingRefundStatus !== "refunded"
    || !run.billingRefundedAt) {
    return "失败续跑只允许已退款的失败运行";
  }
  return null;
}

/** Deterministic checkpoints that only re-derive from board output. Clearing
 * them costs no provider call and is what makes the row reset actually reach the
 * assembled artifacts: `standard-atlas` would otherwise hand back its stale
 * completed atlas and hide the regenerated rows. */
const STANDARD_ROW_DERIVED_JOB_KEYS = ["standard-atlas"] as const;

interface GateScopedResetJob {
  readonly id: string;
  readonly key: string;
  readonly kind: string;
  readonly attempt: number;
  readonly outputArtifactIds: readonly string[];
}

/**
 * Clear the gate-blamed boards so the normal runner regenerates them.
 *
 * The board is `completed`, so nothing else in the pipeline would redo it: the
 * runner returns a completed board verbatim. Marking it failed with its output
 * detached is the reset. The attempt counter is deliberately preserved under
 * per-image billing, because it is the ledger's logical-attempt key — a redo has
 * to arrive as a *new* attempt so it is charged and approved rather than
 * colliding with the call the user already paid for.
 */
async function resetGateScopedJobs(
  tx: Prisma.TransactionClient,
  input: {
    readonly runId: string;
    readonly projectId: string;
    readonly userId: string;
    readonly perImageBilling: boolean;
    readonly jobs: readonly GateScopedResetJob[];
    readonly gate: string;
    readonly now: Date;
  },
): Promise<void> {
  const obsoleteArtifactIds = input.jobs.flatMap((job) => [...job.outputArtifactIds]);
  if (obsoleteArtifactIds.length > 0) {
    await tx.codexPetArtifact.updateMany({
      where: {
        id: { in: obsoleteArtifactIds },
        runId: input.runId,
        projectId: input.projectId,
        userId: input.userId,
      },
      data: { status: "superseded" },
    });
  }
  for (const job of input.jobs) {
    await tx.codexPetJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        error: `${input.gate} 闸门指认该动作组需要重做`,
        // One more attempt, so the ledger sees a fresh logical attempt and the
        // per-image gate can ask the user to approve (and pay for) the redo.
        // Never lower a durable limit an approval already raised.
        ...(input.perImageBilling
          ? { maxAttempts: Math.max(job.attempt + 1, 1) }
          : { attempt: 0 }),
        output: Prisma.DbNull,
        outputArtifactIds: [],
        providerMetadata: Prisma.DbNull,
        workerId: null,
        startedAt: null,
        completedAt: input.now,
      },
    });
  }
  // Reassembly must be forced only when a standard row actually changed; a
  // direction-only scope leaves the intermediate atlas (and the paid cardinal
  // board derived from it) untouched.
  const standardRowChanged = input.jobs.some((job) => job.kind === "standard_row");
  if (!standardRowChanged) return;
  const derived = await tx.codexPetJob.findMany({
    where: {
      runId: input.runId,
      projectId: input.projectId,
      userId: input.userId,
      key: { in: [...STANDARD_ROW_DERIVED_JOB_KEYS] },
      status: "completed",
    },
    select: { id: true, outputArtifactIds: true },
  });
  const derivedArtifactIds = derived.flatMap((job) => job.outputArtifactIds);
  if (derivedArtifactIds.length > 0) {
    await tx.codexPetArtifact.updateMany({
      where: {
        id: { in: derivedArtifactIds },
        runId: input.runId,
        projectId: input.projectId,
        userId: input.userId,
      },
      data: { status: "superseded" },
    });
  }
  if (derived.length > 0) {
    await tx.codexPetJob.updateMany({
      where: { id: { in: derived.map((job) => job.id) } },
      data: {
        status: "queued",
        output: Prisma.DbNull,
        outputArtifactIds: [],
        error: null,
        workerId: null,
        startedAt: null,
        completedAt: null,
      },
    });
  }
}

export interface CodexPetFailedContinuationInput {
  readonly prisma: PrismaClient;
  readonly runId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly reason: string;
}

export interface CodexPetFailedContinuationResult {
  readonly runId: string;
  readonly resumed: boolean;
  readonly targetPromptVersion: string;
  readonly preservedImageGenerationCallCount: number;
  readonly reusableCheckpointKeys: readonly string[];
  readonly resettableJobKeys: readonly string[];
}

export interface CodexPetTargetedBoardRetryInput {
  readonly prisma: PrismaClient;
  readonly runId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly sourceBoardArtifactId: string;
  /** Optional deterministic guide derived from already-paid provider frames. */
  readonly scaffoldArtifactId?: string;
  readonly reason: string;
}

export interface CodexPetTargetedBoardRetryResult {
  readonly runId: string;
  readonly resumed: boolean;
  readonly state: "running-right";
  readonly sourceBoardArtifactId: string;
  readonly preservedImageGenerationCallCount: number;
}

/**
 * Prepare exactly one running-right replay from an already-paid Seedream
 * board. This intentionally leaves the run terminal until a separate,
 * explicit recovery step reuses any other approved boards; it cannot enqueue
 * or contact a provider by itself.
 */
export async function initializeCodexPetTargetedBoardRetry(
  input: CodexPetTargetedBoardRetryInput,
): Promise<CodexPetTargetedBoardRetryResult> {
  const reason = input.reason.trim();
  const requestedScaffoldArtifactId = input.scaffoldArtifactId?.trim() || null;
  if (!reason) throw new Error("定向动作续跑必须记录具体修复原因");
  if (!input.sourceBoardArtifactId.trim()) throw new Error("定向动作续跑缺少失败姿势板");

  return input.prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT "id" FROM "CodexPetRun" WHERE "id" = $1 FOR UPDATE', input.runId);
    const run = await tx.codexPetRun.findFirst({
      where: { id: input.runId, projectId: input.projectId, userId: input.userId },
      include: { project: true },
    });
    if (!run || run.project.id !== input.projectId || run.project.userId !== input.userId) {
      throw new Error("定向动作续跑源运行归属不一致");
    }
    const snapshot = record(run.inputSnapshot);
    const existing = record(snapshot.targetedBoardRetry);
    const targetedBillingBlocked = continuationBillingBlocked(run);
    if (targetedBillingBlocked) throw new Error(targetedBillingBlocked);
    if (run.status !== "failed"
      || run.workerId
      || run.cancelRequested
      || run.project.latestRunId !== run.id
      || run.project.status !== "failed") {
      throw new Error("定向动作续跑只允许当前无 lease、未取消的失败运行");
    }
    if (run.requestedModel !== DOUBAO_IMAGE_MODEL) {
      throw new Error("running-right 定向脚手架续跑只允许 Seedream 项目");
    }
    if (!run.selectedBaseArtifactId) throw new Error("定向动作续跑缺少已确认主形象");

    const [job, idleJob, sourceBoard, recoveryScaffold] = await Promise.all([
      tx.codexPetJob.findFirst({
        where: { runId: run.id, projectId: run.projectId, userId: run.userId, key: "row-running-right" },
      }),
      tx.codexPetJob.findFirst({
        where: { runId: run.id, projectId: run.projectId, userId: run.userId, key: "row-idle" },
        select: { status: true },
      }),
      tx.codexPetArtifact.findFirst({
        where: {
          id: input.sourceBoardArtifactId,
          runId: run.id,
          projectId: run.projectId,
          userId: run.userId,
          kind: "pose_board",
          status: "ready",
        },
      }),
      requestedScaffoldArtifactId ? tx.codexPetArtifact.findFirst({
        where: {
          id: requestedScaffoldArtifactId,
          runId: run.id,
          projectId: run.projectId,
          userId: run.userId,
          kind: "pose_board_scaffold",
          status: "ready",
          mime: "image/png",
        },
      }) : null,
    ]);
    const idempotentPreparedJob = existing.schemaVersion === "codex-pet-targeted-board-retry-v1"
      && existing.state === "running-right"
      && existing.sourceBoardArtifactId === input.sourceBoardArtifactId
      && (existing.scaffoldArtifactId ?? null) === requestedScaffoldArtifactId
      && job?.status === "queued";
    if (!job || (!["failed", "cancelled"].includes(job.status) && !idempotentPreparedJob)) {
      throw new Error("running-right 当前不是可定向续跑的失败动作");
    }
    const existingAttempt = existing.schemaVersion === "codex-pet-targeted-board-retry-v1"
      ? (Number.isSafeInteger(Number(existing.attempt)) && Number(existing.attempt) >= 1 ? Number(existing.attempt) : 1)
      : 0;
    if (existing.schemaVersion === "codex-pet-targeted-board-retry-v1") {
      if (existing.state !== "running-right") throw new Error("该运行已经绑定到其他定向动作续跑");
      if (existing.sourceBoardArtifactId === input.sourceBoardArtifactId
        && (existing.scaffoldArtifactId ?? null) === requestedScaffoldArtifactId) {
        if (idleJob?.status === "completed" && run.status === "failed") {
          const sequence = run.lastEventSequence + 1;
          await tx.codexPetRun.update({
            where: { id: run.id },
            data: {
              status: "standard_generating",
              progressStage: "standard_generating",
              progressMessage: "idle 已复用，正在执行受控 running-right 续跑",
              completedAt: null,
              error: null,
              lastEventSequence: sequence,
            },
          });
          await tx.codexPetProject.update({ where: { id: run.projectId }, data: { status: "standard_generating" } });
        }
        return {
          runId: run.id,
          resumed: false,
          state: "running-right" as const,
          sourceBoardArtifactId: input.sourceBoardArtifactId,
          preservedImageGenerationCallCount: run.imageGenerationCallCount,
        };
      }
      if (!Number.isSafeInteger(existingAttempt) || existingAttempt < 1 || existingAttempt >= TARGETED_BOARD_MAX_REAL_ATTEMPTS) {
        throw new Error("定向动作续跑已达到真实调用上限");
      }
      const latestBoard = await tx.codexPetArtifact.findFirst({
        where: {
          runId: run.id,
          projectId: run.projectId,
          userId: run.userId,
          jobId: job.id,
          kind: "pose_board",
          status: "ready",
        },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (!latestBoard || latestBoard.id !== input.sourceBoardArtifactId) {
        throw new Error("定向动作续跑缺少上一次真实调用产生的新失败板");
      }
    }
    if (!sourceBoard || sourceBoard.jobId !== job.id) {
      throw new Error("定向续跑失败板不属于 running-right 动作");
    }
    if (requestedScaffoldArtifactId && (!recoveryScaffold || recoveryScaffold.jobId !== job.id)) {
      throw new Error("定向续跑脚手架不属于 running-right 动作");
    }
    if (recoveryScaffold
      && (!recoveryScaffold.width
        || !recoveryScaffold.height
        || Math.abs(recoveryScaffold.width / 4 - recoveryScaffold.height / 2) > 1)) {
      throw new Error("定向续跑脚手架必须使用与 4×2 目标一致的方形槽位画布");
    }
    const sourceMetadata = record(sourceBoard.metadata);
    if (sourceMetadata.actualModel !== DOUBAO_IMAGE_MODEL
      && sourceMetadata.requestedModel !== DOUBAO_IMAGE_MODEL) {
      throw new Error("定向续跑失败板不是 Seedream 真实产物");
    }

    const now = new Date();
    const nextSnapshot = {
      ...snapshot,
      targetedBoardRetry: {
        schemaVersion: "codex-pet-targeted-board-retry-v1",
        state: "running-right",
        status: "prepared",
        sourceBoardArtifactId: sourceBoard.id,
        scaffoldArtifactId: recoveryScaffold?.id ?? null,
        reason,
        preparedAt: now.toISOString(),
        sourceImageGenerationCallCount: run.imageGenerationCallCount,
        attempt: existingAttempt + 1,
        maxAttempts: TARGETED_BOARD_MAX_REAL_ATTEMPTS,
      },
    } as Prisma.InputJsonObject;
    const changed = await tx.codexPetJob.updateMany({
      where: { id: job.id, runId: run.id, projectId: run.projectId, userId: run.userId, status: { in: ["failed", "cancelled"] } },
      data: {
        status: "queued",
        attempt: 0,
        maxAttempts: 1,
        input: {
          ...record(job.input),
          targetedRetry: true,
          targetedRetryState: "running-right",
          targetedRetrySourceBoardArtifactId: sourceBoard.id,
          targetedRetryScaffoldArtifactId: recoveryScaffold?.id ?? null,
        } as Prisma.InputJsonValue,
        outputArtifactIds: [],
        output: Prisma.DbNull,
        providerMetadata: Prisma.DbNull,
        error: null,
        workerId: null,
        startedAt: null,
        completedAt: null,
      },
    });
    if (changed.count !== 1) throw new Error("定向动作续跑状态已被其他操作改变");
    const sequence = run.lastEventSequence + 1;
    const activateRun = idleJob?.status === "completed";
    await tx.codexPetRun.update({
      where: { id: run.id },
      data: {
        inputSnapshot: nextSnapshot,
        lastEventSequence: sequence,
        ...(activateRun ? {
          status: "standard_generating",
          progressStage: "standard_generating",
          progressMessage: "idle 已复用，正在执行受控 running-right 续跑",
          completedAt: null,
          error: null,
        } : {}),
      },
    });
    if (activateRun) {
      await tx.codexPetProject.update({
        where: { id: run.projectId },
        data: { status: "standard_generating" },
      });
    }
    await tx.codexPetEvent.create({
      data: {
        projectId: run.projectId,
        runId: run.id,
        userId: run.userId,
        sequence,
        type: "run.targeted_board_retry_prepared",
        stage: "failed",
        progress: run.progressPercent,
        message: `已锁定 running-right 第 ${existingAttempt + 1}/${TARGETED_BOARD_MAX_REAL_ATTEMPTS} 次 Seedream 续跑，不会自动重试`,
        payload: {
          state: "running-right",
          sourceBoardArtifactId: sourceBoard.id,
          scaffoldArtifactId: recoveryScaffold?.id ?? null,
          preservedImageGenerationCallCount: run.imageGenerationCallCount,
          attempt: existingAttempt + 1,
          maxAttempts: TARGETED_BOARD_MAX_REAL_ATTEMPTS,
        },
      },
    });
    return {
      runId: run.id,
      resumed: true,
      state: "running-right" as const,
      sourceBoardArtifactId: sourceBoard.id,
      preservedImageGenerationCallCount: run.imageGenerationCallCount,
    };
  });
}

/**
 * Unlock one failed/refunded run after a board-prompt upgrade without creating
 * a project, charging again, or contacting any provider. The normal runner
 * owns the actual replay and its input-revision CAS resets only stale failed
 * board jobs when execution is explicitly started later.
 */
export async function initializeCodexPetFailedContinuation(
  input: CodexPetFailedContinuationInput,
): Promise<CodexPetFailedContinuationResult> {
  const reason = input.reason.trim();
  if (!reason) throw new Error("失败续跑必须记录具体修复原因");

  return input.prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT "id" FROM "CodexPetRun" WHERE "id" = $1 FOR UPDATE', input.runId);
    const run = await tx.codexPetRun.findFirst({
      where: { id: input.runId, projectId: input.projectId, userId: input.userId },
      include: { project: true, jobs: { orderBy: { createdAt: "asc" } } },
    });
    if (!run || run.project.id !== input.projectId || run.project.userId !== input.userId) {
      throw new Error("失败续跑源运行归属不一致");
    }

    const snapshot = record(run.inputSnapshot);
    const existingContinuation = record(snapshot.failedContinuation);
    if (existingContinuation.schemaVersion === CONTINUATION_SCHEMA_VERSION) {
      if (existingContinuation.targetPromptVersion === CODEX_PET_BOARD_PROMPT_VERSION) {
        if (["failed", "cancelled"].includes(run.status)) {
          throw new Error("该失败运行已经使用过当前提示词版本的一次续跑机会");
        }
        return {
          runId: run.id,
          resumed: false,
          targetPromptVersion: CODEX_PET_BOARD_PROMPT_VERSION,
          preservedImageGenerationCallCount: run.imageGenerationCallCount,
          reusableCheckpointKeys: [...REQUIRED_CHECKPOINT_KEYS],
          resettableJobKeys: Array.isArray(existingContinuation.resettableJobKeys)
            ? existingContinuation.resettableJobKeys.filter((value): value is string => typeof value === "string")
            : [],
        };
      }
    }

    const billingBlocked = continuationBillingBlocked(run);
    if (billingBlocked) throw new Error(billingBlocked);
    if (run.status !== "failed"
      || !run.billingActivatedAt
      || run.workerId
      || run.cancelRequested) {
      throw new Error("失败续跑只允许已激活计费、无 lease 且未取消的失败运行");
    }
    if (run.project.latestRunId !== run.id
      || run.project.status !== "failed"
      || run.project.deletedAt) {
      throw new Error("失败续跑源运行不是项目当前失败版本");
    }
    if (!run.selectedBaseArtifactId) throw new Error("失败续跑缺少已确认的主形象检查点");

    const selectedBase = await tx.codexPetArtifact.findFirst({
      where: {
        id: run.selectedBaseArtifactId,
        runId: run.id,
        projectId: run.projectId,
        userId: run.userId,
        kind: "base_candidate",
        status: "ready",
      },
      select: { id: true },
    });
    if (!selectedBase) throw new Error("失败续跑的已确认主形象不存在或已失效");

    const jobsByKey = new Map(run.jobs.map((job) => [job.key, job]));
    for (const key of REQUIRED_CHECKPOINT_KEYS) {
      const job = jobsByKey.get(key);
      if (!job || job.status !== "completed") throw new Error(`失败续跑缺少已完成检查点：${key}`);
    }

    const staleCompletedBoards = run.jobs.filter((job) => (
      BOARD_JOB_KINDS.has(job.kind)
      && job.status === "completed"
      && record(job.input).promptVersion !== CODEX_PET_BOARD_PROMPT_VERSION
    ));
    if (staleCompletedBoards.length > 0) {
      throw new Error(`失败续跑不能隐式重做已通过动作：${staleCompletedBoards.map((job) => job.key).join("、")}`);
    }

    const resettableJobs = run.jobs.filter((job) => (
      BOARD_JOB_KINDS.has(job.kind)
      && ["failed", "cancelled", "queued"].includes(job.status)
      && record(job.input).promptVersion !== CODEX_PET_BOARD_PROMPT_VERSION
    ));
    // A gate rejection is the other continuable shape: every row can be
    // `completed` at the current prompt version while the assembled atlas still
    // fails, so "did the prompt version move" cannot be the only admission test.
    // The scope comes from the gate itself, recorded when the run failed, and is
    // therefore never an implicit redo of an action the user approved.
    const gateFailure = readCodexPetGateFailureSnapshot(run.inputSnapshot);
    const gateScopedJobs = gateFailure
      ? gateFailure.rows
        .map((row) => jobsByKey.get(codexPetGateRowJobKey(row)))
        .filter((job): job is NonNullable<typeof job> => Boolean(job)
          && BOARD_JOB_KINDS.has(job!.kind)
          && !resettableJobs.some((candidate) => candidate.id === job!.id))
      : [];
    if (resettableJobs.length === 0 && gateScopedJobs.length === 0) {
      throw new Error(gateFailure
        ? `失败续跑找不到闸门指认的动作任务：${gateFailure.rows.join("、")}`
        : `失败续跑没有可由 ${CODEX_PET_BOARD_PROMPT_VERSION} 修复的旧动作任务`);
    }

    const now = new Date();
    if (gateScopedJobs.length > 0) {
      await resetGateScopedJobs(tx, {
        runId: run.id,
        projectId: run.projectId,
        userId: run.userId,
        perImageBilling: run.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE,
        jobs: gateScopedJobs,
        gate: gateFailure!.gate,
        now,
      });
    }
    const resettableJobKeys = [...resettableJobs, ...gateScopedJobs].map((job) => job.key);
    const sourcePromptVersions = [...new Set([...resettableJobs, ...gateScopedJobs]
      .map((job) => record(job.input).promptVersion)
      .filter((value): value is string => typeof value === "string" && value.length > 0))];
    const priorTargetPromptVersions = [...new Set([
      ...(Array.isArray(existingContinuation.priorTargetPromptVersions)
        ? existingContinuation.priorTargetPromptVersions.filter((value): value is string => typeof value === "string" && value.length > 0)
        : []),
      ...(typeof existingContinuation.targetPromptVersion === "string" && existingContinuation.targetPromptVersion.length > 0
        ? [existingContinuation.targetPromptVersion]
        : []),
    ])];
    const nextSnapshot = {
      ...snapshot,
      // The gate scope has been consumed by this continuation's reset. Leaving it
      // behind would let a later continuation silently re-clear the same rows
      // from a record that no longer describes the current run.
      gateFailure: null,
      failedContinuation: {
        schemaVersion: CONTINUATION_SCHEMA_VERSION,
        initializedAt: now.toISOString(),
        reason,
        sourceStatus: run.status,
        sourcePromptVersions,
        targetPromptVersion: CODEX_PET_BOARD_PROMPT_VERSION,
        priorTargetPromptVersions,
        sourceImageGenerationCallCount: run.imageGenerationCallCount,
        maxBoardAttemptsPerJob: 1,
        reusableCheckpointKeys: [...REQUIRED_CHECKPOINT_KEYS],
        resettableJobKeys,
        ...(gateFailure && gateScopedJobs.length > 0
          ? {
            gateFailure: {
              gate: gateFailure.gate,
              rows: [...gateFailure.rows],
              recordedAt: gateFailure.recordedAt,
              resetJobKeys: gateScopedJobs.map((job) => job.key),
            },
          }
          : {}),
      },
    } as Prisma.InputJsonObject;

    const updated = await tx.codexPetRun.update({
      where: { id: run.id },
      data: {
        inputSnapshot: nextSnapshot,
        status: "standard_generating",
        progressStage: "standard_generating",
        progressPercent: Math.max(16, run.progressPercent),
        progressMessage: "已复用主形象与身份指南，等待一次性续跑缺失动作",
        completedAt: null,
        heartbeatAt: null,
        workerId: null,
        error: null,
        pendingImageJobKey: null,
        imageGenerationApprovalBudget: 0,
        lastEventSequence: { increment: 1 },
      },
      select: { lastEventSequence: true },
    });
    await tx.codexPetProject.update({
      where: { id: run.projectId },
      data: { status: "standard_generating" },
    });
    await tx.codexPetEvent.create({
      data: {
        projectId: run.projectId,
        runId: run.id,
        userId: run.userId,
        sequence: updated.lastEventSequence,
        type: "run.continuation_initialized",
        stage: "standard_generating",
        progress: Math.max(16, run.progressPercent),
        message: gateScopedJobs.length > 0
          ? `已锁定旧检查点，等待重做闸门指认的 ${gateScopedJobs.length} 组动作`
          : "已锁定旧检查点，等待一次性续跑缺失动作",
        payload: {
          targetPromptVersion: CODEX_PET_BOARD_PROMPT_VERSION,
          preservedImageGenerationCallCount: run.imageGenerationCallCount,
          reusableCheckpointKeys: [...REQUIRED_CHECKPOINT_KEYS],
          resettableJobKeys,
          ...(gateFailure && gateScopedJobs.length > 0
            ? { gate: gateFailure.gate, gateRows: [...gateFailure.rows] }
            : {}),
        },
      },
    });

    return {
      runId: run.id,
      resumed: true,
      targetPromptVersion: CODEX_PET_BOARD_PROMPT_VERSION,
      preservedImageGenerationCallCount: run.imageGenerationCallCount,
      reusableCheckpointKeys: [...REQUIRED_CHECKPOINT_KEYS],
      resettableJobKeys,
    };
  });
}
