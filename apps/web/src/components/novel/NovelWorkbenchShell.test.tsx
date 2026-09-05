// @vitest-environment jsdom

/**
 * 工作台外壳自己的用例。这一层只做三件事：画 header、切工作区、把「这本书还没设置完」说出来，
 * 面板里的活全是子组件的 —— 所以八个子面板一律换成一行探针，断言只落在外壳自己渲染的东西上。
 *
 * 在这之前外壳没有用例文件：两个容器用例（NovelWorkflowStudio{,.live}.test.tsx）都拿探针把它整块替掉，
 * 于是那条警告条在原有用例里根本没有落脚的地方。
 */
import "@testing-library/jest-dom";
import type { ComponentProps } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NovelProjectDetail } from "../../api";
import { NovelWorkbenchShell } from "./NovelWorkbenchShell";

const api = vi.hoisted(() => ({ getNovelStructure: vi.fn() }));

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  ...api,
}));

vi.mock("./NovelStructureSidebar", () => ({ NovelStructureSidebar: () => <div data-testid="structure-sidebar" /> }));
vi.mock("./NovelChapterDesk", () => ({ NovelChapterDesk: () => <div data-testid="chapter-desk" /> }));
vi.mock("./NovelContextInspector", () => ({ NovelContextInspector: () => <div data-testid="context-inspector" /> }));
vi.mock("./NovelModelSelector", () => ({ NovelModelSelector: () => <div data-testid="model-selector" /> }));
vi.mock("./NovelRunCockpit", () => ({ NovelRunCockpit: () => <div data-testid="run-cockpit" /> }));
vi.mock("./NovelIntelligenceWorkspace", () => ({ NovelIntelligenceWorkspace: () => <div data-testid="intelligence-workspace" /> }));
vi.mock("./NovelBibleWorkspace", () => ({ NovelBibleWorkspace: () => <div data-testid="bible-workspace" /> }));
vi.mock("./NovelPromptWorkbench", () => ({ NovelPromptWorkbench: () => <div data-testid="prompt-workbench" /> }));

const PROJECT: NovelProjectDetail["project"] = {
  id: "project-1",
  title: "长夜纪元",
  genre: "男频 · 东方玄幻",
  premise: "被逐出宗门的阵法师听见古阵残响。",
  settings: {},
  generationPrefs: {},
  targetChapters: 100,
  targetCharsPerChapter: 3200,
  setupStage: 5,
  setupCompleted: true,
  storyPhase: "development",
  autopilotStatus: "idle",
  currentBranch: "main",
  status: "active",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

function makeDetail(setupCompleted: boolean): NovelProjectDetail {
  return { project: { ...PROJECT, setupCompleted }, bible: null, chapters: [], tasks: [] };
}

type ShellProps = ComponentProps<typeof NovelWorkbenchShell>;

const noop = () => {};

/** 子面板都是探针，所以除了 `detail` 和那几条状态文案，其余给什么都不影响断言。 */
function makeProps(overrides: Partial<ShellProps> = {}): ShellProps {
  return {
    token: "token",
    detail: makeDetail(true),
    workbench: null,
    selectedChapter: null,
    selectedChapterId: "",
    chapterTitle: "",
    chapterSummary: "",
    chapterOutline: "",
    generationHint: "",
    chapterContent: "",
    targetChars: "3200",
    saveStatus: "idle",
    isGenerating: false,
    isRewriting: false,
    isReviewSaving: false,
    writingModel: "claude-opus-5",
    isModelSaving: false,
    notice: "",
    error: "",
    onBackToLibrary: noop,
    onOpenSetup: noop,
    onRefresh: noop,
    onSelectChapter: noop,
    onCreateChapter: noop,
    onTitleChange: noop,
    onSummaryChange: noop,
    onOutlineChange: noop,
    onGenerationHintChange: noop,
    onContentChange: noop,
    onTargetCharsChange: noop,
    onGenerate: noop,
    onRewrite: async () => {},
    onAnalyze: noop,
    onSaveReview: noop,
    onVersionRestored: noop,
    onWritingModelChange: noop,
    ...overrides,
  };
}

/** 结构树是挂上来就拉的，渲染完先把那一轮 setState 冲掉，免得每条用例都带个 act 警告。 */
async function renderShell(overrides: Partial<ShellProps> = {}) {
  const props = makeProps(overrides);
  const view = render(<NovelWorkbenchShell {...props} />);
  await act(async () => {});
  return { ...view, props };
}

beforeEach(() => {
  api.getNovelStructure.mockReset().mockResolvedValue([]);
});

describe("NovelWorkbenchShell 设置未完成提示", () => {
  it("设置没做完就挂一条警告条，并给一条回向导的路", async () => {
    await renderShell({ detail: makeDetail(false) });

    expect(screen.getByRole("status")).toHaveTextContent("这本书的新书设置还没做完");
    expect(screen.getByRole("button", { name: "继续设置" })).toBeInTheDocument();
  });

  it("设置做完了就不挂", async () => {
    await renderShell({ detail: makeDetail(true) });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续设置" })).not.toBeInTheDocument();
  });

  it("点「继续设置」把向导叫回来", async () => {
    const onOpenSetup = vi.fn();
    await renderShell({ detail: makeDetail(false), onOpenSetup });

    fireEvent.click(screen.getByRole("button", { name: "继续设置" }));

    expect(onOpenSetup).toHaveBeenCalledTimes(1);
  });

  // 「设置没做完」是个常驻状态，不是某个工作区的事，所以它挂在工作区外面
  it("切到别的工作区那条还在", async () => {
    await renderShell({ detail: makeDetail(false) });

    fireEvent.click(screen.getByRole("button", { name: /全托管/ }));

    expect(screen.getByTestId("run-cockpit")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("这本书的新书设置还没做完");
  });

  // 警告条是常驻状态、error/notice 是这一刻的回执，两条各占一行，别互相顶掉
  it("和报错条各占一条", async () => {
    await renderShell({ detail: makeDetail(false), error: "生成失败" });

    expect(screen.getByRole("status")).toHaveTextContent("这本书的新书设置还没做完");
    expect(screen.getByText("生成失败")).toBeInTheDocument();
  });
});
