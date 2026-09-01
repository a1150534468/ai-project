import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  activateChargedCodexPetRun,
  codexPetBillingBlocksProjectDeletion,
  CodexPetBillingRunNotFoundError,
  codexPetPendingBillingFields,
  listCodexPetBillingReconciliationCandidates,
  reconcileCodexPetRunBilling,
  releaseDefinitelyUnchargedCodexPetRun,
} from "./codex-pet-billing.js";
import { CODEX_PET_PER_IMAGE_BILLING_MODE } from "./codex-pet-call-ledger.js";

const BILLING_SCOPE = {
  runId: "run-1",
  userId: "user-1",
  projectId: "project-1",
} as const;

type Row = Record<string, any>;

function matches(value: unknown, condition: unknown): boolean {
  if (condition === null || typeof condition !== "object" || condition instanceof Date) {
    return value === condition;
  }
  const rule = condition as Row;
  if ("in" in rule && !rule.in.includes(value)) return false;
  if ("not" in rule && value === rule.not) return false;
  if ("lte" in rule && (!(value instanceof Date) || value > rule.lte)) return false;
  if ("lt" in rule && (!(value instanceof Date) || value >= rule.lt)) return false;
  if ("gte" in rule && (!(value instanceof Date) || value < rule.gte)) return false;
  return true;
}

function rowMatches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  if (where.OR && !(where.OR as Row[]).some((part) => rowMatches(row, part))) return false;
  if (where.AND && !(where.AND as Row[]).every((part) => rowMatches(row, part))) return false;
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR" || key === "AND") return true;
    return matches(row[key], condition);
  });
}

function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && !(value instanceof Date) && "increment" in value) {
      row[key] = (row[key] ?? 0) + value.increment;
    } else {
      row[key] = value;
    }
  }
  row.updatedAt = new Date();
}

