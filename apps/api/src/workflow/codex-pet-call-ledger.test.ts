import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  CODEX_PET_EXTRA_IMAGE_CALLS_PER_JOB_LIMIT,
  CODEX_PET_EXTRA_IMAGE_CALLS_PER_RUN_LIMIT,
  CODEX_PET_PER_IMAGE_BILLING_MODE,
  CodexPetImageCallAlreadySentError,
  CodexPetImageCallLimitError,
  refundCodexPetUndispatchedExtraCalls,
  codexPetExtraCallBudget,
  completeCodexPetImageCall,
  markCodexPetImageCallSent,
  prepareCodexPetImageCallDispatch,
  prepareCodexPetExtraImageCall,
  refundCodexPetFailedExtraCall,
} from "./codex-pet-call-ledger.js";
import { callImageGenerationDetailed } from "./_shared/image-service.js";

type CallRow = Record<string, unknown>;

function createLedgerPrisma(limit = 14) {
  const run: Record<string, unknown> = {
    id: "run-1",
    projectId: "project-1",
    userId: "user-1",
    workerId: "worker-1",
    cancelRequested: false,
    billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
    plannedImageCallLimit: limit,
    imageGenerationCallCount: 0,
    billingResourceKey: "codex_pet_v2_package",
  };
  const calls: CallRow[] = [];
  let nextId = 1;
  const prisma: Record<string, unknown> = {
    $queryRawUnsafe: async () => [{ id: run.id }],
    codexPetRun: {
      findFirst: async () => run,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        const increment = data.imageGenerationCallCount as { increment?: number } | undefined;
        if (increment?.increment) run.imageGenerationCallCount = Number(run.imageGenerationCallCount) + increment.increment;
        if (data.heartbeatAt) run.heartbeatAt = data.heartbeatAt;
        return { count: 1 };
      },
    },
    codexPetImageCall: {
      findUnique: async ({ where }: { where: { runId_jobKey_logicalAttempt: { runId: string; jobKey: string; logicalAttempt: number } } }) => {
        const key = where.runId_jobKey_logicalAttempt;
        return calls.find((call) => call.runId === key.runId && call.jobKey === key.jobKey && call.logicalAttempt === key.logicalAttempt) ?? null;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => calls.find((call) => (
        call.runId === where.runId && call.jobKey === where.jobKey && call.callKind === where.callKind
      )) ?? null,
      count: async ({ where }: { where: Record<string, unknown> }) => calls.filter((call) => {
        const statusFilter = where.status as string | { in?: readonly string[]; not?: string } | undefined;
        const statusMatches = statusFilter === undefined
          ? true
          : typeof statusFilter === "string"
            ? call.status === statusFilter
            : statusFilter.in
              ? statusFilter.in.includes(String(call.status))
              : statusFilter.not !== undefined
                ? call.status !== statusFilter.not
                : true;
        return call.runId === where.runId
          && call.projectId === where.projectId
          && call.userId === where.userId
          && call.callKind === where.callKind
          && (where.jobKey === undefined || call.jobKey === where.jobKey)
          && statusMatches
          && (where.sentAt === undefined || call.sentAt != null);
      }).length,
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const refundFilter = where.refundStatus as { not?: string } | undefined;
        return calls.filter((call) => (where.runId === undefined || call.runId === where.runId)
          && (where.projectId === undefined || call.projectId === where.projectId)
          && (where.userId === undefined || call.userId === where.userId)
          && (where.callKind === undefined || call.callKind === where.callKind)
          && (where.status === undefined || call.status === where.status)
          && (refundFilter?.not === undefined || (call.refundStatus ?? "none") !== refundFilter.not));
      },
      create: async ({ data }: { data: CallRow }) => {
        const row = { id: `call-${nextId++}`, ...data };
        calls.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: CallRow }) => {
        const row = calls.find((call) => call.id === where.id);
        if (!row) throw new Error("call missing");
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: CallRow }) => {
        const refundFilter = where.refundStatus as { not?: string } | undefined;
        const matched = calls.filter((call) => (where.id === undefined || call.id === where.id)
          && (where.runId === undefined || call.runId === where.runId)
          && (where.jobKey === undefined || call.jobKey === where.jobKey)
          && (where.logicalAttempt === undefined || call.logicalAttempt === where.logicalAttempt)
          && (refundFilter?.not === undefined || (call.refundStatus ?? "none") !== refundFilter.not));
        matched.forEach((call) => Object.assign(call, data));
        return { count: matched.length };
      },
    },
  };
  prisma.$transaction = async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma);
  return { prisma: prisma as unknown as PrismaClient, run, calls };
}

