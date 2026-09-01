/**
 * 智能体团队跑任务前，把挂载的知识库压成一段随 prompt 走的 `knowledgeText`。
 *
 * **这里不是检索，别把它当检索看**（P4.3 记录，2026-09-01）：
 * `buildAgentKnowledgeBaseContext` 连任务目标都不收 —— 参数只有 `kbIds` / `attachAllOwn`。
 * 它按 `updatedAt desc` 每个库取 2 篇 `indexed` 文档、再按 `ordinal asc` 取每篇前 2 块，
 * 也就是「最近改过的两篇文档的开头 ~1400 字」，和用户这次问什么毫无关系。
 * 长文档尤其糟：拿到的是封面和目录，不是相关段落。
 *
 * 对照 `workflow/dub/dub-kb-context.ts`（56 行）就是该有的样子：
 * `resolveEffectiveKbIds` → `billableEmbed(query)` → `retrieveChunks`（pgvector 余弦）
 * → `filterRelevantChunks`（minScore 0.35）。任务目标在调用点 `routes.ts:215/264` 就在手边
 * （下一行正传给 `recommendTeam`），差的不是管线而是一次决定：
 * 每次提交任务多一笔**计费的** embedding、以及推荐链路上多一个失败点该怎么降级。
 * 所以它留在本计划范围外，是显式决定，不是漏掉。
 *
 * 顺带更正 P4.3 原文的说法：`take: 2` 是**按库**嵌在 KB select 里的，产物系统库从来不是
 * 「永远排最前」。它真正的伤害是占掉 `attachAllOwn` 集合里一个位子、并吃掉全局
 * `MAX_SNIPPETS`（12）里最多 4 条 —— 而库间顺序本身是不确定的（`resolveEffectiveKbIds`
 * 返回的是 Set 迭代序，底下那次 `findMany` 没有 `orderBy`），所以挂了 3 个以上库时，
 * 它能把一个真库挤出预算。那些行已随 P2 删掉。
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { resolveEffectiveKbIds } from "../kb/retrieve.js";

const MAX_CONTEXT_KBS = 50;
const MAX_DOCUMENTS_PER_KB = 2;
const MAX_CHUNKS_PER_DOCUMENT = 2;
const MAX_SNIPPETS = 12;
const MAX_SNIPPET_LENGTH = 700;

export interface AgentKnowledgeBaseSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly ownerType: string;
}

export interface AgentKnowledgeSnippet {
  readonly kbId: string;
  readonly kbName: string;
  readonly docName: string;
  readonly ordinal: number;
  readonly content: string;
}

export interface AgentKnowledgeBaseContext {
  readonly attachAllOwn: boolean;
  readonly requestedKbIds: readonly string[];
  readonly effectiveKbIds: readonly string[];
  readonly knowledgeBases: readonly AgentKnowledgeBaseSummary[];
  readonly snippets: readonly AgentKnowledgeSnippet[];
  readonly knowledgeText: string;
}

export interface AgentKnowledgeBaseInput {
  readonly kbIds?: readonly string[];
  readonly attachAllOwn?: boolean;
}

interface KnowledgeBaseRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly ownerType: string;
  readonly documents: readonly {
    readonly name: string;
    readonly chunks: readonly {
      readonly ordinal: number;
      readonly content: string;
    }[];
  }[];
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  const result = new Set<string>();
  for (const value of values ?? []) {
    const normalized = value.trim();
    if (normalized) result.add(normalized);
    if (result.size >= MAX_CONTEXT_KBS) break;
  }
  return [...result];
}

function compactSnippet(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_SNIPPET_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_SNIPPET_LENGTH - 1)}…`;
}

export function emptyKnowledgeBaseContext(input: AgentKnowledgeBaseInput = {}): AgentKnowledgeBaseContext {
  return {
    attachAllOwn: input.attachAllOwn === true,
    requestedKbIds: uniqueStrings(input.kbIds),
    effectiveKbIds: [],
    knowledgeBases: [],
    snippets: [],
    knowledgeText: "",
  };
}

export async function buildAgentKnowledgeBaseContext(
  prisma: PrismaClient,
  userId: string,
  input: AgentKnowledgeBaseInput,
): Promise<AgentKnowledgeBaseContext> {
  const requestedKbIds = uniqueStrings(input.kbIds);
  const attachAllOwn = input.attachAllOwn === true;
  if (!attachAllOwn && requestedKbIds.length === 0) {
    return emptyKnowledgeBaseContext({ kbIds: requestedKbIds, attachAllOwn });
  }

  const effectiveKbIds = (await resolveEffectiveKbIds(prisma, userId, {
    attachedKbIds: requestedKbIds,
    kbAttachAllOwn: attachAllOwn,
  })).slice(0, MAX_CONTEXT_KBS);

  if (effectiveKbIds.length === 0) {
    return {
      ...emptyKnowledgeBaseContext({ kbIds: requestedKbIds, attachAllOwn }),
      effectiveKbIds,
    };
  }

  const rows = await prisma.knowledgeBase.findMany({
    where: { id: { in: effectiveKbIds } },
    select: {
      id: true,
      name: true,
      description: true,
      ownerType: true,
      documents: {
        where: { status: "indexed" },
        orderBy: { updatedAt: "desc" },
        take: MAX_DOCUMENTS_PER_KB,
        select: {
          name: true,
          chunks: {
            orderBy: { ordinal: "asc" },
            take: MAX_CHUNKS_PER_DOCUMENT,
            select: { ordinal: true, content: true },
          },
        },
      },
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row as KnowledgeBaseRecord]));
  const orderedRows = effectiveKbIds
    .map((id) => byId.get(id))
    .filter((row): row is KnowledgeBaseRecord => Boolean(row));
  const snippets = orderedRows
    .flatMap((kb) => kb.documents.flatMap((document) => document.chunks.map((chunk) => ({
      kbId: kb.id,
      kbName: kb.name,
      docName: document.name,
      ordinal: chunk.ordinal,
      content: compactSnippet(chunk.content),
    }))))
    .filter((snippet) => snippet.content.length > 0)
    .slice(0, MAX_SNIPPETS);

  return {
    attachAllOwn,
    requestedKbIds,
    effectiveKbIds,
    knowledgeBases: orderedRows.map((kb) => ({
      id: kb.id,
      name: kb.name,
      description: kb.description ?? "",
      ownerType: kb.ownerType,
    })),
    snippets,
    knowledgeText: snippets
      .map((snippet) => `- [${snippet.kbName}/${snippet.docName}#${snippet.ordinal}] ${snippet.content}`)
      .join("\n"),
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function isJsonObject(value: Prisma.JsonValue | null | undefined): value is Prisma.JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function knowledgeBaseSummaries(value: unknown): AgentKnowledgeBaseSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Prisma.JsonObject => isJsonObject(item as Prisma.JsonValue))
    .map((item) => ({
      id: stringValue(item.id),
      name: stringValue(item.name),
      description: stringValue(item.description),
      ownerType: stringValue(item.ownerType),
    }))
    .filter((item) => item.id && item.name);
}

function knowledgeSnippets(value: unknown): AgentKnowledgeSnippet[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Prisma.JsonObject => isJsonObject(item as Prisma.JsonValue))
    .map((item) => ({
      kbId: stringValue(item.kbId),
      kbName: stringValue(item.kbName),
      docName: stringValue(item.docName),
      ordinal: typeof item.ordinal === "number" ? item.ordinal : 0,
      content: stringValue(item.content),
    }))
    .filter((item) => item.kbId && item.kbName && item.docName && item.content);
}

export function knowledgeBaseContextToJson(context: AgentKnowledgeBaseContext): Prisma.InputJsonObject {
  return {
    attachAllOwn: context.attachAllOwn,
    requestedKbIds: [...context.requestedKbIds],
    effectiveKbIds: [...context.effectiveKbIds],
    knowledgeBases: context.knowledgeBases.map((kb) => ({
      id: kb.id,
      name: kb.name,
      description: kb.description,
      ownerType: kb.ownerType,
    })),
    snippets: context.snippets.map((snippet) => ({
      kbId: snippet.kbId,
      kbName: snippet.kbName,
      docName: snippet.docName,
      ordinal: snippet.ordinal,
      content: snippet.content,
    })),
    knowledgeText: context.knowledgeText,
  };
}

export function readKnowledgeBaseContext(value: unknown): AgentKnowledgeBaseContext {
  if (!isJsonObject(value as Prisma.JsonValue)) return emptyKnowledgeBaseContext();
  const data = value as Prisma.JsonObject;
  return {
    attachAllOwn: data.attachAllOwn === true,
    requestedKbIds: stringArray(data.requestedKbIds),
    effectiveKbIds: stringArray(data.effectiveKbIds),
    knowledgeBases: knowledgeBaseSummaries(data.knowledgeBases),
    snippets: knowledgeSnippets(data.snippets),
    knowledgeText: stringValue(data.knowledgeText),
  };
}

export function describeKnowledgeBaseContext(context: AgentKnowledgeBaseContext): string {
  if (context.effectiveKbIds.length === 0) return "";
  const sections = [
    [
      `已挂载知识库 ${context.knowledgeBases.length} 个：`,
      ...context.knowledgeBases.map((kb) => (
        `- ${kb.name}${kb.ownerType === "OFFICIAL" ? "（官方）" : "（我的）"}${kb.description ? `：${kb.description}` : ""}`
      )),
    ].join("\n"),
  ];
  if (context.knowledgeText.trim()) {
    sections.push(`知识库参考资料：\n${context.knowledgeText}`);
  }
  return sections.join("\n\n");
}
