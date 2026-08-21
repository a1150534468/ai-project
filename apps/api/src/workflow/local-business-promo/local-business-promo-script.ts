import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { createLlmClient, loadLlmConfig } from "@ai-assistant/llm";
import { createBillingClient as makeBillingClient } from "@ai-assistant/billing";
import {
  countLocalBusinessPromoSpeechChars,
  directionLabel,
  localBusinessPromoNarrationBudget,
  shotCountForDuration,
  splitScriptIntoShotLines,
  type LocalBusinessPromoBrief,
  type LocalBusinessPromoSettings,
} from "./local-business-promo-core.js";

const SCRIPT_MAX_OUTPUT_TOKENS = 1200;
const SCRIPT_TIMEOUT_MS = 60_000;
const SCRIPT_MAX_REWRITE_ATTEMPTS = 2;
const SYSTEM_PROMPT = [
  "你是一名擅长本地生活短视频口播策划的文案导演。",
  "任务：基于商家资料，输出适合短视频逐段镜头使用的口播文案。",
  "输出要求：",
  "1. 只输出最终文案内容，不要解释、不加标题、不加 Markdown。",
  "2. 每一段单独换行，整篇总行数必须严格等于用户要求的镜头段数。",
  "3. 每行都要可直接作为短视频单段口播输入，语言自然、口语化、接地气。",
  "4. 避免过度夸张、虚假承诺、平台违禁表述和空泛套话。",
  "5. 优先围绕门店信任、服务体验、结果价值、到店理由来组织节奏。",
  "6. 口播必须宁短勿长，严格服从目标时长，不要写成长段大白话。",
].join("\n");

type BillingReserveSettle = Pick<ReturnType<typeof makeBillingClient>, "reserve" | "settle">;
type MessageUsage = {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
};

export interface GenerateLocalBusinessPromoScriptInput {
  readonly userId: string;
  readonly brief: LocalBusinessPromoBrief;
  readonly settings: LocalBusinessPromoSettings;
  readonly billing?: BillingReserveSettle;
}

function defaultBilling(): BillingReserveSettle {
  return makeBillingClient({ baseUrl: process.env.BILLING_BASE_URL!, token: process.env.BILLING_INTERNAL_TOKEN! });
}

export function resolveLocalBusinessPromoScriptModel(
  env: NodeJS.ProcessEnv = process.env,
  defaultModel?: string,
): string {
  return (env.LOCAL_BUSINESS_PROMO_SCRIPT_MODEL ?? defaultModel ?? "").trim() || "GLM-5.2";
}

function estimateInputTokens(userMessage: string): number {
  return Math.max(1, Math.ceil(`${SYSTEM_PROMPT}\n\n${userMessage}`.length / 3));
}

function buildUserMessage(input: GenerateLocalBusinessPromoScriptInput): string {
  const shotCount = shotCountForDuration(input.settings.durationSec);
  const narrationBudget = localBusinessPromoNarrationBudget(input.settings.durationSec);
  return [
    `请为一个 ${input.settings.durationSec} 秒的本地商家宣传视频生成 ${shotCount} 行口播文案。`,
    `文案方向：${directionLabel(input.settings.direction)}。`,
    `成片时长以 ${narrationBudget.targetDurationSec} 秒为主，如语速自然停顿稍多，可顺延到 ${narrationBudget.maxDurationSec} 秒以内，总口播字数控制在 ${narrationBudget.totalMinChars}-${narrationBudget.totalMaxChars} 字之间，宁短勿长。`,
    `每行字数建议：${narrationBudget.lines.map((line, index) => `${index + 1}. ${line.label}${line.durationSec}秒 ${line.minChars}-${line.maxChars}字`).join("；")}。`,
    `门店/品牌名称：${input.brief.storeName || "未填写"}`,
    `行业类型：${input.brief.industry || "未填写"}`,
    `城市/商圈：${input.brief.cityArea || "未填写"}`,
    `目标客户：${input.brief.targetCustomers || "未填写"}`,
    `主推服务/产品：${input.brief.mainOffer || "未填写"}`,
    `核心卖点：${input.brief.sellingPoints || "未填写"}`,
    "文案节奏要求：开场抓人，中段讲清价值，结尾形成到店或咨询动机。",
    "请把每一行都写得适合单独配一个镜头，不要输出编号，不要把一句写得过长。",
  ].join("\n");
}

