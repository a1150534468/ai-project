import type { Prisma, PrismaClient } from "@prisma/client";

export const CODEX_PET_LEGACY_READ_ONLY_STATUS = "legacy_read_only";

const ARCHIVABLE_LEGACY_STATUSES = new Set([
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
  "ready",
  "failed",
  "cancelled",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { ...value as Record<string, unknown> }
    : {};
}

export interface CodexPetLegacyArchiveResult {
  readonly runId: string;
  readonly projectId: string;
  readonly originalRunStatus: string;
  readonly originalProjectStatus: string;
  readonly eventSequence: number;
}

/**
 * Archives explicitly selected, inactive legacy runs without changing their
 * provider provenance, artifacts or jobs. A row lock and strict preconditions
 * prevent this administrative operation from racing a live worker.
 */
export async function archiveCodexPetLegacyRuns(input: {
  readonly prisma: PrismaClient;
  readonly runIds: readonly string[];
  readonly now?: () => Date;
  readonly reason?: string;
}): Promise<readonly CodexPetLegacyArchiveResult[]> {
  const runIds = [...new Set(input.runIds.map((runId) => runId.trim()).filter(Boolean))];
  if (runIds.length === 0) throw new Error("at least one Codex pet run id is required");
  const at = input.now?.() ?? new Date();
  const reason = input.reason?.trim() || "历史运行已按 GPT 单模型收敛策略归档为只读";

  return input.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const results: CodexPetLegacyArchiveResult[] = [];
    for (const runId of runIds) {
      await tx.$queryRawUnsafe('SELECT "id" FROM "CodexPetRun" WHERE "id" = $1 FOR UPDATE', runId);
      const run = await tx.codexPetRun.findUnique({ where: { id: runId } });
      if (!run) throw new Error(`Codex pet run ${runId} was not found`);
      if (run.status === CODEX_PET_LEGACY_READ_ONLY_STATUS) {
        const existingEvent = await tx.codexPetEvent.findFirst({
          where: { runId: run.id, type: "run.legacy_read_only_archived" },
          orderBy: { sequence: "desc" },
        });
        results.push({
          runId: run.id,
          projectId: run.projectId,
          originalRunStatus: String(asRecord(run.inputSnapshot).legacyReadOnlyArchive && asRecord(asRecord(run.inputSnapshot).legacyReadOnlyArchive).originalRunStatus || "unknown"),
          originalProjectStatus: String(asRecord(run.inputSnapshot).legacyReadOnlyArchive && asRecord(asRecord(run.inputSnapshot).legacyReadOnlyArchive).originalProjectStatus || "unknown"),
          eventSequence: existingEvent?.sequence ?? run.lastEventSequence,
        });
        continue;
      }
      if (!ARCHIVABLE_LEGACY_STATUSES.has(run.status)) {
        throw new Error(`Codex pet run ${runId} is not an archivable legacy run`);
      }
      if (run.workerId || run.cancelRequested) {
        throw new Error(`Codex pet run ${runId} still has a worker lease or cancellation in progress`);
      }

      await tx.$queryRawUnsafe('SELECT "id" FROM "CodexPetProject" WHERE "id" = $1 FOR UPDATE', run.projectId);
      const project = await tx.codexPetProject.findFirst({ where: { id: run.projectId, userId: run.userId, deletedAt: null } });
      if (!project) throw new Error(`Codex pet project for run ${runId} was not found`);
      if (project.latestRunId !== run.id) {
        throw new Error(`Codex pet run ${runId} is no longer the project's latest run`);
      }
      if (!ARCHIVABLE_LEGACY_STATUSES.has(project.status)) {
        throw new Error(`Codex pet project for run ${runId} is not in an archivable state`);
      }

      const eventSequence = run.lastEventSequence + 1;
      const inputSnapshot = {
        ...asRecord(run.inputSnapshot),
        legacyReadOnlyArchive: {
          originalRunStatus: run.status,
          originalProjectStatus: project.status,
          archivedAt: at.toISOString(),
          reason,
        },
      };
      const archived = await tx.codexPetRun.updateMany({
        where: {
          id: run.id,
          projectId: run.projectId,
          userId: run.userId,
          status: run.status,
          workerId: null,
          cancelRequested: false,
        },
        data: {
          inputSnapshot,
          status: CODEX_PET_LEGACY_READ_ONLY_STATUS,
          progressStage: CODEX_PET_LEGACY_READ_ONLY_STATUS,
          progressMessage: "历史运行已归档为只读，保留产物与模型来源",
          pendingImageJobKey: null,
          imageGenerationApprovalBudget: 0,
          completedAt: run.completedAt ?? at,
          heartbeatAt: null,
          lastEventSequence: eventSequence,
        },
      });
      if (archived.count !== 1) throw new Error(`Codex pet run ${runId} changed while being archived`);
      await tx.codexPetProject.updateMany({
        where: { id: project.id, userId: project.userId, latestRunId: run.id, status: project.status },
        data: { status: CODEX_PET_LEGACY_READ_ONLY_STATUS },
      });
      await tx.codexPetEvent.create({
        data: {
          projectId: run.projectId,
          runId: run.id,
          userId: run.userId,
          sequence: eventSequence,
          type: "run.legacy_read_only_archived",
          stage: CODEX_PET_LEGACY_READ_ONLY_STATUS,
          message: "历史运行已归档为只读，未改变产物或模型来源",
          progress: run.progressPercent,
          payload: {
            originalRunStatus: run.status,
            originalProjectStatus: project.status,
            reason,
          },
        },
      });
      results.push({
        runId: run.id,
        projectId: run.projectId,
        originalRunStatus: run.status,
        originalProjectStatus: project.status,
        eventSequence,
      });
    }
    return results;
  });
}