const baseInput = {
  projectId: "project-1",
  userId: "user-1",
  workerId: "worker-1",
  requestedModel: "gpt-image-2",
  points: 200,
} as const;

describe("Codex pet image-call ledger", () => {
  it("blocks the fifteenth planned call before a provider adapter can run", async () => {
    const { prisma, calls, run } = createLedgerPrisma(14);
    for (let attempt = 1; attempt <= 14; attempt += 1) {
      await prepareCodexPetImageCallDispatch({ ...baseInput, prisma, runId: "run-1", jobKey: `row-${attempt}`, logicalAttempt: 1 });
      await markCodexPetImageCallSent({ ...baseInput, prisma, runId: "run-1", jobKey: `row-${attempt}`, logicalAttempt: 1 });
    }

    const fetchFn = vi.fn();
    await expect(callImageGenerationDetailed({
      config: {
        endpoint: "https://pixel.example.test/v1/images/generations",
        apiKey: "test-key",
        model: "gpt-image-2",
        protocol: "openai",
      },
      prompt: "must not reach Pixel",
      size: "1024x1024",
      fetchFn,
      onRequestDispatching: async () => {
        await prepareCodexPetImageCallDispatch({
          ...baseInput,
          prisma,
          runId: "run-1",
          jobKey: "look-over-limit",
          logicalAttempt: 1,
        });
      },
      onRequestSent: async () => {
        await markCodexPetImageCallSent({
          ...baseInput,
          prisma,
          runId: "run-1",
          jobKey: "look-over-limit",
          logicalAttempt: 1,
        });
      },
    })).rejects.toBeInstanceOf(CodexPetImageCallLimitError);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(calls).toHaveLength(14);
    expect(run.imageGenerationCallCount).toBe(14);
  });

  it("keeps an approved extra call outside the planned-call limit", async () => {
    const { prisma, calls, run } = createLedgerPrisma(2);
    await prepareCodexPetExtraImageCall({
      prisma,
      runId: "run-1",
      projectId: "project-1",
      userId: "user-1",
      jobKey: "base-candidate-2",
      logicalAttempt: 1,
      requestedModel: "gpt-image-2",
      resourceKey: "codex_pet_v2_package",
      points: 200,
    });
    await prepareCodexPetImageCallDispatch({ ...baseInput, prisma, runId: "run-1", jobKey: "base-candidate-2", logicalAttempt: 1 });
    await markCodexPetImageCallSent({ ...baseInput, prisma, runId: "run-1", jobKey: "base-candidate-2", logicalAttempt: 1 });

    for (const jobKey of ["row-idle", "row-waving"]) {
      await prepareCodexPetImageCallDispatch({ ...baseInput, prisma, runId: "run-1", jobKey, logicalAttempt: 1 });
      await markCodexPetImageCallSent({ ...baseInput, prisma, runId: "run-1", jobKey, logicalAttempt: 1 });
    }
    await expect(prepareCodexPetImageCallDispatch({
      ...baseInput,
      prisma,
      runId: "run-1",
      jobKey: "row-over-limit",
      logicalAttempt: 1,
    })).rejects.toBeInstanceOf(CodexPetImageCallLimitError);

    expect(run.imageGenerationCallCount).toBe(3);
    expect(calls.filter((call) => call.callKind === "planned" && call.sentAt)).toHaveLength(2);
    expect(calls.filter((call) => call.callKind === "extra" && call.sentAt)).toHaveLength(1);
  });

  it("keeps one durable failed call after a request has been sent and never dispatches its duplicate", async () => {
    const { prisma, calls, run } = createLedgerPrisma();
    await prepareCodexPetImageCallDispatch({ ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1 });
    await markCodexPetImageCallSent({ ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1 });
    await completeCodexPetImageCall({
      prisma,
      runId: "run-1",
      jobKey: "row-idle",
      logicalAttempt: 1,
      error: new Error("upstream timeout after POST"),
    });

    await expect(markCodexPetImageCallSent({
      ...baseInput,
      prisma,
      runId: "run-1",
      jobKey: "row-idle",
      logicalAttempt: 1,
    })).rejects.toBeInstanceOf(CodexPetImageCallAlreadySentError);
    expect(run.imageGenerationCallCount).toBe(1);
    expect(calls).toMatchObject([{ points: 200, status: "failed", sentAt: expect.any(Date), completedAt: expect.any(Date) }]);
  });

  it("does not count or settle a synchronous failure before fetch is invoked", async () => {
    const { prisma, calls, run } = createLedgerPrisma();
    const dispatched = vi.fn(async () => {
      await prepareCodexPetImageCallDispatch({ ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1 });
    });
    const sent = vi.fn(async () => {
      await markCodexPetImageCallSent({ ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1 });
    });
    const fetchFn = vi.fn(() => {
      throw new Error("local fetch setup failed");
    }) as unknown as typeof fetch;

    await expect(callImageGenerationDetailed({
      config: {
        endpoint: "https://pixel.example.test/v1/images/generations",
        apiKey: "test-key",
        model: "gpt-image-2",
        protocol: "openai",
      },
      prompt: "must stay local",
      size: "1024x1024",
      fetchFn,
      onRequestDispatching: dispatched,
      onRequestSent: sent,
    })).rejects.toThrow("local fetch setup failed");
    await completeCodexPetImageCall({
      prisma,
      runId: "run-1",
      jobKey: "row-idle",
      logicalAttempt: 1,
      error: new Error("local fetch setup failed"),
    });

    expect(dispatched).toHaveBeenCalledOnce();
    expect(sent).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(run.imageGenerationCallCount).toBe(0);
    expect(calls).toMatchObject([{ status: "failed", completedAt: expect.any(Date) }]);
    expect(calls[0]?.sentAt).toBeUndefined();
  });

  it("marks a call sent only after fetch has been invoked", async () => {
    let fetchInvoked = false;
    const fetchFn = vi.fn(async () => {
      fetchInvoked = true;
      throw new Error("socket closed after dispatch");
    }) as unknown as typeof fetch;
    const sent = vi.fn(async () => {
      expect(fetchInvoked).toBe(true);
    });

    await expect(callImageGenerationDetailed({
      config: {
        endpoint: "https://pixel.example.test/v1/images/generations",
        apiKey: "test-key",
        model: "gpt-image-2",
        protocol: "openai",
      },
      prompt: "record the fetch boundary",
      size: "1024x1024",
      fetchFn,
      onRequestSent: sent,
    })).rejects.toThrow("socket closed after dispatch");

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(sent).toHaveBeenCalledOnce();
  });

  it("prepares exactly one deterministic extra call for a failed job", async () => {
    const { prisma, calls } = createLedgerPrisma();
    const first = await prepareCodexPetExtraImageCall({
      prisma,
      runId: "run-1",
      projectId: "project-1",
      userId: "user-1",
      jobKey: "row-idle",
      logicalAttempt: 2,
      requestedModel: "gpt-image-2",
      resourceKey: "codex_pet_v2_package",
      points: 200,
    });
    const duplicate = await prepareCodexPetExtraImageCall({
      prisma,
      runId: "run-1",
      projectId: "project-1",
      userId: "user-1",
      jobKey: "row-idle",
      logicalAttempt: 2,
      requestedModel: "gpt-image-2",
      resourceKey: "codex_pet_v2_package",
      points: 200,
    });

    expect(first.created).toBe(true);
    expect(duplicate).toEqual({ operationId: first.operationId, created: false });
    expect(calls).toMatchObject([{ callKind: "extra", status: "prepared", units: 1 }]);
  });

  it("allows another extra attempt only under a new logical attempt", async () => {
    const { prisma, calls } = createLedgerPrisma();
    const second = await prepareCodexPetExtraImageCall({
      prisma,
      runId: "run-1",
      projectId: "project-1",
      userId: "user-1",
      jobKey: "row-running-right",
      logicalAttempt: 2,
      requestedModel: "gpt-image-2",
      resourceKey: "codex_pet_v2_package",
      points: 200,
    });
    const duplicate = await prepareCodexPetExtraImageCall({
      prisma,
      runId: "run-1",
      projectId: "project-1",
      userId: "user-1",
      jobKey: "row-running-right",
      logicalAttempt: 2,
      requestedModel: "gpt-image-2",
      resourceKey: "codex_pet_v2_package",
      points: 200,
    });
    const third = await prepareCodexPetExtraImageCall({
      prisma,
      runId: "run-1",
      projectId: "project-1",
      userId: "user-1",
      jobKey: "row-running-right",
      logicalAttempt: 3,
      requestedModel: "gpt-image-2",
      resourceKey: "codex_pet_v2_package",
      points: 200,
    });

    expect(second.created).toBe(true);
    expect(duplicate).toEqual({ operationId: second.operationId, created: false });
    expect(third.created).toBe(true);
    expect(third.operationId).not.toBe(second.operationId);
    expect(calls).toMatchObject([
      { jobKey: "row-running-right", logicalAttempt: 2, callKind: "extra", status: "prepared" },
      { jobKey: "row-running-right", logicalAttempt: 3, callKind: "extra", status: "prepared" },
    ]);
  });

  it("persists a safe transport classification with a failed call", async () => {
    const { prisma, calls } = createLedgerPrisma();
    await prepareCodexPetImageCallDispatch({ ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1 });
    await markCodexPetImageCallSent({ ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1 });
    const failure = new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } });

    await completeCodexPetImageCall({
      prisma,
      runId: "run-1",
      jobKey: "row-idle",
      logicalAttempt: 1,
      error: failure,
    });

    expect(calls).toMatchObject([{ status: "failed", error: "[network/UND_ERR_SOCKET] fetch failed" }]);
  });
});

