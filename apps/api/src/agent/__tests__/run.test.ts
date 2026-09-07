import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatInitialReserveOutputTokens,
  chatMaxOutputTokenBudget,
  ChatModelEmptyResponseError,
  ChatModelStreamTimeoutError,
  runTurn,
  type RunTurnClient,
  type RunTurnMessageStream,
  type RunTurnModelRequest,
} from "../run.js";
import { execTool as executeBuiltinTool } from "../tools.js";

interface StreamScript {
  readonly response?: Anthropic.Message;
  readonly deltas?: readonly string[];
  readonly failure?: Error;
  readonly pending?: boolean;
}

interface ScriptedClient {
  readonly client: RunTurnClient;
  readonly requests: RunTurnModelRequest[];
  readonly aborts: ReturnType<typeof vi.fn>[];
}

function text(value: string): Anthropic.TextBlock {
  return { type: "text", text: value, citations: null };
}

function toolUse(id: string, name = "get_time", input: unknown = {}): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

function response(
  stopReason: Anthropic.StopReason,
  content: Anthropic.ContentBlock[],
  inputTokens = 1,
  outputTokens = 1,
): Anthropic.Message {
  return {
    id: "message-" + stopReason,
    type: "message",
    role: "assistant",
    model: "test-model",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      server_tool_use: null,
      service_tier: null,
    },
  };
}

class FakeMessageStream implements RunTurnMessageStream {
  readonly abort = vi.fn();
  private readonly textListeners: Array<(delta: string) => void> = [];
  private readonly errorListeners: Array<(error: unknown) => void> = [];

  constructor(private readonly script: StreamScript) {}

  on(event: "streamEvent", listener: () => void): this;
  on(event: "text", listener: (delta: string) => void): this;
  on(event: "error" | "abort", listener: (error: unknown) => void): this;
  on(
    event: "streamEvent" | "text" | "error" | "abort",
    listener: (() => void) | ((delta: string) => void) | ((error: unknown) => void),
  ): this {
    if (event === "text") this.textListeners.push(listener as (delta: string) => void);
    if (event === "error") this.errorListeners.push(listener as (error: unknown) => void);
    return this;
  }

  async finalMessage(): Promise<Anthropic.Message> {
    for (const delta of this.script.deltas ?? []) {
      for (const listener of this.textListeners) listener(delta);
    }
    if (this.script.failure) {
      queueMicrotask(() => {
        for (const listener of this.errorListeners) listener(this.script.failure);
      });
      return new Promise<never>(() => undefined);
    }
    if (this.script.pending) return new Promise<never>(() => undefined);
    return this.script.response ?? response("end_turn", [text("ok")]);
  }
}

function scriptedClient(...scripts: StreamScript[]): ScriptedClient {
  const requests: RunTurnModelRequest[] = [];
  const aborts: ReturnType<typeof vi.fn>[] = [];
  let cursor = 0;
  const client: RunTurnClient = {
    messages: {
      stream(request) {
        const script = scripts[cursor];
        if (!script) throw new Error("unexpected model request " + (cursor + 1));
        cursor += 1;
        requests.push({ ...request, messages: request.messages.slice(), tools: request.tools.slice() });
        const stream = new FakeMessageStream(script);
        aborts.push(stream.abort);
        return stream;
      },
    },
  };
  return { client, requests, aborts };
}

