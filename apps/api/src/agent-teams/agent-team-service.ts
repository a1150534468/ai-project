import { Prisma, type PrismaClient } from "@prisma/client";
import type Anthropic from "@anthropic-ai/sdk";
import { createLlmClient, loadLlmConfig } from "@ai-assistant/llm";
import { buildTeamRecommendationPrompt } from "./agent-team-prompts.js";
import { normalizeRecommendedTeam } from "./agent-team-normalize.js";
import { AGENT_TEAM_RUN_STATUS, confirmTeamBodySchema, type RecommendedAgentMember, type RecommendedTeam } from "./agent-team-types.js";
import {
  describeTaskContext,
  readTaskContextFromSnapshot,
  taskContextToJson,
  type AgentTaskContext,
} from "./agent-task-context.js";
import {
  agentUsageFromAnthropicUsage,
  fallbackAgentModelUsage,
  withAgentModelBilling,
  type AgentModelBillingContext,
} from "./agent-model-billing.js";

class AgentTeamRecommendationResponseError extends Error {
  readonly name = "AgentTeamRecommendationResponseError";

  constructor() {
    super("AGENT_TEAM_RECOMMENDATION_RESPONSE_INVALID");
  }
}

class AgentWorkflowRunNotFoundError extends Error {
  readonly name = "AgentWorkflowRunNotFoundError";

  constructor() {
    super("AGENT_WORKFLOW_RUN_NOT_FOUND");
  }
}

class AgentTeamNotFoundError extends Error {
  readonly name = "AgentTeamNotFoundError";

  constructor() {
    super("AGENT_TEAM_NOT_FOUND");
  }
}

class AgentTeamConfirmationNotAllowedError extends Error {
  readonly name = "AgentTeamConfirmationNotAllowedError";

  constructor() {
    super("AGENT_TEAM_CONFIRMATION_NOT_ALLOWED");
  }
}

function textFromMessage(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function jsonFragment(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new AgentTeamRecommendationResponseError();
  }
  return text.slice(start, end + 1);
}

function buildMemberSnapshot(member: RecommendedAgentMember): Prisma.InputJsonObject {
  return {
    name: member.name,
    role: member.role,
    responsibility: member.responsibility,
    systemPrompt: member.systemPrompt,
    skills: member.skills,
    isCore: member.isCore,
  };
}

function buildTeamSnapshot(team: RecommendedTeam, taskContext?: AgentTaskContext): Prisma.InputJsonObject {
  const snapshot: Prisma.InputJsonObject = {
    teamName: team.teamName,
    teamDescription: team.teamDescription,
    mainAgentPrompt: team.mainAgentPrompt,
    members: team.members.map((member) => buildMemberSnapshot(member)),
  };
  return taskContext ? { ...snapshot, taskContext: taskContextToJson(taskContext) } : snapshot;
}

function normalizeConfirmedTeam(teamInput: unknown): RecommendedTeam {
  return normalizeRecommendedTeam(confirmTeamBodySchema.parse(teamInput));
}

export async function requestRecommendedTeam(
  taskGoal: string,
  taskContext?: AgentTaskContext,
  billingContext?: Pick<AgentModelBillingContext, "userId">,
): Promise<RecommendedTeam> {
  const cfg = loadLlmConfig();
  const client = createLlmClient(cfg);
  const contextText = taskContext ? describeTaskContext(taskContext) : "";
  const prompt = contextText
    ? `${buildTeamRecommendationPrompt(taskGoal)}\n\n任务上下文：\n${contextText}`
    : buildTeamRecommendationPrompt(taskGoal);
  const model = taskContext?.selectedModel ?? cfg.defaultModel;
  const system = "你是 Agent 团队配置生成器。只输出 JSON。";
  return withAgentModelBilling({
    billingContext: billingContext?.userId
      ? {
        userId: billingContext.userId,
        type: "agent_team_recommend",
        operationIdPrefix: `agent-team:recommend:${billingContext.userId}`,
      }
      : undefined,
    model,
    system,
    prompt,
    call: async () => {
      const message = await client.messages.create({
        model,
        max_tokens: 4096,
        system,
        messages: [{ role: "user", content: prompt }],
      });
      const text = textFromMessage(message);
      if (!text) {
        throw new AgentTeamRecommendationResponseError();
      }
      const parsed: unknown = JSON.parse(jsonFragment(text));
      return {
        value: normalizeRecommendedTeam(parsed),
        usage: agentUsageFromAnthropicUsage(
          message.usage,
          fallbackAgentModelUsage({ system, prompt, output: text }),
        ),
      };
    },
  });
}

