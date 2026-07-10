import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  chatInitialReserveOutputTokens,
  chatMaxOutputTokenBudget,
  ChatModelEmptyResponseError,
  ChatModelStreamTimeoutError,
  runTurn,
} from "../run.js";

// 用假 client 模拟"先 tool_use 再 end_turn"两轮
function fakeClient(): Anthropic {
  let call = 0;
  return {
    messages: {
      stream: vi.fn(() => {
        call += 1;
        const finalMessage = async () => {
          if (call === 1) {
            return {
              stop_reason: "tool_use",
              content: [
                { type: "tool_use", id: "t1", name: "get_time", input: {} },
              ],
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          }
          return {
            stop_reason: "end_turn",
            content: [{ type: "text", text: "现在是工具返回的时间" }],
            usage: { input_tokens: 1, output_tokens: 8 },
          };
        };
        if (call === 1) {
          return {
            on() { return this; },
            finalMessage,
          };
        }
        return {
          on(event: string, listener: (delta: string, snapshot: string) => void) {
            if (event === "text") listener("现在是工具返回的时间", "现在是工具返回的时间");
            return this;
          },
          finalMessage,
        };
      }),
    },
  } as unknown as Anthropic;
}

describe("runTurn 工具循环", () => {
  it("注入本机工具时仍保留默认云端工具", async () => {
    const client = {
      messages: {
        stream: vi.fn(() => ({
          on() { return this; },
          async finalMessage() {
            return {
              stop_reason: "end_turn",
              content: [{ type: "text", text: "ok" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          },
        })),
      },
    } as unknown as Anthropic;

    await runTurn({
      client,
      model: "glm-5.2",
      history: [{ role: "user", content: "看桌面文件并告诉我时间" }],
      tools: [{
        name: "fs_list",
        description: "列出目录",
        input_schema: { type: "object", properties: {}, required: [] },
      }],
      execTool: async () => "ok",
    });

    expect(client.messages.stream).toHaveBeenCalledWith(expect.objectContaining({
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "get_time" }),
        expect.objectContaining({ name: "fs_list" }),
      ]),
    }));
  });

  it("遇到 tool_use 执行工具并回填，最终返回文本", async () => {
    const onText = vi.fn();
    const out = await runTurn({
      client: fakeClient(),
      model: "glm-5.2",
      history: [{ role: "user", content: "几点了" }],
      onText,
    });
    expect(out.text).toContain("时间");
    expect(out.toolCalls).toBe(1);
    expect(out.stoppedByMaxIterations).toBe(false);
  });

  it("工具执行时回调开始和完成状态", async () => {
    const onTool = vi.fn();
    const out = await runTurn({
      client: fakeClient(),
      model: "glm-5.2",
      history: [{ role: "user", content: "几点了" }],
      execTool: async () => "2026-07-03T00:00:00.000Z",
      onTool,
    });

    expect(out.toolCalls).toBe(1);
    expect(onTool).toHaveBeenNthCalledWith(1, {
      id: "t1",
      name: "get_time",
      input: {},
      status: "started",
    });
    expect(onTool).toHaveBeenNthCalledWith(2, expect.objectContaining({
      id: "t1",
      name: "get_time",
      input: {},
      status: "completed",
      output: "2026-07-03T00:00:00.000Z",
    }));
  });

  it("工具返回错误文本时回调失败状态并继续喂给模型", async () => {
    const onTool = vi.fn();
    const out = await runTurn({
      client: fakeClient(),
      model: "glm-5.2",
      history: [{ role: "user", content: "操作电脑" }],
      execTool: async () => "[工具执行失败: CONNECTION_LOST] 这一步结果未知",
      onTool,
    });

    expect(out.toolCalls).toBe(1);
    expect(onTool).toHaveBeenLastCalledWith(expect.objectContaining({
      id: "t1",
      name: "get_time",
      status: "failed",
      error: "[工具执行失败: CONNECTION_LOST] 这一步结果未知",
    }));
  });

  it("工具调用轮里的文字不会提前作为最终回复输出", async () => {
    let call = 0;
    const client = {
      messages: {
        stream: vi.fn(() => {
          call += 1;
          if (call === 1) {
            return {
              on(event: string, listener: (delta: string, snapshot: string) => void) {
                if (event === "text") listener("Assessing build machine", "Assessing build machine");
                return this;
              },
              async finalMessage() {
                return {
                  stop_reason: "tool_use",
                  content: [
                    { type: "text", text: "Assessing build machine" },
                    { type: "tool_use", id: "t1", name: "terminal_exec", input: {} },
                  ],
                  usage: { input_tokens: 1, output_tokens: 1 },
                };
              },
            };
          }
          return {
            on(event: string, listener: (delta: string, snapshot: string) => void) {
              if (event === "text") listener("最终检查完成", "最终检查完成");
              return this;
            },
            async finalMessage() {
              return {
                stop_reason: "end_turn",
                content: [{ type: "text", text: "最终检查完成" }],
                usage: { input_tokens: 1, output_tokens: 1 },
              };
            },
          };
        }),
      },
    } as unknown as Anthropic;
    const onText = vi.fn();
    const onResetText = vi.fn();

    const out = await runTurn({
      client,
      model: "glm-5.2",
      history: [{ role: "user", content: "检查构建机" }],
      execTool: async () => "ok",
      onText,
      onResetText,
    });

    expect(out.toolCalls).toBe(1);
    expect(out.text).toBe("最终检查完成");
    // 新流式行为：工具前的说明会实时流出，但随后被 onResetText 作废，
    // 前端最终仅保留最终文本，工具前说明不会泄漏进最终回复
    expect(onText).toHaveBeenNthCalledWith(1, "Assessing build machine");
    expect(onResetText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenLastCalledWith("最终检查完成");
  });

  it("按文本 delta 回调，而不是等完整消息返回后一次性回调", async () => {
    const onText = vi.fn();
    const client = {
      messages: {
        create: vi.fn(async () => ({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "你好世界" }],
          usage: { input_tokens: 1, output_tokens: 4 },
        })),
        stream: vi.fn(() => ({
          on(event: string, listener: (delta: string, snapshot: string) => void) {
            if (event === "text") {
              listener("你好", "你好");
              listener("世界", "你好世界");
            }
            return this;
          },
          async finalMessage() {
            return {
              stop_reason: "end_turn",
              content: [{ type: "text", text: "你好世界" }],
              usage: { input_tokens: 1, output_tokens: 4 },
            };
          },
        })),
      },
    } as unknown as Anthropic;

    const out = await runTurn({
      client,
      model: "glm-5.2",
      history: [{ role: "user", content: "打招呼" }],
      onText,
    });

    expect(out.text).toBe("你好世界");
    expect(onText).toHaveBeenNthCalledWith(1, "你好");
    expect(onText).toHaveBeenNthCalledWith(2, "世界");
    expect(client.messages.stream).toHaveBeenCalled();
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it("默认支持超过 8 次的桌面工具循环", async () => {
    let call = 0;
    const client = {
      messages: {
        stream: vi.fn(() => ({
          on() { return this; },
          async finalMessage() {
            call += 1;
            if (call <= 9) {
              return {
                stop_reason: "tool_use",
                content: [{ type: "tool_use", id: `t${call}`, name: "terminal_exec", input: {} }],
                usage: { input_tokens: 1, output_tokens: 1 },
              };
            }
            return {
              stop_reason: "end_turn",
              content: [{ type: "text", text: "任务完成" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          },
        })),
      },
    } as unknown as Anthropic;

    const out = await runTurn({
      client,
      model: "glm-5.2",
      history: [{ role: "user", content: "操作电脑" }],
      execTool: async () => "ok",
    });

    expect(out.toolCalls).toBe(9);
    expect(out.text).toBe("任务完成");
    expect(out.stoppedByMaxIterations).toBe(false);
  });

  it("工具循环耗尽上限时返回明确状态", async () => {
    let call = 0;
    const client = {
      messages: {
        stream: vi.fn(() => ({
          on() { return this; },
          async finalMessage() {
            call += 1;
            return {
              stop_reason: "tool_use",
              content: [{ type: "tool_use", id: `t${call}`, name: "terminal_exec", input: {} }],
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          },
        })),
      },
    } as unknown as Anthropic;

    const out = await runTurn({
      client,
      model: "glm-5.2",
      history: [{ role: "user", content: "一直操作电脑" }],
      execTool: async () => "ok",
      maxIterations: 2,
    });

    expect(out.toolCalls).toBe(2);
    expect(out.text).toBe("");
    expect(out.stoppedByMaxIterations).toBe(true);
  });

  it("工具循环耗尽上限时不把工具轮说明当最终文本", async () => {
    let call = 0;
    const client = {
      messages: {
        stream: vi.fn(() => ({
          on(event: string, listener: (delta: string, snapshot: string) => void) {
            if (event === "text") listener("Still checking", "Still checking");
            return this;
          },
          async finalMessage() {
            call += 1;
            return {
              stop_reason: "tool_use",
              content: [
                { type: "text", text: "Still checking" },
                { type: "tool_use", id: `t${call}`, name: "terminal_exec", input: {} },
              ],
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          },
        })),
      },
    } as unknown as Anthropic;
    const onText = vi.fn();
    const onResetText = vi.fn();

    const out = await runTurn({
      client,
      model: "glm-5.2",
      history: [{ role: "user", content: "一直操作电脑" }],
      execTool: async () => "ok",
      onText,
      onResetText,
      maxIterations: 2,
    });

    expect(out.toolCalls).toBe(2);
    expect(out.text).toBe("");
    expect(out.stoppedByMaxIterations).toBe(true);
    // 新流式行为：工具轮说明会实时流出，但每轮都被 onResetText 作废，
    // 最终文本仍为空，不会把工具轮说明当最终回复
    expect(onText).toHaveBeenCalledWith("Still checking");
    expect(onResetText).toHaveBeenCalled();
  });

  it("模型流空闲超时时会中止请求", async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const client = {
      messages: {
        stream: vi.fn(() => ({
          on() { return this; },
          abort,
          finalMessage: () => new Promise<never>(() => {}),
        })),
      },
    } as unknown as Anthropic;

    const pending = runTurn({
      client,
      model: "glm-5.2",
      history: [{ role: "user", content: "测试卡住" }],
      streamIdleTimeoutMs: 20,
      streamTotalTimeoutMs: 1000,
      streamMaxRetries: 0,
    });

    const assertion = expect(pending).rejects.toBeInstanceOf(ChatModelStreamTimeoutError);
    await vi.advanceTimersByTimeAsync(21);
    await assertion;
    expect(abort).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("模型流未输出文本前异常会自动重试", async () => {
    let call = 0;
    const firstAbort = vi.fn();
    const secondAbort = vi.fn();
    const client = {
      messages: {
        stream: vi.fn(() => {
          call += 1;
          if (call === 1) {
            const listeners: Record<string, (...args: unknown[]) => void> = {};
            return {
              on(event: string, listener: (...args: unknown[]) => void) {
                listeners[event] = listener;
                return this;
              },
              abort: firstAbort,
              finalMessage: () => {
                queueMicrotask(() => listeners.error?.(new Error("bad stream")));
                return new Promise<never>(() => {});
              },
            };
          }
          return {
            on(event: string, listener: (delta: string, snapshot: string) => void) {
              if (event === "text") listener("重试成功", "重试成功");
              return this;
            },
            abort: secondAbort,
            async finalMessage() {
              return {
                stop_reason: "end_turn",
                content: [{ type: "text", text: "重试成功" }],
                usage: { input_tokens: 1, output_tokens: 2 },
              };
            },
          };
        }),
      },
    } as unknown as Anthropic;
    const onText = vi.fn();

    const out = await runTurn({
      client,
      model: "glm-5.2",
      history: [{ role: "user", content: "测试重试" }],
      onText,
      streamIdleTimeoutMs: 1000,
      streamTotalTimeoutMs: 2000,
      streamMaxRetries: 1,
    });

    expect(out.text).toBe("重试成功");
    expect(onText).toHaveBeenCalledWith("重试成功");
    expect(client.messages.stream).toHaveBeenCalledTimes(2);
    expect(firstAbort).toHaveBeenCalledTimes(1);
    expect(secondAbort).not.toHaveBeenCalled();
  });

  it("最终消息为空但流式 delta 有内容时，使用流式内容作为最终回复", async () => {
    const client = {
      messages: {
        stream: vi.fn(() => ({
          on(event: string, listener: (delta: string, snapshot: string) => void) {
            if (event === "text") {
              listener("流式", "流式");
              listener("内容", "流式内容");
            }
            return this;
          },
          async finalMessage() {
            return {
              stop_reason: "end_turn",
              content: [],
              usage: { input_tokens: 3, output_tokens: 8 },
            };
          },
        })),
      },
    } as unknown as Anthropic;
    const onText = vi.fn();

    const out = await runTurn({
      client,
      model: "glm-5.2",
      history: [{ role: "user", content: "写文章" }],
      onText,
    });

    expect(out.text).toBe("流式内容");
    expect(out.usage.outputTokens).toBe(8);
    expect(onText).toHaveBeenNthCalledWith(1, "流式");
    expect(onText).toHaveBeenNthCalledWith(2, "内容");
  });

  it("模型没有返回有效文本时抛出空响应错误", async () => {
    const client = {
      messages: {
        stream: vi.fn(() => ({
          on() { return this; },
          async finalMessage() {
            return {
              stop_reason: "end_turn",
              content: [],
              usage: { input_tokens: 3, output_tokens: 8 },
            };
          },
        })),
      },
    } as unknown as Anthropic;

    await expect(runTurn({
      client,
      model: "glm-5.2",
      history: [{ role: "user", content: "写文章" }],
    })).rejects.toBeInstanceOf(ChatModelEmptyResponseError);
  });

  it("模型因 max_tokens 截断时自动续写并合并最终回复", async () => {
    const streamCalls: Array<{ messages: Anthropic.MessageParam[]; max_tokens: number }> = [];
    let call = 0;
    const client = {
      messages: {
        stream: vi.fn((args: { messages: Anthropic.MessageParam[]; max_tokens: number }) => {
          streamCalls.push({ max_tokens: args.max_tokens, messages: [...args.messages] });
          call += 1;
          if (call === 1) {
            return {
              on(event: string, listener: (delta: string, snapshot: string) => void) {
                if (event === "text") listener("第一段", "第一段");
                return this;
              },
              async finalMessage() {
                return {
                  stop_reason: "max_tokens",
                  content: [{ type: "text", text: "第一段" }],
                  usage: { input_tokens: 10, output_tokens: 100 },
                };
              },
            };
          }
          return {
            on(event: string, listener: (delta: string, snapshot: string) => void) {
              if (event === "text") listener("第二段", "第二段");
              return this;
            },
            async finalMessage() {
              return {
                stop_reason: "end_turn",
                content: [{ type: "text", text: "第二段" }],
                usage: { input_tokens: 5, output_tokens: 20 },
              };
            },
          };
        }),
      },
    } as unknown as Anthropic;
    const onText = vi.fn();

    const out = await runTurn({
      client,
      model: "glm-5.2",
      history: [{ role: "user", content: "写一篇长文" }],
      onText,
      maxContinuations: 1,
    });

    expect(out.text).toBe("第一段第二段");
    expect(out.usage).toEqual({ inputTokens: 15, outputTokens: 120 });
    expect(onText).toHaveBeenNthCalledWith(1, "第一段");
    expect(onText).toHaveBeenNthCalledWith(2, "第二段");
    expect(streamCalls).toHaveLength(2);
    expect(streamCalls[1].messages.at(-1)).toEqual({
      role: "user",
      content: expect.stringContaining("继续"),
    });
  });

  it("主对话初始预扣只使用单次输出上限", () => {
    expect(chatInitialReserveOutputTokens({ maxOutputTokens: 100 })).toBe(100);
  });

  it("自动续写总输出预算覆盖续写轮数", () => {
    expect(chatMaxOutputTokenBudget({ maxOutputTokens: 100, maxContinuations: 2 })).toBe(300);
  });
});
