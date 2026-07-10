import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentWorkflowRunDto } from "../../agentTeamApi";
import { WorkflowRunPanel } from "./WorkflowRunPanel";

function makeRun(overrides: Partial<AgentWorkflowRunDto> = {}): AgentWorkflowRunDto {
  return {
    id: "run-1",
    teamId: "team-1",
    taskGoal: "审查一下这个授权书靠谱不靠谱",
    status: "succeeded",
    teamSnapshot: {},
    planSnapshot: {},
    finalReport: "# 授权书审查结论\n\n**可靠性判断**：需要补充授权范围。",
    error: null,
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:10:00.000Z",
    completedAt: "2026-07-03T00:10:00.000Z",
    cancelledAt: null,
    steps: [{
      id: "step-1",
      memberName: "DocParser",
      memberSnapshot: {},
      title: "解析ICP授权书文档",
      goal: "读取授权书内容",
      input: {},
      output: "已解析授权书正文",
      status: "succeeded",
      position: 0,
      retryCount: 0,
      error: null,
      startedAt: "2026-07-03T00:01:00.000Z",
      completedAt: "2026-07-03T00:02:00.000Z",
    }],
    events: [],
    ...overrides,
  };
}

describe("WorkflowRunPanel", () => {
  it("renders the completed final report as markdown and hides workflow steps by default", () => {
    const html = renderToStaticMarkup(
      <WorkflowRunPanel run={makeRun()} isCancelling={false} onCancel={vi.fn()} />,
    );

    expect(html).toContain("任务已完成");
    expect(html).toContain("任务答案与报告");
    expect(html).toContain("查看工作流");
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>可靠性判断</strong>");
    expect(html).not.toContain("解析ICP授权书文档");
  });

  it("keeps workflow steps visible while a run is still active", () => {
    const html = renderToStaticMarkup(
      <WorkflowRunPanel
        run={makeRun({ status: "running", finalReport: "", completedAt: null })}
        isCancelling={false}
        onCancel={vi.fn()}
      />,
    );

    expect(html).toContain("执行中");
    expect(html).toContain("解析ICP授权书文档");
    expect(html).toContain("工作流完成后会在这里生成完整任务报告。");
  });
});