function userHistory(content = "你好"): Anthropic.MessageParam[] {
  return [{ role: "user", content }];
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("runTurn 的模型输出", () => {
  it("逐段转发文本，并用最终消息与 usage 作为返回值", async () => {
    const fixture = scriptedClient({
      deltas: ["你", "好"],
      response: response("end_turn", [text("你好")], 7, 2),
    });
    const onText = vi.fn();

    const result = await runTurn({
      client: fixture.client,
      model: "glm-5.2",
      history: userHistory(),
      onText,
    });

    expect(onText.mock.calls).toEqual([["你"], ["好"]]);
    expect(result).toMatchObject({
      text: "你好",
      toolCalls: 0,
      stoppedByMaxIterations: false,
      usage: { inputTokens: 7, outputTokens: 2 },
    });
    expect(result.messages).toHaveLength(2);
  });

  it("兼容只在最终消息里给文本、没有 text 事件的网关", async () => {
    const fixture = scriptedClient({ response: response("end_turn", [text("最终正文")]) });
    const onText = vi.fn();

    const result = await runTurn({
      client: fixture.client,
      model: "glm-5.2",
      history: userHistory(),
      onText,
    });

    expect(result.text).toBe("最终正文");
    expect(onText).toHaveBeenCalledOnce();
    expect(onText).toHaveBeenCalledWith("最终正文");
  });

  it("最终消息补齐流事件漏掉的尾巴时，只增发缺失部分", async () => {
    const fixture = scriptedClient({
      deltas: ["第一段"],
      response: response("end_turn", [text("第一段第二段")]),
    });
    const onText = vi.fn();

    const result = await runTurn({
      client: fixture.client,
      model: "glm-5.2",
      history: userHistory(),
      onText,
    });

    expect(result.text).toBe("第一段第二段");
    expect(onText.mock.calls).toEqual([["第一段"], ["第二段"]]);
  });

  it("最终消息为空时采用已经收到的流式文本", async () => {
    const fixture = scriptedClient({
      deltas: ["流式", "正文"],
      response: response("end_turn", [], 3, 8),
    });

    const result = await runTurn({
      client: fixture.client,
      model: "glm-5.2",
      history: userHistory(),
    });

    expect(result.text).toBe("流式正文");
    expect(result.usage.outputTokens).toBe(8);
  });

  it("流与最终消息都没有文本时抛类型化错误", async () => {
    const fixture = scriptedClient({ response: response("end_turn", []) });

    await expect(
      runTurn({
        client: fixture.client,
        model: "glm-5.2",
        history: userHistory(),
      }),
    ).rejects.toBeInstanceOf(ChatModelEmptyResponseError);
  });
});

describe("runTurn 的自动续写", () => {
  it("在 max_tokens 后追加续写提示，并合并文本与 token 用量", async () => {
    const fixture = scriptedClient(
      { deltas: ["上半"], response: response("max_tokens", [text("上半")], 10, 100) },
      { deltas: ["下半"], response: response("end_turn", [text("下半")], 5, 20) },
    );

    const result = await runTurn({
      client: fixture.client,
      model: "glm-5.2",
      history: userHistory("写长文"),
      maxContinuations: 1,
    });

    expect(result.text).toBe("上半下半");
    expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 120 });
    const secondRequest = fixture.requests[1];
    expect(secondRequest?.messages.at(-1)).toEqual({
      role: "user",
      content: expect.stringContaining("继续"),
    });
  });

  it("续写次数达到上限后保留已生成正文，不再发请求", async () => {
    const fixture = scriptedClient({
      deltas: ["被截断的正文"],
      response: response("max_tokens", [text("被截断的正文")]),
    });

    const result = await runTurn({
      client: fixture.client,
      model: "glm-5.2",
      history: userHistory(),
      maxContinuations: 0,
    });

    expect(result.text).toBe("被截断的正文");
    expect(fixture.requests).toHaveLength(1);
  });

  it("工具前说明被清除时恢复此前已确认的续写正文", async () => {
    const fixture = scriptedClient(
      { deltas: ["第一段"], response: response("max_tokens", [text("第一段")]) },
      {
        deltas: ["我先查一下"],
        response: response("tool_use", [text("我先查一下"), toolUse("tool-1")]),
      },
      { deltas: ["第二段"], response: response("end_turn", [text("第二段")]) },
    );
    const visible: string[] = [];
    const onResetText = vi.fn(() => visible.splice(0));

    const result = await runTurn({
      client: fixture.client,
      model: "glm-5.2",
      history: userHistory(),
      maxContinuations: 2,
      execTool: async () => "2026-09-07T00:00:00.000Z",
      onText: (delta) => visible.push(delta),
      onResetText,
    });

    expect(result.text).toBe("第一段第二段");
    expect(visible.join("")).toBe(result.text);
    expect(onResetText).toHaveBeenCalledOnce();
  });
});

