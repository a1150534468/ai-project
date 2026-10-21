/**
 * 图文批次的轮询。批次里只要还有 generating / revising 的行就每 2.5s 拉一次
 * **轻量状态端点**（只有 id/status/error，没有正文）；任一平台新落地就做一次
 * 全量回填让它的结果立刻可见，整批落地后再回填一次 + 刷新历史一次，并按
 * **回填返回值**一次性给出「几个平台已生成」和失败原因（不按状态查询的旧快照
 * 宣布完成——两查之间可能又起了新一轮生成）。
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
  const inputsRef = useRef({ batchProjects, batchBusy, pollBatchId, pollProjectId, loadBatch, loadBatchStatus, refreshHistory, setError, setNotice });
  inputsRef.current = { batchProjects, batchBusy, pollBatchId, pollProjectId, loadBatch, loadBatchStatus, refreshHistory, setError, setNotice };
  const pollerRef = useRef<Poller | null>(null);
  // 上一轮见过的行状态：判断「这一轮有没有平台新落地」——有新落地就值得做一次
  // 全量回填把它的正文/状态带进界面，不必等整批结束；稳态轮询仍然只打轻量端点。
  const seenStatusRef = useRef(new Map<string, string>());
  // 已落地但回填失败的行：状态本身不会再变，靠这本账在下一轮把回填重试出来，
  // 否则「落地 → 回填失败」之后新结果永远进不了界面（除非整批结束）。
  const pendingSettleRef = useRef(new Set<string>());
  // 上一轮见过的界面状态：seen 只采纳「界面状态的新变化」（回填落地、用户重新
  // 生成），不能每轮拿界面快照无条件覆盖 —— 服务端轮询可能先观察到某行回到
  // generating，界面还是旧的 ready 时反复覆盖会把这次落地从 seen 里抹掉。
  const lastPropsRef = useRef(new Map<string, string>());
  const lastBatchKeyRef = useRef<string | null>(null);
  if (pollerRef.current === null) {
    pollerRef.current = createPoller({
      intervalMs: POLL_INTERVAL_MS,
      shouldPoll: () => inputsRef.current.batchBusy && inputsRef.current.pollProjectId !== "",
      refresh: async () => {
        const input = inputsRef.current;
        try {
          const seen = seenStatusRef.current;
          const statuses = await input.loadBatchStatus({ batchId: input.pollBatchId, projectId: input.pollProjectId });
          const settledNow = statuses
            .filter((row) => {
              const before = seen.get(row.id);
              return before !== undefined && isBusyArticleWorkflowStatus(before) && !isBusyArticleWorkflowStatus(row.status);
            })
            .map((row) => row.id);
          for (const row of statuses) seen.set(row.id, row.status);
          const pending = pendingSettleRef.current;
          const hasPendingRetry = [...pending].some((id) =>
            statuses.some((row) => row.id === id && !isBusyArticleWorkflowStatus(row.status)),
          );
          const lightSummary = summarizeArticleWorkflowPoll(statuses);
          if (lightSummary.busy && settledNow.length === 0 && !hasPendingRetry) return;
          // 有平台落地（或整批落地）：全量回填一次（force=false），先落地平台的
          // 结果立刻可见，不被还没跑完的平台拖住。
          let projects: readonly ArticleWorkflowProject[];
          try {
            projects = await input.loadBatch({ batchId: input.pollBatchId, projectId: input.pollProjectId, force: false });
          } catch (error) {
            for (const id of settledNow) pending.add(id);
            throw error;
          }
          pending.clear();
          // 完成与否一律按回填返回值判定：轻量快照说忙、全量却已全落地时同样
          // 要报完成（反之快照说完成、回填仍忙时不能误报，继续轮询即可）。
          const finalSummary = summarizeArticleWorkflowPoll(projects);
          if (finalSummary.busy) return;
          await input.refreshHistory();
          if (finalSummary.notice) input.setNotice(finalSummary.notice);
          if (finalSummary.error) input.setError(finalSummary.error);
        } catch (err) {
          input.setError(errorMessage(err, "刷新项目失败"));
        }
      },
    });
  }

  // 换批次/项目时落地记账清零（渲染期按 key 变化触发）：不能放进 effect 里
  // 无条件跑——首次挂载时它会把同一次渲染刚同步好的 seen 又清掉；放渲染期还能
  // 保证清零与下方按新 props 重新同步在同一次渲染内完成，不留空窗。
  const batchKey = `${pollBatchId ?? ""}|${pollProjectId}`;
  if (lastBatchKeyRef.current !== batchKey) {
    if (lastBatchKeyRef.current !== null) {
      seenStatusRef.current.clear();
      pendingSettleRef.current.clear();
      lastPropsRef.current.clear();
    }
    lastBatchKeyRef.current = batchKey;
  }

  // 每次渲染跟随界面状态维护 lastProps/seen：某行状态一变（回填落地、用户重试/
  // 重新生成）就同步进 seen。只在轮询开头采样会漏掉两次轮询之间的双翻转
  // （落地→又变忙，采样值恰好等于最终值）；而界面没变时这里什么都不写，
  // 也不会像无条件覆盖那样抹掉服务端轮询先观察到的状态变化。
  for (const project of batchProjects) {
    if (lastPropsRef.current.get(project.id) !== project.status) {
      lastPropsRef.current.set(project.id, project.status);
      seenStatusRef.current.set(project.id, project.status);
    }
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
