import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type Anthropic from "@anthropic-ai/sdk";
import { getPrisma, getRedis } from "@yc/db";
import { createBillingClient } from "@yc/billing";
import { createLlmClient, loadLlmConfig } from "@yc/llm";
import { analyzeDubVideo, type AnalyzeBilling } from "./dub-analyze-service.js";
import { rewriteDubScript, type RewriteBilling } from "./dub-rewrite-service.js";
import { buildKbContext } from "./dub-kb-context.js";
import { loadSkyhumanConfig, type SkyhumanConfig } from "./dub-skyhuman-client.js";
import { listAvatars, setAvatarFavorite, removeAvatar, startAvatarClone, pollFinalize, type AvatarBilling, type StoreVideoFn } from "./dub-avatar-service.js";
import { startVideoCreate } from "./dub-video-service.js";
import { probeVideoDurationSec } from "./video-probe.js";
import { storeGeneratedVideo, VIDEO_ANALYZE_VIDEO_SEC_RESOURCE_KEY } from "./video-service.js";
import { DUB_TTS_CHAR_KEY, DUB_AVATAR_CLONE_KEY, DUB_VIDEO_SEC_KEY, DUB_PARSE_VIDEO_KEY, DUB_PARSE_QUOTA_PER_HOUR } from "./dub-constants.js";
import { parseShareToStored } from "./dub-parse-service.js";
import { loadParseConfig, type ParseConfig } from "./dub-parse-client.js";
import { consumeDubParseQuota } from "./dub-parse-ratelimit.js";
import { loadS3Config, makeS3, putObject, getObject } from "../storage/s3.js";
import { loadMimoConfig, type MimoConfig } from "./dub-mimo-client.js";
import { generateTts } from "./dub-tts-service.js";
import { storeAudioBuffer, buildAudioPublicUrl } from "./dub-audio-store.js";
import { listEnabledBgmPresets } from "./dub-bgm-service.js";
import { createProject, listProjects, getProject, patchProject, deleteProject, assertReadyForGenerate, finalizeProjectVideo } from "./dub-project-service.js";
import { DUB_PRESET_VOICES, isPresetVoice } from "./dub-tts-voices.js";
import { DUB_AVATAR_VIDEO_MAX_BYTES, DUB_AUDIO_MAX_BYTES, DUB_TTS_TEXT_MAX_CHARS, DUB_TTS_CLONE_REF_MAX_BYTES, DUB_ANALYZE_VIDEO_MAX_BYTES, DUB_REWRITE_TEXT_MAX_CHARS, DUB_BGM_MAX_BYTES, DUB_STAGE, type DubTtsMode } from "./dub-constants.js";

interface PricingBilling {
  listResourcePrices?: () => Promise<{ data: Array<{ resourceKey: string; rate: number; perUnits: number; enabled: boolean }> }>;
}

