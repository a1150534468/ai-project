// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NovelEngineEvent, NovelEngineRun, NovelEngineStep, NovelNarrativeDashboard } from "../../api";
import { NovelRunCockpit } from "./NovelRunCockpit";

const api = vi.hoisted(() => ({
  controlNovelEngineRun: vi.fn(),
  exportNovelProject: vi.fn(),
  getNovelEngineRun: vi.fn(),
  getNovelNarrativeDashboard: vi.fn(),
  importNovelProject: vi.fn(),
  listNovelEngineEvents: vi.fn(),
  listNovelEngineRuns: vi.fn(),
  startNovelAutopilotRun: vi.fn(),
  streamNovelEngineEvents: vi.fn(),
}));

vi.mock("../../api", () => api);

const run: NovelEngineRun = {
  id: "run-1",
  projectId: "project-1",
  mode: "autopilot",
  status: "writing",
  currentStep: "writeChapter",
  currentChapter: 1,
  targetChapters: 100,
  targetCharsPerChapter: 3000,
  autoReview: true,
  completedChapters: 0,
  consecutiveFailures: 0,
  pauseRequested: false,
  cancelRequested: false,
  error: null,
  createdAt: "2026-07-15T09:00:00.000Z",
  updatedAt: "2026-07-15T09:00:00.000Z",
};

const event: NovelEngineEvent = {
  id: "event-1",
  runId: run.id,
  projectId: run.projectId,
  sequence: 1,
  type: "runQueued",
  stage: "queued",
  step: null,
  chapterNumber: 1,
  progress: 0,
  payload: {},
  createdAt: "2026-07-15T09:00:00.000Z",
};

function chapterChunk(sequence: number, text: string): NovelEngineEvent {
  return {
    ...event,
    id: `chunk-${sequence}`,
    sequence,
    type: "chapterChunk",
    stage: "writing",
    step: "writeChapter",
    progress: 50,
    payload: { text },
  };
}

const dashboard: NovelNarrativeDashboard = {
  project: { storyPhase: "opening", autopilotStatus: "writing", currentBranch: "main" },
  stats: { chapters: 0, totalChars: 0, openForeshadows: 0, storylines: 0, debts: 0, facts: 0, characters: 0 },
  tensionCurve: [],
};

