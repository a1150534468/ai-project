import { getPrisma, getRedis } from "@ai-assistant/db";
import { createLlmClient, loadLlmConfig } from "@ai-assistant/llm";
import type Anthropic from "@anthropic-ai/sdk";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { runTurn, type RunTurnResult } from "../agent/run.js";
import { iconForAgentId, resolveAgent, type AgentRuntime } from "../agents/service.js";
import { requireUser } from "../auth/require-user.js";
import {
  dedupeKbCitations,
  filterRelevantChunks,
  resolveEffectiveKbIds,
  retrieveChunks,
  shouldRetrieveKbForQuery,
  type KbCitation,
} from "../kb/retrieve.js";
import { embed, loadEmbeddingConfig } from "../memory/embedding-client.js";
import { addTurn, search } from "../memory/memory-service.js";
import { withTimeout } from "../runtime/with-timeout.js";
import { buildCurrentUserContent, isImageMime, prepareChatAttachments, resolveChatModel } from "./attachments.js";
import { acquireSessionLock } from "./lock.js";
import { chatModelErrorMessage, providerModelId, type ChatErrorProvider } from "./routes-errors.js";
import {
  DEFAULT_KB_MAX_CHUNKS_PER_DOCUMENT,
  DEFAULT_KB_MAX_CONTEXT_CHUNKS,
  DEFAULT_KB_MIN_SCORE,
  DEFAULT_KB_RETRIEVE_TIMEOUT_MS,
  DEFAULT_KB_TOPK,
  positiveIntEnv,
  positiveNumberEnv,
} from "./routes-runtime.js";
import { bodySchema, type ChatRequestBody } from "./routes-schemas.js";
import { registerSessionRoutes } from "./session-routes.js";
import { openChatEventStream, type ChatEventStream } from "./sse.js";

export { chatModelErrorMessage, providerModelId } from "./routes-errors.js";

interface ActiveSession {
  id: string;
  agent: AgentRuntime;
  attachedKbIds: string[];
  kbAttachAllOwn: boolean;
}

interface KnowledgeSelection {
  ids: string[];
  allOwn: boolean;
  explicit: boolean;
}

interface PromptContext {
  system?: string;
  memoryIds: string[];
  kbCitations: KbCitation[];
}

function appendPrompt(current: string | undefined, block: string): string {
  return current ? `${current}\n\n${block}` : block;
}

function snapshottedAgent(row: {
  agentId: string | null;
  agentName: string | null;
  agentPrompt: string | null;
}): AgentRuntime | null {
  if (row.agentId === null || row.agentName === null || row.agentPrompt === null) return null;
  return {
    agentId: row.agentId,
    agentName: row.agentName,
    agentPrompt: row.agentPrompt,
    agentIcon: iconForAgentId(row.agentId),
  };
}

async function existingSession(
  prisma: PrismaClient,
  userId: string,
  sessionId: string,
): Promise<ActiveSession | "forbidden"> {
  const row = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      userId: true,
      agentId: true,
      agentName: true,
      agentPrompt: true,
      attachedKbIds: true,
      kbAttachAllOwn: true,
    },
  });
  if (!row || row.userId !== userId) return "forbidden";

  return {
    id: sessionId,
    agent: snapshottedAgent(row) ?? (await resolveAgent(prisma, userId, row.agentId)),
    attachedKbIds: row.attachedKbIds,
    kbAttachAllOwn: row.kbAttachAllOwn,
  };
}

async function newSession(
  prisma: PrismaClient,
  userId: string,
  requestedAgentId: string | undefined,
): Promise<ActiveSession> {
  const agent = await resolveAgent(prisma, userId, requestedAgentId);
  const row = await prisma.session.create({
    data: {
      userId,
      agentId: agent.agentId,
      agentName: agent.agentName,
      agentPrompt: agent.agentPrompt,
    },
  });
  return { id: row.id, agent, attachedKbIds: [], kbAttachAllOwn: false };
}

function knowledgeSelection(body: ChatRequestBody, session: ActiveSession): KnowledgeSelection {
  const explicit = body.kbIds !== undefined || body.attachAllOwn !== undefined;
  if (!explicit) {
    return {
      ids: session.attachedKbIds,
      allOwn: session.kbAttachAllOwn,
      explicit: false,
    };
  }
  return {
    ids: body.kbIds ?? [],
    allOwn: body.attachAllOwn ?? false,
    explicit: true,
  };
}

