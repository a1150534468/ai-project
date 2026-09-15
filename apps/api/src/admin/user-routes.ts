import { getPrisma } from "@ai-assistant/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { generateUniqueUid } from "../auth/uid.js";
import { writeAudit } from "./audit.js";
import { requireAdmin } from "./guard.js";
import { requestAdminId } from "./request-admin.js";
import { buildAdminUserDetail } from "./user-detail.js";

const USER_SELECT = {
  id: true,
  uid: true,
  username: true,
  bannedAt: true,
  createdAt: true,
} as const;

const createUserSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(8).max(200),
});

interface UserListQuery {
  readonly q?: string;
  readonly page?: string;
  readonly pageSize?: string;
}

interface UserListOptions {
  readonly where: Prisma.UserWhereInput;
  readonly page: number;
  readonly pageSize: number;
}

export function parseUserListOptions(query: UserListQuery): UserListOptions {
  const search = query.q?.trim();
  const rawPage = Number.parseInt(query.page ?? "", 10);
  const rawPageSize = Number.parseInt(query.pageSize ?? "", 10) || 20;
  return {
    where: search
      ? {
          OR: [
            { uid: { contains: search, mode: "insensitive" } },
            { username: { contains: search, mode: "insensitive" } },
          ],
        }
      : {},
    page: Number.isNaN(rawPage) ? 1 : Math.min(1_000_000, Math.max(1, rawPage)),
    pageSize: Math.min(100, Math.max(1, rawPageSize)),
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

export interface AdminUserRoutesOptions {
  readonly prisma?: PrismaClient;
}

export async function adminUserRoutes(
  app: FastifyInstance,
  options: AdminUserRoutesOptions = {},
): Promise<void> {
  const prisma = options.prisma ?? getPrisma();
  const canManageUsers = { preHandler: requireAdmin("USER_MANAGE") };

  app.get("/api/admin/users", canManageUsers, async (request) => {
    const { where, page, pageSize } = parseUserListOptions(request.query as UserListQuery);
    const [total, data] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: USER_SELECT,
      }),
    ]);
    return { success: true, data, total, page, pageSize };
  });

  app.post("/api/admin/users", canManageUsers, async (request, reply) => {
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    if (await prisma.user.findUnique({ where: { username: parsed.data.username }, select: { id: true } })) {
      return reply.code(409).send({ error: "用户名已被占用" });
    }

    const [uid, passwordHash] = await Promise.all([
      generateUniqueUid(async (candidate) =>
        Boolean(await prisma.user.findUnique({ where: { uid: candidate }, select: { id: true } })),
      ),
      argon2.hash(parsed.data.password),
    ]);
    try {
      const user = await prisma.user.create({
        data: { uid, username: parsed.data.username, passwordHash },
        select: USER_SELECT,
      });
      await writeAudit(prisma, requestAdminId(request), "USER_CREATE", user.id, { uid });
      return { success: true, data: user };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return reply.code(409).send({ error: "用户名已被占用" });
      }
      throw error;
    }
  });

  for (const action of [
    { path: "ban", bannedAt: () => new Date(), audit: "USER_BAN" },
    { path: "unban", bannedAt: () => null, audit: "USER_UNBAN" },
  ] as const) {
    app.post(`/api/admin/users/:id/${action.path}`, canManageUsers, async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await prisma.user.updateMany({ where: { id }, data: { bannedAt: action.bannedAt() } });
      if (result.count !== 1) return reply.code(404).send({ error: "用户不存在" });
      await writeAudit(prisma, requestAdminId(request), action.audit, id);
      return { success: true };
    });
  }

  app.get(
    "/api/admin/users/:id/detail",
    { preHandler: requireAdmin("USER_DETAIL_VIEW") },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = await prisma.user.findUnique({ where: { id }, select: USER_SELECT });
      if (!user) return reply.code(404).send({ error: "用户不存在" });
      return { success: true, data: await buildAdminUserDetail(prisma, user) };
    },
  );
}
