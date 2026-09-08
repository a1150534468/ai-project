import type Anthropic from "@anthropic-ai/sdk";
import { isObjectLike } from "../runtime/records.js";
import { MEMORY_TYPES, type MemoryType } from "./memory-types.js";

export type ExistingMemory = {
  id: string;
  title?: string;
  text: string;
  type?: MemoryType | string;
  tags?: string[];
};

type OptionalMemoryFields = {
  title?: string;
  type?: MemoryType | string;
  importance?: number;
  tags?: string[];
};

export type MemoryAction =
  | ({ event: "ADD"; text: string } & OptionalMemoryFields)
  | ({ event: "UPDATE"; id: string; text: string } & OptionalMemoryFields)
  | { event: "DELETE"; id: string }
  | { event: "NONE"; text?: string };

export type MemoryExtractionFailure = "request" | "stop" | "framing" | "schema";
export type MemoryExtractionLogger = (reason: MemoryExtractionFailure) => void;

const MAX_ACTIONS = 6;
const EXTRACTION_OUTPUT_TOKENS = 512;
const EVENT_NAMES: ReadonlySet<string> = new Set(["ADD", "UPDATE", "DELETE", "NONE"]);
const TYPE_NAMES: ReadonlySet<string> = new Set(MEMORY_TYPES);
const noopLogger: MemoryExtractionLogger = () => {};

type ActionEvent = MemoryAction["event"];

function optionalText(candidate: unknown): string | undefined {
  if (typeof candidate !== "string") return;
  const trimmed = candidate.trim();
  if (trimmed) return trimmed;
}

function optionalTags(candidate: unknown): string[] | undefined {
  if (!Array.isArray(candidate)) return;
  const result: string[] = [];
  for (const entry of candidate) {
    if (typeof entry !== "string") return;
    const tag = entry.trim();
    if (tag) result.push(tag);
  }
  return result;
}

function optionalType(candidate: unknown): MemoryType | undefined {
  return typeof candidate === "string" && TYPE_NAMES.has(candidate)
    ? (candidate as MemoryType)
    : undefined;
}

function eventName(candidate: unknown): ActionEvent | null {
  if (typeof candidate !== "string") return null;
  const name = candidate.toUpperCase();
  return EVENT_NAMES.has(name) ? (name as ActionEvent) : null;
}

function optionalFields(source: Record<string, unknown>): OptionalMemoryFields {
  const result: OptionalMemoryFields = {};
  const title = optionalText(source.title);
  const type = optionalType(source.type);
  const tags = optionalTags(source.tags);
  if (title) result.title = title;
  if (type) result.type = type;
  if (typeof source.importance === "number" && Number.isFinite(source.importance)) {
    result.importance = source.importance;
  }
  if (tags) result.tags = tags;
  return result;
}

/** 找 JSON 数组的完整边界；字符串里的括号和反斜杠转义不参与深度。 */
function framedArrays(text: string): string[] {
  const arrays: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let cursor = 0; cursor < text.length; cursor++) {
    const character = text[cursor];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "[") {
      if (depth === 0) start = cursor;
      depth += 1;
    } else if (character === "]" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        arrays.push(text.slice(start, cursor + 1));
        start = -1;
      }
    }
  }
  return arrays;
}

function uniqueJsonArray(text: string): unknown[] | null {
  const valid: unknown[][] = [];
  for (const frame of framedArrays(text)) {
    try {
      const decoded: unknown = JSON.parse(frame);
      if (Array.isArray(decoded)) valid.push(decoded);
    } catch {
      // 一个坏候选不妨碍后面唯一的合法数组；两个合法数组才算歧义。
    }
  }
  return valid.length === 1 ? valid[0] : null;
}

function parseOne(item: unknown, allowedIds?: ReadonlySet<string>): MemoryAction | null {
  if (typeof item === "string") {
    const text = optionalText(item);
    return text ? { event: "ADD", text } : null;
  }
  if (!isObjectLike(item)) return null;

  const event = eventName(item.event);
  if (event === "NONE") return { event };
  if (event === "ADD") {
    const text = optionalText(item.text);
    return text ? { event, text, ...optionalFields(item) } : null;
  }

  const id = optionalText(item.id);
  if (!id || (allowedIds && !allowedIds.has(id))) return null;
  if (event === "DELETE") return { event, id };
  if (event === "UPDATE") {
    const text = optionalText(item.text);
    return text ? { event, id, text, ...optionalFields(item) } : null;
  }
  return null;
}