describe("runTurn 的工具循环", () => {
  it("把工具结果回灌给下一次模型请求", async () => {
    const fixture = scriptedClient(
      { response: response("tool_use", [toolUse("time-1")]) },
      { deltas: ["查到了"], response: response("end_turn", [text("查到了")]) },
    );

    const result = await runTurn({
      client: fixture.client,
      model: "glm-5.2",
      history: userHistory("几点了"),
      execTool: async () => "2026-09-07T00:00:00.000Z",
    });

    expect(result.toolCalls).toBe(1);
    expect(result.text).toBe("查到了");
    expect(fixture.requests[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "time-1",
          content: "2026-09-07T00:00:00.000Z",
        },
      ],
    });
  });

  it("附加工具覆盖同名内置定义，同时保留其他内置工具", async () => {
    const fixture = scriptedClient({ response: response("end_turn", [text("ok")]) });

    await runTurn({
      client: fixture.client,
      model: "glm-5.2",
      history: userHistory(),
      tools: [
        {
          name: "get_time",
          description: "自定义时钟",
          input_schema: { type: "object", properties: {} },
        },
        {
          name: "list_files",
          description: "列出文件",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });

    expect(fixture.requests[0]?.tools).toEqual([
      expect.objectContaining({ name: "get_time", description: "自定义时钟" }),
      expect.objectContaining({ name: "list_files" }),
    ]);
  });

  it("逐个报告工具开始与完成，并保持响应顺序", async () => {
    const fixture = scriptedClient(
      { response: response("tool_use", [toolUse("a", "first"), toolUse("b", "second")]) },
      { response: response("end_turn", [text("完成")]) },
    );
    const onTool = vi.fn();

    const result = await runTurn({
      client: fixture.client,
      model: "glm-5.2",
      history: userHistory(),
      execTool: async (name) => name + "-result",
      onTool,
    });

    expect(result.toolCalls).toBe(2);
    expect(onTool).toHaveBeenCalledTimes(4);
    expect(onTool.mock.calls.map(([event]) => [event.name, event.status])).toEqual([
      ["first", "started"],
      ["first", "completed"],
      ["second", "started"],
      ["second", "completed"],
    ]);
  });

  it("工具返回约定失败文本时上报失败，但仍把文本交给模型", async () => {
    const fixture = scriptedClient(
      { response: response("tool_use", [toolUse("broken")]) },
      { response: response("end_turn", [text("已说明失败")]) },
    );
    const onTool = vi.fn();
    const failure = "[工具执行失败: CONNECTION_LOST] 结果未知";

    const result = await runTurn({
      client: fixture.client,
      model: "glm-5.2",
      history: userHistory(),
      execTool: async () => failure,
      onTool,
    });

    expect(result.text).toBe("已说明失败");
    expect(onTool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "broken",
        status: "failed",
        output: failure,
        error: failure,
      }),
    );
  });

  it("工具执行抛错时上报失败并停止本轮", async () => {
    const fixture = scriptedClient({ response: response("tool_use", [toolUse("broken")]) });
    const onTool = vi.fn();

    await expect(
      runTurn({
        client: fixture.client,
        model: "glm-5.2",
        history: userHistory(),
        execTool: async () => {
          throw new Error("disk offline");
        },
        onTool,
      }),
    ).rejects.toThrow("disk offline");
    expect(onTool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "broken",
        status: "failed",
        error: "disk offline",
      }),
    );
  });

  it("达到迭代上限时执行最后一轮工具并返回明确状态", async () => {
    const fixture = scriptedClient(
      { response: response("tool_use", [toolUse("one")]) },
      { response: response("tool_use", [toolUse("two")]) },
    );

    const result = await runTurn({
      client: fixture.client,
      model: "glm-5.2",
      history: userHistory(),
      execTool: async () => "ok",
      maxIterations: 2,
    });

    expect(result).toMatchObject({ text: "", toolCalls: 2, stoppedByMaxIterations: true });
    expect(result.messages.at(-1)).toMatchObject({ role: "user" });
  });

  it("默认上限允许连续九轮工具调用", async () => {
    const scripts: StreamScript[] = Array.from({ length: 9 }, (_, index) => ({
      response: response("tool_use", [toolUse("tool-" + index)]),
    }));
    scripts.push({ response: response("end_turn", [text("任务完成")]) });
    const fixture = scriptedClient(...scripts);

    const result = await runTurn({
      client: fixture.client,
      model: "glm-5.2",
      history: userHistory(),
      execTool: async () => "ok",
    });

    expect(result).toMatchObject({
      text: "任务完成",
      toolCalls: 9,
      stoppedByMaxIterations: false,
    });
  });

  it("工具轮的流式说明不会混进最终答复", async () => {
    const fixture = scriptedClient(
      {
        deltas: ["正在检查"],
        response: response("tool_use", [text("正在检查"), toolUse("inspect")]),
      },
      { deltas: ["检查完成"], response: response("end_turn", [text("检查完成")]) },
    );
    const visible: string[] = [];
    const onResetText = vi.fn(() => visible.splice(0));

    const result = await runTurn({
      client: fixture.client,
      model: "glm-5.2",
      history: userHistory(),
      execTool: async () => "ok",
      onText: (delta) => visible.push(delta),
      onResetText,
    });

    expect(result.text).toBe("检查完成");
    expect(visible.join("")).toBe("检查完成");
    expect(onResetText).toHaveBeenCalledOnce();
  });
});

