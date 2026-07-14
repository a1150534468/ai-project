import type Anthropic from "@anthropic-ai/sdk";
import { createLlmClient, loadLlmConfig } from "@ai-assistant/llm";
import { createBillingClient as makeBillingClient } from "@ai-assistant/billing";
import { FANOUT_TIMEOUT_MS } from "./fanout-dimensions.js";

export type BillingReserveSettle = Pick<ReturnType<typeof makeBillingClient>, "reserve" | "settle">;
export type LlmClientLike = {
  readonly messages: {
    readonly create: (
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { timeout?: number },
    ) => Promise<Anthropic.Message>;
  };
};

export function defaultBilling(): BillingReserveSettle {
  return makeBillingClient({ baseUrl: process.env.BILLING_BASE_URL!, token: process.env.BILLING_INTERNAL_TOKEN! });
}
export function defaultLlm(): LlmClientLike {
  return createLlmClient(loadLlmConfig());
}

export function estimateInputTokens(system: string, user: string): number {
  return Math.max(1, Math.ceil(`${system}\n\n${user}`.length / 3));
}

export interface RunBillableArgs {
  readonly operationId: string;
  readonly userId: string;
  readonly model: string;
  readonly system: string;
  readonly user: string;
  readonly maxOutputTokens: number;
  readonly billing: BillingReserveSettle;
  readonly llm: LlmClientLike;
}
export interface RunBillableResult {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

// reserve → llm.create → settle。失败时以 0 用量结算并抛出（预扣被释放/不实扣）。
export async function runBillableMessage(args: RunBillableArgs): Promise<RunBillableResult> {
  const { operationId, userId, model, system, user, maxOutputTokens, billing, llm } = args;
  const estIn = estimateInputTokens(system, user);
  await billing.reserve({ operationId, userId, type: "chat", model, inputTokens: estIn, maxOutputTokens });
  try {
    const resp = await llm.messages.create(
      { model, max_tokens: maxOutputTokens, system, messages: [{ role: "user", content: user }] },
      { timeout: FANOUT_TIMEOUT_MS },
    );
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) throw new Error("empty fanout result");
    const inputTokens = resp.usage?.input_tokens ?? estIn;
    const outputTokens = resp.usage?.output_tokens ?? 0;
    await billing.settle({ operationId, userId, model, inputTokens, outputTokens });
    return { text, inputTokens, outputTokens };
  } catch (err) {
    await billing.settle({ operationId, userId, model, inputTokens: 0, outputTokens: 0 }).catch(() => undefined);
    throw err;
  }
}
