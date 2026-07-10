import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { AGENT_TEAM_RUN_STATUS } from "./agent-team-types.js";
import { createPrismaWorkflowStore } from "./agent-workflow-store.js";

interface UpdateManyArgs {
  readonly where: unknown;
  readonly data: unknown;
}

describe("createPrismaWorkflowStore", () => {
  it("guards run terminal updates with user, run, and non-cancelled conditions", async () => {
    const agentWorkflowRun = {
      updateMany: vi.fn(async (_args: UpdateManyArgs) => ({ count: 1 })),
      findUnique: vi.fn(async () => ({ status: AGENT_TEAM_RUN_STATUS.running, cancelledAt: null })),
    };
    const prisma = {
      agentWorkflowRun,
      agentWorkflowStep: {},
      agentWorkflowEvent: {},
    } as unknown as PrismaClient;
    const store = createPrismaWorkflowStore(prisma, "user-1", "run-1");

    await store.markRunRunning();
    await store.completeRun("总结");
    await store.failRun("失败");

    for (const call of agentWorkflowRun.updateMany.mock.calls) {
      const args = call[0];
      expect(args).toEqual(expect.objectContaining({
        where: {
          id: "run-1",
          userId: "user-1",
          status: { not: AGENT_TEAM_RUN_STATUS.cancelled },
          cancelledAt: null,
        },
      }));
    }
  });

  it("does not throw or overwrite terminal status when a run was cancelled", async () => {
    const agentWorkflowRun = {
      updateMany: vi.fn(async (_args: UpdateManyArgs) => ({ count: 0 })),
      findUnique: vi.fn(async () => ({
        status: AGENT_TEAM_RUN_STATUS.cancelled,
        cancelledAt: new Date("2026-07-03T00:00:00.000Z"),
      })),
    };
    const prisma = {
      agentWorkflowRun,
      agentWorkflowStep: {},
      agentWorkflowEvent: {},
    } as unknown as PrismaClient;
    const store = createPrismaWorkflowStore(prisma, "user-1", "run-1");

    await expect(store.completeRun("总结")).resolves.toBeUndefined();
    await expect(store.failRun("失败")).resolves.toBeUndefined();

    expect(agentWorkflowRun.findUnique).toHaveBeenCalledWith({
      where: { id_userId: { id: "run-1", userId: "user-1" } },
      select: { status: true, cancelledAt: true },
    });
  });
});