describe("runTurn 的流保护", () => {
  it("空闲超时会中止当前流", async () => {
    vi.useFakeTimers();
    const fixture = scriptedClient({ pending: true });
    const pending = runTurn({
      client: fixture.client,
      model: "glm-5.2",
      history: userHistory(),
      streamIdleTimeoutMs: 20,
      streamTotalTimeoutMs: 1_000,
      streamMaxRetries: 0,
    });

    const rejected = expect(pending).rejects.toBeInstanceOf(ChatModelStreamTimeoutError);
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(fixture.aborts[0]).toHaveBeenCalledOnce();
  });

  it("总时长超时独立于空闲超时", async () => {
    vi.useFakeTimers();
    const fixture = scriptedClient({ pending: true });
    const pending = runTurn({
      client: fixture.client,
      model: "glm-5.2",
      history: userHistory(),
      streamIdleTimeoutMs: 1_000,
      streamTotalTimeoutMs: 20,
      streamMaxRetries: 0,
    });

    const rejected = expect(pending).rejects.toMatchObject({
      message: "CHAT_MODEL_STREAM_TOTAL_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(fixture.aborts[0]).toHaveBeenCalledOnce();
  });

  it("失败后重试，并在清除半截文本后恢复既有正文", async () => {
    const fixture = scriptedClient(
      { deltas: ["已确认"], response: response("max_tokens", [text("已确认")]) },
      { deltas: ["半截"], failure: new Error("bad stream") },
      { deltas: ["补完"], response: response("end_turn", [text("补完")]) },
    );
    const visible: string[] = [];
    const onResetText = vi.fn(() => visible.splice(0));

    const result = await runTurn({
      client: fixture.client,
      model: "glm-5.2",
      history: userHistory(),
      maxContinuations: 1,
      streamMaxRetries: 1,
      onText: (delta) => visible.push(delta),
      onResetText,
    });

    expect(result.text).toBe("已确认补完");
    expect(visible.join("")).toBe(result.text);
    expect(fixture.requests).toHaveLength(3);
    expect(fixture.aborts[1]).toHaveBeenCalledOnce();
  });

  it("重试次数耗尽后透传最后一次错误", async () => {
    const fixture = scriptedClient({ failure: new Error("first") }, { failure: new Error("second") });

    await expect(
      runTurn({
        client: fixture.client,
        model: "glm-5.2",
        history: userHistory(),
        streamMaxRetries: 1,
      }),
    ).rejects.toThrow("second");
    expect(fixture.requests).toHaveLength(2);
  });
});

describe("输出 token 预算", () => {
  it("初始预扣只覆盖第一次模型请求", () => {
    expect(chatInitialReserveOutputTokens({ maxOutputTokens: 100 })).toBe(100);
  });

  it("最大预算覆盖第一次请求和全部续写", () => {
    expect(chatMaxOutputTokenBudget({ maxOutputTokens: 100, maxContinuations: 2 })).toBe(300);
  });

  it("环境变量非法时使用默认值，合法小数向下取整", () => {
    vi.stubEnv("CHAT_MAX_OUTPUT_TOKENS", "12.9");
    vi.stubEnv("CHAT_MAX_CONTINUATIONS", "bad");
    expect(chatInitialReserveOutputTokens()).toBe(12);
    expect(chatMaxOutputTokenBudget()).toBe(12 * 21);
  });
});

describe("服务端内置工具", () => {
  it("get_time 返回当前 UTC ISO 时间", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T03:04:05.000Z"));
    await expect(executeBuiltinTool("get_time", {})).resolves.toBe("2026-09-07T03:04:05.000Z");
  });

  it("未知名称返回可供模型理解的错误文本", async () => {
    await expect(executeBuiltinTool("missing", null)).resolves.toBe("未知工具: missing");
  });
});
