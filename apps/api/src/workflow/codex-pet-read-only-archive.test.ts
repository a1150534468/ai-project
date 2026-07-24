import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  archiveCodexPetLegacyRuns,
  CODEX_PET_LEGACY_READ_ONLY_STATUS,
} from "./codex-pet-read-only-archive.js";

function makePrisma(input: {
  readonly run?: Record<string, unknown>;
  readonly project?: Record<string, unknown>;
} = {}) {
  const run = {
    id: "run-legacy",
    projectId: "project-legacy",
    userId: "user-1",
    inputSnapshot: { requestedModel: "gpt-image-2" },
    status: "awaiting_direction_review",
    progressStage: "awaiting_direction_review",
    progressPercent: 86,
    progressMessage: "等待继续",
    billingMode: "legacy_package_v1",
    billingPoints: 2600,
    billingRefundStatus: "none",
    workerId: null,
    cancelRequested: false,
    pendingImageJobKey: "look-b",
    imageGenerationApprovalBudget: 1,
    heartbeatAt: null,
    completedAt: null,
    lastEventSequence: 12,
    ...input.run,
  } as Record<string, any>;
  const project = {
    id: "project-legacy",
    userId: "user-1",
    latestRunId: "run-legacy",
    status: "awaiting_direction_review",
    deletedAt: null,
    ...input.project,
  } as Record<string, any>;
  const events: Record<string, any>[] = [];
  const prisma = {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
    $queryRawUnsafe: async () => [],
    codexPetRun: {
      findUnique: async ({ where }: { readonly where: { readonly id: string } }) => where.id === run.id ? { ...run } : null,
      updateMany: async ({ where, data }: { readonly where: Record<string, unknown>; readonly data: Record<string, unknown> }) => {
        if (where.id !== run.id || where.status !== run.status || where.workerId !== run.workerId || where.cancelRequested !== run.cancelRequested || where.billingMode !== run.billingMode) return { count: 0 };
        Object.assign(run, data);
        return { count: 1 };
      },
    },
    codexPetProject: {
      findFirst: async ({ where }: { readonly where: Record<string, unknown> }) => where.id === project.id && where.userId === project.userId && where.deletedAt === null ? { ...project } : null,
      updateMany: async ({ where, data }: { readonly where: Record<string, unknown>; readonly data: Record<string, unknown> }) => {
        if (where.id !== project.id || where.userId !== project.userId || where.latestRunId !== project.latestRunId || where.status !== project.status) return { count: 0 };
        Object.assign(project, data);
        return { count: 1 };
      },
    },
    codexPetEvent: {
      findFirst: async () => events.at(-1) ?? null,
      create: async ({ data }: { readonly data: Record<string, unknown> }) => {
        events.push({ ...data });
        return { ...data };
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, run, project, events };
}

describe("Codex pet legacy read-only archive", () => {
  it("archives an inactive legacy run while preserving billing, provenance, and original state", async () => {
    const { prisma, run, project, events } = makePrisma();
    const at = new Date("2026-07-24T05:00:00.000Z");

    await expect(archiveCodexPetLegacyRuns({
      prisma,
      runIds: ["run-legacy", "run-legacy"],
      now: () => at,
    })).resolves.toEqual([{
      runId: "run-legacy",
      projectId: "project-legacy",
      originalRunStatus: "awaiting_direction_review",
      originalProjectStatus: "awaiting_direction_review",
      eventSequence: 13,
    }]);

    expect(run).toMatchObject({
      status: CODEX_PET_LEGACY_READ_ONLY_STATUS,
      progressStage: CODEX_PET_LEGACY_READ_ONLY_STATUS,
      billingMode: "legacy_package_v1",
      billingPoints: 2600,
      billingRefundStatus: "none",
      pendingImageJobKey: null,
      imageGenerationApprovalBudget: 0,
      completedAt: at,
      heartbeatAt: null,
      lastEventSequence: 13,
    });
    expect(run.inputSnapshot).toMatchObject({
      requestedModel: "gpt-image-2",
      legacyReadOnlyArchive: {
        originalRunStatus: "awaiting_direction_review",
        originalProjectStatus: "awaiting_direction_review",
        archivedAt: at.toISOString(),
      },
    });
    expect(project.status).toBe(CODEX_PET_LEGACY_READ_ONLY_STATUS);
    expect(events).toEqual([expect.objectContaining({
      type: "run.legacy_read_only_archived",
      stage: CODEX_PET_LEGACY_READ_ONLY_STATUS,
      sequence: 13,
      payload: expect.objectContaining({ originalRunStatus: "awaiting_direction_review" }),
    })]);
  });

  it("refuses a live or per-image run without changing its historical record", async () => {
    const { prisma, run, project, events } = makePrisma({
      run: { workerId: "worker-1", billingMode: "per_image_call_v1" },
    });

    await expect(archiveCodexPetLegacyRuns({ prisma, runIds: ["run-legacy"] }))
      .rejects.toThrow("does not use legacy billing");

    expect(run.status).toBe("awaiting_direction_review");
    expect(project.status).toBe("awaiting_direction_review");
    expect(events).toEqual([]);
  });

  it("archives a terminal legacy failure without changing its billing receipt", async () => {
    const { prisma, run, project, events } = makePrisma({
      run: { status: "failed", billingPoints: 0, billingRefundStatus: "refunded", completedAt: new Date("2026-07-24T02:00:00.000Z") },
      project: { status: "failed" },
    });

    await archiveCodexPetLegacyRuns({ prisma, runIds: ["run-legacy"] });

    expect(run).toMatchObject({
      status: CODEX_PET_LEGACY_READ_ONLY_STATUS,
      billingMode: "legacy_package_v1",
      billingPoints: 0,
      billingRefundStatus: "refunded",
      completedAt: new Date("2026-07-24T02:00:00.000Z"),
    });
    expect(events).toHaveLength(1);
  });
});
