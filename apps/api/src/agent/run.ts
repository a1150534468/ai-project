import type Anthropic from "@anthropic-ai/sdk";
import { builtinTools, execTool as execBuiltinTool } from "./tools.js";

export interface RunTurnArgs {
  client: RunTurnClient;
  model: string;
  history: Anthropic.MessageParam[];
  system?: string;
  onText?: (delta: string) => void;
  onResetText?: () => void;
  onTool?: (event: RunTurnToolEvent) => void;
  maxIterations?: number;
  streamIdleTimeoutMs?: number;
  streamTotalTimeoutMs?: number;
  streamMaxRetries?: number;
  maxOutputTokens?: number;
  maxContinuations?: number;
  tools?: Anthropic.Tool[];
  execTool?: (name: string, input: unknown) => Promise<string>;
}

export interface RunTurnModelRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly tools: Anthropic.Tool[];
  readonly system?: string;
  readonly messages: Anthropic.MessageParam[];
}

export interface RunTurnMessageStream {
  on(event: "streamEvent", listener: () => void): this;
  on(event: "text", listener: (delta: string) => void): this;
  on(event: "error" | "abort", listener: (error: unknown) => void): this;
  abort(): void;
  finalMessage(): Promise<Anthropic.Message>;
}

export interface RunTurnClient {
  readonly messages: {
    stream(request: RunTurnModelRequest): RunTurnMessageStream;
  };
}

export interface RunTurnResult {
  text: string;
  toolCalls: number;
  stoppedByMaxIterations: boolean;
  messages: Anthropic.MessageParam[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface RunTurnToolEvent {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly status: "started" | "completed" | "failed";
  readonly elapsedMs?: number;
  readonly output?: string;
  readonly error?: string;
}

interface RunLimits {
  readonly iterations: number;
  readonly idleTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly retries: number;
  readonly outputTokens: number;
  readonly continuations: number;
}

interface StreamAttempt {
  readonly message: Anthropic.Message;
  readonly streamedText: string;
}

interface TurnProgress {
  answer: string;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  continuationCount: number;
  stoppedByMaxIterations: boolean;
}

const DEFAULTS = Object.freeze({
  idleTimeoutMs: 60_000,
  totalTimeoutMs: 180_000,
  retries: 1,
  iterations: 256,
  outputTokens: 4096,
  continuations: 20,
});

const CONTINUE_FROM_CUTOFF =
  "请从上一条回复被截断的位置继续写，不要重复已经写过的内容，不要添加任何说明或标题，直接续写正文。";
const TOOL_FAILURE_PREFIX = "[工具执行失败:";

export class ChatModelStreamTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatModelStreamTimeoutError";
  }
}

export class ChatModelEmptyResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatModelEmptyResponseError";
  }
}

function integerFromEnv(name: string, fallback: number, allowZero: boolean): number {
  const candidate = Number(process.env[name]);
  const belowMinimum = allowZero ? candidate < 0 : candidate <= 0;
  return Number.isFinite(candidate) && !belowMinimum ? Math.floor(candidate) : fallback;
}

function limitsFor(args: RunTurnArgs): RunLimits {
  return {
    iterations: args.maxIterations ?? DEFAULTS.iterations,
    idleTimeoutMs:
      args.streamIdleTimeoutMs ?? integerFromEnv("CHAT_STREAM_IDLE_TIMEOUT_MS", DEFAULTS.idleTimeoutMs, false),
    totalTimeoutMs:
      args.streamTotalTimeoutMs ?? integerFromEnv("CHAT_STREAM_TOTAL_TIMEOUT_MS", DEFAULTS.totalTimeoutMs, false),
    retries: args.streamMaxRetries ?? integerFromEnv("CHAT_STREAM_MAX_RETRIES", DEFAULTS.retries, true),
    outputTokens: args.maxOutputTokens ?? integerFromEnv("CHAT_MAX_OUTPUT_TOKENS", DEFAULTS.outputTokens, false),
    continuations: args.maxContinuations ?? integerFromEnv("CHAT_MAX_CONTINUATIONS", DEFAULTS.continuations, true),
  };
}

