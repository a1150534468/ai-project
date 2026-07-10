import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorkflowFinalReportSystemPrompt, defaultSummarize, type WorkflowSummaryContext } from "./agent-workflow-llm.js";

const mockLlm = vi.hoisted(() => ({
  create: vi.fn(async () => ({
    content: [{ type: "text", text: "# 结论\n\n授权书需要修改后再使用。" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 17, output_tokens: 9 },
  })),
}));

const mockBilling = vi.hoisted(() => ({
  reserve: vi.fn(async () => ({ reserved: 1 })),
  settle: vi.fn(async () => ({ settled: 1 })),
}));

vi.mock("@yc/llm", () => ({
  loadLlmConfig: () => ({ baseURL: "http://llm", apiKey: "key", defaultModel: "fallback-model" }),
  createLlmClient: () => ({
    messages: { create: mockLlm.create },
  }),
}));

vi.mock("@yc/billing", () => ({
  createBillingClient: () => mockBilling,
}));

function summaryContext(): WorkflowSummaryContext {
  return {
    run: {
      id: "run-1",
      userId: "user-1",
      teamId: "team-1",
      taskGoal: "审查一下这个授权书靠谱不靠谱",
      status: "running",
      teamSnapshot: {
        taskContext: { selectedModel: "priced-model" },
      },
      planSnapshot: {},
    },
    steps: [{
      id: "step-1",
      title: "审查授权范围",
      goal: "判断授权范围是否清晰",
      memberName: "法务专家",
      memberSnapshot: {},
      input: {},
      output: "授权范围过宽，建议明确授权事项和期限。",
      status: "succeeded",
      position: 0,
    }],
    events: [],
  };
}

describe("agent workflow LLM", () => {
  beforeEach(() => {
    process.env.BILLING_BASE_URL = "http://billing";
    process.env.BILLING_INTERNAL_TOKEN = "token";
    mockLlm.create.mockClear();
    mockBilling.reserve.mockClear();
    mockBilling.settle.mockClear();
  });

  it("uses an answer-first final report prompt instead of a process summary template", () => {
    const prompt = buildWorkflowFinalReportSystemPrompt();

    expect(prompt).toContain("最终答案和任务报告");
    expect(prompt).toContain("第一屏必须先直接回答用户的任务");
    expect(prompt).toContain("不要把工作流步骤");
    expect(prompt).toContain("不要套用");
  });

  it("bills the selected model when the main agent writes the final report", async () => {
    const report = await defaultSummarize(summaryContext());

    expect(report).toContain("授权书需要修改后再使用");
    expect(mockBilling.reserve).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      type: "agent_team_report",
      model: "priced-model",
      maxOutputTokens: 8192,
    }));
    expect(mockBilling.settle).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      model: "priced-model",
      inputTokens: 17,
      outputTokens: 9,
    }));
  });

  it("continues a final report when the model stops at the output token limit", async () => {
    mockLlm.create
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "# 结论\n\n第一段报告还没有结束。" }],
        stop_reason: "max_tokens",
        usage: { input_tokens: 31, output_tokens: 8192 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "\n\n## 后续分析\n第二段报告补齐了完整结尾。" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 24, output_tokens: 12 },
      });

    const report = await defaultSummarize(summaryContext());

    expect(report).toContain("第一段报告还没有结束");
    expect(report).toContain("第二段报告补齐了完整结尾");
    expect(mockLlm.create).toHaveBeenCalledTimes(2);
    expect(mockLlm.create.mock.calls.at(1)).toEqual([expect.objectContaining({
      max_tokens: 8192,
      messages: [expect.objectContaining({
        role: "user",
        content: expect.stringContaining("请从被截断处继续输出"),
      })],
    })]);
    expect(mockBilling.reserve).toHaveBeenCalledTimes(2);
    expect(mockBilling.settle).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      model: "priced-model",
      inputTokens: 31,
      outputTokens: 8192,
    }));
    expect(mockBilling.settle).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      model: "priced-model",
      inputTokens: 24,
      outputTokens: 12,
    }));
  });

  it("rewrites a process-summary report into an answer-first report and bills the rewrite", async () => {
    mockLlm.create
      .mockResolvedValueOnce({
        content: [{
          type: "text",
          text: "# 授权书审查任务报告\n\n## 1. 任务目标\n审查授权书是否靠谱。\n\n## 2. 完成情况\n工作流已完成。\n\n## 3. 关键执行过程\n法务专家完成审查。",
        }],
        stop_reason: "end_turn",
        usage: { input_tokens: 41, output_tokens: 44 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "# 结论\n\n这份授权书不靠谱，不能直接使用。必须补充授权范围、期限和受托人身份。" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 36, output_tokens: 18 },
      });

    const report = await defaultSummarize(summaryContext());

    expect(report).toContain("这份授权书不靠谱");
    expect(report).not.toContain("任务目标");
    expect(report).not.toContain("关键执行过程");
    expect(mockLlm.create).toHaveBeenCalledTimes(2);
    expect(mockLlm.create.mock.calls.at(1)).toEqual([expect.objectContaining({
      max_tokens: 8192,
      messages: [expect.objectContaining({
        role: "user",
        content: expect.stringContaining("改写为用户答案优先"),
      })],
    })]);
    expect(mockBilling.reserve).toHaveBeenCalledTimes(2);
    expect(mockBilling.settle).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      model: "priced-model",
      inputTokens: 36,
      outputTokens: 18,
    }));
  });
});
