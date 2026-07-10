import type Anthropic from "@anthropic-ai/sdk";
import { builtinTools, execTool } from "./tools.js";

export interface RunTurnArgs {
  client: Anthropic;
  model: string;
  history: Anthropic.MessageParam[];
  system?: string; // 可选系统提示词（如记忆注入）
  onText?: (delta: string) => void; // 逐 token 实时回调（真流式）
  onResetText?: () => void; // 重试/工具前说明作废时，通知前端清空当前这轮已流式的文本
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

export interface RunTurnResult {
  text: string;
  toolCalls: number;
  stoppedByMaxIterations: boolean;
  messages: Anthropic.MessageParam[]; // 含本回合产生的 assistant/tool 消息
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

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_STREAM_TOTAL_TIMEOUT_MS = 180_000;
const DEFAULT_STREAM_MAX_RETRIES = 1;
const DEFAULT_MAX_ITERATIONS = 256;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_MAX_CONTINUATIONS = 20;
const CONTINUATION_PROMPT = "请从上一条回复被截断的位置继续写，不要重复已经写过的内容，不要添加任何说明或标题，直接续写正文。";

type MessageStream = ReturnType<Anthropic["messages"]["stream"]>;

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

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function streamIdleTimeoutMs(arg?: number): number {
  return arg ?? positiveInt(process.env.CHAT_STREAM_IDLE_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS);
}

function streamTotalTimeoutMs(arg?: number): number {
  return arg ?? positiveInt(process.env.CHAT_STREAM_TOTAL_TIMEOUT_MS, DEFAULT_STREAM_TOTAL_TIMEOUT_MS);
}

function streamMaxRetries(arg?: number): number {
  return arg ?? nonNegativeInt(process.env.CHAT_STREAM_MAX_RETRIES, DEFAULT_STREAM_MAX_RETRIES);
}

function mergeTools(extraTools: readonly Anthropic.Tool[] | undefined): Anthropic.Tool[] {
  const byName = new Map<string, Anthropic.Tool>();
  for (const tool of builtinTools) byName.set(tool.name, tool);
  for (const tool of extraTools ?? []) byName.set(tool.name, tool);
  return [...byName.values()];
}

function maxOutputTokens(arg?: number): number {
  return arg ?? positiveInt(process.env.CHAT_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS);
}

function maxContinuations(arg?: number): number {
  return arg ?? nonNegativeInt(process.env.CHAT_MAX_CONTINUATIONS, DEFAULT_MAX_CONTINUATIONS);
}

export function chatMaxOutputTokenBudget(args?: {
  readonly maxOutputTokens?: number;
  readonly maxContinuations?: number;
}): number {
  return maxOutputTokens(args?.maxOutputTokens) * (maxContinuations(args?.maxContinuations) + 1);
}

export function chatInitialReserveOutputTokens(args?: {
  readonly maxOutputTokens?: number;
}): number {
  return maxOutputTokens(args?.maxOutputTokens);
}

async function finalMessageWithGuards(
  stream: MessageStream,
  opts: {
    idleTimeoutMs: number;
    totalTimeoutMs: number;
    onText?: (delta: string) => void;
    onTextEmitted?: () => void;
  },
): Promise<Anthropic.Message> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let totalTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
    };

    const settleReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      stream.abort();
      reject(err);
    };

    const settleResolve = (message: Anthropic.Message) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(message);
    };

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        settleReject(new ChatModelStreamTimeoutError("CHAT_MODEL_STREAM_IDLE_TIMEOUT"));
      }, opts.idleTimeoutMs);
    };

    stream.on("streamEvent", resetIdleTimer);
    stream.on("text", (delta) => {
      resetIdleTimer();
      if (delta) {
        opts.onTextEmitted?.();
        opts.onText?.(delta);
      }
    });
    stream.on("error", settleReject);
    stream.on("abort", settleReject);

    resetIdleTimer();
    totalTimer = setTimeout(() => {
      settleReject(new ChatModelStreamTimeoutError("CHAT_MODEL_STREAM_TOTAL_TIMEOUT"));
    }, opts.totalTimeoutMs);

    void stream.finalMessage().then(settleResolve, settleReject);
  });
}