/** One extra call already charged, at the given final status. */
async function seedExtraCall(
  prisma: PrismaClient,
  jobKey: string,
  logicalAttempt: number,
  status: string,
): Promise<void> {
  await prepareCodexPetExtraImageCall({
    prisma,
    runId: "run-1",
    projectId: "project-1",
    userId: "user-1",
    jobKey,
    logicalAttempt,
    requestedModel: "gpt-image-2",
    resourceKey: "codex_pet_v2_package",
    points: 200,
  });
  await prisma.codexPetImageCall.updateMany({
    where: { runId: "run-1", jobKey, logicalAttempt },
    data: { status, sentAt: status === "prepared" ? null : new Date() },
  });
}

/**
 * A logical attempt is the billing unit: one ledger row, one settled unit, one
 * user approval. A transport retry is the adapter re-sending that same paid unit
 * after a socket-level failure, so it must re-enter the row it already owns.
 * Getting this wrong is what made a single socket blip park the run and demand a
 * paid approval for work the user never chose to redo.
 */
describe("Codex pet transport retry inside one paid unit", () => {
  it("re-dispatches the same ledger row instead of reserving a second one", async () => {
    const { prisma, calls, run } = createLedgerPrisma(14);
    await prepareCodexPetImageCallDispatch({ ...baseInput, prisma, runId: "run-1", jobKey: "look-cardinals", logicalAttempt: 1 });
    await markCodexPetImageCallSent({ ...baseInput, prisma, runId: "run-1", jobKey: "look-cardinals", logicalAttempt: 1 });

    await prepareCodexPetImageCallDispatch({
      ...baseInput, prisma, runId: "run-1", jobKey: "look-cardinals", logicalAttempt: 1, transportAttempt: 2,
    });
    await markCodexPetImageCallSent({
      ...baseInput, prisma, runId: "run-1", jobKey: "look-cardinals", logicalAttempt: 1, transportAttempt: 2,
    });

    expect(calls).toHaveLength(1);
    // The user paid once, so the run must still read one call, not two.
    expect(run.imageGenerationCallCount).toBe(1);
  });

  it("keeps the original sentAt so the settled unit count cannot drift", async () => {
    const { prisma, calls, run } = createLedgerPrisma(14);
    await prepareCodexPetImageCallDispatch({ ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1 });
    const first = await markCodexPetImageCallSent({ ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1 });
    const originalSentAt = calls[0]!.sentAt;

    await prepareCodexPetImageCallDispatch({
      ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1, transportAttempt: 3,
    });
    const retried = await markCodexPetImageCallSent({
      ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1, transportAttempt: 3,
    });

    // `sentAt` is half of every settled-unit filter, so re-stamping it would move
    // a unit that was already counted.
    expect(calls[0]!.sentAt).toBe(originalSentAt);
    expect(run.imageGenerationCallCount).toBe(1);
    expect(retried.operationId).toBe(first.operationId);
  });

  /**
   * The row's own `sentAt` is already inside the planned count, so a naive limit
   * re-check refuses the retry of the very last planned call — the one place a
   * transport hiccup is least recoverable.
   */
  it("retries the fourteenth planned call without tripping the limit", async () => {
    const { prisma, calls, run } = createLedgerPrisma(14);
    for (let attempt = 1; attempt <= 14; attempt += 1) {
      await prepareCodexPetImageCallDispatch({ ...baseInput, prisma, runId: "run-1", jobKey: `row-${attempt}`, logicalAttempt: 1 });
      await markCodexPetImageCallSent({ ...baseInput, prisma, runId: "run-1", jobKey: `row-${attempt}`, logicalAttempt: 1 });
    }

    await expect(prepareCodexPetImageCallDispatch({
      ...baseInput, prisma, runId: "run-1", jobKey: "row-14", logicalAttempt: 1, transportAttempt: 2,
    })).resolves.toMatchObject({ callKind: "planned" });
    await expect(markCodexPetImageCallSent({
      ...baseInput, prisma, runId: "run-1", jobKey: "row-14", logicalAttempt: 1, transportAttempt: 2,
    })).resolves.toMatchObject({ callCount: 14 });
    expect(calls).toHaveLength(14);
    expect(run.imageGenerationCallCount).toBe(14);
  });

  it("still refuses to re-dispatch a unit that already reached a terminal outcome", async () => {
    const { prisma } = createLedgerPrisma(14);
    await prepareCodexPetImageCallDispatch({ ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1 });
    await markCodexPetImageCallSent({ ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1 });
    await completeCodexPetImageCall({ prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1 });

    await expect(prepareCodexPetImageCallDispatch({
      ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1, transportAttempt: 2,
    })).rejects.toBeInstanceOf(CodexPetImageCallAlreadySentError);
  });

  it("refuses a transport retry of a failed unit, which needs its own approval", async () => {
    const { prisma } = createLedgerPrisma(14);
    await prepareCodexPetImageCallDispatch({ ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1 });
    await markCodexPetImageCallSent({ ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1 });
    await completeCodexPetImageCall({ prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1, error: new Error("boom") });

    await expect(prepareCodexPetImageCallDispatch({
      ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1, transportAttempt: 2,
    })).rejects.toBeInstanceOf(CodexPetImageCallAlreadySentError);
  });

  it("treats transportAttempt 1 on an existing row as the duplicate it is", async () => {
    const { prisma } = createLedgerPrisma(14);
    await prepareCodexPetImageCallDispatch({ ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1 });
    await markCodexPetImageCallSent({ ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1 });

    await expect(prepareCodexPetImageCallDispatch({
      ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1,
    })).rejects.toBeInstanceOf(CodexPetImageCallAlreadySentError);
  });
});

