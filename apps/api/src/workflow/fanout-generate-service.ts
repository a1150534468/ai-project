import { randomUUID } from "node:crypto";
import { InsufficientBalanceError } from "@ai-assistant/billing";
import {
  FANOUT_MODEL,
  FANOUT_CONCURRENCY,
  FANOUT_MAX_REFILL_ROUNDS,
  FANOUT_DEDUP_THRESHOLD,
  MODE_BATCH,
  DIMENSIONS,
} from "./fanout-dimensions.js";
import { buildBatchPrompt, parseVariants, deriveSeoKeywords } from "./fanout-prompts.js";
import { filterByDedup, maxSimilarity } from "./fanout-dedup.js";
import {
  runBillableMessage,
  defaultBilling,
  defaultLlm,
  type BillingReserveSettle,
  type LlmClientLike,
} from "./fanout-billing.js";
import type {
  FanoutGenerateInput,
  FanoutGenerateResult,
  FanoutMode,
  FanoutVariant,
} from "./fanout-types.js";

// 该模式该 count 下，用于循环取标签的枚举池
function labelPool(mode: FanoutMode, input: FanoutGenerateInput): string[] {
  if (mode === "script") {
    return [
      "15秒短视频",
      "30秒短视频",
      "60秒口播",
      "90秒剧情",
      "直播话术",
      "带货脚本",
      "开场白",
      "结束语",
    ];
  }
  if (mode === "matrix") return ["变体"];
  const dim = input.dimension ? DIMENSIONS[input.dimension] : DIMENSIONS.platform;
  if (dim.id === "seo") {
    const kws = deriveSeoKeywords(input.brief);
    return kws.length > 0 ? kws : [input.brief.product.slice(0, 8)];
  }
  return [...dim.values];
}

interface BatchPlan {
  readonly index: number;
  readonly labels: string[];
}

function planBatches(
  mode: FanoutMode,
  count: number,
  pool: string[],
  startIndex: number
): BatchPlan[] {
  const { batchSize } = MODE_BATCH[mode];
  const batches: BatchPlan[] = [];
  let produced = 0;
  let idx = startIndex;
  while (produced < count) {
    const take = Math.min(batchSize, count - produced);
    const labels: string[] = [];
    for (let i = 0; i < take; i++) labels.push(pool[(produced + i) % pool.length]);
    batches.push({ index: idx++, labels });
    produced += take;
  }
  return batches;
}

type RawVariant = { label: string; text: string };

// 并发执行一组批次，返回原始变体；遇余额不足抛出，遇批失败跳过
async function runBatches(args: {
  batches: BatchPlan[];
  input: FanoutGenerateInput;
  taskId: string;
  billing: BillingReserveSettle;
  llm: LlmClientLike;
  onPartialFailure: () => void;
}): Promise<{ variants: RawVariant[]; balanceStopped: boolean }> {
  const { batches, input, taskId, billing, llm, onPartialFailure } = args;
  const { maxOutputTokens } = MODE_BATCH[input.mode];
  const out: RawVariant[] = [];
  let balanceStopped = false;

  for (let i = 0; i < batches.length; i += FANOUT_CONCURRENCY) {
    if (balanceStopped) break;
    const slice = batches.slice(i, i + FANOUT_CONCURRENCY);
    const settled = await Promise.all(
      slice.map(async (batch) => {
        const { system, user } = buildBatchPrompt({
          mode: input.mode,
          brief: input.brief,
          labels: batch.labels,
          dimension: input.dimension,
        });
        const operationId = `fanout:${taskId}:${input.mode}:${batch.index}`;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const { text } = await runBillableMessage({
              operationId,
              userId: input.userId,
              model: FANOUT_MODEL,
              system,
              user,
              maxOutputTokens,
              billing,
              llm,
            });
            return {
              ok: true as const,
              variants: parseVariants(input.mode, text, batch.labels),
            };
          } catch (err) {
            if (err instanceof InsufficientBalanceError)
              return { ok: false as const, balance: true };
            if (attempt === 1) {
              onPartialFailure();
              return { ok: false as const, balance: false };
            }
          }
        }
        return { ok: false as const, balance: false };
      })
    );
    for (const r of settled) {
      if (!r.ok && r.balance) {
        balanceStopped = true;
        continue;
      }
      if (r.ok) out.push(...r.variants);
    }
  }
  return { variants: out, balanceStopped };
}

function dedupEnabled(input: FanoutGenerateInput): boolean {
  if (input.mode === "matrix") return true;
  if (input.mode === "script") return false;
  return input.dedup === true;
}

export interface GenerateDeps {
  readonly billing?: BillingReserveSettle;
  readonly llm?: LlmClientLike;
}

export async function generateFanout(
  input: FanoutGenerateInput & GenerateDeps
): Promise<FanoutGenerateResult> {
  const billing = input.billing ?? defaultBilling();
  const llm = input.llm ?? defaultLlm();
  const taskId = randomUUID();
  const pool = labelPool(input.mode, input);
  const useDedup = dedupEnabled(input);

  const accepted: FanoutVariant[] = [];
  const acceptedTexts: string[] = [];
  let partialFailure = false;
  let stoppedByBalance = false;
  let nextIndex = 0;

  const addVariant = (label: string, text: string, similarity: number) => {
    accepted.push({
      id: randomUUID(),
      text,
      label,
      charCount: text.replace(/\s/g, "").length,
      similarity,
      highSimilarity: similarity > FANOUT_DEDUP_THRESHOLD,
    });
    acceptedTexts.push(text);
  };

  for (let round = 0; round <= FANOUT_MAX_REFILL_ROUNDS; round++) {
    const remaining = input.count - accepted.length;
    if (remaining <= 0 || stoppedByBalance) break;

    const batches = planBatches(input.mode, remaining, pool, nextIndex);
    nextIndex += batches.length;
    const { variants, balanceStopped } = await runBatches({
      batches,
      input,
      taskId,
      billing,
      llm,
      onPartialFailure: () => {
        partialFailure = true;
      },
    });
    if (balanceStopped) stoppedByBalance = true;

    if (!useDedup) {
      for (const v of variants) {
        if (accepted.length >= input.count) break;
        addVariant(v.label, v.text, 0);
      }
      break; // 非去重模式一轮即止（labels 已按 count 规划）
    }

    // 去重：与已接受集合比对
    const texts = variants.map((v) => v.text);
    const { accepted: freshTexts } = filterByDedup(texts, acceptedTexts, FANOUT_DEDUP_THRESHOLD);
    const freshSet = new Set(freshTexts);
    for (const v of variants) {
      if (accepted.length >= input.count) break;
      if (!freshSet.has(v.text)) continue;
      freshSet.delete(v.text); // 同一文本只收一次
      const sim = maxSimilarity(v.text, acceptedTexts);
      addVariant(v.label, v.text, sim);
    }
    if (variants.length === 0) break; // 无产出，避免空转补批
  }

  const delivered = accepted.length;
  const avgSimilarity =
    delivered > 0 ? accepted.reduce((s, v) => s + v.similarity, 0) / delivered : 0;

  return {
    variants: accepted.slice(0, input.count),
    requested: input.count,
    delivered: Math.min(delivered, input.count),
    avgSimilarity,
    partialFailure,
    stoppedByBalance,
  };
}
