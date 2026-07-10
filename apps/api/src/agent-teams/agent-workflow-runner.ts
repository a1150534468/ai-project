function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export interface AgentWorkflowStepForRunner {
  readonly id: string;
  readonly title: string;
  readonly memberName: string;
  readonly goal: string;
}

export interface AgentWorkflowRunnerEvent {
  readonly stepId?: string;
  readonly memberName?: string;
  readonly type: string;
  readonly message: string;
  readonly payload?: unknown;
}

export interface AgentWorkflowRunnerStore {
  markRunRunning: () => Promise<void>;
  nextPendingStep: () => Promise<AgentWorkflowStepForRunner | null>;
  markStepRunning: (stepId: string) => Promise<void>;
  completeStep: (stepId: string, output: string) => Promise<void>;
  failStep: (stepId: string, error: string) => Promise<void>;
  appendEvent: (event: AgentWorkflowRunnerEvent) => Promise<void>;
  completeRun: (finalReport: string) => Promise<void>;
  failRun: (error: string) => Promise<void>;
  isCancelled: () => Promise<boolean>;
}

export interface RunAgentWorkflowStepsArgs {
  readonly runId: string;
  readonly executeStep: (step: AgentWorkflowStepForRunner) => Promise<string>;
  readonly summarize: () => Promise<string>;
  readonly store: AgentWorkflowRunnerStore;
  // 将执行期错误转成用户可读文案；缺省沿用原始 message，由调用方注入友好化实现
  readonly formatError?: (error: unknown, fallback: string) => string;
}

async function handleCancelledRun(store: AgentWorkflowRunnerStore, runId: string): Promise<void> {
  await store.appendEvent({
    type: "run_cancelled",
    message: `工作流已取消：${runId}`,
  });
}

export async function runAgentWorkflowSteps(args: RunAgentWorkflowStepsArgs): Promise<void> {
  const { executeStep, store, summarize } = args;
  const formatError = args.formatError ?? errorMessage;

  try {
    if (await store.isCancelled()) {
      await handleCancelledRun(store, args.runId);
      return;
    }

    await store.markRunRunning();

    while (true) {
      if (await store.isCancelled()) {
        await handleCancelledRun(store, args.runId);
        return;
      }

      const step = await store.nextPendingStep();
      if (!step) {
        break;
      }

      await store.markStepRunning(step.id);
      await store.appendEvent({
        stepId: step.id,
        memberName: step.memberName,
        type: "step_started",
        message: `${step.memberName} 开始执行：${step.title}`,
      });

      try {
        const output = await executeStep(step);
        await store.completeStep(step.id, output);
        await store.appendEvent({
          stepId: step.id,
          memberName: step.memberName,
          type: "step_succeeded",
          message: `${step.memberName} 完成：${step.title}`,
        });
      } catch (error) {
        const message = formatError(error, "步骤执行失败");
        await store.failStep(step.id, message);
        await store.appendEvent({
          stepId: step.id,
          memberName: step.memberName,
          type: "step_failed",
          message: `${step.memberName} 执行失败：${step.title}`,
          payload: { error: message },
        });
        await store.failRun(message);
        return;
      }
    }

    if (await store.isCancelled()) {
      await handleCancelledRun(store, args.runId);
      return;
    }

    const finalReport = await summarize();

    if (await store.isCancelled()) {
      await handleCancelledRun(store, args.runId);
      return;
    }

    await store.completeRun(finalReport);
  } catch (error) {
    await store.failRun(formatError(error, "工作流执行失败"));
  }
}