function configuredOutputTokens(explicit?: number): number {
  return explicit ?? integerFromEnv("CHAT_MAX_OUTPUT_TOKENS", DEFAULTS.outputTokens, false);
}

function configuredContinuations(explicit?: number): number {
  return explicit ?? integerFromEnv("CHAT_MAX_CONTINUATIONS", DEFAULTS.continuations, true);
}

export function chatMaxOutputTokenBudget(args?: {
  readonly maxOutputTokens?: number;
  readonly maxContinuations?: number;
}): number {
  const perRequest = configuredOutputTokens(args?.maxOutputTokens);
  return perRequest * (configuredContinuations(args?.maxContinuations) + 1);
}

export function chatInitialReserveOutputTokens(args?: { readonly maxOutputTokens?: number }): number {
  return configuredOutputTokens(args?.maxOutputTokens);
}

function toolCatalog(extra: readonly Anthropic.Tool[] | undefined): Anthropic.Tool[] {
  const catalog = new Map(builtinTools.map((tool) => [tool.name, tool]));
  for (const tool of extra ?? []) catalog.set(tool.name, tool);
  return Array.from(catalog.values());
}

function textFrom(message: Anthropic.Message): string {
  return message.content.reduce((text, block) => {
    return block.type === "text" ? text + block.text : text;
  }, "");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 等待 SDK 汇总最终消息，同时独立守住两种卡死：长时间没有任何流事件，以及整条流总耗时过长。
 * SDK 自己的请求超时不能代替前者；只要中继连接还活着，请求层可能永远看不出模型已经停住。
 */
function collectStream(
  stream: RunTurnMessageStream,
  limits: Pick<RunLimits, "idleTimeoutMs" | "totalTimeoutMs">,
  onText?: (delta: string) => void,
): Promise<StreamAttempt> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let streamedText = "";
    let idleTimer: NodeJS.Timeout | undefined;
    let totalTimer: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (totalTimer !== undefined) clearTimeout(totalTimer);
    };

    const succeed = (message: Anthropic.Message) => {
      if (finished) return;
      finished = true;
      clearTimers();
      resolve({ message, streamedText });
    };

    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      clearTimers();
      stream.abort();
      reject(error);
    };

    const armIdleTimeout = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => fail(new ChatModelStreamTimeoutError("CHAT_MODEL_STREAM_IDLE_TIMEOUT")),
        limits.idleTimeoutMs,
      );
    };

    stream.on("streamEvent", armIdleTimeout);
    stream.on("text", (delta) => {
      armIdleTimeout();
      if (delta.length === 0) return;
      streamedText += delta;
      onText?.(delta);
    });
    stream.on("error", fail);
    stream.on("abort", fail);

    armIdleTimeout();
    totalTimer = setTimeout(
      () => fail(new ChatModelStreamTimeoutError("CHAT_MODEL_STREAM_TOTAL_TIMEOUT")),
      limits.totalTimeoutMs,
    );

    try {
      void stream.finalMessage().then(succeed, fail);
    } catch (error) {
      fail(error);
    }
  });
}

function replaceVisibleText(args: RunTurnArgs, replacement: string): void {
  if (!args.onResetText) return;
  args.onResetText();
  if (replacement.length > 0) args.onText?.(replacement);
}

async function nextModelMessage(
  args: RunTurnArgs,
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
  limits: RunLimits,
  acceptedText: string,
): Promise<StreamAttempt> {
  for (let attempt = 0; ; attempt += 1) {
    let emitted = "";
    const stream = args.client.messages.stream({
      model: args.model,
      max_tokens: limits.outputTokens,
      tools,
      system: args.system,
      messages,
    });

    try {
      return await collectStream(stream, limits, (delta) => {
        emitted += delta;
        args.onText?.(delta);
      });
    } catch (error) {
      if (attempt >= limits.retries) throw error;
      // reset 会删除这一轮整条助手草稿，因此续写前已经确认的正文也要立即补回。
      if (emitted.length > 0) replaceVisibleText(args, acceptedText);
    }
  }
}

