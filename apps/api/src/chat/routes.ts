/**
 * 聊天路由:`POST /api/chat`(SSE 一轮对话)+ 三条会话读写路由。原文件把模块级的
 * schema、错误翻译、工具展示、运行期常量搬到 4 个同域文件,本文件只留下 fastify 插件本体。
 *
 * **本文件刻意不做成纯 re-export 门面**(与 image-routes.ts / video-routes.ts 同一处理):
 * 插件闭包持有 `prisma` / `redis` / `client`,四条路由全靠它们。要把路由再拆走就得
 * 先造一层 ctx 间接,行数不会更少,只会多一层。它的导出面是**恰好 3 个名字**
 * (`chatRoutes` / `chatModelErrorMessage` / `providerModelId`),后两个由文件末尾的
 * re-export 原样转出,`routes-errors.test.ts` 就从本文件认这两个名字。
 *
 * 分工:
 *  - routes-schemas.ts      请求体校验(bodySchema 及其附件子 schema)
 *  - routes-errors.ts       上游错误翻译 + 百炼模型别名
 *  - routes-tool-summary.ts 工具事件 → SSE 载荷
 *  - routes-runtime.ts      KB 默认值 / 心跳间隔 / 环境变量读取
 *
 * 四个新文件都是叶子,依赖方向单向:四个叶子 → 本文件。
 *
 * `POST /api/chat` 里几处顺序不能动:
 *  - 封禁校验在 `acquireSessionLock` **之前**,因为它是无副作用的 4xx。放到取锁之后
 *    会让一次注定失败的请求把会话锁占满一个 TTL。
 *  - `send("session", ...)` 必须是第一条 SSE,前端靠它拿到 sessionId;后面任何一条 `error`
 *    事件都得有会话可挂。
 *  - `finally` 里 `clearInterval` → `release()` → `reply.raw.end()` 三件事都必须做:漏心跳会留下
 *    永久 15s 一次写 SSE 的定时器,漏 release 会让该会话在锁 TTL 内一直 409。
 */

import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/require-user.js";
import { getPrisma } from "@ai-assistant/db";
import { getRedis } from "@ai-assistant/db";
import { createLlmClient, loadLlmConfig } from "@ai-assistant/llm";
import { runTurn } from "../agent/run.js";
import { execTool as execDefaultTool } from "../agent/tools.js";
import { acquireSessionLock } from "./lock.js";
import { embed, loadEmbeddingConfig } from "../memory/embedding-client.js";
import { search, addTurn } from "../memory/memory-service.js";
import {
  dedupeKbCitations,
  filterRelevantChunks,
  resolveEffectiveKbIds,
  retrieveChunks,
  shouldRetrieveKbForQuery,
  type KbCitation,
} from "../kb/retrieve.js";
import type Anthropic from "@anthropic-ai/sdk";
import { localTools } from "@ai-assistant/connector-protocol";
import { getDispatcher } from "../connector/hub.js";
import { makeLocalExecTool } from "../connector/local-tools.js";
import { pickActiveDevice } from "../connector/select-device.js";
import { parseDeviceTools, selectMountedTools, type InstalledToolSummary } from "../tools/tool-mounts.js";
import { iconForAgentId, resolveAgent, type AgentRuntime } from "../agents/service.js";
import {
  buildCurrentUserContent,
  isImageMime,
  prepareChatAttachments,
  resolveChatModel,
} from "./attachments.js";

// === 拆分后的同域模块 ===
import { bodySchema } from "./routes-schemas.js";
import { chatModelErrorMessage, providerModelId, type ChatErrorProvider } from "./routes-errors.js";
import { TOOL_LABELS, toToolPayload } from "./routes-tool-summary.js";
import {
  DEFAULT_KB_MAX_CHUNKS_PER_DOCUMENT,
  DEFAULT_KB_MAX_CONTEXT_CHUNKS,
  DEFAULT_KB_MIN_SCORE,
  DEFAULT_KB_TOPK,
  positiveIntEnv,
  positiveNumberEnv,
  SSE_HEARTBEAT_MS,
} from "./routes-runtime.js";

