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
