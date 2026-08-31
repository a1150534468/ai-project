// 由 codex-pet-runner.ts 纯移动而来（P3.1 阶段 1，知识归档）。

import { type CodexPetJob, Prisma } from "@prisma/client";
import { settlePerImageBilling } from "./runner-billing.js";
import { emit, updateOwnedJob } from "./runner-lease.js";
import {
  CodexPetArchiveDeferredError,
  CodexPetCancelledError,
  type CodexPetExecutionResult,
  CodexPetLeaseLostError,
  type RunnerContext,
} from "./runner-types.js";
import { asRecord, configuredArchiveMaxAttempts, safeError } from "./runner-util.js";

export const TERMINAL_ARCHIVE_ERROR_CODES = new Set([
  "run_not_found",
  "invalid_stage",
  "archive_deleted",
  "package_incomplete",
  "validation_failed",
  "source_conflict",
]);

export function terminalArchiveError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
  return typeof code === "string" && TERMINAL_ARCHIVE_ERROR_CODES.has(code);
}

export function archiveErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Serialize every knowledge-archive Job transition with the owning Run row.
 *
 * A Job-level workerId alone is not a lease: after a stale-run takeover the
 * old process can still finish an in-flight database call. Locking and
 * checking the Run in the same transaction prevents that process from
 * changing the Job after a newer worker owns the Run.
 */
export async function withCurrentKnowledgeArchiveLease<T>(
  ctx: RunnerContext,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return ctx.prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ readonly id: string }>>`
      SELECT "id"
      FROM "CodexPetRun"
      WHERE "id" = ${ctx.runId}
        AND "projectId" = ${ctx.project.id}
        AND "userId" = ${ctx.project.userId}
        AND "workerId" = ${ctx.workerId}
        AND "status" = 'archiving'
        AND "cancelRequested" = false
      FOR UPDATE
    `;
    if (locked.length !== 1) throw new CodexPetLeaseLostError();
    return operation(tx);
  });
}

export async function transitionKnowledgeArchiveJob(
  ctx: RunnerContext,
  job: CodexPetJob,
  data: Prisma.CodexPetJobUpdateManyMutationInput,
): Promise<CodexPetJob> {
  return withCurrentKnowledgeArchiveLease(ctx, async (tx) => {
    await updateOwnedJob(tx, ctx, job.id, data, { status: job.status, workerId: job.workerId });
    const updated = await tx.codexPetJob.findFirst({
      where: {
        id: job.id,
        runId: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
      },
    });
    if (!updated) throw new CodexPetLeaseLostError();
    return updated;
  });
}

export async function ensureKnowledgeArchiveJob(
  ctx: RunnerContext,
  maxAttempts: number,
): Promise<CodexPetJob> {
  return withCurrentKnowledgeArchiveLease(ctx, async (tx) => {
    const job = await tx.codexPetJob.upsert({
      where: { runId_key: { runId: ctx.runId, key: "knowledge-archive" } },
      create: {
        projectId: ctx.project.id,
        runId: ctx.runId,
        userId: ctx.project.userId,
        key: "knowledge-archive",
        kind: "knowledge_archive",
        dependencyKeys: ["standard-atlas", "look-a", "look-b"],
        maxAttempts,
      },
      update: { maxAttempts },
    });
    if (job.runId !== ctx.runId
      || job.projectId !== ctx.project.id
      || job.userId !== ctx.project.userId) {
      throw new Error("Codex pet knowledge archive job ownership mismatch");
    }
    return job;
  });
}

/**
 * `archiveCodexPetRun` commits the Document and Run link atomically, but the
 * process can die before it checkpoints the Job. In that case the ownership-
 * scoped Run link is the durable result. Reconcile the Job without consuming
 * another attempt or calling the archive routine again.
 */
