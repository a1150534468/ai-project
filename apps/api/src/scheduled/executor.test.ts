import { describe, it, expect, vi } from "vitest";
import { InsufficientBalanceError } from "@yc/billing";
import { runScheduledTask } from "./executor.js";

function makeDeps(taskOver: Record<string, unknown> = {}) {
  const runs: any[] = [];
  const emails: any[] = [];
  const task = {
    id: "t1", userId: "u1", title: "T", prompt: "p", model: "m",
    agentId: null, kbIds: null, deviceId: null, emailTo: "a@b.com", ...taskOver,
  };
  const prisma = {
    scheduledTask: {
      findUnique: vi.fn().mockResolvedValue(task),
      update: vi.fn().mockResolvedValue({}),
    },
    scheduledTaskRun: {
      create: vi.fn().mockImplementation(({ data }: any) => {
        const row = { id: "r" + runs.length, startedAt: new Date("2026-07-09T00:00:00Z"), ...data };
        runs.push(row); return Promise.resolve(row);
      }),
      update: vi.fn().mockImplementation(({ where, data }: any) => {
        const row = runs.find((r) => r.id === where.id); Object.assign(row, data); return Promise.resolve(row);
      }),
    },
    device: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  const redis = { set: vi.fn().mockResolvedValue("OK"), del: vi.fn().mockResolvedValue(1) };
  const billing = { reserve: vi.fn().mockResolvedValue({ reserved: 10 }), settle: vi.fn().mockResolvedValue({ settled: 5 }) };
  const emailSender = { send: vi.fn().mockImplementation((m: any) => { emails.push(m); return Promise.resolve({ ok: true }); }) };
  const runAgent = vi.fn().mockResolvedValue({ text: "done", toolCalls: 1, inputTokens: 10, outputTokens: 20 });
  const deps = { prisma, redis, billing, emailSender, runAgent, now: () => new Date("2026-07-09T00:00:10Z") };
  return { deps, runs, emails, prisma, redis, billing, emailSender, runAgent };
}

describe("runScheduledTask", () => {
  it("正常：reserve→runAgent→settle→success，发邮件，释放 active", async () => {
    const t = makeDeps();
    await runScheduledTask(t.deps as any, "t1", "2026-07-09T00:00:00.000Z");
    expect(t.billing.reserve).toHaveBeenCalledOnce();
    expect(t.runAgent).toHaveBeenCalledOnce();
    expect(t.billing.settle).toHaveBeenCalledOnce();
    const last = t.runs[t.runs.length - 1];
    expect(last.status).toBe("success");
    expect(last.emailStatus).toBe("sent");
    expect(t.redis.del).toHaveBeenCalled();
  });

  it("emailTo 为空 → 成功但跳过发邮件（emailStatus=skipped_no_config，不调 send）", async () => {
    const t = makeDeps({ emailTo: "" });
    await runScheduledTask(t.deps as any, "t1", "2026-07-09T00:00:00.000Z");
    const last = t.runs[t.runs.length - 1];
    expect(last.status).toBe("success");
    expect(last.emailStatus).toBe("skipped_no_config");
    expect(t.emails.length).toBe(0);
  });

  it("active 抢锁失败 → skipped prev_running，不 reserve", async () => {
    const t = makeDeps();
    t.redis.set.mockResolvedValueOnce(null);
    await runScheduledTask(t.deps as any, "t1", "2026-07-09T00:00:00.000Z");
    expect(t.billing.reserve).not.toHaveBeenCalled();
    expect(t.runs[t.runs.length - 1].skipReason).toBe("prev_running");
  });

  it("绑定设备离线 → skipped device_offline，不 reserve，发通知", async () => {
    const t = makeDeps({ deviceId: "d1" });
    t.prisma.device.findFirst.mockResolvedValue(null);
    await runScheduledTask(t.deps as any, "t1", "2026-07-09T00:00:00.000Z");
    expect(t.billing.reserve).not.toHaveBeenCalled();
    expect(t.runs[t.runs.length - 1].skipReason).toBe("device_offline");
    expect(t.emails.length).toBe(1);
  });

  it("余额不足 → skipped insufficient_balance，不停用任务", async () => {
    const t = makeDeps();
    t.billing.reserve.mockRejectedValue(new InsufficientBalanceError());
    await runScheduledTask(t.deps as any, "t1", "2026-07-09T00:00:00.000Z");
    expect(t.runAgent).not.toHaveBeenCalled();
    expect(t.runs[t.runs.length - 1].skipReason).toBe("insufficient_balance");
    expect(t.prisma.scheduledTask.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ enabled: false }) }),
    );
  });

  it("billing 宕机（非余额错误）→ skipped billing_unavailable", async () => {
    const t = makeDeps();
    t.billing.reserve.mockRejectedValue(new Error("ECONNREFUSED"));
    await runScheduledTask(t.deps as any, "t1", "2026-07-09T00:00:00.000Z");
    expect(t.runAgent).not.toHaveBeenCalled();
    expect(t.runs[t.runs.length - 1].skipReason).toBe("billing_unavailable");
  });

  it("runAgent 抛错 → 仍 settle（释放预扣）+ failed", async () => {
    const t = makeDeps();
    t.runAgent.mockRejectedValue(new Error("模型超时"));
    await runScheduledTask(t.deps as any, "t1", "2026-07-09T00:00:00.000Z");
    expect(t.billing.settle).toHaveBeenCalledOnce();
    const last = t.runs[t.runs.length - 1];
    expect(last.status).toBe("failed");
    expect(last.error).toContain("模型超时");
    expect(t.redis.del).toHaveBeenCalled();
  });
});
