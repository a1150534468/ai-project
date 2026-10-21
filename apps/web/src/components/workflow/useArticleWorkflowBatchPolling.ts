/**
 * 图文批次的轮询。批次里只要还有 generating / revising 的行就每 2.5s 拉一次
 * **轻量状态端点**（只有 id/status/error，没有正文），全部落地后才做一次全量
 * 回填 + 一次历史刷新，并一次性给出「几个平台已生成」和失败原因。
 *
 * 从 `useArticleWorkflowStudio.ts` 原样搬出。两条不能动的规则:
 *  - **回填一律 force=false**。已完成的平台可能正在被编辑,force=true 会把用户手里
 *    那份草稿冲掉。落地时的那一次全量回填同样遵守。
 *  - **配图失败要单独报**。这类行状态仍是 `ready`,只有 `error` 有值;只看 `failed`
 *    的话用户会以为图都出好了。汇总逻辑在 articleWorkflowBatchModel 的
 *    summarizeArticleWorkflowPoll（纯逻辑，可单测）。
 */
import { useEffect } from "react";
import { errorMessage } from "../../apiError";
import type { ArticleWorkflowPlatform } from "@ai-assistant/article-workflow";
import type { ArticleWorkflowProject, ArticleWorkflowStatusRow } from "../../workflowArticleApi";
import { summarizeArticleWorkflowPoll } from "./articleWorkflowBatchModel";
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

export type ArticleWorkflowLoadBatchStatus =
  (args: { readonly batchId: string | null; readonly projectId: string }) =>
    Promise<readonly ArticleWorkflowStatusRow[]>;

export function useArticleWorkflowBatchPolling(args: {
  readonly batchProjects: readonly ArticleWorkflowProject[];
  readonly batchBusy: boolean;
  readonly loadBatch: ArticleWorkflowLoadBatch;
  readonly loadBatchStatus: ArticleWorkflowLoadBatchStatus;
  readonly refreshHistory: () => Promise<void>;
  readonly setError: (value: string) => void;
  readonly setNotice: (value: string) => void;
}) {
  const { batchProjects, batchBusy, loadBatch, loadBatchStatus, refreshHistory, setError, setNotice } = args;
  const pollBatchId = batchProjects[0]?.batchId ?? null;
  const pollProjectId =
    batchProjects.find((item) => isBusyArticleWorkflowStatus(item.status))?.id ?? batchProjects[0]?.id ?? "";

  useEffect(() => {
    if (!batchBusy || !pollProjectId) return undefined;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const statuses = await loadBatchStatus({ batchId: pollBatchId, projectId: pollProjectId });
          const summary = summarizeArticleWorkflowPoll(statuses);
          if (summary.busy) return;
          // 全部落地：一次性全量回填（force=false 保住正在编辑的草稿）+ 刷新历史
          await loadBatch({ batchId: pollBatchId, projectId: pollProjectId, force: false });
          await refreshHistory();
          if (summary.notice) setNotice(summary.notice);
          if (summary.error) setError(summary.error);
        } catch (err) {
          setError(errorMessage(err, "刷新项目失败"));
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [batchBusy, loadBatch, loadBatchStatus, pollBatchId, pollProjectId, refreshHistory, setError, setNotice]);
}
