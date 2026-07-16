import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NovelChapterIntelligencePanel } from "./NovelChapterIntelligencePanel";
import { NovelReviewPanel } from "./NovelReviewPanel";
import { NovelWorkflowStudio } from "./NovelWorkflowStudio";

describe("NovelWorkflowStudio", () => {
  it("uses the project brand accent instead of a separate novel accent", () => {
    const html = renderToStaticMarkup(<NovelWorkflowStudio token="token" />);

    expect(html).not.toContain("#b8502d");
    expect(html).not.toContain("#d7a08b");
    expect(html).toContain("bg-brand");
  });

  it("renders the PlotPilot-style premise-first library and create foundry", () => {
    const html = renderToStaticMarkup(<NovelWorkflowStudio token="token" />);

    expect(html).toContain("长篇叙事工作台");
    expect(html).toContain("故事梗概");
    expect(html).toContain("市场分区");
    expect(html).toContain("目标篇幅");
    expect(html).toContain("建档并进入设置向导");
    expect(html).toContain('data-novel-scroll-region="library"');
    expect(html).toContain("overflow-y-auto");
    expect(html).not.toContain("核心要求");
    expect(html).not.toContain("是否金手指");
    expect(html).not.toContain("频道");
    expect(html).not.toContain("是否金手指");
    expect(html).not.toContain("新建当前输入");
  });

  it("does not render the roleplay stage", () => {
    const html = renderToStaticMarkup(<NovelWorkflowStudio token="token" />);

    expect(html).not.toContain("扮演");
    expect(html).not.toContain("roleplay");
  });

  it("includes workbench intelligence labels in panel smoke output", () => {
    const workbench = {
      project: { id: "project-1", title: "长夜纪元", genre: "玄幻", status: "active", createdAt: "", updatedAt: "" },
      stats: { totalWords: 10, finishedChapters: 1, completionRate: 10, averageWords: 10, lastUpdate: "" },
      chapters: [{
        id: "chapter-1",
        volumeIndex: 1,
        chapterIndex: 1,
        title: "寒泉院",
        summary: "沈九泠发现锁灵坠。",
        content: "正文",
        consistencyJson: { status: "warning", quality: { score: 70, styleRisk: "medium" } },
        status: "ready",
        reviewStatus: "pending" as const,
        reviewNotes: "",
        aiReview: "诊断：质量分 70 /100",
        aiActionItems: ["补足场景"],
        modificationRate: 0,
        billableChars: 2,
        lastTaskId: null,
        updatedAt: "",
      }],
      knowledgeFacts: [{ subject: "锁灵坠", predicate: "能力", object: "护住心脉" }],
      foreshadowItems: [{ title: "锁灵坠来历", status: "open", expectedPayoffChapter: 4 }],
      workbenchHighlights: {
        focusChapterNumber: 2,
        recommendedFocus: "回收伏笔",
        continuityAlerts: [{ title: "伏笔接近回收窗口", detail: "优先处理" }],
        microBeats: [{ index: 1, label: "场景落位", targetWords: 600, objective: "定位场景" }],
        focusCard: { mission: "推进主线", conflict: "制造阻力", endingHook: "留下问题" },
        qualitySnapshot: { consistencyStatus: "warning", styleRisk: "medium" },
        workflowGate: { status: "warning" },
      },
    };
    const html = renderToStaticMarkup(
      <>
        <NovelChapterIntelligencePanel chapter={workbench.chapters[0]} workbench={workbench} />
        <NovelReviewPanel chapter={workbench.chapters[0]} isSaving={false} onSave={() => undefined} onAnalyze={() => undefined} />
      </>,
    );

    expect(html).toContain("章节情报");
    expect(html).toContain("审阅");
    expect(html).toContain("质量诊断");
  });
});
