import { describe, expect, it } from "vitest";
import { recommendationFromRunSnapshot } from "./agentTeamRunState";
import type { AgentWorkflowRunDto } from "./agentTeamApi";

function runWithSnapshot(teamSnapshot: unknown): AgentWorkflowRunDto {
  return {
    id: "run-1",
    teamId: null,
    taskGoal: "审查合同",
    status: "awaiting_team_confirmation",
    teamSnapshot,
    planSnapshot: {},
    finalReport: "",
    error: null,
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    completedAt: null,
    cancelledAt: null,
    steps: [],
    events: [],
  };
}

describe("agentTeamRunState", () => {
  it("restores a team recommendation from an awaiting run snapshot", () => {
    const recommendation = recommendationFromRunSnapshot(runWithSnapshot({
      teamName: "合同审查团队",
      teamDescription: "审查合同风险",
      mainAgentPrompt: "统筹审查",
      members: [{
        name: "法务专家",
        role: "Reviewer",
        responsibility: "检查法律风险",
        systemPrompt: "你负责检查法律风险。",
        skills: ["合同审查"],
        isCore: true,
      }],
    }));

    expect(recommendation?.teamName).toBe("合同审查团队");
    expect(recommendation?.members[0]?.name).toBe("法务专家");
  });

  it("does not restore a recommendation for completed runs", () => {
    const run = runWithSnapshot({ teamName: "合同审查团队", members: [] });
    expect(recommendationFromRunSnapshot({ ...run, status: "succeeded" })).toBeNull();
  });
});
