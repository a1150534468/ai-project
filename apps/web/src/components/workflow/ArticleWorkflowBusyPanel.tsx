import { Icon } from "@iconify/react";
import type { ArticleWorkflowProject } from "../../workflowArticleApi";

interface ArticleWorkflowBusyPanelProps {
  readonly project: ArticleWorkflowProject;
}

export function ArticleWorkflowBusyPanel({ project }: ArticleWorkflowBusyPanelProps) {
  return (
    <section className="rounded-[18px] border border-[#e7e9f0] bg-white p-8 shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
      <div className="mx-auto max-w-[560px] text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#eef8f5] text-brand">
          <Icon icon="mdi:loading" className="text-[28px] animate-spin" aria-hidden />
        </div>
        <h2 className="mt-4 text-xl font-semibold text-[#14151a]">
          {project.status === "revising" ? "AI 正在重新整理文章" : "AI 正在生成公众号图文"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-[#667085]">{project.progressMessage || "请稍候..."}</p>

        <div className="mt-6 rounded-full bg-[#eef1f5] p-1">
          <div
            className="h-2 rounded-full bg-brand transition-all"
            style={{ width: `${Math.min(100, Math.max(8, project.progressPercent))}%` }}
          />
        </div>
      </div>
    </section>
  );
}
