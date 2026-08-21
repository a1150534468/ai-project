import { Queue, Worker, type Processor } from "bullmq";
import type { PrismaClient } from "@prisma/client";
import { deleteObject, makeS3, type S3 } from "../storage/s3.js";
import { codexPetBullConnection } from "./codex-pet-queue.js";
import { isCodexPetArtifactObjectKeyFor } from "./codex-pet-storage.js";
import { codexPetBillingBlocksProjectDeletion } from "./codex-pet-billing.js";

export const CODEX_PET_CLEANUP_QUEUE_NAME = "codex-pet-project-cleanup";

export interface CodexPetProjectCleanupPayload {
  readonly userId: string;
  readonly projectId: string;
  /**
   * Durable deletion plan captured before project rows are removed. BullMQ
   * keeps this data across attempts, so private-object deletion can continue
   * after the knowledge document/project transaction has already committed.
   */
  readonly objectRefs?: readonly CodexPetCleanupObjectRef[];
}

export interface CodexPetCleanupObjectRef {
  readonly objectKey: string;
  readonly userId: string;
  readonly projectId: string;
  readonly runId: string;
}

export class CodexPetCleanupPendingError extends Error {
  constructor(projectId: string) {
    super(`Codex pet project ${projectId} still has live work or unsettled billing`);
    this.name = "CodexPetCleanupPendingError";
  }
}

// A run can briefly have no worker lease (for example between Bull delivery
// and the CAS claim, or while it is waiting for base-artifact confirmation)
// while it is still an active part of the workflow.  Project deletion must
// wait for the cancellation transition to make that run terminal; checking
// only workerId would otherwise allow cleanup to delete a live run's rows and
// private objects underneath a later queue delivery.
const CODEX_PET_NON_TERMINAL_RUN_STATUSES = new Set([
  "queued",
  "base_generating",
  "awaiting_base_review",
  "awaiting_direction_review",
  "standard_generating",
  "direction_generating",
  "validating",
  "repairing",
  "packaging",
  "archiving",
]);

let cleanupQueue: Queue<CodexPetProjectCleanupPayload> | null = null;

function producer(): Queue<CodexPetProjectCleanupPayload> {
  cleanupQueue ??= new Queue<CodexPetProjectCleanupPayload>(CODEX_PET_CLEANUP_QUEUE_NAME, { connection: codexPetBullConnection() });
  return cleanupQueue;
}

export async function enqueueCodexPetProjectCleanup(payload: CodexPetProjectCleanupPayload): Promise<void> {
  const queue = producer();
  const jobId = `project-${payload.projectId}`;
  // Failed jobs are retained for diagnosis (`removeOnFail` keeps the last
  // 500), but BullMQ treats a retained job id as already present.  Without
  // removing an exhausted failed record, a later DELETE/retry would be a
  // silent no-op and leave the project permanently in `deleting`.
  const existing = await queue.getJob(jobId);
  if (existing && (await existing.getState()) === "failed") {
    await existing.remove().catch(() => undefined);
  }
  await queue.add("cleanup", payload, {
    jobId,
    attempts: Math.max(3, Number(process.env.CODEX_PET_CLEANUP_ATTEMPTS) || 120),
    backoff: { type: "fixed", delay: Math.max(1_000, Number(process.env.CODEX_PET_CLEANUP_BACKOFF_MS) || 10_000) },
    removeOnComplete: true,
    removeOnFail: Math.max(1, Number(process.env.QUEUE_FAILED_JOB_COUNT) || 200),
  });
}

export function createCodexPetCleanupWorker(processor: Processor<CodexPetProjectCleanupPayload>): Worker<CodexPetProjectCleanupPayload> {
  return new Worker<CodexPetProjectCleanupPayload>(CODEX_PET_CLEANUP_QUEUE_NAME, processor, {
    connection: codexPetBullConnection(),
    concurrency: 1,
  });
}

