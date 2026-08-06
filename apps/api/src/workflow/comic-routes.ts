import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { getPrisma } from "@ai-assistant/db";
import {
  activateComicScriptVersion,
  comicProjectStoreFromPrisma,
  createComicBibleEntry,
  createComicEpisode,
  createComicProject,
  createComicScriptVersion,
  deleteComicBibleEntry,
  deleteComicProject,
  getComicProjectDetail,
  listComicBibleEntries,
  listComicEpisodes,
  listComicProjects,
  listComicScriptVersions,
  updateComicBibleEntry,
  updateComicEpisode,
  updateComicProject,
  type ComicProjectStore,
} from "./comic-project-service.js";
import { comicScriptSourceSchema } from "./comic-types.js";

interface ComicWorkflowRouteOptions extends FastifyPluginOptions {
  readonly store?: ComicProjectStore;
}

const idParamsSchema = z.object({ projectId: z.string().min(1) });
const episodeParamsSchema = z.object({ episodeId: z.string().min(1) });
const bibleParamsSchema = z.object({ entryId: z.string().min(1) });
const scriptParamsSchema = z.object({ versionId: z.string().min(1) });

const createProjectSchema = z.object({
  title: z.string().trim().min(1).max(80),
  logline: z.string().trim().max(300).default(""),
  style: z.string().trim().max(200).default(""),
});

const updateProjectSchema = createProjectSchema.partial();

const createBibleEntrySchema = z.object({
  category: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(80),
  content: z.string().trim().max(2000).default(""),
  position: z.number().int().min(0).max(10000).default(0),
});

const updateBibleEntrySchema = createBibleEntrySchema.partial();

const createEpisodeSchema = z.object({
  title: z.string().trim().min(1).max(80),
  summary: z.string().trim().max(1200).default(""),
  targetDurationSec: z.number().int().min(10).max(600).default(90),
});

const updateEpisodeSchema = createEpisodeSchema.partial();

const createScriptSchema = z.object({
  outline: z.string().trim().max(4000).default(""),
  scriptText: z.string().trim().min(1).max(30000),
  source: comicScriptSourceSchema.default("manual"),
  prompt: z.string().trim().max(4000).default(""),
});

function requireUserId(app: FastifyInstance["server"], userId: string | undefined): string | null {
  void app;
  return userId?.trim() || null;
}

