import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { createLlmClient, loadLlmConfig } from "../client.js";

const provider = process.env.LLM_PROVIDER?.trim().toLowerCase();
const bailianConfigured = !!(process.env.BAILIAN_BASE_URL
  || process.env.BAILIAN_WORKSPACE_ID
  || process.env.BAILIAN_API_KEY
  || process.env.DASHSCOPE_API_KEY);
const hasBailianEnv = (
  provider === "bailian"
  || provider === "aliyun"
  || (!provider && bailianConfigured)
)
  && !!(process.env.BAILIAN_BASE_URL || process.env.BAILIAN_WORKSPACE_ID)
  && !!(process.env.BAILIAN_API_KEY || process.env.DASHSCOPE_API_KEY);
const hasLegacyEnv = ((!provider && !bailianConfigured) || provider === "anthropic" || provider === "newapi")
  && !!process.env.LLM_BASE_URL
  && !!process.env.LLM_API_KEY;
const hasEnv = process.env.RUN_TOOLUSE_POC === "1" && (hasBailianEnv || hasLegacyEnv);

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

describe.runIf(hasEnv)("P0: tool_use 全链路（当前配置的 LLM Provider）", () => {
  it("模型应发起 get_time 工具调用并据其结果作答", async () => {
    const cfg = loadLlmConfig();
    const client = createLlmClient(cfg);

    const tools: Anthropic.Tool[] = [
      {
        name: "get_time",
        description: "获取当前 UTC 时间，用户问时间时必须调用此工具",
        input_schema: { type: "object", properties: {}, required: [] },
      },
    ];
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "现在几点了？请用工具查。" },
    ];

    const first = await client.messages.create({
      model: cfg.defaultModel,
      max_tokens: 1024,
      tools,
      messages,
    });

    const toolUse = first.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    expect(toolUse, "模型未发起 tool_use，Provider 的工具调用链路不通").toBeTruthy();
    expect(toolUse!.name).toBe("get_time");

    const fixedTime = "2026-06-26T12:00:00Z";
    messages.push({ role: "assistant", content: first.content });
    messages.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: toolUse!.id, content: fixedTime },
      ],
    });

    const second = await client.messages.create({
      model: cfg.defaultModel,
      max_tokens: 1024,
      tools,
      messages,
    });

    const text = textOf(second);
    expect(text).toContain("12:00");
  }, 60_000);

  it("Anthropic SDK 流式接口应返回完整文本", async () => {
    const cfg = loadLlmConfig();
    const client = createLlmClient(cfg);
    const stream = client.messages.stream({
      model: cfg.defaultModel,
      max_tokens: 128,
      messages: [{ role: "user", content: "只回答：stream-ok" }],
    });

    const message = await stream.finalMessage();
    expect(textOf(message).toLowerCase()).toContain("stream-ok");
  }, 60_000);

  it("Anthropic 图片内容块应被百炼多模态模型接受", async () => {
    const cfg = loadLlmConfig();
    const client = createLlmClient(cfg);
    const message = await client.messages.create({
      model: process.env.CHAT_MULTIMODAL_MODEL?.trim() || cfg.defaultModel,
      max_tokens: 128,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFElEQVR4nGP4TyJgGNUwqmH4agAAr639H708R/EAAAAASUVORK5CYII=",
            },
          },
          { type: "text", text: "简短描述这张图片。" },
        ],
      }],
    });

    expect(textOf(message).trim().length).toBeGreaterThan(0);
  }, 60_000);
});
