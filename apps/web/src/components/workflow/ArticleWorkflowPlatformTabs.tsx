import { Icon } from "@iconify/react";
import type { ArticleWorkflowPlatform } from "@ai-assistant/article-workflow";
import { Fragment } from "react";
import type { ArticleWorkflowProject } from "../../workflowArticleApi";
import { shortPlatformLabel } from "./articleWorkflowBatchModel";
import { isBusyArticleWorkflowStatus } from "./articleWorkflowStudioModel";

interface ArticleWorkflowPlatformTabsProps {
  readonly projects: readonly ArticleWorkflowProject[];
  readonly activePlatform: ArticleWorkflowPlatform | null;
  readonly dirtyPlatforms: readonly ArticleWorkflowPlatform[];
  readonly retryingProjectId: string | null;
  readonly onSelectPlatform: (platform: ArticleWorkflowPlatform) => void;
  readonly onRetry: (projectId: string) => void;
}

/** 单平台批次不显示页签，避免多一行没用的 UI */
export function ArticleWorkflowPlatformTabs(props: ArticleWorkflowPlatformTabsProps) {
  if (props.projects.length < 2) return null;

  return (
    <div className="inline-flex flex-wrap gap-1 rounded-full bg-[#f5f6fa] p-1" role="tablist">
      {props.projects.map((row) => {
        const active = row.platform === props.activePlatform;
        const busy = isBusyArticleWorkflowStatus(row.status);
        const retrying = props.retryingProjectId === row.id;
        return (
          <Fragment key={row.id}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => props.onSelectPlatform(row.platform)}
              className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                active ? "bg-white text-[#14151a] shadow-sm" : "text-[#667085]"
              }`}
            >
              {shortPlatformLabel(row.platform)}
              {busy && <Icon icon="mdi:loading" className="animate-spin text-brand" aria-label="生成中" />}
              {!busy && row.status === "failed" && (
                <Icon icon="mdi:alert-circle-outline" className="text-red-500" aria-label="生成失败" />
              )}
              {!busy && props.dirtyPlatforms.includes(row.platform) && (
                <span className="h-1.5 w-1.5 rounded-full bg-[#e08b1c]" aria-label="待保存" />
              )}
            </button>
            {/* 失败的那个平台旁边直接给重试入口，不用先切到那个页签 */}
            {row.status === "failed" && (
              <button
                type="button"
                onClick={() => props.onRetry(row.id)}
                disabled={retrying}
                aria-label={`重新生成${shortPlatformLabel(row.platform)}`}
                className="flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs font-semibold text-red-600 transition hover:bg-white disabled:text-red-300"
              >
                <Icon icon={retrying ? "mdi:loading" : "mdi:refresh"} className={retrying ? "animate-spin" : ""} aria-hidden />
                {retrying ? "提交中" : "重新生成"}
              </button>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
