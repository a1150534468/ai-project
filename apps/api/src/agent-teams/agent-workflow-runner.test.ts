import { describe, expect, it, vi } from "vitest";
import { runAgentWorkflowSteps } from "./agent-workflow-runner.js";

function createStep(id: string, title: string, memberName: string, goal: string) {
  return { id, title, memberName, goal };
}

describe("runAgentWorkflowSteps", () => {
  it("runs pending steps serially and completes the run with the final report", async () => {
    const stepOne = createStep("step-1", "审查合同", "法务合规专家", "识别风险");
    const stepTwo = createStep("step-2", "案例对比", "案例分析师", "查找案例");
    const calls: string[] = [];
    const store = {
      markRunRunning: vi.fn(async () => undefined),
      nextPendingStep: vi.fn()
        .mockResolvedValueOnce(stepOne)
        .mockResolvedValueOnce(stepTwo)
        .mockResolvedValueOnce(null),
      markStepRunning: vi.fn(async (stepId: string) => {
        calls.push(`start:${stepId}`);
      }),
      completeStep: vi.fn(async (stepId: string, output: string) => {
        calls.push(`done:${stepId}:${output}`);
      }),
      failStep: vi.fn(async () => undefined),
      appendEvent: vi.fn(async () => undefined),
      completeRun: vi.fn(async (_report: string) => undefined),
      failRun: vi.fn(async () => undefined),
      isCancelled: vi.fn(async () => false),
    };
    const summarize = vi.fn(async () => "最终总结");

    await runAgentWorkflowSteps({
      runId: "run-1",
      executeStep: async (step) => `输出：${step.title}`,
      summarize,
      store,
    });

    expect(calls).toEqual([
      "start:step-1",
      "done:step-1:输出：审查合同",
      "start:step-2",
      "done:step-2:输出：案例对比",
    ]);
    expect(store.appendEvent).toHaveBeenNthCalledWith(1, {
      memberName: "法务合规专家",
      stepId: "step-1",
      type: "step_started",
      message: "法务合规专家 开始执行：审查合同",
    });
    expect(store.appendEvent).toHaveBeenNthCalledWith(2, {
      memberName: "法务合规专家",
      stepId: "step-1",
      type: "step_succeeded",
      message: "法务合规专家 完成：审查合同",
    });
    expect(store.appendEvent).toHaveBeenNthCalledWith(3, {
      memberName: "案例分析师",
      stepId: "step-2",
      type: "step_started",
      message: "案例分析师 开始执行：案例对比",
    });
    expect(store.appendEvent).toHaveBeenNthCalledWith(4, {
      memberName: "案例分析师",
      stepId: "step-2",
      type: "step_succeeded",
      message: "案例分析师 完成：案例对比",
    });
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(store.completeRun).toHaveBeenCalledWith("最终总结");
    expect(store.failRun).not.toHaveBeenCalled();
  });

  it("fails the current step and run when executeStep throws", async () => {
    const stepOne = createStep("step-1", "审查合同", "法务合规专家", "识别风险");
    const stepTwo = createStep("step-2", "案例对比", "案例分析师", "查找案例");
    const store = {
      markRunRunning: vi.fn(async () => undefined),
      nextPendingStep: vi.fn()
        .mockResolvedValueOnce(stepOne)
        .mockResolvedValueOnce(stepTwo),
      markStepRunning: vi.fn(async () => undefined),
      completeStep: vi.fn(async () => undefined),
      failStep: vi.fn(async () => undefined),
      appendEvent: vi.fn(async () => undefined),
      completeRun: vi.fn(async () => undefined),
      failRun: vi.fn(async () => undefined),
      isCancelled: vi.fn(async () => false),
    };
    const summarize = vi.fn(async () => "不会执行");

    await runAgentWorkflowSteps({
      runId: "run-2",
      executeStep: async () => {
        throw new Error("步骤执行失败");
      },
      summarize,
      store,
    });

    expect(store.markStepRunning).toHaveBeenCalledTimes(1);
    expect(store.completeStep).not.toHaveBeenCalled();
    expect(store.failStep).toHaveBeenCalledWith("step-1", "步骤执行失败");
    expect(store.appendEvent).toHaveBeenNthCalledWith(1, {
      memberName: "法务合规专家",
      stepId: "step-1",
      type: "step_started",
      message: "法务合规专家 开始执行：审查合同",
    });
    expect(store.appendEvent).toHaveBeenNthCalledWith(2, {
      memberName: "法务合规专家",
      stepId: "step-1",
      type: "step_failed",
      message: "法务合规专家 执行失败：审查合同",
      payload: { error: "步骤执行失败" },
    });
    expect(store.failRun).toHaveBeenCalledWith("步骤执行失败");
    expect(store.completeRun).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
  });

  it("routes step failures through the injected formatError", async () => {
    const stepOne = createStep("step-1", "审查合同", "法务合规专家", "识别风险");
    const store = {
      markRunRunning: vi.fn(async () => undefined),
      nextPendingStep: vi.fn().mockResolvedValueOnce(stepOne),
      markStepRunning: vi.fn(async () => undefined),
      completeStep: vi.fn(async () => undefined),
      failStep: vi.fn(async () => undefined),
      appendEvent: vi.fn(async () => undefined),
      completeRun: vi.fn(async () => undefined),
      failRun: vi.fn(async () => undefined),
      isCancelled: vi.fn(async () => false),
    };

    await runAgentWorkflowSteps({
      runId: "run-fmt",
      executeStep: async () => {
        throw new Error('402 {"error":{"message":"Insufficient account balance (request id: x)"}}');
      },
      summarize: vi.fn(async () => "不会执行"),
      store,
      formatError: () => "AI 服务额度暂时不可用，请稍后重试或联系客服",
    });

    expect(store.failStep).toHaveBeenCalledWith("step-1", "AI 服务额度暂时不可用，请稍后重试或联系客服");
    expect(store.failRun).toHaveBeenCalledWith("AI 服务额度暂时不可用，请稍后重试或联系客服");
    expect(store.appendEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      payload: { error: "AI 服务额度暂时不可用，请稍后重试或联系客服" },
    }));
  });

  it("stops when the workflow is cancelled and does not complete the run", async () => {
    const stepOne = createStep("step-1", "审查合同", "法务合规专家", "识别风险");
    const store = {
      markRunRunning: vi.fn(async () => undefined),
      nextPendingStep: vi.fn().mockResolvedValueOnce(stepOne),
      markStepRunning: vi.fn(async () => undefined),
      completeStep: vi.fn(async () => undefined),
      failStep: vi.fn(async () => undefined),
      appendEvent: vi.fn(async () => undefined),
      completeRun: vi.fn(async () => undefined),
      failRun: vi.fn(async () => undefined),
      isCancelled: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    };
    const summarize = vi.fn(async () => "不会执行");

    await runAgentWorkflowSteps({
      runId: "run-3",
      executeStep: async (step) => `输出：${step.title}`,
      summarize,
      store,
    });

    expect(store.completeStep).toHaveBeenCalledWith("step-1", "输出：审查合同");
    expect(summarize).not.toHaveBeenCalled();
    expect(store.completeRun).not.toHaveBeenCalled();
    expect(store.failRun).not.toHaveBeenCalled();
  });

  it("does not mark the run running when it is already cancelled", async () => {
    const store = {
      markRunRunning: vi.fn(async () => undefined),
      nextPendingStep: vi.fn(async () => null),
      markStepRunning: vi.fn(async () => undefined),
      completeStep: vi.fn(async () => undefined),
      failStep: vi.fn(async () => undefined),
      appendEvent: vi.fn(async () => undefined),
      completeRun: vi.fn(async () => undefined),
      failRun: vi.fn(async () => undefined),
      isCancelled: vi.fn(async () => true),
    };

    await runAgentWorkflowSteps({
      runId: "run-cancelled",
      executeStep: async () => "不会执行",
      summarize: async () => "不会执行",
      store,
    });

    expect(store.markRunRunning).not.toHaveBeenCalled();
    expect(store.nextPendingStep).not.toHaveBeenCalled();
    expect(store.completeRun).not.toHaveBeenCalled();
    expect(store.failRun).not.toHaveBeenCalled();
  });

  it("fails the run when an outer error escapes the workflow loop", async () => {
    const store = {
      markRunRunning: vi.fn(async () => undefined),
      nextPendingStep: vi.fn(async () => null),
      markStepRunning: vi.fn(async () => undefined),
      completeStep: vi.fn(async () => undefined),
      failStep: vi.fn(async () => undefined),
      appendEvent: vi.fn(async () => undefined),
      completeRun: vi.fn(async () => undefined),
      failRun: vi.fn(async () => undefined),
      isCancelled: vi.fn(async () => false),
    };

    await runAgentWorkflowSteps({
      runId: "run-4",
      executeStep: async () => "不会执行",
      summarize: async () => {
        throw new Error("总结失败");
      },
      store,
    });

    expect(store.failRun).toHaveBeenCalledWith("总结失败");
    expect(store.completeRun).not.toHaveBeenCalled();
  });
});
