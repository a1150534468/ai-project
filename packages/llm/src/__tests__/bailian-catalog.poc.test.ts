import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { createLlmClient, loadLlmConfig } from "../client.js";

const BAILIAN_ANTHROPIC_MODELS = [
  "qwen3.7-plus",
  "qwen3.7-max",
  "deepseek-v4-pro",
  "glm-5.2",
  "qwen3.6-flash",
  "deepseek-v4-flash",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "qwen3.6-35b-a3b",
  "qwen3.6-27b",
  "qwen3.6-max-preview",
  "qwen3.7-plus-2026-05-26",
  "qwen3.7-max-2026-06-08",
  "qwen3.7-max-2026-05-20",
  "qwen3.6-flash-2026-04-16",
  "qwen3.5-plus-2026-04-20",
  "qwen3.5-ocr",
] as const;

const BAILIAN_OPENAI_ONLY_MODELS = [
  "qwen3.7-max-preview",
  "qwen3.7-max-2026-05-17",
] as const;

const provider = process.env.LLM_PROVIDER?.trim().toLowerCase();
const hasBailianEnv = (provider === "bailian" || provider === "aliyun")
  && !!(process.env.BAILIAN_BASE_URL || process.env.BAILIAN_WORKSPACE_ID)
  && !!(process.env.BAILIAN_API_KEY || process.env.DASHSCOPE_API_KEY);
const enabled = process.env.RUN_BAILIAN_CATALOG_POC === "1" && hasBailianEnv;

const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFElEQVR4nGP4TyJgGNUwqmH4agAAr639H708R/EAAAAASUVORK5CYII=";

function promptFor(model: string): Anthropic.MessageParam["content"] {
  if (model === "qwen3.5-ocr") {
    return [
      { type: "image", source: { type: "base64", media_type: "image/png", data: tinyPng } },
      { type: "text", text: "识别图片；若没有文字，只回答：OK" },
    ];
  }
  return "只回答：OK";
}

describe.runIf(enabled)("P0: 百炼免费模型目录可调用", () => {
  it("17 个对话模型均可通过 Anthropic 兼容端点响应", async () => {
    const client = createLlmClient(loadLlmConfig());
    const failures: string[] = [];

    // Keep the smoke test sequential to avoid turning account RPM limits into
    // false negatives for the catalog itself.
    for (const model of BAILIAN_ANTHROPIC_MODELS) {
      try {
        const response = await client.messages.create({
          model,
          max_tokens: 64,
          messages: [{ role: "user", content: promptFor(model) }],
        });
        if (response.content.length === 0) failures.push(`${model}: empty response`);
      } catch (error) {
        failures.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    expect(failures, failures.join("\n")).toEqual([]);
  }, 300_000);

  it("2 个旧预览模型可通过百炼 OpenAI 兼容端点响应", async () => {
    const apiKey = process.env.BAILIAN_API_KEY || process.env.DASHSCOPE_API_KEY || "";
    const failures: string[] = [];

    for (const model of BAILIAN_OPENAI_ONLY_MODELS) {
      const response = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 64,
          messages: [{ role: "user", content: "只回答：OK" }],
        }),
      });
      if (!response.ok) failures.push(`${model}: ${response.status} ${await response.text()}`);
    }

    expect(failures, failures.join("\n")).toEqual([]);
  }, 60_000);
});
