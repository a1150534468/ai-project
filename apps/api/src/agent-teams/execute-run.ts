import { Prisma, type AgentWorkflowEvent, type AgentWorkflowRun, type AgentWorkflowStep, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@yc/db";
import { AGENT_TEAM_RUN_STATUS } from "./agent-team-types.js";
import { formatAgentWorkflowError } from "./agent-workflow-error.js";
import { requestWorkflowPlan, workflowPlanErrorMessage, type WorkflowPlanStep } from "./agent-workflow-plan.js";
import { runAgentWorkflowSteps, type AgentWorkflowRunnerStore, type RunAgentWorkflowStepsArgs } from "./agent-workflow-runner.js";
import { createWorkflowSteps } from "./agent-workflow-service.js";
import { createPrismaWorkflowStore } from "./agent-workflow-store.js";
import {
  defaultExecuteStep,
  defaultSummarize,
  eventContext,
  runContext,
  stepContext,
  type WorkflowStepExecutionContext,
  type WorkflowSummaryContext,
} from "./agent-workflow-llm.js";
import {
  readTaskContextFromSnapshot,
  type AgentTaskContext,
} from "./agent-task-context.js";
import { localTools } from "@yc/connector-protocol";
import { getDispatcher } from "../connector/hub.js";
import { makeLocalExecTool } from "../connector/local-tools.js";
import { pickActiveDevice } from "../connector/select-device.js";
import type { RunTurnToolEvent } from "../agent/run.js";

type OwnedRunRecord = AgentWorkflowRun & {
  readonly steps: AgentWorkflowStep[];
  readonly events: AgentWorkflowEvent[];
};

type PlanWorkflowFn = (
  taskGoal: string,
  teamSnapshot: Prisma.JsonValue,
  taskContext: AgentTaskContext,
) => Promise<readonly WorkflowPlanStep[]>;

type RunnerFn = (args: RunAgentWorkflowStepsArgs) => Promise<void>;

type CreateStoreFn = (prisma: PrismaClient, userId: string, runId: string) => AgentWorkflowRunnerStore;

interface ComputerToolsSpec {
  readonly deviceId?: string;
  readonly tools: import("@anthropic-ai/sdk").default.Tool[];
  readonly execTool: (name: string, input: unknown) => Promise<string>;
}

interface Logger {
  readonly error: (obj: unknown, msg?: string) => void;
}

export interface ExecuteTeamRunDeps {
  // prisma 可注入；不提供则使用 getPrisma()
  readonly prisma?: PrismaClient;
  // computerTools 可注入：undefined=不注入(走默认 resolveComputerToolExecution，行为不变)；null=显式无工具；对象=用它
  readonly computerTools?: ComputerToolsSpec | null;
  // planWorkflow 可注入以覆盖默认的 requestWorkflowPlan
  readonly planWorkflow?: PlanWorkflowFn;
  // createStore 可注入；不提供则使用 createPrismaWorkflowStore
  readonly createStore?: CreateStoreFn;
  // runner 可注入；不提供则使用 runAgentWorkflowSteps
  readonly runner?: RunnerFn;
  // executeStep 可注入；不提供则使用 defaultExecuteStep
  readonly executeStep?: (context: WorkflowStepExecutionContext) => Promise<string>;
  // summarize 可注入；不提供则使用 defaultSummarize
  readonly summarize?: (context: WorkflowSummaryContext) => Promise<string>;
  // logger 可注入，用于错误日志；不提供则使用改进的 console
  readonly logger?: Logger;
}

function toolOutputPreview(event: RunTurnToolEvent): string | undefined {
  const raw = event.error ?? event.output;
  if (!raw) return undefined;
  const normalized = raw.replace(/\s+/g, " ").trim();
  return normalized.length > 220 ? `${normalized.slice(0, 219)}…` : normalized;
}

function toolEventMessage(memberName: string, event: RunTurnToolEvent): string {
  const status = event.status === "started" ? "开始调用" : event.status === "failed" ? "调用失败" : "调用完成";
  return `${memberName} ${status}电脑工具：${event.name}`;
}

async function loadOwnedRun(prisma: PrismaClient, userId: string, runId: string): Promise<OwnedRunRecord | null> {
  return prisma.agentWorkflowRun.findUnique({
    where: { id_userId: { id: runId, userId } },
    include: {
      steps: { orderBy: { position: "asc" } },
      events: { orderBy: { createdAt: "asc" } },
    },
  });
}

async function failRunBestEffort(prisma: PrismaClient, userId: string, runId: string, message: string): Promise<void> {
  await prisma.agentWorkflowRun.updateMany({
    where: {
      id: runId,
      userId,
      status: { not: AGENT_TEAM_RUN_STATUS.cancelled },
      cancelledAt: null,
    },
    data: {
      status: AGENT_TEAM_RUN_STATUS.failed,
      error: message,
      finalReport: "",
      completedAt: new Date(),
    },
  });
}

async function resolveComputerToolExecution(prisma: PrismaClient, userId: string) {
  const online = await prisma.device.findMany({
    where: { userId, online: true, revokedAt: null },
    select: { id: true, userId: true, lastSeenAt: true },
  });
  const active = pickActiveDevice(online);
  if (!active) return null;
  return {
    deviceId: active.id,
    tools: localTools,
    execTool: makeLocalExecTool(getDispatcher(), userId, active.id, active.userId),
  };
}

export async function executeTeamRun(
  userId: string,
  runId: string,
  taskGoal: string,
  teamSnapshot: Prisma.JsonValue,
  deps?: ExecuteTeamRunDeps,
): Promise<void> {
  const prisma = deps?.prisma ?? getPrisma();
  const logger = deps?.logger ?? {
    error: (obj: unknown, msg?: string) => {
      if (msg) console.error(msg, obj);
      else console.error(obj);
    },
  };
  const planWorkflow = deps?.planWorkflow;
  const createStore = deps?.createStore ?? createPrismaWorkflowStore;
  const runner = deps?.runner ?? runAgentWorkflowSteps;
  const executeStep = deps?.executeStep ?? defaultExecuteStep;
  const summarize = deps?.summarize ?? defaultSummarize;

  try {
    const taskContext = readTaskContextFromSnapshot(teamSnapshot);
    let steps: readonly WorkflowPlanStep[];
    try {
      steps = planWorkflow
        ? await planWorkflow(taskGoal, teamSnapshot, taskContext)
        : await requestWorkflowPlan(taskGoal, teamSnapshot, taskContext, { userId, runId });
    } catch (error) {
      throw new Error(workflowPlanErrorMessage(error));
    }
    await createWorkflowSteps(prisma, userId, runId, steps);
    const store = createStore(prisma, userId, runId);
    const computerTools = deps?.computerTools !== undefined
      ? deps.computerTools
      : await resolveComputerToolExecution(prisma, userId);
    if (computerTools) {
      await store.appendEvent({
        type: "computer_tools_ready",
        message: `已向工作流 Agent 暴露 ${computerTools.tools.length} 个用户电脑工具`,
        payload: { deviceId: computerTools.deviceId || undefined, tools: computerTools.tools.map((tool) => tool.name) },
      });
    }
    await runner({
      runId,
      store,
      formatError: formatAgentWorkflowError,
      executeStep: async (step) => {
        const run = await loadOwnedRun(prisma, userId, runId);
        if (!run) throw new Error("AGENT_WORKFLOW_RUN_NOT_FOUND");
        const currentStep = run.steps.find((item) => item.id === step.id);
        if (!currentStep) throw new Error("AGENT_WORKFLOW_STEP_NOT_FOUND");
        return executeStep({
          run: runContext(run),
          step: stepContext(currentStep),
          completedSteps: run.steps
            .filter((item) => item.status === "succeeded" && item.output.trim())
            .map(stepContext),
          tools: computerTools?.tools,
          execTool: computerTools?.execTool,
          onTool: (event) => {
            void store.appendEvent({
              stepId: currentStep.id,
              memberName: currentStep.memberName,
              type: `computer_tool_${event.status}`,
              message: toolEventMessage(currentStep.memberName, event),
              payload: {
                tool: event.name,
                status: event.status,
                input: event.input,
                elapsedMs: event.elapsedMs,
                outputPreview: toolOutputPreview(event),
                error: event.error,
              },
            });
          },
        });
      },
      summarize: async () => {
        const run = await loadOwnedRun(prisma, userId, runId);
        if (!run) throw new Error("AGENT_WORKFLOW_RUN_NOT_FOUND");
        return summarize({
          run: runContext(run),
          steps: run.steps.map(stepContext),
          events: run.events.map(eventContext),
        });
      },
    });
  } catch (error) {
    logger.error({ err: error, runId }, "agent team workflow execution failed");
    await failRunBestEffort(prisma, userId, runId, formatAgentWorkflowError(error, "工作流执行失败"));
  }
}
