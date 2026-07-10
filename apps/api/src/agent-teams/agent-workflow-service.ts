import { Prisma, type AgentTeam, type AgentTeamMember, type PrismaClient } from "@prisma/client";
import { AGENT_TEAM_RUN_STATUS, AGENT_WORKFLOW_MAX_STEPS, AGENT_WORKFLOW_STEP_STATUS } from "./agent-team-types.js";
import type { WorkflowPlanStep } from "./agent-workflow-plan.js";
import { taskContextToJson, type AgentTaskContext } from "./agent-task-context.js";

class AgentTeamNotFoundError extends Error {
  readonly name = "AgentTeamNotFoundError";

  constructor() {
    super("AGENT_TEAM_NOT_FOUND");
  }
}

class AgentWorkflowRunNotFoundError extends Error {
  readonly name = "AgentWorkflowRunNotFoundError";

  constructor() {
    super("AGENT_WORKFLOW_RUN_NOT_FOUND");
  }
}

function stringArray(value: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function buildMemberSnapshot(
  member: Pick<AgentTeamMember, "name" | "role" | "responsibility" | "systemPrompt" | "skills" | "isCore">,
): Prisma.InputJsonObject {
  return {
    name: member.name,
    role: member.role,
    responsibility: member.responsibility,
    systemPrompt: member.systemPrompt,
    skills: stringArray(member.skills),
    isCore: member.isCore,
  };
}

function buildTeamSnapshot(team: AgentTeam & { members: AgentTeamMember[] }, taskContext?: AgentTaskContext): Prisma.InputJsonObject {
  const snapshot: Prisma.InputJsonObject = {
    teamName: team.name,
    teamDescription: team.description,
    mainAgentPrompt: team.mainAgentPrompt,
    members: team.members
      .slice()
      .sort((left, right) => left.position - right.position)
      .map((member) => buildMemberSnapshot(member)),
  };
  return taskContext ? { ...snapshot, taskContext: taskContextToJson(taskContext) } : snapshot;
}

function isJsonObject(value: Prisma.JsonValue | null | undefined): value is Prisma.JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTeamSnapshotMembers(snapshot: Prisma.JsonValue): readonly Prisma.InputJsonObject[] {
  if (!isJsonObject(snapshot) || !Array.isArray(snapshot.members)) return [];
  return snapshot.members
    .filter(isJsonObject)
    .map((member) => ({
      name: typeof member.name === "string" ? member.name : "",
      role: typeof member.role === "string" ? member.role : "",
      responsibility: typeof member.responsibility === "string" ? member.responsibility : "",
      systemPrompt: typeof member.systemPrompt === "string" ? member.systemPrompt : "",
      skills: stringArray(member.skills),
      isCore: member.isCore === true,
    }))
    .filter((member) => typeof member.name === "string" && member.name.length > 0);
}

function memberSnapshotForStep(teamSnapshot: Prisma.JsonValue, memberName: string): Prisma.InputJsonObject {
  const matched = readTeamSnapshotMembers(teamSnapshot).find((member) => member.name === memberName);
  return matched ?? { name: memberName };
}

function planSnapshot(steps: readonly WorkflowPlanStep[]): Prisma.InputJsonObject {
  return {
    steps: steps.map((step) => ({
      title: step.title,
      goal: step.goal,
      memberName: step.memberName,
      input: step.input,
    })),
  };
}

export async function createRunFromTeam(
  prisma: PrismaClient,
  userId: string,
  teamId: string,
  taskGoal: string,
  taskContext: AgentTaskContext,
) {
  const team = await prisma.agentTeam.findUnique({
    where: { id_userId: { id: teamId, userId } },
    include: { members: { orderBy: { position: "asc" } } },
  });
  if (!team) throw new AgentTeamNotFoundError();

  return prisma.agentWorkflowRun.create({
    data: {
      userId,
      teamId: team.id,
      taskGoal,
      status: AGENT_TEAM_RUN_STATUS.teamConfirmed,
      teamSnapshot: buildTeamSnapshot(team, taskContext),
    },
  });
}

export async function createWorkflowSteps(
  prisma: PrismaClient,
  userId: string,
  runId: string,
  steps: readonly WorkflowPlanStep[],
) {
  const run = await prisma.agentWorkflowRun.findUnique({
    where: { id_userId: { id: runId, userId } },
    select: { id: true, teamSnapshot: true },
  });
  if (!run) throw new AgentWorkflowRunNotFoundError();

  const normalizedSteps = steps.slice(0, AGENT_WORKFLOW_MAX_STEPS);
  if (normalizedSteps.length === 0) {
    throw new Error("AGENT_WORKFLOW_PLAN_EMPTY");
  }

  return prisma.$transaction(async (tx) => {
    await tx.agentWorkflowStep.deleteMany({ where: { runId, userId } });
    await tx.agentWorkflowStep.createMany({
      data: normalizedSteps.map((step, index) => ({
        runId,
        userId,
        memberName: step.memberName,
        memberSnapshot: memberSnapshotForStep(run.teamSnapshot, step.memberName),
        title: step.title,
        goal: step.goal,
        input: step.input,
        status: AGENT_WORKFLOW_STEP_STATUS.pending,
        position: index,
      })),
    });

    return tx.agentWorkflowRun.update({
      where: { id_userId: { id: runId, userId } },
      data: {
        status: AGENT_TEAM_RUN_STATUS.planning,
        error: null,
        finalReport: "",
        completedAt: null,
        planSnapshot: planSnapshot(normalizedSteps),
      },
      include: {
        steps: { orderBy: { position: "asc" } },
        events: { orderBy: { createdAt: "asc" } },
      },
    });
  });
}
