import { useState } from "react";
import { Icon } from "@iconify/react";
import type { AgentWorkflowRunDto } from "../../agentTeamApi";
import { buildRunDocument } from "../../agentTeamDocument";
import { canSaveToDesktop, downloadTextFile, revealDesktopPath, saveDocumentToDesktop } from "../../desktopBridge";
import { MarkdownMessage } from "../MarkdownMessage";

type SaveState = "idle" | "saving" | "saved" | "error";

interface RunDocumentActionsProps {
  readonly run: AgentWorkflowRunDto;
}

// 完成态工作流的产物操作：保存到本地（B，桌面端）+ 下载文档（A，任何环境）。
function RunDocumentActions({ run }: RunDocumentActionsProps) {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savedPath, setSavedPath] = useState("");
  const desktopAvailable = canSaveToDesktop();

  const handleDownload = () => {
    const doc = buildRunDocument(run);
    downloadTextFile(doc.filename, doc.content);
  };

  const handleSaveLocal = () => {
    setSaveState("saving");
    const doc = buildRunDocument(run);
    void saveDocumentToDesktop(doc.filename, doc.content)
      .then((result) => {
        setSavedPath(result.path);
        setSaveState("saved");
      })
      .catch(() => setSaveState("error"));
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {desktopAvailable && (
        <button
          type="button"
          onClick={handleSaveLocal}
          disabled={saveState === "saving"}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-[10px] bg-brand px-3 text-sm font-semibold text-white transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-60"
        >
          <Icon icon={saveState === "saving" ? "mdi:loading" : "mdi:content-save-outline"} className={saveState === "saving" ? "animate-spin text-base" : "text-base"} aria-hidden />
          {saveState === "saving" ? "保存中…" : "保存到本地"}
        </button>
      )}
      <button
        type="button"
        onClick={handleDownload}
        className="inline-flex h-9 items-center justify-center gap-2 rounded-[10px] border border-hairline bg-white px-3 text-sm font-semibold text-ink transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
      >
        <Icon icon="mdi:download-outline" className="text-base" aria-hidden />
        下载文档
      </button>
      {saveState === "saved" && (
        <span className="inline-flex items-center gap-1.5 text-xs text-ink-secondary">
          <Icon icon="mdi:check-circle" className="text-sm text-brand" aria-hidden />
          已保存
          <button type="button" onClick={() => void revealDesktopPath(savedPath)} className="font-medium text-brand-ink underline-offset-2 ">
            打开文件夹
          </button>
        </span>
      )}
      {saveState === "error" && <span className="text-xs text-red-600">保存失败，可改用「下载文档」</span>}
    </div>
  );
}

const RUNNING_STATUSES = new Set(["team_confirmed", "planning", "running"]);

