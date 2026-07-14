import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@ai-assistant/db";
import { createBillingClient, type AdminOrderRow, type ListAdminOrdersParams } from "@ai-assistant/billing";
import { requireAdmin } from "./guard.js";

const listOrdersQuerySchema = z.object({
  user: z.string().trim().max(128).optional(),
  userId: z.string().trim().max(64).optional(),
  tradeNo: z.string().trim().max(64).optional(),
  status: z.string().trim().max(16).optional(),
  kind: z.string().trim().max(16).optional(),
  provider: z.string().trim().max(16).optional(),
  paymentMethod: z.string().trim().max(16).optional(),
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

interface OrderUser {
  id: string;
  uid: string;
  username: string;
}

type OrderWithUser = AdminOrderRow & { user: OrderUser | null };

export async function adminOrderRoutes(app: FastifyInstance) {
  const prisma = getPrisma();
  const billing = createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });

  app.get(
    "/api/admin/orders",
    { preHandler: requireAdmin("ORDER_MANAGE") },
    async (req, reply) => {
      const parsed = listOrdersQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });

      const userIds = await resolveOrderUserIds(parsed.data.user);
      if (parsed.data.user && userIds.length === 0) {
        return {
          success: true,
          data: [],
          total: 0,
          summary: emptyOrderSummary(),
        };
      }

      try {
        const result = await billing.listAdminOrders(toBillingOrderQuery(parsed.data, userIds));
        const data = await attachOrderUsers(result.data);
        return {
          success: true,
          data,
          total: result.total,
          summary: result.summary,
        };
      } catch {
        return reply.code(502).send({ error: "计费服务不可用" });
      }
    },
  );

  async function resolveOrderUserIds(keyword?: string): Promise<string[]> {
    const q = keyword?.trim();
    if (!q) return [];
    const rows = await prisma.user.findMany({
      where: {
        OR: [
          { id: { contains: q } },
          { uid: { contains: q } },
          { username: { contains: q } },
        ],
      },
      select: { id: true },
      take: 100,
    });
    return rows.map((row) => row.id);
  }

  async function attachOrderUsers(rows: AdminOrderRow[]): Promise<OrderWithUser[]> {
    const ids = Array.from(new Set(rows.map((row) => row.userId).filter(Boolean)));
    if (ids.length === 0) {
      return rows.map((row) => ({ ...row, user: null }));
    }
    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, uid: true, username: true },
    });
    const byID = new Map(users.map((user) => [user.id, user]));
    return rows.map((row) => ({ ...row, user: byID.get(row.userId) ?? null }));
  }
}

function toBillingOrderQuery(
  q: z.infer<typeof listOrdersQuerySchema>,
  userIds: string[],
): ListAdminOrdersParams {
  return {
    userId: q.userId || undefined,
    userIds: userIds.length > 0 ? userIds : undefined,
    tradeNo: q.tradeNo || undefined,
    status: q.status || undefined,
    kind: q.kind || undefined,
    provider: q.provider || undefined,
    paymentMethod: q.paymentMethod || undefined,
    from: q.from || undefined,
    to: q.to || undefined,
    limit: q.limit,
    offset: q.offset,
  };
}

function emptyOrderSummary() {
  return {
    total: 0,
    successCount: 0,
    pendingCount: 0,
    closedCount: 0,
    successAmountFen: 0,
    successPoints: 0,
    payingUsers: 0,
  };
}
