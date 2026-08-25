import { Icon } from "@iconify/react";
import type { AgentWorkflowRunDto } from "../../agentTeamApi";
import { statusLabel } from "./WorkflowRunPanel";

const SUCCESS_STATUSES = new Set(["succeeded"]);
const FAILED_STATUSES = new Set(["failed", "cancelled"]);
const RUNNING_STATUSES = new Set(["team_confirmed", "planning", "running"]);

function statusTone(status: string): string {
  if (SUCCESS_STATUSES.has(status)) return "text-brand-ink";
  if (FAILED_STATUSES.has(status)) return "text-danger-ink";
  if (RUNNING_STATUSES.has(status)) return "text-warning-ink";
  return "text-ink";
}

function formatDuration(startIso: string, endIso: string | null): string {
  const start = Date.parse(startIso);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "—";
  const totalSeconds = Math.round((end - start) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

interface RunStatusCardProps {
  readonly run: AgentWorkflowRunDto | null;
}

export function RunStatusCard({ run }: RunStatusCardProps) {
  if (!run) return null;

  const completedSteps = run.steps.filter((step) => SUCCESS_STATUSES.has(step.status)).length;
  const wordCount = run.finalReport.trim().length;
  const duration = formatDuration(run.createdAt, run.completedAt ?? run.cancelledAt);

  const metrics = [
    { icon: "mdi:progress-check", label: "状态", value: statusLabel(run.status), tone: statusTone(run.status) },
    { icon: "mdi:clock-outline", label: "耗时", value: duration, tone: "text-ink" },
    { icon: "mdi:format-list-checks", label: "步骤", value: `${completedSteps}/${run.steps.length}`, tone: "text-ink" },
    { icon: "mdi:text", label: "篇幅", value: wordCount ? `${wordCount} 字` : "—", tone: "text-ink" },
  ];

  return (
    <section className="rounded-[14px] border border-hairline-subtle bg-surface p-4">
      <p className="mb-3 text-sm font-semibold text-ink">任务状态</p>
      <div className="grid grid-cols-2 gap-2">
        {metrics.map((metric) => (
          <div key={metric.label} className="flex items-center gap-2.5 rounded-[10px] bg-surface-subtle px-3 py-2.5">
            <Icon icon={metric.icon} className="flex-none text-base text-ink-secondary" aria-hidden />
            <div className="min-w-0">
              <p className="text-[11px] text-ink-tertiary">{metric.label}</p>
              <p className={`truncate text-[13px] font-semibold ${metric.tone}`}>{metric.value}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
