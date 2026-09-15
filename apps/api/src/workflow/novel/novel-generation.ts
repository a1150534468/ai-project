import type Anthropic from "@anthropic-ai/sdk";
import { createLlmClient, loadLlmConfig } from "@ai-assistant/llm";
import {
  buildNovelSystemPrompt,
  buildNovelUserPrompt,
  type NovelPreparedRequest,
  type NovelPromptInput,
} from "./novel-prompts.js";

export interface NovelGenerationResult {
  readonly text: string;
  readonly model: string;
}

export type NovelGenerator = (input: NovelPromptInput) => Promise<NovelGenerationResult>;

export function resolveNovelTextModel(env: NodeJS.ProcessEnv = process.env, defaultModel?: string): string {
  const configured = env.NOVEL_TEXT_MODEL?.trim();
  return configured || defaultModel?.trim() || "GLM-5.2";
}

function bounded(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

export function novelGenerationMaxTokens(input: NovelPromptInput): number {
  const targetChars = input.targetChars ?? (input.targetKind === "chapter" ? 3_000 : 500);
  if (input.targetKind === "chapter") return bounded(Math.ceil(targetChars * 2), 6_000, 16_000);
  if (input.targetKind === "chapterRewrite") return bounded(Math.ceil(targetChars * 2), 2_000, 8_000);
  return input.targetKind === "setupPlot" ? 16_000 : 10_000;
}

export function buildNovelPreparedRequest(input: NovelPromptInput, model: string): NovelPreparedRequest {
  const temperature = typeof input.temperatureOverride === "number"
    ? bounded(input.temperatureOverride, 0, 2)
    : undefined;
  return {
    model,
    maxTokens: novelGenerationMaxTokens(input),
    ...(temperature === undefined ? {} : { temperature }),
    systemPrompt: buildNovelSystemPrompt(input.targetKind),
    userPrompt: input.promptOverride?.trim() || buildNovelUserPrompt(input),
  };
}

function responseText(response: { content: Array<Anthropic.ContentBlock> }): string {
  return response.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("").trim();
}

export function createNovelGenerator(env: NodeJS.ProcessEnv = process.env): NovelGenerator {
  return async (input) => {
    const config = loadLlmConfig(env);
    const client = createLlmClient(config);
    const model = input.modelOverride?.trim() || resolveNovelTextModel(env, config.defaultModel);
    const prepared = buildNovelPreparedRequest(input, model);
    const request = {
      model: prepared.model,
      max_tokens: prepared.maxTokens,
      ...(prepared.temperature === undefined ? {} : { temperature: prepared.temperature }),
      system: prepared.systemPrompt,
      messages: [{ role: "user" as const, content: prepared.userPrompt }],
    };

    await input.onRequestPrepared?.(prepared);
    let response: { content: Array<Anthropic.ContentBlock> };
    if (!input.onChunk) {
      response = await client.messages.create(request);
    } else {
      const stream = client.messages.stream(request);
      let callbacks = Promise.resolve();
      let callbackError: unknown;
      stream.on("text", (chunk) => {
        callbacks = callbacks.then(() => input.onChunk!(chunk)).catch((error) => {
          callbackError = error;
          stream.abort();
          throw error;
        });
      });
      try {
        response = await stream.finalMessage();
        await callbacks;
      } catch (error) {
        await callbacks.catch(() => undefined);
        throw callbackError ?? error;
      }
    }

    const text = responseText(response);
    if (!text) throw new Error("empty novel generation response");
    return { text, model };
  };
}
