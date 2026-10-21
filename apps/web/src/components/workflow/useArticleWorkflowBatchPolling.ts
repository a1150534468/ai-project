/**
 * 图文批次的轮询。批次里只要还有 generating / revising 的行就每 2.5s 拉一次
 * **轻量状态端点**（只有 id/status/error，没有正文），全部落地后才做一次全量
 * 回填 + 一次历史刷新，并一次性给出「几个平台已生成」和失败原因。
 *
 * 调度走纯逻辑 poller（src/poller.ts）：重叠保护与「落地停轮」在它里面，
 * 这个 hook 只负责把批次状态喂给它、把一轮轮询的业务动作交给它。
 *
 * 两条不能动的规则:
 *  - **回填一律 force=false**。已完成的平台可能正在被编辑,force=true 会把用户手里
 *    那份草稿冲掉。落地时的那一次全量回填同样遵守。
 *  - **配图失败要单独报**。这类行状态仍是 `ready`,只有 `error` 有值;只看 `failed`
 *    的话用户会以为图都出好了。汇总逻辑在 articleWorkflowBatchModel 的
 *    summarizeArticleWorkflowPoll（纯逻辑，可单测）。
 */
import { useEffect, useRef } from "react";
import { errorMessage } from "../../apiError";
import { createPoller, type Poller } from "../../poller";
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

  // poller 只建一次，输入全走 ref：批次切换/状态翻转只 notify，不重建调度器
  const inputsRef = useRef({ batchBusy, pollBatchId, pollProjectId, loadBatch, loadBatchStatus, refreshHistory, setError, setNotice });
  inputsRef.current = { batchBusy, pollBatchId, pollProjectId, loadBatch, loadBatchStatus, refreshHistory, setError, setNotice };
  const pollerRef = useRef<Poller | null>(null);
  if (pollerRef.current === null) {
    pollerRef.current = createPoller({
      intervalMs: POLL_INTERVAL_MS,
      shouldPoll: () => inputsRef.current.batchBusy && inputsRef.current.pollProjectId !== "",
      refresh: async () => {
        const input = inputsRef.current;
        try {
          const statuses = await input.loadBatchStatus({ batchId: input.pollBatchId, projectId: input.pollProjectId });
          const summary = summarizeArticleWorkflowPoll(statuses);
          if (summary.busy) return;
          // 全部落地：一次性全量回填（force=false 保住正在编辑的草稿）+ 刷新历史
          await input.loadBatch({ batchId: input.pollBatchId, projectId: input.pollProjectId, force: false });
          await input.refreshHistory();
          if (summary.notice) input.setNotice(summary.notice);
          if (summary.error) input.setError(summary.error);
        } catch (err) {
          input.setError(errorMessage(err, "刷新项目失败"));
        }
      },
    });
  }

  useEffect(() => {
    const poller = pollerRef.current;
    if (!poller) return undefined;
    poller.start();
    return () => poller.stop();
  }, []);

  useEffect(() => {
    pollerRef.current?.notify();
  }, [batchBusy, pollBatchId, pollProjectId]);
}
