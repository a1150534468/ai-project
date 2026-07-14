import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseWorkflowPlan, requestWorkflowPlan } from "./agent-workflow-plan.js";
import { emptyKnowledgeBaseContext } from "./agent-knowledge-context.js";

const planSteps = [
  { title: "拆解任务", goal: "明确目标", memberName: "任务规划官", input: { order: 1 } },
  { title: "执行分析", goal: "输出分析", memberName: "资料分析师", input: { order: 2 } },
  { title: "质量审查", goal: "检查结果", memberName: "质量审查官", input: { order: 3 } },
];

const mockLlm = vi.hoisted(() => ({
  planText: "",
}));

const mockBilling = vi.hoisted(() => ({
  reserve: vi.fn(async () => ({ reserved: 1 })),
  settle: vi.fn(async () => ({ settled: 1 })),
}));

vi.mock("@ai-assistant/llm", () => ({
  loadLlmConfig: () => ({ baseURL: "http://llm", apiKey: "key", defaultModel: "test-model" }),
  createLlmClient: () => ({
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: "text", text: mockLlm.planText }],
      })),
    },
  }),
}));

vi.mock("@ai-assistant/billing", () => ({
  createBillingClient: () => mockBilling,
}));

describe("agent workflow plan", () => {
  beforeEach(() => {
    process.env.BILLING_BASE_URL = "http://billing";
    process.env.BILLING_INTERNAL_TOKEN = "token";
    mockLlm.planText = JSON.stringify({ steps: planSteps });
    mockBilling.reserve.mockClear();
    mockBilling.settle.mockClear();
  });

  it("accepts object and array plan shapes", () => {
    expect(parseWorkflowPlan({ steps: planSteps })).toHaveLength(3);
    expect(parseWorkflowPlan(planSteps)).toHaveLength(3);
  });

  it("normalizes string step input into a JSON object", () => {
    const steps = parseWorkflowPlan({
      steps: planSteps.map((step, index) => ({
        ...step,
        input: `执行第 ${index + 1} 步时关注合同风险`,
      })),
    });

    expect(steps[0]?.input).toEqual({ instruction: "执行第 1 步时关注合同风险" });
  });

  it("normalizes wrapped and alternate field plan shapes", () => {
    const steps = parseWorkflowPlan({
      workflow: {
        steps: [
          { name: "读取授权书", objective: "识别授权主体和授权范围", agent: "首席法务官", input: "检查授权主体" },
          { task: "核对授权边界", description: "核对期限、权限和签章", assignee: "风险评估专家", input: { kb: "法律知识库", note: null } },
          { step: "输出审查报告", content: "形成靠谱不靠谱的明确结论", role: "文本校对专家", input: ["标注风险等级"] },
        ],
      },
    }, {
      teamSnapshot: {
        members: [
          { name: "首席法务官" },
          { name: "风险评估专家" },
          { name: "文本校对专家" },
        ],
      },
      taskGoal: "审查授权书靠谱不靠谱",
    });

    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatchObject({
      title: "读取授权书",
      goal: "识别授权主体和授权范围",
      memberName: "首席法务官",
      input: { instruction: "检查授权主体" },
    });
    expect(steps[1]?.input).toEqual({ kb: "法律知识库" });
    expect(steps[2]?.input).toEqual({ items: ["标注风险等级"] });
  });

  it("pads short plans and truncates overlong plans", () => {
    const shortPlan = parseWorkflowPlan({ steps: planSteps.slice(0, 2) }, {
      teamSnapshot: { members: planSteps.map((step) => ({ name: step.memberName })) },
      taskGoal: "审查授权书靠谱不靠谱",
    });
    const longPlan = parseWorkflowPlan({ steps: Array.from({ length: 13 }, (_, index) => ({
      title: `步骤 ${index + 1}`,
      goal: "执行任务",
      memberName: "任务规划官",
      input: {},
    })) });

    expect(shortPlan).toHaveLength(3);
    expect(shortPlan[2]?.title).toBe("形成任务报告");
    expect(longPlan).toHaveLength(12);
  });

  it("requests and parses a workflow plan from the LLM", async () => {
    const steps = await requestWorkflowPlan("审查采购合同", { teamName: "合同团队" });

    expect(steps).toHaveLength(3);
    expect(steps[0]?.memberName).toBe("任务规划官");
  });

  it("bills workflow planning with the selected model when user context is provided", async () => {
    const steps = await requestWorkflowPlan(
      "审查采购合同",
      { teamName: "合同团队" },
      {
        selectedModel: "priced-model",
        knowledgeBase: emptyKnowledgeBaseContext(),
        attachments: [],
        attachmentLabel: "",
        attachmentText: "",
        hasImageAttachment: false,
        computerTools: [],
      },
      { userId: "user-1", runId: "run-1" },
    );

    expect(steps).toHaveLength(3);
    expect(mockBilling.reserve).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      type: "agent_team_plan",
      model: "priced-model",
      maxOutputTokens: 4096,
    }));
    expect(mockBilling.settle).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      model: "priced-model",
    }));
  });

  it("falls back to a minimum workflow when the LLM returns non JSON text", async () => {
    mockLlm.planText = "建议先读取授权书，再核对主体、范围和签章，最后输出审查报告。";

    const steps = await requestWorkflowPlan("审查授权书靠谱不靠谱", {
      teamName: "授权书审查团队",
      members: [{ name: "首席法务官" }, { name: "风险评估专家" }, { name: "报告撰写员" }],
    });

    expect(steps).toHaveLength(3);
    expect(steps[0]?.memberName).toBe("首席法务官");
    expect(steps[2]?.title).toBe("形成任务报告");
  });
});
