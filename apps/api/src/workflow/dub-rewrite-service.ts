import type Anthropic from "@anthropic-ai/sdk";
import { M3_MODEL, M3_TIMEOUT_MS } from "./video-multimodal.js";
import { DUB_REWRITE_MAX_TOKENS, DUB_REWRITE_PRICE_MULTIPLIER, DUB_REWRITE_BILLING_TYPE } from "./dub-constants.js";

export interface RewriteBilling {
  reserve: (a: { operationId: string; userId: string; type: string; model: string; inputTokens: number; maxOutputTokens: number }) => Promise<{ reserved: number }>;
  settle: (a: { operationId: string; userId: string; model: string; inputTokens: number; outputTokens: number }) => Promise<{ settled: number }>;
}

const REWRITE_SYSTEM = [
  "你是资深短视频口播文案改写专家（俗称「洗文案」）。用户给你一段原始口播文案，请重写一遍。",
  "要求：",
  "1) 保留原文的核心信息、卖点与说服逻辑，但**换一种全新的表达方式**（措辞、句式、开场钩子、结尾 CTA 全部重写）；",
  "2) 口语化、适合口播，句子短、有节奏，不要书面语长句；",
  "3) 字数与原文相当（±20%）；",
  "4) 不要出现「改写后」「以下是」等元话语，不要 Markdown，不要标题；",
  "5) 只输出改写后的口播文案正文本身。",
].join("\n");

export interface BuildRewriteInput {
  text: string;
  highlights?: readonly string[];
  kbContext?: string | null;
  style?: string;
}

export function buildRewritePrompt(input: BuildRewriteInput): string {
  const lines = [`【原始口播文案】\n${input.text}`];
  if (input.highlights && input.highlights.length > 0) {
    lines.push(`【必须保留以下卖点】${input.highlights.join("、")}`);
  }
  if (input.kbContext) {
    lines.push(`【知识库参考资料（改写时可引用其中事实，不得编造）】\n${input.kbContext}`);
  }
  if (input.style?.trim()) lines.push(`【风格要求】${input.style.trim()}`);
  lines.push("请输出改写后的口播文案。");
  return lines.join("\n\n");
}

function estimateInputTokens(system: string, user: string): number {
  return Math.max(1, Math.ceil(`${system}\n\n${user}`.length / 3));
}

export async function rewriteDubScript(args: {
  userId: string; text: string; client: Anthropic; billing: RewriteBilling;
  highlights?: readonly string[]; kbContext?: string | null; style?: string; operationId?: string;
}): Promise<{ script: string }> {
  const text = args.text?.trim() ?? "";
  if (!text) throw new Error("原始文案不能为空");
  const system = REWRITE_SYSTEM;
  const user = buildRewritePrompt({ text, highlights: args.highlights, kbContext: args.kbContext, style: args.style });
  const operationId = args.operationId ?? `dub-rewrite:${args.userId}:${Date.now()}`;
  await args.billing.reserve({
    operationId, userId: args.userId, type: DUB_REWRITE_BILLING_TYPE, model: M3_MODEL,
    inputTokens: estimateInputTokens(system, user) * DUB_REWRITE_PRICE_MULTIPLIER,
    maxOutputTokens: DUB_REWRITE_MAX_TOKENS * DUB_REWRITE_PRICE_MULTIPLIER,
  });
  try {
    const resp = await args.client.messages.create(
      { model: M3_MODEL, max_tokens: DUB_REWRITE_MAX_TOKENS, system, messages: [{ role: "user", content: user }] },
      { timeout: M3_TIMEOUT_MS },
    );
    const script = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
    if (!script) throw new Error("洗稿结果为空");
    await args.billing.settle({
      operationId, userId: args.userId, model: M3_MODEL,
      inputTokens: (resp.usage?.input_tokens ?? 0) * DUB_REWRITE_PRICE_MULTIPLIER,
      outputTokens: (resp.usage?.output_tokens ?? 0) * DUB_REWRITE_PRICE_MULTIPLIER,
    });
    return { script };
  } catch (err) {
    await args.billing.settle({ operationId, userId: args.userId, model: M3_MODEL, inputTokens: 0, outputTokens: 0 }).catch(() => undefined);
    throw err;
  }
}
