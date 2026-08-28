import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { settlePerImageRunBilling } from "./runner-billing.js";
import { CODEX_PET_PER_IMAGE_BILLING_MODE } from "../codex-pet-call-ledger.js";

const SCOPE = { runId: "run-1", projectId: "project-1", userId: "user-1" } as const;

function harness(input: { readonly sentCalls: number; readonly settled: number; readonly reservedPoints: number }) {
  const updates: Record<string, any>[] = [];
  const prisma = {
    codexPetRun: {
      findFirst: vi.fn(async () => ({
        id: SCOPE.runId,
        projectId: SCOPE.projectId,
        userId: SCOPE.userId,
        billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
        billingSettlementStatus: "reserved",
        billingOperationId: `codex-pet:run:${SCOPE.runId}:planned-images`,
        billingResourceKey: "codex_pet_v2_package",
        billingReservedPoints: input.reservedPoints,
      })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        updates.push(data);
        return { count: 1 };
      }),
    },
    codexPetImageCall: { count: vi.fn(async () => input.sentCalls) },
  } as unknown as PrismaClient;
  const settleResource = vi.fn(async () => ({ settled: input.settled }));
  return { prisma, settleResource, updates };
}

describe("settlePerImageRunBilling 漏计费留痕", () => {
  it("交付了真实调用却结算到 0 时记下 billingChargeError（预留已被提前关账）", async () => {
    const { prisma, settleResource, updates } = harness({ sentCalls: 8, settled: 0, reservedPoints: 2800 });

    await settlePerImageRunBilling({ prisma, billing: { settleResource } as any, ...SCOPE });

    expect(settleResource).toHaveBeenCalledWith(expect.objectContaining({ units: 8 }));
    // 仍然置 settled：纠正工具只认终态且 settled 的运行，否则补收无从下手。
    expect(updates[0]).toMatchObject({
      billingSettledUnits: 8,
      billingSettledPoints: 0,
      billingSettlementStatus: "settled",
    });
    expect(String(updates[0]?.billingChargeError)).toContain("8");
    expect(String(updates[0]?.billingChargeError)).toContain("2800");
  });

  it("正常结算不写 billingChargeError", async () => {
    const { prisma, settleResource, updates } = harness({ sentCalls: 8, settled: 1600, reservedPoints: 2800 });

    await settlePerImageRunBilling({ prisma, billing: { settleResource } as any, ...SCOPE });

    expect(updates[0]).toMatchObject({ billingSettledUnits: 8, billingSettledPoints: 1600 });
    expect(updates[0]).not.toHaveProperty("billingChargeError");
  });

  it("一次都没交付时结算 0 是正确结果，不留痕", async () => {
    const { prisma, settleResource, updates } = harness({ sentCalls: 0, settled: 0, reservedPoints: 2800 });

    await settlePerImageRunBilling({ prisma, billing: { settleResource } as any, ...SCOPE });

    expect(updates[0]).toMatchObject({ billingSettledUnits: 0, billingSettledPoints: 0 });
    expect(updates[0]).not.toHaveProperty("billingChargeError");
  });
});
