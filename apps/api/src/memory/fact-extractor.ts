import type Anthropic from "@anthropic-ai/sdk";
import { isObjectLike } from "../runtime/records.js";
import { MEMORY_TYPES, type MemoryType } from "./memory-types.js";

export interface ExistingMemory {
  id: string;
  title?: string;
  text: string;
  type?: MemoryType | string;
  tags?: string[];
}

export type MemoryAction =
  | {
      event: "ADD";
      title?: string;
      text: string;
      type?: MemoryType | string;
      importance?: number;
      tags?: string[];
    }
  | {
      event: "UPDATE";
      id: string;
      title?: string;
      text: string;
      type?: MemoryType | string;
      importance?: number;
      tags?: string[];
    }
  | {
      event: "DELETE";
      id: string;
    }
  | {
      event: "NONE";
      text?: string;
    };

const ACTION_EVENTS = ["ADD", "UPDATE", "DELETE", "NONE"] as const;
type ActionEvent = (typeof ACTION_EVENTS)[number];

function isTextBlock(
  block: Anthropic.Messages.RawMessageStreamEvent | Anthropic.TextBlock | Anthropic.ContentBlock,
): block is Anthropic.TextBlock {
  return block.type === "text";
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return undefined;
  }

  const tags = value
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return tags.length > 0 ? tags : [];
}

function readImportance(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readMemoryType(value: unknown): MemoryType | undefined {
  if (typeof value !== "string") return undefined;

  return MEMORY_TYPES.find((item) => item === value);
}

function normalizeEvent(value: unknown): ActionEvent | null {
  if (typeof value !== "string") return null;

  const upper = value.toUpperCase();
  return ACTION_EVENTS.find((item) => item === upper) ?? null;
}

function appendSharedFields(
  action:
    | Extract<MemoryAction, { event: "ADD" }>
    | Extract<MemoryAction, { event: "UPDATE" }>,
  input: Record<string, unknown>,
): void {
  const title = readTrimmedString(input.title);
  if (title) {
    action.title = title;
  }

  const type = readMemoryType(input.type);
  if (type) {
    action.type = type;
  }

  const importance = readImportance(input.importance);
  if (importance !== undefined) {
    action.importance = importance;
  }

  const tags = readTags(input.tags);
  if (tags !== undefined) {
    action.tags = tags;
  }
}

export type MemoryExtractionFailure = "request" | "stop" | "framing" | "schema";

export type MemoryExtractionLogger = (reason: MemoryExtractionFailure) => void;

const ignoreExtractionFailure: MemoryExtractionLogger = () => {};

/**
 * 模型偶尔会在 JSON 前后多说一句。不能用 `/\[[\s\S]*\]/` 贪婪吞：两段数组会粘成一段坏 JSON，
 * 字符串里的 `]` 也不是边界。这里逐字符找平衡数组，完整尊重 JSON 字符串和反斜杠转义。
 */
function framedArrays(text: string): string[] {
  const arrays: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "[") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "]" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        arrays.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return arrays;
}

function parseJsonArray(text: string): unknown[] | null {
  const parsed = framedArrays(text).flatMap((candidate) => {
    try {
      const value: unknown = JSON.parse(candidate);
      return Array.isArray(value) ? [value] : [];
    } catch {
      return [];
    }
  });
  return parsed.length === 1 ? parsed[0] : null;
}

