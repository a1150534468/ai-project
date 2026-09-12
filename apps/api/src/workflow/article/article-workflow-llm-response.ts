import type Anthropic from "@anthropic-ai/sdk";
import { jsonrepair } from "jsonrepair";
import type { ZodType, ZodTypeDef } from "zod";

type OpenAiChoice = { readonly message?: { readonly content?: unknown }; readonly text?: unknown };

function contentBlocks(raw: unknown): readonly Anthropic.ContentBlock[] {
  const value = typeof raw === "string" ? JSON.parse(raw) as unknown : raw;
  if (!value || typeof value !== "object") throw new Error("模型返回结构无法解析");
  const response = value as { readonly content?: unknown; readonly choices?: readonly OpenAiChoice[] };
  if (Array.isArray(response.content)) return response.content as readonly Anthropic.ContentBlock[];
  if (typeof response.content === "string") {
    return [{ type: "text", text: response.content } as Anthropic.TextBlock];
  }
  const text = response.choices?.map((choice) => {
    if (typeof choice.message?.content === "string") return choice.message.content;
    return typeof choice.text === "string" ? choice.text : "";
  }).join("").trim();
  if (text) return [{ type: "text", text } as Anthropic.TextBlock];
  throw new Error("模型响应缺少 content 字段");
}

export function articleWorkflowTextFromResponse(raw: unknown): string {
  return contentBlocks(raw)
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

export function stripArticleWorkflowCodeFence(text: string): string {
  return text.replace(/^```(?:json|html)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

export function parseArticleWorkflowJson<T>(text: string, schema: ZodType<T, ZodTypeDef, unknown>): T {
  let value: unknown;
  try {
    value = JSON.parse(jsonrepair(stripArticleWorkflowCodeFence(text))) as unknown;
  } catch {
    throw new Error("模型返回结构无法解析，请重试");
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const fields = parsed.error.issues.map((issue) => issue.path.join(".")).filter(Boolean).join("、");
  console.warn(`[article-workflow] 模型输出不符合 schema: ${fields || "(根对象)"}`);
  throw new Error("模型返回结构不符合要求，请重试");
}