export async function runTurn(args: RunTurnArgs): Promise<RunTurnResult> {
  const { client, model, onText, onResetText, system } = args;
  const tools = mergeTools(args.tools);
  const execToolFn = args.execTool ?? execTool;
  const messages: Anthropic.MessageParam[] = [...args.history];
  const maxIterations = args.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const idleTimeoutMs = streamIdleTimeoutMs(args.streamIdleTimeoutMs);
  const totalTimeoutMs = streamTotalTimeoutMs(args.streamTotalTimeoutMs);
  const maxStreamRetries = streamMaxRetries(args.streamMaxRetries);
  const outputTokensPerCall = maxOutputTokens(args.maxOutputTokens);
  const maxContinuationTurns = maxContinuations(args.maxContinuations);
  let toolCalls = 0;
  let finalText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let stoppedByMaxIterations = false;
  let continuationTurns = 0;
  let continuationActive = false;

  for (let i = 0; i < maxIterations; i++) {
    let resp: Anthropic.Message | undefined;
    let attemptText = "";
    let attempt = 0;
    let textDeltas: string[] = [];
    while (!resp) {
      textDeltas = [];
      attemptText = "";
      const stream = client.messages.stream({
        model,
        max_tokens: outputTokensPerCall,
        tools,
        system,
        messages,
      });

      try {
        resp = await finalMessageWithGuards(stream, {
          idleTimeoutMs,
          totalTimeoutMs,
          onText: (delta) => {
            textDeltas.push(delta);
            attemptText += delta;
            onText?.(delta); // 逐 token 实时转发到 SSE
          },
        });
      } catch (err) {
        if (attempt >= maxStreamRetries) throw err;
        // 本次尝试已流式出的半截文本作废，通知前端清空后重试
        if (textDeltas.length > 0) onResetText?.();
        attempt += 1;
      }
    }

    inputTokens += resp.usage?.input_tokens ?? 0;
    outputTokens += resp.usage?.output_tokens ?? 0;
    messages.push({ role: "assistant", content: resp.content });

    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const effectiveText = text || attemptText;
    // tool_use 轮的文本只是工具调用前的说明（会被 onResetText 清掉），不计入最终答案；
    // 仅普通结束或 max_tokens 续写块才写入/累加 finalText。
    if (effectiveText && resp.stop_reason !== "tool_use") {
      finalText = continuationActive || resp.stop_reason === "max_tokens"
        ? `${finalText}${effectiveText}`
        : effectiveText;
    }

    // 输出被 max_tokens 截断：自动续写。前端已实时流式的内容保留，续写块继续往后追加。
    if (resp.stop_reason === "max_tokens") {
      if (continuationTurns >= maxContinuationTurns) break;
      continuationTurns += 1;
      continuationActive = true;
      messages.push({ role: "user", content: CONTINUATION_PROMPT });
      continue;
    }

    if (resp.stop_reason !== "tool_use") {
      // 文本已在流式回调里逐 token 实时发出；仅当没有任何 delta 但最终有文本时兜底补发一次
      if (textDeltas.length === 0 && text) onText?.(text);
      break;
    }

    // stop_reason === "tool_use"：本轮流式出的是工具调用前的说明，最终答案不含它，
    // 清掉前端已显示的这段，保持与 finalText / 入库文本一致
    if (textDeltas.length > 0) onResetText?.();

    const toolUses = resp.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      toolCalls += 1;
      const startedAt = Date.now();
      args.onTool?.({ id: tu.id, name: tu.name, input: tu.input, status: "started" });
      try {
        const r = await execToolFn(tu.name, tu.input);
        const failed = r.startsWith("[工具执行失败:");
        args.onTool?.({
          id: tu.id,
          name: tu.name,
          input: tu.input,
          status: failed ? "failed" : "completed",
          elapsedMs: Date.now() - startedAt,
          output: r,
          ...(failed ? { error: r } : {}),
        });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: r });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        args.onTool?.({
          id: tu.id,
          name: tu.name,
          input: tu.input,
          status: "failed",
          elapsedMs: Date.now() - startedAt,
          error: message,
        });
        throw error;
      }
    }
    messages.push({ role: "user", content: results });
    if (i === maxIterations - 1) {
      stoppedByMaxIterations = true;
    }
  }

  // 仅在「模型真的没给内容」时抛空响应；打满工具轮上限属正常终止（由 stoppedByMaxIterations 表达），不算空响应。
  if (!finalText.trim() && !stoppedByMaxIterations) {
    throw new ChatModelEmptyResponseError("CHAT_MODEL_EMPTY_RESPONSE");
  }

  return { text: finalText, toolCalls, stoppedByMaxIterations, messages, usage: { inputTokens, outputTokens } };
}
