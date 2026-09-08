import type Anthropic from "@anthropic-ai/sdk";
import { embed, type EmbeddingConfig } from "./embedding-client.js";
import { extractMemoryActions, type MemoryAction } from "./fact-extractor.js";
import {
  listMemory,
  queryMemory,
  type MemoryHit,
  type MemorySnapshot,
  withUserMemoryTransaction,
} from "./memory-store.js";
import { mergeMemoryUpdate, sanitizeMemoryShape } from "./memory-types.js";

const POLICY = {
  minimumSearchScore: 30 / 100,
  duplicateScoreExclusive: 95 / 100,
  duplicateCandidateLimit: 5,
  searchDeadlineMs: 3 * 1_000,
} as const;

const FACT_SEPARATORS = /[\s,.;:!?，。；：！？、"'“”‘’()[\]{}【】（）]/g;
const FACT_PREFIXES = [
  /^(用户|本人|我|咱|俺)(的)?/,
  /^(职业|岗位|职位|身份|工作)(是|为)?/,
  /^(是|为)?(一名|一个|一位|位|名)/,
  /^(是|为)/,
] as const;
const CAREER_TERMS = [
  "职业", "岗位", "职位", "工作", "转行", "全职", "兼职", "失业", "离职", "在职", "求职",
  "前端", "后端", "工程师", "开发工程师", "产品经理", "运营", "设计师",
] as const;
const LOW_VALUE_PATTERNS = [
  /^(你好|您好|谢谢|多谢|好的|好|ok|嗯|哈哈|再见|拜拜)[。.!！]*$/i,
  /^(用户)?(询问|问|想知道|需要帮助|请求|要求|让助手)/,
  /请提供更多信息|有什么我可以帮|随时告诉我|可以随时问/i,
] as const;
const DURABLE_SIGNALS = [
  "喜欢", "偏好", "希望", "默认", "习惯", "正在", "项目", "产品", "公司", "职业", "岗位", "职位",
  "身份", "工作", "目标", "计划", "长期", "使用", "常用", "技术栈", "住在", "来自", "姓名", "叫",
  "生日", "联系方式", "语言", "回复", "风格", "约束", "预算", "禁用", "不要", "转行", "全职", "兼职",
  "失业", "离职", "在职", "求职", "学习", "研究", "维护", "开发", "部署", "服务器", "域名", "知识库", "系统",
] as const;

function canonicalFactKey(raw: string): string {
  let key = raw.normalize("NFKC").trim().toLocaleLowerCase("und").replace(FACT_SEPARATORS, "");
  for (const prefix of FACT_PREFIXES) key = key.replace(prefix, "");
  return key;
}

function sameFact(candidate: string, existing: string): boolean {
  const key = canonicalFactKey(candidate);
  return key !== "" && key === canonicalFactKey(existing);
}

function isCareerFact(raw: string): boolean {
  const key = canonicalFactKey(raw);
  return CAREER_TERMS.some((term) => key.includes(term));
}

function shouldPersistFact(raw: string): boolean {
  const candidate = raw.normalize("NFKC").trim();
  if (candidate.length < 3 || LOW_VALUE_PATTERNS.some((pattern) => pattern.test(candidate))) return false;
  if (DURABLE_SIGNALS.some((signal) => candidate.includes(signal))) return true;
  const declarative = !candidate.endsWith("?") && !candidate.endsWith("？");
  return declarative && candidate.length >= 8;
}

function obsoleteCareerIds(
  memories: readonly MemorySnapshot[],
  replacementText: string,
  preserveId?: string,
): string[] {
  if (!isCareerFact(replacementText)) return [];
  return memories
    .filter((memory) =>
      memory.id !== preserveId
      && isCareerFact(memory.text)
      && !sameFact(replacementText, memory.text))
    .map((memory) => memory.id);
}

function duplicateOf(text: string, hit: MemoryHit, career: boolean): boolean {
  return sameFact(text, hit.text)
    || (hit.score > POLICY.duplicateScoreExclusive && (!career || !isCareerFact(hit.text)));
}

export async function search(
  cfg: EmbeddingConfig,
  userId: string,
  query: string,
  topK = 5,
  precomputedVector?: number[],
): Promise<MemoryHit[]> {
  const abort = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const retrieval = async () => {
      const vector = precomputedVector ?? (await embed(cfg, query, fetch, abort.signal)).vector;
      return (await queryMemory(userId, vector, topK))
        .filter((hit) => hit.score >= POLICY.minimumSearchScore);
    };
    return await Promise.race([
      retrieval(),
      new Promise<MemoryHit[]>((_, reject) => {
        timeout = setTimeout(() => {
          abort.abort();
          reject(new Error("memory search timeout"));
        }, POLICY.searchDeadlineMs);
      }),
    ]);
  } catch {
    return [];
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function applyAdd(
  cfg: EmbeddingConfig,
  userId: string,
  action: Extract<MemoryAction, { event: "ADD" }>,
  metadata: unknown,
  acceptedKeys: Set<string>,
): Promise<void> {
  const candidate = sanitizeMemoryShape(action);
  if (!candidate || !shouldPersistFact(candidate.text)) return;
  const key = canonicalFactKey(candidate.text);
  if (key && acceptedKeys.has(key)) return;
  const { vector } = await embed(cfg, candidate.text);

  const inserted = await withUserMemoryTransaction(userId, async (store) => {
    const nearby = await store.query(vector, POLICY.duplicateCandidateLimit);
    const career = isCareerFact(candidate.text);
    if (nearby.some((hit) => duplicateOf(candidate.text, hit, career))) return false;
    const current = await store.list();
    await store.insert(candidate, vector, metadata);
    await store.deleteMany(obsoleteCareerIds(current, candidate.text));
    return true;
  });
  if (inserted && key) acceptedKeys.add(key);
}

async function applyUpdate(
  cfg: EmbeddingConfig,
  userId: string,
  action: Extract<MemoryAction, { event: "UPDATE" }>,
  metadata: unknown,
  preview: readonly MemorySnapshot[],
): Promise<void> {
  const expected = preview.find((memory) => memory.id === action.id);
  if (!expected) return;
  const replacement = mergeMemoryUpdate(expected, action);
  if (!replacement || !shouldPersistFact(replacement.text)) return;
  const { vector } = await embed(cfg, replacement.text);

  await withUserMemoryTransaction(userId, async (store) => {
    const outcome = await store.update(action.id, expected, replacement, vector, metadata);
    if (outcome.kind !== "updated") return;
    const current = await store.list();
    await store.deleteMany(obsoleteCareerIds(current, replacement.text, action.id));
  });
}

async function applyDelete(
  userId: string,
  action: Extract<MemoryAction, { event: "DELETE" }>,
  preview: readonly MemorySnapshot[],
): Promise<void> {
  const expected = preview.find((memory) => memory.id === action.id);
  if (!expected) return;
  await withUserMemoryTransaction(userId, (store) => store.delete(action.id, expected));
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
  let preview: Awaited<ReturnType<typeof listMemory>>;
  let actions: MemoryAction[];
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
    console.error("[memory] addTurn failed", error);
    return;
  }

  const acceptedKeys = new Set<string>();
  for (const action of actions) {
    try {
      if (action.event === "ADD") await applyAdd(cfg, userId, action, metadata, acceptedKeys);
      else if (action.event === "UPDATE") await applyUpdate(cfg, userId, action, metadata, preview);
      else if (action.event === "DELETE") await applyDelete(userId, action, preview);
    } catch (error) {
      console.error("[memory] addTurn action failed", action, error);
    }
  }
}
