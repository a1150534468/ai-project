import type { FastifyReply } from "fastify";

/**
 * 取已鉴权请求上的 userId，没有就直接回 401 并返回 null（调用方 `if (!userId) return;`）。
 *
 * 注意 `local-business-promo` 域另有一份同名同形的 `authUserId`，本次**没有**合并 ——
 * 那边 48 个调用点跨 11 个文件，合并属于独立改动，等确认后再动。
 */
export function authUserId(req: { readonly userId?: string }, reply: FastifyReply): string | null {
  if (req.userId) return req.userId;
  reply.code(401).send({ error: "未登录" });
  return null;
}
