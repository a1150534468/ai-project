// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NovelWorkflowStudio } from "./NovelWorkflowStudio";

const api = vi.hoisted(() => ({
  analyzeNovelChapter: vi.fn(),
  createNovelProject: vi.fn(),
  deleteNovelProject: vi.fn(),
  getNovelEngineRun: vi.fn(),
  getNovelProject: vi.fn(),
  getNovelWorkbench: vi.fn(),
  listNovelProjects: vi.fn(),
  rewriteNovelChapterSelection: vi.fn(),
  saveNovelChapter: vi.fn(),
  saveNovelChapterReview: vi.fn(),
  startNovelAssistedRun: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api")>(),
  ...api,
}));

vi.mock("../novel/NovelLibraryPage", () => ({ NovelLibraryPage: () => <div>书库</div> }));
vi.mock("../novel/NovelSetupWizard", () => ({ NovelSetupWizard: () => null }));
vi.mock("../novel/NovelWorkbenchShell", () => ({
  NovelWorkbenchShell: (props: { chapterContent: string; onGenerate: () => void }) => <div><button type="button" onClick={props.onGenerate}>生成正文</button><div data-testid="chapter-content">{props.chapterContent}</div></div>,
}));

const project = {
  id: "project-1",
  title: "测试小说",
  genre: "科幻",
  premise: "程序员重构世界。",
  settings: {},
  targetChapters: 31,
  targetCharsPerChapter: 3000,
  setupStage: 5,
  setupCompleted: true,
  storyPhase: "ending",
  autopilotStatus: "idle",
  currentBranch: "main",
  status: "active",
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
};

function chapter(content: string, updatedAt: string) {
  return {
    id: "chapter-31",
    volumeIndex: 1,
    chapterIndex: 31,
    title: "第 31 章",
    summary: "",
    outline: "",
    generationHint: "",
    executionPlan: {},
    microBeats: [],
    content,
    status: content ? "ready" : "draft",
    reviewStatus: "pending" as const,
    billableChars: content.length,
    lastTaskId: content ? "task-31" : null,
    updatedAt,
  };
}

function detail(content: string, updatedAt: string) {
  return { project: { ...project, updatedAt }, bible: null, chapters: [chapter(content, updatedAt)], tasks: [] };
}

function workbench(content: string, updatedAt: string) {
  return {
    project,
    stats: { totalWords: content.length, finishedChapters: content ? 1 : 0, completionRate: content ? 100 : 0, averageWords: content.length, lastUpdate: updatedAt },
    chapters: [chapter(content, updatedAt)],
    knowledgeFacts: [],
    foreshadowItems: [],
    workbenchHighlights: {},
  };
}

describe("NovelWorkflowStudio live run refresh", () => {
  beforeEach(() => {
    window.location.hash = "#novel/project-1/workbench";
    api.listNovelProjects.mockResolvedValue([]);
    api.getNovelProject
      .mockResolvedValueOnce(detail("", "2026-07-16T00:00:00.000Z"))
      .mockResolvedValue(detail("这是生成完成后的第 31 章正文。", "2026-07-16T00:04:00.000Z"));
    api.getNovelWorkbench
      .mockResolvedValueOnce(workbench("", "2026-07-16T00:00:00.000Z"))
      .mockResolvedValue(workbench("这是生成完成后的第 31 章正文。", "2026-07-16T00:04:00.000Z"));
    api.startNovelAssistedRun.mockResolvedValue({ id: "run-31", status: "queued", currentChapter: 31 });
    api.getNovelEngineRun.mockResolvedValue({ run: { id: "run-31", status: "awaitingReview", currentChapter: 31, error: null }, steps: [] });
    api.saveNovelChapter.mockImplementation(async (_token: string, _projectId: string, _chapterIndex: number, payload: { content?: string }) => chapter(payload.content ?? "", "2026-07-16T00:04:00.000Z"));
  });

  afterEach(() => {
    window.location.hash = "";
    vi.clearAllMocks();
  });

  it("reloads workbench data when an assisted run reaches awaitingReview", async () => {
    render(<NovelWorkflowStudio token="token" />);
    const generate = await screen.findByRole("button", { name: "生成正文" });

    fireEvent.click(generate);

    await waitFor(() => expect(api.getNovelEngineRun).toHaveBeenCalledWith("token", "project-1", "run-31"));
    await waitFor(() => expect(screen.getByTestId("chapter-content")).toHaveTextContent("这是生成完成后的第 31 章正文。"));
    expect(api.getNovelProject.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(api.getNovelWorkbench.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