export async function createRecommendationRun(
  prisma: PrismaClient,
  userId: string,
  taskGoal: string,
  team: RecommendedTeam,
  taskContext: AgentTaskContext,
) {
  return prisma.agentWorkflowRun.create({
    data: {
      userId,
      taskGoal,
      status: AGENT_TEAM_RUN_STATUS.awaitingTeamConfirmation,
      teamSnapshot: buildTeamSnapshot(team, taskContext),
      planSnapshot: Prisma.JsonNull,
    },
  });
}

export async function listTeams(prisma: PrismaClient, userId: string) {
  return prisma.agentTeam.findMany({
    where: { userId },
    include: { members: true },
    orderBy: { updatedAt: "desc" },
  });
}

export async function findOwnedTeam(prisma: PrismaClient, userId: string, teamId: string) {
  return prisma.agentTeam.findUnique({
    where: { id_userId: { id: teamId, userId } },
    include: { members: true },
  });
}

export async function deleteOwnedTeam(prisma: PrismaClient, userId: string, teamId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.agentTeam.findUnique({
      where: { id_userId: { id: teamId, userId } },
      select: { id: true },
    });
    if (!existing) throw new AgentTeamNotFoundError();

    await tx.agentWorkflowRun.updateMany({
      where: { teamId, userId },
      data: { teamId: null },
    });
    await tx.agentTeamMember.deleteMany({ where: { teamId, userId } });
    const deleted = await tx.agentTeam.deleteMany({ where: { id: teamId, userId } });
    if (deleted.count !== 1) throw new AgentTeamNotFoundError();
  });
}

export async function confirmRecommendedTeam(
  prisma: PrismaClient,
  userId: string,
  runId: string,
  teamInput: unknown,
) {
  const team = normalizeConfirmedTeam(teamInput);

  return prisma.$transaction(async (tx) => {
    const existingRun = await tx.agentWorkflowRun.findUnique({
      where: { id_userId: { id: runId, userId } },
      select: { teamSnapshot: true },
    });
    if (!existingRun) {
      throw new AgentWorkflowRunNotFoundError();
    }
    const taskContext = readTaskContextFromSnapshot(existingRun.teamSnapshot);
    const teamSnapshot = buildTeamSnapshot(team, taskContext);

    const claimed = await tx.agentWorkflowRun.updateMany({
      where: {
        id: runId,
        userId,
        status: AGENT_TEAM_RUN_STATUS.awaitingTeamConfirmation,
      },
      data: {
        status: AGENT_TEAM_RUN_STATUS.teamConfirmed,
        teamSnapshot,
      },
    });
    if (claimed.count !== 1) {
      const existing = await tx.agentWorkflowRun.findUnique({
        where: { id_userId: { id: runId, userId } },
        select: { id: true },
      });
      if (!existing) {
        throw new AgentWorkflowRunNotFoundError();
      }
      throw new AgentTeamConfirmationNotAllowedError();
    }

    const createdTeam = await tx.agentTeam.create({
      data: {
        user: { connect: { id: userId } },
        name: team.teamName,
        description: team.teamDescription,
        mainAgentPrompt: team.mainAgentPrompt,
        sourceRunId: runId,
        members: {
          create: team.members.map((member, index) => ({
            user: { connect: { id: userId } },
            name: member.name,
            role: member.role,
            responsibility: member.responsibility,
            systemPrompt: member.systemPrompt,
            skills: member.skills,
            isCore: member.isCore,
            position: index,
          })),
        },
      },
      include: { members: true },
    });

    const updatedRun = await tx.agentWorkflowRun.update({
      where: { id_userId: { id: runId, userId } },
      data: {
        teamId: createdTeam.id,
        teamSnapshot,
      },
    });

    return { team: createdTeam, run: updatedRun };
  });
}