describe("Codex pet extra-call budget", () => {
  it("stops approving repairs for one action once the per-job ceiling is reached", async () => {
    const { prisma } = createLedgerPrisma();
    for (let attempt = 2; attempt <= CODEX_PET_EXTRA_IMAGE_CALLS_PER_JOB_LIMIT + 1; attempt += 1) {
      await seedExtraCall(prisma, "row-running-right", attempt, "succeeded");
    }

    const budget = await codexPetExtraCallBudget({
      prisma,
      runId: "run-1",
      projectId: "project-1",
      userId: "user-1",
      jobKey: "row-running-right",
    });

    expect(budget.jobUsed).toBe(CODEX_PET_EXTRA_IMAGE_CALLS_PER_JOB_LIMIT);
    expect(budget.exhausted).toBe("job");
  });

  /**
   * The `老鼠猫` run spent 10 extra calls on a single row because each approval
   * only raised that job's own maxAttempts. A budget that only counted the run
   * total would still have allowed it.
   */
  it("would have refused the tenth repair of a single row", async () => {
    const { prisma } = createLedgerPrisma();
    let refusedAt: number | null = null;
    for (let attempt = 2; attempt <= 11; attempt += 1) {
      const budget = await codexPetExtraCallBudget({
        prisma,
        runId: "run-1",
        projectId: "project-1",
        userId: "user-1",
        jobKey: "row-running-right",
      });
      if (budget.exhausted) { refusedAt = attempt; break; }
      await seedExtraCall(prisma, "row-running-right", attempt, "succeeded");
    }

    expect(refusedAt).toBe(CODEX_PET_EXTRA_IMAGE_CALLS_PER_JOB_LIMIT + 2);
  });

  it("stops a defect that walks across actions at the per-run ceiling", async () => {
    const { prisma } = createLedgerPrisma();
    // Spread across enough distinct jobs that no single job hits its own cap.
    let seeded = 0;
    for (let job = 0; seeded < CODEX_PET_EXTRA_IMAGE_CALLS_PER_RUN_LIMIT; job += 1) {
      for (let attempt = 2; attempt <= 3 && seeded < CODEX_PET_EXTRA_IMAGE_CALLS_PER_RUN_LIMIT; attempt += 1) {
        await seedExtraCall(prisma, `row-${job}`, attempt, "succeeded");
        seeded += 1;
      }
    }

    const budget = await codexPetExtraCallBudget({
      prisma,
      runId: "run-1",
      projectId: "project-1",
      userId: "user-1",
      jobKey: "row-fresh",
    });

    expect(budget.jobUsed).toBe(0);
    expect(budget.runUsed).toBe(CODEX_PET_EXTRA_IMAGE_CALLS_PER_RUN_LIMIT);
    expect(budget.exhausted).toBe("run");
  });

  /**
   * A completed run needed 6 consecutive extras on `look-cardinals`, every one a
   * socket failure. Those are refunded, so charging them against the repair
   * budget would refuse legitimate repairs during a provider outage.
   */
  it("does not spend the budget on provider failures", async () => {
    const { prisma } = createLedgerPrisma();
    for (let attempt = 2; attempt <= 7; attempt += 1) {
      await seedExtraCall(prisma, "look-cardinals", attempt, "failed");
    }

    const budget = await codexPetExtraCallBudget({
      prisma,
      runId: "run-1",
      projectId: "project-1",
      userId: "user-1",
      jobKey: "look-cardinals",
    });

    expect(budget.jobUsed).toBe(0);
    expect(budget.exhausted).toBeNull();
  });

  it("counts an in-flight extra call so a double approval cannot slip past the cap", async () => {
    const { prisma } = createLedgerPrisma();
    await seedExtraCall(prisma, "row-idle", 2, "dispatching");

    const budget = await codexPetExtraCallBudget({
      prisma,
      runId: "run-1",
      projectId: "project-1",
      userId: "user-1",
      jobKey: "row-idle",
    });

    expect(budget.jobUsed).toBe(1);
  });
});

