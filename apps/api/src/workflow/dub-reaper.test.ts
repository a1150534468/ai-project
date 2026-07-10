import { describe, it, expect, vi } from "vitest";
import { reapStaleSkyhumanTasks } from "./dub-reaper.js";

describe("dub-reaper", () => {
  it("已提交（有 providerTaskId）的超期任务调用 finalize", async () => {
    const prisma = { skyhumanTask: { findMany: vi.fn().mockResolvedValue([{ id: "t1", operationId: "op1", providerTaskId: "p1" }, { id: "t2", operationId: "op2", providerTaskId: "p2" }]) } } as any;
    const finalize = vi.fn().mockResolvedValue(undefined);
    const n = await reapStaleSkyhumanTasks({ prisma, cfg: {} as any, fetchFn: vi.fn(), billing: {} as any, storeVideo: vi.fn(), staleMs: 90_000, finalize });
    expect(n).toBe(2);
    expect(finalize).toHaveBeenCalledTimes(2);
  });

  it("未提交（providerTaskId=null）的超期任务：退款 + 置失败，不调 finalize", async () => {
    const prisma = {
      skyhumanTask: {
        findMany: vi.fn().mockResolvedValue([{ id: "t3", operationId: "op3", providerTaskId: null }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as any;
    const billing = { refundResource: vi.fn().mockResolvedValue({ success: true }) } as any;
    const finalize = vi.fn();
    await reapStaleSkyhumanTasks({ prisma, cfg: {} as any, fetchFn: vi.fn(), billing, storeVideo: vi.fn(), staleMs: 90_000, finalize });
    expect(billing.refundResource).toHaveBeenCalledWith("op3");
    expect(prisma.skyhumanTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }));
    expect(finalize).not.toHaveBeenCalled();
  });

  it("只扫 running + 超期（不再过滤 providerTaskId）", async () => {
    const prisma = { skyhumanTask: { findMany: vi.fn().mockResolvedValue([]) } } as any;
    await reapStaleSkyhumanTasks({ prisma, cfg: {} as any, fetchFn: vi.fn(), billing: {} as any, storeVideo: vi.fn(), staleMs: 90_000, finalize: vi.fn() });
    const where = prisma.skyhumanTask.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("running");
    expect(where.updatedAt.lt).toBeInstanceOf(Date);
    expect(where.providerTaskId).toBeUndefined();
  });
});