export function statusLabel(status: string): string {
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

interface WorkflowRunPanelProps {
  readonly run: AgentWorkflowRunDto | null;
  readonly isCancelling: boolean;
  readonly onCancel: () => void;
}

interface WorkflowStepsProps {
  readonly run: AgentWorkflowRunDto;
}

function WorkflowSteps({ run }: WorkflowStepsProps) {
  return (
    <div className="space-y-2">
      {run.steps.map((step) => (
        <div key={step.id} className="rounded-[10px] border border-hairline-subtle bg-white p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink">{step.title}</p>
              <p className="mt-1 text-xs text-ink-secondary">{step.memberName} · {statusLabel(step.status)}</p>
            </div>
            <Icon icon={step.status === "succeeded" ? "mdi:check-circle" : step.status === "failed" ? "mdi:alert-circle" : "mdi:progress-clock"} className="mt-0.5 flex-none text-lg text-brand" aria-hidden />
          </div>
          {step.output && <p className="mt-2 line-clamp-3 break-words text-xs leading-5 text-ink-secondary">{step.output}</p>}
          {step.error && <p className="mt-2 break-words text-xs text-red-600">{step.error}</p>}
        </div>
      ))}
      {run.steps.length === 0 && <p className="rounded-[10px] bg-[#f7faf9] p-4 text-sm text-ink-secondary">团队确认后会自动生成工作流步骤。</p>}
    </div>
  );
}

export function WorkflowRunPanel({ run, isCancelling, onCancel }: WorkflowRunPanelProps) {
  const [expandedRunIds, setExpandedRunIds] = useState<ReadonlySet<string>>(() => new Set());
  if (!run) return null;
  const canCancel = RUNNING_STATUSES.has(run.status);
  const hasFinalReport = run.finalReport.trim().length > 0;
  const isCompletedReport = run.status === "succeeded" && hasFinalReport;
  const isWorkflowVisible = !isCompletedReport || expandedRunIds.has(run.id);

  const toggleWorkflow = () => {
    setExpandedRunIds((current) => {
      const next = new Set(current);
      if (next.has(run.id)) {
        next.delete(run.id);
      } else {
        next.add(run.id);
      }
      return next;
    });
  };

  return (
    <section className="rounded-[14px] border border-hairline-subtle bg-white p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-ink">执行记录</p>
          <h2 className="mt-1 line-clamp-2 text-base font-semibold text-ink">{run.taskGoal}</h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[#f7faf9] px-3 text-xs text-ink-secondary">
            <Icon icon={RUNNING_STATUSES.has(run.status) ? "mdi:loading" : "mdi:progress-check"} className={RUNNING_STATUSES.has(run.status) ? "animate-spin" : ""} aria-hidden />
            {statusLabel(run.status)}
          </span>
          {canCancel && (
            <button
              type="button"
              disabled={isCancelling}
              onClick={onCancel}
              className="h-8 rounded-full border border-hairline px-3 text-xs font-medium text-ink-secondary transition disabled:opacity-60"
            >
              {isCancelling ? "取消中" : "取消"}
            </button>
          )}
        </div>
      </div>

      {isCompletedReport ? (
        <div className="mt-4 space-y-4">
          <article className="rounded-[14px] border border-brand/15 bg-[#f7faf9] p-5">
            <div className="flex flex-col gap-3 border-b border-hairline-subtle pb-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-ink">任务已完成</p>
                <h3 className="mt-1 text-lg font-semibold text-ink">任务答案与报告</h3>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <RunDocumentActions run={run} />
                <button
                  type="button"
                  aria-expanded={isWorkflowVisible}
                  aria-controls={`agent-workflow-steps-${run.id}`}
                  onClick={toggleWorkflow}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-[10px] border border-hairline bg-white px-3 text-sm font-semibold text-ink transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                >
                  <Icon icon={isWorkflowVisible ? "mdi:chevron-up" : "mdi:source-branch"} className="text-base" aria-hidden />
                  {isWorkflowVisible ? "隐藏工作流" : "查看工作流"}
                </button>
              </div>
            </div>
            <div className="mt-5 max-w-[980px] text-ink-secondary">
              <MarkdownMessage content={run.finalReport} variant="report" />
            </div>
          </article>
          {isWorkflowVisible && (
            <div id={`agent-workflow-steps-${run.id}`} className="rounded-[14px] border border-hairline-subtle bg-[#fbfbfc] p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-ink">工作流过程</h3>
                <span className="text-xs text-ink-secondary">{run.steps.length} 个步骤</span>
              </div>
              <WorkflowSteps run={run} />
            </div>
          )}
        </div>
      ) : (
        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
          <WorkflowSteps run={run} />
          <div className="rounded-[10px] bg-[#f7faf9] p-4">
            <h3 className="text-sm font-semibold text-ink">主 Agent 任务报告</h3>
            {hasFinalReport ? (
              <div className="mt-3 text-ink-secondary">
                <MarkdownMessage content={run.finalReport} />
              </div>
            ) : (
              <p className="mt-3 break-words text-sm leading-6 text-ink-secondary">{run.error ?? "工作流完成后会在这里生成完整任务报告。"}</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
