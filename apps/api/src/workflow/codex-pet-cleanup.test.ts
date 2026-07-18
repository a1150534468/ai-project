import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { CodexPetCleanupPendingError, executeCodexPetProjectCleanup } from "./codex-pet-cleanup.js";

function fixture(options: {
  live?: boolean;
  objectKey?: string;
  projectMissing?: boolean;
  projectStatus?: string;
  runStatus?: string;
  chargeStatus?: string;
  refundStatus?: string;
  refundedAt?: Date | null;
  activatedAt?: Date | null;
} = {}) {
  const tx = {
    document: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    codexPetProject: { deleteMany: vi.fn(async () => ({ count: 1 })) },
  };
  const prisma = {
    codexPetProject: { findFirst: vi.fn(async () => options.projectMissing ? null : ({ id: "project-1", userId: "user-1", status: options.projectStatus ?? "deleting" })) },
    codexPetRun: {
      findMany: vi.fn(async () => [{
        id: "run-1",
        status: options.runStatus ?? "ready",
        workerId: options.live ? "worker-1" : null,
        billingChargeStatus: options.chargeStatus ?? "charged",
        billingActivatedAt: options.activatedAt === undefined ? new Date("2026-07-18T00:00:00.000Z") : options.activatedAt,
        billingRefundedAt: options.refundedAt ?? null,
        billingRefundStatus: options.refundStatus ?? "none",
      }]),
    },
    codexPetArtifact: { findMany: vi.fn(async () => [{
      objectKey: options.objectKey ?? "workflow/codex-pets/user-1/project-1/run-1/a/file.webp",
      userId: "user-1",
      projectId: "project-1",
      runId: "run-1",
    }]) },
    $transaction: vi.fn(async (callback: (arg: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as PrismaClient;
  const send = vi.fn(async () => ({}));
  const persistObjectRefs = vi.fn(async () => undefined);
  const s3 = { bucket: "test", client: { send } } as never;
  return { prisma, tx, s3, send, persistObjectRefs };
}

describe("Codex pet durable project cleanup", () => {
  it("does not delete a project that was not marked for deletion", async () => {
    const value = fixture({ projectStatus: "cancelled" });
    await expect(executeCodexPetProjectCleanup({ prisma: value.prisma, s3: value.s3, userId: "user-1", projectId: "project-1", persistObjectRefs: value.persistObjectRefs }))
      .resolves.toEqual({ deleted: false, objectCount: 0 });
    expect(value.send).not.toHaveBeenCalled();
    expect(value.tx.codexPetProject.deleteMany).not.toHaveBeenCalled();
  });

  it("waits for the active worker before deleting any state", async () => {
    const value = fixture({ live: true });
    await expect(executeCodexPetProjectCleanup({ prisma: value.prisma, s3: value.s3, userId: "user-1", projectId: "project-1", persistObjectRefs: value.persistObjectRefs }))
      .rejects.toBeInstanceOf(CodexPetCleanupPendingError);
    expect(value.send).not.toHaveBeenCalled();
    expect(value.tx.codexPetProject.deleteMany).not.toHaveBeenCalled();
  });

  it("waits for an active run even when no worker lease is currently held", async () => {
    const value = fixture({ runStatus: "standard_generating" });
    await expect(executeCodexPetProjectCleanup({ prisma: value.prisma, s3: value.s3, userId: "user-1", projectId: "project-1", persistObjectRefs: value.persistObjectRefs }))
      .rejects.toBeInstanceOf(CodexPetCleanupPendingError);
    expect(value.send).not.toHaveBeenCalled();
    expect(value.tx.codexPetProject.deleteMany).not.toHaveBeenCalled();
  });

  it("keeps the durable receipt while a charge or refund is unsettled", async () => {
    for (const options of [
      { chargeStatus: "uncertain" },
      { chargeStatus: "charged", refundStatus: "pending" },
      { chargeStatus: "charged", refundStatus: "failed" },
    ]) {
      const value = fixture(options);
      await expect(executeCodexPetProjectCleanup({ prisma: value.prisma, s3: value.s3, userId: "user-1", projectId: "project-1", persistObjectRefs: value.persistObjectRefs }))
        .rejects.toBeInstanceOf(CodexPetCleanupPendingError);
      expect(value.send).not.toHaveBeenCalled();
      expect(value.tx.codexPetProject.deleteMany).not.toHaveBeenCalled();
    }
  });

  it("persists the object plan, deletes documents/project, then deletes private objects", async () => {
    const value = fixture();
    await expect(executeCodexPetProjectCleanup({ prisma: value.prisma, s3: value.s3, userId: "user-1", projectId: "project-1", persistObjectRefs: value.persistObjectRefs }))
      .resolves.toEqual({ deleted: true, objectCount: 1 });
    expect(value.persistObjectRefs).toHaveBeenCalledOnce();
    expect(value.send).toHaveBeenCalledOnce();
    expect(value.tx.document.deleteMany).toHaveBeenCalledWith({ where: { sourceModule: "codex_pet", sourceId: { in: ["run-1"] }, kb: { userId: "user-1", systemKey: "AI_ARTIFACTS" } } });
    expect(value.tx.codexPetProject.deleteMany).toHaveBeenCalledWith({ where: { id: "project-1", userId: "user-1" } });
    expect(value.persistObjectRefs.mock.invocationCallOrder[0]).toBeLessThan(value.tx.document.deleteMany.mock.invocationCallOrder[0]!);
    expect(value.tx.codexPetProject.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(value.send.mock.invocationCallOrder[0]!);
  });

  it("retries retained private objects after relational state is already gone", async () => {
    const value = fixture({ projectMissing: true });
    const objectRefs = [{
      objectKey: "workflow/codex-pets/user-1/project-1/run-1/a/file.webp",
      userId: "user-1",
      projectId: "project-1",
      runId: "run-1",
    }];
    await expect(executeCodexPetProjectCleanup({
      prisma: value.prisma,
      s3: value.s3,
      userId: "user-1",
      projectId: "project-1",
      objectRefs,
    })).resolves.toEqual({ deleted: true, objectCount: 1 });
    expect(value.send).toHaveBeenCalledOnce();
    expect(value.tx.document.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses cleanup keys outside the Codex pet namespace", async () => {
    const value = fixture({ objectKey: "workflow/images/not-a-pet.png" });
    await expect(executeCodexPetProjectCleanup({ prisma: value.prisma, s3: value.s3, userId: "user-1", projectId: "project-1", persistObjectRefs: value.persistObjectRefs }))
      .rejects.toThrow(/outside/);
    expect(value.tx.codexPetProject.deleteMany).not.toHaveBeenCalled();
  });
});
