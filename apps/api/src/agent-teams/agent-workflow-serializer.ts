import type { AgentTeam, AgentTeamMember, AgentWorkflowEvent, AgentWorkflowRun, AgentWorkflowStep, Prisma } from "@prisma/client";

function stringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function serializeTeam(team: AgentTeam & { members: AgentTeamMember[] }) {
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    mainAgentPrompt: team.mainAgentPrompt,
    members: team.members
      .slice()
      .sort((left, right) => left.position - right.position)
      .map((member) => ({
        id: member.id,
        name: member.name,
        role: member.role,
        responsibility: member.responsibility,
        systemPrompt: member.systemPrompt,
        skills: stringArray(member.skills),
        isCore: member.isCore,
        position: member.position,
      })),
    createdAt: team.createdAt.toISOString(),
    updatedAt: team.updatedAt.toISOString(),
  };
}

export function serializeRun(run: AgentWorkflowRun & { steps?: AgentWorkflowStep[]; events?: AgentWorkflowEvent[] }) {
  return {
    id: run.id,
    teamId: run.teamId,
    taskGoal: run.taskGoal,
    status: run.status,
    teamSnapshot: run.teamSnapshot,
    planSnapshot: run.planSnapshot,
    finalReport: run.finalReport,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    cancelledAt: run.cancelledAt?.toISOString() ?? null,
    steps: (run.steps ?? [])
      .slice()
      .sort((left, right) => left.position - right.position)
      .map((step) => ({
        id: step.id,
        memberName: step.memberName,
        memberSnapshot: step.memberSnapshot,
        title: step.title,
        goal: step.goal,
        input: step.input,
        output: step.output,
        status: step.status,
        position: step.position,
        retryCount: step.retryCount,
        error: step.error,
        startedAt: step.startedAt?.toISOString() ?? null,
        completedAt: step.completedAt?.toISOString() ?? null,
      })),
    events: (run.events ?? [])
      .slice()
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((event) => ({
        id: event.id,
        stepId: event.stepId,
        memberName: event.memberName,
        type: event.type,
        message: event.message,
        payload: event.payload,
        createdAt: event.createdAt.toISOString(),
      })),
  };
}
