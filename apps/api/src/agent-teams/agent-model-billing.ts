import { randomUUID } from "node:crypto";
import { createBillingClient } from "@ai-assistant/billing";

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

interface AgentBillingClient {
  reserve(args: {
    readonly operationId: string;
    readonly userId: string;
    readonly type: string;
    readonly model: string;
    readonly inputTokens: number;
    readonly maxOutputTokens: number;
  }): Promise<unknown>;
  settle(args: {
    readonly operationId: string;
    readonly userId: string;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheInputTokens?: number;
    readonly cacheOutputTokens?: number;
  }): Promise<unknown>;
}

export interface AgentModelBillingContext {
  readonly userId?: string;
  readonly type: string;
  readonly operationIdPrefix: string;
}

export interface AgentModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheInputTokens?: number;
  readonly cacheOutputTokens?: number;
}

interface BillableModelCallArgs<T> {
  readonly billingContext?: AgentModelBillingContext;
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  readonly maxOutputTokens?: number;
  readonly call: () => Promise<{ readonly value: T; readonly usage: AgentModelUsage }>;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function usageNumber(value: unknown): number {
  return positiveInt(value) ?? 0;
}

function readUsageNumber(usage: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const value = positiveInt(usage[key]);
    if (value !== undefined) return value;
  }
  return 0;
}

function createAgentBillingClient(): AgentBillingClient {
  const baseUrl = process.env.BILLING_BASE_URL?.trim();
  const token = process.env.BILLING_INTERNAL_TOKEN?.trim();
  if (!baseUrl || !token) throw new Error("BILLING_BASE_URL/BILLING_INTERNAL_TOKEN required");
  return createBillingClient({ baseUrl, token });
}

export function estimateAgentInputTokens(system: string, prompt: string): number {
  return Math.max(1, Math.ceil(`${system}\n\n${prompt}`.length / 3));
}

export function fallbackAgentModelUsage(args: {
  readonly system: string;
  readonly prompt: string;
  readonly output: string;
}): AgentModelUsage {
  return {
    inputTokens: estimateAgentInputTokens(args.system, args.prompt),
    outputTokens: Math.max(1, Math.ceil(args.output.length / 3)),
  };
}

export function agentUsageFromAnthropicUsage(
  usage: unknown,
  fallback: AgentModelUsage,
): AgentModelUsage {
  if (typeof usage !== "object" || usage === null) return fallback;
  const row = usage as Record<string, unknown>;
  const cacheCreationInputTokens = usageNumber(row.cache_creation_input_tokens);
  const cacheReadInputTokens = usageNumber(row.cache_read_input_tokens);
  const cacheInputTokens = readUsageNumber(row, ["cache_input_tokens", "cacheInputTokens"])
    || cacheCreationInputTokens + cacheReadInputTokens;
  const cacheOutputTokens = readUsageNumber(row, ["cache_output_tokens", "cacheOutputTokens"]);
  return {
    inputTokens: readUsageNumber(row, ["input_tokens", "inputTokens"]) || fallback.inputTokens,
    outputTokens: readUsageNumber(row, ["output_tokens", "outputTokens"]) || fallback.outputTokens,
    ...(cacheInputTokens > 0 ? { cacheInputTokens } : {}),
    ...(cacheOutputTokens > 0 ? { cacheOutputTokens } : {}),
  };
}

export async function withAgentModelBilling<T>(args: BillableModelCallArgs<T>): Promise<T> {
  const billingContext = args.billingContext;
  const userId = billingContext?.userId?.trim();
  if (!billingContext || !userId) {
    return (await args.call()).value;
  }

  const billing = createAgentBillingClient();
  const operationId = `${billingContext.operationIdPrefix}:${randomUUID()}`;
  let reserved = false;
  try {
    await billing.reserve({
      operationId,
      userId,
      type: billingContext.type,
      model: args.model,
      inputTokens: estimateAgentInputTokens(args.system, args.prompt),
      maxOutputTokens: args.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    });
    reserved = true;
    const result = await args.call();
    await billing.settle({
      operationId,
      userId,
      model: args.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheInputTokens: result.usage.cacheInputTokens,
      cacheOutputTokens: result.usage.cacheOutputTokens,
    });
    return result.value;
  } catch (error) {
    if (reserved) {
      await billing.settle({
        operationId,
        userId,
        model: args.model,
        inputTokens: 0,
        outputTokens: 0,
      }).catch(() => undefined);
    }
    throw error;
  }
}
