// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../motion/Toast";
import { ArticleWorkflowStudio } from "./ArticleWorkflowStudio";

const api = vi.hoisted(() => ({
  createArticleWorkflowProject: vi.fn(),
  deleteArticleWorkflowProject: vi.fn(),
  generateArticleWorkflowImages: vi.fn(),
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
    creationMode: "source" as const,
    creationConfig: { mode: "source" as const, generateImages: true },
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

function enterEditMode() {
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
}

beforeEach(() => {
  api.deleteArticleWorkflowProject.mockResolvedValue({ deleted: 1, batchId: "batch-1" });
  api.getArticleWorkflowPricing.mockResolvedValue(null);
  api.listArticleWorkflowHistory.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("ArticleWorkflowStudio 失败行处理", () => {
  it("从工作台顶栏打开项目记录，并可回到新建态", async () => {
    await renderStudio(captionProject());

    fireEvent.click(screen.getByRole("button", { name: "项目历史" }));
    expect(screen.getByRole("dialog", { name: "图文项目记录" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "新建图文" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "图文项目记录" })).toBeNull());
    expect(screen.getByLabelText("文章原文")).toBeTruthy();
  });

  it("failed 行改文案不触发自动保存，并原样显示失败原因", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderStudio(captionProject());

    // 后端存的 error 要能直接看到，不然「哪一行扣费失败、为什么」全靠猜
    expect(screen.getByRole("alert").textContent).toContain("403 Access to model denied");

    enterEditMode();
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

    enterEditMode();
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
    await waitFor(() => expect(screen.getAllByText("排队重试中").length).toBeGreaterThan(0));
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

  it("caption 完成态直接展示底部配图，并可展开 AI 重写", async () => {
    await renderStudio(captionProject({
      status: "ready" as const,
      progressStage: "ready",
      progressMessage: "已生成完成",
      error: null,
      title: "夏天必囤的咖啡机",
    }));

    expect(screen.getByRole("heading", { name: "配图素材" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "配图素材 0" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "AI 重写" }));
    expect(screen.getByLabelText("重新生成要求")).toBeTruthy();
  });

  it("后补图请求进行中禁用按钮，避免重复提交和重复计费", async () => {
    let release = (): void => undefined;
    api.generateArticleWorkflowImages.mockImplementation(
      () => new Promise((resolve) => {
        release = () => resolve({ projectId: "article-1", queued: true });
      }),
    );
    const ready = captionProject({
      status: "ready" as const,
      progressStage: "ready",
      progressMessage: "文案已生成",
      error: null,
      title: "冰咖啡",
      captionText: "先确认文案。",
      creationConfig: {
        mode: "topic" as const,
        generateImages: false,
        topic: "冰咖啡",
        keyPoints: "",
        audience: "",
        avoid: "",
        style: { mode: "preset" as const, preset: "general" as const },
      },
      creationMode: "topic" as const,
      imageManifestJson: [{
        slot: "cover" as const,
        role: "cover" as const,
        assetId: null,
        imageUrl: "",
        thumbnailUrl: "",
        alt: "封面",
        caption: "",
        prompt: "cover prompt",
      }],
    });
    api.getArticleWorkflowBatch.mockResolvedValue({
      batchId: "batch-1",
      projects: [{ ...ready, status: "revising" as const, progressStage: "illustrating" }],
    });
    await renderStudio(ready);

    const button = screen.getByRole("button", { name: "生成配图" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    expect(api.generateArticleWorkflowImages).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => expect(api.getArticleWorkflowBatch).toHaveBeenCalled());
  });
});

describe("ArticleWorkflowStudio 项目历史删除", () => {
  it("删除当前批次时防止重复提交，并在成功后回到新建态", async () => {
    let release = (): void => undefined;
    api.deleteArticleWorkflowProject.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ deleted: 1, batchId: "batch-1" });
    }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const ready = captionProject({
      title: "冰咖啡项目",
      status: "ready" as const,
      progressStage: "ready",
      error: null,
    });
    render(
      <ToastProvider>
        <ArticleWorkflowStudio
          token="token"
          initialHistory={[ready as never]}
          initialProject={ready as never}
          initialBootstrapping={false}
        />
      </ToastProvider>,
    );
    await act(async () => { await Promise.resolve(); });

    const deleteButton = screen.getByRole("button", { name: "删除 冰咖啡项目" });
    fireEvent.click(deleteButton);
    await waitFor(() => expect(deleteButton).toBeDisabled());
    fireEvent.click(deleteButton);
    expect(api.deleteArticleWorkflowProject).toHaveBeenCalledTimes(1);
    expect(api.deleteArticleWorkflowProject).toHaveBeenCalledWith("token", "article-1");

    release();
    await waitFor(() => expect(screen.getByLabelText("文章原文")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "删除 冰咖啡项目" })).toBeNull();
  });

  it("取消确认时保留历史项目", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const ready = captionProject({
      title: "保留项目",
      status: "ready" as const,
      progressStage: "ready",
      error: null,
    });
    render(
      <ToastProvider>
        <ArticleWorkflowStudio
          token="token"
          initialHistory={[ready as never]}
          initialProject={ready as never}
          initialBootstrapping={false}
        />
      </ToastProvider>,
    );
    await act(async () => { await Promise.resolve(); });

    fireEvent.click(screen.getByRole("button", { name: "删除 保留项目" }));

    expect(api.deleteArticleWorkflowProject).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "删除 保留项目" })).toBeTruthy();
  });
});

