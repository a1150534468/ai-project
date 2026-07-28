import "./env.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import { getPrisma, getRedis } from "@ai-assistant/db";
import { authRoutes } from "./auth/routes.js";
import { chatRoutes } from "./chat/routes.js";
import { billingRoutes } from "./billing/routes.js";
import { memoryRoutes } from "./memory/routes.js";
import { deviceRoutes } from "./device/routes.js";
import { toolRoutes } from "./tools/routes.js";
import { adminRoutes } from "./admin/routes.js";
import { adminUserRoutes } from "./admin/user-routes.js";
import { adminCodeRoutes } from "./admin/code-routes.js";
import { adminBalanceRoutes } from "./admin/balance-routes.js";
import { adminModelRoutes } from "./admin/model-routes.js";
import { adminVipRoutes } from "./admin/vip-routes.js";
import { adminAuditRoutes } from "./admin/audit-routes.js";
import { adminOrderRoutes } from "./admin/order-routes.js";
import { resourceRoutes } from "./admin/resource-routes.js";
import { announcementRoutes } from "./admin/announcement-routes.js";
import { adminMembershipRoutes } from "./admin/membership-routes.js";
import { adminKnowledgeRoutes } from "./admin/knowledge-routes.js";
import { membershipUserRoutes } from "./membership/routes.js";
import { agentRoutes } from "./agents/routes.js";
import { agentTeamRoutes } from "./agent-teams/routes.js";
import { imageWorkflowRoutes } from "./workflow/image-routes.js";
import { portraitWorkflowRoutes } from "./workflow/portrait-routes.js";
import { codexPetRoutes } from "./workflow/codex-pet-routes.js";
import { enqueueCodexPetProjectCleanup } from "./workflow/codex-pet-cleanup.js";
import { videoWorkflowRoutes } from "./workflow/video-routes.js";
import { dubRoutes } from "./workflow/dub-routes.js";
import { adminDubRoutes } from "./admin/dub-routes.js";
import { startDubReaper } from "./workflow/dub-reaper.js";
import { startLocalBusinessPromoRefundReaper } from "./workflow/local-business-promo-refund.js";
import { loadSkyhumanConfig } from "./workflow/dub-skyhuman-client.js";
import { finalizeProjectVideo } from "./workflow/dub-project-service.js";
import { buildAudioPublicUrl } from "./workflow/dub-audio-store.js";
import { loadS3Config, putObject, getObject } from "./storage/s3.js";
import { storeGeneratedVideo } from "./workflow/video-service.js";
import { createBillingClient } from "@ai-assistant/billing";
import { randomUUID } from "node:crypto";
import { ecomWorkflowRoutes } from "./workflow/ecom-routes.js";
import { localBusinessPromoRoutes } from "./workflow/local-business-promo-routes.js";
import { ecomMainImageRoutes } from "./workflow/ecom-main-routes.js";
import { ecomHelpWriteRoutes } from "./workflow/ecom-helpwrite-routes.js";
import { fanoutRoutes } from "./workflow/fanout-routes.js";
import { novelWorkflowRoutes } from "./workflow/novel-routes.js";
import { novelEngineRoutes } from "./novel/routes.js";
import { comicWorkflowRoutes } from "./workflow/comic-routes.js";
import { comicProductionRoutes } from "./workflow/comic-production-routes.js";
import { reportRoutes } from "./workflow/report-routes.js";
import { articleWorkflowRoutes } from "./workflow/article-workflow-routes.js";
import { analyticsRoutes } from "./admin/analytics-routes.js";
import { adminResellerRoutes } from "./admin/reseller-routes.js";
import { clientMenuRoutes } from "./admin/client-menu-routes.js";
import { resellerRoutes } from "./reseller/routes.js";
import { kbRoutes } from "./kb/routes.js";
import { wechatRoutes } from "./wechat/routes.js";
import { verifyToken } from "./auth/token.js";
import { registerHub } from "./connector/hub.js";
import { startReaper } from "./connector/reaper.js";
import { startAnalyticsRollup } from "./analytics/cron.js";
import { startKbReaper } from "./kb/reaper.js";
import { buildIndexDeps } from "./kb/deps.js";
import { makeS3 } from "./storage/s3.js";
import { seedPlatformChannel } from "./reseller/seed.js";
import { createLlmClient, loadLlmConfig } from "@ai-assistant/llm";
import { scheduledRoutes } from "./scheduled/routes.js";
import { startScheduledDispatcher } from "./scheduled/cron.js";
import { runScheduledTask } from "./scheduled/executor.js";
import { createRunAgent } from "./scheduled/agent-run.js";
import { createEmailSender, type SmtpEnv } from "./scheduled/email/sender.js";
import { createAiDraft } from "./scheduled/ai-draft-glue.js";
import { apiDocsEnabled, registerOpenApi, registerOpenApiUi } from "./docs/openapi.js";

function readCookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    if (trimmed.slice(0, index) !== name) continue;
    const value = trimmed.slice(index + 1);
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

export async function buildServer() {
  const app = Fastify({
    logger: true,
    bodyLimit: Number(process.env.API_BODY_LIMIT_BYTES) || 30 * 1024 * 1024,
  });

  // 全局错误处理：Fastify 默认处理器会把 error.message（含 Prisma 的绝对路径、
  // 查询结构等内部信息）原样写进 500 响应体，这里统一收敛为通用文案，详情只进日志。
  app.setErrorHandler((err: unknown, req, reply) => {
    const e = err as Partial<{ statusCode: number; message: string }>;
    const status =
      typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500
        ? e.statusCode
        : 500;
    if (status >= 500) req.log.error({ err }, "unhandled error");
    else req.log.warn({ err }, "request error");
    // SSE 等流式响应出错时响应头已发出，再 send 会二次写头，只能断开连接。
    if (reply.raw.headersSent) {
      reply.raw.end();
      return reply;
    }
    return reply
      .code(status)
      .send({ error: status >= 500 ? "服务器内部错误" : (typeof e.message === "string" ? e.message : "请求失败") });
  });

  const docsEnabled = apiDocsEnabled();
  // Swagger 必须先于业务路由注册，才能完整收集 Fastify 路由。
  if (docsEnabled) await registerOpenApi(app);

  // CORS：生产用 CORS_ORIGIN（逗号分隔白名单）；未设置时 dev 放开
  const corsOrigin = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim())
    : true;
  await app.register(cors, { origin: corsOrigin, credentials: true });
  await app.register(websocket);
  await app.register(multipart, {
    limits: {
      fileSize: Number(process.env.KB_MAX_FILE_BYTES) || 20971520,
    },
  });

  // 鉴权装饰器：从 Authorization: Bearer 解析 userId
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ")
      ? auth.slice(7)
      : readCookieValue(req.headers.cookie, "token");
    if (token) {
      const uid = verifyToken(token, process.env.SESSION_SECRET!);
      if (uid) (req as unknown as { userId: string }).userId = uid;
    }
  });

  await app.register(authRoutes);
  await app.register(chatRoutes);
  await app.register(wechatRoutes);
  await app.register(kbRoutes);
  await app.register(billingRoutes);
  await app.register(membershipUserRoutes);
  await app.register(agentRoutes, { redis: getRedis() });
  await app.register(agentTeamRoutes);
  await app.register(imageWorkflowRoutes);
  await app.register(portraitWorkflowRoutes);
  await app.register((instance) => codexPetRoutes(instance, { enqueueProjectCleanup: enqueueCodexPetProjectCleanup }));
  await app.register(videoWorkflowRoutes);
  await app.register(dubRoutes);
  await app.register(ecomWorkflowRoutes);
  await app.register(localBusinessPromoRoutes);
  await app.register(ecomMainImageRoutes);
  await app.register(ecomHelpWriteRoutes);
  await app.register(fanoutRoutes);
  await app.register(novelWorkflowRoutes);
  await app.register(novelEngineRoutes);
  await app.register(comicWorkflowRoutes);
  await app.register(comicProductionRoutes);
  await app.register((a) => reportRoutes(a, { prisma: getPrisma() }));
  await app.register(articleWorkflowRoutes);
  await app.register(memoryRoutes);
  await app.register(deviceRoutes);
  await app.register(toolRoutes);
  await app.register(adminRoutes);
  await app.register(adminUserRoutes);
  await app.register(adminCodeRoutes);
  await app.register(adminBalanceRoutes);
  await app.register(adminModelRoutes);
  await app.register(adminVipRoutes);
  await app.register(adminAuditRoutes);
  await app.register(adminOrderRoutes);
  await app.register(resourceRoutes);
  await app.register(adminDubRoutes);
  await app.register(announcementRoutes);
  await app.register(adminMembershipRoutes);
  await app.register(adminKnowledgeRoutes);
  await app.register(analyticsRoutes);
  await app.register(adminResellerRoutes);
  await app.register(clientMenuRoutes);
  await app.register(resellerRoutes);
  await registerHub(app);

  const reaperTimer = startReaper(getPrisma(), getRedis());
  const analyticsTimer = startAnalyticsRollup(getPrisma(), getRedis());
  const localBusinessPromoRefundReaperTimer = startLocalBusinessPromoRefundReaper({
    prisma: getPrisma(),
    redis: getRedis(),
    billing: createBillingClient({ baseUrl: process.env.BILLING_BASE_URL!, token: process.env.BILLING_INTERNAL_TOKEN! }),
  });

  const schedLlm = createLlmClient(loadLlmConfig());
  const schedBilling = createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });

  let schedTimer: NodeJS.Timeout | undefined;
  if (process.env.NODE_ENV !== "test") {
    const schedEmail = createEmailSender(process.env as unknown as SmtpEnv);
    const schedRunAgent = createRunAgent({ prisma: getPrisma(), client: schedLlm });
    schedTimer = startScheduledDispatcher(getPrisma(), getRedis(), (taskId, slotIso) =>
      runScheduledTask(
        { prisma: getPrisma(), redis: getRedis(), billing: schedBilling, emailSender: schedEmail, runAgent: schedRunAgent },
        taskId,
        slotIso,
      ),
    );
  }

  await app.register(scheduledRoutes, {
    aiDraft: createAiDraft({ redis: getRedis(), billing: schedBilling, client: schedLlm }),
  });

  if (docsEnabled) await registerOpenApiUi(app);

  // 飞天数字人任务 reaper：仅在配置了 SKYHUMAN_API_TOKEN 时启动（未配置则该功能整体不可用，不拖垮服务）
  if (process.env.SKYHUMAN_API_TOKEN) {
    const dubFetch: typeof fetch = (...a) => fetch(...a);
    const dubPrisma = getPrisma();
    const dubGetObject = async (key: string) => getObject(makeS3(loadS3Config()), key);
    const dubStoreVideoBuffer = async (a: { userId: string; buffer: Buffer }) => {
      const cfg = loadS3Config();
      const key = `dub/final/${a.userId}/${randomUUID()}.mp4`;
      await putObject(makeS3(cfg), key, a.buffer, "video/mp4", { acl: "public-read" });
      return { url: buildAudioPublicUrl(cfg, key), objectKey: key };
    };
    startDubReaper({
      prisma: dubPrisma,
      redis: getRedis(),
      billing: createBillingClient({ baseUrl: process.env.BILLING_BASE_URL!, token: process.env.BILLING_INTERNAL_TOKEN! }),
      cfg: loadSkyhumanConfig(),
      fetchFn: dubFetch,
      storeVideo: async (a) => {
        const s = await storeGeneratedVideo({ url: a.url, userId: a.userId, requestId: `dub-${a.taskId}`, requestIndex: 0, format: "mp4", fetchFn: dubFetch });
        return { url: s.originalUrl, objectKey: s.objectKey ?? "" };
      },
      // 兜底路径同样叠 BGM：回调丢失时靠 reaper 完成项目收尾
      finalizeProject: (a) => finalizeProjectVideo({ prisma: dubPrisma, ...a, getObject: dubGetObject, storeVideoBuffer: dubStoreVideoBuffer }),
    });
  }

  // 启动 KB reaper（仅在非测试环境，且 S3/embedding 已配置）
  // 未配置则跳过：知识库索引不可用，但 api/聊天等照常启动（解耦，避免 KB 配置缺失拖垮整个服务）
  let kbReaper: { stop: () => void } | null = null;
  if (process.env.NODE_ENV !== "test") {
    try {
      const deps = await buildIndexDeps(makeS3());
      kbReaper = startKbReaper(deps);
    } catch (err) {
      app.log.warn({ err }, "知识库存储/嵌入未配置，跳过 KB 索引 reaper（聊天等功能不受影响）");
    }
  }

  app.addHook("onClose", async () => {
    clearInterval(reaperTimer);
    clearInterval(analyticsTimer);
    if (schedTimer) clearInterval(schedTimer);
    clearInterval(localBusinessPromoRefundReaperTimer);
    kbReaper?.stop();
  });

  app.get("/health", async () => ({ ok: true }));
  return app;
}

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  const port = Number(process.env.PORT ?? 8090);
  buildServer().then(async (app) => {
    await seedPlatformChannel(getPrisma());
    app.listen({ port, host: "0.0.0.0" });

    // 优雅关闭：关 server、断开 PG/Redis 连接，避免连接泄漏
    const shutdown = async (sig: string) => {
      app.log.info(`收到 ${sig}，优雅关闭中…`);
      try {
        await app.close();
        await getPrisma().$disconnect();
        await getRedis().quit();
      } catch (err) {
        app.log.error(err);
      } finally {
        process.exit(0);
      }
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  });
}
