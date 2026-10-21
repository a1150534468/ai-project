// @vitest-environment jsdom
import { act, render, renderHook } from "@testing-library/react";
import { startTransition, Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArticleWorkflowProject, ArticleWorkflowStatusRow } from "../../workflowArticleApi";
import { useArticleWorkflowBatchPolling } from "./useArticleWorkflowBatchPolling";

/**
 * 批次轮询 hook 的时序直测：用 renderHook 精确控制 props 翻转与轮询推进，
 * 覆盖工作室级用例里被真实时间渗扰的竞态（两次轮询之间的状态双翻转）。
 */

function project(id: string, status: string): ArticleWorkflowProject {
  return {
    id,
    batchId: "batch-1",
    platform: id === "a" ? "wechat" : "xiaohongshu",
    status,
    error: null,
  } as unknown as ArticleWorkflowProject;
}

function statusRow(row: ArticleWorkflowProject): ArticleWorkflowStatusRow {
  return {
    id: row.id,
    platform: row.platform,
    status: row.status,
    error: row.error ?? null,
    updatedAt: "2026-08-20T06:00:00.000Z",
  } as ArticleWorkflowStatusRow;
}

describe("useArticleWorkflowBatchPolling 时序", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("两次轮询之间「落地→重新生成→再落地」的双翻转不能漏检回填", async () => {
    // a 放在第二个位置：b 全程 busy 且排第一，pollProjectId 恒为 b——
    // 这样「换项目清零」不会偶然把 seen 清掉重播种，测的才是 seen 同步本身。
    let serverRows = [project("b", "generating"), project("a", "generating")];
    const loadBatchStatus = vi.fn(async () => serverRows.map(statusRow));
    const loadBatch = vi.fn(async () => serverRows);
    const refreshHistory = vi.fn(async () => undefined);
    const setError = vi.fn();
    const setNotice = vi.fn();

    const hook = renderHook(
      (props: { projects: ArticleWorkflowProject[] }) =>
        useArticleWorkflowBatchPolling({
          batchProjects: props.projects,
          batchBusy: true,
          loadBatch,
          loadBatchStatus,
          refreshHistory,
          setError,
          setNotice,
        }),
      { initialProps: { projects: [project("b", "generating"), project("a", "generating")] } },
    );

    // 第一轮：a 落地、b 仍在跑 → 回填一次（部分落地不通知）
    serverRows = [project("b", "generating"), project("a", "ready")];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(loadBatch).toHaveBeenCalledTimes(1);
    expect(setNotice).not.toHaveBeenCalled();
    // 界面跟上回填结果（a=ready）
    hook.rerender({ projects: [project("b", "generating"), project("a", "ready")] });

    // 两次轮询之间用户重新生成 a：界面回到 generating；服务端很快又跑完
    hook.rerender({ projects: [project("b", "generating"), project("a", "generating")] });
    serverRows = [project("b", "generating"), project("a", "ready")];

    // 第二轮：a 的第二次落地必须被检出并回填——若 seen 只在轮询开头采样界面状态，
    // 采样值（generating）与上轮相同，这次 ready 会被当成 ready→ready 漏掉
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(loadBatch).toHaveBeenCalledTimes(2);
    expect(setNotice).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("挂起/被放弃的渲染不能污染 seen：未提交的 ready 不得让随后真落地漏检", async () => {
    let serverRows = [project("b", "generating"), project("a", "generating")];
    const loadBatchStatus = vi.fn(async () => serverRows.map(statusRow));
    const loadBatch = vi.fn(async () => serverRows);
    const refreshHistory = vi.fn(async () => undefined);
    const setError = vi.fn();
    const setNotice = vi.fn();

    // hook 调用之后抛未决 Promise 让本次渲染挂起、永不提交：若记账写在渲染期，
    // 这次「未提交的 ready」就会污染 seen；写在 layout effect 里则不会运行。
    let suspend = false;
    function Probe({ projects }: { projects: ArticleWorkflowProject[] }) {
      useArticleWorkflowBatchPolling({
        batchProjects: projects,
        batchBusy: true,
        loadBatch,
        loadBatchStatus,
        refreshHistory,
        setError,
        setNotice,
      });
      if (suspend) throw new Promise<void>(() => {});
      return null;
    }

    const view = render(
      <Suspense fallback={null}>
        <Probe projects={[project("b", "generating"), project("a", "generating")]} />
      </Suspense>,
    );

    // 服务端把 a 跑完；同一时刻一次试图把 a=ready 画上界面的渲染被挂起（未提交）
    serverRows = [project("b", "generating"), project("a", "ready")];
    suspend = true;
    await act(async () => {
      startTransition(() => {
        view.rerender(
          <Suspense fallback={null}>
            <Probe projects={[project("b", "generating"), project("a", "ready")]} />
          </Suspense>,
        );
      });
    });

    // 轮询观测到真落地：seen 里 a 必须仍是 generating → 跃迁成立 → 回填发生。
    // 若 seen 被挂起渲染污染成 ready，这里会 ready→ready 漏检、loadBatch 不被调用。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(loadBatch).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
