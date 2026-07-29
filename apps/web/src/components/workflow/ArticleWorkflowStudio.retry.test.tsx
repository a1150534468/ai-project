// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../motion/Toast";
import { ArticleWorkflowStudio } from "./ArticleWorkflowStudio";

const api = vi.hoisted(() => ({
  createArticleWorkflowProject: vi.fn(),
  getArticleWorkflowBatch: vi.fn(),
  getArticleWorkflowPricing: vi.fn(),
  getArticleWorkflowProject: vi.fn(),
  listArticleWorkflowHistory: vi.fn(),
  regenerateArticleWorkflowImage: vi.fn(),
  retryArticleWorkflowProject: vi.fn(),
  rewriteArticleWorkflowProject: vi.fn(),
  updateArticleWorkflowProject: vi.fn(),
}));

vi.mock("../../workflowArticleApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../workflowArticleApi")>(),
  ...api,
}));

/** 小红书行走 caption 编辑器（纯 textarea），不必把富文本编辑器拖进 jsdom */
function captionProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "article-1",
    sourceFormat: "plain-text" as const,
    sourceText: "开头第一段。\n\n第二段继续说明。",
    generationMode: "polish-text" as const,
    platform: "xiaohongshu" as const,
    batchId: "batch-1",
    title: "",
    summary: "",
    bodyHtml: "",
    captionText: "",
    tags: [] as readonly string[],
    imageManifestJson: [],
    status: "failed" as const,
    progressStage: "failed",
    progressPercent: 100,
    progressMessage: "生成失败",
    error: "403 Access to model denied for this account",
    createdAt: "2026-07-08T06:00:00.000Z",
    updatedAt: "2026-07-08T06:00:00.000Z",
    ...overrides,
  };
}

async function renderStudio(project: ReturnType<typeof captionProject>) {
  const result = render(
    <ToastProvider>
      <ArticleWorkflowStudio
        token="token"
        initialHistory={[]}
        initialProject={project as never}
        initialBootstrapping={false}
      />
    </ToastProvider>,
  );
  // 挂载时会拉一次计价，等它落地再断言，免得 act 告警
  await act(async () => { await Promise.resolve(); });
  return result;
}

beforeEach(() => {
  api.getArticleWorkflowPricing.mockResolvedValue(null);
  api.listArticleWorkflowHistory.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("ArticleWorkflowStudio 失败行处理", () => {
  it("failed 行改文案不触发自动保存，并原样显示失败原因", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderStudio(captionProject());

    // 后端存的 error 要能直接看到，不然「哪一行扣费失败、为什么」全靠猜
    expect(screen.getByRole("alert").textContent).toContain("403 Access to model denied");

    fireEvent.change(screen.getByLabelText("正文文案"), { target: { value: "手改一段文案" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    expect(api.updateArticleWorkflowProject).not.toHaveBeenCalled();
    // 保存入口也不给：这一行在后端只会拿到 409
    expect(screen.getByRole("button", { name: /保存修改/ })).toBeDisabled();
  });

  it("ready 行照旧自动保存（对照，确认闸门没把正常保存一起关掉）", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const ready = captionProject({
      status: "ready" as const,
      progressStage: "ready",
      progressMessage: "已生成完成",
      error: null,
      title: "夏天必囤的咖啡机",
      captionText: "第一次用就回不去了。",
      tags: ["咖啡机"] as readonly string[],
    });
    api.updateArticleWorkflowProject.mockResolvedValue({ ...ready, captionText: "手改一段文案" });
    await renderStudio(ready);

    fireEvent.change(screen.getByLabelText("正文文案"), { target: { value: "手改一段文案" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    expect(api.updateArticleWorkflowProject).toHaveBeenCalledWith(
      "token",
      "article-1",
      expect.objectContaining({ captionText: "手改一段文案" }),
    );
  });

  it("点重试调 retry 端点，该行进入 generating 并交给轮询", async () => {
    const failed = captionProject();
    const generating = captionProject({
      status: "generating" as const,
      progressStage: "queued",
      progressPercent: 0,
      progressMessage: "排队重试中",
      error: null,
    });
    api.retryArticleWorkflowProject.mockResolvedValue({ projectId: "article-1" });
    api.getArticleWorkflowBatch.mockResolvedValue({ batchId: "batch-1", projects: [generating] });
    await renderStudio(failed);

    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));

    await waitFor(() => expect(api.retryArticleWorkflowProject).toHaveBeenCalledWith("token", "article-1"));
    // 进入生成中后由现有轮询接管，界面切到进度态
    await waitFor(() => expect(screen.getByText("排队重试中")).toBeTruthy());
    // 通知栏与 toast 各出现一次
    expect(screen.getAllByText("已重新开始生成").length).toBeGreaterThan(0);
    expect(api.updateArticleWorkflowProject).not.toHaveBeenCalled();
  });

  it("重试请求进行中按钮禁用，防重复点击", async () => {
    // 挂起 retry 请求，观察请求进行中按钮是否禁用
    let release = (): void => undefined;
    api.retryArticleWorkflowProject.mockImplementation(
      () => new Promise((resolve) => {
        release = () => resolve({ projectId: "article-1" });
      }),
    );
    api.getArticleWorkflowBatch.mockResolvedValue({
      batchId: "batch-1",
      projects: [captionProject({ status: "generating" as const, progressMessage: "排队重试中", error: null })],
    });
    await renderStudio(captionProject());

    const button = screen.getByRole("button", { name: "重新生成" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    expect(api.retryArticleWorkflowProject).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => expect(api.getArticleWorkflowBatch).toHaveBeenCalled());
  });
});

describe("自动保存只在内容真的变了才发车", () => {
  function readyProject(overrides: Record<string, unknown> = {}) {
    return captionProject({
      status: "ready" as const,
      progressStage: "ready",
      progressMessage: "已生成完成",
      error: null,
      title: "夏天必囤的咖啡机",
      captionText: "第一次用就回不去了。",
      tags: ["咖啡机"] as readonly string[],
      ...overrides,
    });
  }

  it("改回原样后不再自动保存", async () => {
    // 回归：早先 onChange 一律打脏，1.5s 后必发车。编辑器载入时对内容做的规范化
    // 也被当成用户编辑存回库里，成品被冲掉。现在按 hash 判定，等于原值就撤脏标记。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderStudio(readyProject());

    const input = screen.getByLabelText("正文文案");
    fireEvent.change(input, { target: { value: "改一版" } });
    fireEvent.change(input, { target: { value: "第一次用就回不去了。" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    expect(api.updateArticleWorkflowProject).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /保存修改/ })).toBeDisabled();
  });

  it("原值重复写入不触发保存", async () => {
    // 编辑器把同样的内容再吐一次（规范化后字符串相同）不该产生一次写库
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderStudio(readyProject());

    fireEvent.change(screen.getByLabelText("正文文案"), { target: { value: "第一次用就回不去了。" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    expect(api.updateArticleWorkflowProject).not.toHaveBeenCalled();
  });

  it("真的改了内容照旧自动保存（对照）", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const ready = readyProject();
    api.updateArticleWorkflowProject.mockResolvedValue({ ...ready, captionText: "确实改过了" });
    await renderStudio(ready);

    fireEvent.change(screen.getByLabelText("正文文案"), { target: { value: "确实改过了" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    expect(api.updateArticleWorkflowProject).toHaveBeenCalledWith(
      "token",
      "article-1",
      expect.objectContaining({ captionText: "确实改过了" }),
    );
  });
});