export async function executeCodexPetProjectCleanup(args: {
  readonly prisma: PrismaClient;
  readonly userId: string;
  readonly projectId: string;
  readonly objectRefs?: readonly CodexPetCleanupObjectRef[];
  readonly persistObjectRefs?: (refs: readonly CodexPetCleanupObjectRef[]) => Promise<void>;
  readonly s3?: S3;
}): Promise<{ deleted: boolean; objectCount: number }> {
  const validateObjectRefs = (refs: readonly CodexPetCleanupObjectRef[]) => {
    for (const ref of refs) {
      if (ref.userId !== args.userId
        || ref.projectId !== args.projectId
        || !isCodexPetArtifactObjectKeyFor(ref)) {
        throw new Error("Refusing to delete an object outside the owning Codex pet namespace");
      }
    }
    return [...new Map(refs.map((ref) => [ref.objectKey, ref])).values()];
  };
  const deleteObjectRefs = async (refs: readonly CodexPetCleanupObjectRef[]) => {
    const s3 = args.s3 ?? makeS3();
    for (const ref of refs) await deleteObject(s3, ref.objectKey);
  };

  const project = await args.prisma.codexPetProject.findFirst({ where: { id: args.projectId, userId: args.userId } });
  if (!project) {
    const retainedRefs = validateObjectRefs(args.objectRefs ?? []);
    if (retainedRefs.length === 0) return { deleted: false, objectCount: 0 };
    await deleteObjectRefs(retainedRefs);
    return { deleted: true, objectCount: retainedRefs.length };
  }
  // New project deletion is a tombstone operation. Keep the legacy cleanup
  // worker safe for old `status=deleting` rows created before soft delete.
  if (project.deletedAt) return { deleted: false, objectCount: 0 };
  if (project.status !== "deleting") return { deleted: false, objectCount: 0 };
  const runs = await args.prisma.codexPetRun.findMany({
    where: { projectId: project.id, userId: args.userId },
    select: {
      id: true,
      status: true,
      workerId: true,
      billingChargeStatus: true,
      billingActivatedAt: true,
      billingRefundedAt: true,
      billingRefundStatus: true,
    },
  });
  if (runs.some((run) => CODEX_PET_NON_TERMINAL_RUN_STATUSES.has(run.status)
    || Boolean(run.workerId)
    || codexPetBillingBlocksProjectDeletion(run))) {
    throw new CodexPetCleanupPendingError(project.id);
  }
  const artifacts = await args.prisma.codexPetArtifact.findMany({
    where: { projectId: project.id, userId: args.userId },
    select: { objectKey: true, userId: true, projectId: true, runId: true },
  });
  const objectRefs = validateObjectRefs(artifacts);
  if (objectRefs.length > 0) {
    if (!args.persistObjectRefs) {
      throw new Error("A durable Codex pet object-deletion plan writer is required");
    }
    // Persist the exact, ownership-checked object plan before the database
    // transaction. If the process dies after the transaction, BullMQ retries
    // with these refs even though the project/artifact rows no longer exist.
    await args.persistObjectRefs(objectRefs);
  }
  await args.prisma.$transaction(async (tx) => {
    if (runs.length) {
      // Restrict archive cleanup to this user's system AI_ARTIFACTS base. The
      // sourceId is already run-scoped/unique, but the KB predicate makes the
      // ownership boundary explicit and protects against legacy collisions.
      await tx.document.deleteMany({
        where: {
          sourceModule: "codex_pet",
          sourceId: { in: runs.map((run) => run.id) },
          kb: { userId: args.userId, systemKey: "AI_ARTIFACTS" },
        },
      });
    }
    await tx.codexPetProject.deleteMany({ where: { id: project.id, userId: args.userId } });
  });
  // Binary cleanup is deliberately after the synchronous relational cleanup.
  // A failure throws and leaves the BullMQ job (including objectRefs)
  // retryable without resurrecting the deleted knowledge document or project.
  await deleteObjectRefs(objectRefs);
  return { deleted: true, objectCount: objectRefs.length };
}

export async function closeCodexPetCleanupQueue(): Promise<void> {
  await cleanupQueue?.close();
  cleanupQueue = null;
}
