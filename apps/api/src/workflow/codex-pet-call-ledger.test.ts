import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  CODEX_PET_PER_IMAGE_BILLING_MODE,
  CodexPetImageCallAlreadySentError,
  CodexPetImageCallLimitError,
  completeCodexPetImageCall,
  markCodexPetImageCallSent,
  prepareCodexPetImageCallDispatch,
  prepareCodexPetExtraImageCall,
} from "./codex-pet-call-ledger.js";
import { callImageGenerationDetailed } from "./image-service.js";

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
      count: async ({ where }: { where: Record<string, unknown> }) => calls.filter((call) => (
        call.runId === where.runId
        && call.projectId === where.projectId
        && call.userId === where.userId
        && call.callKind === where.callKind
        && call.status === where.status
      )).length,
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
        const matched = calls.filter((call) => call.runId === where.runId
          && call.jobKey === where.jobKey
          && call.logicalAttempt === where.logicalAttempt);
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
});