async function effectiveKnowledge(
  prisma: PrismaClient,
  userId: string,
  selection: KnowledgeSelection,
): Promise<{ ids: string[]; validated: boolean }> {
  if (selection.ids.length === 0 && !selection.allOwn) return { ids: [], validated: true };
  try {
    const ids = await resolveEffectiveKbIds(prisma, userId, {
      attachedKbIds: selection.ids,
      kbAttachAllOwn: selection.allOwn,
    });
    return { ids, validated: true };
  } catch {
    return { ids: [], validated: false };
  }
}

async function buildPromptContext(args: {
  prisma: PrismaClient;
  userId: string;
  query: string;
  memoryEnabled: boolean;
  kbIds: string[];
  baseSystem?: string;
}): Promise<PromptContext> {
  let system = args.baseSystem;
  let queryVector: number[] | undefined;
  let memoryIds: string[] = [];
  const searchKnowledge = args.kbIds.length > 0 && shouldRetrieveKbForQuery(args.query);

  if (args.memoryEnabled || searchKnowledge) {
    try {
      const embeddingConfig = loadEmbeddingConfig();
      queryVector = (await embed(embeddingConfig, args.query)).vector;
      if (args.memoryEnabled) {
        const memories = await search(embeddingConfig, args.userId, args.query, 5, queryVector);
        if (memories.length > 0) {
          memoryIds = memories.map((memory) => memory.id);
          system = appendPrompt(system, `相关记忆：\n${memories.map((memory) => `- ${memory.text}`).join("\n")}`);
        }
      }
    } catch {
      queryVector = undefined;
    }
  }

  let kbCitations: KbCitation[] = [];
  if (searchKnowledge && queryVector) {
    try {
      const hits = await withTimeout(
        retrieveChunks(args.prisma, args.kbIds, queryVector, positiveIntEnv("KB_TOPK", DEFAULT_KB_TOPK)),
        positiveIntEnv("KB_RETRIEVE_TIMEOUT_MS", DEFAULT_KB_RETRIEVE_TIMEOUT_MS),
        "knowledge base retrieval",
      );
      const relevant = filterRelevantChunks(hits, {
        minScore: positiveNumberEnv("KB_MIN_SCORE", DEFAULT_KB_MIN_SCORE),
        maxChunks: positiveIntEnv("KB_MAX_CONTEXT_CHUNKS", DEFAULT_KB_MAX_CONTEXT_CHUNKS),
        maxChunksPerDocument: positiveIntEnv("KB_MAX_CHUNKS_PER_DOCUMENT", DEFAULT_KB_MAX_CHUNKS_PER_DOCUMENT),
      });
      if (relevant.length > 0) {
        const references = relevant.map((hit) => {
          const preview = hit.content.slice(0, 200);
          return `- ${hit.docName}#${hit.ordinal}: ${preview}${hit.content.length > 200 ? "..." : ""}`;
        });
        system = appendPrompt(system, `参考资料：\n${references.join("\n")}`);
        kbCitations = dedupeKbCitations(relevant);
      }
    } catch {
      // Retrieval is optional; the model can answer without knowledge-base context.
    }
  }

  return { system, memoryIds, kbCitations };
}

function finalAssistantText(result: RunTurnResult): string {
  if (result.stoppedByMaxIterations) {
    const notice = `本轮已经连续调用了 ${result.toolCalls} 次工具，达到单轮上限。如需继续请发送“继续”。`;
    return result.text.trim() ? `${result.text}\n\n${notice}` : notice;
  }
  if (result.text.trim()) return result.text;
  return result.toolCalls > 0 ? "本轮调用了工具，但模型没有返回最终说明。如需继续请发送“继续”。" : "";
}

function alignStreamedAnswer(stream: ChatEventStream, streamed: string, finalText: string): void {
  if (streamed === finalText) return;
  if (finalText.startsWith(streamed)) {
    stream.send("text", { text: finalText.slice(streamed.length) });
    return;
  }
  stream.send("reset", {});
  if (finalText) stream.send("text", { text: finalText });
}