function buildRewriteMessage(args: {
  readonly input: GenerateLocalBusinessPromoScriptInput;
  readonly previousScript: string;
  readonly feedback: string;
}): string {
  return [
    buildUserMessage(args.input),
    "",
    "上一版文案不符合时长预算，请完全重写，并严格压缩：",
    args.feedback,
    "不要解释，不要道歉，只输出新的最终文案。",
    "上一版文案如下，仅供你判断哪里太长，不要照抄：",
    args.previousScript,
  ].join("\n");
}

function parseScriptResponse(response: unknown): {
  readonly content: Anthropic.ContentBlock[];
  readonly usage?: MessageUsage;
} {
  let payload = response;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload) as unknown;
    } catch {
      throw new Error("invalid script response");
    }
  }
  if (typeof payload !== "object" || payload === null) {
    throw new Error("invalid script response");
  }
  const row = payload as {
    readonly content?: unknown;
    readonly usage?: unknown;
    readonly output_text?: unknown;
  };
  if (Array.isArray(row.content)) {
    return {
      content: row.content as Anthropic.ContentBlock[],
      usage: typeof row.usage === "object" && row.usage !== null ? row.usage as MessageUsage : undefined,
    };
  }
  if (typeof row.output_text === "string" && row.output_text.trim()) {
    return {
      content: [{ type: "text", text: row.output_text.trim(), citations: null } as Anthropic.TextBlock],
      usage: typeof row.usage === "object" && row.usage !== null ? row.usage as MessageUsage : undefined,
    };
  }
  throw new Error("empty script result");
}

function splitSentenceChunks(line: string): string[] {
  const chunks = line
    .split(/(?<=[，,。！？!?；;：:])/u)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  return chunks.length > 0 ? chunks : [line.trim()];
}

function cutLineToMaxChars(line: string, maxChars: number): string {
  const normalized = line.trim();
  if (!normalized) return "";
  if (countLocalBusinessPromoSpeechChars(normalized) <= maxChars) return normalized;

  let best = "";
  for (const chunk of splitSentenceChunks(normalized)) {
    const candidate = `${best}${chunk}`;
    if (!best || countLocalBusinessPromoSpeechChars(candidate) <= maxChars) {
      best = candidate;
      if (countLocalBusinessPromoSpeechChars(best) >= maxChars) break;
      continue;
    }
    break;
  }
  if (best && countLocalBusinessPromoSpeechChars(best) <= maxChars) {
    return best.trim().replace(/[，,、；;：:]+$/u, "").trim();
  }

  let count = 0;
  let output = "";
  for (const char of Array.from(normalized)) {
    const nextCount = count + (/[\p{L}\p{N}]/u.test(char) ? 1 : 0);
    if (nextCount > maxChars) break;
    output += char;
    count = nextCount;
  }
  return output.trim().replace(/[，,、；;：:]+$/u, "").trim();
}

function compressScriptToBudget(lines: readonly string[], maxCharsByLine: readonly number[], totalMaxChars: number): readonly string[] {
  const compressed = lines.map((line, index) => cutLineToMaxChars(line, maxCharsByLine[index] ?? totalMaxChars));
  let totalChars = compressed.reduce((sum, line) => sum + countLocalBusinessPromoSpeechChars(line), 0);
  let guard = 0;
  while (totalChars > totalMaxChars && guard < 32) {
    guard += 1;
    let longestIndex = 0;
    for (let index = 1; index < compressed.length; index += 1) {
      if (countLocalBusinessPromoSpeechChars(compressed[index] ?? "") > countLocalBusinessPromoSpeechChars(compressed[longestIndex] ?? "")) {
        longestIndex = index;
      }
    }
    const current = compressed[longestIndex] ?? "";
    const currentChars = countLocalBusinessPromoSpeechChars(current);
    if (currentChars <= 4) break;
    const overflow = totalChars - totalMaxChars;
    const nextMax = Math.max(4, currentChars - overflow);
    const nextLine = cutLineToMaxChars(current, nextMax);
    if (!nextLine || nextLine === current) break;
    compressed[longestIndex] = nextLine;
    totalChars = compressed.reduce((sum, line) => sum + countLocalBusinessPromoSpeechChars(line), 0);
  }
  return compressed;
}

function normalizeScriptForDuration(script: string, settings: LocalBusinessPromoSettings): string {
  const budget = localBusinessPromoNarrationBudget(settings.durationSec);
  const normalizedLines = splitScriptIntoShotLines(script, budget.shotCount)
    .map((line) => line.replace(/\s+/g, " ").trim());
  const totalChars = normalizedLines.reduce((sum, line) => sum + countLocalBusinessPromoSpeechChars(line), 0);
  const fitsBudget = totalChars <= budget.totalMaxChars
    && normalizedLines.every((line, index) => countLocalBusinessPromoSpeechChars(line) <= budget.lines[index]!.maxChars);
  if (fitsBudget) return normalizedLines.join("\n");
  return compressScriptToBudget(
    normalizedLines,
    budget.lines.map((line) => line.maxChars),
    budget.totalMaxChars,
  ).join("\n");
}

