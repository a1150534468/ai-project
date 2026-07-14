import type Anthropic from "@anthropic-ai/sdk";
import type { AgentWorkflowEvent, AgentWorkflowRun, AgentWorkflowStep, Prisma } from "@prisma/client";
import { createLlmClient, loadLlmConfig } from "@ai-assistant/llm";
import { runTurn, type RunTurnToolEvent } from "../agent/run.js";
import { describeTaskContext, readTaskContextFromSnapshot, type AgentTaskContext } from "./agent-task-context.js";
import {
  agentUsageFromAnthropicUsage,
  fallbackAgentModelUsage,
  withAgentModelBilling,
  type AgentModelBillingContext,
} from "./agent-model-billing.js";

export interface WorkflowRunContext {
  readonly id: string;
  readonly userId: string;
  readonly teamId: string | null;
  readonly taskGoal: string;
  readonly status: string;
  readonly teamSnapshot: Prisma.JsonValue;
  readonly planSnapshot: Prisma.JsonValue;
}

export interface WorkflowStepContext {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly memberName: string;
  readonly memberSnapshot: Prisma.JsonValue;
  readonly input: Prisma.JsonValue;
  readonly status: string;
  readonly output: string;
  readonly position: number;
}

export interface WorkflowEventContext {
  readonly id: string;
  readonly stepId: string | null;
  readonly memberName: string;
  readonly type: string;
  readonly message: string;
  readonly payload: Prisma.JsonValue | null;
}

export interface WorkflowStepExecutionContext {
  readonly run: WorkflowRunContext;
  readonly step: WorkflowStepContext;
  readonly completedSteps: readonly WorkflowStepContext[];
  readonly tools?: readonly Anthropic.Tool[];
  readonly execTool?: (name: string, input: unknown) => Promise<string>;
  readonly onTool?: (event: RunTurnToolEvent) => void | Promise<void>;
}

export interface WorkflowSummaryContext {
  readonly run: WorkflowRunContext;
  readonly steps: readonly WorkflowStepContext[];
  readonly events: readonly WorkflowEventContext[];
}

const DEFAULT_TEXT_MAX_OUTPUT_TOKENS = 4096;
const FINAL_REPORT_MAX_OUTPUT_TOKENS = 8192;
const FINAL_REPORT_MAX_CONTINUATIONS = 4;
const CONTINUATION_PROMPT_CONTEXT_CHARS = 12000;
const REPORT_GUARD_HEAD_CHARS = 2400;

const PROCESS_SUMMARY_MARKERS = [
  "任务目标",
  "完成情况",
  "关键执行过程",
  "最终结果或交付物",
  "工作流执行",
  "流程执行",
  "执行过程",
  "交付物",
] as const;

const ANSWER_FIRST_MARKERS = [
  "结论",
  "核心结论",
  "总体判断",
  "直接答案",
  "任务答案",
  "结论与建议",
] as const;

interface TextModelResult {
  readonly text: string;
  readonly stopReason: string;
}

