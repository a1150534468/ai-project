// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NovelContextInspector } from "./NovelContextInspector";

const api = vi.hoisted(() => ({
  getNovelSetup: vi.fn(),
  listNovelCharacters: vi.fn(),
  listNovelProps: vi.fn(),
  listNovelStorylines: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api")>(),
  ...api,
}));
vi.mock("@iconify/react", () => ({ Icon: ({ icon }: { readonly icon: string }) => <span data-icon={icon} /> }));

describe("NovelContextInspector chapter context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const pending = () => new Promise<never>(() => undefined);
    api.getNovelSetup.mockImplementation(pending);
    api.listNovelCharacters.mockImplementation(pending);
    api.listNovelProps.mockImplementation(pending);
    api.listNovelStorylines.mockImplementation(pending);
  });

  it("reuses setup characters and storylines instead of requesting them twice", async () => {
    api.getNovelSetup.mockResolvedValue({ bible: null, locations: [], characters: [{ id: "c1", name: "目录角色" }], storylines: [{ id: "s1", title: "目录故事线" }] });
    api.listNovelProps.mockResolvedValue([]);
    render(<NovelContextInspector token="token" projectId="project-1" chapter={null} workbench={null} isReviewSaving={false} onSaveReview={vi.fn()} onAnalyze={vi.fn()} />);
    await act(async () => {});
    expect(api.getNovelSetup).toHaveBeenCalledTimes(1);
    expect(api.listNovelProps).toHaveBeenCalledTimes(1);
    expect(api.listNovelCharacters).not.toHaveBeenCalled();
    expect(api.listNovelStorylines).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "人物" }));
    expect(screen.getByText("目录角色")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "故事线" }));
    expect(screen.getByText("目录故事线")).toBeVisible();
  });

  it("shows the selected chapter snapshot instead of next-chapter highlights", () => {
    const chapter = {
      id: "chapter-32",
      volumeIndex: 1,
      chapterIndex: 32,
      title: "物理抹杀协议",
      summary: "本章摘要",
      outline: "本章大纲",
      content: "正文",
      contextSnapshot: {
        focusCard: { mission: "第32章实际任务", conflict: "第32章实际冲突", endingHook: "第32章实际钩子" },
        microBeats: [{ index: 1, label: "第32章场景落位", targetWords: 640, objective: "定位第32章场景" }],
        continuityAlerts: [{ title: "第32章实际提醒", detail: "检查本章连续性" }],
      },
      status: "ready",
      billableChars: 2,
      lastTaskId: "task-32",
      updatedAt: "2026-07-16T06:00:00.000Z",
    };
    const workbench = {
      project: { id: "project-1", title: "测试小说", genre: "科幻", status: "active", createdAt: "", updatedAt: "" },
      stats: { totalWords: 2, finishedChapters: 1, completionRate: 100, averageWords: 2, lastUpdate: "" },
      chapters: [chapter],
      knowledgeFacts: [],
      foreshadowItems: [],
      workbenchHighlights: {
        focusChapterNumber: 33,
        focusCard: { mission: "第33章下一任务", conflict: "第33章下一冲突", endingHook: "第33章下一钩子" },
        microBeats: [{ index: 1, label: "第33章节拍", targetWords: 700, objective: "推进第33章" }],
        continuityAlerts: [{ title: "第33章下一提醒", detail: "检查下一章连续性" }],
      },
    };

    render(<NovelContextInspector token="token" projectId="project-1" chapter={chapter} workbench={workbench} isReviewSaving={false} onSaveReview={vi.fn()} onAnalyze={vi.fn()} />);

    expect(screen.getByText("第32章实际任务")).toBeVisible();
    expect(screen.getByText(/第32章场景落位/)).toBeVisible();
    expect(screen.getByText(/第32章实际提醒/)).toBeVisible();
    expect(screen.queryByText("第33章下一任务")).not.toBeInTheDocument();
    expect(screen.queryByText(/第33章节拍/)).not.toBeInTheDocument();
    expect(screen.queryByText(/第33章下一提醒/)).not.toBeInTheDocument();
  });
});