describe("ArticleWorkflowStudio 主题创作", () => {
  it("keeps all creation inputs in the left configuration panel and reserves the workspace for output", async () => {
    render(
      <ToastProvider>
        <ArticleWorkflowStudio
          token="token"
          initialHistory={[]}
          initialProject={null}
          initialBootstrapping={false}
        />
      </ToastProvider>,
    );
    await act(async () => { await Promise.resolve(); });

    const config = screen.getByRole("region", { name: "图文生成配置" });
    const output = screen.getByRole("region", { name: "实时输出预览" });
    expect(within(config).getByLabelText("文章原文")).toBeTruthy();
    expect(within(config).getByRole("tab", { name: "主题创作" })).toBeTruthy();
    expect(within(output).queryByLabelText("文章原文")).toBeNull();
    expect(within(output).getByText(/在左侧填写素材或主题/)).toBeTruthy();
  });

  it("switches to copy-first by default and validates custom style before submit", async () => {
    render(
      <ToastProvider>
        <ArticleWorkflowStudio
          token="token"
          initialHistory={[]}
          initialProject={null}
          initialBootstrapping={false}
        />
      </ToastProvider>,
    );
    await act(async () => { await Promise.resolve(); });

    fireEvent.click(screen.getByRole("tab", { name: "主题创作" }));
    const imageSwitch = screen.getByRole("switch", { name: "同时生成配图" }) as HTMLInputElement;
    expect(imageSwitch.checked).toBe(false);
    expect(screen.getByRole("button", { name: "生成 3 个平台文案" })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("例如：夏天在家做一杯清爽咖啡"), {
      target: { value: "在家做冰咖啡" },
    });
    expect(screen.getByRole("button", { name: "生成 3 个平台文案" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("tab", { name: "自定义风格" }));
    expect(screen.getByRole("button", { name: "生成 3 个平台文案" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("自定义风格"), {
      target: { value: "先给结论，再分步骤" },
    });
    expect(screen.getByRole("button", { name: "生成 3 个平台文案" })).not.toBeDisabled();
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

    enterEditMode();
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

    enterEditMode();
    fireEvent.change(screen.getByLabelText("正文文案"), { target: { value: "第一次用就回不去了。" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    expect(api.updateArticleWorkflowProject).not.toHaveBeenCalled();
  });

  it("真的改了内容照旧自动保存（对照）", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const ready = readyProject();
    api.updateArticleWorkflowProject.mockResolvedValue({ ...ready, captionText: "确实改过了" });
    await renderStudio(ready);

    enterEditMode();
    fireEvent.change(screen.getByLabelText("正文文案"), { target: { value: "确实改过了" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    expect(api.updateArticleWorkflowProject).toHaveBeenCalledWith(
      "token",
      "article-1",
      expect.objectContaining({ captionText: "确实改过了" }),
    );
  });
});
