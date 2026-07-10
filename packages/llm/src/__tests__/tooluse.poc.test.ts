import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { createLlmClient, loadLlmConfig } from "../client.js";

const hasEnv = process.env.RUN_TOOLUSE_POC === "1"
  && !!process.env.LLM_BASE_URL
  && !!process.env.LLM_API_KEY;

describe.runIf(hasEnv)("P0: tool_use 全链路 (NewAPI→GLM)", () => {
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
    expect(toolUse, "模型未发起 tool_use，NewAPI/GLM tool 链路不通").toBeTruthy();
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

    const text = second.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    expect(text).toContain("12:00");
  }, 60_000);
});
