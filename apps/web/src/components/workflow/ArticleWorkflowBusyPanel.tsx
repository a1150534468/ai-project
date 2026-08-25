import { Icon } from "@iconify/react";
import type { ArticleWorkflowProject } from "../../workflowArticleApi";
import {
  shortPlatformLabel,
  type ArticleWorkflowBatchProgress,
} from "./articleWorkflowBatchModel";
import { isBusyArticleWorkflowStatus } from "./articleWorkflowStudioModel";

interface ArticleWorkflowBusyPanelProps {
  readonly project: ArticleWorkflowProject;
  readonly batchProjects: readonly ArticleWorkflowProject[];
  readonly batchProgress: ArticleWorkflowBatchProgress;
}

function rowStatusText(project: ArticleWorkflowProject): string {
  if (project.status === "failed") return project.error || "生成失败";
  if (!isBusyArticleWorkflowStatus(project.status)) return "已完成";
  return project.progressMessage || "排队中";
}

function progressValue(props: ArticleWorkflowBusyPanelProps): number {
  const multi = props.batchProjects.length > 1;
  return Math.min(100, Math.max(8, multi ? props.batchProgress.percent : props.project.progressPercent));
}

function PlatformProgressList(props: ArticleWorkflowBusyPanelProps) {
  return (
    <ul className="grid gap-2 text-left">
      {props.batchProjects.map((row) => {
        const busy = isBusyArticleWorkflowStatus(row.status);
        return (
          <li key={row.id} className="flex items-center gap-3 rounded-lg border border-hairline-subtle bg-surface px-3 py-2.5">
            <Icon
              icon={row.status === "failed" ? "mdi:alert-circle-outline" : busy ? "mdi:loading" : "mdi:check-circle"}
              className={`shrink-0 text-lg ${row.status === "failed" ? "text-danger-ink" : busy ? "animate-spin text-brand" : "text-brand"}`}
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-ink">{shortPlatformLabel(row.platform)}</span>
              <span className={`mt-0.5 block truncate text-xs ${row.status === "failed" ? "text-danger-ink" : "text-ink-secondary"}`}>
                {rowStatusText(row)}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function ArticleWorkflowBusyPanel(props: ArticleWorkflowBusyPanelProps) {
  const multi = props.batchProjects.length > 1;
  return (
    <section className="grid h-full min-h-[480px] place-items-center bg-surface px-6 py-10">
      <div className="w-full max-w-[560px] text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-brand-soft text-brand">
          <Icon icon="mdi:loading" className="animate-spin text-[28px]" aria-hidden />
        </div>
        <h2 className="mt-4 text-xl font-semibold text-ink">
          {props.project.status === "revising" ? "AI 正在重新整理文章" : "AI 正在生成多平台图文"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-ink-secondary">{props.project.progressMessage || "请稍候..."}</p>
        {multi && (
          <p className="mt-1 text-xs text-ink-tertiary">
            已完成 {props.batchProgress.completed} / {props.batchProgress.total} 个平台
          </p>
        )}
        <div className="mx-auto mt-6 h-2 max-w-[420px] overflow-hidden rounded-full bg-hairline-subtle">
          <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${progressValue(props)}%` }} />
        </div>
        <div className="mx-auto mt-6 max-w-[480px]">
          <PlatformProgressList {...props} />
        </div>
      </div>
    </section>
  );
}
