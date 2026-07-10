import type Anthropic from "@anthropic-ai/sdk";
import { Prisma } from "@prisma/client";
import { createLlmClient, loadLlmConfig } from "@yc/llm";
import { z } from "zod";
import { buildWorkflowPlanPrompt } from "./agent-team-prompts.js";
import { AGENT_WORKFLOW_MAX_STEPS } from "./agent-team-types.js";
import { describeTaskContext, type AgentTaskContext } from "./agent-task-context.js";
import {
  agentUsageFromAnthropicUsage,
  fallbackAgentModelUsage,
  withAgentModelBilling,
  type AgentModelBillingContext,
} from "./agent-model-billing.js";

const AGENT_WORKFLOW_MIN_STEPS = 3;

class AgentWorkflowPlanResponseError extends Error {
  readonly name = "AgentWorkflowPlanResponseError";

  constructor(message = "AGENT_WORKFLOW_PLAN_RESPONSE_INVALID") {
    super(message);
  }
}

export interface WorkflowPlanStep {
  readonly title: string;
  readonly goal: string;
  readonly memberName: string;
  readonly input: Prisma.InputJsonObject;
}

export interface WorkflowPlanParseOptions {
  readonly teamSnapshot?: Prisma.JsonValue;
  readonly taskGoal?: string;
}

const STEP_ARRAY_KEYS = ["steps", "tasks", "items", "nodes"] as const;
const STEP_CONTAINER_KEYS = ["workflow", "workflowPlan", "plan", "data", "result"] as const;
const TITLE_KEYS = ["title", "name", "step", "task", "summary"] as const;
const GOAL_KEYS = ["goal", "objective", "description", "content", "instruction", "task"] as const;
const MEMBER_KEYS = ["memberName", "agentName", "agent", "assignee", "owner", "role", "executor"] as const;
const INPUT_KEYS = ["input", "context", "params", "arguments", "payload"] as const;

type UnknownRecord = Record<string, unknown>;

function textFromMessage(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function jsonFragment(text: string): string {
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  const start = Math.min(...starts);
  if (!Number.isFinite(start)) throw new AgentWorkflowPlanResponseError();
  const endToken = text[start] === "[" ? "]" : "}";
  const end = text.lastIndexOf(endToken);
  if (end <= start) throw new AgentWorkflowPlanResponseError();
  return text.slice(start, end + 1);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function primitiveText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  return "";
}

function fieldText(value: unknown): string {
  const direct = primitiveText(value);
  if (direct) return direct;
  if (!isRecord(value)) return "";
  for (const key of ["name", "title", "role", "id"]) {
    const text = primitiveText(value[key]);
    if (text) return text;
  }
  return "";
}

function firstText(record: UnknownRecord, keys: readonly string[]): string {
  for (const key of keys) {
    const text = fieldText(record[key]);
    if (text) return text;
  }
  return "";
}

function trimMax(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max).trimEnd();
}

function readMemberNames(teamSnapshot: Prisma.JsonValue | undefined): readonly string[] {
  if (!isRecord(teamSnapshot)) return [];
  const members = teamSnapshot.members;
  if (!Array.isArray(members)) return [];
  return members
    .map((member) => (isRecord(member) ? fieldText(member.name) : ""))
    .filter((name) => name.length > 0);
}

function memberNameAt(index: number, memberNames: readonly string[]): string {
  if (memberNames.length === 0) return "主 Agent";
  return memberNames[index % memberNames.length] ?? "主 Agent";
}

function looksLikeStep(value: unknown): value is UnknownRecord {
  if (!isRecord(value)) return false;
  return [...TITLE_KEYS, ...GOAL_KEYS, ...MEMBER_KEYS, ...INPUT_KEYS].some((key) => key in value);
}

function stepCandidatesFromValue(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  if (looksLikeStep(value)) return [value];
  const values = Object.values(value).filter((item) => typeof item === "string" || isRecord(item));
  return values.length > 0 ? values : [];
}

function extractPlanSteps(input: unknown, depth = 0): readonly unknown[] {
  if (Array.isArray(input)) return input;
  if (!isRecord(input) || depth > 3) return [];

  for (const key of STEP_ARRAY_KEYS) {
    const steps = stepCandidatesFromValue(input[key]);
    if (steps.length > 0) return steps;
  }

  for (const key of STEP_CONTAINER_KEYS) {
    const steps = extractPlanSteps(input[key], depth + 1);
    if (steps.length > 0) return steps;
  }

  return looksLikeStep(input) ? [input] : [];
}

export function toInputJsonValue(value: unknown): Prisma.InputJsonValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== null && item !== undefined)
      .map((item) => toInputJsonValue(item));
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === null || item === undefined) continue;
      result[key] = toInputJsonValue(item);
    }
    return result;
  }
  throw new AgentWorkflowPlanResponseError("AGENT_WORKFLOW_PLAN_INPUT_INVALID");
}

function toInputJsonObject(value: unknown): Prisma.InputJsonObject {
  if (typeof value === "string") {
    return { instruction: value.trim() };
  }
  if (Array.isArray(value)) {
    return { items: toInputJsonValue(value) };
  }
  if (!isRecord(value)) {
    if (value === null || value === undefined) return {};
    return { value: toInputJsonValue(value) };
  }
  const result: Record<string, Prisma.InputJsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue;
    result[key] = toInputJsonValue(item);
  }
  return result;
}

function inputValueForStep(record: UnknownRecord): unknown {
  for (const key of INPUT_KEYS) {
    if (key in record) return record[key];
  }
  return undefined;
}

