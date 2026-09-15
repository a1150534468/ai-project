import type { Prisma, PrismaClient } from "@prisma/client";

type AuditDb = PrismaClient | Prisma.TransactionClient;

export function writeAudit(
  db: AuditDb,
  adminId: string,
  action: string,
  target?: string,
  detail?: unknown,
): Promise<unknown> {
  return db.adminAudit.create({
    data: {
      adminId,
      action,
      target: target ?? null,
      detail: (detail ?? null) as Prisma.InputJsonValue,
    },
  });
}
