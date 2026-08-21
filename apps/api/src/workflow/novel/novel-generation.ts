import type Anthropic from "@anthropic-ai/sdk";
import { createLlmClient, loadLlmConfig } from "@ai-assistant/llm";
import { buildNovelSystemPrompt, buildNovelUserPrompt, type NovelPreparedRequest, type NovelPromptInput } from "./novel-prompts.js";

export interface NovelGenerationResult {
  readonly text: string;
  readonly model: string;
}

export type NovelGenerator = (input: NovelPromptInput) => Promise<NovelGenerationResult>;

export function resolveNovelTextModel(env: NodeJS.ProcessEnv = process.env, defaultModel?: string): string {
  return (env.NOVEL_TEXT_MODEL ?? defaultModel ?? "").trim() || "GLM-5.2";
}

function clampTokenBudget(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function novelGenerationMaxTokens(input: NovelPromptInput): number {
  if (input.targetKind === "chapter") {
    return clampTokenBudget(Math.max(6000, Math.ceil((input.targetChars ?? 3000) * 2)), 6000, 16000);
  }
  if (input.targetKind === "chapterRewrite") return clampTokenBudget(Math.max(2000, Math.ceil((input.targetChars ?? 500) * 2)), 2000, 8000);
  if (input.targetKind === "setupPlot") return 16_000;
  if (input.targetKind === "setupBible" || input.targetKind === "setupCharacters" || input.targetKind === "setupLocations") return 10_000;
  return 10_000;
}

export function buildNovelPreparedRequest(input: NovelPromptInput, model: string): NovelPreparedRequest {
  return {
    model,
    maxTokens: novelGenerationMaxTokens(input),
    ...(typeof input.temperatureOverride === "number" ? { temperature: Math.max(0, Math.min(2, input.temperatureOverride)) } : {}),
    systemPrompt: buildNovelSystemPrompt(input.targetKind),
    userPrompt: input.promptOverride?.trim() || buildNovelUserPrompt(input),
  };
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
    const model = input.modelOverride?.trim() || resolveNovelTextModel(env, cfg.defaultModel);
    const prepared = buildNovelPreparedRequest(input, model);
    const request = {
      model: prepared.model,
      max_tokens: prepared.maxTokens,
      ...(prepared.temperature === undefined ? {} : { temperature: prepared.temperature }),
      system: prepared.systemPrompt,
      messages: [{
        role: "user" as const,
        content: prepared.userPrompt,
      }],
    };
    await input.onRequestPrepared?.(prepared);
    let response: { content: Array<Anthropic.ContentBlock> };
    if (input.onChunk) {
      const stream = client.messages.stream(request);
      let pending = Promise.resolve();
      let chunkError: unknown;
      stream.on("text", (chunk) => {
        pending = pending.then(async () => {
          try {
            await input.onChunk!(chunk);
          } catch (error) {
            chunkError = error;
            stream.abort();
            throw error;
          }
        });
      });
      try {
        response = await stream.finalMessage();
        await pending;
      } catch (error) {
        await pending.catch(() => undefined);
        throw chunkError ?? error;
      }
    } else {
      response = await client.messages.create(request);
    }
    const text = extractResponseText(response);
    if (!text) throw new Error("empty novel generation response");
    return { text, model };
  };
}