function normalizeWorkflowPlanStep(
  rawStep: unknown,
  index: number,
  memberNames: readonly string[],
  taskGoal: string,
): WorkflowPlanStep {
  if (isRecord(rawStep)) {
    const title = firstText(rawStep, TITLE_KEYS) || `步骤 ${index + 1}`;
    const goal = firstText(rawStep, GOAL_KEYS) || title || taskGoal || "完成用户任务";
    const memberName = firstText(rawStep, MEMBER_KEYS) || memberNameAt(index, memberNames);
    const input = inputValueForStep(rawStep);
    return {
      title: trimMax(title, 120),
      goal: trimMax(goal, 4000),
      memberName: trimMax(memberName, 80),
      input: input === undefined ? {} : toInputJsonObject(input),
    };
  }

  const text = fieldText(rawStep);
  const title = text || `步骤 ${index + 1}`;
  return {
    title: trimMax(title, 120),
    goal: trimMax(text || taskGoal || "完成用户任务", 4000),
    memberName: trimMax(memberNameAt(index, memberNames), 80),
    input: text ? { instruction: text } : {},
  };
}

function synthesizeWorkflowPlan(options: WorkflowPlanParseOptions): readonly WorkflowPlanStep[] {
  const memberNames = readMemberNames(options.teamSnapshot);
  const taskGoal = options.taskGoal?.trim() || "完成用户任务";
  const templates = [
    {
      title: "理解任务与资料",
      goal: `明确任务目标、输入资料和需要验证的关键问题：${taskGoal}`,
      input: { taskGoal },
    },
    {
      title: "执行核心审查",
      goal: "结合团队职责完成主要分析，输出证据、判断和风险点。",
      input: { taskGoal },
    },
    {
      title: "形成任务报告",
      goal: "汇总任务完成情况、核心结论、风险等级、依据和后续建议，输出完整任务报告。",
      input: { taskGoal },
    },
  ] as const;

  return templates.map((template, index) => ({
    title: template.title,
    goal: template.goal,
    memberName: memberNameAt(index, memberNames),
    input: template.input,
  }));
}

function normalizePlanLength(
  steps: readonly WorkflowPlanStep[],
  options: WorkflowPlanParseOptions,
): readonly WorkflowPlanStep[] {
  const normalized = steps.slice(0, AGENT_WORKFLOW_MAX_STEPS);
  if (normalized.length >= AGENT_WORKFLOW_MIN_STEPS) return normalized;

  const fallback = synthesizeWorkflowPlan(options);
  return [
    ...normalized,
    ...fallback.slice(normalized.length, AGENT_WORKFLOW_MIN_STEPS),
  ];
}

export function parseWorkflowPlan(
  input: unknown,
  options: WorkflowPlanParseOptions = {},
): readonly WorkflowPlanStep[] {
  const memberNames = readMemberNames(options.teamSnapshot);
  const taskGoal = options.taskGoal?.trim() || "完成用户任务";
  const steps = extractPlanSteps(input).map((step, index) => (
    normalizeWorkflowPlanStep(step, index, memberNames, taskGoal)
  ));
  return normalizePlanLength(steps, options);
}

function parseWorkflowPlanText(
  text: string,
  options: WorkflowPlanParseOptions,
): readonly WorkflowPlanStep[] {
  try {
    return parseWorkflowPlan(JSON.parse(jsonFragment(text)), options);
  } catch (error) {
    if (
      error instanceof AgentWorkflowPlanResponseError
      || error instanceof SyntaxError
      || error instanceof z.ZodError
    ) {
      return synthesizeWorkflowPlan(options);
    }
    throw error;
  }
}

export async function requestWorkflowPlan(
  taskGoal: string,
  teamSnapshot: Prisma.JsonValue,
  taskContext?: AgentTaskContext,
  billingContext?: Pick<AgentModelBillingContext, "userId"> & { readonly runId?: string },
): Promise<readonly WorkflowPlanStep[]> {
  const cfg = loadLlmConfig();
  const client = createLlmClient(cfg);
  const contextText = taskContext ? describeTaskContext(taskContext) : "";
  const content = contextText
    ? `${buildWorkflowPlanPrompt(taskGoal, JSON.stringify(teamSnapshot))}\n\n任务上下文：\n${contextText}`
    : buildWorkflowPlanPrompt(taskGoal, JSON.stringify(teamSnapshot));
  const model = taskContext?.selectedModel ?? cfg.defaultModel;
  const system = "你是 Agent 工作流规划器。只输出 JSON。";
  return withAgentModelBilling({
    billingContext: billingContext?.userId
      ? {
        userId: billingContext.userId,
        type: "agent_team_plan",
        operationIdPrefix: `agent-team:plan:${billingContext.runId ?? billingContext.userId}`,
      }
      : undefined,
    model,
    system,
    prompt: content,
    call: async () => {
      const message = await client.messages.create({
        model,
        max_tokens: 4096,
        system,
        messages: [{
          role: "user",
          content,
        }],
      });
      const text = textFromMessage(message);
      const steps = text
        ? parseWorkflowPlanText(text, { teamSnapshot, taskGoal })
        : synthesizeWorkflowPlan({ teamSnapshot, taskGoal });
      return {
        value: steps,
        usage: agentUsageFromAnthropicUsage(
          message.usage,
          fallbackAgentModelUsage({ system, prompt: content, output: text }),
        ),
      };
    },
  });
}

export function workflowPlanErrorMessage(error: unknown): string {
  if (error instanceof AgentWorkflowPlanResponseError) return error.message;
  if (error instanceof SyntaxError || error instanceof z.ZodError) return "工作流计划生成失败：规划结果结构不合法";
  return error instanceof Error && error.message.trim() ? error.message : "工作流计划生成失败";
}
