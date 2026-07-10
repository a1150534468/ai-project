import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { createLlmClient, loadLlmConfig } from "@yc/llm";
import { createBillingClient as makeBillingClient } from "@yc/billing";

const HELP_WRITE_MODEL = "MiniMax-M3";
const MAX_OUTPUT_TOKENS = 800;
const TIMEOUT_MS = 60_000;

export type HelpWriteField = "sellingPoints" | "extra";
type BillingReserveSettle = Pick<ReturnType<typeof makeBillingClient>, "reserve" | "settle">;
type LlmClientLike = {
  readonly messages: {
    readonly create: (body: Anthropic.MessageCreateParamsNonStreaming, options?: { timeout?: number }) => Promise<Anthropic.Message>;
  };
};

export interface HelpWriteInput {
  readonly field: HelpWriteField;
  readonly productName: string;
  readonly category: string;
  readonly sellingPoints?: readonly string[];
  readonly userId: string;
  readonly billing?: BillingReserveSettle;
  readonly llm?: LlmClientLike;
}

function buildSystem(field: HelpWriteField): string {
  if (field === "sellingPoints") {
    return "你是资深电商文案。根据商品名称与类目，输出 4~6 条简洁有力的中文卖点，每条一行，采用「卖点名：一句话说明」格式，突出差异化与转化力。只输出卖点本身，不要编号、不要开场白、不要 Markdown、不要多余解释。";
  }
  return "你是资深电商文案。根据商品名称、类目与已有卖点，输出一段 30~80 字的中文补充说明，用于点明适用人群/使用场景/品质承诺。只输出这段说明纯文本，不要标题、不要 Markdown、不要多余解释。";
}

function buildUser(input: HelpWriteInput): string {
  const lines = [`商品名称：${input.productName.trim()}`, `商品类目：${input.category.trim() || "未填写"}`];
  const points = (input.sellingPoints ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
  if (input.field === "extra" && points.length > 0) lines.push(`已有卖点：${points.join("；")}`);
  return lines.join("\n");
}

function estimateInputTokens(system: string, user: string): number {
  return Math.max(1, Math.ceil(`${system}\n\n${user}`.length / 3));
}

function defaultBilling(): BillingReserveSettle {
  return makeBillingClient({ baseUrl: process.env.BILLING_BASE_URL!, token: process.env.BILLING_INTERNAL_TOKEN! });
}

export async function helpWriteEcomField(input: HelpWriteInput): Promise<string> {
  const productName = input.productName.trim();
  if (!productName) throw new Error("productName required");
  const system = buildSystem(input.field);
  const user = buildUser({ ...input, productName });
  const billing = input.billing ?? defaultBilling();
  const operationId = `ecom-helpwrite:${randomUUID()}`;
  await billing.reserve({ operationId, userId: input.userId, type: "chat", model: HELP_WRITE_MODEL, inputTokens: estimateInputTokens(system, user), maxOutputTokens: MAX_OUTPUT_TOKENS });
  const client = input.llm ?? createLlmClient(loadLlmConfig());
  try {
    const resp = await client.messages.create(
      { model: HELP_WRITE_MODEL, max_tokens: MAX_OUTPUT_TOKENS, system, messages: [{ role: "user", content: user }] },
      { timeout: TIMEOUT_MS },
    );
    const text = resp.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!text) throw new Error("empty help-write result");
    await billing.settle({ operationId, userId: input.userId, model: HELP_WRITE_MODEL, inputTokens: resp.usage?.input_tokens ?? estimateInputTokens(system, user), outputTokens: resp.usage?.output_tokens ?? 0 });
    return text;
  } catch (err) {
    await billing.settle({ operationId, userId: input.userId, model: HELP_WRITE_MODEL, inputTokens: 0, outputTokens: 0 }).catch(() => undefined);
    throw err;
  }
}
