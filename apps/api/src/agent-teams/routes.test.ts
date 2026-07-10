import Fastify from "fastify";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentTeamRoutes, type AgentTeamRouteOptions } from "./routes.js";
import type { RecommendedTeam } from "./agent-team-types.js";
import type { WorkflowPlanStep } from "./agent-workflow-plan.js";

interface ScheduledWorkRecorder {
  readonly tasks: Promise<void>[];
  scheduleTask: (work: () => Promise<void>) => void;
  waitForAll: () => Promise<void>;
}

interface MockTeamMember {
  readonly id: string;
  readonly teamId: string;
  readonly userId: string;
  readonly name: string;
  readonly role: string;
  readonly responsibility: string;
  readonly systemPrompt: string;
  readonly skills: Prisma.JsonValue;
  readonly isCore: boolean;
  readonly position: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface MockTeam {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly description: string;
  readonly mainAgentPrompt: string;
  readonly sourceRunId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface MockRun {
  readonly id: string;
  readonly userId: string;
  readonly teamId: string | null;
  readonly taskGoal: string;
  readonly status: string;
  readonly teamSnapshot: Prisma.JsonValue;
  readonly planSnapshot: Prisma.JsonValue;
  readonly finalReport: string;
  readonly error: string | null;
  readonly operationIds: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
  readonly cancelledAt: Date | null;
}

interface MockStep {
  readonly id: string;
  readonly runId: string;
  readonly userId: string;
  readonly memberName: string;
  readonly memberSnapshot: Prisma.JsonValue;
  readonly title: string;
  readonly goal: string;
  readonly input: Prisma.JsonValue;
  readonly output: string;
  readonly status: string;
  readonly position: number;
  readonly retryCount: number;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

interface MockEvent {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string | null;
  readonly userId: string;
  readonly memberName: string;
  readonly type: string;
  readonly message: string;
  readonly payload: Prisma.JsonValue | null;
  readonly createdAt: Date;
}

const primaryUserId = "user-primary";
const secondaryUserId = "user-secondary";

const recommendedTeam: RecommendedTeam = {
  teamName: "合同攻坚队",
  teamDescription: "负责拆解、审查与总结采购合同风险",
  mainAgentPrompt: "统筹团队分工并收敛最终结论",
  members: [
    {
      name: "任务规划官",
      role: "Planner",
      responsibility: "拆解目标与步骤",
      systemPrompt: "你负责拆解任务并给出行动计划。",
      skills: ["planning"],
      isCore: true,
    },
    {
      name: "条款审查员",
      role: "Reviewer",
      responsibility: "逐条识别风险条款",
      systemPrompt: "你负责审查条款并指出风险。",
      skills: ["contract-review"],
      isCore: true,
    },
    {
      name: "结论总结员",
      role: "Reporter",
      responsibility: "汇总结论与行动项",
      systemPrompt: "你负责汇总结论并生成最终报告。",
      skills: ["reporting"],
      isCore: false,
    },
  ],
};

const workflowPlan: readonly WorkflowPlanStep[] = [
  {
    title: "拆解审查目标",
    goal: "明确要检查的重点风险",
    memberName: "任务规划官",
    input: { section: "scope" },
  },
  {
    title: "完成合同审查",
    goal: "输出条款风险清单",
    memberName: "条款审查员",
    input: { section: "clauses" },
  },
];

const uploadedTextAttachment = {
  name: "purchase-contract.txt",
  mime: "text/plain",
  sizeBytes: Buffer.byteLength("付款节点：验收后 30 天内付款。"),
  kind: "file" as const,
  dataBase64: Buffer.from("付款节点：验收后 30 天内付款。", "utf8").toString("base64"),
};

const knowledgeBases = [
  {
    id: "kb-owned",
    ownerType: "USER",
    userId: primaryUserId,
    name: "采购合同知识库",
    description: "采购合同审查规范",
    documents: [{
      name: "付款条款指南.txt",
      status: "indexed",
      chunks: [{ ordinal: 1, content: "付款条件应明确验收节点、账期和违约责任。" }],
    }],
  },
  {
    id: "kb-official",
    ownerType: "OFFICIAL",
    userId: null,
    name: "官方合规库",
    description: "官方合规参考",
    documents: [{
      name: "合同合规手册.txt",
      status: "indexed",
      chunks: [{ ordinal: 2, content: "重大合同应保留审批记录和授权依据。" }],
    }],
  },
  {
    id: "kb-other-user",
    ownerType: "USER",
    userId: secondaryUserId,
    name: "他人知识库",
    description: "",
    documents: [{
      name: "不可访问.txt",
      status: "indexed",
      chunks: [{ ordinal: 1, content: "不应进入上下文。" }],
    }],
  },
] as const;

function createScheduledWorkRecorder(): ScheduledWorkRecorder {
  const tasks: Promise<void>[] = [];
  return {
    tasks,
    scheduleTask(work) {
      tasks.push(work());
    },
    async waitForAll() {
      await Promise.all(tasks);
    },
  };
}

function createPrismaMock(): PrismaClient {
  const teams: MockTeam[] = [];
  const teamMembers: MockTeamMember[] = [];
  const runs: MockRun[] = [];
  const steps: MockStep[] = [];
  const events: MockEvent[] = [];
  let idCounter = 0;
  let timeCounter = 0;

  function nextId(prefix: string): string {
    idCounter += 1;
    return `${prefix}-${idCounter}`;
  }

  function nextDate(): Date {
    timeCounter += 1;
    return new Date(Date.UTC(2026, 6, 3, 0, 0, timeCounter));
  }

  function cloneJson(value: Prisma.JsonValue | undefined): Prisma.JsonValue {
    if (value === undefined || value === null) return null;
    return JSON.parse(JSON.stringify(value)) as Prisma.JsonValue;
  }

  function sortSteps(runId: string): MockStep[] {
    return steps.filter((step) => step.runId === runId).sort((left, right) => left.position - right.position);
  }

  function sortEvents(runId: string): MockEvent[] {
    return events.filter((event) => event.runId === runId).sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  }

  function membersForTeam(teamId: string): MockTeamMember[] {
    return teamMembers.filter((member) => member.teamId === teamId).sort((left, right) => left.position - right.position);
  }

  function teamRecord(team: MockTeam) {
    return {
      ...team,
      sourceRunId: team.sourceRunId,
      members: membersForTeam(team.id),
    };
  }

  function runRecord(run: MockRun) {
    return {
      ...run,
      steps: sortSteps(run.id),
      events: sortEvents(run.id),
    };
  }

  function matchesRunWhere(run: MockRun, where: Record<string, unknown>): boolean {
    if (typeof where.id === "string" && run.id !== where.id) return false;
    if (typeof where.userId === "string" && run.userId !== where.userId) return false;
    if (typeof where.teamId === "string" && run.teamId !== where.teamId) return false;
    if (where.cancelledAt === null && run.cancelledAt !== null) return false;

    const status = where.status;
    if (typeof status === "string" && run.status !== status) return false;
    if (typeof status === "object" && status !== null) {
      const notValue = Reflect.get(status, "not");
      if (typeof notValue === "string" && run.status === notValue) return false;
      const notInValue = Reflect.get(status, "notIn");
      if (Array.isArray(notInValue) && notInValue.includes(run.status)) return false;
    }
    return true;
  }

  function matchesStepWhere(step: MockStep, where: Record<string, unknown>): boolean {
    if (typeof where.id === "string" && step.id !== where.id) return false;
    if (typeof where.runId === "string" && step.runId !== where.runId) return false;
    if (typeof where.userId === "string" && step.userId !== where.userId) return false;
    if (typeof where.status === "string" && step.status !== where.status) return false;
    return true;
  }

  function updateRun(run: MockRun, data: Record<string, unknown>): void {
    const index = runs.findIndex((item) => item.id === run.id);
    runs[index] = {
      ...run,
      teamId: typeof data.teamId === "string" ? data.teamId : data.teamId === null ? null : run.teamId,
      status: typeof data.status === "string" ? data.status : run.status,
      teamSnapshot: "teamSnapshot" in data ? cloneJson(data.teamSnapshot as Prisma.JsonValue) : run.teamSnapshot,
      planSnapshot: "planSnapshot" in data ? cloneJson(data.planSnapshot as Prisma.JsonValue) : run.planSnapshot,
      finalReport: typeof data.finalReport === "string" ? data.finalReport : run.finalReport,
      error: typeof data.error === "string" ? data.error : data.error === null ? null : run.error,
      updatedAt: nextDate(),
      completedAt: data.completedAt instanceof Date ? data.completedAt : data.completedAt === null ? null : run.completedAt,
      cancelledAt: data.cancelledAt instanceof Date ? data.cancelledAt : data.cancelledAt === null ? null : run.cancelledAt,
    };
  }

  function updateStep(step: MockStep, data: Record<string, unknown>): void {
    const index = steps.findIndex((item) => item.id === step.id);
    steps[index] = {
      ...step,
      status: typeof data.status === "string" ? data.status : step.status,
      output: typeof data.output === "string" ? data.output : step.output,
      error: typeof data.error === "string" ? data.error : data.error === null ? null : step.error,
      retryCount: typeof data.retryCount === "number" ? data.retryCount : step.retryCount,
      updatedAt: nextDate(),
      startedAt: data.startedAt instanceof Date ? data.startedAt : data.startedAt === null ? null : step.startedAt,
      completedAt: data.completedAt instanceof Date ? data.completedAt : data.completedAt === null ? null : step.completedAt,
    };
  }

  const prisma: Record<string, unknown> = {
    agentTeam: {
      findMany: vi.fn(async (args: { readonly where: { readonly userId: string } }) => {
        return teams
          .filter((team) => team.userId === args.where.userId)
          .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
          .map(teamRecord);
      }),
      findFirst: vi.fn(async (args: { readonly where: { readonly userId?: string; readonly sourceRunId?: string | null } }) => {
        const team = teams.find((item) => (
          (args.where.userId === undefined || item.userId === args.where.userId) &&
          (args.where.sourceRunId === undefined || item.sourceRunId === args.where.sourceRunId)
        ));
        return team ? teamRecord(team) : null;
      }),
      findUnique: vi.fn(async (args: { readonly where: { readonly id_userId: { readonly id: string; readonly userId: string } } }) => {
        const team = teams.find((item) => item.id === args.where.id_userId.id && item.userId === args.where.id_userId.userId);
        return team ? teamRecord(team) : null;
      }),
      create: vi.fn(async (args: {
        readonly data: {
          readonly user?: { readonly connect: { readonly id: string } };
          readonly userId?: string;
          readonly name: string;
          readonly description: string;
          readonly mainAgentPrompt: string;
          readonly sourceRunId?: string;
          readonly members: {
            readonly create: readonly {
              readonly user?: { readonly connect: { readonly id: string } };
              readonly userId?: string;
              readonly name: string;
              readonly role: string;
              readonly responsibility: string;
              readonly systemPrompt: string;
              readonly skills: readonly string[];
              readonly isCore: boolean;
              readonly position: number;
            }[];
          };
        };
      }) => {
        if (args.data.userId) throw new Error("Unknown argument `userId`");
        const connectedUserId = args.data.user?.connect.id;
        if (!connectedUserId) throw new Error("Missing required relation `user`");
        const createdAt = nextDate();
        const team: MockTeam = {
          id: nextId("team"),
          userId: connectedUserId,
          name: args.data.name,
          description: args.data.description,
          mainAgentPrompt: args.data.mainAgentPrompt,
          sourceRunId: args.data.sourceRunId ?? null,
          createdAt,
          updatedAt: createdAt,
        };
        teams.push(team);
        for (const member of args.data.members.create) {
          if (member.userId) throw new Error("Unknown argument `userId`");
          const memberUserId = member.user?.connect.id;
          if (!memberUserId) throw new Error("Missing required relation `user`");
          const memberCreatedAt = nextDate();
          teamMembers.push({
            id: nextId("member"),
            teamId: team.id,
            userId: memberUserId,
            name: member.name,
            role: member.role,
            responsibility: member.responsibility,
            systemPrompt: member.systemPrompt,
            skills: cloneJson([...member.skills]),
            isCore: member.isCore,
            position: member.position,
            createdAt: memberCreatedAt,
            updatedAt: memberCreatedAt,
          });
        }
        return teamRecord(team);
      }),
      deleteMany: vi.fn(async (args: { readonly where: { readonly id?: string; readonly userId?: string } }) => {
        let count = 0;
        for (let index = teams.length - 1; index >= 0; index -= 1) {
          const team = teams[index];
          if (args.where.id && team.id !== args.where.id) continue;
          if (args.where.userId && team.userId !== args.where.userId) continue;
          teams.splice(index, 1);
          count += 1;
        }
        return { count };
      }),
    },
    agentTeamMember: {
      deleteMany: vi.fn(async (args: { readonly where: { readonly teamId?: string; readonly userId?: string } }) => {
        let count = 0;
        for (let index = teamMembers.length - 1; index >= 0; index -= 1) {
          const member = teamMembers[index];
          if (args.where.teamId && member.teamId !== args.where.teamId) continue;
          if (args.where.userId && member.userId !== args.where.userId) continue;
          teamMembers.splice(index, 1);
          count += 1;
        }
        return { count };
      }),
    },
    agentWorkflowRun: {
      create: vi.fn(async (args: { readonly data: Record<string, unknown> }) => {
        const createdAt = nextDate();
        const run: MockRun = {
          id: nextId("run"),
          userId: String(args.data.userId),
          teamId: typeof args.data.teamId === "string" ? args.data.teamId : null,
          taskGoal: String(args.data.taskGoal),
          status: String(args.data.status),
          teamSnapshot: cloneJson(args.data.teamSnapshot as Prisma.JsonValue),
          planSnapshot: "planSnapshot" in args.data ? cloneJson(args.data.planSnapshot as Prisma.JsonValue) : {},
          finalReport: "",
          error: null,
          operationIds: [],
          createdAt,
          updatedAt: createdAt,
          completedAt: null,
          cancelledAt: null,
        };
        runs.push(run);
        return { ...run };
      }),
      findUnique: vi.fn(async (args: { readonly where: { readonly id_userId: { readonly id: string; readonly userId: string } }; readonly select?: Record<string, boolean>; readonly include?: Record<string, unknown> }) => {
        const run = runs.find((item) => item.id === args.where.id_userId.id && item.userId === args.where.id_userId.userId);
        if (!run) return null;
        if (args.select) {
          const selected: Record<string, unknown> = {};
          for (const [key, enabled] of Object.entries(args.select)) {
            if (enabled) selected[key] = Reflect.get(run, key);
          }
          return selected;
        }
        if (args.include) {
          return runRecord(run);
        }
        return { ...run };
      }),
      findMany: vi.fn(async (args: {
        readonly where?: { readonly userId?: string };
        readonly include?: Record<string, unknown>;
        readonly orderBy?: { readonly updatedAt?: "asc" | "desc" };
        readonly take?: number;
      }) => {
        const userId = args.where?.userId;
        const sorted = runs
          .filter((run) => !userId || run.userId === userId)
          .sort((left, right) => {
            const diff = left.updatedAt.getTime() - right.updatedAt.getTime();
            return args.orderBy?.updatedAt === "asc" ? diff : -diff;
          })
          .slice(0, args.take ?? runs.length);
        return args.include ? sorted.map(runRecord) : sorted.map((run) => ({ ...run }));
      }),
      updateMany: vi.fn(async (args: { readonly where: Record<string, unknown>; readonly data: Record<string, unknown> }) => {
        let count = 0;
        for (const run of [...runs]) {
          if (!matchesRunWhere(run, args.where)) continue;
          updateRun(run, args.data);
          count += 1;
        }
        return { count };
      }),
      update: vi.fn(async (args: { readonly where: { readonly id_userId: { readonly id: string; readonly userId: string } }; readonly data: Record<string, unknown>; readonly include?: Record<string, unknown> }) => {
        const run = runs.find((item) => item.id === args.where.id_userId.id && item.userId === args.where.id_userId.userId);
        if (!run) throw new Error("run not found");
        updateRun(run, args.data);
        const updated = runs.find((item) => item.id === run.id);
        if (!updated) throw new Error("run missing after update");
        return args.include ? runRecord(updated) : { ...updated };
      }),
    },
    agentWorkflowStep: {
      deleteMany: vi.fn(async (args: { readonly where: { readonly runId: string; readonly userId: string } }) => {
        const before = steps.length;
        for (let index = steps.length - 1; index >= 0; index -= 1) {
          const item = steps[index];
          if (item.runId === args.where.runId && item.userId === args.where.userId) steps.splice(index, 1);
        }
        return { count: before - steps.length };
      }),
      createMany: vi.fn(async (args: { readonly data: readonly Record<string, unknown>[] }) => {
        for (const row of args.data) {
          const createdAt = nextDate();
          steps.push({
            id: nextId("step"),
            runId: String(row.runId),
            userId: String(row.userId),
            memberName: String(row.memberName),
            memberSnapshot: cloneJson(row.memberSnapshot as Prisma.JsonValue),
            title: String(row.title),
            goal: String(row.goal),
            input: cloneJson(row.input as Prisma.JsonValue),
            output: "",
            status: String(row.status),
            position: Number(row.position),
            retryCount: 0,
            error: null,
            createdAt,
            updatedAt: createdAt,
            startedAt: null,
            completedAt: null,
          });
        }
        return { count: args.data.length };
      }),
      findFirst: vi.fn(async (args: { readonly where: Record<string, unknown>; readonly select?: Record<string, boolean> }) => {
        const found = steps
          .filter((step) => matchesStepWhere(step, args.where))
          .sort((left, right) => left.position - right.position)[0];
        if (!found) return null;
        if (!args.select) return { ...found };
        const selected: Record<string, unknown> = {};
        for (const [key, enabled] of Object.entries(args.select)) {
          if (enabled) selected[key] = Reflect.get(found, key);
        }
        return selected;
      }),
      updateMany: vi.fn(async (args: { readonly where: Record<string, unknown>; readonly data: Record<string, unknown> }) => {
        let count = 0;
        for (const step of [...steps]) {
          if (!matchesStepWhere(step, args.where)) continue;
          updateStep(step, args.data);
          count += 1;
        }
        return { count };
      }),
    },
    agentWorkflowEvent: {
      create: vi.fn(async (args: { readonly data: Record<string, unknown> }) => {
        const event: MockEvent = {
          id: nextId("event"),
          runId: String(args.data.runId),
          stepId: typeof args.data.stepId === "string" ? args.data.stepId : null,
          userId: String(args.data.userId),
          memberName: String(args.data.memberName ?? ""),
          type: String(args.data.type),
          message: String(args.data.message),
          payload: "payload" in args.data ? cloneJson(args.data.payload as Prisma.JsonValue) : null,
          createdAt: nextDate(),
        };
        events.push(event);
        return { ...event };
      }),
    },
    device: {
      findMany: vi.fn(async () => []),
    },
    knowledgeBase: {
      findMany: vi.fn(async (args: {
        readonly where?: {
          readonly ownerType?: string;
          readonly userId?: string;
          readonly id?: { readonly in?: readonly string[] };
        };
        readonly select?: Record<string, unknown>;
      }) => {
        const idFilter = args.where?.id?.in;
        let rows = idFilter
          ? knowledgeBases.filter((kb) => idFilter.includes(kb.id))
          : knowledgeBases;
        if (args.where?.ownerType) rows = rows.filter((kb) => kb.ownerType === args.where?.ownerType);
        if (args.where?.userId) rows = rows.filter((kb) => kb.userId === args.where?.userId);
        if (args.select?.documents) return rows.map((kb) => ({
          id: kb.id,
          name: kb.name,
          description: kb.description,
          ownerType: kb.ownerType,
          documents: kb.documents,
        }));
        if (args.select?.ownerType || args.select?.userId) return rows.map((kb) => ({
          id: kb.id,
          ownerType: kb.ownerType,
          userId: kb.userId,
        }));
        return rows.map((kb) => ({ id: kb.id }));
      }),
    },
    $transaction: vi.fn(async <T>(work: (client: PrismaClient) => Promise<T>) => work(prisma as unknown as PrismaClient)),
  };

  return prisma as unknown as PrismaClient;
}

async function createApp(options: {
  readonly deps?: AgentTeamRouteOptions;
}) {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      req.userId = auth.slice(7);
    }
  });
  await app.register(agentTeamRoutes, options.deps ?? {});
  await app.ready();
  return app;
}

