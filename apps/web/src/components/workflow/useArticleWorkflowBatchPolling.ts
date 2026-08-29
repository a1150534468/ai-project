/**
 * 图文批次的轮询。批次里只要还有 generating / revising 的行就每 2.5s 拉一次,
 * 全部落地后一次性给出「几个平台已生成」和失败原因。
 *
 * 从 `useArticleWorkflowStudio.ts` 原样搬出。两条不能动的规则:
 *  - **回填一律 force=false**。已完成的平台可能正在被编辑,force=true 会把用户手里
 *    那份草稿冲掉。
 *  - **配图失败要单独报**。这类行状态仍是 `ready`,只有 `error` 有值;只看 `failed`
 *    的话用户会以为图都出好了。
 */
import { useEffect } from "react";
import type { ArticleWorkflowPlatform } from "@ai-assistant/article-workflow";
import type { ArticleWorkflowProject } from "../../workflowArticleApi";
import { shortPlatformLabel } from "./articleWorkflowBatchModel";
import { isBusyArticleWorkflowStatus } from "./articleWorkflowStudioModel";

const POLL_INTERVAL_MS = 2500;

export interface ArticleWorkflowLoadBatchArgs {
  readonly batchId: string | null;
  readonly projectId: string;
  readonly force?: boolean;
  readonly focusPlatform?: ArticleWorkflowPlatform | null;
}

export type ArticleWorkflowLoadBatch =
  (args: ArticleWorkflowLoadBatchArgs) => Promise<readonly ArticleWorkflowProject[]>;

export function useArticleWorkflowBatchPolling(args: {
  readonly batchProjects: readonly ArticleWorkflowProject[];
  readonly batchBusy: boolean;
  readonly loadBatch: ArticleWorkflowLoadBatch;
  readonly refreshHistory: () => Promise<void>;
  readonly setError: (value: string) => void;
  readonly setNotice: (value: string) => void;
  readonly onBalanceRefresh?: () => void;
}) {
  const { batchProjects, batchBusy, loadBatch, refreshHistory, setError, setNotice, onBalanceRefresh } = args;
  const pollBatchId = batchProjects[0]?.batchId ?? null;
  const pollProjectId =
    batchProjects.find((item) => isBusyArticleWorkflowStatus(item.status))?.id ?? batchProjects[0]?.id ?? "";

  useEffect(() => {
    if (!batchBusy || !pollProjectId) return undefined;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          // 已完成的平台可能正在被编辑，force=false 保住那份草稿
          const details = await loadBatch({
            batchId: pollBatchId,
            projectId: pollProjectId,
            force: false,
          });
          await refreshHistory();
          if (details.some((item) => isBusyArticleWorkflowStatus(item.status))) return;
          const failed = details.filter((item) => item.status === "failed");
          const imageFailures = details.filter((item) => item.status === "ready" && item.error);
          const ready = details.length - failed.length;
          setNotice(ready > 0 ? `${ready} 个平台已生成` : "图文处理失败");
          if (failed.length > 0) {
            const names = failed.map((item) => shortPlatformLabel(item.platform)).join("、");
            setError(`${names}生成失败：${failed[0]?.error || "未知原因"}`);
          } else if (imageFailures.length > 0) {
            const names = imageFailures.map((item) => shortPlatformLabel(item.platform)).join("、");
            setError(`${names}配图失败：${imageFailures[0]?.error || "未知原因"}`);
          }
          onBalanceRefresh?.();
        } catch (err) {
          setError(err instanceof Error ? err.message : "刷新项目失败");
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [batchBusy, loadBatch, onBalanceRefresh, pollBatchId, pollProjectId, refreshHistory, setError, setNotice]);
}
