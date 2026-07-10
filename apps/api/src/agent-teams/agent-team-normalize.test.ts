import { describe, expect, it } from "vitest";
import { normalizeRecommendedTeam } from "./agent-team-normalize.js";
import { confirmTeamBodySchema } from "./agent-team-types.js";

function validMember(index: number, isCore = false) {
  return {
    name: `成员${index}`,
    role: "执行者",
    responsibility: `负责第 ${index} 部分`,
    systemPrompt: `你负责第 ${index} 部分并输出可验收结果。`,
    skills: ["分析"],
    isCore,
  };
}

const teamBase = { teamName: "测试团队", teamDescription: "测试任务" } as const;

describe("normalizeRecommendedTeam", () => {
  it("pads recommended members to the minimum team size", () => {
    const result = normalizeRecommendedTeam({
      ...teamBase,
      members: [{
        name: "法务合规专家",
        role: "核心执行者",
        responsibility: "识别合同风险",
        systemPrompt: "你负责审查合同合规风险。",
        skills: ["法务"],
        isCore: true,
      }],
    });

    expect(result.members).toHaveLength(3);
    expect(result.members.map((member) => member.name)).toEqual([
      "法务合规专家",
      "任务规划官",
      "资料分析师",
    ]);
  });

  it("pads an empty recommendation to the minimum team size", () => {
    const result = normalizeRecommendedTeam({
      ...teamBase,
      members: [],
    });

    expect(result.members).toHaveLength(3);
    expect(result.members.map((member) => member.name)).toEqual([
      "任务规划官",
      "资料分析师",
      "质量审查官",
    ]);
  });

  it("does not share fallback member objects between calls", () => {
    const first = normalizeRecommendedTeam({
      ...teamBase,
      members: [],
    });

    const member = first.members[0];
    expect(member).toBeDefined();
    if (member) member.name = "被污染的成员";

    const second = normalizeRecommendedTeam({
      ...teamBase,
      members: [],
    });

    expect(second.members[0]?.name).toBe("任务规划官");
  });

  it("pads two recommended members to the minimum team size", () => {
    const result = normalizeRecommendedTeam({
      ...teamBase,
      members: [
        {
          name: "调研专家",
          role: "调研",
          responsibility: "收集任务背景。",
          systemPrompt: "你负责收集任务背景、提取事实和约束。",
          skills: ["调研"],
          isCore: true,
        },
        {
          name: "执行专家",
          role: "执行",
          responsibility: "完成核心交付。",
          systemPrompt: "你负责按照计划完成核心交付并记录结果。",
          skills: ["执行"],
          isCore: true,
        },
      ],
    });

    expect(result.members).toHaveLength(3);
    expect(result.members[2]?.name).toBe("任务规划官");
  });

  it("trims text fields and filters blank skills", () => {
    const result = normalizeRecommendedTeam({
      teamName: "  清理团队  ",
      teamDescription: "  清理输入  ",
      mainAgentPrompt: "  主 Agent 负责验收。  ",
      members: [{
        name: "  清理专家  ",
        role: "  数据清理  ",
        responsibility: "  清理空白字段。  ",
        systemPrompt: "  你负责清理输入中的空白字段并保持结构稳定。  ",
        skills: [" 分析 ", " ", "复核"],
        isCore: true,
      }],
    });

    expect(result.teamName).toBe("清理团队");
    expect(result.teamDescription).toBe("清理输入");
    expect(result.mainAgentPrompt).toBe("主 Agent 负责验收。");
    expect(result.members[0]).toMatchObject({
      name: "清理专家",
      role: "数据清理",
      responsibility: "清理空白字段。",
      skills: ["分析", "复核"],
    });
  });

  it("normalizes oversized recommendation fields and skills", () => {
    const skills = [...Array.from({ length: 8 }, (_, index) => `技能${index + 1}`), "超长技能".repeat(20)];
    const result = normalizeRecommendedTeam({
      teamName: `团队${"名".repeat(90)}`,
      teamDescription: "描述".repeat(300),
      mainAgentPrompt: "主".repeat(4001),
      members: [{
        name: `成员${"名".repeat(90)}`,
        role: "角色".repeat(60),
        responsibility: "职责".repeat(300),
        systemPrompt: "短提示",
        skills,
        isCore: true,
      }],
    });

    expect(result.teamName).toHaveLength(80);
    expect(result.teamDescription).toHaveLength(500);
    expect(result.mainAgentPrompt).toHaveLength(4000);
    expect(result.members[0]?.name).toHaveLength(40);
    expect(result.members[0]?.role).toHaveLength(80);
    expect(result.members[0]?.responsibility).toHaveLength(500);
    expect(result.members[0]?.systemPrompt.length).toBeGreaterThanOrEqual(10);
    expect(result.members[0]?.skills).toHaveLength(8);
    expect(result.members[0]?.skills.every((skill) => skill.length <= 40)).toBe(true);
    expect(confirmTeamBodySchema.safeParse(result).success).toBe(true);
  });

  it("normalizes blank and very short system prompts for confirmation", () => {
    const result = normalizeRecommendedTeam({
      teamName: "短提示团队",
      teamDescription: "短字段输入",
      members: [
        {
          name: "a",
          role: "r",
          responsibility: "b",
          systemPrompt: " ",
          skills: ["x"],
          isCore: true,
        },
        {
          name: "c",
          role: "r",
          responsibility: "d",
          systemPrompt: "短",
          skills: ["y"],
          isCore: true,
        },
      ],
    });

    expect(result.members[0]?.systemPrompt.length).toBeGreaterThanOrEqual(10);
    expect(result.members[1]?.systemPrompt.length).toBeGreaterThanOrEqual(10);
    expect(confirmTeamBodySchema.safeParse(result).success).toBe(true);
  });

  it("trims recommended members to ten", () => {
    const members = Array.from({ length: 12 }, (_, index) => ({
      name: `成员${index + 1}`,
      role: "执行者",
      responsibility: `负责第 ${index + 1} 部分`,
      systemPrompt: `你负责第 ${index + 1} 部分。`,
      skills: ["分析"],
      isCore: index < 2,
    }));

    const result = normalizeRecommendedTeam({
      ...teamBase,
      members,
    });

    expect(result.members).toHaveLength(10);
    expect(result.members[9]?.name).toBe("成员10");
  });

  it("trims oversized recommendations before rejecting member count", () => {
    const members = Array.from({ length: 21 }, (_, index) => ({
      name: `成员${index + 1}`,
      role: "执行者",
      responsibility: `负责第 ${index + 1} 部分`,
      systemPrompt: `你负责第 ${index + 1} 部分。`,
      skills: ["分析"],
      isCore: index < 2,
    }));

    const result = normalizeRecommendedTeam({
      ...teamBase,
      members,
    });

    expect(result.members).toHaveLength(10);
    expect(result.members[9]?.name).toBe("成员10");
  });

  it("keeps core members when trimming oversized recommendations", () => {
    const members = Array.from({ length: 11 }, (_, index) => (
      index === 10 ? validMember(11, true) : validMember(index + 1)
    ));

    const result = normalizeRecommendedTeam({
      ...teamBase,
      members,
    });

    expect(result.members).toHaveLength(10);
    expect(result.members.some((member) => member.name === "成员11")).toBe(true);
    expect(result.members.some((member) => member.name === "成员10")).toBe(false);
  });

  it("rejects members without name or responsibility", () => {
    expect(() => normalizeRecommendedTeam({
      ...teamBase,
      members: [{
        name: "",
        role: "执行者",
        responsibility: "",
        systemPrompt: "你负责执行。",
        skills: [],
        isCore: false,
      }],
    })).toThrow("AGENT_TEAM_MEMBER_INVALID");
  });
});