export async function reconcileKnowledgeArchiveJob(
  ctx: RunnerContext,
  job: CodexPetJob,
): Promise<string | null> {
  return withCurrentKnowledgeArchiveLease(ctx, async (tx) => {
    const run = await tx.codexPetRun.findFirst({
      where: {
        id: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        workerId: ctx.workerId,
        status: "archiving",
        cancelRequested: false,
      },
      select: { knowledgeDocumentId: true },
    });
    if (!run) throw new CodexPetLeaseLostError();
    if (!run.knowledgeDocumentId) return null;

    const document = await tx.document.findFirst({
      where: {
        id: run.knowledgeDocumentId,
        sourceModule: "codex_pet",
        sourceId: ctx.runId,
        kb: {
          ownerType: "USER",
          userId: ctx.project.userId,
          systemKey: "AI_ARTIFACTS",
        },
      },
      select: { id: true },
    });
    if (!document) return null;

    const previous = asRecord(job.output);
    if (job.status === "completed"
      && job.workerId === null
      && previous.documentId === document.id) {
      return document.id;
    }
    await updateOwnedJob(tx, ctx, job.id, {
      status: "completed",
      output: { documentId: document.id } as Prisma.InputJsonValue,
      completedAt: new Date(),
      workerId: null,
      error: null,
    }, { status: job.status, workerId: job.workerId });
    return document.id;
  });
}

/**
 * Knowledge archival is a durable job rather than an in-process retry loop.
 * Transient database/indexing-control-plane failures leave the run at 98% in
 * `archiving`; the worker releases its lease and the stale-run scanner queues
 * another attempt. Permanent contract failures, or exhaustion of the bounded
 * deployment-configured attempts, still follow the normal full-refund path.
 */
export async function runKnowledgeArchiveAttempt(ctx: RunnerContext): Promise<string> {
  const maxAttempts = configuredArchiveMaxAttempts(ctx.env);
  let job = await ensureKnowledgeArchiveJob(ctx, maxAttempts);

  const reconciledDocumentId = await reconcileKnowledgeArchiveJob(ctx, job);
  if (reconciledDocumentId) return reconciledDocumentId;

  const previous = asRecord(job.output);
  if (job.status === "completed") {
    throw new Error(typeof previous.documentId === "string" && previous.documentId
      ? "知识库归档 checkpoint 与运行关联不一致"
      : "知识库归档 checkpoint 缺少文档 ID");
  }
  if (job.status === "failed" || job.status === "cancelled") {
    throw new Error(job.error || "AI 产物知识库归档任务已终止");
  }
  if (job.status !== "queued" && job.status !== "running") {
    throw new Error(`无法从 ${job.status} 状态恢复知识库归档任务`);
  }

  // A process crash can leave a running Job behind while the Run lease is
  // later reclaimed. Resume that exact attempt; only a durably queued retry
  // consumes the next bounded attempt.
  const recoveringRunningAttempt = job.status === "running";
  const attempt = recoveringRunningAttempt ? Math.max(1, job.attempt) : job.attempt + 1;
  if (attempt > job.maxAttempts) throw new Error("AI 产物知识库归档重试次数已耗尽");
  job = await transitionKnowledgeArchiveJob(ctx, job, {
    status: "running",
    attempt,
    workerId: ctx.workerId,
    startedAt: recoveringRunningAttempt ? job.startedAt ?? new Date() : new Date(),
    completedAt: null,
    error: null,
  });
  if (attempt === 1 && !recoveringRunningAttempt) {
    await emit(ctx, "knowledge.archive_started", "archiving", 98, "开始写入 AI 产物知识库", {
      attempt,
      maxAttempts: job.maxAttempts,
    }, job.key).catch(() => undefined);
  }
  try {
    const documentId = (await ctx.archiveRun({
      prisma: ctx.prisma,
      runId: ctx.runId,
      userId: ctx.project.userId,
      projectId: ctx.project.id,
      workerId: ctx.workerId,
    })).documentId;
    if (!documentId) throw new Error("知识库归档未返回文档 ID");
    job = await transitionKnowledgeArchiveJob(ctx, job, {
      status: "completed",
      output: { documentId } as Prisma.InputJsonValue,
      completedAt: new Date(),
      workerId: null,
      error: null,
    });
    await emit(ctx, "knowledge.archive_completed", "archiving", 98, "已归档到 AI 产物知识库", {
      knowledgeDocumentId: documentId,
      attempt,
    }, job.key).catch(() => undefined);
    return documentId;
  } catch (error) {
    if (error instanceof CodexPetLeaseLostError || archiveErrorCode(error) === "lease_lost") {
      throw new CodexPetLeaseLostError();
    }
    if (archiveErrorCode(error) === "cancelled") throw new CodexPetCancelledError();
    const terminal = terminalArchiveError(error) || attempt >= job.maxAttempts;
    job = await transitionKnowledgeArchiveJob(ctx, job, {
      status: terminal ? "failed" : "queued",
      workerId: null,
      error: safeError(error),
      completedAt: terminal ? new Date() : null,
    });
    await emit(ctx, "knowledge.archive_retrying", "archiving", 98, terminal
      ? "AI 产物知识库归档最终失败"
      : "知识库归档暂时失败，等待 Worker 重试", {
      attempt,
      maxAttempts: job.maxAttempts,
      terminal,
      error: safeError(error),
    }, job.key).catch(() => undefined);
    if (terminal) throw error;
    throw new CodexPetArchiveDeferredError(safeError(error), attempt, job.maxAttempts);
  }
}