function parseActions(items: readonly unknown[], allowedIds?: ReadonlySet<string>): MemoryAction[] {
  const result: MemoryAction[] = [];
  for (const item of items) {
    const action = parseOne(item, allowedIds);
    if (action) result.push(action);
    if (result.length === MAX_ACTIONS) break;
  }
  return result;
}

function extractionPrompt(
  userMessage: string,
  assistantMessage: string,
  visibleMemories: readonly ExistingMemory[],
): string {
  const catalog = JSON.stringify(visibleMemories, null, 2);
  return `你负责从中文对话中维护可跨会话复用的用户记忆。
阅读本轮用户与助手消息，并给出需要应用到长期记忆库的变更。
仅提取之后仍可能有用的稳定事实：偏好、身份背景、长期约束、持续中的工作或项目，以及可复用的领域信息。
忽略礼貌用语、只与当前回合有关的安排或上下文，也不要把助手陈述当作用户事实。
若用户更正、否认或更新已有事实，请针对原 id 生成 UPDATE；若事实已失效且无替代内容则生成 DELETE。不要为同一事实再建一条 ADD。

响应必须仅包含一个 JSON 数组；数组之外不得出现说明、Markdown 标记或代码围栏。
event 取值限定为 ADD、UPDATE、DELETE、NONE；type 取值限定为 CORE、PERMANENT、TEMPORARY、KNOWLEDGE、OTHER。
UPDATE 与 DELETE 的 id 只能从下方已有记忆中选择。动作数不得超过 ${MAX_ACTIONS}。
新增示例：{"event":"ADD","title":"回复偏好","text":"用户希望回答简洁","type":"PERMANENT","importance":75,"tags":["沟通"]}
修改示例：{"event":"UPDATE","id":"known_id","title":"当前职业","text":"用户现在从事后端开发","type":"CORE","importance":85,"tags":["职业"]}
删除示例：{"event":"DELETE","id":"known_id"}
无需变更时：[{"event":"NONE"}]

<existing_memories>
${catalog}
</existing_memories>
<user_message>
${userMessage}
</user_message>
<assistant_message>
${assistantMessage}
</assistant_message>`;
}

function failure(logger: MemoryExtractionLogger, reason: MemoryExtractionFailure): MemoryAction[] {
  logger(reason);
  return [];
}

export async function extractMemoryActions(
  client: Anthropic,
  model: string,
  user: string,
  assistant: string,
  existingMemories: readonly ExistingMemory[],
  onFailure: MemoryExtractionLogger = noopLogger,
): Promise<MemoryAction[]> {
  const visible = existingMemories.slice(0, 30);
  let response: Awaited<ReturnType<Anthropic["messages"]["create"]>>;
  try {
    response = await client.messages.create({
      model,
      max_tokens: EXTRACTION_OUTPUT_TOKENS,
      messages: [{ role: "user", content: extractionPrompt(user, assistant, visible) }],
    });
  } catch {
    return failure(onFailure, "request");
  }

  if (!("content" in response) || (response.stop_reason !== "end_turn" && response.stop_reason !== null)) {
    return failure(onFailure, "stop");
  }
  const text = response.content.reduce(
    (combined, block) => (block.type === "text" ? combined + block.text : combined),
    "",
  );
  const decoded = uniqueJsonArray(text);
  if (!decoded) return failure(onFailure, "framing");

  const actions = parseActions(decoded, new Set(visible.map((memory) => memory.id)));
  if (decoded.length > 0 && actions.length === 0) onFailure("schema");
  return actions;
}

export async function extractFacts(
  client: Anthropic,
  model: string,
  user: string,
  assistant: string,
): Promise<string[]> {
  const actions = await extractMemoryActions(client, model, user, assistant, []);
  return actions
    .filter((action): action is Extract<MemoryAction, { event: "ADD" }> => action.event === "ADD")
    .map((action) => action.text);
}