export async function comicWorkflowRoutes(app: FastifyInstance, opts: ComicWorkflowRouteOptions = {}) {
  const store = opts.store ?? comicProjectStoreFromPrisma(getPrisma());

  app.get("/api/workflow/comics/projects", async (req, reply) => {
    const userId = requireUserId(app.server, req.userId);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    return { success: true, data: await listComicProjects(store, userId) };
  });

  app.post("/api/workflow/comics/projects", async (req, reply) => {
    const userId = requireUserId(app.server, req.userId);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "请输入漫剧标题" });
    const data = await createComicProject(store, { userId, ...parsed.data });
    return reply.code(201).send({ success: true, data });
  });

  app.get("/api/workflow/comics/projects/:projectId", async (req, reply) => {
    const userId = requireUserId(app.server, req.userId);
    const params = idParamsSchema.safeParse(req.params);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const data = await getComicProjectDetail(store, userId, params.data.projectId);
    if (!data) return reply.code(404).send({ error: "项目不存在" });
    return { success: true, data };
  });

  app.patch("/api/workflow/comics/projects/:projectId", async (req, reply) => {
    const userId = requireUserId(app.server, req.userId);
    const params = idParamsSchema.safeParse(req.params);
    const body = updateProjectSchema.safeParse(req.body);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const data = await updateComicProject(store, userId, params.data.projectId, body.data);
    if (!data) return reply.code(404).send({ error: "项目不存在" });
    return { success: true, data };
  });

  app.delete("/api/workflow/comics/projects/:projectId", async (req, reply) => {
    const userId = requireUserId(app.server, req.userId);
    const params = idParamsSchema.safeParse(req.params);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const deleted = await deleteComicProject(store, userId, params.data.projectId);
    if (!deleted) return reply.code(404).send({ error: "项目不存在" });
    return { success: true };
  });

  app.get("/api/workflow/comics/projects/:projectId/bible", async (req, reply) => {
    const userId = requireUserId(app.server, req.userId);
    const params = idParamsSchema.safeParse(req.params);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const data = await listComicBibleEntries(store, userId, params.data.projectId);
    if (!data) return reply.code(404).send({ error: "项目不存在" });
    return { success: true, data };
  });

  app.post("/api/workflow/comics/projects/:projectId/bible", async (req, reply) => {
    const userId = requireUserId(app.server, req.userId);
    const params = idParamsSchema.safeParse(req.params);
    const body = createBibleEntrySchema.safeParse(req.body);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const data = await createComicBibleEntry(store, { userId, projectId: params.data.projectId, ...body.data });
    if (!data) return reply.code(404).send({ error: "项目不存在" });
    return reply.code(201).send({ success: true, data });
  });

  app.patch("/api/workflow/comics/bible/:entryId", async (req, reply) => {
    const userId = requireUserId(app.server, req.userId);
    const params = bibleParamsSchema.safeParse(req.params);
    const body = updateBibleEntrySchema.safeParse(req.body);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const data = await updateComicBibleEntry(store, userId, params.data.entryId, body.data);
    if (!data) return reply.code(404).send({ error: "设定不存在" });
    return { success: true, data };
  });

  app.delete("/api/workflow/comics/bible/:entryId", async (req, reply) => {
    const userId = requireUserId(app.server, req.userId);
    const params = bibleParamsSchema.safeParse(req.params);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const deleted = await deleteComicBibleEntry(store, userId, params.data.entryId);
    if (!deleted) return reply.code(404).send({ error: "设定不存在" });
    return { success: true };
  });

  app.get("/api/workflow/comics/projects/:projectId/episodes", async (req, reply) => {
    const userId = requireUserId(app.server, req.userId);
    const params = idParamsSchema.safeParse(req.params);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const data = await listComicEpisodes(store, userId, params.data.projectId);
    if (!data) return reply.code(404).send({ error: "项目不存在" });
    return { success: true, data };
  });

  app.post("/api/workflow/comics/projects/:projectId/episodes", async (req, reply) => {
    const userId = requireUserId(app.server, req.userId);
    const params = idParamsSchema.safeParse(req.params);
    const body = createEpisodeSchema.safeParse(req.body);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const data = await createComicEpisode(store, { userId, projectId: params.data.projectId, ...body.data });
    if (!data) return reply.code(404).send({ error: "项目不存在" });
    return reply.code(201).send({ success: true, data });
  });

  app.patch("/api/workflow/comics/episodes/:episodeId", async (req, reply) => {
    const userId = requireUserId(app.server, req.userId);
    const params = episodeParamsSchema.safeParse(req.params);
    const body = updateEpisodeSchema.safeParse(req.body);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const data = await updateComicEpisode(store, userId, params.data.episodeId, body.data);
    if (!data) return reply.code(404).send({ error: "剧集不存在" });
    return { success: true, data };
  });

  app.post("/api/workflow/comics/episodes/:episodeId/script", async (req, reply) => {
    const userId = requireUserId(app.server, req.userId);
    const params = episodeParamsSchema.safeParse(req.params);
    const body = createScriptSchema.safeParse(req.body);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const data = await createComicScriptVersion(store, { userId, episodeId: params.data.episodeId, ...body.data });
    if (!data) return reply.code(404).send({ error: "剧集不存在" });
    return reply.code(201).send({ success: true, data });
  });

  app.get("/api/workflow/comics/episodes/:episodeId/script-versions", async (req, reply) => {
    const userId = requireUserId(app.server, req.userId);
    const params = episodeParamsSchema.safeParse(req.params);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const data = await listComicScriptVersions(store, userId, params.data.episodeId);
    if (!data) return reply.code(404).send({ error: "剧集不存在" });
    return { success: true, data };
  });

  app.post("/api/workflow/comics/script-versions/:versionId/activate", async (req, reply) => {
    const userId = requireUserId(app.server, req.userId);
    const params = scriptParamsSchema.safeParse(req.params);
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const data = await activateComicScriptVersion(store, userId, params.data.versionId);
    if (!data) return reply.code(404).send({ error: "脚本版本不存在" });
    return { success: true, data };
  });
}