async function createReusableTeam(prisma: PrismaClient, userId: string) {
  return prisma.agentTeam.create({
    data: {
      user: { connect: { id: userId } },
      name: recommendedTeam.teamName,
      description: recommendedTeam.teamDescription,
      mainAgentPrompt: recommendedTeam.mainAgentPrompt,
      members: {
        create: recommendedTeam.members.map((member, index) => ({
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
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent team routes", () => {
  it("creates an awaiting-team-confirmation recommendation run without scheduling execution", async () => {
    const prisma = createPrismaMock();
    const scheduled = createScheduledWorkRecorder();
    const recommendTeam = vi.fn(async () => recommendedTeam);
    const app = await createApp({
      deps: {
        prisma,
        scheduleTask: scheduled.scheduleTask,
        recommendTeam,
        planWorkflow: vi.fn(async () => workflowPlan),
        executeStep: vi.fn(async () => "unused"),
        summarize: vi.fn(async () => "unused"),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent-teams/recommend",
      headers: { authorization: `Bearer ${primaryUserId}` },
      payload: { taskGoal: "审查采购合同并汇总风险" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.recommendation.teamName).toBe(recommendedTeam.teamName);
    expect(body.data.run.status).toBe("awaiting_team_confirmation");
    expect(body.data.run.teamId).toBeNull();
    expect(recommendTeam).toHaveBeenCalledWith("审查采购合同并汇总风险", expect.objectContaining({
      attachments: [],
    }));
    expect(scheduled.tasks).toHaveLength(0);

    await app.close();
  });

  it("lists the current user's agent workflow history", async () => {
    const prisma = createPrismaMock();
    const scheduled = createScheduledWorkRecorder();
    const app = await createApp({
      deps: {
        prisma,
        scheduleTask: scheduled.scheduleTask,
        recommendTeam: vi.fn(async () => recommendedTeam),
        planWorkflow: vi.fn(async () => workflowPlan),
        executeStep: vi.fn(async () => "unused"),
        summarize: vi.fn(async () => "unused"),
      },
    });

    await app.inject({
      method: "POST",
      url: "/api/agent-teams/recommend",
      headers: { authorization: `Bearer ${primaryUserId}` },
      payload: { taskGoal: "第一次审查合同" },
    });
    await app.inject({
      method: "POST",
      url: "/api/agent-teams/recommend",
      headers: { authorization: `Bearer ${secondaryUserId}` },
      payload: { taskGoal: "他人的任务" },
    });
    await app.inject({
      method: "POST",
      url: "/api/agent-teams/recommend",
      headers: { authorization: `Bearer ${primaryUserId}` },
      payload: { taskGoal: "第二次审查授权书" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/agent-teams/runs",
      headers: { authorization: `Bearer ${primaryUserId}` },
    });

    expect(response.statusCode).toBe(200);
    const runs = response.json().data.runs;
    expect(runs.map((run: { taskGoal: string }) => run.taskGoal)).toEqual([
      "第二次审查授权书",
      "第一次审查合同",
    ]);
    expect(JSON.stringify(runs)).not.toContain("他人的任务");

    await app.close();
  });

  it("stores selected model and uploaded files in the task context", async () => {
    const prisma = createPrismaMock();
    const scheduled = createScheduledWorkRecorder();
    const recommendTeam = vi.fn(async () => recommendedTeam);
    const app = await createApp({
      deps: {
        prisma,
        scheduleTask: scheduled.scheduleTask,
        recommendTeam,
        planWorkflow: vi.fn(async () => workflowPlan),
        executeStep: vi.fn(async () => "unused"),
        summarize: vi.fn(async () => "unused"),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent-teams/recommend",
      headers: { authorization: `Bearer ${primaryUserId}` },
      payload: {
        taskGoal: "审查采购合同并汇总风险",
        model: "MiniMax-M3",
        attachments: [uploadedTextAttachment],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(recommendTeam).toHaveBeenCalledWith("审查采购合同并汇总风险", expect.objectContaining({
      selectedModel: "MiniMax-M3",
      attachments: [expect.objectContaining({ name: "purchase-contract.txt" })],
      attachmentText: expect.stringContaining("付款节点"),
    }));
    const run = response.json().data.run;
    expect(run.teamSnapshot.taskContext.selectedModel).toBe("MiniMax-M3");
    expect(run.teamSnapshot.taskContext.attachmentText).toContain("付款节点");
    expect(run.teamSnapshot.taskContext.computerTools.length).toBeGreaterThan(0);

    await app.close();
  });

  it("filters and stores mounted knowledge bases in the task context", async () => {
    const prisma = createPrismaMock();
    const scheduled = createScheduledWorkRecorder();
    const recommendTeam = vi.fn(async () => recommendedTeam);
    const app = await createApp({
      deps: {
        prisma,
        scheduleTask: scheduled.scheduleTask,
        recommendTeam,
        planWorkflow: vi.fn(async () => workflowPlan),
        executeStep: vi.fn(async () => "unused"),
        summarize: vi.fn(async () => "unused"),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent-teams/recommend",
      headers: { authorization: `Bearer ${primaryUserId}` },
      payload: {
        taskGoal: "根据知识库审查采购合同",
        kbIds: ["kb-owned", "kb-official", "kb-other-user"],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(recommendTeam).toHaveBeenCalledWith("根据知识库审查采购合同", expect.objectContaining({
      knowledgeBase: expect.objectContaining({
        effectiveKbIds: ["kb-owned", "kb-official"],
        knowledgeText: expect.stringContaining("付款条件应明确验收节点"),
      }),
    }));
    const taskContext = response.json().data.run.teamSnapshot.taskContext;
    expect(taskContext.knowledgeBase.effectiveKbIds).toEqual(["kb-owned", "kb-official"]);
    expect(taskContext.knowledgeBase.knowledgeText).toContain("重大合同应保留审批记录");
    expect(taskContext.knowledgeBase.knowledgeText).not.toContain("不应进入上下文");

    await app.close();
  });

  it("confirms a recommended team, stores it, and completes the scheduled workflow", async () => {
    const prisma = createPrismaMock();
    const scheduled = createScheduledWorkRecorder();
    const executeStep = vi.fn(async ({ step, run }: { readonly step: { readonly title: string }; readonly run: { readonly taskGoal: string } }) => {
      expect(JSON.stringify(run)).toContain("MiniMax-M3");
      expect(JSON.stringify(run)).toContain("付款节点");
      return `${run.taskGoal}:${step.title}`;
    });
    const summarize = vi.fn(async ({ run, steps }: { readonly run: { readonly taskGoal: string }; readonly steps: readonly { readonly output: string }[] }) => {
      return `总结:${run.taskGoal}:${steps.map((step) => step.output).join("|")}`;
    });
    const app = await createApp({
      deps: {
        prisma,
        scheduleTask: scheduled.scheduleTask,
        recommendTeam: vi.fn(async () => recommendedTeam),
        planWorkflow: vi.fn(async () => workflowPlan),
        executeStep,
        summarize,
      },
    });

    const recommendResponse = await app.inject({
      method: "POST",
      url: "/api/agent-teams/recommend",
      headers: { authorization: `Bearer ${primaryUserId}` },
      payload: { taskGoal: "审查采购合同并汇总风险", model: "MiniMax-M3", attachments: [uploadedTextAttachment] },
    });
    const runId = recommendResponse.json().data.run.id as string;

    const confirmResponse = await app.inject({
      method: "POST",
      url: `/api/agent-teams/runs/${runId}/confirm-team`,
      headers: { authorization: `Bearer ${primaryUserId}` },
      payload: recommendedTeam,
    });

    expect(confirmResponse.statusCode).toBe(200);
    const confirmed = confirmResponse.json();
    expect(confirmed.data.team.name).toBe(recommendedTeam.teamName);
    expect(confirmed.data.run.status).toBe("team_confirmed");
    expect(scheduled.tasks).toHaveLength(1);

    await scheduled.waitForAll();

    const getRunResponse = await app.inject({
      method: "GET",
      url: `/api/agent-teams/runs/${runId}`,
      headers: { authorization: `Bearer ${primaryUserId}` },
    });

    expect(getRunResponse.statusCode).toBe(200);
    const runBody = getRunResponse.json();
    expect(runBody.data.run.status).toBe("succeeded");
    expect(runBody.data.run.finalReport).toContain("总结:审查采购合同并汇总风险");
    expect(runBody.data.run.steps).toHaveLength(2);
    expect(runBody.data.run.events.length).toBeGreaterThanOrEqual(2);
    expect(executeStep).toHaveBeenCalledTimes(2);
    expect(summarize).toHaveBeenCalledTimes(1);

    const savedTeam = await prisma.agentTeam.findFirst({
      where: { userId: primaryUserId, sourceRunId: runId },
      include: { members: { orderBy: { position: "asc" } } },
    });
    expect(savedTeam?.members).toHaveLength(3);

    await app.close();
  });

  it("creates a run from an existing reusable team without calling recommendTeam", async () => {
    const prisma = createPrismaMock();
    const scheduled = createScheduledWorkRecorder();
    const recommendTeam = vi.fn(async () => recommendedTeam);
    const summarize = vi.fn(async () => "最终总结");
    const team = await createReusableTeam(prisma, primaryUserId);
    const app = await createApp({
      deps: {
        prisma,
        scheduleTask: scheduled.scheduleTask,
        recommendTeam,
        planWorkflow: vi.fn(async () => workflowPlan),
        executeStep: vi.fn(async ({ step }: { readonly step: { readonly title: string } }) => `输出:${step.title}`),
        summarize,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agent-teams/${team.id}/runs`,
      headers: { authorization: `Bearer ${primaryUserId}` },
      payload: { taskGoal: "复用既有团队审查合同" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.data.run.teamId).toBe(team.id);
    expect(body.data.run.status).toBe("team_confirmed");
    expect(recommendTeam).not.toHaveBeenCalled();
    expect(scheduled.tasks).toHaveLength(1);

    await scheduled.waitForAll();

    const getRunResponse = await app.inject({
      method: "GET",
      url: `/api/agent-teams/runs/${body.data.run.id as string}`,
      headers: { authorization: `Bearer ${primaryUserId}` },
    });
    expect(getRunResponse.statusCode).toBe(200);
    expect(getRunResponse.json().data.run.status).toBe("succeeded");
    expect(getRunResponse.json().data.run.finalReport).toBe("最终总结");
    expect(getRunResponse.json().data.run.steps).toHaveLength(2);
    expect(summarize).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("lists owned teams and returns 404 for another user's team or run", async () => {
    const prisma = createPrismaMock();
    const scheduled = createScheduledWorkRecorder();
    const team = await createReusableTeam(prisma, primaryUserId);
    const app = await createApp({
      deps: {
        prisma,
        scheduleTask: scheduled.scheduleTask,
        recommendTeam: vi.fn(async () => recommendedTeam),
        planWorkflow: vi.fn(async () => workflowPlan),
        executeStep: vi.fn(async ({ step }: { readonly step: { readonly title: string } }) => `输出:${step.title}`),
        summarize: vi.fn(async () => "最终总结"),
      },
    });

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/agent-teams",
      headers: { authorization: `Bearer ${primaryUserId}` },
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().data.teams).toHaveLength(1);

    const createRunResponse = await app.inject({
      method: "POST",
      url: `/api/agent-teams/${team.id}/runs`,
      headers: { authorization: `Bearer ${primaryUserId}` },
      payload: { taskGoal: "复用既有团队审查合同" },
    });
    const runId = createRunResponse.json().data.run.id as string;

    const teamResponse = await app.inject({
      method: "GET",
      url: `/api/agent-teams/${team.id}`,
      headers: { authorization: `Bearer ${secondaryUserId}` },
    });
    expect(teamResponse.statusCode).toBe(404);

    const runResponse = await app.inject({
      method: "GET",
      url: `/api/agent-teams/runs/${runId}`,
      headers: { authorization: `Bearer ${secondaryUserId}` },
    });
    expect(runResponse.statusCode).toBe(404);

    await app.close();
  });

  it("deletes a reusable team while keeping its workflow history", async () => {
    const prisma = createPrismaMock();
    const scheduleTask = vi.fn();
    const team = await createReusableTeam(prisma, primaryUserId);
    const app = await createApp({
      deps: {
        prisma,
        scheduleTask,
        recommendTeam: vi.fn(async () => recommendedTeam),
        planWorkflow: vi.fn(async () => workflowPlan),
        executeStep: vi.fn(async () => "unused"),
        summarize: vi.fn(async () => "unused"),
      },
    });

    const createRunResponse = await app.inject({
      method: "POST",
      url: `/api/agent-teams/${team.id}/runs`,
      headers: { authorization: `Bearer ${primaryUserId}` },
      payload: { taskGoal: "用这个团队审查授权书" },
    });
    expect(createRunResponse.statusCode).toBe(201);
    const runId = createRunResponse.json().data.run.id as string;

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/agent-teams/${team.id}`,
      headers: { authorization: `Bearer ${primaryUserId}` },
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json().data.deletedTeamId).toBe(team.id);

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/agent-teams",
      headers: { authorization: `Bearer ${primaryUserId}` },
    });
    expect(listResponse.json().data.teams).toHaveLength(0);

    const runResponse = await app.inject({
      method: "GET",
      url: `/api/agent-teams/runs/${runId}`,
      headers: { authorization: `Bearer ${primaryUserId}` },
    });
    expect(runResponse.statusCode).toBe(200);
    expect(runResponse.json().data.run.teamId).toBeNull();
    expect(runResponse.json().data.run.taskGoal).toBe("用这个团队审查授权书");

    const otherUserDeleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/agent-teams/${team.id}`,
      headers: { authorization: `Bearer ${secondaryUserId}` },
    });
    expect(otherUserDeleteResponse.statusCode).toBe(404);

    await app.close();
  });

  it("requires login for protected routes", async () => {
    const prisma = createPrismaMock();
    const app = await createApp({
      deps: {
        prisma,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/agent-teams",
    });

    expect(response.statusCode).toBe(401);

    await app.close();
  });
});
