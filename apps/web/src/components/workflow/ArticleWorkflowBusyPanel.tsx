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

export function ArticleWorkflowBusyPanel(props: ArticleWorkflowBusyPanelProps) {
  const { project, batchProjects, batchProgress } = props;
  const multi = batchProjects.length > 1;

  return (
    <section className="rounded-[18px] border border-[#e7e9f0] bg-white p-8 shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
      <div className="mx-auto max-w-[560px] text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#eef8f5] text-brand">
          <Icon icon="mdi:loading" className="text-[28px] animate-spin" aria-hidden />
        </div>
        <h2 className="mt-4 text-xl font-semibold text-[#14151a]">
          {project.status === "revising" ? "AI 正在重新整理文章" : "AI 正在生成多平台图文"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-[#667085]">{project.progressMessage || "请稍候..."}</p>
        {multi && (
          <p className="mt-1 text-xs text-[#8a8f98]">
            已完成 {batchProgress.completed} / {batchProgress.total} 个平台
          </p>
        )}

        <div className="mt-6 rounded-full bg-[#eef1f5] p-1">
          <div
            className="h-2 rounded-full bg-brand transition-all"
            style={{ width: `${Math.min(100, Math.max(8, multi ? batchProgress.percent : project.progressPercent))}%` }}
          />
        </div>

        {multi && (
          <ul className="mt-6 grid gap-2 text-left">
            {batchProjects.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 rounded-[12px] border border-[#edf0f5] bg-[#fafbfe] px-3 py-2"
              >
                <span className="text-sm font-semibold text-[#1d2433]">{shortPlatformLabel(row.platform)}</span>
                <span className={`truncate text-xs ${row.status === "failed" ? "text-red-600" : "text-[#667085]"}`}>
                  {rowStatusText(row)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
