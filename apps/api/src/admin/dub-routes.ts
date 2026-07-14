import type { FastifyInstance } from "fastify";
import { getPrisma } from "@ai-assistant/db";
import { requireAdmin } from "./guard.js";
import { writeAudit } from "./audit.js";
import { loadSkyhumanConfig, getCredit } from "../workflow/dub-skyhuman-client.js";
import { listAllBgmPresets, createBgmPreset, updateBgmPreset, deleteBgmPreset } from "../workflow/dub-bgm-service.js";
import { storeAudioBuffer } from "../workflow/dub-audio-store.js";
import { DUB_BGM_MAX_BYTES } from "../workflow/dub-constants.js";

export async function adminDubRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/dub/skyhuman/credit", { preHandler: requireAdmin("VIEW_ANALYTICS") }, async (_req, reply) => {
    try {
      const fetchFn: typeof fetch = (...a) => fetch(...a);
      const r = await getCredit(loadSkyhumanConfig(), fetchFn);
      return { success: true, data: { left: r.left } };
    } catch {
      return reply.code(502).send({ error: "飞天服务不可用" });
    }
  });

  // BGM 预制 = 官方素材，权限归口 KNOWLEDGE_MANAGE（与官方知识库/配额包一致），不新增权限项。
  app.get("/api/admin/dub/bgm", { preHandler: requireAdmin("KNOWLEDGE_MANAGE") }, async () => {
    return { success: true, data: await listAllBgmPresets(getPrisma()) };
  });

  app.post("/api/admin/dub/bgm", { preHandler: requireAdmin("KNOWLEDGE_MANAGE") }, async (req, reply) => {
    const file = await req.file(); if (!file) return reply.code(400).send({ error: "请选择 BGM 音频" });
    if (!file.mimetype.startsWith("audio/")) return reply.code(400).send({ error: "仅支持音频文件" });
    const buffer = Buffer.from(await file.toBuffer());
    if (buffer.byteLength > DUB_BGM_MAX_BYTES) return reply.code(413).send({ error: "BGM 不能超过 20MB" });
    const q = req.query as { title?: string; sortOrder?: string };
    const ext = file.mimetype.includes("wav") ? "wav" : "mp3";
    const stored = await storeAudioBuffer({ userId: "official", buffer, mime: file.mimetype, ext });
    const prisma = getPrisma();
    const row = await createBgmPreset(prisma, {
      title: (q.title ?? "未命名").slice(0, 40),
      url: stored.url,
      objectKey: stored.objectKey,
      sortOrder: Number(q.sortOrder ?? 0) || 0,
    });
    const me = (req as unknown as { admin: { id: string } }).admin;
    await writeAudit(prisma, me.id, "DUB_BGM_CREATE", row.id, { title: row.title });
    return { success: true, data: row };
  });

  app.patch("/api/admin/dub/bgm/:id", { preHandler: requireAdmin("KNOWLEDGE_MANAGE") }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as { title?: string; sortOrder?: number; enabled?: boolean };
    const prisma = getPrisma();
    const ok = await updateBgmPreset(prisma, id, b);
    if (!ok) return reply.code(404).send({ error: "BGM 不存在" });
    const me = (req as unknown as { admin: { id: string } }).admin;
    await writeAudit(prisma, me.id, "DUB_BGM_UPDATE", id, b);
    return { success: true };
  });

  app.delete("/api/admin/dub/bgm/:id", { preHandler: requireAdmin("KNOWLEDGE_MANAGE") }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const prisma = getPrisma();
    const ok = await deleteBgmPreset(prisma, id);
    if (!ok) return reply.code(404).send({ error: "BGM 不存在" });
    const me = (req as unknown as { admin: { id: string } }).admin;
    await writeAudit(prisma, me.id, "DUB_BGM_DELETE", id);
    return { success: true };
  });
}
