import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NovelIntelligenceWorkspace } from "./NovelIntelligenceWorkspace";
import { NovelRunCockpit, novelRunEventScope, novelRunEventText, novelRunEventTime } from "./NovelRunCockpit";
import type { NovelEngineEvent } from "../../api";

describe("novel engine workbench", () => {
  it("renders one focused autopilot view without the duplicate operations tab", () => {
    const html = renderToStaticMarkup(<NovelRunCockpit token="token" projectId="project-1" nextChapter={1} />);
    expect(html).toContain("全托管驾驶舱");
    expect(html).toContain("启动全托管");
    expect(html).toContain("实时管线");
    expect(html).toContain("SSE");
    expect(html).not.toContain("监控与 DAG");
    expect(html).not.toContain("作品导入与导出");
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

  it("formats event prefixes as local 24-hour time", () => {
    const local = new Date(2026, 6, 16, 6, 53, 42).toISOString();
    expect(novelRunEventTime(local)).toBe("06:53:42");
    expect(novelRunEventTime("invalid")).toBe("--:--:--");
  });
});
