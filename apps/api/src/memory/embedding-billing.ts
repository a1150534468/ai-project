import type { ReserveArgs, SettleArgs } from "@yc/billing";
import { embed, type EmbedResult, type EmbeddingConfig } from "./embedding-client.js";

export interface EmbeddingBillingClient {
  reserve(args: ReserveArgs): Promise<unknown>;
  settle(args: SettleArgs): Promise<unknown>;
}

export function estimateEmbeddingTokens(input: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(input || " ", "utf8") / 3));
}

export async function billableEmbed(args: {
  readonly billing: EmbeddingBillingClient;
  readonly cfg: EmbeddingConfig;
  readonly userId: string;
  readonly operationId: string;
  readonly input: string;
  readonly embedFn?: (cfg: EmbeddingConfig, input: string) => Promise<EmbedResult>;
}): Promise<EmbedResult> {
  const estimatedTokens = estimateEmbeddingTokens(args.input);
  await args.billing.reserve({
    operationId: args.operationId,
    userId: args.userId,
    type: "embedding",
    model: args.cfg.model,
    inputTokens: estimatedTokens,
    maxOutputTokens: 0,
  });

  let result: EmbedResult;
  try {
    result = await (args.embedFn ?? embed)(args.cfg, args.input);
  } catch (error) {
    await args.billing.settle({
      operationId: args.operationId,
      userId: args.userId,
      model: args.cfg.model,
      inputTokens: 0,
      outputTokens: 0,
    }).catch(() => undefined);
    throw error;
  }

  await args.billing.settle({
    operationId: args.operationId,
    userId: args.userId,
    model: args.cfg.model,
    inputTokens: Math.max(result.tokens, estimatedTokens),
    outputTokens: 0,
  });
  return result;
}