function rememberTurn(args: {
  client: Parameters<typeof addTurn>[1];
  defaultModel: string;
  userId: string;
  sessionId: string;
  userText: string;
  assistantText: string;
}): void {
  void (async () => {
    try {
      const embeddingConfig = loadEmbeddingConfig();
      const model = process.env.MEMORY_EXTRACT_MODEL ?? args.defaultModel;
      await addTurn(embeddingConfig, args.client, model, args.userId, args.userText, args.assistantText, {
        sessionId: args.sessionId,
      });
    } catch {
      // Long-term memory is best effort and must not delay the completed SSE turn.
    }
  })();
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireUser);

  const prisma = getPrisma();
  const redis = getRedis();
  const config = loadLlmConfig();
  const client = createLlmClient(config);

  app.post("/api/chat", async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });

    const userId = request.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { bannedAt: true, memoryEnabled: true },
    });
    if (!user) return reply.code(401).send({ error: "未登录" });
    if (user.bannedAt) return reply.code(403).send({ error: "账号已被封禁" });

    const active = parsed.data.sessionId
      ? await existingSession(prisma, userId, parsed.data.sessionId)
      : await newSession(prisma, userId, parsed.data.agentId);
    if (active === "forbidden") {
      return reply.code(403).send({ error: "无权访问该会话" });
    }

    const requestedModel = parsed.data.model ?? config.defaultModel;
    const hasImage = parsed.data.attachments.some(
      (attachment) => attachment.kind === "image" || isImageMime(attachment.mime),
    );
    const modelChoice = resolveChatModel(requestedModel, hasImage);
    const providerModel = providerModelId(modelChoice.model, config.provider);
    const errorProvider: ChatErrorProvider = config.modelRoutes?.some((route) => route.model === modelChoice.model)
      ? "ai-pixel"
      : config.provider;

    const release = await acquireSessionLock(redis, active.id);
    if (!release) return reply.code(409).send({ error: "该会话正在处理中" });

    let stream: ChatEventStream | undefined;
    try {
      stream = openChatEventStream(reply);
      stream.send("session", {
        sessionId: active.id,
        agentId: active.agent.agentId,
        agentName: active.agent.agentName,
        agentIcon: active.agent.agentIcon,
        model: modelChoice.model,
        providerModel,
        requestedModel,
        fallbackReason: modelChoice.fallbackReason,
      });

      let attachments;
      try {
        attachments = await prepareChatAttachments(parsed.data.attachments);
      } catch (error) {
        stream.send("error", {
          message: error instanceof Error ? error.message : "附件解析失败",
        });
        return;
      }

      const messageText = parsed.data.message.trim();
      const storedUserText = `${messageText}${attachments.storedLabel}`.trim() || "[附件]";
      const queryText = `${messageText}\n${attachments.searchableText}`.trim() || storedUserText;
      const selectedKnowledge = knowledgeSelection(parsed.data, active);
      const knowledge = await effectiveKnowledge(prisma, userId, selectedKnowledge);

      const previousMessages = await prisma.message.findMany({
        where: { sessionId: active.id },
        select: { role: true, content: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });

      await prisma.$transaction(async (tx) => {
        await tx.message.create({
          data: { sessionId: active.id, role: "user", content: storedUserText },
        });
        await tx.session.update({
          where: { id: active.id },
          data: {
            updatedAt: new Date(),
            ...(selectedKnowledge.explicit && knowledge.validated
              ? {
                  attachedKbIds: knowledge.ids,
                  kbAttachAllOwn: selectedKnowledge.allOwn,
                }
              : {}),
          },
        });
      });

      const history: Anthropic.MessageParam[] = previousMessages.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      }));
      history.push({
        role: "user",
        content: buildCurrentUserContent(messageText, attachments),
      });

      const context = await buildPromptContext({
        prisma,
        userId,
        query: queryText,
        memoryEnabled: user.memoryEnabled,
        kbIds: knowledge.ids,
        baseSystem: active.agent.agentPrompt,
      });
      const result = await runTurn({
        client,
        model: providerModel,
        history,
        system: context.system,
        onText: (text) => stream?.send("text", { text }),
        onResetText: () => stream?.send("reset", {}),
      });
      const assistantText = finalAssistantText(result);
      alignStreamedAnswer(stream, result.text, assistantText);

      if (context.memoryIds.length > 0 || context.kbCitations.length > 0) {
        stream.send("citation", {
          memories: context.memoryIds,
          kb: context.kbCitations,
        });
      }
      if (assistantText) {
        await prisma.message.create({
          data: {
            sessionId: active.id,
            role: "assistant",
            content: assistantText,
            model: modelChoice.model,
          },
        });
      }
      stream.send("done", { sessionId: active.id });

      if (user.memoryEnabled && assistantText) {
        rememberTurn({
          client,
          defaultModel: config.defaultModel,
          userId,
          sessionId: active.id,
          userText: storedUserText,
          assistantText,
        });
      }
    } catch (error) {
      app.log.error(error);
      if (!stream) throw error;
      stream.send("error", { message: chatModelErrorMessage(error, errorProvider) });
    } finally {
      try {
        await release();
      } catch (error) {
        app.log.error({ err: error }, "failed to release chat session lock");
      } finally {
        stream?.close();
      }
    }
  });

  registerSessionRoutes(app, prisma);
}
