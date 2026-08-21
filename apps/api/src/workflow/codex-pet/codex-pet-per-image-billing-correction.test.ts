import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { CODEX_PET_PER_IMAGE_BILLING_MODE } from "./codex-pet-call-ledger.js";
import {
  codexPetPerImageBillingCorrectionOperationId,
  correctCodexPetPerImageBilling,
} from "./codex-pet-per-image-billing-correction.js";

function createPrisma(status = "failed") {
  const run: Record<string, unknown> = {
    id: "run-1",
    projectId: "project-1",
    userId: "user-1",
    status,
    workerId: null,
    cancelRequested: false,
    billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
    billingOperationId: "codex-pet:run:run-1:planned-images",
    billingResourceKey: "codex_pet_v2_package",
    billingSettlementStatus: "settled",
    billingSettledPoints: 200,
    billingSettledUnits: 2,
    billingPoints: 200,
    usage: null,
    lastEventSequence: 4,
  };
  const calls: Record<string, unknown>[] = [
    { id: "call-1", runId: "run-1", callKind: "planned", sentAt: new Date("2026-07-24T00:00:00.000Z"), points: 0 },
    { id: "call-2", runId: "run-1", callKind: "planned", sentAt: new Date("2026-07-24T00:00:01.000Z"), points: 0 },
  ];
  const events: Record<string, unknown>[] = [];
  const prisma: Record<string, any> = {
    $queryRawUnsafe: vi.fn(async () => [{ id: run.id }]),
    $transaction: async (work: (tx: typeof prisma) => Promise<unknown>) => work(prisma),
    codexPetRun: {
      findFirst: vi.fn(async () => ({ ...run })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        for (const [key, value] of Object.entries(data)) {
          run[key] = value && typeof value === "object" && "increment" in value
            ? Number(run[key] ?? 0) + Number((value as { increment: number }).increment)
            : value;
        }
        return { ...run };
      }),
    },
    codexPetImageCall: {
      findMany: vi.fn(async () => calls.map((call) => ({ id: call.id, points: call.points }))),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const matching = calls.filter((call) => call.runId === where.runId && call.callKind === where.callKind && call.sentAt && call.points === where.points);
        matching.forEach((call) => Object.assign(call, data));
        return { count: matching.length };
      }),
    },
    codexPetEvent: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { events.push(data); return data; }) },
  };
  return { prisma: prisma as unknown as PrismaClient, run, calls, events };
}

describe("Codex pet per-image billing correction", () => {
  it("corrects a prematurely settled terminal run once without creating an image call", async () => {
    const { prisma, run, calls, events } = createPrisma();
    const chargeResource = vi.fn(async () => ({ charged: 200 }));

    const result = await correctCodexPetPerImageBilling({
      prisma,
      billing: { chargeResource },
      runId: "run-1",
      perImageCallPoints: 200,
      now: () => new Date("2026-07-24T01:00:00.000Z"),
    });

    expect(result).toMatchObject({ status: "corrected", ledgerPoints: 400, correctionPoints: 200, settledPoints: 400 });
    expect(chargeResource).toHaveBeenCalledWith({
      operationId: codexPetPerImageBillingCorrectionOperationId("run-1", 400),
      userId: "user-1",
      resourceKey: "codex_pet_v2_package",
      units: 1,
    });
    expect(calls.map((call) => call.points)).toEqual([200, 200]);
    expect(run).toMatchObject({ billingSettledPoints: 400, billingPoints: 400, billingSettledUnits: 2 });
    expect(events).toHaveLength(1);

    await expect(correctCodexPetPerImageBilling({
      prisma,
      billing: { chargeResource },
      runId: "run-1",
      perImageCallPoints: 200,
    })).resolves.toMatchObject({ status: "already_corrected", settledPoints: 400 });
    expect(chargeResource).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
  });

  it("refuses a nonterminal run before contacting billing", async () => {
    const { prisma } = createPrisma("standard_generating");
    const chargeResource = vi.fn(async () => ({ charged: 200 }));

    await expect(correctCodexPetPerImageBilling({
      prisma,
      billing: { chargeResource },
      runId: "run-1",
      perImageCallPoints: 200,
    })).rejects.toThrow("settled terminal per-image");
    expect(chargeResource).not.toHaveBeenCalled();
  });
});
