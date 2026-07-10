import {
  AGENT_TEAM_MAX_MEMBERS,
  AGENT_TEAM_MEMBER_INVALID,
  AGENT_TEAM_MIN_MEMBERS,
  type RecommendedAgentMember,
  type RecommendedTeam,
  recommendedTeamSchema,
} from "./agent-team-types.js";

const FALLBACK_MEMBERS: readonly RecommendedAgentMember[] = [
  {
    name: "任务规划官",
    role: "规划与拆解",
    responsibility: "澄清任务目标、拆解执行步骤、定义验收标准。",
    systemPrompt: "你是任务规划官，负责把用户目标拆解成清晰、可执行、可验收的步骤。",
    skills: ["任务拆解", "验收标准"],
    isCore: true,
  },
  {
    name: "资料分析师",
    role: "信息整理",
    responsibility: "整理输入资料、提取关键事实、识别缺失信息。",
    systemPrompt: "你是资料分析师，负责从用户任务和上下文中提取事实、约束和风险。",
    skills: ["资料分析", "事实提取"],
    isCore: false,
  },
  {
    name: "质量审查官",
    role: "质量控制",
    responsibility: "检查输出是否满足目标、是否存在遗漏、矛盾或不可验证结论。",
    systemPrompt: "你是质量审查官，负责审查执行产物，指出遗漏、矛盾和不可验证之处。",
    skills: ["质量审查", "风险识别"],
    isCore: false,
  },
];

export class AgentTeamMemberInvalidError extends Error {
  readonly name = "AgentTeamMemberInvalidError";
  readonly code = AGENT_TEAM_MEMBER_INVALID;

  constructor() {
    super(AGENT_TEAM_MEMBER_INVALID);
  }
}

function hasInvalidMemberIssue(input: unknown): boolean {
  return typeof input === "object"
    && input !== null
    && "issues" in input
    && Array.isArray(input.issues)
    && input.issues.some((issue) => {
      if (typeof issue !== "object" || issue === null || !("path" in issue) || !Array.isArray(issue.path)) {
        return false;
      }
      return issue.path[0] === "members" && issue.path.length > 1;
    });
}

function cleanMember(member: RecommendedAgentMember): RecommendedAgentMember {
  const name = member.name.trim();
  const responsibility = member.responsibility.trim();
  const rawSystemPrompt = member.systemPrompt.trim();

  if (!name || !responsibility) {
    throw new AgentTeamMemberInvalidError();
  }
  const systemPrompt = rawSystemPrompt.length >= 10
    ? rawSystemPrompt
    : `你是${name}，负责${responsibility}。请按要求完成任务。`;

  return {
    name: name.slice(0, 40),
    role: member.role.trim().slice(0, 80),
    responsibility: responsibility.slice(0, 500),
    systemPrompt: systemPrompt.slice(0, 4000),
    skills: member.skills.map((skill) => skill.trim().slice(0, 40)).filter((skill) => skill.length > 0).slice(0, 8),
    isCore: member.isCore,
  };
}

function cloneMember(member: RecommendedAgentMember): RecommendedAgentMember {
  return {
    ...member,
    skills: [...member.skills],
  };
}

function trimMembersByPriority(members: readonly RecommendedAgentMember[]): RecommendedAgentMember[] {
  if (members.length <= AGENT_TEAM_MAX_MEMBERS) return [...members];
  return members
    .map((member, index) => ({ member, index }))
    .sort((left, right) => {
      if (left.member.isCore !== right.member.isCore) return left.member.isCore ? -1 : 1;
      return left.index - right.index;
    })
    .slice(0, AGENT_TEAM_MAX_MEMBERS)
    .map((entry) => entry.member);
}

export function normalizeRecommendedTeam(input: unknown): RecommendedTeam {
  const parsed = recommendedTeamSchema.safeParse(input);
  if (!parsed.success) {
    if (hasInvalidMemberIssue(parsed.error)) {
      throw new AgentTeamMemberInvalidError();
    }
    throw parsed.error;
  }

  const members = parsed.data.members.map(cleanMember);
  const names = new Set(members.map((member) => member.name));

  for (const fallback of FALLBACK_MEMBERS) {
    if (members.length >= AGENT_TEAM_MIN_MEMBERS) break;
    if (names.has(fallback.name)) continue;
    members.push(cloneMember(fallback));
    names.add(fallback.name);
  }

  return {
    teamName: parsed.data.teamName.trim().slice(0, 80),
    teamDescription: parsed.data.teamDescription.trim().slice(0, 500),
    mainAgentPrompt: parsed.data.mainAgentPrompt.trim().slice(0, 4000),
    members: trimMembersByPriority(members).map(cloneMember),
  };
}