// 这两个名字原样转出,routes-errors.test.ts 从本文件 import 它们。
export { chatModelErrorMessage, providerModelId } from "./routes-errors.js";

export async function chatRoutes(app: FastifyInstance) {
  // 本文件 4 个路由全部必须登录，挂插件级。钩子和它保护的路由同文件，
  // 这样测试单独注册本文件时守卫不会凭空消失。
  app.addHook("preHandler", requireUser);

  const prisma = getPrisma();
  const redis = getRedis();
  const cfg = loadLlmConfig();
  const client = createLlmClient(cfg);

  app.post("/api/chat", async (req, reply) => {
    const userId = req.userId;
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });

    // 会话归属校验（防越权）
    let sessionId = parsed.data.sessionId;
    let sessionAgent: AgentRuntime | null = null;
    let requestedToolIds = parsed.data.toolIds ?? [];
    if (sessionId) {
      const s = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { userId: true, agentId: true, agentName: true, agentPrompt: true, attachedToolIds: true },
      });
      if (!s || s.userId !== userId) return reply.code(403).send({ error: "无权访问该会话" });
      requestedToolIds = parsed.data.toolIds ?? s.attachedToolIds;
      if (s.agentId && s.agentName && s.agentPrompt) {
        const resolved = await resolveAgent(prisma, userId, s.agentId);
        sessionAgent = {
          agentId: s.agentId,
          agentName: s.agentName,
          agentPrompt: s.agentPrompt,
          agentIcon: resolved.agentIcon,
        };
      } else {
        sessionAgent = await resolveAgent(prisma, userId, s.agentId);
      }
    } else {
      sessionAgent = await resolveAgent(prisma, userId, parsed.data.agentId);
      const s = await prisma.session.create({
        data: {
          userId,
          agentId: sessionAgent.agentId,
          agentName: sessionAgent.agentName,
          agentPrompt: sessionAgent.agentPrompt,
          attachedToolIds: requestedToolIds,
        },
      });
      sessionId = s.id;
    }

    // 封禁拦截：已登录用户被封后下次请求即拒（取锁前，避免泄漏会话锁）
    const u0 = await prisma.user.findUnique({ where: { id: userId }, select: { bannedAt: true } });
    if (u0?.bannedAt) return reply.code(403).send({ error: "账号已被封禁" });

    // 模型解析：取锁前，纯计算无副作用
    const requestedModel = parsed.data.model ?? cfg.defaultModel;
    const hasImageAttachment = parsed.data.attachments.some((a) => a.kind === "image" || isImageMime(a.mime));
    const modelResolution = resolveChatModel(requestedModel, hasImageAttachment);
    const resolvedModel = modelResolution.model;
    const model = providerModelId(resolvedModel, cfg.provider);
    const errorProvider: ChatErrorProvider = cfg.modelRoutes?.some((route) => route.model === resolvedModel)
      ? "ai-pixel"
      : cfg.provider;

    const release = await acquireSessionLock(redis, sessionId);
    if (!release) return reply.code(409).send({ error: "该会话正在处理中" });

    // SSE 响应头
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.flushHeaders?.();
    let responseClosed = false;
    let heartbeat: NodeJS.Timeout | undefined;
    const send = (event: string, data: unknown) => {
      if (responseClosed || reply.raw.destroyed || reply.raw.writableEnded) return;
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        (reply.raw as typeof reply.raw & { flush?: () => void }).flush?.();
      } catch {
        responseClosed = true;
        if (heartbeat) clearInterval(heartbeat);
      }
    };
    reply.raw.on("close", () => {
      responseClosed = true;
      if (heartbeat) clearInterval(heartbeat);
    });
    heartbeat = setInterval(() => {
      send("ping", { ts: Date.now() });
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();
    send("session", {
      sessionId,
      agentId: sessionAgent?.agentId,
      agentName: sessionAgent?.agentName,
      agentIcon: sessionAgent?.agentIcon,
      model: resolvedModel,
      providerModel: model,
      requestedModel,
      fallbackReason: modelResolution.fallbackReason,
    });

    try {
      const preparedAttachments = await prepareChatAttachments(parsed.data.attachments).catch((err) => {
        send("error", { message: err instanceof Error ? err.message : "附件解析失败" });
        return null;
      });
      if (!preparedAttachments) return;

      const storedUserContent = `${parsed.data.message.trim()}${preparedAttachments.storedLabel}`.trim() || "[附件]";
      const queryText = `${parsed.data.message.trim()}\n${preparedAttachments.searchableText}`.trim() || storedUserContent;

      // 持久化用户消息
      const userMessage = await prisma.message.create({
        data: { sessionId, role: "user", content: storedUserContent },
        select: { id: true },
      });

      // 载入历史
      const rows = await prisma.message.findMany({
        where: { sessionId },
        orderBy: { createdAt: "asc" },
      });
      const history: Anthropic.MessageParam[] = rows.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.id === userMessage.id ? buildCurrentUserContent(parsed.data.message, preparedAttachments) : m.content,
      }));

      // 记忆检索注入（可选）+ KB 检索注入（可选）
      let systemPrompt: string | undefined = sessionAgent?.agentPrompt;
      let citationMemoryIds: string[] = [];
      let kbCitations: KbCitation[] = [];

      const user = await prisma.user.findUnique({ where: { id: userId } });

      // 解析有效 KB ID（防越权）
      let effectiveKbIds: string[] = [];
      try {
        effectiveKbIds = await resolveEffectiveKbIds(prisma, userId, {
          attachedKbIds: parsed.data.kbIds,
          kbAttachAllOwn: parsed.data.attachAllOwn,
        });
      } catch {
        // KB 解析失败降级（不阻塞聊天）
        effectiveKbIds = [];
      }
      const shouldSearchKb = effectiveKbIds.length > 0 && shouldRetrieveKbForQuery(queryText);

      // 是否需要 embed：记忆启用或有 KB 挂载
      let queryVector: number[] | undefined;
      if (user?.memoryEnabled || shouldSearchKb) {
        try {
          const embCfg = loadEmbeddingConfig();
          const embedResult = await embed(embCfg, queryText);
          queryVector = embedResult.vector;

          // 记忆检索（使用预计算向量）
          if (user?.memoryEnabled && queryVector) {
            const memories = await search(
              embCfg,
              userId,
              queryText,
              5,
              queryVector
            );
            if (memories.length > 0) {
              citationMemoryIds = memories.map((m) => m.id);
              const memoryBlock = `相关记忆：\n${memories.map((m) => `- ${m.text}`).join("\n")}`;
              systemPrompt = systemPrompt ? `${systemPrompt}\n\n${memoryBlock}` : memoryBlock;
            }
          }
        } catch {
          // embed 失败降级（不阻塞聊天）：没有向量就跳过记忆与 KB 注入
          queryVector = undefined;
        }
      }

      // KB 检索（使用预计算向量）
      if (shouldSearchKb && queryVector) {
        try {
          const kbTopK = positiveIntEnv("KB_TOPK", DEFAULT_KB_TOPK);
          const kbTimeoutMs = Number(process.env.KB_RETRIEVE_TIMEOUT_MS) || 3000;

          // 带超时的 KB 检索
          const rawKbHits = await Promise.race([
            retrieveChunks(prisma, effectiveKbIds, queryVector, kbTopK),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("KB_RETRIEVE_TIMEOUT")), kbTimeoutMs)
            ),
          ]);
          const kbHits = filterRelevantChunks(rawKbHits, {
            minScore: positiveNumberEnv("KB_MIN_SCORE", DEFAULT_KB_MIN_SCORE),
            maxChunks: positiveIntEnv("KB_MAX_CONTEXT_CHUNKS", DEFAULT_KB_MAX_CONTEXT_CHUNKS),
            maxChunksPerDocument: positiveIntEnv(
              "KB_MAX_CHUNKS_PER_DOCUMENT",
              DEFAULT_KB_MAX_CHUNKS_PER_DOCUMENT,
            ),
          });

          if (kbHits.length > 0) {
            // 拼接 KB 参考资料块
            const kbBlock = `参考资料：\n${kbHits
              .map((h) => {
                // 截断内容到合理长度（避免 systemPrompt 过长）
                const contentPreview = h.content.substring(0, 200);
                return `- ${h.docName}#${h.ordinal}: ${contentPreview}${h.content.length > 200 ? "..." : ""}`;
              })
              .join("\n")}`;

            // 并列拼接到 systemPrompt（记忆与 KB 独立）
            systemPrompt = systemPrompt ? `${systemPrompt}\n\n${kbBlock}` : kbBlock;

            // 记录 KB citation（仅记录文档和分块号）
            kbCitations = dedupeKbCitations(kbHits);
          }
        } catch {
          // KB 检索失败降级（不阻塞聊天）
          // kbCitations 保持空数组，systemPrompt 不被改动
        }
      }

      // 会话挂载持久化
      if (parsed.data.kbIds || parsed.data.attachAllOwn) {
        try {
          await prisma.session.update({
            where: { id: sessionId },
            data: {
              attachedKbIds: parsed.data.kbIds || [],
              kbAttachAllOwn: parsed.data.attachAllOwn ?? false,
            },
          });
        } catch {
          // 会话更新失败不阻塞聊天
        }
      }
      if (parsed.data.toolIds) {
        try {
          await prisma.session.update({
            where: { id: sessionId },
            data: { attachedToolIds: requestedToolIds },
          });
        } catch {
        }
      }

      let chatTools: Anthropic.Tool[] | undefined;
      let chatExecTool: ((name: string, input: unknown) => Promise<string>) | undefined;
      const toolLabels: Record<string, string> = { ...TOOL_LABELS };
      const online = await prisma.device.findMany({
        where: { userId, online: true, revokedAt: null },
        select: { id: true, userId: true, lastSeenAt: true, capabilities: true, tools: true },
      });
      const active = pickActiveDevice(online, parsed.data.deviceId);
      if (active) {
        const installedRows = requestedToolIds.length > 0
          ? await prisma.userToolInstall.findMany({
            where: { userId, status: "installed", toolName: { in: requestedToolIds } },
            select: { name: true, toolName: true, description: true },
          })
          : [];
        const installedTools: InstalledToolSummary[] = installedRows.map((row) => ({
          name: row.name,
          toolName: row.toolName,
          description: row.description,
        }));
        for (const row of installedRows) {
          toolLabels[row.toolName] = row.name;
        }
        const mounted = selectMountedTools({
          requestedToolIds,
          builtinTools: localTools,
          installedTools,
          deviceCapabilities: active.capabilities,
          deviceTools: parseDeviceTools(active.tools),
        });
        if (mounted.tools.length > 0) {
          const localExec = makeLocalExecTool(getDispatcher(), userId, active.id, active.userId);
          chatTools = mounted.tools;
          chatExecTool = (name, input) => {
            if (mounted.allowedToolNames.has(name)) {
              return localExec(name, input);
            }
            return execDefaultTool(name, input);
          };
        }
        send("device", { deviceId: active.id, tools: mounted.tools.map((tool) => tool.name) });
      }

      const result = await runTurn({
        client,
        model,
        history,
        system: systemPrompt,
        tools: chatTools,
        execTool: chatExecTool,
        onText: (t) => send("text", { text: t }),
        onResetText: () => send("reset", {}),
        onTool: (event) => {
          app.log.info({
            sessionId,
            userId,
            tool: event.name,
            status: event.status,
            elapsedMs: event.elapsedMs,
          }, "chat tool event");
          send("tool", toToolPayload(event, toolLabels));
        },
      });
      const assistantText = result.stoppedByMaxIterations
        ? `本轮已经连续执行了 ${result.toolCalls} 次电脑工具，已达到本轮工具调用上限。请查看上方工具调用记录确认执行状态，如需继续请发送“继续”。`
        : result.text.trim().length > 0
          ? result.text
          : result.toolCalls > 0
            ? "本轮已经执行了电脑工具，但模型没有返回最终说明。请查看上方工具调用记录确认执行状态，必要时发送“继续”让我接着处理。"
            : "";
      if (assistantText && assistantText !== result.text) {
        send("text", { text: assistantText });
      }

      // 发送 citation（如果有记忆或 KB 命中）
      if (citationMemoryIds.length > 0 || kbCitations.length > 0) {
        send("citation", {
          memories: citationMemoryIds,
          kb: kbCitations,
        });
      }

      // 持久化助手回复
      if (assistantText) {
        await prisma.message.create({
          data: { sessionId, role: "assistant", content: assistantText, model: resolvedModel },
        });
      }
      send("done", { sessionId });

      // 异步入库长期记忆（不阻塞 done 发送）
      if (user?.memoryEnabled) {
        void (async () => {
          try {
            const embCfg = loadEmbeddingConfig();
            const extractModel = process.env.MEMORY_EXTRACT_MODEL ?? cfg.defaultModel;
            await addTurn(embCfg, client, extractModel, userId, storedUserContent, result.text, {
              sessionId,
            });
          } catch {
            // addTurn 内部已降级；此处不再处理
          }
        })();
      }
    } catch (err) {
      app.log.error(err);
      const message = chatModelErrorMessage(err, errorProvider);
      send("error", { message });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      await release();
      if (!responseClosed && !reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.end();
      }
    }
  });

  // 获取用户会话列表
  app.get("/api/sessions", async (req, reply) => {
    const userId = req.userId;

    const sessions = await prisma.session.findMany({
      where: { userId },
      select: {
        id: true,
        agentId: true,
        agentName: true,
        updatedAt: true,
        messages: {
          where: { role: "user" },
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { content: true },
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });

    const data = sessions.map((s) => {
      // 取首条用户消息，截断到30字；无消息则"新对话"
      const title = s.messages.length > 0
        ? s.messages[0].content.substring(0, 30)
        : "新对话";

      return {
        id: s.id,
        title,
        agentId: s.agentId,
        agentName: s.agentName,
        agentIcon: iconForAgentId(s.agentId),
        updatedAt: s.updatedAt.toISOString(),
      };
    });

    return reply.send({
      success: true,
      data,
    });
  });

  // 取会话消息列表（权限检验）
  app.get("/api/sessions/:id/messages", async (req, reply) => {
    const userId = req.userId;

    const { id: sessionId } = req.params as { id: string };

    // 检查会话是否存在且属于该用户（防越权）
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });

    if (!session) return reply.code(404).send({ error: "会话不存在" });
    if (session.userId !== userId) return reply.code(403).send({ error: "无权访问该会话" });

    // 按时间正序返回消息
    const messages = await prisma.message.findMany({
      where: { sessionId },
      select: {
        role: true,
        content: true,
        model: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    return reply.send({
      success: true,
      data: messages,
    });
  });

  // 删除用户会话（级联删Message）
  app.delete("/api/sessions/:id", async (req, reply) => {
    const userId = req.userId;

    const { id: sessionId } = req.params as { id: string };

    // 检查会话是否存在且属于该用户
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });

    if (!session) return reply.code(404).send({ error: "会话不存在" });
    if (session.userId !== userId) return reply.code(403).send({ error: "无权访问该会话" });

    // 删除会话（Message 由 Prisma cascade 自动删除）
    await prisma.session.delete({
      where: { id: sessionId },
    });

    return reply.send({ success: true });
  });
}