describe("NovelRunCockpit live events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listNovelEngineRuns.mockResolvedValue([run]);
    api.getNovelNarrativeDashboard.mockResolvedValue(dashboard);
    api.getNovelEngineRun.mockResolvedValue({ run, steps: [] });
    api.listNovelEngineEvents.mockResolvedValue({ events: [event], cursor: event.sequence });
    api.streamNovelEngineEvents.mockImplementation(({ signal }: { readonly signal?: AbortSignal }) => new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener("abort", () => resolve(), { once: true });
    }));
  });

  it("keeps the current log and SSE connection when the parent callback changes", async () => {
    const view = render(<NovelRunCockpit token="token" projectId="project-1" nextChapter={1} onProjectChanged={vi.fn()} />);

    expect(await screen.findByText("运行已入队")).toBeVisible();
    expect(api.listNovelEngineEvents).toHaveBeenCalledTimes(1);

    view.rerender(<NovelRunCockpit token="token" projectId="project-1" nextChapter={1} onProjectChanged={vi.fn()} />);

    await waitFor(() => expect(api.listNovelEngineEvents).toHaveBeenCalledTimes(1));
    expect(screen.getByText("运行已入队")).toBeVisible();
  });

  it("shows real model progress instead of leaving the write step at one percent", async () => {
    const step: NovelEngineStep = {
      id: "step-1",
      runId: run.id,
      sequence: 3,
      kind: "writeChapter",
      status: "running",
      chapterNumber: 1,
      attempt: 1,
      progress: 1,
      input: {},
      output: null,
      error: null,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      startedAt: run.createdAt,
      completedAt: null,
      taskProgress: {
        status: "running",
        percent: 63,
        stage: "streaming",
        message: "模型正在流式生成，已接收 1,680 字",
        streamedChars: 1680,
        updatedAt: run.updatedAt,
      },
    };
    api.getNovelEngineRun.mockResolvedValue({ run, steps: [step] });

    render(<NovelRunCockpit token="token" projectId="project-1" nextChapter={1} />);

    expect(await screen.findByText("running · 63%")).toBeVisible();
    expect(screen.getByText("模型正在流式生成，已接收 1,680 字")).toBeVisible();
    expect(screen.getByText("已接收 1,680 字")).toBeVisible();
  });

  it("follows streamed prose until the user scrolls up, then resumes at the bottom", async () => {
    let emitEvent: ((next: NovelEngineEvent) => void) | undefined;
    api.streamNovelEngineEvents.mockImplementation(({ onEvent, signal }: { readonly onEvent: (next: NovelEngineEvent) => void; readonly signal?: AbortSignal }) => {
      emitEvent = onEvent;
      return new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    render(<NovelRunCockpit token="token" projectId="project-1" nextChapter={1} />);
    await waitFor(() => expect(emitEvent).toBeTypeOf("function"));

    act(() => emitEvent?.(chapterChunk(2, "第一段。")));
    const preview = await screen.findByTestId("novel-stream-preview");
    const previewShell = screen.getByTestId("novel-stream-preview-shell");
    expect(previewShell).toHaveClass("flex-1");
    expect(previewShell.className).not.toContain("max-h-52");
    expect(preview).not.toContainElement(screen.getByText("正文流式预览"));
    Object.defineProperty(preview, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(preview, "clientHeight", { configurable: true, value: 200 });
    preview.scrollTop = 100;

    act(() => emitEvent?.(chapterChunk(3, "第二段。")));
    await waitFor(() => expect(preview.scrollTop).toBe(1000));
    expect(screen.getByText("自动跟随")).toBeVisible();

    fireEvent.wheel(preview, { deltaY: -120 });
    preview.scrollTop = 250;
    fireEvent.scroll(preview);
    expect(screen.getByRole("button", { name: "回到最新" })).toBeVisible();

    act(() => emitEvent?.(chapterChunk(4, "第三段。")));
    await waitFor(() => expect(preview).toHaveTextContent("第三段。"));
    expect(preview.scrollTop).toBe(250);

    preview.scrollTop = 760;
    fireEvent.scroll(preview);
    expect(screen.queryByRole("button", { name: "回到最新" })).not.toBeInTheDocument();

    Object.defineProperty(preview, "scrollHeight", { configurable: true, value: 1200 });
    act(() => emitEvent?.(chapterChunk(5, "第四段。")));
    await waitFor(() => expect(preview.scrollTop).toBe(1200));

    preview.scrollTop = 300;
    fireEvent.scroll(preview);
    fireEvent.click(screen.getByRole("button", { name: "回到最新" }));
    expect(preview.scrollTop).toBe(1200);
    expect(screen.getByText("自动跟随")).toBeVisible();
  });

  it("keeps run history inside autopilot and collapsed by default", async () => {
    const previousRun: NovelEngineRun = {
      ...run,
      id: "run-previous",
      mode: "assisted",
      status: "completed",
      currentStep: "finalizeChapter",
      completedChapters: 1,
      createdAt: "2026-07-14T09:00:00.000Z",
      updatedAt: "2026-07-14T09:03:00.000Z",
    };
    api.listNovelEngineRuns.mockResolvedValue([run, previousRun]);

    render(<NovelRunCockpit token="token" projectId="project-1" nextChapter={1} />);

    const toggle = await screen.findByRole("button", { name: "展开运行历史" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("辅助写作 · 已完成")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "收起运行历史" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("辅助写作 · 已完成")).toBeVisible();
  });

  it("starts a new iteration from chapter thirty-one after a completed thirty-chapter run", async () => {
    const completedRun: NovelEngineRun = {
      ...run,
      status: "completed",
      currentStep: "finalizeChapter",
      currentChapter: 30,
      targetChapters: 30,
      completedChapters: 30,
    };
    const nextRun: NovelEngineRun = {
      ...completedRun,
      id: "run-2",
      status: "queued",
      currentStep: "prepareChapter",
      currentChapter: 31,
      targetChapters: 60,
    };
    api.listNovelEngineRuns.mockResolvedValue([completedRun]);
    api.getNovelEngineRun.mockResolvedValue({ run: completedRun, steps: [] });
    api.startNovelAutopilotRun.mockResolvedValue(nextRun);

    render(<NovelRunCockpit token="token" projectId="project-1" nextChapter={31} />);

    const targetInput = await screen.findByRole("textbox", { name: "目标章节" });
    await waitFor(() => expect(targetInput).toHaveValue("30"));
    fireEvent.change(targetInput, { target: { value: "60" } });
    expect(targetInput).toHaveValue("60");
    fireEvent.click(screen.getByRole("button", { name: "启动全托管" }));

    await waitFor(() => expect(api.startNovelAutopilotRun).toHaveBeenCalledWith("token", "project-1", {
      targetChapters: 60,
      targetCharsPerChapter: 3000,
      startChapter: 31,
      autoReview: true,
    }));
  });
});
