import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@ai-assistant/db";
import { getRedis } from "@ai-assistant/db";
import { createLlmClient, loadLlmConfig } from "@ai-assistant/llm";
import { createBillingClient, InsufficientBalanceError } from "@ai-assistant/billing";
import {
  ChatModelEmptyResponseError,
  ChatModelStreamTimeoutError,
  runTurn,
  type RunTurnToolEvent,
} from "../agent/run.js";
import { execTool as execDefaultTool } from "../agent/tools.js";
import { acquireSessionLock } from "./lock.js";
import { loadEmbeddingConfig } from "../memory/embedding-client.js";
import { billableEmbed } from "../memory/embedding-billing.js";
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
  estimateInputTokens,
  isImageMime,
  prepareChatAttachments,
  resolveChatModel,
} from "./attachments.js";

const attachmentSchema = z.object({
  name: z.string().min(1).max(240),
  mime: z.string().min(1).max(160),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
  kind: z.enum(["image", "file"]),
  dataBase64: z.string().min(1).max(14 * 1024 * 1024),
});

const bodySchema = z.object({
  sessionId: z.string().optional(),
  message: z.string().max(20_000).default(""),
  model: z.string().min(1).max(128).optional(),
  agentId: z.string().min(1).max(128).optional(),
  kbIds: z.array(z.string()).max(50).optional(),
  attachAllOwn: z.boolean().optional(),
  toolIds: z.array(z.string().min(1).max(64)).max(64).optional(),
  deviceId: z.string().min(1).max(128).optional(),
  attachments: z.array(attachmentSchema).max(8).default([]),
}).refine((data) => data.message.trim().length > 0 || data.attachments.length > 0, {
  message: "message or attachments required",
});

let enabledCache: { at: number; set: Set<string>; maxOutput: Map<string, number> } | null = null;
const ENABLED_TTL_MS = 30_000;
// 预扣统一按 10000 token 的输出价计算（Go 侧按模型输出单价换算成算力点）。
const CHAT_RESERVE_OUTPUT_TOKENS = 10_000;
const DEFAULT_KB_MIN_SCORE = 0.35;
const DEFAULT_KB_TOPK = 8;
const DEFAULT_KB_MAX_CONTEXT_CHUNKS = 4;
const DEFAULT_KB_MAX_CHUNKS_PER_DOCUMENT = 2;
const SSE_HEARTBEAT_MS = 15_000;

function upstreamErrorDetails(error: unknown): { status?: number; code: string; message: string } {
  if (!error || typeof error !== "object") {
    return { code: "", message: error instanceof Error ? error.message : String(error ?? "") };
  }
  const value = error as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
    error?: { code?: unknown; message?: unknown };
    cause?: { code?: unknown; message?: unknown };
  };
  const status = typeof value.status === "number" ? value.status : undefined;
  const code = [value.code, value.error?.code, value.cause?.code]
    .find((item): item is string => typeof item === "string") ?? "";
  const message = [value.message, value.error?.message, value.cause?.message]
    .find((item): item is string => typeof item === "string") ?? "";
  return { status, code, message };
}

type ChatErrorProvider = "bailian" | "anthropic" | "ai-pixel";

export function chatModelErrorMessage(error: unknown, provider: ChatErrorProvider): string {
  if (error instanceof ChatModelStreamTimeoutError) return "模型响应超时，请重试";
  if (error instanceof ChatModelEmptyResponseError) return "模型未返回内容，请重试";

  const details = upstreamErrorDetails(error);
  const searchable = `${details.code} ${details.message}`;
  const providerName = provider === "bailian" ? "百炼" : provider === "ai-pixel" ? "AI Pixel" : "模型服务";
  if (details.status === 401 || /invalid[_ .-]?api[_ .-]?key|authentication/i.test(searchable)) {
    return `${providerName} API Key 无效或已失效`;
  }
  if (/Model\.AccessDenied|access.?denied|permission/i.test(searchable)) {
    return `${providerName}业务空间未授权该模型，请检查 Workspace ID、API Key 与模型权限`;
  }
  if (details.status === 404 || /model.*(not found|不存在)|invalid.*model/i.test(searchable)) {
    return `${providerName}中不存在该模型或当前地域不可用`;
  }
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|connection/i.test(searchable)) {
    return `无法连接${providerName}，请检查接入地址与网络`;
  }
  return "生成失败，请重试";
}

const BAILIAN_MODEL_ALIASES = new Map<string, string>([
  ["GLM-5.2", "glm-5.2"],
]);

export function providerModelId(model: string, provider: "bailian" | "anthropic"): string {
  return provider === "bailian" ? (BAILIAN_MODEL_ALIASES.get(model) ?? model) : model;
}

