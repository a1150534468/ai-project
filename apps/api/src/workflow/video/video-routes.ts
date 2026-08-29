/**
 * 视频工作流路由门面:11 条路由 + reaper 挂载。文件从 992 行拆成本文件 + 5 个同域文件,
 * 对外导出仍然只有 `videoWorkflowRoutes` 一个名字,`video-routes.test.ts` 与
 * `video/index.ts` 零改动。
 *
 * 插件体本身留在这里,没有继续外移 —— 与 `image-routes.ts` 同样的取舍。原因是它闭包捕获了
 * `prisma` / `billing` / `fetchFn` / `scheduleTask` / 四个轮询旋钮 / 懒建的 `getLlmClient` /
 * 就地定义的 `reapHandlers`,把路由再抽走就得先造一个 context 对象把这些穿进去,那不是纯移动,
 * 而是一次会牵动测试的改造。
 *
 * `getLlmClient` 必须保持懒建:模块加载期就 `loadLlmConfig()` 会让缺 LLM 环境变量的部署
 * 起不来,而这 11 条路由里只有 3 条真的用得到 LLM。
 *
 * `startVideoReaper` 是有条件挂的,并且在 `app.onClose` 里 `clearInterval` —— 少了这一步,
 * 测试里每建一个 app 实例就漏一个定时器,进程退不出。
 *
 * 同域分工:schemas(入参校验)/ support(旋钮与叶子工具)/ contracts(计费与行形状)/
 * serialize(读取与对外 JSON)/ task(提交-轮询-结算-退款流水线)。
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../../auth/require-user.js";
import { getPrisma } from "@ai-assistant/db";
import { createBillingClient, InsufficientBalanceError } from "@ai-assistant/billing";
import { optimizeVideoPrompt } from "./video-prompt-optimize.js";
import { createLlmClient, loadLlmConfig } from "@ai-assistant/llm";
import type Anthropic from "@anthropic-ai/sdk";
import { analyzeMaterials, analyzeReference } from "../_shared/video-analyze-service.js";
import { generateScript, type ScriptPayload } from "./video-script-service.js";
import { probeVideoDurationSec } from "../_shared/video-probe.js";
import {
  isAutoDuration,
  loadVideoGenerationConfig,
  MAX_VIDEO_DURATION_SEC,
  probeVideoGenerationStatus,
  storeVideoMaterial,
  videoGenerationResourceKey,
  VIDEO_ANALYZE_IMAGE_RESOURCE_KEY,
  VIDEO_ANALYZE_VIDEO_SEC_RESOURCE_KEY,
} from "../_shared/video-service.js";
import { startVideoReaper, type VideoReapHandlers } from "./video-reaper.js";
import { videoOperationId, type VideoTaskRow } from "./video-shared.js";
import {
  analyzeMaterialsSchema,
  generateScriptSchema,
  optimizePromptSchema,
  videoRequestSchema,
} from "./video-route-schemas.js";
import {
  DEFAULT_MAX_POLL_ATTEMPTS,
  DEFAULT_POLL_INITIAL_DELAY_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_STATUS_TIMEOUT_MS,
  DEFAULT_SUBMIT_RETRIES,
  DEFAULT_SUBMIT_RETRY_DELAY_MS,
  loadNumber,
  safeErrorMessage,
  videoTaskStatus,
  VIDEO_REF_MAX_BYTES,
} from "./video-route-support.js";
import type { VideoWorkflowRouteDeps } from "./video-route-contracts.js";
import {
  configuredVideoPriceRows,
  hasInputVideo,
  listRecentTasks,
  listRecentVideos,
  normalizeRequest,
  requestPayloadJson,
  serializeTask,
  serializeVideo,
  sumInputDurationSec,
} from "./video-route-serialize.js";
import { finishSubmittedVideoTask, refundAndFailVideoTask, runVideoTask } from "./video-route-task.js";

export async function videoWorkflowRoutes(app: FastifyInstance, deps: VideoWorkflowRouteDeps = {}) {
  // 本文件 11 个路由全部必须登录，挂插件级。钩子和它保护的路由同文件，
  // 这样测试单独注册本文件时守卫不会凭空消失。
  app.addHook("preHandler", requireUser);

  const prisma = deps.prisma ?? getPrisma();
  const billing = deps.billing ?? createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });
  const fetchFn = deps.fetchFn ?? fetch;
  const scheduleTask = deps.scheduleTask ?? ((work: () => Promise<void>) => {
    void work().catch((error) => app.log.error(error));
  });
  const pollInitialDelayMs = deps.pollInitialDelayMs ?? loadNumber("VIDEO_POLL_INITIAL_DELAY_MS", DEFAULT_POLL_INITIAL_DELAY_MS);
  const pollIntervalMs = deps.pollIntervalMs ?? loadNumber("VIDEO_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS);
  const maxPollAttempts = deps.maxPollAttempts ?? loadNumber("VIDEO_MAX_POLL_ATTEMPTS", DEFAULT_MAX_POLL_ATTEMPTS);
  const submitRetries = deps.submitRetries ?? loadNumber("VIDEO_SUBMIT_RETRIES", DEFAULT_SUBMIT_RETRIES);
  const submitRetryDelayMs = deps.submitRetryDelayMs ?? loadNumber("VIDEO_SUBMIT_RETRY_DELAY_MS", DEFAULT_SUBMIT_RETRY_DELAY_MS);
  // 懒构造：仅在帮我写路由真正被调用时才读 LLM 配置，避免无关路由/测试因缺 LLM_* env 而在注册期报错。
  let llmClientCache: Anthropic | null = deps.llmClient ?? null;
  const getLlmClient = (): Anthropic => {
    if (!llmClientCache) llmClientCache = createLlmClient(loadLlmConfig());
    return llmClientCache;
  };

  // —— 主动扫（超时兜底）——
  // 之前 video 一个兜底都没有：进程被杀，行就永久停在 running，钱也永久悬空。
  // 注册在插件内而非 server.ts，因为续跑要用这里的 fetchFn / billing / 轮询参数。
  const reapHandlers: VideoReapHandlers = {
    probe: async (row) => {
      const probed = await probeVideoGenerationStatus({
        cfg: loadVideoGenerationConfig(),
        providerTaskId: row.providerTaskId,
        fetchFn,
        timeoutMs: loadNumber("VIDEO_STATUS_TIMEOUT_MS", DEFAULT_STATUS_TIMEOUT_MS),
      });
      if (probed.kind === "found") {
        return { kind: "found", upstreamFailed: probed.status.status === videoTaskStatus.failed };
      }
      return probed.kind === "missing" ? { kind: "missing" } : { kind: "unknown", reason: probed.reason };
    },
    resume: async (row) => {
      try {
        await finishSubmittedVideoTask({
          prisma,
          billing,
          fetchFn,
          task: row,
          cfg: loadVideoGenerationConfig(),
          // 续跑时不再等首次延迟：这一行早就提交出去了，没必要再空等 5 秒。
          pollInitialDelayMs: 0,
          pollIntervalMs,
          maxPollAttempts,
          // 兜底扫拿不到输入视频秒数：建行时写进 resultPayload 的请求体已被首次轮询
          // 覆盖成状态体。传 null 让结算那步跳过而不是拿 0 顶上（拿 0 会多退钱）。
          inputDurationSec: null,
          onSettleSkipped: (task) => app.log.warn(
            { requestId: task.requestId },
            "video reaper resumed a task with input video; skipped auto-duration settle (input seconds unknown)",
          ),
        });
      } catch (error) {
        // 续跑失败 → 与主路径同一套收尾：退款 + 置 failed。
        await refundAndFailVideoTask({ prisma, billing, task: row, error });
        throw error;
      }
    },
    fail: async (row, reason) => {
      await refundAndFailVideoTask({ prisma, billing, task: row, error: new Error(reason) });
    },
    onOutcome: (row, outcome, detail) => {
      if (outcome === "resumed" || outcome === "failed") {
        app.log.warn({ requestId: row.requestId, outcome, detail }, "video reaper handled a stale task");
      }
    },
  };

  if (deps.redis) {
    const timer = startVideoReaper({
      prisma,
      redis: deps.redis,
      handlers: reapHandlers,
      onError: (error) => app.log.error({ err: error }, "video reaper tick failed"),
    });
    // 必须清：插件可以被反复注册（测试、多实例 fastify），漏了就攒定时器。
    app.addHook("onClose", async () => { clearInterval(timer); });
  }

  app.get("/api/workflow/videos/pricing", async (req, reply) => {
    const userId = req.userId;
    if (!billing.listResourcePrices) return { success: true, data: configuredVideoPriceRows([]) };
    try {
      const rows = (await billing.listResourcePrices()).data ?? [];
      return { success: true, data: configuredVideoPriceRows(rows) };
    } catch (error) {
      app.log.warn({ err: error }, "load video pricing failed");
      return reply.code(502).send({ error: "获取视频价格失败" });
    }
  });

  // 帮我写「拆解」价：图片按张 + 视频按秒。供向导预估消耗与判断价格是否已配置。
  app.get("/api/workflow/videos/analyze-pricing", async (req, reply) => {
    const userId = req.userId;
    const empty = { rate: 0, perUnits: 1, enabled: false };
    if (!billing.listResourcePrices) return { success: true, data: { image: empty, videoSec: empty } };
    try {
      const rows = (await billing.listResourcePrices()).data ?? [];
      const pick = (key: string) => {
        const row = rows.find((r) => r.resourceKey === key);
        return { rate: row?.rate ?? 0, perUnits: row?.perUnits && row.perUnits > 0 ? row.perUnits : 1, enabled: row?.enabled ?? false };
      };
      return { success: true, data: { image: pick(VIDEO_ANALYZE_IMAGE_RESOURCE_KEY), videoSec: pick(VIDEO_ANALYZE_VIDEO_SEC_RESOURCE_KEY) } };
    } catch (error) {
      app.log.warn({ err: error }, "load analyze pricing failed");
      return reply.code(502).send({ error: "获取拆解价格失败" });
    }
  });

  app.post("/api/workflow/videos/optimize-prompt", async (req, reply) => {
    const userId = req.userId;
    const parsed = optimizePromptSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    try {
      const optimized = await optimizeVideoPrompt({ prompt: parsed.data.prompt, userId, materials: parsed.data.materials });
      return { success: true, data: { optimized } };
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        return reply.code(402).send({ error: "算力点不足，请充值", code: "INSUFFICIENT_BALANCE" });
      }
      app.log.warn({ err: error }, "optimize video prompt failed");
      return reply.code(502).send({ error: "提示词优化失败，请稍后再试" });
    }
  });

  app.get("/api/workflow/videos", async (req, reply) => {
    const userId = req.userId;
    const rows = await listRecentVideos(prisma, userId);
    return { success: true, data: rows.map(serializeVideo) };
  });

  // —— 帮我写：素材分析（图片按张 + 视频按秒计费）——
  app.post("/api/workflow/videos/analyze-materials", async (req, reply) => {
    const userId = req.userId;
    const parsed = analyzeMaterialsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    try {
      const insight = await analyzeMaterials({
        userId,
        requestId: parsed.data.requestId,
        materials: parsed.data.materials,
        billing,
        ...(deps.visionCfg ? { cfg: deps.visionCfg } : {}),
        ...(deps.callVisionFn ? { callVisionFn: deps.callVisionFn } : {}),
        resolveVideoSeconds: async (urls) => {
          const rows = await prisma.videoMaterial.findMany({
            where: { url: { in: [...new Set(urls)] } },
            select: { url: true, durationSec: true },
          });
          return new Map(rows.map((r) => [r.url, r.durationSec]));
        },
        fetchFn,
      });
      return { success: true, data: insight };
    } catch (error) {
      if (error instanceof InsufficientBalanceError) return reply.code(402).send({ error: "视频点不足，请充值", code: "INSUFFICIENT_BALANCE" });
      app.log.warn({ err: error }, "analyze materials failed");
      return reply.code(502).send({ error: safeErrorMessage(error) });
    }
  });

  // —— 帮我写：参考视频拆解（≤50MB，按秒计费）——
  app.post("/api/workflow/videos/analyze-reference", async (req, reply) => {
    const userId = req.userId;
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "请选择参考视频" });
    if (!file.mimetype.startsWith("video/")) return reply.code(400).send({ error: "仅支持视频文件" });
    const buffer = Buffer.from(await file.toBuffer());
    if (buffer.byteLength > VIDEO_REF_MAX_BYTES) return reply.code(400).send({ error: "参考视频不能超过 50MB" });
    try {
      const durationSec = await probeVideoDurationSec(buffer);
      const result = await analyzeReference({
        userId,
        // randomUUID 保证 operationId 全局唯一，避免多用户同毫秒上传导致的计费冲突
        requestId: `ref-${userId}-${randomUUID()}`,
        videoBuffer: buffer,
        mime: file.mimetype,
        durationSec,
        billing,
        ...(deps.visionCfg ? { cfg: deps.visionCfg } : {}),
        ...(deps.callVisionFn ? { callVisionFn: deps.callVisionFn } : {}),
      });
      return { success: true, data: result };
    } catch (error) {
      if (error instanceof InsufficientBalanceError) return reply.code(402).send({ error: "视频点不足，请充值", code: "INSUFFICIENT_BALANCE" });
      app.log.warn({ err: error }, "analyze reference failed");
      return reply.code(502).send({ error: safeErrorMessage(error) });
    }
  });

  // —— 帮我写：脚本生成（token 原价×2 计费）——
  app.post("/api/workflow/videos/generate-script", async (req, reply) => {
    const userId = req.userId;
    const parsed = generateScriptSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    try {
      const result = await generateScript({ userId, payload: parsed.data as ScriptPayload, client: getLlmClient(), billing });
      return { success: true, data: result };
    } catch (error) {
      if (error instanceof InsufficientBalanceError) return reply.code(402).send({ error: "算力点不足，请充值", code: "INSUFFICIENT_BALANCE" });
      app.log.warn({ err: error }, "generate script failed");
      return reply.code(502).send({ error: safeErrorMessage(error) });
    }
  });

  app.get("/api/workflow/videos/tasks", async (req, reply) => {
    const userId = req.userId;
    const rows = await listRecentTasks(prisma, userId);
    return { success: true, data: rows.map(serializeTask) };
  });

  app.get("/api/workflow/videos/state", async (req, reply) => {
    const userId = req.userId;
    const [videos, tasks] = await Promise.all([
      listRecentVideos(prisma, userId),
      listRecentTasks(prisma, userId),
    ]);
    return {
      success: true,
      data: {
        videos: videos.map(serializeVideo),
        tasks: tasks.map(serializeTask),
      },
    };
  });

  app.post("/api/workflow/videos/materials", async (req, reply) => {
    const userId = req.userId;
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "请选择素材文件" });
    const buffer = Buffer.from(await file.toBuffer());
    try {
      const stored = await storeVideoMaterial({
        userId,
        filename: file.filename,
        mime: file.mimetype,
        buffer,
      });
      // 缓存权威时长（按 URL 键），供「有输入视频」复合计费按输入时长扣费。
      if (stored.mime.startsWith("video/")) {
        await prisma.videoMaterial.upsert({
          where: { url: stored.url },
          update: { durationSec: stored.durationSec, objectKey: stored.objectKey, mime: stored.mime },
          create: {
            userId,
            url: stored.url,
            objectKey: stored.objectKey,
            mime: stored.mime,
            durationSec: stored.durationSec,
          },
        });
      }
      return { success: true, data: stored };
    } catch (error) {
      return reply.code(400).send({ error: safeErrorMessage(error) });
    }
  });

  app.post("/api/workflow/videos/generate", async (req, reply) => {
    const userId = req.userId;
    const parsed = videoRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const request = normalizeRequest(parsed.data);
    const inputVideo = hasInputVideo(parsed.data);
    const resourceKey = videoGenerationResourceKey(request.model, request.resolution, inputVideo);
    const operationId = videoOperationId(request.requestId);

    const existingTask = await prisma.videoGenerationTask.findFirst({
      where: { userId, requestId: request.requestId },
    });
    if (existingTask) {
      const videos = await listRecentVideos(prisma, userId);
      return reply.code(existingTask.status === videoTaskStatus.completed ? 200 : 202).send({
        success: true,
        data: {
          task: serializeTask(existingTask),
          videos: videos.map(serializeVideo),
        },
      });
    }

    // 有输入视频时按复合计费：输入视频秒数 × 输入单价 + 输出秒数 × 输出单价。
    // 输入时长为计费依据，必须取后端上传时 ffprobe 落库的权威值，不可信客户端。
    let inputDurationSec = 0;
    if (inputVideo) {
      inputDurationSec = await sumInputDurationSec(prisma, parsed.data.videoWithRoles.map((item) => item.url));
      if (inputDurationSec <= 0) {
        return reply.code(400).send({ error: "无法获取输入视频时长，请通过上传素材接口重新上传输入视频" });
      }
    }

    // 自动时长（0/-1）：下单不知实际输出秒，先按最大 15s 预扣，出结果后按实际秒结算退差额。
    const autoDuration = isAutoDuration(request.durationSec);
    const chargeOutputUnits = autoDuration ? MAX_VIDEO_DURATION_SEC : request.durationSec;

    let chargedPoints = 0;
    try {
      const charged = await billing.chargeResource({
        operationId,
        userId,
        resourceKey,
        units: chargeOutputUnits,
        ...(inputVideo ? { inputUnits: inputDurationSec } : {}),
        accountType: "video",
      });
      chargedPoints = charged.charged;
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        return reply.code(402).send({ error: "视频点不足，请充值", code: "INSUFFICIENT_BALANCE" });
      }
      return reply.code(502).send({ error: "视频计费未配置或服务不可用" });
    }

    let task: VideoTaskRow;
    try {
      task = await prisma.videoGenerationTask.create({
        data: {
          userId,
          requestId: request.requestId,
          providerTaskId: null,
          prompt: request.prompt,
          model: request.model,
          aspectRatio: request.aspectRatio,
          resolution: request.resolution,
          durationSec: request.durationSec,
          generateAudio: request.generateAudio,
          hasInputVideo: inputVideo,
          resourceKey,
          chargedPoints,
          status: videoTaskStatus.running,
          progress: 0,
          error: null,
          resultPayload: requestPayloadJson(request),
          completedAt: null,
        },
      });
    } catch (error) {
      await billing.refundResource(operationId).catch(() => undefined);
      app.log.error(error);
      return reply.code(500).send({ error: "创建视频任务失败" });
    }

    scheduleTask(async () => {
      await runVideoTask({
        prisma,
        billing,
        fetchFn,
        task,
        request,
        pollInitialDelayMs,
        pollIntervalMs,
        maxPollAttempts,
        inputDurationSec,
        submitRetries,
        submitRetryDelayMs,
        onSubmitRetry: (err, attempt) => app.log.warn({ err, attempt, requestId: request.requestId }, "video submit retry"),
      });
    });

    const videos = await listRecentVideos(prisma, userId);
    return reply.code(202).send({
      success: true,
      data: {
        task: serializeTask(task),
        videos: videos.map(serializeVideo),
      },
    });
  });
}
