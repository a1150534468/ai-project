import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { AGENT_TEAM_RUN_STATUS, AGENT_WORKFLOW_STEP_STATUS } from "./agent-team-types.js";
import { emptyKnowledgeBaseContext } from "./agent-knowledge-context.js";
import { createRunFromTeam, createWorkflowSteps } from "./agent-workflow-service.js";
import type { WorkflowPlanStep } from "./agent-workflow-plan.js";

interface CreateManyArgs {
  readonly data: readonly unknown[];
}

function expectCreateManyArgs(value: CreateManyArgs | null): CreateManyArgs {
  if (!value) throw new Error("createMany was not called");
  return value;
}

function workflowStep(index: number): WorkflowPlanStep {
  return {
    title: `步骤 ${index}`,
    goal: "完成任务",
    memberName: "任务规划官",
    input: { index },
  };
}

describe("agent workflow service", () => {
  it("creates a team-confirmed run from an owned reusable team", async () => {
    const agentTeam = {
      findUnique: vi.fn(async () => ({
        id: "team-1",
        userId: "user-1",
        name: "合同团队",
        description: "审查合同",
        mainAgentPrompt: "统筹审查",
        members: [{
          name: "任务规划官",
          role: "规划",
          responsibility: "拆解任务",
          systemPrompt: "负责拆解任务",
          skills: ["规划"],
          isCore: true,
          position: 0,
        }],
      })),
    };
    const agentWorkflowRun = {
      create: vi.fn(async (args: unknown) => args),
    };
    const prisma = { agentTeam, agentWorkflowRun } as unknown as PrismaClient;

    await createRunFromTeam(prisma, "user-1", "team-1", "审查采购合同", {
      knowledgeBase: emptyKnowledgeBaseContext(),
      attachments: [],
      attachmentLabel: "",
      attachmentText: "",
      hasImageAttachment: false,
      computerTools: [],
    });

    expect(agentTeam.findUnique).toHaveBeenCalledWith({
      where: { id_userId: { id: "team-1", userId: "user-1" } },
      include: { members: { orderBy: { position: "asc" } } },
    });
    expect(agentWorkflowRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: "user-1",
        teamId: "team-1",
        status: AGENT_TEAM_RUN_STATUS.teamConfirmed,
      }),
    }));
  });

  it("replaces old steps and stores at most twelve pending plan steps", async () => {
    let createManyArgs: CreateManyArgs | null = null;
    const agentWorkflowRun = {
      findUnique: vi.fn(async () => ({
        id: "run-1",
        teamSnapshot: {
          members: [{
            name: "任务规划官",
            role: "规划",
            responsibility: "拆解任务",
            systemPrompt: "负责拆解任务",
            skills: ["规划"],
            isCore: true,
          }],
        },
      })),
      update: vi.fn(async (args: unknown) => args),
    };
    const agentWorkflowStep = {
      deleteMany: vi.fn(async () => ({ count: 1 })),
      createMany: vi.fn(async (args: CreateManyArgs) => {
        createManyArgs = args;
        return { count: args.data.length };
      }),
    };
    const tx = { agentWorkflowRun, agentWorkflowStep };
    const prisma = {
      agentWorkflowRun,
      agentWorkflowStep,
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaClient;

    await createWorkflowSteps(
      prisma,
      "user-1",
      "run-1",
      Array.from({ length: 13 }, (_, index) => workflowStep(index + 1)),
    );

    expect(agentWorkflowRun.findUnique).toHaveBeenCalledWith({
      where: { id_userId: { id: "run-1", userId: "user-1" } },
      select: { id: true, teamSnapshot: true },
    });
    expect(agentWorkflowStep.deleteMany).toHaveBeenCalledWith({ where: { runId: "run-1", userId: "user-1" } });
    expect(agentWorkflowStep.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([
        expect.objectContaining({
          runId: "run-1",
          userId: "user-1",
          status: AGENT_WORKFLOW_STEP_STATUS.pending,
          position: 0,
        }),
      ]),
    }));
    expect(expectCreateManyArgs(createManyArgs).data).toHaveLength(12);
    expect(agentWorkflowRun.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id_userId: { id: "run-1", userId: "user-1" } },
      data: expect.objectContaining({ status: AGENT_TEAM_RUN_STATUS.planning }),
    }));
  });
});
