// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NovelChapterDesk } from "./NovelChapterDesk";

const api = vi.hoisted(() => ({
  listNovelChapterVersions: vi.fn(),
  listNovelGenerationRequests: vi.fn(),
  restoreNovelChapterVersion: vi.fn(),
}));
vi.mock("../../api", () => api);
vi.mock("@iconify/react", () => ({ Icon: ({ icon }: { readonly icon: string }) => <span data-icon={icon} /> }));

describe("NovelChapterDesk prompt audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listNovelGenerationRequests.mockResolvedValue([{
      id: "request-1", projectId: "project-1", chapterId: "chapter-1", chapterIndex: 1, taskId: "task-1", runId: "run-1", stepId: "step-1",
      targetKind: "chapter", attempt: 1, systemPrompt: "系统提示词原文", userPrompt: "用户提示词原文", model: "audit-model", temperature: 0.4,
      maxTokens: 6000, templateId: null, templateVersion: null, requestHash: "hash", status: "succeeded", error: null,
      createdAt: "2026-07-16T06:00:00.000Z", updatedAt: "2026-07-16T06:01:00.000Z",
    }]);
    api.listNovelChapterVersions.mockResolvedValue([]);
  });

  it("shows the exact system and user prompts sent for the selected chapter", async () => {
    render(<NovelChapterDesk
      chapter={{ id: "chapter-1", volumeIndex: 1, chapterIndex: 1, title: "第一章", summary: "", content: "正文", status: "ready", billableChars: 2, lastTaskId: "task-1", updatedAt: "2026-07-16T06:00:00.000Z" }}
      token="token" projectId="project-1" chapterTitle="第一章" chapterSummary="" chapterOutline="" generationHint="" chapterContent="正文" targetChars="3000" saveStatus="saved" isGenerating={false} isRewriting={false}
      onTitleChange={vi.fn()} onSummaryChange={vi.fn()} onOutlineChange={vi.fn()} onGenerationHintChange={vi.fn()} onContentChange={vi.fn()} onTargetCharsChange={vi.fn()} onGenerate={vi.fn()} onRewrite={vi.fn()} onAnalyze={vi.fn()} onVersionRestored={vi.fn()}
    />);

    expect(screen.queryByRole("button", { name: "执行剧本" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "微节拍" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /写作要求/ }));
    expect(screen.getByText("章节大纲")).toBeVisible();
    expect(screen.getByText("生成约束")).toBeVisible();
    expect(screen.queryByText("执行剧本（结构化）")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /提示词记录/ }));

    expect(await screen.findByText("系统提示词原文")).toBeVisible();
    expect(screen.getByText("用户提示词原文")).toBeVisible();
    expect(api.listNovelGenerationRequests).toHaveBeenCalledWith("token", "project-1", 1);
    expect(screen.getByText("实际发送")).toBeVisible();
  });

  it("lets the prose editor fill the available browser width and height", () => {
    render(<NovelChapterDesk
      chapter={{ id: "chapter-1", volumeIndex: 1, chapterIndex: 1, title: "第一章", summary: "概要", content: "正文", status: "ready", billableChars: 2, lastTaskId: "task-1", updatedAt: "2026-07-16T06:00:00.000Z" }}
      token="token" projectId="project-1" chapterTitle="第一章" chapterSummary="概要" chapterOutline="" generationHint="" chapterContent="正文" targetChars="3000" saveStatus="saved" isGenerating={false} isRewriting={false}
      onTitleChange={vi.fn()} onSummaryChange={vi.fn()} onOutlineChange={vi.fn()} onGenerationHintChange={vi.fn()} onContentChange={vi.fn()} onTargetCharsChange={vi.fn()} onGenerate={vi.fn()} onRewrite={vi.fn()} onAnalyze={vi.fn()} onVersionRestored={vi.fn()}
    />);

    const layout = screen.getByTestId("novel-chapter-prose-layout");
    const editor = screen.getByPlaceholderText("在这里写作，或点击右上角生成正文……");
    expect(layout).toHaveClass("min-h-full", "w-full", "flex-col");
    expect(layout.className).toContain("max-w-[clamp(920px,82vw,1480px)]");
    expect(editor).toHaveClass("flex-1", "min-h-[320px]", "overflow-y-auto");
    expect(editor.className).not.toContain("min-h-[650px]");
  });
});