export async function dubRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const redis = getRedis();
  const billing = createBillingClient({ baseUrl: process.env.BILLING_BASE_URL!, token: process.env.BILLING_INTERNAL_TOKEN! }) as unknown as AvatarBilling & RewriteBilling & AnalyzeBilling & PricingBilling;
  // 懒构造 LLM client：仅在分析/洗稿路由真正被调用时才读 LLM 配置，避免注册期因缺 LLM_* env 报错
  let llmClientCache: Anthropic | null = null;
  const getLlmClient = (): Anthropic => {
    if (!llmClientCache) llmClientCache = createLlmClient(loadLlmConfig());
    return llmClientCache;
  };
  const fetchFn: typeof fetch = (...a) => fetch(...a);
  const scheduleTask = (fn: () => Promise<void>) => { void fn().catch((e) => app.log.error(e)); };
  const storeVideo: StoreVideoFn = async (a) => {
    const s = await storeGeneratedVideo({ url: a.url, userId: a.userId, requestId: `dub-${a.taskId}`, requestIndex: 0, format: "mp4", fetchFn });
    return { url: s.originalUrl, objectKey: s.objectKey ?? "" };
  };
  const getObjectByKey = async (key: string) => getObject(makeS3(loadS3Config()), key);
  const storeVideoBuffer = async (a: { userId: string; buffer: Buffer }) => {
    const cfg = loadS3Config();
    const key = `dub/final/${a.userId}/${randomUUID()}.mp4`;
    await putObject(makeS3(cfg), key, a.buffer, "video/mp4", { acl: "public-read" });
    return { url: buildAudioPublicUrl(cfg, key), objectKey: key };
  };
  const finalizeProject = (a: { projectId: string; videoUrl: string; videoObjectKey: string }) =>
    finalizeProjectVideo({ prisma, ...a, getObject: getObjectByKey, storeVideoBuffer });

  // 懒加载飞天配置：缺 token 时不在注册期抛错（否则拖垮所有 buildServer 测试），用到时返回 null → 502。
  let cachedCfg: SkyhumanConfig | null | undefined;
  function getCfg(): SkyhumanConfig | null {
    if (cachedCfg === undefined) {
      try { cachedCfg = loadSkyhumanConfig(); } catch { cachedCfg = null; }
    }
    return cachedCfg;
  }

  // 懒加载 MiMo 配置：缺 key 不在注册期抛错，用到时返回 null → 502。
  let cachedMimo: MimoConfig | null | undefined;
  function getMimo(): MimoConfig | null {
    if (cachedMimo === undefined) { try { cachedMimo = loadMimoConfig(); } catch { cachedMimo = null; } }
    return cachedMimo;
  }

  // 懒加载解析配置：缺 key 不在注册期抛错，用到时返回 null → 502。
  let cachedParse: ParseConfig | null | undefined;
  function getParseCfg(): ParseConfig | null {
    if (cachedParse === undefined) { try { cachedParse = loadParseConfig(); } catch { cachedParse = null; } }
    return cachedParse;
  }

  function uid(req: unknown): string | null { return (req as { userId?: string }).userId || null; }

  app.get("/api/workflow/dub/tts/voices", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    return { success: true, data: DUB_PRESET_VOICES };
  });

  app.post("/api/workflow/dub/tts", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const mimo = getMimo(); if (!mimo) return reply.code(502).send({ error: "MiMo 未配置" });
    const b = (req.body ?? {}) as { mode?: string; text?: string; format?: string; voice?: string; description?: string; style?: string; refAudioBase64?: string; refAudioMime?: string };
    const mode = b.mode as DubTtsMode | undefined;
    if (mode !== "preset" && mode !== "design" && mode !== "clone") return reply.code(400).send({ error: "mode 无效" });
    const text = (b.text ?? "").trim();
    if (!text) return reply.code(400).send({ error: "请输入口播文案" });
    if (text.length > DUB_TTS_TEXT_MAX_CHARS) return reply.code(400).send({ error: `文案不能超过 ${DUB_TTS_TEXT_MAX_CHARS} 字` });
    const format = b.format === "mp3" ? "mp3" : "wav";
    if (mode === "preset" && (!b.voice || !isPresetVoice(b.voice))) return reply.code(400).send({ error: "请选择预置音色" });
    if (mode === "design" && !b.description?.trim()) return reply.code(400).send({ error: "请填写音色描述" });
    let refAudioDataUri: string | undefined;
    if (mode === "clone") {
      if (!b.refAudioBase64 || !b.refAudioMime) return reply.code(400).send({ error: "请上传参考音频" });
      const bytes = Buffer.from(b.refAudioBase64, "base64").byteLength;
      if (bytes > DUB_TTS_CLONE_REF_MAX_BYTES) return reply.code(413).send({ error: "参考音频不能超过 10MB" });
      refAudioDataUri = `data:${b.refAudioMime};base64,${b.refAudioBase64}`;
    }
    try {
      const r = await generateTts({
        cfg: mimo, fetchFn, billing, userId, mode, text, format,
        voice: b.voice, description: b.description, style: b.style, refAudioDataUri,
        storeAudio: storeAudioBuffer, probeDurationSec: probeVideoDurationSec,
      });
      return { success: true, data: { audioUrl: r.audioUrl, objectKey: r.objectKey, durationSec: r.durationSec, chargedPoints: r.chargedPoints } };
    } catch (e) {
      if ((e as Error)?.name === "InsufficientBalanceError") return reply.code(402).send({ error: "算力点不足，请充值" });
      app.log.error({ err: e, route: "dub/tts", mode }, "语音合成失败");
      return reply.code(502).send({ error: "语音合成失败：" + errText(e) });
    }
  });

  // 向导用：展示每步预计消耗；未配价（enabled=false）时前端置灰该步。真实扣费仍在后端。
  app.get("/api/workflow/dub/pricing", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const empty = { rate: 0, perUnits: 1, enabled: false };
    if (!billing.listResourcePrices) return { success: true, data: { analyzeVideoSec: empty, ttsChar: empty, avatarClone: empty, videoSec: empty, parseVideo: empty } };
    try {
      const rows = (await billing.listResourcePrices()).data ?? [];
      const pick = (key: string) => {
        const row = rows.find((r) => r.resourceKey === key);
        return { rate: row?.rate ?? 0, perUnits: row?.perUnits && row.perUnits > 0 ? row.perUnits : 1, enabled: row?.enabled ?? false };
      };
      return { success: true, data: {
        analyzeVideoSec: pick(VIDEO_ANALYZE_VIDEO_SEC_RESOURCE_KEY),
        ttsChar: pick(DUB_TTS_CHAR_KEY),
        avatarClone: pick(DUB_AVATAR_CLONE_KEY),
        videoSec: pick(DUB_VIDEO_SEC_KEY),
        parseVideo: pick(DUB_PARSE_VIDEO_KEY),
      } };
    } catch (error) {
      app.log.warn({ err: error }, "load dub pricing failed");
      return reply.code(502).send({ error: "获取价格失败" });
    }
  });

  app.get("/api/workflow/dub/bgm", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    return { success: true, data: await listEnabledBgmPresets(prisma) };
  });

  app.post("/api/workflow/dub/bgm/upload", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const file = await req.file(); if (!file) return reply.code(400).send({ error: "请选择 BGM 音频" });
    if (!file.mimetype.startsWith("audio/")) return reply.code(400).send({ error: "仅支持音频文件" });
    const buffer = Buffer.from(await file.toBuffer());
    if (buffer.byteLength > DUB_BGM_MAX_BYTES) return reply.code(413).send({ error: "BGM 不能超过 20MB" });
    const ext = file.mimetype.includes("wav") ? "wav" : "mp3";
    return { success: true, data: await storeAudioBuffer({ userId, buffer, mime: file.mimetype, ext }) };
  });

  app.post("/api/workflow/dub/projects", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const title = (req.body as { title?: string } | undefined)?.title;
    return { success: true, data: await createProject(prisma, userId, title) };
  });

  app.get("/api/workflow/dub/projects", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    return { success: true, data: await listProjects(prisma, userId) };
  });

  app.get("/api/workflow/dub/projects/:id", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const p = await getProject(prisma, userId, (req.params as { id: string }).id);
    return p ? { success: true, data: p } : reply.code(404).send({ error: "项目不存在" });
  });

  app.patch("/api/workflow/dub/projects/:id", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const ok = await patchProject(prisma, userId, (req.params as { id: string }).id, (req.body ?? {}) as Record<string, unknown>);
    return ok ? { success: true } : reply.code(404).send({ error: "项目不存在或无可更新字段" });
  });

  app.delete("/api/workflow/dub/projects/:id", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const ok = await deleteProject(prisma, userId, (req.params as { id: string }).id);
    return ok ? { success: true } : reply.code(404).send({ error: "项目不存在" });
  });

  app.post("/api/workflow/dub/projects/:id/generate", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const cfg = getCfg(); if (!cfg) return reply.code(502).send({ error: "飞天未配置" });
    const projectId = (req.params as { id: string }).id;
    const project = await getProject(prisma, userId, projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    // 资金护栏：已在成片中的项目不得重复下单（刷新页面/重复点击会二次扣费）。失败任务由 reaper 90s 内置为 failed 后可重试。
    if (project.stage === DUB_STAGE.generating || project.stage === DUB_STAGE.mixing) {
      return reply.code(409).send({ error: "成片进行中，请稍候" });
    }
    try {
      assertReadyForGenerate(project);
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    try {
      const audioKey = project.audioObjectKey!;
      const audioBuffer = await getObjectByKey(audioKey);
      // 必须按真实后缀推导 mime：TTS 可产出 wav 或 mp3，写死 wav 会让飞天按错误扩展名取流（错误码 2013）
      const audioMime = audioKey.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : "audio/wav";
      const task = await startVideoCreate({
        prisma, redis, billing, cfg, fetchFn, userId, projectId,
        avatarId: project.avatarId!, title: project.title,
        audioBuffer, audioMime,
        probeDurationSec: probeVideoDurationSec, storeVideo, finalizeProject, scheduleTask,
      });
      await patchProject(prisma, userId, projectId, { stage: DUB_STAGE.generating });
      return reply.code(202).send({ success: true, data: { taskId: task.id } });
    } catch (e) {
      if ((e as Error).message.includes("形象不存在")) return reply.code(403).send({ error: (e as Error).message });
      return reply.code(billingErrCode(e)).send({ error: billingErrMsg(e) });
    }
  });

  app.post("/api/workflow/dub/projects/:id/remix", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const project = await getProject(prisma, userId, (req.params as { id: string }).id);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    if (!project.resultObjectKey || !project.resultVideoUrl) return reply.code(400).send({ error: "尚无成片可混流" });
    await finalizeProject({ projectId: project.id, videoUrl: project.resultVideoUrl, videoObjectKey: project.resultObjectKey });
    return { success: true };
  });

  app.post("/api/workflow/dub/analyze", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const file = await req.file(); if (!file) return reply.code(400).send({ error: "请选择参考视频" });
    if (!file.mimetype.startsWith("video/")) return reply.code(400).send({ error: "仅支持视频文件" });
    const buffer = Buffer.from(await file.toBuffer());
    if (buffer.byteLength > DUB_ANALYZE_VIDEO_MAX_BYTES) return reply.code(413).send({ error: "参考视频不能超过 50MB" });
    try {
      const durationSec = await probeVideoDurationSec(buffer);
      const analysis = await analyzeDubVideo({
        userId, requestId: `dub-${userId}-${randomUUID()}`,
        videoBuffer: buffer, mime: file.mimetype, durationSec,
        billing,
      });
      return { success: true, data: analysis };
    } catch (e) {
      if ((e as Error)?.name === "InsufficientBalanceError") return reply.code(402).send({ error: "算力点不足，请充值" });
      app.log.error({ err: e, route: "dub/analyze" }, "视频拆解失败");
      return reply.code(502).send({ error: "视频拆解失败：" + errText(e) });
    }
  });

  app.post("/api/workflow/dub/parse", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const cfg = getParseCfg(); if (!cfg) return reply.code(502).send({ error: "解析服务未配置" });
    const text = ((req.body as { text?: string })?.text ?? "").trim();
    if (!text) return reply.code(400).send({ error: "请粘贴分享文案或链接" });
    const allowed = await consumeDubParseQuota(redis, userId, DUB_PARSE_QUOTA_PER_HOUR);
    if (!allowed) return reply.code(429).send({ error: "解析太频繁，请稍后再试" });
    try {
      const data = await parseShareToStored({
        userId, requestId: `${userId}-${randomUUID()}`, text,
        deps: { billing, parseConfig: cfg, onError: (m, e) => app.log.error({ err: e, route: "dub/parse" }, m) },
      });
      return { success: true, data };
    } catch (e) {
      if ((e as Error)?.name === "InsufficientBalanceError") return reply.code(402).send({ error: "算力点不足，请充值" });
      const msg = errText(e);
      if (/未识别|图文|图集/.test(msg)) return reply.code(400).send({ error: msg });
      app.log.error({ err: e, route: "dub/parse" }, "链接解析失败");
      return reply.code(502).send({ error: "链接解析失败：" + msg });
    }
  });

  app.post("/api/workflow/dub/analyze-parsed", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const objectKey = ((req.body as { objectKey?: string })?.objectKey ?? "").trim();
    if (!objectKey) return reply.code(400).send({ error: "缺少 objectKey" });
    if (!objectKey.startsWith(`dub/parsed/${userId}/`)) return reply.code(403).send({ error: "无权访问该资源" });
    let buffer: Buffer;
    try { buffer = await getObjectByKey(objectKey); }
    catch { return reply.code(404).send({ error: "解析视频已失效，请重新解析" }); }
    try {
      const durationSec = await probeVideoDurationSec(buffer);
      const analysis = await analyzeDubVideo({
        userId, requestId: `dub-${userId}-${randomUUID()}`,
        videoBuffer: buffer, mime: "video/mp4", durationSec, billing,
      });
      return { success: true, data: analysis };
    } catch (e) {
      if ((e as Error)?.name === "InsufficientBalanceError") return reply.code(402).send({ error: "算力点不足，请充值" });
      app.log.error({ err: e, route: "dub/analyze-parsed" }, "解析视频拆解失败");
      return reply.code(502).send({ error: "视频拆解失败：" + errText(e) });
    }
  });

  app.post("/api/workflow/dub/rewrite", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const b = (req.body ?? {}) as { text?: string; kbIds?: string[]; highlights?: string[]; style?: string; injectHighlights?: boolean };
    const text = (b.text ?? "").trim();
    if (!text) return reply.code(400).send({ error: "请输入原始文案" });
    if (text.length > DUB_REWRITE_TEXT_MAX_CHARS) return reply.code(400).send({ error: `文案不能超过 ${DUB_REWRITE_TEXT_MAX_CHARS} 字` });
    const kbIds = Array.isArray(b.kbIds) ? b.kbIds.slice(0, 50) : [];
    try {
      const kbContext = await buildKbContext({ prisma, billing, userId, kbIds, query: text });
      const highlights = b.injectHighlights && Array.isArray(b.highlights) ? b.highlights : undefined;
      const r = await rewriteDubScript({ userId, text, client: getLlmClient(), billing, highlights, kbContext, style: b.style });
      return { success: true, data: { script: r.script } };
    } catch (e) {
      if ((e as Error)?.name === "InsufficientBalanceError") return reply.code(402).send({ error: "算力点不足，请充值" });
      app.log.error({ err: e, route: "dub/rewrite" }, "洗稿失败");
      return reply.code(502).send({ error: "洗稿失败：" + errText(e) });
    }
  });

  app.get("/api/workflow/dub/avatars", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    return { success: true, data: await listAvatars(prisma, userId) };
  });

  app.post("/api/workflow/dub/avatars", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const cfg = getCfg(); if (!cfg) return reply.code(502).send({ error: "飞天未配置" });
    const file = await req.file(); if (!file) return reply.code(400).send({ error: "请选择场景视频" });
    if (!file.mimetype.startsWith("video/")) return reply.code(400).send({ error: "仅支持视频文件" });
    const buffer = Buffer.from(await file.toBuffer());
    if (buffer.byteLength > DUB_AVATAR_VIDEO_MAX_BYTES) return reply.code(413).send({ error: "场景视频不能超过 100MB" });
    const title = String((req.query as { title?: string }).title ?? "未命名").slice(0, 40);
    try {
      const task = await startAvatarClone({ prisma, redis, billing, cfg, fetchFn, userId, title, buffer, mime: file.mimetype, storeVideo, scheduleTask });
      return reply.code(202).send({ success: true, data: { taskId: task.id } });
    } catch (e) {
      app.log.error({ err: e, route: "dub/avatars:create" }, "创建数字人失败");
      return reply.code(billingErrCode(e)).send({ error: billingErrMsg(e) });
    }
  });

  app.patch("/api/workflow/dub/avatars/:id", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const favorite = Boolean((req.body as { favorite?: boolean } | undefined)?.favorite);
    const ok = await setAvatarFavorite(prisma, userId, (req.params as { id: string }).id, favorite);
    return ok ? { success: true } : reply.code(404).send({ error: "形象不存在" });
  });

  app.delete("/api/workflow/dub/avatars/:id", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const cfg = getCfg(); if (!cfg) return reply.code(502).send({ error: "飞天未配置" });
    const ok = await removeAvatar({ prisma, cfg, fetchFn, userId, avatarId: (req.params as { id: string }).id });
    return ok ? { success: true } : reply.code(404).send({ error: "形象不存在" });
  });

  app.post("/api/workflow/dub/video/generate", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const cfg = getCfg(); if (!cfg) return reply.code(502).send({ error: "飞天未配置" });
    const file = await req.file(); if (!file) return reply.code(400).send({ error: "请选择驱动音频" });
    if (!file.mimetype.startsWith("audio/")) return reply.code(400).send({ error: "仅支持音频文件" });
    const buffer = Buffer.from(await file.toBuffer());
    if (buffer.byteLength > DUB_AUDIO_MAX_BYTES) return reply.code(413).send({ error: "音频不能超过 20MB" });
    const q = req.query as { avatarId?: string; title?: string };
    const avatarId = String(q.avatarId ?? "");
    const title = String(q.title ?? "未命名").slice(0, 40);
    if (!avatarId) return reply.code(400).send({ error: "请选择数字人形象" });
    try {
      const task = await startVideoCreate({ prisma, redis, billing, cfg, fetchFn, userId, avatarId, title, audioBuffer: buffer, audioMime: file.mimetype, probeDurationSec: probeVideoDurationSec, storeVideo, scheduleTask });
      return reply.code(202).send({ success: true, data: { taskId: task.id } });
    } catch (e) {
      if ((e as Error).message.includes("形象不存在")) return reply.code(403).send({ error: (e as Error).message });
      return reply.code(billingErrCode(e)).send({ error: billingErrMsg(e) });
    }
  });

  app.get("/api/workflow/dub/tasks/:id", async (req, reply) => {
    const userId = uid(req); if (!userId) return reply.code(401).send({ error: "未登录" });
    const task = await prisma.skyhumanTask.findFirst({ where: { id: (req.params as { id: string }).id, userId } });
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    return { success: true, data: { id: task.id, kind: task.kind, status: task.status, resultPayload: task.resultPayload, error: task.error } };
  });

  app.post("/api/workflow/dub/skyhuman/callback", async (req, reply) => {
    const secret = (req.query as { secret?: string }).secret;
    if (!secret || secret !== process.env.SKYHUMAN_CALLBACK_SECRET) return reply.code(403).send({ error: "forbidden" });
    const providerTaskId = (req.body as { task_id?: string } | undefined)?.task_id;
    if (!providerTaskId) return { received: true };
    const cfg = getCfg(); if (!cfg) return { received: true };
    const task = await prisma.skyhumanTask.findFirst({ where: { providerTaskId }, select: { id: true } });
    // 回调常比后台轮询先到：必须带上 finalizeProject，否则任务被标记 completed 却不混流，项目永久卡在 generating
    if (task) scheduleTask(() => pollFinalize({ prisma, billing, cfg, fetchFn, taskId: task.id, storeVideo, finalizeProject, maxAttempts: 1, intervalMs: 0 }));
    return { received: true };
  });
}

function billingErrCode(e: unknown): number { return (e as Error)?.name === "InsufficientBalanceError" ? 402 : 502; }
function billingErrMsg(e: unknown): string { return (e as Error)?.name === "InsufficientBalanceError" ? "视频点不足，请充值" : "计费未配置或服务不可用"; }

// 上游错误的 message 常常没有信息量（AWS SDK 的 S3 403 就只给 "UnknownError"），
// 必须带上 error name 与 HTTP 状态码，否则线上只能靠探针猜根因。
function errText(e: unknown): string {
  const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const msg = err?.message?.trim() || "未知错误";
  const name = err?.name && err.name !== "Error" ? err.name : "";
  const status = err?.$metadata?.httpStatusCode;
  return [name && name !== msg ? name : "", msg, status ? `(HTTP ${status})` : ""].filter(Boolean).join(" ");
}
