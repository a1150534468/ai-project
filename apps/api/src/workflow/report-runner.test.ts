import { describe, it, expect, vi } from "vitest";
import { runReportTask } from "./report-runner.js";

function makeDeps() {
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    reportTask: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return {};
      }),
    },
  };
  const put = vi.fn().mockResolvedValue(undefined);
  const billing = {
    reserve: vi.fn().mockResolvedValue(undefined),
    settle: vi.fn().mockResolvedValue(undefined),
    listEnabledModels: vi.fn().mockResolvedValue({
      data: [{ model: "MiniMax-M3", maxOutputTokens: 4096 }],
    }),
  };
  const llm = {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "<h1>ok</h1>" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 8 },
      }),
    },
  };
  return { updates, prisma, put, billing, llm };
}

describe("runReportTask", () => {
  it("成功：running→ready，写 S3，落 htmlKey/tokens", async () => {
    const d = makeDeps();
    await runReportTask({
      taskId: "t1",
      userId: "u1",
      text: "数据",
      intent: "",
      model: "MiniMax-M3",
      prisma: d.prisma as never,
      s3: {} as never,
      putObject: d.put,
      billing: d.billing as never,
      llm: d.llm as never,
    });
    expect(d.updates[0]).toMatchObject({ stage: "running" });
    const ready = d.updates.find((u) => u.stage === "ready");
    expect(ready).toBeTruthy();
    expect(ready!.htmlKey).toBe("reports/u1/t1.html");
    expect(d.put).toHaveBeenCalledOnce();
    // 报告 HTML 必须公开可读，否则沙箱 iframe/下载走公开 URL 会 AccessDenied
    expect(d.put).toHaveBeenCalledWith(
      expect.anything(),
      "reports/u1/t1.html",
      expect.any(Buffer),
      expect.stringContaining("text/html"),
      { acl: "public-read" },
    );
  });

  it("模型不可用：置 failed", async () => {
    const d = makeDeps();
    d.billing.listEnabledModels = vi.fn().mockResolvedValue({ data: [] });
    await runReportTask({
      taskId: "t1",
      userId: "u1",
      text: "数据",
      intent: "",
      model: "ghost",
      prisma: d.prisma as never,
      s3: {} as never,
      putObject: d.put,
      billing: d.billing as never,
      llm: d.llm as never,
    });
    expect(d.updates.some((u) => u.stage === "failed")).toBe(true);
    expect(d.put).not.toHaveBeenCalled();
  });

  it("模型已启用但 maxOutputTokens=0（后台未配上限）时用默认值继续，不判不可用", async () => {
    const d = makeDeps();
    d.billing.listEnabledModels = vi.fn().mockResolvedValue({
      data: [{ model: "MiniMax-M3", maxOutputTokens: 0 }],
    });
    await runReportTask({
      taskId: "t1",
      userId: "u1",
      text: "数据",
      intent: "",
      model: "MiniMax-M3",
      prisma: d.prisma as never,
      s3: {} as never,
      putObject: d.put,
      billing: d.billing as never,
      llm: d.llm as never,
    });
    expect(d.updates.some((u) => u.stage === "failed")).toBe(false);
    const ready = d.updates.find((u) => u.stage === "ready");
    expect(ready).toBeTruthy();
    expect(d.put).toHaveBeenCalledOnce();
    // 用了默认输出上限发起 reserve（>0），而不是把 0 传下去
    expect(d.billing.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: expect.any(Number) }),
    );
    const reserveArg = d.billing.reserve.mock.calls[0][0] as { maxOutputTokens: number };
    expect(reserveArg.maxOutputTokens).toBeGreaterThan(0);
  });

  it("LLM 失败：置 failed 且 error 落库", async () => {
    const d = makeDeps();
    d.llm.messages.create = vi.fn().mockRejectedValue(new Error("boom"));
    await runReportTask({
      taskId: "t1",
      userId: "u1",
      text: "数据",
      intent: "",
      model: "MiniMax-M3",
      prisma: d.prisma as never,
      s3: {} as never,
      putObject: d.put,
      billing: d.billing as never,
      llm: d.llm as never,
    });
    const failed = d.updates.find((u) => u.stage === "failed");
    expect(failed).toBeTruthy();
    expect(String(failed!.error)).toContain("boom");
  });

  it("全面详尽 + 超单次预算 → 按分表分块多轮，拼成带目录导航的长报告，不漏分表", async () => {
    const d = makeDeps();
    // 两个大分表，合计超过单次预算(56k token)，触发分块
    const rows = (tag: string) => Array.from({ length: 1500 }, () => `${tag}行` + "x".repeat(60)).join("\n");
    const text = `# 表A\n${rows("A")}\n# 表B\n${rows("B")}`;
    await runReportTask({
      taskId: "t1", userId: "u1", text, intent: "全面详尽", model: "MiniMax-M3", exhaustive: true,
      prisma: d.prisma as never, s3: {} as never, putObject: d.put, billing: d.billing as never, llm: d.llm as never,
    });
    const ready = d.updates.find((u) => u.stage === "ready");
    expect(ready).toBeTruthy();
    // 多段 → llm 被多次调用（每段至少一次）
    expect((d.llm.messages.create as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    // 存的 HTML 含目录导航
    const putHtml = (d.put.mock.calls[0][2] as Buffer).toString("utf8");
    expect(putHtml).toContain('<nav class="rpt-toc">');
    expect(putHtml).toContain("总览"); // 有开篇总览封面
    expect(putHtml).toContain("表A");
    expect(putHtml).toContain("表B");
    // 总览封面 + 各分表段 → llm 调用数 ≥ 分表段数 + 1
    const overviewOp = (d.billing.reserve.mock.calls as Array<[{ operationId: string }]>).some(
      (c) => c[0].operationId.includes("overview"),
    );
    expect(overviewOp).toBe(true);
  });

  it("全面详尽 + 放得下 → 单次生成不截断、不分块(无目录导航)", async () => {
    const d = makeDeps();
    await runReportTask({
      taskId: "t1", userId: "u1", text: "# 表A\n少量数据", intent: "全面详尽", model: "MiniMax-M3", exhaustive: true,
      prisma: d.prisma as never, s3: {} as never, putObject: d.put, billing: d.billing as never, llm: d.llm as never,
    });
    expect(d.updates.find((u) => u.stage === "ready")).toBeTruthy();
    expect((d.llm.messages.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    const putHtml = (d.put.mock.calls[0][2] as Buffer).toString("utf8");
    expect(putHtml).not.toContain('<nav class="rpt-toc">');
  });
});
