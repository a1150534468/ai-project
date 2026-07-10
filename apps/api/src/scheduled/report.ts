export type RunStatus = "success" | "failed" | "skipped";
export type SkipReason = "device_offline" | "insufficient_balance" | "billing_unavailable" | "prev_running";

export interface ReportInput {
  readonly title: string;
  readonly status: RunStatus;
  readonly skipReason?: SkipReason;
  readonly triggeredAt: Date;
  readonly durationMs?: number;
  readonly resultText?: string;
  readonly toolCalls?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly pointsCharged?: number | null;
  readonly error?: string;
}

const STATUS_LABEL: Record<RunStatus, string> = { success: "成功", failed: "失败", skipped: "跳过" };
const SKIP_LABEL: Record<SkipReason, string> = {
  device_offline: "绑定设备离线，本次未执行",
  insufficient_balance: "算力点余额不足，本次未执行",
  billing_unavailable: "计费服务暂不可用，本次未执行",
  prev_running: "上一次运行尚未结束，本次跳过",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildReport(input: ReportInput): { subject: string; html: string } {
  const subject = `[定时任务] ${input.title} — ${STATUS_LABEL[input.status]}`;
  const rows: string[] = [
    `<p><b>任务</b>：${esc(input.title)}</p>`,
    `<p><b>计划时刻</b>：${input.triggeredAt.toISOString()}</p>`,
    `<p><b>状态</b>：${STATUS_LABEL[input.status]}</p>`,
  ];
  if (input.status === "skipped" && input.skipReason) {
    rows.push(`<p><b>原因</b>：${SKIP_LABEL[input.skipReason]}</p>`);
  }
  if (input.status === "failed" && input.error) {
    rows.push(`<p><b>错误</b>：${esc(input.error)}</p>`);
  }
  if (typeof input.durationMs === "number") {
    rows.push(`<p><b>耗时</b>：${Math.round(input.durationMs / 1000)} 秒</p>`);
  }
  if (typeof input.toolCalls === "number") {
    rows.push(`<p><b>工具调用</b>：${input.toolCalls} 次｜tokens：${input.inputTokens ?? 0}/${input.outputTokens ?? 0}｜算力点：${input.pointsCharged ?? 0}</p>`);
  }
  if (input.resultText) {
    rows.push(`<hr/><h3>任务结果</h3><div style="white-space:pre-wrap">${esc(input.resultText)}</div>`);
  }
  return { subject, html: `<div style="font-family:sans-serif;line-height:1.6">${rows.join("\n")}</div>` };
}
