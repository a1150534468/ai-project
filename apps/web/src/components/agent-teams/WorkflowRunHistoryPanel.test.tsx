import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentWorkflowRunDto } from "../../agentTeamApi";
import { WorkflowRunHistoryPanel } from "./WorkflowRunHistoryPanel";

function makeRun(overrides: Partial<AgentWorkflowRunDto> = {}): AgentWorkflowRunDto {
  return {
    id: "run-1",
    teamId: "team-1",
    taskGoal: "审查一下这个授权书靠谱不靠谱",
    status: "succeeded",
    teamSnapshot: {},
    planSnapshot: {},
    finalReport: "# 结论\n\n授权书需要补充授权范围后再使用。",
    error: null,
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:10:00.000Z",
    completedAt: "2026-07-03T00:10:00.000Z",
    cancelledAt: null,
    steps: [],
    events: [],
    ...overrides,
  };
}

describe("WorkflowRunHistoryPanel", () => {
  it("renders recent runs with status and report preview", () => {
    const html = renderToStaticMarkup(
      <WorkflowRunHistoryPanel
        runs={[makeRun(), makeRun({ id: "run-2", status: "failed", taskGoal: "审查采购合同", finalReport: "", error: "积分不足，请充值" })]}
        activeRunId="run-1"
        onSelectRun={vi.fn()}
      />,
    );

    expect(html).toContain("Agent 团队运行历史");
    expect(html).toContain("审查一下这个授权书靠谱不靠谱");
    expect(html).toContain("授权书需要补充授权范围后再使用");
    expect(html).toContain("审查采购合同");
    expect(html).toContain("失败");
    expect(html).toContain("积分不足，请充值");
  });

  it("renders an empty state", () => {
    const html = renderToStaticMarkup(
      <WorkflowRunHistoryPanel runs={[]} activeRunId={null} onSelectRun={vi.fn()} />,
    );

    expect(html).toContain("暂无运行历史");
  });

  it("prefers the answer section when previewing an old process-summary report", () => {
    const html = renderToStaticMarkup(
      <WorkflowRunHistoryPanel
        runs={[makeRun({
          finalReport: "# 2024年美国经济发展分析任务报告\n\n## 一、任务目标\n系统性分析2024年美国经济。\n\n## 二、核心结论\n2024年美国经济体现出韧性，通胀回落但利率压力仍在。",
        })]}
        activeRunId={null}
        onSelectRun={vi.fn()}
      />,
    );

    expect(html).toContain("核心结论");
    expect(html).toContain("2024年美国经济体现出韧性");
    expect(html).not.toContain("任务目标");
  });
});