function textFromMessage(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function stopReasonFromMessage(message: Anthropic.Message): string {
  return typeof message.stop_reason === "string" ? message.stop_reason : "";
}

function textTail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

function buildContinuationPrompt(originalPrompt: string, generatedText: string): string {
  return [
    "模型上一次输出因为长度上限被截断。",
    "请从被截断处继续输出同一份最终答案和任务报告的后续正文。",
    "要求：不要重复已经输出的段落，不要重新开始，不要总结工作流流程，只续写用户任务的答案和报告。",
    "如果报告事实上已经完整，只输出“已完整”。",
    `原始输入摘要：\n${textTail(originalPrompt, CONTINUATION_PROMPT_CONTEXT_CHARS)}`,
    `已经输出的报告末尾：\n${textTail(generatedText, CONTINUATION_PROMPT_CONTEXT_CHARS)}`,
  ].join("\n\n");
}

function continuationBillingContext(
  billingContext: AgentModelBillingContext | undefined,
  index: number,
): AgentModelBillingContext | undefined {
  if (!billingContext) return undefined;
  return {
    ...billingContext,
    operationIdPrefix: `${billingContext.operationIdPrefix}:continue-${index}`,
  };
}

function isCompletionSentinel(text: string): boolean {
  return /^已完整[。.]?$/.test(text.trim());
}

function firstMarkerIndex(text: string, markers: readonly string[]): number {
  const found = markers
    .map((marker) => text.indexOf(marker))
    .filter((index) => index >= 0);
  return found.length === 0 ? -1 : Math.min(...found);
}

function countMarkers(text: string, markers: readonly string[]): number {
  return markers.reduce((count, marker) => count + (text.includes(marker) ? 1 : 0), 0);
}

function looksLikeProcessSummaryReport(report: string): boolean {
  const head = report
    .replace(/[#*_>`\-\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, REPORT_GUARD_HEAD_CHARS);
  const processIndex = firstMarkerIndex(head, PROCESS_SUMMARY_MARKERS);
  const answerIndex = firstMarkerIndex(head, ANSWER_FIRST_MARKERS);
  if (answerIndex >= 0 && (processIndex < 0 || answerIndex < processIndex)) return false;
  const processTitle = /任务报告|执行报告|流程报告/.test(head.slice(0, 120));
  return (processTitle && processIndex >= 0) || countMarkers(head, PROCESS_SUMMARY_MARKERS) >= 2;
}

async function invokeTextModel(
  system: string,
  prompt: string,
  options: {
    readonly taskContext?: AgentTaskContext;
    readonly tools?: readonly Anthropic.Tool[];
    readonly execTool?: (name: string, input: unknown) => Promise<string>;
    readonly onTool?: (event: RunTurnToolEvent) => void | Promise<void>;
    readonly billingContext?: AgentModelBillingContext;
    readonly maxOutputTokens?: number;
    readonly continueOnMaxTokens?: boolean;
    readonly maxContinuations?: number;
  } = {},
): Promise<string> {
  const cfg = loadLlmConfig();
  const client = createLlmClient(cfg);
  const model = options.taskContext?.selectedModel ?? cfg.defaultModel;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_TEXT_MAX_OUTPUT_TOKENS;

  if (options.tools && options.execTool) {
    const tools = options.tools;
    const execTool = options.execTool;
    return withAgentModelBilling({
      billingContext: options.billingContext,
      model,
      system,
      prompt,
      maxOutputTokens,
      call: async () => {
        const result = await runTurn({
          client,
          model,
          system,
          history: [{ role: "user", content: prompt }],
          tools: [...tools],
          execTool,
          maxIterations: 64,
          onTool: (event) => {
            void options.onTool?.(event);
          },
        });
        const text = result.text.trim();
        if (!text) throw new Error("AGENT_WORKFLOW_LLM_RESPONSE_EMPTY");
        return { value: text, usage: result.usage };
      },
    });
  }

  const callTextMessage = async (
    nextPrompt: string,
    billingContext: AgentModelBillingContext | undefined,
  ): Promise<TextModelResult> => withAgentModelBilling({
    billingContext,
    model,
    system,
    prompt: nextPrompt,
    maxOutputTokens,
    call: async () => {
      const message = await client.messages.create({
        model,
        max_tokens: maxOutputTokens,
        system,
        messages: [{ role: "user", content: nextPrompt }],
      });
      const text = textFromMessage(message);
      if (!text) throw new Error("AGENT_WORKFLOW_LLM_RESPONSE_EMPTY");
      return {
        value: { text, stopReason: stopReasonFromMessage(message) },
        usage: agentUsageFromAnthropicUsage(
          message.usage,
          fallbackAgentModelUsage({ system, prompt: nextPrompt, output: text }),
        ),
      };
    },
  });

  const first = await callTextMessage(prompt, options.billingContext);
  const parts = [first.text];
  let stopReason = first.stopReason;

  for (
    let index = 1;
    options.continueOnMaxTokens && stopReason === "max_tokens" && index <= (options.maxContinuations ?? 0);
    index += 1
  ) {
    const continuation = await callTextMessage(
      buildContinuationPrompt(prompt, parts.join("\n\n")),
      continuationBillingContext(options.billingContext, index),
    );
    if (isCompletionSentinel(continuation.text)) break;
    parts.push(continuation.text);
    stopReason = continuation.stopReason;
  }

  return parts.join("\n\n").trim();
}

export function runContext(run: AgentWorkflowRun): WorkflowRunContext {
  return {
    id: run.id,
    userId: run.userId,
    teamId: run.teamId,
    taskGoal: run.taskGoal,
    status: run.status,
    teamSnapshot: run.teamSnapshot,
    planSnapshot: run.planSnapshot,
  };
}

export function stepContext(step: AgentWorkflowStep): WorkflowStepContext {
  return {
    id: step.id,
    title: step.title,
    goal: step.goal,
    memberName: step.memberName,
    memberSnapshot: step.memberSnapshot,
    input: step.input,
    status: step.status,
    output: step.output,
    position: step.position,
  };
}

export function eventContext(event: AgentWorkflowEvent): WorkflowEventContext {
  return {
    id: event.id,
    stepId: event.stepId,
    memberName: event.memberName,
    type: event.type,
    message: event.message,
    payload: event.payload,
  };
}

export async function defaultExecuteStep(context: WorkflowStepExecutionContext): Promise<string> {
  const taskContext = readTaskContextFromSnapshot(context.run.teamSnapshot);
  const taskContextText = describeTaskContext(taskContext);
  return invokeTextModel(
    [
      "你是多 Agent 工作流成员。根据上下文完成当前步骤，只输出结果正文，不要 Markdown 标题。",
      context.tools && context.execTool
        ? "你可以按需调用已经暴露的用户电脑工具完成本地文件、终端和浏览器操作。"
        : "当前没有可调用的在线本地电脑工具；如任务依赖本机操作，请在结果中明确说明受限原因。",
    ].join("\n"),
    [
      `主任务：${context.run.taskGoal}`,
      taskContextText ? `任务上下文：${taskContextText}` : "",
      `当前成员：${context.step.memberName}`,
      `成员上下文：${JSON.stringify(context.step.memberSnapshot)}`,
      `当前步骤：${context.step.title}`,
      `步骤目标：${context.step.goal}`,
      `步骤输入：${JSON.stringify(context.step.input)}`,
      `已完成步骤：${JSON.stringify(context.completedSteps)}`,
    ].filter(Boolean).join("\n\n"),
    {
      taskContext,
      tools: context.tools,
      execTool: context.execTool,
      onTool: context.onTool,
      billingContext: {
        userId: context.run.userId,
        type: "agent_team_step",
        operationIdPrefix: `agent-team:step:${context.run.id}:${context.step.id}`,
      },
    },
  );
}

export function buildWorkflowFinalReportSystemPrompt(): string {
  return [
    "你是多 Agent 工作流主 Agent。你的输出是给用户看的最终答案和任务报告，不是流程复盘。",
    "第一屏必须先直接回答用户的任务：给出清晰结论、判断、结果或可直接使用的成果；如果任务问“靠谱不靠谱/能不能用/怎么改”，先给明确 verdict。",
    "正文使用 Markdown，结构优先围绕用户任务本身组织，例如：结论、关键依据、详细分析、修改建议、风险与后续动作。",
    "不要把工作流步骤、Agent 分工、执行事件或文件路径当作主报告内容；这些只能作为必要时的“依据说明”简短出现。",
    "不要套用“任务目标、完成情况、关键执行过程、最终结果或交付物”这种流程汇总模板。",
    "如果某些信息无法验证，要明确说明限制、原因和对结论的影响。",
  ].join("\n");
}

function buildWorkflowFinalReportRewriteSystemPrompt(): string {
  return [
    "你是多 Agent 最终报告质检与改写器。",
    "输入是一份不合格的流程汇总型报告，你必须改写为用户任务的最终答案和报告。",
    "第一段必须直接给用户结论、判断、结果或可执行建议。",
    "禁止出现“任务目标、完成情况、关键执行过程、最终结果或交付物、流程执行、工作流执行”这些流程模板标题。",
    "可以保留原报告中有用的事实、数据、分析和风险，但必须按用户问题本身重组。",
    "只输出改写后的 Markdown 正文。",
  ].join("\n");
}

function buildWorkflowFinalReportRewritePrompt(context: WorkflowSummaryContext, originalReport: string): string {
  return [
    `用户任务：${context.run.taskGoal}`,
    `不合格的流程汇总型报告：\n${originalReport}`,
    `可用步骤结果：${JSON.stringify(context.steps)}`,
    `事件记录：${JSON.stringify(context.events)}`,
    "请改写为用户答案优先的完整报告。",
  ].join("\n\n");
}

function reportBillingContext(run: WorkflowRunContext, suffix?: string): AgentModelBillingContext {
  return {
    userId: run.userId,
    type: "agent_team_report",
    operationIdPrefix: suffix
      ? `agent-team:report:${run.id}:${suffix}`
      : `agent-team:report:${run.id}`,
  };
}

export async function defaultSummarize(context: WorkflowSummaryContext): Promise<string> {
  const taskContext = readTaskContextFromSnapshot(context.run.teamSnapshot);
  const taskContextText = describeTaskContext(taskContext);
  const report = await invokeTextModel(
    buildWorkflowFinalReportSystemPrompt(),
    [
      `主任务：${context.run.taskGoal}`,
      taskContextText ? `任务上下文：${taskContextText}` : "",
      `团队快照：${JSON.stringify(context.run.teamSnapshot)}`,
      `步骤结果：${JSON.stringify(context.steps)}`,
      `事件记录：${JSON.stringify(context.events)}`,
    ].filter(Boolean).join("\n\n"),
    {
      taskContext,
      maxOutputTokens: FINAL_REPORT_MAX_OUTPUT_TOKENS,
      continueOnMaxTokens: true,
      maxContinuations: FINAL_REPORT_MAX_CONTINUATIONS,
      billingContext: reportBillingContext(context.run),
    },
  );
  if (!looksLikeProcessSummaryReport(report)) return report;
  return invokeTextModel(
    buildWorkflowFinalReportRewriteSystemPrompt(),
    buildWorkflowFinalReportRewritePrompt(context, report),
    {
      taskContext,
      maxOutputTokens: FINAL_REPORT_MAX_OUTPUT_TOKENS,
      continueOnMaxTokens: true,
      maxContinuations: FINAL_REPORT_MAX_CONTINUATIONS,
      billingContext: reportBillingContext(context.run, "rewrite"),
    },
  );
}
