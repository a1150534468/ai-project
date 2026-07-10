import { describe, expect, it } from "vitest";
import { AGENT_TEAM_RUN_STATUS, confirmTeamBodySchema } from "./agent-team-types.js";

function validMember(index: number) {
  return {
    name: `成员${index}`,
    role: "执行者",
    responsibility: `负责第 ${index} 部分`,
    systemPrompt: `你负责第 ${index} 部分并输出可验收结果。`,
    skills: ["分析"],
    isCore: false,
  };
}

describe("agent team schemas", () => {
  it("includes the team rejected status", () => {
    expect(AGENT_TEAM_RUN_STATUS.teamRejected).toBe("team_rejected");
  });

  it("requires confirmed teams to have between three and ten members", () => {
    const base = {
      teamName: "确认团队",
      teamDescription: "用户确认后的团队",
      members: [validMember(1), validMember(2), validMember(3)],
    };

    expect(confirmTeamBodySchema.safeParse(base).success).toBe(true);
    expect(confirmTeamBodySchema.safeParse({ ...base, members: [validMember(1), validMember(2)] }).success).toBe(false);
    expect(confirmTeamBodySchema.safeParse({
      ...base,
      members: Array.from({ length: 11 }, (_, index) => validMember(index + 1)),
    }).success).toBe(false);
  });

  it("rejects blank skills in confirmed teams", () => {
    const result = confirmTeamBodySchema.safeParse({
      teamName: "确认团队",
      teamDescription: "用户确认后的团队",
      members: [
        { ...validMember(1), skills: ["法务", " "] },
        validMember(2),
        validMember(3),
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects oversized fields in confirmed teams", () => {
    const base = {
      teamName: "确认团队",
      teamDescription: "用户确认后的团队",
      mainAgentPrompt: "主 Agent 负责验收。",
      members: [validMember(1), validMember(2), validMember(3)],
    };

    expect(confirmTeamBodySchema.safeParse({ ...base, teamName: "名".repeat(81) }).success).toBe(false);
    expect(confirmTeamBodySchema.safeParse({ ...base, teamDescription: "描述".repeat(251) }).success).toBe(false);
    expect(confirmTeamBodySchema.safeParse({ ...base, mainAgentPrompt: "主".repeat(4001) }).success).toBe(false);
    expect(confirmTeamBodySchema.safeParse({
      ...base,
      members: [{ ...validMember(1), systemPrompt: "太短" }, validMember(2), validMember(3)],
    }).success).toBe(false);
    expect(confirmTeamBodySchema.safeParse({
      ...base,
      members: [{ ...validMember(1), skills: Array.from({ length: 9 }, (_, index) => `技能${index + 1}`) }, validMember(2), validMember(3)],
    }).success).toBe(false);
  });

  it("rejects unknown fields in confirmed teams", () => {
    const result = confirmTeamBodySchema.safeParse({
      teamName: "确认团队",
      teamDescription: "用户确认后的团队",
      members: [validMember(1), validMember(2), validMember(3)],
      unexpected: "不要静默吞掉",
    });

    expect(result.success).toBe(false);
  });

  it("rejects unknown member fields in confirmed teams", () => {
    const result = confirmTeamBodySchema.safeParse({
      teamName: "确认团队",
      teamDescription: "用户确认后的团队",
      members: [
        { ...validMember(1), unexpected: "不要静默吞掉" },
        validMember(2),
        validMember(3),
      ],
    });

    expect(result.success).toBe(false);
  });
});
