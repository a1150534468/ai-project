import { Icon } from "@iconify/react";
import type { AgentWorkflowRunDto } from "../../agentTeamApi";

interface WorkflowRunHistoryPanelProps {
  readonly runs: readonly AgentWorkflowRunDto[];
  readonly activeRunId?: string | null;
  readonly onSelectRun: (run: AgentWorkflowRunDto) => void;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    awaiting_team_confirmation: "等待确认",
    team_confirmed: "已确认",
    planning: "规划中",
    running: "执行中",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return labels[status] ?? status;
}

function statusTone(status: string): string {
  if (status === "succeeded") return "bg-brand-soft text-brand-ink";
  if (status === "failed" || status === "cancelled") return "bg-red-50 text-red-700";
  return "bg-[#f7faf9] text-ink-secondary";
}

function formatTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

const ANSWER_PREVIEW_MARKERS = ["核心结论", "总体判断", "直接结论", "任务答案", "结论"] as const;

function plainReportText(report: string): string {
  return report
    .replace(/[#*_>`\-\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function answerPreviewText(text: string): string {
  const indexes = ANSWER_PREVIEW_MARKERS
    .map((marker) => text.indexOf(marker))
    .filter((index) => index >= 0 && index < 1200);
  if (indexes.length === 0) return text;
  return text.slice(Math.min(...indexes));
}

function reportPreview(run: AgentWorkflowRunDto): string {
  const text = plainReportText(run.finalReport);
  if (text) {
    return answerPreviewText(text).slice(0, 96);
  }
  return run.error || "暂无最终报告";
}

export function WorkflowRunHistoryPanel({ runs, activeRunId, onSelectRun }: WorkflowRunHistoryPanelProps) {
  return (
    <section className="rounded-[14px] border border-[#e8e8ed] bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-ink">历史记录</p>
          <h2 className="mt-1 text-base font-semibold text-ink">Agent 团队运行历史</h2>
        </div>
        <span className="text-xs text-ink-secondary">{runs.length} 条</span>
      </div>

      {runs.length > 0 ? (
        <div className="mt-4 grid gap-2">
          {runs.map((run) => {
            const active = run.id === activeRunId;
            const time = formatTime(run.completedAt ?? run.updatedAt);
            return (
              <button
                key={run.id}
                type="button"
                onClick={() => onSelectRun(run)}
                className={`rounded-[10px] border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
                  active ? "border-brand/50 bg-brand-soft" : "border-[#e8e8ed] bg-white "
                }`}
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h3 className="line-clamp-1 text-sm font-semibold text-ink">{run.taskGoal}</h3>
                    <p className="mt-1 line-clamp-1 text-xs leading-5 text-ink-secondary">{reportPreview(run)}</p>
                  </div>
                  <div className="flex flex-none items-center gap-2">
                    <span className={`inline-flex h-7 items-center rounded-full px-2.5 text-[11px] font-medium ${statusTone(run.status)}`}>
                      {statusLabel(run.status)}
                    </span>
                    {time && <span className="text-xs text-ink-tertiary">{time}</span>}
                    <Icon icon="mdi:chevron-right" className="text-lg text-ink-tertiary" aria-hidden />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="mt-4 rounded-[10px] border border-dashed border-[#d2d2d7] p-6 text-center text-sm text-ink-secondary">
          暂无运行历史
        </div>
      )}
    </section>
  );
}