describe("Codex pet failed extra-call refund", () => {
  it("refunds a charged extra call that failed at the provider", async () => {
    const { prisma, calls } = createLedgerPrisma();
    await seedExtraCall(prisma, "row-idle", 2, "failed");
    const refundResource = vi.fn(async () => ({ success: true }));

    const refunded = await refundCodexPetFailedExtraCall({
      prisma,
      billing: { refundResource },
      runId: "run-1",
      jobKey: "row-idle",
      logicalAttempt: 2,
    });

    expect(refunded).toBe(true);
    expect(refundResource).toHaveBeenCalledWith("codex-pet:run:run-1:image:row-idle:2:extra");
    expect(calls).toMatchObject([{ refundStatus: "refunded" }]);
  });

  it("never refunds a call that produced an image", async () => {
    const { prisma } = createLedgerPrisma();
    await seedExtraCall(prisma, "row-idle", 2, "succeeded");
    const refundResource = vi.fn(async () => ({ success: true }));

    const refunded = await refundCodexPetFailedExtraCall({
      prisma,
      billing: { refundResource },
      runId: "run-1",
      jobKey: "row-idle",
      logicalAttempt: 2,
    });

    expect(refunded).toBe(false);
    expect(refundResource).not.toHaveBeenCalled();
  });

  /**
   * Planned calls are covered by the run reservation and drop out of the settled
   * units, so refunding them here would return points twice.
   */
  it("leaves a failed planned call to the settlement path", async () => {
    const { prisma } = createLedgerPrisma();
    await prepareCodexPetImageCallDispatch({ ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1 });
    await markCodexPetImageCallSent({ ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1 });
    await completeCodexPetImageCall({ prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1, error: new Error("boom") });
    const refundResource = vi.fn(async () => ({ success: true }));

    const refunded = await refundCodexPetFailedExtraCall({
      prisma,
      billing: { refundResource },
      runId: "run-1",
      jobKey: "row-idle",
      logicalAttempt: 1,
    });

    expect(refunded).toBe(false);
    expect(refundResource).not.toHaveBeenCalled();
  });

  it("is idempotent so a retry cannot refund twice", async () => {
    const { prisma } = createLedgerPrisma();
    await seedExtraCall(prisma, "row-idle", 2, "failed");
    const refundResource = vi.fn(async () => ({ success: true }));
    const args = { prisma, billing: { refundResource }, runId: "run-1", jobKey: "row-idle", logicalAttempt: 2 } as const;

    await refundCodexPetFailedExtraCall(args);
    const second = await refundCodexPetFailedExtraCall(args);

    expect(second).toBe(true);
    expect(refundResource).toHaveBeenCalledTimes(1);
  });

  it("records a retryable receipt when the refund call fails", async () => {
    const { prisma, calls } = createLedgerPrisma();
    await seedExtraCall(prisma, "row-idle", 2, "failed");
    const refundResource = vi.fn(async () => { throw new Error("billing down"); });

    const refunded = await refundCodexPetFailedExtraCall({
      prisma,
      billing: { refundResource },
      runId: "run-1",
      jobKey: "row-idle",
      logicalAttempt: 2,
    });

    expect(refunded).toBe(false);
    expect(calls[0]).toMatchObject({ refundStatus: "pending" });
    expect(String(calls[0]!.refundError)).toContain("billing down");
  });

  it("treats a rejected refund as unfinished rather than done", async () => {
    const { prisma, calls } = createLedgerPrisma();
    await seedExtraCall(prisma, "row-idle", 2, "failed");
    const refundResource = vi.fn(async () => ({ success: false }));

    const refunded = await refundCodexPetFailedExtraCall({
      prisma,
      billing: { refundResource },
      runId: "run-1",
      jobKey: "row-idle",
      logicalAttempt: 2,
    });

    expect(refunded).toBe(false);
    expect(calls[0]).toMatchObject({ refundStatus: "pending" });
  });
});

