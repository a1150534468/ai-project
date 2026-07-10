import { randomUUID } from "node:crypto";
import { z } from "zod";
import { FANOUT_MODEL, FANOUT_EXTRACT_MAX_TOKENS } from "./fanout-dimensions.js";
import { buildExtractPrompt } from "./fanout-prompts.js";
import {
  runBillableMessage, defaultBilling, defaultLlm,
  type BillingReserveSettle, type LlmClientLike,
} from "./fanout-billing.js";
import type { FanoutBrief } from "./fanout-types.js";

const briefSchema = z.object({
  product: z.string().trim().min(1),
  audience: z.string().trim().default(""),
  sellingPoints: z.array(z.string().trim()).default([]),
  style: z.string().trim().default(""),
  scene: z.string().trim().default(""),
});

function stripFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function tryParseBrief(text: string): FanoutBrief | null {
  try {
    const parsed = briefSchema.parse(JSON.parse(stripFence(text)));
    return { ...parsed, sellingPoints: parsed.sellingPoints };
  } catch {
    return null;
  }
}

export interface ExtractInput {
  readonly userId: string;
  readonly raw: string;
  readonly billing?: BillingReserveSettle;
  readonly llm?: LlmClientLike;
}

export async function extractFanoutBrief(input: ExtractInput): Promise<FanoutBrief> {
  const raw = input.raw.trim();
  if (!raw) throw new Error("原文不能为空");
  const { system, user } = buildExtractPrompt(raw);
  const billing = input.billing ?? defaultBilling();
  const llm = input.llm ?? defaultLlm();

  for (let attempt = 0; attempt < 2; attempt++) {
    const { text } = await runBillableMessage({
      operationId: `fanout-extract:${randomUUID()}`,
      userId: input.userId, model: FANOUT_MODEL,
      system, user, maxOutputTokens: FANOUT_EXTRACT_MAX_TOKENS, billing, llm,
    });
    const brief = tryParseBrief(text);
    if (brief) return brief;
  }
  throw new Error("理解失败：模型未返回合法结构");
}