function parseActions(items: readonly unknown[], allowedIds?: ReadonlySet<string>): MemoryAction[] {
  const actions: MemoryAction[] = [];

  for (const item of items) {
    if (actions.length >= 6) break;

    if (typeof item === "string") {
      const text = readTrimmedString(item);
      if (text) {
        actions.push({ event: "ADD", text });
      }
      continue;
    }

    if (!isObjectLike(item)) {
      continue;
    }

    const event = normalizeEvent(item.event);
    if (!event) {
      continue;
    }

    switch (event) {
      case "ADD": {
        const text = readTrimmedString(item.text);
        if (!text) {
          continue;
        }

        const action: Extract<MemoryAction, { event: "ADD" }> = {
          event: "ADD",
          text,
        };
        appendSharedFields(action, item);
        actions.push(action);
        break;
      }
      case "UPDATE": {
        const id = readTrimmedString(item.id);
        const text = readTrimmedString(item.text);
        if (!id || !text || (allowedIds && !allowedIds.has(id))) {
          continue;
        }

        const action: Extract<MemoryAction, { event: "UPDATE" }> = {
          event: "UPDATE",
          id,
          text,
        };
        appendSharedFields(action, item);
        actions.push(action);
        break;
      }
      case "DELETE": {
        const id = readTrimmedString(item.id);
        if (!id || (allowedIds && !allowedIds.has(id))) {
          continue;
        }

        actions.push({
          event: "DELETE",
          id,
        });
        break;
      }
      case "NONE":
        actions.push({ event: "NONE" });
        break;
    }
  }

  return actions;
}

function buildPrompt(
  user: string,
  assistant: string,
  existingMemories: readonly ExistingMemory[],
): string {
  const memoryPreview = JSON.stringify(existingMemories, null, 2);

  return [
    "你是中文长期记忆管理员。",
    "请根据下面这一轮对话，决定是否要对长期记忆执行动作。",
    "只保留对未来回合长期有价值的信息，例如稳定偏好、持续项目、身份背景、长期约束、领域知识。",
    "不要保存寒暄、一次性安排、短期上下文、助手自己的话。",
    "如果新信息与已有记忆冲突、状态发生变化、用户否认旧事实，必须优先 UPDATE 或 DELETE 对应 id，不要重复 ADD。",
    "只输出 JSON 数组，不要解释，不要 Markdown，不要代码块。",
    "动作只能使用 ADD、UPDATE、DELETE、NONE。",
    "type 只能使用 CORE、PERMANENT、TEMPORARY、KNOWLEDGE、OTHER。",
    "UPDATE 和 DELETE 必须使用已有记忆中的 id。",
    "最多输出 6 条动作。",
    'ADD 示例：{"event":"ADD","title":"项目","text":"用户正在做某项目","type":"CORE","importance":90,"tags":["项目"]}',
    'UPDATE 示例：{"event":"UPDATE","id":"memory_id","title":"新标题","text":"更新后的长期信息","type":"PERMANENT","importance":80,"tags":["更新"]}',
    'DELETE 示例：{"event":"DELETE","id":"memory_id"}',
    'NONE 示例：[{"event":"NONE"}]',
    "",
    "已有记忆（最多 30 条）：",
    memoryPreview,
    "",
    `用户：${user}`,
    `助手：${assistant}`,
  ].join("\n");
}

export async function extractMemoryActions(
  client: Anthropic,
  model: string,
  user: string,
  assistant: string,
  existingMemories: readonly ExistingMemory[],
  onFailure: MemoryExtractionLogger = ignoreExtractionFailure,
): Promise<MemoryAction[]> {
  const visibleMemories = existingMemories.slice(0, 30);
  let response: Awaited<ReturnType<Anthropic["messages"]["create"]>>;
  try {
    response = await client.messages.create({
      model,
      max_tokens: 512,
      messages: [{ role: "user", content: buildPrompt(user, assistant, visibleMemories) }],
    });
  } catch {
    onFailure("request");
    return [];
  }

  if (!("content" in response) || (response.stop_reason !== "end_turn" && response.stop_reason !== null)) {
    onFailure("stop");
    return [];
  }
  const text = response.content.filter(isTextBlock).map((block) => block.text).join("");
  const parsed = parseJsonArray(text);
  if (!parsed) {
    onFailure("framing");
    return [];
  }

  const actions = parseActions(parsed, new Set(visibleMemories.map((memory) => memory.id)));
  if (parsed.length > 0 && actions.length === 0) onFailure("schema");
  return actions;
}

export async function extractFacts(
  client: Anthropic,
  model: string,
  user: string,
  assistant: string,
): Promise<string[]> {
  const actions = await extractMemoryActions(client, model, user, assistant, []);
  return actions.flatMap((action) => (action.event === "ADD" ? [action.text] : []));
}