/**
 * An extra call is charged at approval; the failed-call refund is attached to the
 * provider outcome. A run cancelled between those two points leaves a `prepared`
 * row that neither predicate covers, so its points stayed in the system.
 */
describe("Codex pet undispatched extra-call refund", () => {
  const refundArgs = { runId: "run-1", projectId: "project-1", userId: "user-1" } as const;

  it("returns points charged at approval for a call that never left the process", async () => {
    const { prisma, calls } = createLedgerPrisma();
    await seedExtraCall(prisma, "row-idle", 2, "prepared");
    const refundResource = vi.fn(async () => ({ success: true }));

    const result = await refundCodexPetUndispatchedExtraCalls({ ...refundArgs, prisma, billing: { refundResource } });

    expect(result).toEqual({ refunded: 1, pending: 0 });
    expect(refundResource).toHaveBeenCalledWith("codex-pet:run:run-1:image:row-idle:2:extra");
    // Kept as "charged and returned"; `cancelled` would deny the charge happened.
    expect(calls[0]).toMatchObject({ refundStatus: "refunded" });
  });

  it("leaves a dispatched call to its own provider outcome", async () => {
    const { prisma } = createLedgerPrisma();
    await seedExtraCall(prisma, "row-sent", 2, "sent");
    await seedExtraCall(prisma, "row-done", 2, "succeeded");
    await seedExtraCall(prisma, "row-failed", 2, "failed");
    const refundResource = vi.fn(async () => ({ success: true }));

    const result = await refundCodexPetUndispatchedExtraCalls({ ...refundArgs, prisma, billing: { refundResource } });

    expect(result).toEqual({ refunded: 0, pending: 0 });
    expect(refundResource).not.toHaveBeenCalled();
  });

  it("never touches the planned reservation, which the settle path owns", async () => {
    const { prisma } = createLedgerPrisma();
    await prepareCodexPetImageCallDispatch({ ...baseInput, prisma, runId: "run-1", jobKey: "row-idle", logicalAttempt: 1 });
    const refundResource = vi.fn(async () => ({ success: true }));

    const result = await refundCodexPetUndispatchedExtraCalls({ ...refundArgs, prisma, billing: { refundResource } });

    expect(result).toEqual({ refunded: 0, pending: 0 });
    expect(refundResource).not.toHaveBeenCalled();
  });

  it("is idempotent so a retried cancellation cannot refund twice", async () => {
    const { prisma } = createLedgerPrisma();
    await seedExtraCall(prisma, "row-idle", 2, "prepared");
    const refundResource = vi.fn(async () => ({ success: true }));

    const first = await refundCodexPetUndispatchedExtraCalls({ ...refundArgs, prisma, billing: { refundResource } });
    const second = await refundCodexPetUndispatchedExtraCalls({ ...refundArgs, prisma, billing: { refundResource } });

    expect(first.refunded).toBe(1);
    expect(second.refunded).toBe(0);
    expect(refundResource).toHaveBeenCalledTimes(1);
  });

  it("reports a failed refund as pending rather than swallowing it", async () => {
    const { prisma, calls } = createLedgerPrisma();
    await seedExtraCall(prisma, "row-idle", 2, "prepared");
    const onError = vi.fn();
    const refundResource = vi.fn(async () => { throw new Error("billing down"); });

    const result = await refundCodexPetUndispatchedExtraCalls({
      ...refundArgs, prisma, billing: { refundResource }, onError,
    });

    expect(result).toEqual({ refunded: 0, pending: 1 });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ refundStatus: "pending" });
    expect(String(calls[0]!.refundError)).toContain("billing down");
  });

  it("refunds every undispatched extra of a run in one sweep", async () => {
    const { prisma } = createLedgerPrisma();
    await seedExtraCall(prisma, "row-idle", 2, "prepared");
    await seedExtraCall(prisma, "row-walk-left", 3, "prepared");
    await seedExtraCall(prisma, "look-cardinals", 2, "sent");
    const refundResource = vi.fn(async () => ({ success: true }));

    const result = await refundCodexPetUndispatchedExtraCalls({ ...refundArgs, prisma, billing: { refundResource } });

    expect(result).toEqual({ refunded: 2, pending: 0 });
    expect(refundResource).toHaveBeenCalledTimes(2);
  });
});
