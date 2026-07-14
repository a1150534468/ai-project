import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NovelIntelligenceWorkspace } from "./NovelIntelligenceWorkspace";
import { NovelRunCockpit } from "./NovelRunCockpit";

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
});
