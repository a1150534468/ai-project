import { Prisma, type AgentWorkflowEvent, type AgentWorkflowRun, type AgentWorkflowStep, type PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { getPrisma } from "@yc/db";
import { localTools } from "@yc/connector-protocol";
import { InsufficientBalanceError } from "@yc/billing";
import { getDispatcher } from "../connector/hub.js";
import { makeLocalExecTool } from "../connector/local-tools.js";
import { pickActiveDevice } from "../connector/select-device.js";
import {
  AGENT_TEAM_RUN_STATUS,
  confirmTeamBodySchema,
  createRunBodySchema,
  recommendTeamBodySchema,
  type RecommendedTeam,
} from "./agent-team-types.js";
import {
  confirmRecommendedTeam,
  createRecommendationRun,
  deleteOwnedTeam,
  findOwnedTeam,
  listTeams,
  requestRecommendedTeam,
} from "./agent-team-service.js";
import { formatAgentWorkflowError } from "./agent-workflow-error.js";
import { requestWorkflowPlan, workflowPlanErrorMessage, type WorkflowPlanStep } from "./agent-workflow-plan.js";
import { runAgentWorkflowSteps, type AgentWorkflowRunnerStore, type RunAgentWorkflowStepsArgs } from "./agent-workflow-runner.js";
import { serializeRun, serializeTeam } from "./agent-workflow-serializer.js";
import { createRunFromTeam, createWorkflowSteps } from "./agent-workflow-service.js";
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
  buildAgentTaskContext,
  readTaskContextFromSnapshot,
  type AgentTaskContext,
} from "./agent-task-context.js";
import { buildAgentKnowledgeBaseContext } from "./agent-knowledge-context.js";
import { executeTeamRun } from "./execute-run.js";
import type { RunTurnToolEvent } from "../agent/run.js";
import type { ChatAttachmentPayload } from "../chat/attachments.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

type ScheduleTask = (work: () => Promise<void>) => void;
type RecommendTeamFn = (taskGoal: string, taskContext: AgentTaskContext) => Promise<RecommendedTeam>;
type PlanWorkflowFn = (
  taskGoal: string,
  teamSnapshot: Prisma.JsonValue,
  taskContext: AgentTaskContext,
) => Promise<readonly WorkflowPlanStep[]>;
type CreateStoreFn = (prisma: PrismaClient, userId: string, runId: string) => AgentWorkflowRunnerStore;
type RunnerFn = (args: RunAgentWorkflowStepsArgs) => Promise<void>;

export interface AgentTeamRouteOptions extends FastifyPluginOptions {
  readonly prisma?: PrismaClient;
  readonly scheduleTask?: ScheduleTask;
  readonly recommendTeam?: RecommendTeamFn;
  readonly planWorkflow?: PlanWorkflowFn;
  readonly createStore?: CreateStoreFn;
  readonly runner?: RunnerFn;
  readonly executeStep?: (context: WorkflowStepExecutionContext) => Promise<string>;
  readonly summarize?: (context: WorkflowSummaryContext) => Promise<string>;
}

type OwnedRunRecord = AgentWorkflowRun & {
  readonly steps: AgentWorkflowStep[];
  readonly events: AgentWorkflowEvent[];
};

function requireUserId(userId: string | undefined): string | null {
  return userId?.trim() || null;
}