export async function completeKnowledgeArchive(ctx: RunnerContext): Promise<CodexPetExecutionResult> {
  // 知识库归档是「事后登记」，不是交付条件：精灵图、ZIP、验证报告在 packaging
  // 阶段就已经落库并复核过。归档失败以前会把整条运行判 failed 并全额退款——
  // 一个登记动作掉一次已交付的付费运行。这里改成尽力而为。
  // 计划：docs/superpowers/plans/2026-08-31-knowledge-vs-asset-library-split.md（P0.3）
  let documentId: string | null = null;
  try {
    documentId = await runKnowledgeArchiveAttempt(ctx);
  } catch (error) {
    // 租约丢失和用户取消是真正的控制流，仍然要往上抛。
    if (error instanceof CodexPetLeaseLostError) throw error;
    if (error instanceof CodexPetCancelledError) throw error;
    // 归档失败的事件由 runKnowledgeArchiveAttempt 自己发（knowledge.archive_retrying），
    // 这里不重复发一条。
  }
  await settlePerImageBilling(ctx);
  const now = new Date();
  const readyCommitted = await ctx.prisma.$transaction(async (tx) => {
    // 判据只看租约和阶段。ready + knowledgeDocumentId=null 现在是合法终态。
    const transition = await tx.codexPetRun.updateMany({
      where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId, status: "archiving", cancelRequested: false },
      data: { status: "ready", progressStage: "ready", progressPercent: 100, progressMessage: "桌宠已完成，可安装到 Codex", completedAt: now, heartbeatAt: now, workerId: null, error: null },
    });
    if (transition.count !== 1) return false;
    await tx.codexPetProject.updateMany({ where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } }, data: { status: "ready" } });
    return true;
  });
  if (!readyCommitted) throw new Error("运行租约或阶段已变化，桌宠不能进入 ready");
  // ready 就是权威的已提交结果。最后这一次 SSE/事件写失败绝不能把一个可交付的
  // 运行降级成 failed 或触发退款。
  await emit(ctx, "run.completed", "ready", 100, documentId ? "桌宠已完成并归档" : "桌宠已完成", {
    knowledgeDocumentId: documentId,
  }).catch(() => undefined);
  return { status: "ready", runId: ctx.runId };
}

export async function releaseDeferredArchiveLease(ctx: RunnerContext, error: CodexPetArchiveDeferredError): Promise<boolean> {
  const released = await ctx.prisma.codexPetRun.updateMany({
    where: {
      id: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      workerId: ctx.workerId,
      status: "archiving",
      cancelRequested: false,
    },
    data: {
      progressStage: "archiving",
      progressPercent: 98,
      progressMessage: `知识库归档暂时失败，等待重试（${error.attempt}/${error.maxAttempts}）`,
      error: error.message,
      workerId: null,
      heartbeatAt: null,
    },
  });
  return released.count === 1;
}
