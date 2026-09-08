import type Anthropic from "@anthropic-ai/sdk";
import { embed, type EmbeddingConfig } from "./embedding-client.js";
import {
  extractMemoryActions,
  type MemoryAction,
} from "./fact-extractor.js";
import {
  listMemory,
  queryMemory,
  type MemoryHit,
  type MemorySnapshot,
  withUserMemoryTransaction,
} from "./memory-store.js";
import { mergeMemoryUpdate, sanitizeMemoryShape } from "./memory-types.js";

const THRESHOLD = 0.3;
const DEDUP = 0.95;
const DEDUP_TOPK = 5;
const SEARCH_TIMEOUT_MS = 3000;

function normalizeFact(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s,.;:!?，。；：！？、"'“”‘’()[\]{}【】（）]/g, "")
    .replace(/^(用户|本人|我|咱|俺)(的)?/, "")
    .replace(/^(职业|岗位|职位|身份|工作)(是|为)?/, "")
    .replace(/^(是|为)?(一名|一个|一位|位|名)/, "")
    .replace(/^(是|为)/, "");
}

function isEquivalentFact(a: string, b: string): boolean {
  const left = normalizeFact(a);
  const right = normalizeFact(b);
  return left.length > 0 && left === right;
}

function factCategory(text: string): "career" | null {
  const normalized = normalizeFact(text);
  if (
    /职业|岗位|职位|工作|转行|全职|兼职|失业|离职|在职|求职|前端|后端|工程师|开发工程师|产品经理|运营|设计师/.test(
      normalized,
    )
  ) {
    return "career";
  }
  return null;
}

function isValuableMemory(text: string): boolean {
  const trimmed = text.normalize("NFKC").trim();
  if (trimmed.length < 3) return false;
  if (/^(你好|您好|谢谢|多谢|好的|好|ok|嗯|哈哈|再见|拜拜)[。.!！]*$/i.test(trimmed)) {
    return false;
  }
  if (/^(用户)?(询问|问|想知道|需要帮助|请求|要求|让助手)/.test(trimmed)) {
    return false;
  }
  if (/请提供更多信息|有什么我可以帮|随时告诉我|可以随时问/i.test(trimmed)) {
    return false;
  }

  if (
    /喜欢|偏好|希望|默认|习惯|正在|项目|产品|公司|职业|岗位|职位|身份|工作|目标|计划|长期|使用|常用|技术栈|住在|来自|姓名|叫|生日|联系方式|语言|回复|风格|约束|预算|禁用|不要|转行|全职|兼职|失业|离职|在职|求职|学习|研究|维护|开发|部署|服务器|域名|知识库|系统/.test(
      trimmed,
    )
  ) {
    return true;
  }

  return trimmed.length >= 8 && !/[?？]$/.test(trimmed);
}

function logAddTurnFailure(error: unknown): void {
  console.error("[memory] addTurn failed", error);
}

function logActionFailure(action: MemoryAction, error: unknown): void {
  console.error("[memory] addTurn action failed", action, error);
}

function isDeduped(hit: MemoryHit): boolean {
  return hit.score > DEDUP;
}

function supersededIds(
  memories: readonly MemorySnapshot[],
  fact: string,
  exceptId?: string,
): string[] {
  const category = factCategory(fact);
  if (!category) return [];
  return memories
    .filter(
      (memory) =>
        memory.id !== exceptId
        && factCategory(memory.text) === category
        && !isEquivalentFact(fact, memory.text),
    )
    .map((memory) => memory.id);
}

export async function search(
  cfg: EmbeddingConfig,
  userId: string,
  query: string,
  topK = 5,
  precomputedVector?: number[],
): Promise<MemoryHit[]> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = async () => {
      const vector = precomputedVector
        ?? (await embed(cfg, query, fetch, controller.signal)).vector;
      const hits = await queryMemory(userId, vector, topK);
      return hits.filter((hit) => hit.score >= THRESHOLD);
    };
    return await Promise.race([
      work(),
      new Promise<MemoryHit[]>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("memory search timeout"));
        }, SEARCH_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function addTurn(
  cfg: EmbeddingConfig,
  client: Anthropic,
  extractModel: string,
  userId: string,
  user: string,
  assistant: string,
  metadata: unknown,
): Promise<void> {
  let actions: MemoryAction[];
  let preview: Awaited<ReturnType<typeof listMemory>>;

  try {
    preview = await listMemory(userId);
    actions = await extractMemoryActions(
      client,
      extractModel,
      user,
      assistant,
      preview,
      (reason) => console.error("[memory] extraction failed", reason),
    );
  } catch (error) {
    logAddTurnFailure(error);
    return;
  }

  const insertedInTurn = new Set<string>();
  for (const action of actions) {
    try {
      switch (action.event) {
        case "ADD": {
          const shape = sanitizeMemoryShape(action);
          if (!shape || !isValuableMemory(shape.text)) continue;
          const normalized = normalizeFact(shape.text);
          if (normalized && insertedInTurn.has(normalized)) continue;

          const result = await embed(cfg, shape.text);
          const inserted = await withUserMemoryTransaction(userId, async (store) => {
            // 锁要在复查之前拿：两个并发回合都在锁外判「没有重复」仍会各插一条。
            const near = await store.query(result.vector, DEDUP_TOPK);
            const category = factCategory(shape.text);
            const duplicate = near.some(
              (hit) =>
                isEquivalentFact(shape.text, hit.text)
                || (isDeduped(hit) && (!category || factCategory(hit.text) !== category)),
            );
            if (duplicate) return false;

            const current = await store.list();
            // 先插后删也好、先删后插也好，关键是二者必须在同一事务；任一步失败全部回滚。
            await store.insert(shape, result.vector, metadata);
            await store.deleteMany(supersededIds(current, shape.text));
            return true;
          });
          if (inserted && normalized) insertedInTurn.add(normalized);
          break;
        }
        case "UPDATE": {
          const expected = preview.find((memory) => memory.id === action.id);
          if (!expected) continue;
          const shape = mergeMemoryUpdate(expected, action);
          if (!shape || !isValuableMemory(shape.text)) continue;
          const result = await embed(cfg, shape.text);

          await withUserMemoryTransaction(userId, async (store) => {
            const updated = await store.update(action.id, expected, shape, result.vector, metadata);
            if (updated.kind !== "updated") return;
            const current = await store.list();
            await store.deleteMany(supersededIds(current, shape.text, action.id));
          });
          break;
        }
        case "DELETE": {
          const expected = preview.find((memory) => memory.id === action.id);
          if (!expected) continue;
          await withUserMemoryTransaction(userId, (store) => store.delete(action.id, expected));
          break;
        }
        case "NONE":
          break;
      }
    } catch (error) {
      logActionFailure(action, error);
    }
  }
}
