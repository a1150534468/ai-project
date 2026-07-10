import type { PrismaClient } from "@yc/db";

export async function writeAudit(
  prisma: PrismaClient,
  adminId: string,
  action: string,
  target?: string,
  detail?: unknown,
): Promise<void> {
  await prisma.adminAudit.create({
    data: {
      adminId,
      action,
      target: target ?? null,
      detail: (detail ?? null) as never,
    },
  });
}