function runRow(overrides: Row = {}): Row {
  const createdAt = new Date("2026-07-18T01:00:00.000Z");
  return {
    id: "run-1",
    projectId: "project-1",
    userId: "user-1",
    idempotencyKey: "start-0001",
    inputSnapshot: {},
    autoContinue: false,
    colorKey: null,
    ...codexPetPendingBillingFields("codex-pet:run-1"),
    billingRefundedAt: null,
    billingRefundStatus: "none",
    billingRefundError: null,
    billingRefundRetryCount: 0,
    billingRefundLastAttemptAt: null,
    billingRefundNextRetryAt: null,
    cancelRequested: false,
    hasSuccessfulImage: false,
    selectedBaseArtifactId: null,
    spritesheetArtifactId: null,
    packageArtifactId: null,
    previewArtifactId: null,
    validationReport: null,
    requestedModel: "gpt-image-2",
    actualModels: [],
    usage: null,
    lastEventSequence: 0,
    workerId: null,
    heartbeatAt: null,
    completedAt: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function projectRow(overrides: Row = {}): Row {
  return {
    id: "project-1",
    userId: "user-1",
    name: "Saga Pet",
    description: "",
    prompt: "small robot",
    stylePreset: "pixel",
    styleNotes: "",
    referenceAssetIds: [],
    autoContinue: true,
    status: "draft",
    latestRunId: null,
    createIdempotencyKey: null,
    createdAt: new Date("2026-07-18T00:00:00.000Z"),
    updatedAt: new Date("2026-07-18T00:00:00.000Z"),
    ...overrides,
  };
}

function createMemoryPrisma(input: { run?: Row; project?: Row } = {}) {
  const state = {
    runs: [input.run ?? runRow()],
    projects: [input.project ?? projectRow()],
    events: [] as Row[],
    transactionDepth: 0,
    failNextTransactionAfterWork: false,
  };
  let transactionTail = Promise.resolve();

  const prisma: Row = {
    codexPetRun: {
      findUnique: async ({ where, include }: Row) => {
        const run = state.runs.find((item) => rowMatches(item, where));
        if (!run) return null;
        const project = state.projects.find((item) => item.id === run.projectId);
        return include?.project
          ? { ...run, project: { status: project?.status, userId: project?.userId } }
          : { ...run };
      },
      findMany: async ({ where, orderBy, take }: Row) => {
        let rows = state.runs.filter((item) => rowMatches(item, where));
        if (orderBy?.updatedAt === "asc") rows = rows.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
        return rows.slice(0, take ?? rows.length).map((row) => ({
          id: row.id,
          userId: row.userId,
          projectId: row.projectId,
        }));
      },
      updateMany: async ({ where, data }: Row) => {
        const rows = state.runs.filter((item) => rowMatches(item, where));
        rows.forEach((row) => applyData(row, data));
        return { count: rows.length };
      },
      update: async ({ where, data }: Row) => {
        const row = state.runs.find((item) => rowMatches(item, where));
        if (!row) throw new Error("run not found");
        applyData(row, data);
        return { ...row };
      },
    },
    codexPetProject: {
      findUnique: async ({ where }: Row) => {
        const row = state.projects.find((item) => rowMatches(item, where));
        return row ? { ...row } : null;
      },
      updateMany: async ({ where, data }: Row) => {
        const rows = state.projects.filter((item) => rowMatches(item, where));
        rows.forEach((row) => applyData(row, data));
        return { count: rows.length };
      },
      update: async ({ where, data }: Row) => {
        const row = state.projects.find((item) => rowMatches(item, where));
        if (!row) throw new Error("project not found");
        applyData(row, data);
        return { ...row };
      },
    },
    codexPetEvent: {
      findFirst: async ({ where }: Row) => {
        const row = state.events.find((item) => rowMatches(item, where));
        return row ? { ...row } : null;
      },
      create: async ({ data }: Row) => {
        if (state.events.some((item) => item.runId === data.runId && item.sequence === data.sequence)) {
          throw new Error("unique event sequence");
        }
        const row = { id: `event-${state.events.length + 1}`, createdAt: new Date(), ...data };
        state.events.push(row);
        return { ...row };
      },
    },
    $queryRawUnsafe: async () => [],
    $transaction: async (work: (tx: Row) => Promise<unknown>) => {
      let release!: () => void;
      const previous = transactionTail;
      transactionTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const snapshot = structuredClone({
        runs: state.runs,
        projects: state.projects,
        events: state.events,
      });
      state.transactionDepth += 1;
      try {
        const result = await work(prisma);
        if (state.failNextTransactionAfterWork) {
          state.failNextTransactionAfterWork = false;
          throw new Error("synthetic activation finalize failure");
        }
        return result;
      } catch (error) {
        state.runs = snapshot.runs;
        state.projects = snapshot.projects;
        state.events = snapshot.events;
        throw error;
      } finally {
        state.transactionDepth -= 1;
        release();
      }
    },
  };
  return { prisma: prisma as unknown as PrismaClient, state };
}

function mutableClock(initial = "2026-07-18T02:00:00.000Z") {
  let value = new Date(initial);
  return {
    now: () => new Date(value),
    advance(ms: number) { value = new Date(value.getTime() + ms); },
  };
}

describe("Codex pet durable billing saga", () => {
  it.each([
    { userId: "other-user", projectId: "project-1" },
    { userId: "user-1", projectId: "other-project" },
  ])("rejects a billing coordinator scope that does not own the run", async (scope) => {
    const { prisma, state } = createMemoryPrisma();
    const chargeResource = vi.fn(async () => ({ charged: 200 }));

    await expect(reconcileCodexPetRunBilling({
      prisma,
      billing: { chargeResource },
      runId: "run-1",
      ...scope,
    })).rejects.toBeInstanceOf(CodexPetBillingRunNotFoundError);
    expect(chargeResource).not.toHaveBeenCalled();
    expect(state.runs[0]).toMatchObject({
      billingChargeStatus: "pending",
      billingChargeAttemptCount: 0,
    });
  });

  it("refuses to charge a run whose denormalized owner does not match its project", async () => {
    const { prisma } = createMemoryPrisma({
      run: runRow({ userId: "user-1" }),
      project: projectRow({ userId: "other-user" }),
    });
    const chargeResource = vi.fn(async () => ({ charged: 200 }));

    await expect(reconcileCodexPetRunBilling({ prisma, billing: { chargeResource }, ...BILLING_SCOPE }))
      .rejects.toThrow("ownership mismatch");
    expect(chargeResource).not.toHaveBeenCalled();
  });

  it("persists a pending intent shape and performs the external charge outside every DB transaction", async () => {
    const { prisma, state } = createMemoryPrisma();
    const chargeResource = vi.fn(async () => {
      expect(state.transactionDepth).toBe(0);
      expect(state.runs[0]!.billingChargeStatus).toBe("charging");
      return { charged: 200 };
    });

    const result = await reconcileCodexPetRunBilling({ prisma, billing: { chargeResource }, ...BILLING_SCOPE });

    expect(result).toMatchObject({ outcome: "activated", chargeStatus: "charged", shouldEnqueue: true, chargedPoints: 200 });
    expect(state.runs[0]).toMatchObject({ status: "queued", billingChargeAttemptCount: 1, billingPoints: 200 });
    expect(state.projects[0]).toMatchObject({ latestRunId: "run-1", status: "queued" });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ type: "run.queued", sequence: 1 });
  });

  it("recovers when charging succeeds but the DB activation finalize fails", async () => {
    const { prisma, state } = createMemoryPrisma();
    const clock = mutableClock();
    const ledger = new Map<string, number>();
    const chargeResource = vi.fn(async ({ operationId }: { operationId: string }) => {
      if (!ledger.has(operationId)) ledger.set(operationId, 200);
      return { charged: ledger.get(operationId)! };
    });
    state.failNextTransactionAfterWork = true;

    const first = await reconcileCodexPetRunBilling({
      prisma,
      billing: { chargeResource },
      ...BILLING_SCOPE,
      now: clock.now,
      retryBaseMs: 1_000,
    });
    expect(first).toMatchObject({ outcome: "uncertain", chargeStatus: "uncertain", shouldEnqueue: false });
    expect(state.events).toHaveLength(0);
    expect(ledger.size).toBe(1);

    clock.advance(1_001);
    const recovered = await reconcileCodexPetRunBilling({
      prisma,
      billing: { chargeResource },
      ...BILLING_SCOPE,
      now: clock.now,
      retryBaseMs: 1_000,
    });
    expect(recovered).toMatchObject({ outcome: "activated", shouldEnqueue: true });
    expect(chargeResource).toHaveBeenCalledTimes(2);
    expect(new Set(chargeResource.mock.calls.map(([call]) => call.operationId))).toEqual(new Set(["codex-pet:run-1"]));
    expect(ledger.size).toBe(1);
    expect(state.events).toHaveLength(1);
  });

  it("converges after a timeout whose operation was actually charged", async () => {
    const { prisma, state } = createMemoryPrisma();
    const clock = mutableClock();
    const ledger = new Map<string, number>();
    let first = true;
    const chargeResource = vi.fn(async ({ operationId }: { operationId: string }) => {
      if (!ledger.has(operationId)) ledger.set(operationId, 200);
      if (first) {
        first = false;
        throw new Error("upstream timeout after commit");
      }
      return { charged: ledger.get(operationId)! };
    });

    const timedOut = await reconcileCodexPetRunBilling({
      prisma,
      billing: { chargeResource },
      ...BILLING_SCOPE,
      now: clock.now,
      retryBaseMs: 1_000,
    });
    expect(timedOut).toMatchObject({ outcome: "uncertain", chargeStatus: "uncertain" });
    expect(ledger.size).toBe(1);

    clock.advance(1_001);
    const recovered = await reconcileCodexPetRunBilling({
      prisma,
      billing: { chargeResource },
      ...BILLING_SCOPE,
      now: clock.now,
      retryBaseMs: 1_000,
    });
    expect(recovered.outcome).toBe("activated");
    expect(ledger.size).toBe(1);
    expect(state.events).toHaveLength(1);
  });

  it("leases a concurrent reconcile so only one caller charges and only one queued event exists", async () => {
    const { prisma, state } = createMemoryPrisma();
    let releaseCharge!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseCharge = resolve; });
    const chargeResource = vi.fn(async () => {
      signalStarted();
      await release;
      return { charged: 200 };
    });

    const first = reconcileCodexPetRunBilling({ prisma, billing: { chargeResource }, ...BILLING_SCOPE });
    await started;
    const concurrent = await reconcileCodexPetRunBilling({ prisma, billing: { chargeResource }, ...BILLING_SCOPE });
    expect(concurrent).toMatchObject({ outcome: "charging", shouldEnqueue: false });
    releaseCharge();
    const completed = await first;

    expect(completed).toMatchObject({ outcome: "activated", shouldEnqueue: true });
    expect(chargeResource).toHaveBeenCalledTimes(1);
    expect(state.events).toHaveLength(1);

    const replay = await activateChargedCodexPetRun({ prisma, ...BILLING_SCOPE, chargedPoints: 200 });
    expect(replay).toMatchObject({ outcome: "activated", shouldEnqueue: true });
    expect(state.events).toHaveLength(1);
  });

  it("does not let a late expired-lease error overwrite a newer successful reconcile", async () => {
    const { prisma, state } = createMemoryPrisma();
    const clock = mutableClock();
    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const chargeResource = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        signalFirst();
        await firstRelease;
        throw new Error("late timeout from expired lease");
      }
      return { charged: 200 };
    });

    const stale = reconcileCodexPetRunBilling({
      prisma,
      billing: { chargeResource },
      ...BILLING_SCOPE,
      now: clock.now,
      chargeLeaseMs: 1_000,
    });
    await firstStarted;
    clock.advance(1_001);
    const recovered = await reconcileCodexPetRunBilling({
      prisma,
      billing: { chargeResource },
      ...BILLING_SCOPE,
      now: clock.now,
      chargeLeaseMs: 1_000,
    });
    expect(recovered).toMatchObject({ outcome: "activated", chargeStatus: "charged" });

    releaseFirst();
    const staleResult = await stale;
    expect(staleResult).toMatchObject({ outcome: "activated", chargeStatus: "charged" });
    expect(state.events).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({ billingChargeStatus: "charged", billingChargeAttemptCount: 2 });
  });

  it("turns a cancellation/deletion race after charge into a durable refund and never activates", async () => {
    const { prisma, state } = createMemoryPrisma();
    let releaseCharge!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseCharge = resolve; });
    const chargeResource = vi.fn(async () => {
      signalStarted();
      await release;
      return { charged: 200 };
    });

    const reconciling = reconcileCodexPetRunBilling({ prisma, billing: { chargeResource }, ...BILLING_SCOPE });
    await started;
    state.runs[0]!.cancelRequested = true;
    state.runs[0]!.status = "cancelled";
    // Simulate an unsafe early refund attempt while the charge was still in
    // flight. The late receipt must reopen the refund instead of trusting it.
    state.runs[0]!.billingRefundedAt = new Date("2026-07-18T02:00:00.000Z");
    state.runs[0]!.billingRefundStatus = "refunded";
    state.projects[0]!.status = "deleting";
    releaseCharge();
    const result = await reconciling;

    expect(result).toMatchObject({ outcome: "refund_pending", shouldEnqueue: false, refundPending: true });
    expect(state.runs[0]).toMatchObject({ billingChargeStatus: "charged", billingRefundStatus: "pending", billingRefundedAt: null, status: "cancelled" });
    expect(state.projects[0]).toMatchObject({ status: "deleting", latestRunId: null });
    expect(state.events).toHaveLength(0);
    expect(codexPetBillingBlocksProjectDeletion(state.runs[0]! as {
      billingChargeStatus: string;
      billingActivatedAt: Date | null;
      billingRefundedAt: Date | null;
      billingRefundStatus: string;
    })).toBe(true);
  });

  it("parks a definite insufficient intent outside active states and can explicitly revive the same idempotent run", async () => {
    const { prisma, state } = createMemoryPrisma();
    let funded = false;
    const chargeResource = vi.fn(async () => {
      if (!funded) {
        const error = new Error("余额不足");
        error.name = "InsufficientBalanceError";
        throw error;
      }
      return { charged: 200 };
    });

    const insufficient = await reconcileCodexPetRunBilling({ prisma, billing: { chargeResource }, ...BILLING_SCOPE });
    expect(insufficient).toMatchObject({ outcome: "insufficient", chargeStatus: "insufficient", shouldEnqueue: false });
    expect(state.runs[0]).toMatchObject({ status: "cancelled", progressStage: "cancelled" });
    expect(state.projects[0]).toMatchObject({ status: "draft", latestRunId: null });

    funded = true;
    const revived = await reconcileCodexPetRunBilling({
      prisma,
      billing: { chargeResource },
      ...BILLING_SCOPE,
      retryInsufficient: true,
    });
    expect(revived).toMatchObject({ outcome: "activated", shouldEnqueue: true });
    expect(state.events).toHaveLength(1);
  });

  it("conditionally releases a never-charged pending run without deleting its audit record", async () => {
    const { prisma, state } = createMemoryPrisma();
    expect(state.runs[0]!.status).toBe("queued");
    await expect(releaseDefinitelyUnchargedCodexPetRun({ prisma, ...BILLING_SCOPE })).resolves.toBe(true);
    expect(state.runs[0]).toMatchObject({ status: "cancelled", billingChargeStatus: "cancelled" });
    await expect(releaseDefinitelyUnchargedCodexPetRun({ prisma, ...BILLING_SCOPE })).resolves.toBe(false);
  });

  it("lists only due or expired reconciliation work", async () => {
    const { prisma, state } = createMemoryPrisma();
    const at = new Date("2026-07-18T05:00:00.000Z");
    state.runs.push(runRow({
      id: "run-future",
      billingOperationId: "codex-pet:run-future",
      billingChargeStatus: "uncertain",
      billingChargeNextRetryAt: new Date(at.getTime() + 60_000),
    }));
    const candidates = await listCodexPetBillingReconciliationCandidates({ prisma, now: at });
    expect(candidates).toEqual([BILLING_SCOPE]);
  });

  it("does not send per-image reservations through the legacy package reconciler", async () => {
    const { prisma, state } = createMemoryPrisma();
    state.runs.push(runRow({
      id: "per-image-pending",
      billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
      billingOperationId: "codex-pet:run:per-image-pending:planned-images",
      billingChargeStatus: "uncertain",
      billingActivatedAt: null,
    }));

    await expect(listCodexPetBillingReconciliationCandidates({ prisma })).resolves.toEqual([BILLING_SCOPE]);
  });
});