function paramsId(value: unknown, key: "runId" | "teamId"): string | null {
  if (typeof value !== "object" || value === null) return null;
  const id = Reflect.get(value, key);
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function scheduledRunner(app: FastifyInstance): ScheduleTask {
  return (work) => {
    void work().catch((error) => app.log.error(error));
  };
}

async function buildParsedTaskContext(
  prisma: PrismaClient,
  userId: string,
  data: {
    readonly model?: string;
    readonly kbIds?: readonly string[];
    readonly attachAllOwn?: boolean;
    readonly attachments?: readonly ChatAttachmentPayload[];
  },
): Promise<AgentTaskContext> {
  const knowledgeBase = await buildAgentKnowledgeBaseContext(prisma, userId, {
    kbIds: data.kbIds,
    attachAllOwn: data.attachAllOwn,
  });
  return buildAgentTaskContext({
    model: data.model,
    knowledgeBase,
    attachments: data.attachments,
  });
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

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && (
    error.message === "AGENT_TEAM_NOT_FOUND" ||
    error.message === "AGENT_WORKFLOW_RUN_NOT_FOUND"
  );
}

function isConflictError(error: unknown): boolean {
  return error instanceof Error && error.message === "AGENT_TEAM_CONFIRMATION_NOT_ALLOWED";
}

function isBillingServiceError(error: unknown): boolean {
  return error instanceof Error && (
    error.message.startsWith("billing ")
    || error.message === "BILLING_BASE_URL/BILLING_INTERNAL_TOKEN required"
  );
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

export async function agentTeamRoutes(app: FastifyInstance, opts: AgentTeamRouteOptions = {}) {
  const prisma = opts.prisma ?? getPrisma();
  const scheduleTask = opts.scheduleTask ?? scheduledRunner(app);
  const recommendTeam = opts.recommendTeam;
  const planWorkflow = opts.planWorkflow;
  const createStore = opts.createStore ?? createPrismaWorkflowStore;
  const runner = opts.runner ?? runAgentWorkflowSteps;
  const executeStep = opts.executeStep ?? defaultExecuteStep;
  const summarize = opts.summarize ?? defaultSummarize;

  function enqueueRun(userId: string, runId: string, taskGoal: string, teamSnapshot: Prisma.JsonValue): void {
    scheduleTask(async () => {
      await executeTeamRun(userId, runId, taskGoal, teamSnapshot, {
        prisma,
        planWorkflow,
        createStore,
        runner,
        executeStep,
        summarize,
        logger: app.log,
      });
    });
  }

  app.get("/api/agent-teams", async (req, reply) => {
    const userId = requireUserId(req.userId);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const teams = await listTeams(prisma, userId);
    return { success: true, data: { teams: teams.map(serializeTeam) } };
  });

  app.post("/api/agent-teams/recommend", async (req, reply) => {
    const userId = requireUserId(req.userId);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const parsed = recommendTeamBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    try {
      const taskContext = await buildParsedTaskContext(prisma, userId, parsed.data);
      const recommendation = recommendTeam
        ? await recommendTeam(parsed.data.taskGoal, taskContext)
        : await requestRecommendedTeam(parsed.data.taskGoal, taskContext, { userId });
      const run = await createRecommendationRun(prisma, userId, parsed.data.taskGoal, recommendation, taskContext);
      return { success: true, data: { recommendation, run: serializeRun(run) } };
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        return reply.code(402).send({ error: "积分不足，请充值", code: "INSUFFICIENT_BALANCE" });
      }
      if (isBillingServiceError(error)) {
        return reply.code(502).send({ error: "计费服务不可用，请稍后重试" });
      }
      req.log.error({ err: error }, "recommend agent team failed");
      return reply.code(502).send({ error: formatAgentWorkflowError(error, "团队推荐失败，请稍后重试") });
    }
  });

  app.post("/api/agent-teams/runs/:runId/confirm-team", async (req, reply) => {
    const userId = requireUserId(req.userId);
    const runId = paramsId(req.params, "runId");
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!runId) return reply.code(400).send({ error: "参数不合法" });
    const parsed = confirmTeamBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    try {
      const confirmed = await confirmRecommendedTeam(prisma, userId, runId, parsed.data);
      enqueueRun(userId, confirmed.run.id, confirmed.run.taskGoal, confirmed.run.teamSnapshot);
      return {
        success: true,
        data: {
          team: serializeTeam(confirmed.team),
          run: serializeRun(confirmed.run),
        },
      };
    } catch (error) {
      if (isNotFoundError(error)) return reply.code(404).send({ error: "运行不存在" });
      if (isConflictError(error)) return reply.code(409).send({ error: "当前运行不可确认团队" });
      req.log.error({ err: error, runId }, "confirm recommended team failed");
      return reply.code(502).send({ error: "团队确认失败，请稍后重试" });
    }
  });

  app.post("/api/agent-teams/:teamId/runs", async (req, reply) => {
    const userId = requireUserId(req.userId);
    const teamId = paramsId(req.params, "teamId");
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!teamId) return reply.code(400).send({ error: "参数不合法" });
    const parsed = createRunBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    try {
      const taskContext = await buildParsedTaskContext(prisma, userId, parsed.data);
      const run = await createRunFromTeam(prisma, userId, teamId, parsed.data.taskGoal, taskContext);
      enqueueRun(userId, run.id, run.taskGoal, run.teamSnapshot);
      return reply.code(201).send({ success: true, data: { run: serializeRun(run) } });
    } catch (error) {
      if (isNotFoundError(error)) return reply.code(404).send({ error: "团队不存在" });
      req.log.error({ err: error, teamId }, "create agent workflow run failed");
      return reply.code(500).send({ error: "创建运行失败，请稍后重试" });
    }
  });

  app.get("/api/agent-teams/runs", async (req, reply) => {
    const userId = requireUserId(req.userId);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const runs = await prisma.agentWorkflowRun.findMany({
      where: { userId },
      include: {
        steps: { orderBy: { position: "asc" } },
        events: { orderBy: { createdAt: "asc" } },
      },
      orderBy: { updatedAt: "desc" },
      take: 30,
    });
    return { success: true, data: { runs: runs.map(serializeRun) } };
  });

  app.delete("/api/agent-teams/:teamId", async (req, reply) => {
    const userId = requireUserId(req.userId);
    const teamId = paramsId(req.params, "teamId");
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!teamId) return reply.code(400).send({ error: "参数不合法" });
    try {
      await deleteOwnedTeam(prisma, userId, teamId);
      return { success: true, data: { deletedTeamId: teamId } };
    } catch (error) {
      if (isNotFoundError(error)) return reply.code(404).send({ error: "团队不存在" });
      req.log.error({ err: error, teamId }, "delete agent team failed");
      return reply.code(500).send({ error: "删除团队失败，请稍后重试" });
    }
  });

  app.get("/api/agent-teams/:teamId", async (req, reply) => {
    const userId = requireUserId(req.userId);
    const teamId = paramsId(req.params, "teamId");
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!teamId) return reply.code(400).send({ error: "参数不合法" });
    const team = await findOwnedTeam(prisma, userId, teamId);
    if (!team) return reply.code(404).send({ error: "团队不存在" });
    return { success: true, data: { team: serializeTeam(team) } };
  });

  app.get("/api/agent-teams/runs/:runId", async (req, reply) => {
    const userId = requireUserId(req.userId);
    const runId = paramsId(req.params, "runId");
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!runId) return reply.code(400).send({ error: "参数不合法" });
    const run = await loadOwnedRun(prisma, userId, runId);
    if (!run) return reply.code(404).send({ error: "运行不存在" });
    return { success: true, data: { run: serializeRun(run) } };
  });

  app.post("/api/agent-teams/runs/:runId/cancel", async (req, reply) => {
    const userId = requireUserId(req.userId);
    const runId = paramsId(req.params, "runId");
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!runId) return reply.code(400).send({ error: "参数不合法" });

    const updated = await prisma.agentWorkflowRun.updateMany({
      where: {
        id: runId,
        userId,
        cancelledAt: null,
        status: {
          notIn: [
            AGENT_TEAM_RUN_STATUS.succeeded,
            AGENT_TEAM_RUN_STATUS.failed,
            AGENT_TEAM_RUN_STATUS.cancelled,
            AGENT_TEAM_RUN_STATUS.teamRejected,
          ],
        },
      },
      data: {
        status: AGENT_TEAM_RUN_STATUS.cancelled,
        cancelledAt: new Date(),
        completedAt: new Date(),
        error: "运行已取消",
      },
    });
    if (updated.count !== 1) {
      const existing = await loadOwnedRun(prisma, userId, runId);
      if (!existing) return reply.code(404).send({ error: "运行不存在" });
      return reply.code(409).send({ error: "运行已结束，无法取消" });
    }

    const run = await loadOwnedRun(prisma, userId, runId);
    if (!run) return reply.code(404).send({ error: "运行不存在" });
    return { success: true, data: { run: serializeRun(run) } };
  });
}
