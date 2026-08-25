import { Icon } from "@iconify/react";
import type { ArticleWorkflowPlatform } from "@ai-assistant/article-workflow";
import type { ArticleWorkflowProject } from "../../workflowArticleApi";
import { shortPlatformLabel } from "./articleWorkflowBatchModel";
import { isBusyArticleWorkflowStatus } from "./articleWorkflowStudioModel";

interface ArticleWorkflowPlatformTabsProps {
  readonly projects: readonly ArticleWorkflowProject[];
  readonly activePlatform: ArticleWorkflowPlatform | null;
  readonly dirtyPlatforms: readonly ArticleWorkflowPlatform[];
  readonly onSelectPlatform: (platform: ArticleWorkflowPlatform) => void;
}

/** 单平台批次不显示页签，避免多一行没有切换价值的 UI。 */
export function ArticleWorkflowPlatformTabs(props: ArticleWorkflowPlatformTabsProps) {
  if (props.projects.length < 2) return null;

  return (
    <div
      className="grid w-full rounded-[10px] bg-surface-muted p-1"
      style={{ gridTemplateColumns: `repeat(${props.projects.length}, minmax(0, 1fr))` }}
      role="tablist"
    >
      {props.projects.map((row) => {
        const active = row.platform === props.activePlatform;
        const busy = isBusyArticleWorkflowStatus(row.status);
        return (
          <button
            key={row.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => props.onSelectPlatform(row.platform)}
            className={`flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-semibold transition ${
              active ? "bg-surface text-ink shadow-sm" : "text-ink-secondary"
            }`}
          >
            <span className="truncate">{shortPlatformLabel(row.platform)}</span>
            {busy && <Icon icon="mdi:loading" className="shrink-0 animate-spin text-brand" aria-label="生成中" />}
            {!busy && row.status === "failed" && (
              <Icon icon="mdi:alert-circle-outline" className="shrink-0 text-danger-ink" aria-label="生成失败" />
            )}
            {!busy && props.dirtyPlatforms.includes(row.platform) && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-label="待保存" />
            )}
          </button>
        );
      })}
    </div>
  );
}
