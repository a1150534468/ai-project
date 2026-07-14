import type { PrismaClient } from "@prisma/client";
import { InsufficientBalanceError } from "@ai-assistant/billing";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ appendNovelRunEvent: vi.fn() }));
vi.mock("./events.js", () => ({ appendNovelRunEvent: mocks.appendNovelRunEvent }));

import { executeNovelEngineStep } from "./runner.js";

describe("novel engine runner", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pauses without consuming circuit-breaker attempts when balance is insufficient", async () => {
    const run = {
      id: "run-1",
      projectId: "project-1",
      userId: "user-1",
      mode: "autopilot",
      status: "queued",
      currentStep: "writeChapter",
      currentChapter: 1,
      targetCharsPerChapter: 3000,
      pauseRequested: false,
      cancelRequested: false,
      consecutiveFailures: 0,
      startedAt: null,
    };
    const step = {
      id: "step-1",
      runId: run.id,
      sequence: 1,
      kind: "writeChapter",
      status: "queued",
      chapterNumber: 1,
      input: {},
      run,
    };
    const stepUpdate = vi.fn(async () => step);
    const runUpdate = vi.fn(async () => run);
    const projectUpdate = vi.fn(async () => ({}));
    const prisma = {
      novelRunStep: {
        findUnique: vi.fn(async () => step),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: stepUpdate,
      },
      novelRun: { update: runUpdate },
      novelProject: {
        update: projectUpdate,
        findUniqueOrThrow: vi.fn(async () => ({ id: "project-1", title: "长夜", genre: "玄幻", premise: "追查旧案", settings: {}, narrativeContract: {} })),
      },
      novelChapter: { findUniqueOrThrow: vi.fn(async () => ({ id: "chapter-1", title: "第一章", summary: "开场" })) },
      novelTask: { findFirst: vi.fn(async () => null) },
      $transaction: vi.fn(async (input: unknown) => Array.isArray(input) ? Promise.all(input) : undefined),
    } as unknown as PrismaClient;
    const billing = {
      reserveResource: vi.fn(async () => { throw new InsufficientBalanceError(); }),
      settleResource: vi.fn(),
      refundResource: vi.fn(),
    };

    await expect(executeNovelEngineStep({ stepId: step.id, prisma, billing, workerId: "worker-1" })).resolves.toBeUndefined();
    expect(stepUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "queued", workerId: null }) }));
    expect(runUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "paused", pauseRequested: true }) }));
    expect(projectUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ data: { autopilotStatus: "paused" } }));
    expect(mocks.appendNovelRunEvent).toHaveBeenLastCalledWith(expect.objectContaining({ type: "balanceRequired", stage: "paused" }));
  });
});
