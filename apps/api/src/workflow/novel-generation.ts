import type Anthropic from "@anthropic-ai/sdk";
import { createLlmClient, loadLlmConfig } from "@ai-assistant/llm";
import { buildNovelSystemPrompt, buildNovelUserPrompt, type NovelPromptInput } from "./novel-prompts.js";

export interface NovelGenerationResult {
  readonly text: string;
  readonly model: string;
}

export type NovelGenerator = (input: NovelPromptInput) => Promise<NovelGenerationResult>;

export function resolveNovelTextModel(env: NodeJS.ProcessEnv = process.env, defaultModel?: string): string {
  return (env.NOVEL_TEXT_MODEL ?? defaultModel ?? "").trim() || "GLM-5.2";
}

function countOrDefault(input: NovelPromptInput, fallback: number): number {
  return Math.max(1, input.targetCount ?? fallback);
}

function clampTokenBudget(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function novelGenerationMaxTokens(input: NovelPromptInput): number {
  if (input.targetKind === "chapter") {
    return clampTokenBudget(Math.max(6000, Math.ceil((input.targetChars ?? 3000) * 2)), 6000, 16000);
  }
  if (input.targetKind === "outline") {
    return clampTokenBudget(Math.max(10000, countOrDefault(input, 12) * 900), 6000, 16000);
  }
  if (input.targetKind === "volumes") {
    return clampTokenBudget(Math.max(6000, countOrDefault(input, 6) * 1000), 6000, 12000);
  }
  if (input.targetKind === "chars") {
    return clampTokenBudget(Math.max(5000, countOrDefault(input, 6) * 800), 5000, 12000);
  }
  return 5000;
}

function extractResponseText(response: { content: Array<Anthropic.ContentBlock> }): string {
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

export function createNovelGenerator(env: NodeJS.ProcessEnv = process.env): NovelGenerator {
  return async (input) => {
    const cfg = loadLlmConfig(env);
    const client = createLlmClient(cfg);
    const model = resolveNovelTextModel(env, cfg.defaultModel);
    const response = await client.messages.create({
      model,
      max_tokens: novelGenerationMaxTokens(input),
      system: buildNovelSystemPrompt(input.targetKind),
      messages: [{
        role: "user",
        content: buildNovelUserPrompt(input),
      }],
    });
    const text = extractResponseText(response);
    if (!text) throw new Error("empty novel generation response");
    return { text, model };
  };
}
