import { Prisma, type PrismaClient } from "@prisma/client";
import { AGENT_TEAM_RUN_STATUS, AGENT_WORKFLOW_STEP_STATUS } from "./agent-team-types.js";
import type { AgentWorkflowRunnerEvent, AgentWorkflowRunnerStore } from "./agent-workflow-runner.js";
import { toInputJsonValue } from "./agent-workflow-plan.js";

class AgentWorkflowRunNotFoundError extends Error {
  readonly name = "AgentWorkflowRunNotFoundError";

  constructor() {
    super("AGENT_WORKFLOW_RUN_NOT_FOUND");
  }
}

class AgentWorkflowStepNotFoundError extends Error {
  readonly name = "AgentWorkflowStepNotFoundError";

  constructor() {
    super("AGENT_WORKFLOW_STEP_NOT_FOUND");
  }
}

async function ensureRunUpdated(
  prisma: PrismaClient,
  userId: string,
  runId: string,
  data: Prisma.AgentWorkflowRunUpdateManyMutationInput,
  guardCancelled = false,
): Promise<void> {
  const result = await prisma.agentWorkflowRun.updateMany({
    where: {
      id: runId,
      userId,
      ...(guardCancelled ? {
        status: { not: AGENT_TEAM_RUN_STATUS.cancelled },
        cancelledAt: null,
      } : {}),
    },
    data,
  });
  if (result.count === 1) return;

  const run = await prisma.agentWorkflowRun.findUnique({
    where: { id_userId: { id: runId, userId } },
    select: { status: true, cancelledAt: true },
  });
  if (!run) throw new AgentWorkflowRunNotFoundError();
  if (guardCancelled && (run.status === AGENT_TEAM_RUN_STATUS.cancelled || run.cancelledAt !== null)) {
    return;
  }
  throw new AgentWorkflowRunNotFoundError();
}

async function ensureStepUpdated(
  prisma: PrismaClient,
  userId: string,
  runId: string,
  stepId: string,
  data: Prisma.AgentWorkflowStepUpdateManyMutationInput,
): Promise<void> {
  const result = await prisma.agentWorkflowStep.updateMany({
    where: { id: stepId, runId, userId },
    data,
  });
  if (result.count !== 1) throw new AgentWorkflowStepNotFoundError();
}

async function appendEvent(
  prisma: PrismaClient,
  userId: string,
  runId: string,
  event: AgentWorkflowRunnerEvent,
): Promise<void> {
  await prisma.agentWorkflowEvent.create({
    data: {
      runId,
      userId,
      stepId: event.stepId ?? null,
      memberName: event.memberName ?? "",
      type: event.type,
      message: event.message,
      payload: event.payload === undefined ? undefined : toInputJsonValue(event.payload),
    },
  });
}

export function createPrismaWorkflowStore(
  prisma: PrismaClient,
  userId: string,
  runId: string,
): AgentWorkflowRunnerStore {
  return {
    markRunRunning: async () => {
      await ensureRunUpdated(prisma, userId, runId, {
        status: AGENT_TEAM_RUN_STATUS.running,
        error: null,
        finalReport: "",
        completedAt: null,
      }, true);
    },
    nextPendingStep: async () => prisma.agentWorkflowStep.findFirst({
      where: { runId, userId, status: AGENT_WORKFLOW_STEP_STATUS.pending },
      orderBy: { position: "asc" },
      select: { id: true, title: true, memberName: true, goal: true },
    }),
    markStepRunning: async (stepId: string) => {
      await ensureStepUpdated(prisma, userId, runId, stepId, {
        status: AGENT_WORKFLOW_STEP_STATUS.running,
        error: null,
        startedAt: new Date(),
        completedAt: null,
      });
    },
    completeStep: async (stepId: string, output: string) => {
      await ensureStepUpdated(prisma, userId, runId, stepId, {
        status: AGENT_WORKFLOW_STEP_STATUS.succeeded,
        output,
        error: null,
        completedAt: new Date(),
      });
    },
    failStep: async (stepId: string, error: string) => {
      await ensureStepUpdated(prisma, userId, runId, stepId, {
        status: AGENT_WORKFLOW_STEP_STATUS.failed,
        output: "",
        error,
        completedAt: new Date(),
      });
    },
    appendEvent: async (event: AgentWorkflowRunnerEvent) => {
      await appendEvent(prisma, userId, runId, event);
    },
    completeRun: async (finalReport: string) => {
      await ensureRunUpdated(prisma, userId, runId, {
        status: AGENT_TEAM_RUN_STATUS.succeeded,
        finalReport,
        error: null,
        completedAt: new Date(),
      }, true);
    },
    failRun: async (error: string) => {
      await ensureRunUpdated(prisma, userId, runId, {
        status: AGENT_TEAM_RUN_STATUS.failed,
        finalReport: "",
        error,
        completedAt: new Date(),
      }, true);
    },
    isCancelled: async () => {
      const run = await prisma.agentWorkflowRun.findUnique({
        where: { id_userId: { id: runId, userId } },
        select: { status: true, cancelledAt: true },
      });
      if (!run) throw new AgentWorkflowRunNotFoundError();
      return run.status === AGENT_TEAM_RUN_STATUS.cancelled || run.cancelledAt !== null;
    },
  };
}
