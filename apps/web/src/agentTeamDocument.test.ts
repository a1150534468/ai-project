import { describe, expect, it } from "vitest";
import { buildRunDocument } from "./agentTeamDocument";
import type { AgentWorkflowRunDto, AgentWorkflowStepDto } from "./agentTeamApi";

function step(partial: Partial<AgentWorkflowStepDto>): AgentWorkflowStepDto {
  return {
    id: "s",
    memberName: "成员",
    memberSnapshot: null,
    title: "步骤",
    goal: "",
    input: null,
    output: "",
    status: "succeeded",
    position: 0,
    retryCount: 0,
    error: null,
    startedAt: null,
    completedAt: null,
    ...partial,
  };
}

function run(partial: Partial<AgentWorkflowRunDto>): AgentWorkflowRunDto {
  return {
    id: "r",
    teamId: null,
    taskGoal: "测试任务",
    status: "succeeded",
    teamSnapshot: null,
    planSnapshot: null,
    finalReport: "",
    error: null,
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T02:30:00.000Z",
    completedAt: "2026-07-06T02:30:00.000Z",
    cancelledAt: null,
    steps: [],
    events: [],
    ...partial,
  };
}

describe("buildRunDocument", () => {
  it("汇总各步骤输出为完整文档，按 position 排序", () => {
    const doc = buildRunDocument(run({
      taskGoal: "能碳文档补充",
      finalReport: "最终结论内容",
      steps: [
        step({ id: "b", title: "第二步", memberName: "数据专员", output: "第二步正文", position: 2 }),
        step({ id: "a", title: "第一步", memberName: "需求分析师", output: "第一步正文", position: 1 }),
      ],
    }));
    expect(doc.content).toContain("# 能碳文档补充");
    expect(doc.content).toContain("## 最终报告\n\n最终结论内容");
    // 步骤按 position 升序：第一步在第二步之前
    expect(doc.content.indexOf("第一步正文")).toBeLessThan(doc.content.indexOf("第二步正文"));
    expect(doc.content).toContain("### 第一步（需求分析师）");
  });

  it("无最终报告时不输出最终报告段", () => {
    const doc = buildRunDocument(run({ finalReport: "  ", steps: [step({ output: "x" })] }));
    expect(doc.content).not.toContain("## 最终报告");
    expect(doc.content).toContain("## 工作流详细过程");
  });

  it("空步骤输出用占位符", () => {
    const doc = buildRunDocument(run({ steps: [step({ output: "" })] }));
    expect(doc.content).toContain("（本步骤无输出）");
  });

  it("文件名基于任务目标 + 完成时间，剥离非法字符", () => {
    const doc = buildRunDocument(run({ taskGoal: 'a/b:c*d?"e', completedAt: "2026-07-06T12:30:00.000Z" }));
    expect(doc.filename).not.toMatch(/[\\/:*?"<>|]/);
    // 时间戳格式 -YYYYMMDD-HHMM.md（用本地时区，故只校验格式不校验具体值）
    expect(doc.filename).toMatch(/-\d{8}-\d{4}\.md$/);
  });
});