const TOOL_LABELS: Record<string, string> = {
  terminal_exec: "执行命令",
  fs_read: "读取文件",
  fs_write: "写入文件",
  fs_list: "列出目录",
  fs_stat: "查看文件信息",
  fs_edit: "编辑文件",
  fs_glob: "查找文件",
  fs_grep: "搜索文本",
  fs_mkdir: "创建文件夹",
  fs_move: "移动文件",
  fs_delete: "删除文件",
  fs_copy: "复制文件",
  browser_navigate: "打开网页",
  browser_snapshot: "读取网页结构",
  browser_click: "点击网页",
  browser_type: "输入网页文本",
  browser_wait: "等待网页",
  browser_evaluate: "执行网页脚本",
  browser_screenshot: "网页截图",
  browser_console: "读取网页日志",
  browser_network: "读取网络请求",
  browser_close: "关闭浏览器",
};

function compactText(value: string, maxLength = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function objectInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function stringInput(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function summarizeToolInput(name: string, input: unknown, labels: Record<string, string> = TOOL_LABELS): string {
  const data = objectInput(input);
  const path = stringInput(data, "path");
  const cwd = stringInput(data, "cwd");
  switch (name) {
    case "terminal_exec": {
      const command = stringInput(data, "command");
      return compactText([command ? `命令：${command}` : "执行命令", cwd ? `目录：${cwd}` : ""].filter(Boolean).join("；"));
    }
    case "fs_read":
    case "fs_write":
    case "fs_list":
    case "fs_stat":
    case "fs_edit":
    case "fs_mkdir":
    case "fs_delete":
      return path ? compactText(`路径：${path}`) : labels[name] ?? name;
    case "fs_move":
    case "fs_copy": {
      const from = stringInput(data, "from") ?? stringInput(data, "source") ?? path;
      const to = stringInput(data, "to") ?? stringInput(data, "destination");
      return compactText([from ? `从：${from}` : "", to ? `到：${to}` : ""].filter(Boolean).join("；") || (labels[name] ?? name));
    }
    case "fs_grep": {
      const pattern = stringInput(data, "pattern") ?? stringInput(data, "query");
      return compactText([pattern ? `关键词：${pattern}` : "", path ? `范围：${path}` : ""].filter(Boolean).join("；") || "搜索文本");
    }
    case "fs_glob": {
      const pattern = stringInput(data, "pattern") ?? stringInput(data, "glob");
      return compactText([pattern ? `匹配：${pattern}` : "", path ? `范围：${path}` : ""].filter(Boolean).join("；") || "查找文件");
    }
    case "browser_navigate": {
      const url = stringInput(data, "url");
      return url ? compactText(`网址：${url}`) : "打开网页";
    }
    case "browser_click":
    case "browser_type": {
      const selector = stringInput(data, "selector");
      const text = stringInput(data, "text");
      return compactText([
        selector ? `目标：${selector}` : "",
        name === "browser_type" && text ? `输入：${text.length} 字` : "",
      ].filter(Boolean).join("；") || (labels[name] ?? name));
    }
    default:
      return labels[name] ?? name;
  }
}

function toolOutputPreview(event: RunTurnToolEvent): string | undefined {
  const raw = event.error ?? event.output;
  if (!raw) return undefined;
  return compactText(raw, 220);
}

function toToolPayload(event: RunTurnToolEvent, labels: Record<string, string> = TOOL_LABELS) {
  return {
    id: event.id,
    name: event.name,
    label: labels[event.name] ?? event.name,
    status: event.status,
    detail: summarizeToolInput(event.name, event.input, labels),
    elapsedMs: event.elapsedMs,
    outputPreview: toolOutputPreview(event),
  };
}

function positiveNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveIntEnv(name: string, fallback: number): number {
  return Math.floor(positiveNumberEnv(name, fallback));
}

/**
 * 测试钩子：直接注入启用集（仅测试用）。
 */
export function __setEnabledForTest(set: Set<string>): void {
  enabledCache = { at: Date.now(), set, maxOutput: new Map() };
}

/**
 * 校验模型是否启用，30s 缓存，billing 故障降级放行。
 * 同时缓存每个模型的 maxOutputTokens（单次输出上限），供 resolveModelMaxOutput 读取。
 */
async function isModelEnabled(billing: ReturnType<typeof createBillingClient>, model: string): Promise<boolean> {
  const now = Date.now();
  if (!enabledCache || now - enabledCache.at >= ENABLED_TTL_MS) {
    try {
      const r = await billing.listEnabledModels();
      enabledCache = {
        at: now,
        set: new Set(r.data.map((m) => m.model)),
        maxOutput: new Map(r.data.map((m) => [m.model, Number(m.maxOutputTokens) || 0])),
      };
    } catch {
      return true; // billing 故障降级放行；reserve 计价仍是安全网
    }
  }
  return enabledCache.set.has(model);
}

/**
 * 读取模型配置的单次输出上限（0=未配置，交由 run 内的全局默认兜底）。
 * 依赖 isModelEnabled 已在本次请求前刷新缓存。
 */
function resolveModelMaxOutput(model: string): number {
  return enabledCache?.maxOutput.get(model) ?? 0;
}

export async function chatRoutes(app: FastifyInstance) {
  const prisma = getPrisma();
  const redis = getRedis();
  const cfg = loadLlmConfig();
  const client = createLlmClient(cfg);
  const billing = createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });

  app.post("/api/chat", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
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

    // 模型校验：取锁前，无副作用 400
    const requestedModel = parsed.data.model ?? cfg.defaultModel;
    const hasImageAttachment = parsed.data.attachments.some((a) => a.kind === "image" || isImageMime(a.mime));
    const modelResolution = resolveChatModel(requestedModel, hasImageAttachment);
    const billingModel = modelResolution.model;
    const model = providerModelId(billingModel, cfg.provider);
    const errorProvider: ChatErrorProvider = cfg.modelRoutes?.some((route) => route.model === billingModel)
      ? "ai-pixel"
      : cfg.provider;
    if (!(await isModelEnabled(billing, billingModel))) {
      return reply.code(400).send({ error: "模型不可用" });
    }

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
      model: billingModel,
      providerModel: model,
      requestedModel,
      fallbackReason: modelResolution.fallbackReason,
    });

    let reservedTurn: { operationId: string; userId: string; model: string } | null = null;
    let reservedTurnSettled = false;
    const settleReservedTurnAsNoCharge = async () => {
      if (!reservedTurn || reservedTurnSettled) return;
      reservedTurnSettled = true;
      await billing.settle({
        operationId: reservedTurn.operationId,
        userId: reservedTurn.userId,
        model: reservedTurn.model,
        inputTokens: 0,
        outputTokens: 0,
      }).catch((settleErr) => {
        app.log.warn({ err: settleErr, operationId: reservedTurn?.operationId }, "failed to refund reserved chat turn");
      });
    };

    try {
      const preparedAttachments = await prepareChatAttachments(parsed.data.attachments).catch((err) => {
        send("error", { message: err instanceof Error ? err.message : "附件解析失败" });
        return null;
      });
      if (!preparedAttachments) return;

      const storedUserContent = `${parsed.data.message.trim()}${preparedAttachments.storedLabel}`.trim() || "[附件]";
      const queryText = `${parsed.data.message.trim()}\n${preparedAttachments.searchableText}`.trim() || storedUserContent;

      // 生成幂等键
      const turnId = `turn:${sessionId}:${Date.now()}`;

      try {
        await billing.reserve({
          operationId: turnId,
          userId,
          type: "chat",
          model: billingModel,
          inputTokens: estimateInputTokens(parsed.data.message, preparedAttachments),
          maxOutputTokens: CHAT_RESERVE_OUTPUT_TOKENS,
        });
        reservedTurn = { operationId: turnId, userId, model: billingModel };
      } catch (e) {
        if (e instanceof InsufficientBalanceError) {
          send("error", { message: "余额不足，请充值算力点", code: "INSUFFICIENT_BALANCE" });
          await release();
          reply.raw.end();
          return;
        }
        throw e;
      }

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
          const embedResult = await billableEmbed({
            billing,
            cfg: embCfg,
            userId,
            operationId: `${turnId}:embedding`,
            input: queryText,
          });
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
        } catch (error) {
          if (error instanceof InsufficientBalanceError) {
            await settleReservedTurnAsNoCharge();
            send("error", { message: "余额不足，请充值算力点", code: "INSUFFICIENT_BALANCE" });
            return;
          }
          if (error instanceof Error && error.message.startsWith("billing ")) {
            await settleReservedTurnAsNoCharge();
            send("error", { message: "计费服务不可用" });
            return;
          }
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

      const modelMaxOutput = resolveModelMaxOutput(billingModel);
      const result = await runTurn({
        client,
        model,
        maxOutputTokens: modelMaxOutput > 0 ? modelMaxOutput : undefined,
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

      // 结算：按实际 token 用量结算，多退少补
      await billing.settle({
        operationId: turnId,
        userId,
        model: billingModel,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
      reservedTurnSettled = true;

      // 持久化助手回复
      if (assistantText) {
        await prisma.message.create({
          data: { sessionId, role: "assistant", content: assistantText, model: billingModel },
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
      await settleReservedTurnAsNoCharge();
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
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });

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
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });

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
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });

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
