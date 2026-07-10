import { describe, it, expect } from "vitest";
import { buildReport } from "./report.js";

describe("buildReport", () => {
  it("成功报告含标题、产出与用量，subject 标成功", () => {
    const r = buildReport({
      title: "每日早报", status: "success",
      triggeredAt: new Date("2026-07-09T00:00:00Z"), durationMs: 12_000,
      resultText: "今天要闻：A、B、C", toolCalls: 2, inputTokens: 100, outputTokens: 200, pointsCharged: 5,
    });
    expect(r.subject).toBe("[定时任务] 每日早报 — 成功");
    expect(r.html).toContain("今天要闻：A、B、C");
    expect(r.html).toContain("每日早报");
    expect(r.html).toContain("5");
  });

  it("跳过报告写明原因，subject 标跳过", () => {
    const r = buildReport({
      title: "巡检", status: "skipped", skipReason: "device_offline",
      triggeredAt: new Date("2026-07-09T00:00:00Z"),
    });
    expect(r.subject).toBe("[定时任务] 巡检 — 跳过");
    expect(r.html).toContain("设备离线");
  });

  it("失败报告带错误信息，subject 标失败", () => {
    const r = buildReport({
      title: "抓取", status: "failed", triggeredAt: new Date("2026-07-09T00:00:00Z"), error: "模型超时",
    });
    expect(r.subject).toBe("[定时任务] 抓取 — 失败");
    expect(r.html).toContain("模型超时");
  });

  it("HTML 转义防注入", () => {
    const r = buildReport({
      title: "x", status: "success", triggeredAt: new Date("2026-07-09T00:00:00Z"),
      resultText: "<script>alert(1)</script>",
    });
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;");
  });
});