function scriptBudgetFeedback(script: string, settings: LocalBusinessPromoSettings): string {
  const budget = localBusinessPromoNarrationBudget(settings.durationSec);
  const lines = splitScriptIntoShotLines(script, budget.shotCount);
  const totalChars = lines.reduce((sum, line) => sum + countLocalBusinessPromoSpeechChars(line), 0);
  const lineFeedback = lines
    .map((line, index) => {
      const maxChars = budget.lines[index]!.maxChars;
      const charCount = countLocalBusinessPromoSpeechChars(line);
      return charCount > maxChars ? `第 ${index + 1} 行现在约 ${charCount} 字，需要压到 ${maxChars} 字以内` : null;
    })
    .filter(Boolean)
    .join("；");
  const totalFeedback = totalChars > budget.totalMaxChars
    ? `整篇现在约 ${totalChars} 字，需要压到 ${budget.totalMaxChars} 字以内`
    : null;
  return [totalFeedback, lineFeedback || null].filter(Boolean).join("；");
}

function scriptFitsDuration(script: string, settings: LocalBusinessPromoSettings): boolean {
  const budget = localBusinessPromoNarrationBudget(settings.durationSec);
  const lines = splitScriptIntoShotLines(script, budget.shotCount);
  const totalChars = lines.reduce((sum, line) => sum + countLocalBusinessPromoSpeechChars(line), 0);
  return totalChars <= budget.totalMaxChars
    && lines.every((line, index) => countLocalBusinessPromoSpeechChars(line) <= budget.lines[index]!.maxChars);
}

function normalizeScriptLineBreaks(script: string, settings: LocalBusinessPromoSettings): string {
  const budget = localBusinessPromoNarrationBudget(settings.durationSec);
  return splitScriptIntoShotLines(script, budget.shotCount)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n");
}

export async function generateLocalBusinessPromoScript(input: GenerateLocalBusinessPromoScriptInput): Promise<string> {
  const billing = input.billing ?? defaultBilling();
  const operationId = `local-business-promo-script:${randomUUID()}`;
  const llmConfig = loadLlmConfig();
  const model = resolveLocalBusinessPromoScriptModel(process.env, llmConfig.defaultModel);
  const initialMessage = buildUserMessage(input);
  let settledInputTokens = 0;
  let settledOutputTokens = 0;

  await billing.reserve({
    operationId,
    userId: input.userId,
    type: "chat",
    model,
    inputTokens: estimateInputTokens(initialMessage),
    maxOutputTokens: SCRIPT_MAX_OUTPUT_TOKENS,
  });

  const client = createLlmClient(llmConfig);
  try {
    let lastNormalizedScript = "";
    for (let attempt = 0; attempt < SCRIPT_MAX_REWRITE_ATTEMPTS; attempt += 1) {
      const userMessage = attempt === 0
        ? initialMessage
        : buildRewriteMessage({
          input,
          previousScript: lastNormalizedScript,
          feedback: scriptBudgetFeedback(lastNormalizedScript, input.settings),
        });
      const response = await client.messages.create(
        {
          model,
          max_tokens: SCRIPT_MAX_OUTPUT_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }],
        },
        { timeout: SCRIPT_TIMEOUT_MS },
      );
      const normalized = parseScriptResponse(response);
      settledInputTokens += normalized.usage?.input_tokens ?? estimateInputTokens(userMessage);
      settledOutputTokens += normalized.usage?.output_tokens ?? 0;
      const text = normalized.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
      if (!text) throw new Error("empty script result");
      lastNormalizedScript = normalizeScriptLineBreaks(text, input.settings);
      if (scriptFitsDuration(lastNormalizedScript, input.settings)) {
        await billing.settle({
          operationId,
          userId: input.userId,
          model,
          inputTokens: settledInputTokens,
          outputTokens: settledOutputTokens,
        });
        return lastNormalizedScript;
      }
    }

    const finalScript = normalizeScriptForDuration(lastNormalizedScript, input.settings);
    await billing.settle({
      operationId,
      userId: input.userId,
      model,
      inputTokens: settledInputTokens,
      outputTokens: settledOutputTokens,
    });
    return finalScript;
  } catch (error) {
    await billing.settle({
      operationId,
      userId: input.userId,
      model,
      inputTokens: settledInputTokens,
      outputTokens: settledOutputTokens,
    }).catch(() => undefined);
    throw error;
  }
}
