import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NovelIntelligenceWorkspace } from "./NovelIntelligenceWorkspace";
import { NovelRunCockpit, novelRunEventScope, novelRunEventText } from "./NovelRunCockpit";
import type { NovelEngineEvent } from "../../api";

describe("novel engine workbench", () => {
  it("renders autopilot controls, resilient pipeline state, and all exports", () => {
    const html = renderToStaticMarkup(<NovelRunCockpit token="token" projectId="project-1" nextChapter={1} />);
    expect(html).toContain("全托管驾驶舱");
    expect(html).toContain("启动全托管");
    expect(html).toContain("实时管线");
    expect(html).toContain("SSE");
    for (const format of ["markdown", "docx", "epub", "pdf"]) expect(html).toContain(format);
  });

  it("renders narrative intelligence, checkpoints, and prompt tooling", () => {
    const html = renderToStaticMarkup(<NovelIntelligenceWorkspace token="token" projectId="project-1" />);
    expect(html).toContain("叙事智能中心");
    expect(html).toContain("角色与关系");
    expect(html).toContain("部卷幕章");
    expect(html).toContain("伏笔与债务");
    expect(html).toContain("检查点");
    expect(html).toContain("提示词工作台");
  });

  it("describes pause events as run state changes instead of repeating step names", () => {
    const event = {
      id: "event-1",
      runId: "run-1",
      projectId: "project-1",
      sequence: 1,
      type: "runStatusChanged",
      stage: "paused",
      step: "validateContent",
      chapterNumber: 5,
      progress: 0,
      payload: { reason: "pauseRequested" },
      createdAt: "2026-07-15T09:00:00.000Z",
    } as NovelEngineEvent;

    expect(novelRunEventScope(event)).toBe("运行");
    expect(novelRunEventText(event)).toBe("已暂停");
  });
});