/** 让前端的流式草稿与最终消息采用同一份文本，即使兼容网关漏发或改写了最后一个 delta。 */
function acceptText(progress: TurnProgress, attempt: StreamAttempt, args: RunTurnArgs): void {
  const canonical = textFrom(attempt.message) || attempt.streamedText;
  if (canonical.length === 0) return;

  if (attempt.streamedText.length === 0) {
    args.onText?.(canonical);
  } else if (canonical.startsWith(attempt.streamedText)) {
    const missingTail = canonical.slice(attempt.streamedText.length);
    if (missingTail.length > 0) args.onText?.(missingTail);
  } else if (canonical !== attempt.streamedText && args.onResetText) {
    replaceVisibleText(args, progress.answer + canonical);
  }

  progress.answer += canonical;
}

function reportToolResult(args: RunTurnArgs, tool: Anthropic.ToolUseBlock, startedAt: number, output: string): void {
  const failed = output.startsWith(TOOL_FAILURE_PREFIX);
  args.onTool?.({
    id: tool.id,
    name: tool.name,
    input: tool.input,
    status: failed ? "failed" : "completed",
    elapsedMs: Date.now() - startedAt,
    output,
    ...(failed ? { error: output } : {}),
  });
}

async function runTools(
  toolUses: readonly Anthropic.ToolUseBlock[],
  execute: (name: string, input: unknown) => Promise<string>,
  args: RunTurnArgs,
): Promise<Anthropic.ToolResultBlockParam[]> {
  const results: Anthropic.ToolResultBlockParam[] = [];

  for (const tool of toolUses) {
    const startedAt = Date.now();
    args.onTool?.({ id: tool.id, name: tool.name, input: tool.input, status: "started" });
    try {
      const output = await execute(tool.name, tool.input);
      reportToolResult(args, tool, startedAt, output);
      results.push({ type: "tool_result", tool_use_id: tool.id, content: output });
    } catch (error) {
      args.onTool?.({
        id: tool.id,
        name: tool.name,
        input: tool.input,
        status: "failed",
        elapsedMs: Date.now() - startedAt,
        error: errorText(error),
      });
      throw error;
    }
  }

  return results;
}

function finish(progress: TurnProgress, messages: Anthropic.MessageParam[]): RunTurnResult {
  if (progress.answer.trim().length === 0 && !progress.stoppedByMaxIterations) {
    throw new ChatModelEmptyResponseError("CHAT_MODEL_EMPTY_RESPONSE");
  }
  return {
    text: progress.answer,
    toolCalls: progress.toolCalls,
    stoppedByMaxIterations: progress.stoppedByMaxIterations,
    messages,
    usage: { inputTokens: progress.inputTokens, outputTokens: progress.outputTokens },
  };
}

export async function runTurn(args: RunTurnArgs): Promise<RunTurnResult> {
  const limits = limitsFor(args);
  const tools = toolCatalog(args.tools);
  const execute = args.execTool ?? execBuiltinTool;
  const messages = args.history.slice();
  const progress: TurnProgress = {
    answer: "",
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    continuationCount: 0,
    stoppedByMaxIterations: false,
  };

  for (let iteration = 0; iteration < limits.iterations; iteration += 1) {
    const attempt = await nextModelMessage(args, messages, tools, limits, progress.answer);
    const response = attempt.message;

    progress.inputTokens += response.usage?.input_tokens ?? 0;
    progress.outputTokens += response.usage?.output_tokens ?? 0;
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "max_tokens") {
      acceptText(progress, attempt, args);
      if (progress.continuationCount >= limits.continuations) break;
      progress.continuationCount += 1;
      messages.push({ role: "user", content: CONTINUE_FROM_CUTOFF });
      continue;
    }

    if (response.stop_reason !== "tool_use") {
      acceptText(progress, attempt, args);
      break;
    }

    // 工具前说明不属于最终答复。清空时把此前已经确认的续写正文恢复，避免界面与落库结果分叉。
    if (attempt.streamedText.length > 0) replaceVisibleText(args, progress.answer);
    const toolUses = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
    progress.toolCalls += toolUses.length;
    const results = await runTools(toolUses, execute, args);
    messages.push({ role: "user", content: results });

    if (iteration + 1 === limits.iterations) {
      progress.stoppedByMaxIterations = true;
    }
  }

  return finish(progress, messages);
}
